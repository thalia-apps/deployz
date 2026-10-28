/**
 * Worker Lambda entry point.
 *
 * Wires the real AWS, GitHub and database seams into the worker (worker.ts)
 * and adapts the two event sources it is subscribed to: the SQS job queue,
 * and the CodeBuild state-change rule that reports a finished release build.
 *
 * Queue failures are reported per message (`batchItemFailures`) so one bad
 * message never re-drives a whole batch.
 */
import { BatchGetBuildsCommand, CodeBuildClient, StartBuildCommand } from '@aws-sdk/client-codebuild';
import { PutObjectCommand, S3Client as SdkS3Client } from '@aws-sdk/client-s3';

import { createAiGateway } from '@deployz/analysis';
import {
  createAnalysisAiGateways,
  resolveAiGatewayConfig,
  resolveAnalysisAiConfig,
  resolveJevConfig,
} from '@deployz/api/ai-config';
import { createAnalysisRunner } from '@deployz/api/analysis';
import { createJevShadowRunnerFromEnv, createJevFailureShadowRunnerFromEnv } from '@deployz/api/jev-shadow';
import { createPaddle } from '@deployz/api/paddle';
import { createSecretCipherFromEnv, type SecretCipher } from '@deployz/api/pending-secrets';
import type { QueueMessage } from '@deployz/api/queue';

import { connectDb, type LambdaDb } from './db-connection.js';
import { loadGithubAppPrivateKey } from './github-app-key.js';
import {
  handleMessage,
  inventoryConfigSecrets,
  loadBuildVariablesFromDb,
  recordBuildResult,
  sweepBilling,
  sweepExpiredPendingSecrets,
  sweepRelayLiveness,
  sweepStuckBuilds,
  sweepStuckJobs,
  type CodeBuildStateChangeEvent,
  type RepositoryFetch,
  type S3Client,
  type WorkerDeps,
} from './worker.js';

interface SqsEvent {
  readonly Records: readonly { readonly messageId: string; readonly body: string }[];
}

/** The 15-minute EventBridge schedule that drives the stuck-job watchdog. */
interface ScheduledEvent {
  readonly 'detail-type': 'Scheduled Event';
}

type WorkerEvent = SqsEvent | CodeBuildStateChangeEvent | ScheduledEvent;

interface BatchResponse {
  readonly batchItemFailures: { readonly itemIdentifier: string }[];
}

const fetchFn: RepositoryFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init?.method ?? 'GET',
    ...(init?.headers ? { headers: init.headers } : {}),
    ...(init?.body ? { body: init.body } : {}),
  });
  return {
    status: response.status,
    headers: { get: (name: string) => response.headers.get(name) },
    json: () => response.json(),
    arrayBuffer: () => response.arrayBuffer(),
    text: () => response.text(),
    body: response.body,
  };
};

let s3: SdkS3Client | undefined;
let codeBuild: CodeBuildClient | undefined;

const s3Client: S3Client = {
  async putObject(params) {
    s3 ??= new SdkS3Client({});
    await s3.send(
      new PutObjectCommand({
        Bucket: params.bucket,
        Key: params.key,
        Body: params.body,
        ...(params.contentType ? { ContentType: params.contentType } : {}),
      }),
    );
  },
};

/** Wires the real AWS, GitHub and database seams. */
function createDeps(db: LambdaDb): WorkerDeps {
  return {
    db,
    fetchFn,
    s3: s3Client,
    async startBuild(input) {
      codeBuild ??= new CodeBuildClient({});
      const response = await codeBuild.send(
        new StartBuildCommand({
          projectName: input.projectName,
          environmentVariablesOverride: input.environmentVariables.map((variable) => ({
            ...variable,
            type: 'PLAINTEXT',
          })),
        }),
      );
      return response.build?.id ?? null;
    },
    async batchGetBuilds(ids) {
      if (ids.length === 0) return [];
      codeBuild ??= new CodeBuildClient({});
      // BatchGetBuilds caps at 100 ids per call.
      const chunks: string[][] = [];
      for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
      const builds = [];
      for (const chunk of chunks) {
        const response = await codeBuild.send(new BatchGetBuildsCommand({ ids: chunk }));
        builds.push(...(response.builds ?? []));
      }
      return builds.flatMap((build) =>
        build.id !== undefined && build.buildStatus !== undefined
          ? [
              {
                id: build.id,
                buildStatus: build.buildStatus,
                exportedEnvironmentVariables: (build.exportedEnvironmentVariables ?? []).flatMap(
                  (variable) =>
                    variable.name !== undefined && variable.value !== undefined
                      ? [{ name: variable.name, value: variable.value }]
                      : [],
                ),
                // Same shape as the EventBridge event's phases, so the
                // sweep's synthesized event carries failure detail too.
                phases: (build.phases ?? []).map((phase) => ({
                  ...(phase.phaseType !== undefined ? { 'phase-type': phase.phaseType } : {}),
                  ...(phase.phaseStatus !== undefined
                    ? { 'phase-status': phase.phaseStatus }
                    : {}),
                  'phase-context': (phase.contexts ?? []).flatMap((context) =>
                    context.message !== undefined && context.message !== ''
                      ? [`${context.statusCode ?? ''}: ${context.message}`]
                      : [],
                  ),
                })),
              },
            ]
          : [],
      );
    },
    runAnalysis: createAnalysisRunner({
      db,
      fetchFn,
      githubAppId: process.env.GITHUB_APP_ID,
      githubAppPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY,
      githubFixtureMode: process.env.GITHUB_FIXTURE_MODE === 'true',
      aiGateway: createAiGateway(resolveAiGatewayConfig(process.env)),
      analysisEngine: resolveAnalysisAiConfig(process.env).engine,
      aiAnalysis: createAnalysisAiGateways(resolveAnalysisAiConfig(process.env)),
      // Same construction as the API server: shadow-only, noop when Jev is
      // disabled or partially configured, one shared breaker per process.
      jevShadow: createJevShadowRunnerFromEnv({ db }, resolveJevConfig(process.env)),
    }),
    loadBuildVariables: (db, applicationId) => loadBuildVariablesFromDb(db, applicationId, secretCipher()),
  };
}

/**
 * Same selection as the API server (apps/api/src/server.ts). Resolved on
 * first use, not at INIT: without a valid key in Lambda only the work that
 * needs a secret fails (loudly), while the watchdog keeps reconciling jobs.
 */
function secretCipher(): SecretCipher {
  return createSecretCipherFromEnv({
    kmsKeyArn: process.env.DEPLOYZ_KMS_KEY_ARN,
    isLambda: Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME),
  });
}

function isSqsEvent(event: WorkerEvent): event is SqsEvent {
  return Array.isArray((event as SqsEvent).Records);
}

export async function handler(event: WorkerEvent): Promise<BatchResponse | void> {
  const db = await connectDb();
  // Sets GITHUB_APP_PRIVATE_KEY for createDeps. A failed read fails only the
  // work that needs GitHub, loudly; the sweeps below still run.
  await loadGithubAppPrivateKey().catch((error: unknown) => {
    console.error(JSON.stringify({ event: 'github:app-key-unavailable', error: String(error) }));
  });

  if (!isSqsEvent(event)) {
    if (event['detail-type'] === 'CodeBuild Build State Change') {
      await recordBuildResult(db, event);
    }
    if (event['detail-type'] === 'Scheduled Event') {
      // Shadow-only, noop when Jev is disabled — same construction as the
      // analysis runner's wiring in createDeps below.
      const jevFailureShadow = createJevFailureShadowRunnerFromEnv({ db }, resolveJevConfig(process.env));
      const failed = await sweepStuckJobs(db, new Date(), jevFailureShadow);
      const relaysDisconnected = await sweepRelayLiveness(db);
      // A build-sweep failure (e.g. a CodeBuild API error) must not fail the
      // whole scheduled invoke — the job sweep above already committed, and
      // the next tick retries the build sweep anyway.
      const sweptBuilds = await sweepStuckBuilds(createDeps(db)).catch((error: unknown) => {
        console.error('sweepStuckBuilds failed', error);
        return 0;
      });
      // Paddle migration Phase 10 — the billing safety net. Same contract as
      // the build sweep: a Paddle or billing failure must not fail the whole
      // scheduled invoke, and the next tick retries it anyway.
      const billing = await sweepBilling(db, createPaddle()).catch((error: unknown) => {
        console.error('sweepBilling failed', error);
        return { promoted: 0, servingChanged: 0, unstuck: 0, reconciled: 0 };
      });
      // Counts only — taken before the expiry sweep so expired rows show.
      // A failed inventory must never fail the scheduled invoke.
      const secretInventory = await inventoryConfigSecrets(db).catch((error: unknown) => {
        console.error('inventoryConfigSecrets failed', error);
        return undefined;
      });
      if (secretInventory !== undefined) {
        console.log(JSON.stringify({ event: 'watchdog:config-secret-inventory', ...secretInventory }));
      }
      // DEPLOY-027 (Phase 4): drop pending_secrets rows whose TTL expired
      // before any relay picked them up. Swallow errors the same way as the
      // other sweeps — a future tick will retry, and a failed sweep must
      // never fail the scheduled invoke.
      const sweptExpiredSecrets = await sweepExpiredPendingSecrets(db).catch((error: unknown) => {
        console.error('sweepExpiredPendingSecrets failed', error);
        return 0;
      });
      console.log(
        JSON.stringify({
          event: 'watchdog:sweep-complete',
          failedJobs: failed,
          relaysDisconnected,
          sweptBuilds,
          billingPromoted: billing.promoted,
          billingServingChanged: billing.servingChanged,
          billingEventsUnstuck: billing.unstuck,
          billingReconciled: billing.reconciled,
          sweptExpiredSecrets,
        }),
      );
    }
    return;
  }

  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      await handleMessage(createDeps(db), JSON.parse(record.body) as QueueMessage, record.messageId);
    } catch (error) {
      console.error(`worker message ${record.messageId} failed`, error);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
