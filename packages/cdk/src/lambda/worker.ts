/**
 * Control-plane worker — what the SQS job queue actually does.
 *
 * The API cannot do slow work itself: Lambda freezes an execution environment
 * the moment its response is sent, so anything started after a reply never
 * finishes. Every such task is queued (apps/api/src/queue.ts) and handled
 * here, in an invocation of its own with its own timeout.
 *
 * Two kinds of work arrive:
 *   - queue messages — ANALYSE_APPLICATION / BUILD_RELEASE / CONFIG_UPDATE.
 *   - a CodeBuild state change — the completion signal for a release build.
 *     The build's exported IMAGE_DIGEST becomes releases.image_digest; §21
 *     pins deployments to that digest.
 *
 * The Lambda entry point (worker-handler.ts) wires the real seams; this
 * module holds no AWS clients of its own, so the logic stays testable.
 */
import { and, eq, inArray, isNotNull, isNull, lt, notInArray, or, sql } from 'drizzle-orm';

import { reconcileBilling } from '@deployz/api/billing';
import { markDeploymentLive, syncServingBilling } from '@deployz/api/billing-lifecycle';
import { fanOutConfigUpdate, listVendorValues } from '@deployz/api/config';
import { mintInstallationToken } from '@deployz/api/github';
import type { SecretCipher } from '@deployz/api/pending-secrets';
import {
  flipHealthyDeploymentsToUpdateAvailable,
  hasStartedInstall,
  newerReadyReleaseExists,
} from '@deployz/api/jobs';
import type { PaddleBilling } from '@deployz/api/paddle';
import type { QueueMessage } from '@deployz/api/queue';
import {
  RELEASE_VERSION_PATTERN,
  buildStageVendorKeys,
  environmentSettingsSchema,
  isRepoRelativePath,
  releaseImageTag,
} from '@deployz/contracts';
import { JOB_TIMEOUTS_MS, RELAY_STALE_AFTER_MS, deploymentStateAfterFailedJob } from '@deployz/contracts';
import type { JevFailureShadowRunner } from '@deployz/api/jev-shadow';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { fetchRepoArchive } from '../pipeline/source-fetch.js';
import type { S3Client } from '../quick-create/publish.js';

export type { S3Client };

// ── Release build events ────────────────────────────────────────────────
//
// This package cannot import apps/api/src/events.ts (that module is not one
// of @deployz/api's exported entry points), so the release.build_* rows are
// written directly here, the same way the operation.* watchdog inserts are.
// Payloads carry only ids and stable codes — never raw CodeBuild logs or
// exception text (the human-readable failure reason lives on
// releases.failure_reason, not in the event log).

type ReleaseBuildEventType =
  | 'release.build_started'
  | 'release.build_completed'
  | 'release.build_failed';

/** Stable lowercase failure codes mirroring the actual failure paths. */
type ReleaseBuildFailureCode =
  | 'build_failed'
  | 'build_cancelled'
  | 'build_timeout'
  | 'build_registry_rate_limited';

/**
 * The buildspec's own words when Docker Hub metered the base-image pull for
 * longer than the build's retries covered (build-pipeline.ts). The phrase is
 * the failing command's text, which CodeBuild reports as the phase context.
 */
const REGISTRY_RATE_LIMIT_PATTERN = /rate limit \(HTTP 429\)/i;

/** A Dockerfile stage name that is safe to pass to `docker build --target`. */
const DOCKER_STAGE_NAME = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Map a CodeBuild terminal status onto the stable vocabulary. Anything not
 * clearly a cancel, a timeout or a registry rate limit is a plain build
 * failure. The rate limit is deliberately separate: it says nothing about
 * the repository, and reporting it as a build failure blames an application
 * that builds perfectly well an hour later.
 */
function buildFailureCode(
  status: string | undefined,
  detail: string | null,
): ReleaseBuildFailureCode {
  if (status === 'STOPPED' || status === 'STOPPING') return 'build_cancelled';
  if (status === 'TIMED_OUT') return 'build_timeout';
  if (detail !== null && REGISTRY_RATE_LIMIT_PATTERN.test(detail)) {
    return 'build_registry_rate_limited';
  }
  return 'build_failed';
}

async function insertReleaseBuildEvent(
  tx: Pick<RuntimeDb, 'insert'>,
  event: {
    organizationId: string;
    releaseId: string;
    applicationId: string;
    eventType: ReleaseBuildEventType;
    result: 'pending' | 'success' | 'failure';
    failureCode?: ReleaseBuildFailureCode;
  },
): Promise<void> {
  await tx.insert(schema.eventLogs).values({
    actorType: 'system',
    actorId: 'build-worker',
    organizationId: event.organizationId,
    releaseId: event.releaseId,
    eventType: event.eventType,
    result: event.result,
    payload: {
      schemaVersion: 1,
      applicationId: event.applicationId,
      ...(event.failureCode !== undefined ? { failureCode: event.failureCode } : {}),
    },
  });
}

// ── Event shapes ─────────────────────────────────────────────────────────

export interface CodeBuildStateChangeEvent {
  readonly 'detail-type': string;
  readonly detail: {
    readonly 'build-status': string;
    /** The build's ARN — correlates the event to the release's current build. */
    readonly 'build-id'?: string;
    readonly 'additional-information'?: {
      readonly environment?: {
        readonly 'environment-variables'?: readonly {
          readonly name: string;
          readonly value: string;
        }[];
      };
      readonly phases?: readonly {
        readonly 'phase-type'?: string;
        readonly 'phase-status'?: string;
        readonly 'phase-context'?: readonly string[];
      }[];
      /** Where the real EventBridge event carries the exported vars (verified live). */
      readonly 'exported-environment-variables'?: readonly {
        readonly name: string;
        readonly value: string;
      }[];
    };
    readonly 'exported-environment-variables'?: readonly {
      readonly name: string;
      readonly value: string;
    }[];
  };
}

/**
 * Everything the worker touches outside its own process. Injected so the
 * dispatch logic is testable without AWS, GitHub, or Secrets Manager — the
 * same seam pattern as the publisher.
 */
export interface WorkerDeps {
  readonly db: RuntimeDb;
  readonly fetchFn: RepositoryFetch;
  readonly s3: S3Client;
  /** Starts a CodeBuild build and resolves its build id (the short "project:uuid" form StartBuild returns), or null. */
  readonly startBuild: (input: {
    projectName: string;
    environmentVariables: { name: string; value: string }[];
  }) => Promise<string | null>;
  /** Looks up builds by their short "project:uuid" id — the stuck-build watchdog's polling seam. */
  readonly batchGetBuilds: (ids: string[]) => Promise<
    {
      id: string;
      buildStatus: string;
      exportedEnvironmentVariables?: { name: string; value: string }[];
      phases?: {
        'phase-type'?: string;
        'phase-status'?: string;
        'phase-context'?: string[];
      }[];
    }[]
  >;
  readonly runAnalysis: (applicationId: string, options?: { force?: boolean }) => Promise<void>;
  /**
   * Build-time variables a vendor configured for this application (§31 env
   * setup) — decrypted where secret. Injectable so buildRelease is testable
   * without the real SecretCipher/KMS seam; see `loadBuildVariablesFromDb`
   * for the default implementation.
   */
  readonly loadBuildVariables: (db: RuntimeDb, applicationId: string) => Promise<{ name: string; value: string }[]>;
}

// ── Seams ────────────────────────────────────────────────────────────────

/**
 * Satisfies both fetch seams at once: the GitHub client needs `json()`, the
 * source fetcher needs `arrayBuffer()` and `text()`.
 */
export type RepositoryFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null;
}>;

/**
 * `docker/` is the convention for a Dockerfile written to be built from the
 * repo root (e.g. Documenso's `docker build -f docker/Dockerfile .`), unlike
 * a Dockerfile in another subdirectory (e.g. `backend/Dockerfile`) whose
 * context is that subdirectory. Only a top-level `docker/` counts — a nested
 * `foo/docker/Dockerfile` does not imply a repo-root context.
 */
export function resolveBuildContext(dockerfilePath: string): string | undefined {
  const dir = dockerfilePath.includes('/') ? dockerfilePath.slice(0, dockerfilePath.lastIndexOf('/')) : '.';
  return dir === 'docker' ? '.' : undefined;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

// ── Build-stage vendor variables (§31 env setup) ───────────────────────────

/**
 * Names a vendor-configured build variable must never collide with — the
 * ids the control plane itself passes to CodeBuild, plus every namespace
 * CodeBuild/AWS reserve for their own environment. A collision is silently
 * dropped rather than failing the whole build; only the NAME is logged
 * (never a value — these entries may be secret).
 */
const RESERVED_BUILD_VARIABLE_NAMES = new Set<string>([
  'SOURCE_S3_URI',
  'RELEASE_VERSION',
  'GIT_SHA',
  'RELEASE_ID',
  'DOCKERFILE_PATH',
  'BUILD_CONTEXT',
  'BUILD_TARGET',
  'DEPLOYZ_BUILD_ARG_NAMES',
  'ECR_REPOSITORY_URI',
  'IMAGE_TAG',
  'IMAGE_DIGEST',
  'PATH',
  'HOME',
  'SHELL',
  'ENV',
  'BASH_ENV',
  'DOCKER_CONFIG',
  'DOCKER_HOST',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
]);

function isReservedBuildVariableName(name: string): boolean {
  return (
    RESERVED_BUILD_VARIABLE_NAMES.has(name) ||
    name.startsWith('CODEBUILD_') ||
    name.startsWith('AWS_') ||
    name.startsWith('DOCKERHUB_') ||
    name.startsWith('LD_')
  );
}

const RELEASE_GIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/;

/**
 * The vendor-configured build-stage keys for this application
 * (docs/environment-variables.md), with their current values resolved (decrypted where secret) via
 * apps/api's config store. Reserved names are dropped — only the name is
 * logged, a value never is.
 */
export async function loadBuildVariablesFromDb(
  db: RuntimeDb,
  applicationId: string,
  cipher: SecretCipher,
): Promise<{ name: string; value: string }[]> {
  const rows = await db
    .select({ environmentSettings: schema.applications.environmentSettings })
    .from(schema.applications)
    .where(eq(schema.applications.id, applicationId))
    .limit(1);
  const parsed = environmentSettingsSchema.safeParse(rows[0]?.environmentSettings);
  if (!parsed.success) return [];

  const keys: string[] = [];
  for (const key of buildStageVendorKeys(parsed.data)) {
    if (isReservedBuildVariableName(key)) {
      console.warn(`skipping build variable "${key}" — reserved name`);
      continue;
    }
    keys.push(key);
  }
  if (keys.length === 0) return [];

  const values = await listVendorValues(db, applicationId, keys, cipher);
  return keys.filter((key) => key in values).map((key) => ({ name: key, value: values[key]! }));
}

// ── BUILD_RELEASE ────────────────────────────────────────────────────────

/**
 * Fetches the release's repository source into S3 and starts the CodeBuild
 * project on it. The build itself is asynchronous: its completion arrives
 * later as a CodeBuild state-change event.
 */
async function buildRelease(deps: WorkerDeps, releaseId: string): Promise<void> {
  const { db } = deps;
  const rows = await db
    .select({ release: schema.releases, application: schema.applications })
    .from(schema.releases)
    .innerJoin(schema.applications, eq(schema.releases.applicationId, schema.applications.id))
    .where(eq(schema.releases.id, releaseId))
    .limit(1);
  const row = rows[0];
  if (!row) return; // The release was deleted between enqueue and pickup.

  const { release, application } = row;
  // A redelivered message must never rebuild a release: a READY release is
  // immutable (customers run its digest), and a started build settles
  // through its own event. Only a failure before any build started retries.
  if (
    release.releaseStatus === 'READY' ||
    release.buildStatus === 'BUILDING' ||
    release.currentBuildId !== null
  ) {
    return;
  }
  const installationId = application.githubInstallationId;
  if (!installationId) {
    await failRelease(db, releaseId, 'No GitHub installation is linked to this application', 'build_failed');
    return;
  }

  try {
    // These strings reach the CodeBuild environment and the Docker command
    // line; the route checks them too, but a row can arrive from any path.
    if (!RELEASE_VERSION_PATTERN.test(release.version)) {
      throw new Error('The release version is not valid for a build');
    }
    if (!RELEASE_GIT_SHA_PATTERN.test(release.gitSha)) {
      throw new Error('The release does not name a commit sha');
    }
    const { token } = await mintInstallationToken(
      installationId,
      requireEnv('GITHUB_APP_ID'),
      requireEnv('GITHUB_APP_PRIVATE_KEY'),
      Date.now(),
      deps.fetchFn,
    );

    const bucket = requireEnv('SOURCE_BUCKET');
    const archive = await fetchRepoArchive(token, application.repoFullName, deps.fetchFn, deps.s3, {
      bucket,
      s3KeyPrefix: `build-source/${application.id}/${release.id}`,
      ref: release.gitSha,
    });

    // The analyser records where the Dockerfile actually lives; a repository
    // is free to keep it out of the root. A vendor PATCH override
    // (detected_metadata.manifestOverrides) WINS over detection — the build
    // must follow the same manifest the deployment gate read, or an
    // override-corrected app would still be built from the wrong files.
    const storedOverrides = (application.detectedMetadata?.['manifestOverrides'] ?? {}) as Record<
      string,
      unknown
    >;
    const overrideDockerfile =
      typeof storedOverrides['dockerfilePath'] === 'string' && storedOverrides['dockerfilePath'].length > 0
        ? storedOverrides['dockerfilePath']
        : undefined;
    const overrideBuildContext =
      typeof storedOverrides['buildContext'] === 'string' && storedOverrides['buildContext'].length > 0
        ? storedOverrides['buildContext']
        : undefined;
    const dockerfilePath =
      overrideDockerfile ??
      (application.detectedMetadata?.['dockerfilePath'] as string | undefined) ??
      'Dockerfile';
    const detectedBuildContext = application.detectedMetadata?.['dockerfileBuildContext'];
    // The detected root context follows the detected Dockerfile only; an
    // overridden Dockerfile is the vendor's own and keeps the directory rule.
    const buildContext =
      overrideBuildContext ??
      (overrideDockerfile === undefined && typeof detectedBuildContext === 'string' ? detectedBuildContext : undefined) ??
      resolveBuildContext(dockerfilePath);
    if (!isRepoRelativePath(dockerfilePath) || (buildContext !== undefined && !isRepoRelativePath(buildContext))) {
      throw new Error('The Dockerfile path and the build context must be paths inside the repository');
    }

    const environmentVariables: { name: string; value: string }[] = [
      { name: 'SOURCE_S3_URI', value: `s3://${bucket}/${archive.s3Key}` },
      { name: 'RELEASE_VERSION', value: releaseImageTag(application.id, release.version) },
      { name: 'GIT_SHA', value: release.gitSha },
      { name: 'RELEASE_ID', value: release.id },
      { name: 'DOCKERFILE_PATH', value: dockerfilePath },
    ];
    if (buildContext !== undefined) {
      environmentVariables.push({ name: 'BUILD_CONTEXT', value: buildContext });
    }
    // The detected application stage of a Dockerfile that ends with a tooling
    // stage. It describes the detected Dockerfile only, like the build context.
    const detectedBuildTarget = application.detectedMetadata?.['dockerfileBuildTarget'];
    if (overrideDockerfile === undefined && typeof detectedBuildTarget === 'string' && DOCKER_STAGE_NAME.test(detectedBuildTarget)) {
      environmentVariables.push({ name: 'BUILD_TARGET', value: detectedBuildTarget });
    }

    // §31 env setup: vendor-configured build-stage variables become
    // `--build-arg NAME` in the buildspec (build-pipeline.ts), which reads
    // each value straight out of the CodeBuild environment — the name list
    // is the only thing that travels as its own variable, never a value.
    const buildVariables = await deps.loadBuildVariables(db, application.id);
    if (buildVariables.length > 0) {
      environmentVariables.push(...buildVariables);
      environmentVariables.push({
        name: 'DEPLOYZ_BUILD_ARG_NAMES',
        value: buildVariables.map((variable) => variable.name).join(' '),
      });
    }

    const buildId = await deps.startBuild({
      projectName: requireEnv('BUILD_PROJECT_NAME'),
      environmentVariables,
    });

    // Pin the release to this build attempt so a terminal event from any
    // earlier attempt (redelivered, or racing a retried build) reads as
    // stale instead of corrupting the result.
    await db.transaction(async (tx) => {
      await tx
        .update(schema.releases)
        .set({
          buildStatus: 'BUILDING',
          releaseStatus: 'BUILDING',
          ...(buildId ? { currentBuildId: buildId } : {}),
        })
        .where(eq(schema.releases.id, releaseId));
      await insertReleaseBuildEvent(tx, {
        organizationId: application.organizationId,
        releaseId,
        applicationId: application.id,
        eventType: 'release.build_started',
        result: 'pending',
      });
    });
  } catch (error) {
    await failRelease(
      db,
      releaseId,
      error instanceof Error ? error.message : String(error),
      'build_failed',
    );
    throw error;
  }
}

async function failRelease(
  db: RuntimeDb,
  releaseId: string,
  reason: string,
  failureCode: ReleaseBuildFailureCode,
): Promise<void> {
  console.error(`release ${releaseId} build failed: ${reason}`);
  // The event needs organization_id (releases has no such column), so the
  // application join resolves it — same join buildRelease and
  // recordBuildResult make. The release may have been deleted meanwhile;
  // the update still runs (no-op) and only an existing release emits.
  const rows = await db
    .select({ application: schema.applications })
    .from(schema.releases)
    .innerJoin(schema.applications, eq(schema.releases.applicationId, schema.applications.id))
    .where(eq(schema.releases.id, releaseId))
    .limit(1);
  const application = rows[0]?.application;
  await db.transaction(async (tx) => {
    await tx
      .update(schema.releases)
      .set({
        buildStatus: 'FAILED',
        releaseStatus: 'FAILED',
        failureReason: reason.slice(0, 500),
      })
      .where(eq(schema.releases.id, releaseId));
    if (application) {
      // If a READY release newer than the deployment's current release no
      // longer exists, revert UPDATE_AVAILABLE back to HEALTHY — the state
      // must mean a genuinely newer READY release exists (§46).
      const updateAvailable = await tx
        .select({ id: schema.deployments.id, currentReleaseId: schema.deployments.currentReleaseId })
        .from(schema.deployments)
        .where(
          and(
            eq(schema.deployments.applicationId, application.id),
            eq(schema.deployments.state, 'UPDATE_AVAILABLE'),
          ),
        );
      for (const dep of updateAvailable) {
        const stillHasNewer = await newerReadyReleaseExists(
          db,
          application.id,
          dep.currentReleaseId,
        );
        if (!stillHasNewer) {
          await tx
            .update(schema.deployments)
            .set({ state: 'HEALTHY' })
            .where(
              and(
                eq(schema.deployments.id, dep.id),
                eq(schema.deployments.state, 'UPDATE_AVAILABLE'),
              ),
            );
        }
      }
      await insertReleaseBuildEvent(tx, {
        organizationId: application.organizationId,
        releaseId,
        applicationId: application.id,
        eventType: 'release.build_failed',
        result: 'failure',
        failureCode,
      });
    }
  });
}

// ── CodeBuild completion ─────────────────────────────────────────────────

function readVariable(
  variables: readonly { name: string; value: string }[] | undefined,
  name: string,
): string | undefined {
  return variables?.find((variable) => variable.name === name)?.value;
}

/**
 * StartBuild resolves a build id in the short "project-name:uuid" form, but
 * the EventBridge CodeBuild state-change event's `detail['build-id']` is the
 * full ARN `arn:aws:codebuild:region:acct:build/project-name:uuid`. Strips
 * everything through the `:build/` marker so both sides of a correlation
 * check compare in the same format. Input with no marker (already short) is
 * returned unchanged.
 */
export function normalizeBuildId(buildId: string): string {
  const marker = ':build/';
  const index = buildId.indexOf(marker);
  return index === -1 ? buildId : buildId.slice(index + marker.length);
}

/**
 * The first failed phase's context from a CodeBuild event — e.g.
 * "POST_BUILD: COMMAND_EXECUTION_ERROR: Error while executing command:
 * docker push …". "CodeBuild reported FAILED" alone leaves the vendor
 * opening the AWS console to learn why; the event already carries the why.
 */
export function buildFailureDetail(event: CodeBuildStateChangeEvent): string | null {
  const phases = event.detail['additional-information']?.phases ?? [];
  for (const phase of phases) {
    if (phase['phase-status'] !== 'FAILED' && phase['phase-status'] !== 'FAULT') continue;
    const context = (phase['phase-context'] ?? []).find((entry) => entry.trim().length > 0);
    if (context === undefined) continue;
    return `${phase['phase-type'] ?? 'unknown phase'}: ${context}`.slice(0, 400);
  }
  return null;
}

export async function recordBuildResult(
  db: RuntimeDb,
  event: CodeBuildStateChangeEvent,
): Promise<void> {
  // The real EventBridge event nests exported vars under
  // additional-information; the top-level spelling is kept for the sweep's
  // synthesized events and any older payloads. (Verified live 2026-08-30: a
  // SUCCEEDED build's digest arrived ONLY under additional-information, and
  // the release was wrongly failed as digest-less.)
  const topLevelExported = event.detail['exported-environment-variables'];
  const exported =
    topLevelExported !== undefined && topLevelExported.length > 0
      ? topLevelExported
      : event.detail['additional-information']?.['exported-environment-variables'];
  const supplied = event.detail['additional-information']?.environment?.['environment-variables'];
  const releaseId = readVariable(exported, 'RELEASE_ID') ?? readVariable(supplied, 'RELEASE_ID');
  if (!releaseId) return; // A build the control plane did not start.

  const releaseRows = await db
    .select({ release: schema.releases, application: schema.applications })
    .from(schema.releases)
    .innerJoin(schema.applications, eq(schema.releases.applicationId, schema.applications.id))
    .where(eq(schema.releases.id, releaseId))
    .limit(1);
  const release = releaseRows[0]?.release;
  const application = releaseRows[0]?.application;
  if (!release) return;

  // Build-attempt correlation: an event for any build other than the one
  // currently pinning the release is stale — a redelivery of an earlier
  // attempt, or a terminal report racing a retry. Moving the release on it
  // could flip a fresh success back to FAILED or resurrect an old digest.
  // Releases with no pinned build (started before correlation existed)
  // still accept any event while in flight.
  const eventBuildId = event.detail['build-id'];
  if (
    release.currentBuildId !== null &&
    eventBuildId !== undefined &&
    normalizeBuildId(eventBuildId) !== normalizeBuildId(release.currentBuildId)
  ) {
    console.warn(
      `ignoring stale CodeBuild event for release ${releaseId}: event build ${eventBuildId}, current build ${release.currentBuildId}`,
    );
    return;
  }

  // Duplicate terminal delivery for the same build: the release is already
  // settled, re-writing the same outcome is at best a wasted write.
  if (release.releaseStatus !== 'BUILDING') {
    console.warn(
      `ignoring duplicate CodeBuild event for release ${releaseId}: already ${release.releaseStatus}`,
    );
    return;
  }

  const status = event.detail['build-status'];
  if (status !== 'SUCCEEDED') {
    const detail = buildFailureDetail(event);
    await failRelease(
      db,
      releaseId,
      `CodeBuild reported ${status}${detail === null ? '' : ` — ${detail}`}`,
      buildFailureCode(status, detail),
    );
    return;
  }

  const imageDigest = readVariable(exported, 'IMAGE_DIGEST');
  if (!imageDigest) {
    await failRelease(db, releaseId, 'Build succeeded without an image digest', 'build_failed');
    return;
  }

  await db.transaction(async (tx) => {
    await tx
      .update(schema.releases)
      .set({ imageDigest, buildStatus: 'SUCCEEDED', releaseStatus: 'READY' })
      .where(eq(schema.releases.id, releaseId));
    if (application) {
      await flipHealthyDeploymentsToUpdateAvailable(tx, application.id);
      await insertReleaseBuildEvent(tx, {
        organizationId: application.organizationId,
        releaseId,
        applicationId: application.id,
        eventType: 'release.build_completed',
        result: 'success',
      });
    }
  });
}

// ── Dispatch ─────────────────────────────────────────────────────────────

export async function handleMessage(
  deps: WorkerDeps,
  message: QueueMessage,
  messageId: string,
): Promise<void> {
  switch (message.type) {
    case 'ANALYSE_APPLICATION':
      // `force` must survive the queue hop: the vendor's explicit Re-analyse
      // bypasses the commit-SHA cache, and dropping it here silently turned
      // that into a cache hit whenever the head commit had not moved.
      await deps.runAnalysis(message.applicationId, { force: message.force === true });
      return;
    case 'BUILD_RELEASE':
      await buildRelease(deps, message.releaseId);
      return;
    case 'CONFIG_UPDATE':
      await fanOutConfigUpdate(deps.db, message, messageId);
      return;
  }
}

// ── Stuck-job watchdog / reconciler (reconcile-before-fail) ──────────────

// Staleness bound per job type (how long with NO signal before the relay is
// presumed gone for this job): JOB_TIMEOUTS_MS lives in @deployz/contracts —
// shared with Team Admin's STUCK flag (docs/admin/team-admin.md) so the
// sweep and the admin view can never disagree. Heartbeats refresh
// lastProgressAt on every active job, so tripping it means the relay itself
// has gone quiet — never that a live operation is merely slow. DESTROY is
// deliberately absent: a dead-relay DESTROY is settled by the vendor's
// force-complete escape hatch, never failed by the watchdog.

/**
 * Runtime bound per attempt with a LIVE relay. Heartbeats keep
 * lastProgressAt fresh whether or not the operation is actually moving, so a
 * relay invocation that died between an AWS mutation and its checkpoint
 * write leaves a RUNNING job no signal will ever settle — the staleness
 * clock cannot see it. Past this bound the job is re-offered to the relay
 * (state back to REQUESTED): every relay executor reads AWS state before
 * acting (describe-before-create/delete, digest short-circuit), so a
 * re-offer converges on what actually happened instead of repeating the
 * mutation, and the result route ignores a late duplicate report.
 */
const JOB_MAX_RUNTIME_MS: Partial<Record<(typeof schema.deploymentJobs.$inferSelect)['type'], number>> = {
  INSTALL: 90 * 60 * 1000,
  DEPLOY_RELEASE: 30 * 60 * 1000,
  ROLLBACK: 30 * 60 * 1000,
  RESTART: 30 * 60 * 1000,
  CONFIG_UPDATE: 30 * 60 * 1000,
  DESTROY: 90 * 60 * 1000,
  PURGE: 90 * 60 * 1000,
  CONFIGURE_DOMAIN: 90 * 60 * 1000,
  REMOVE_DOMAIN: 90 * 60 * 1000,
};

/** Re-offers per job before the watchdog concludes the operation is wedged. */
const MAX_RECONCILE_REQUEUES = 3;

/**
 * How long past its staleness bound a WAITING job may sit on a disconnected
 * relay before the watchdog finally fails it. Long on purpose: a relay that
 * comes back resumes from its checkpoint, and prematurely failing the job
 * would misreport an operation that may have finished in AWS.
 */
const RELAY_WAIT_GRACE_MS = 24 * 60 * 60 * 1000;

const ACTIVE_MUTATING_STATES = ['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING'] as const;

/**
 * Reconciles stuck mutating jobs instead of blindly failing them.
 *
 * Live relay: a job past its runtime bound (or stale in flight) is re-offered
 * to the relay (bounded by MAX_RECONCILE_REQUEUES), whose describe-first
 * executors resolve the true AWS state; only exhausted re-offers fail.
 *
 * Dead relay: the job is parked WAITING (surfaced as "waiting for the
 * customer's AWS connection", never a false FAILED); the relay's next command
 * poll claims WAITING jobs back. Only after RELAY_WAIT_GRACE_MS does the
 * watchdog fail it, classified RELAY_DISCONNECTED.
 *
 * Failure settlement matches the relay result route: a failed day-2
 * operation on a deployment with a running release never marks the whole
 * deployment FAILED.
 */
export async function sweepStuckJobs(
  db: RuntimeDb,
  now: Date = new Date(),
  failureShadow?: JevFailureShadowRunner,
): Promise<number> {
  const rows = await db
    .select({ job: schema.deploymentJobs, deployment: schema.deployments })
    .from(schema.deploymentJobs)
    .innerJoin(schema.deployments, eq(schema.deploymentJobs.deploymentId, schema.deployments.id))
    .where(
      inArray(schema.deploymentJobs.state, [...ACTIVE_MUTATING_STATES]),
    );

  let settled = 0;
  for (const { job, deployment } of rows) {
    const timeout = JOB_TIMEOUTS_MS[job.type];
    const maxRuntime = JOB_MAX_RUNTIME_MS[job.type];
    const lastSignal = job.lastProgressAt ?? job.startedAt ?? job.createdAt;
    const runtimeStart = job.startedAt ?? job.createdAt;
    const stale = timeout !== undefined && now.getTime() - lastSignal.getTime() > timeout;
    const inFlight = job.state === 'RUNNING' || job.state === 'WAITING';
    const overRuntime =
      maxRuntime !== undefined && inFlight && now.getTime() - runtimeStart.getTime() > maxRuntime;

    const evidence = {
      jobType: job.type,
      startedAt: job.startedAt?.toISOString() ?? null,
      lastProgressAt: job.lastProgressAt?.toISOString() ?? null,
      relayStatus: deployment.relayStatus,
      reconcileCount: job.reconcileCount,
    };

    if (deployment.relayStatus === 'CONNECTED') {
      if (!stale && !overRuntime) continue;

      if (inFlight && job.reconcileCount < MAX_RECONCILE_REQUEUES) {
        await db.transaction(async (tx) => {
          const requeued = await tx
            .update(schema.deploymentJobs)
            .set({
              state: 'REQUESTED',
              reconcileCount: job.reconcileCount + 1,
              lastProgressAt: now,
            })
            .where(
              and(
                eq(schema.deploymentJobs.id, job.id),
                inArray(schema.deploymentJobs.state, ['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING']),
              ),
            )
            .returning({ id: schema.deploymentJobs.id });
          // Job already settled (result route won the race) — nothing to requeue.
          if (requeued.length === 0) return;
          await tx.insert(schema.eventLogs).values({
            actorType: 'system',
            actorId: 'watchdog',
            organizationId: deployment.organizationId,
            customerId: deployment.customerId,
            deploymentId: deployment.id,
            jobId: job.id,
            eventType: 'operation.requeued',
            previousState: deployment.state,
            requestedState: null,
            result: 'pending',
            payload: evidence,
          });
        });
        settled += 1;
        continue;
      }

      // Re-offers exhausted (or the relay never claims what it is offered).
      // DESTROY still never fails from here — force-complete owns it.
      if (timeout === undefined) continue;
      await failStuckJob(
        db,
        job,
        deployment,
        now,
        job.type === 'CONFIGURE_DOMAIN' || job.type === 'REMOVE_DOMAIN'
          ? 'DOMAIN_OPERATION_TIMEOUT'
          : 'UNKNOWN',
        evidence,
        failureShadow,
      );
      settled += 1;
      continue;
    }

    // Relay not connected. DESTROY (no timeout entry) is force-complete's.
    if (timeout === undefined || !stale) continue;

    if (job.state !== 'WAITING') {
      // Park, don't fail: the operation may have finished in AWS, and a
      // returning relay resumes from its checkpoint. lastProgressAt is left
      // alone so the grace clock keeps measuring real silence.
      await db.transaction(async (tx) => {
        await tx
          .update(schema.deploymentJobs)
          .set({ state: 'WAITING' })
          .where(eq(schema.deploymentJobs.id, job.id));
        await tx.insert(schema.eventLogs).values({
          actorType: 'system',
          actorId: 'watchdog',
          organizationId: deployment.organizationId,
          customerId: deployment.customerId,
          deploymentId: deployment.id,
          jobId: job.id,
          eventType: 'operation.waiting_for_relay',
          previousState: deployment.state,
          requestedState: null,
          result: 'pending',
          payload: evidence,
        });
      });
      settled += 1;
      continue;
    }

    if (now.getTime() - lastSignal.getTime() > timeout + RELAY_WAIT_GRACE_MS) {
      await failStuckJob(db, job, deployment, now, 'RELAY_DISCONNECTED', evidence, failureShadow);
      settled += 1;
    }
  }
  return settled;
}

async function failStuckJob(
  db: RuntimeDb,
  job: typeof schema.deploymentJobs.$inferSelect,
  deployment: typeof schema.deployments.$inferSelect,
  now: Date,
  failureCode: 'UNKNOWN' | 'RELAY_DISCONNECTED' | 'DOMAIN_OPERATION_TIMEOUT',
  evidence: Record<string, unknown>,
  failureShadow?: JevFailureShadowRunner,
): Promise<void> {
  // Phase 5 §9.3: a domain job timeout must never fail the DEPLOYMENT —
  // the domain is a separate lifecycle (same rule as the relay result
  // route's isDomainJobType guard). Its failure surfaces on the
  // custom_domains row instead, and the next heartbeat nudge opens a fresh
  // retry cycle.
  const isDomainJob = job.type === 'CONFIGURE_DOMAIN' || job.type === 'REMOVE_DOMAIN';
  // Same settlement rule as the relay result route: a timed-out day-2
  // operation on a deployment with a running release must not mark the
  // whole deployment FAILED — the previous release is still serving.
  // currentReleaseId alone under-counts this: a first install runs the
  // template-pinned image with no release row ever deployed (CANARY-008),
  // so a SUCCEEDED install also counts as a running workload.
  const nextState = isDomainJob
    ? null
    : deploymentStateAfterFailedJob({
        jobType: job.type,
        hasCurrentRelease:
          deployment.currentReleaseId !== null ||
          (await hasStartedInstall(db, deployment.id)),
        newerReadyReleaseExists: await newerReadyReleaseExists(
          db,
          deployment.applicationId,
          deployment.currentReleaseId,
        ),
      });

  let settledHere = false;
  await db.transaction(async (tx) => {
    const failed = await tx
      .update(schema.deploymentJobs)
      .set({
        state: 'FAILED',
        finishedAt: now,
        failureCode,
        result: { timeout: true, reconcileAttempts: job.reconcileCount },
      })
      .where(
        and(
          eq(schema.deploymentJobs.id, job.id),
          inArray(schema.deploymentJobs.state, ['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING']),
        ),
      )
      .returning({ id: schema.deploymentJobs.id });
    // Job already settled by the result route — skip all side effects.
    if (failed.length === 0) return;
    settledHere = true;

    if (nextState !== null) {
      await tx
        .update(schema.deployments)
        .set({ state: nextState })
        .where(eq(schema.deployments.id, deployment.id));
    }

    if (isDomainJob) {
      await tx
        .update(schema.customDomains)
        .set({ lastError: failureCode })
        .where(
          and(
            eq(schema.customDomains.deploymentId, deployment.id),
            isNull(schema.customDomains.removedAt),
          ),
        );
    }

    // Phase 5 §9.2: a timed-out PURGE keeps the deployment DELETED (the
    // cleanup lifecycle is separate) — the failure lands on cleanupState so
    // the purge stays retryable from PURGE_FAILED instead of resurrecting
    // the deployment into a deployment-failure state.
    if (job.type === 'PURGE') {
      await tx
        .update(schema.deployments)
        .set({ cleanupState: 'PURGE_FAILED' })
        .where(eq(schema.deployments.id, deployment.id));
    }

    await tx.insert(schema.eventLogs).values({
      actorType: 'system',
      actorId: 'watchdog',
      organizationId: deployment.organizationId,
      customerId: deployment.customerId,
      deploymentId: deployment.id,
      jobId: job.id,
      eventType: 'operation.timeout',
      previousState: deployment.state,
      requestedState: nextState,
      result: 'failure',
      payload: evidence,
    });
  });

  // Jev UNKNOWN-failure shadow (PR 3): fire-and-forget telemetry after the
  // settlement — only when this call was the one that settled the job and
  // the code stayed UNKNOWN. The runner swallows its own errors; the
  // watchdog's own behavior is unchanged.
  if (settledHere && failureCode === 'UNKNOWN') {
    const lastSignal = job.lastProgressAt ?? job.startedAt ?? job.createdAt;
    void failureShadow
      ?.run({
        deploymentId: deployment.id,
        jobId: job.id,
        deploymentStage: job.type,
        failureReason: `Watchdog failed the job after exhausting re-offers: relayStatus=${String(evidence['relayStatus'])}, reconcileCount=${String(evidence['reconcileCount'])}, lastProgressAt=${String(evidence['lastProgressAt'] ?? 'never')}.`,
        healthStatus: deployment.healthStatus,
        relayStatus: deployment.relayStatus,
        elapsedMs: now.getTime() - lastSignal.getTime(),
        retryCount: job.reconcileCount,
        deployzFailureCode: 'UNKNOWN',
      })
      .catch(() => {});
  }
}

// ── Relay-liveness sweep ──────────────────────────────────────────────────

/**
 * Persists DISCONNECTED on deployments whose relay missed its check-in
 * window. Reads trust the persisted column (see toFleetRow), so someone has
 * to write the transition — this is that someone. A relay that registered
 * but died before its first health report counts from relayBoundAt instead
 * of lastHealthAt, which would otherwise stay NULL forever and pin the row
 * at CONNECTED. A returning relay needs no help: its heartbeat writes
 * CONNECTED back directly.
 */
export async function sweepRelayLiveness(db: RuntimeDb, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RELAY_STALE_AFTER_MS);
  const swept = await db
    .update(schema.deployments)
    .set({ relayStatus: 'DISCONNECTED' })
    .where(
      and(
        eq(schema.deployments.relayStatus, 'CONNECTED'),
        or(
          lt(schema.deployments.lastHealthAt, cutoff),
          and(
            isNull(schema.deployments.lastHealthAt),
            isNotNull(schema.deployments.relayBoundAt),
            lt(schema.deployments.relayBoundAt, cutoff),
          ),
        ),
      ),
    )
    .returning({ id: schema.deployments.id });
  return swept.length;
}

// ── Stuck-build watchdog ─────────────────────────────────────────────────

/**
 * A missed or lost CodeBuild state-change event otherwise leaves a release
 * BUILDING forever — nothing else ever moves it on. Every 30 minutes without
 * a status update, ask CodeBuild directly what happened and settle the
 * release the same way a real event would (reusing recordBuildResult, so
 * status/digest handling is not duplicated). A build CodeBuild still reports
 * IN_PROGRESS is left untouched; a build id CodeBuild no longer knows about
 * fails the release outright.
 */
const STUCK_BUILD_TIMEOUT_MS = 30 * 60 * 1000;

export async function sweepStuckBuilds(deps: WorkerDeps, now: Date = new Date()): Promise<number> {
  const { db } = deps;
  const cutoff = new Date(now.getTime() - STUCK_BUILD_TIMEOUT_MS);

  // A worker that died before it started CodeBuild (for example out of
  // memory on a huge repository) leaves a BUILDING release with no build id.
  const neverStarted = await db
    .select({ id: schema.releases.id })
    .from(schema.releases)
    .where(
      and(
        eq(schema.releases.releaseStatus, 'BUILDING'),
        isNull(schema.releases.currentBuildId),
        lt(schema.releases.updatedAt, cutoff),
      ),
    );
  for (const release of neverStarted) {
    await failRelease(db, release.id, 'The build did not start. Try the release again.', 'build_timeout');
  }
  const stuck = await db
    .select()
    .from(schema.releases)
    .where(
      and(
        eq(schema.releases.releaseStatus, 'BUILDING'),
        isNotNull(schema.releases.currentBuildId),
        lt(schema.releases.updatedAt, cutoff),
      ),
    );
  if (stuck.length === 0) return neverStarted.length;

  const builds = await deps.batchGetBuilds(
    stuck.map((release) => release.currentBuildId as string),
  );
  const buildsById = new Map(builds.map((build) => [normalizeBuildId(build.id), build]));

  let swept = neverStarted.length;
  for (const release of stuck) {
    const build = buildsById.get(normalizeBuildId(release.currentBuildId as string));
    if (!build) {
      await failRelease(db, release.id, 'CodeBuild no longer has a record of this build', 'build_timeout');
      swept += 1;
      continue;
    }
    if (build.buildStatus === 'IN_PROGRESS') continue; // Still running — leave it.

    await recordBuildResult(db, {
      'detail-type': 'CodeBuild Build State Change',
      detail: {
        'build-status': build.buildStatus,
        'build-id': build.id,
        ...(build.phases !== undefined
          ? { 'additional-information': { phases: build.phases } }
          : {}),
        'exported-environment-variables': [
          ...(build.exportedEnvironmentVariables ?? []),
          { name: 'RELEASE_ID', value: release.id },
        ],
      },
    });
    swept += 1;
  }
  return swept;
}

// ── Billing safety job (Paddle migration Phase 10) ───────────────────────
//
// Every billing write in the request path is best-effort by design: a Paddle
// failure or a lost write must never fail a deployment. This sweep is what
// makes that safe — it runs on the same 15-minute schedule as the watchdogs
// and closes the three gaps that leaves. It is also where billing pauses and
// resumes with whether a live deployment serves the customer.

/** A webhook event row still claimed after this long was abandoned by a crash. */
const STUCK_WEBHOOK_EVENT_MS = 10 * 60 * 1000;

/** How stale a subscription's last reconciliation may be before the sweep redoes it. */
const RECONCILE_STALE_AFTER_MS = 60 * 60 * 1000;

export interface BillingSweepResult {
  /** Deployments observed READY whose billing activation never landed. */
  promoted: number;
  /** Live deployments whose billing paused or resumed with their serving state. */
  servingChanged: number;
  /** Webhook event rows released so Paddle's next redelivery is processed. */
  unstuck: number;
  /** Organizations whose subscription quantity was re-checked against Paddle. */
  reconciled: number;
}

/**
 * The billing safety net (transition map row 20).
 *
 *  1. Promotes a PRODUCTION deployment that reached READY but is still
 *     NOT_STARTED. The signal is the PERSISTED `step_timings.READY` entry,
 *     not a re-derivation: advanceStepTimings always stamps the active step,
 *     and markDeploymentLive runs independently of that write, so a row with
 *     a READY timing and no billing state is exactly a missed activation.
 *     DELETING/DELETED rows are excluded — the billing state machine does
 *     not read the lifecycle state for activation, so this query has to
 *     exclude them itself, or the sweep would start billing something being
 *     torn down.
 *
 *  1b. Pauses billing for an ACTIVE production deployment that no longer
 *     serves the customer (FAILED, or connector DISCONNECTED) and resumes a
 *     PAUSED one that is connected and HEALTHY / UPDATE_AVAILABLE again
 *     (syncServingBilling). DISCONNECTED is persisted only after
 *     RELAY_STALE_AFTER_MS, and this pass runs every 15 minutes, so a short
 *     heartbeat gap never changes the Paddle quantity. The relay write paths
 *     resume a PAUSED deployment sooner, at its next verified READY stage.
 *
 *  2. Releases `billing_provider_events` rows abandoned in RECEIVED. A crash
 *     between the insert and processing leaves a row that makes Paddle's
 *     redelivery read as a duplicate, so the event is never processed at all.
 *     FAILED is the state handlePaddleWebhook retries.
 *
 *  3. Re-checks subscriptions whose quantity has not been reconciled for an
 *     hour. This is what lets the request path skip reconciling on every
 *     harmless transition: drift is bounded by this pass, not by hoping no
 *     call was ever missed.
 *
 * Never throws for one organization's sake: each reconcile is independent and
 * records its own outcome.
 */
export async function sweepBilling(
  db: RuntimeDb,
  paddle: PaddleBilling | null,
  now: Date = new Date(),
): Promise<BillingSweepResult> {
  const organizationsToReconcile = new Set<string>();

  // 1. Missed activations.
  const missed = await db
    .select()
    .from(schema.deployments)
    .where(
      and(
        eq(schema.deployments.deploymentType, 'PRODUCTION'),
        eq(schema.deployments.billingState, 'NOT_STARTED'),
        notInArray(schema.deployments.state, ['DELETING', 'DELETED']),
        // `-> 'READY' IS NOT NULL`, never the `?` containment operator: `?`
        // collides with the driver's own parameter placeholders.
        sql`${schema.deployments.stepTimings} -> 'READY' IS NOT NULL`,
      ),
    );
  let promoted = 0;
  for (const deployment of missed) {
    // Attributed to the safety job, not the relay: the relay never reported
    // this one — that is precisely why the sweep had to catch it.
    const promotedHere = await markDeploymentLive(db, deployment, now, {
      actorType: 'system',
      actorId: 'billing-safety-job',
    });
    if (promotedHere) {
      promoted += 1;
      organizationsToReconcile.add(deployment.organizationId);
    }
  }

  // 1b. Serving changes on live deployments.
  const live = await db
    .select()
    .from(schema.deployments)
    .where(
      and(
        eq(schema.deployments.deploymentType, 'PRODUCTION'),
        inArray(schema.deployments.billingState, ['ACTIVE', 'PAUSED']),
        notInArray(schema.deployments.state, ['DELETING', 'DELETED']),
      ),
    );
  let servingChanged = 0;
  for (const deployment of live) {
    if (await syncServingBilling(db, deployment, now)) {
      servingChanged += 1;
      organizationsToReconcile.add(deployment.organizationId);
    }
  }

  // 2. Abandoned webhook events.
  const unstuck = await db
    .update(schema.billingProviderEvents)
    .set({ processingStatus: 'FAILED', error: 'abandoned in RECEIVED; released for redelivery' })
    .where(
      and(
        eq(schema.billingProviderEvents.processingStatus, 'RECEIVED'),
        lt(schema.billingProviderEvents.createdAt, new Date(now.getTime() - STUCK_WEBHOOK_EVENT_MS)),
      ),
    )
    .returning({ id: schema.billingProviderEvents.id });

  // 3. Drift sweep over subscriptions Paddle will still accept updates for.
  const stale = await db
    .select({ organizationId: schema.billingSubscriptions.organizationId })
    .from(schema.billingSubscriptions)
    .where(
      and(
        inArray(schema.billingSubscriptions.status, ['ACTIVE', 'PAST_DUE']),
        or(
          isNull(schema.billingSubscriptions.lastReconciledAt),
          lt(
            schema.billingSubscriptions.lastReconciledAt,
            new Date(now.getTime() - RECONCILE_STALE_AFTER_MS),
          ),
        ),
      ),
    );
  for (const row of stale) organizationsToReconcile.add(row.organizationId);

  for (const organizationId of organizationsToReconcile) {
    await reconcileBilling({ db, paddle, now: () => now }, organizationId);
  }

  return { promoted, servingChanged, unstuck: unstuck.length, reconciled: organizationsToReconcile.size };
}

/**
 * DEPLOY-027 (Phase 4): TTL sweep over pending_secrets. Plain SQL DELETE,
 * no KMS — the sweep just drops ciphertext the API can no longer decrypt
 * because the customer never enrolled within `DEFAULT_PENDING_SECRET_TTL_MS`.
 * Both tiers go (staged and bound): a staged row older than the TTL was
 * never materialized, and a bound row older than the TTL belongs to a
 * deployment whose relay never enrolled.
 */
export async function sweepExpiredPendingSecrets(
  db: RuntimeDb,
  now: Date = new Date(),
): Promise<number> {
  const deleted = await db
    .delete(schema.pendingSecrets)
    .where(lt(schema.pendingSecrets.expiresAt, now))
    .returning();
  return deleted.length;
}

/**
 * Counts-only inventory of stored config-secret ciphertext, by storage
 * format (`none`, legacy `stub`, `kms1`, `other`), age, and — for the
 * pending-secret vault — tier, expiry, and delivery state. Logged on every
 * watchdog tick so operators can follow the legacy-row migration from
 * CloudWatch. Reads no value and returns no identifier.
 */
export async function inventoryConfigSecrets(db: RuntimeDb, now: Date = new Date()): Promise<{
  vendor: Record<string, number>;
  customerScopeCiphertext: number;
  pending: Record<string, number>;
}> {
  const format = (column: typeof schema.applicationConfigs.encryptedValue | typeof schema.pendingSecrets.ciphertext) =>
    sql<string>`CASE WHEN ${column} IS NULL THEN 'none' WHEN ${column} LIKE 'enc:%' THEN 'stub' WHEN ${column} LIKE 'kms1:%' THEN 'kms1' ELSE 'other' END`;
  const nowIso = now.toISOString();
  const age = (column: typeof schema.applicationConfigs.updatedAt | typeof schema.pendingSecrets.createdAt) =>
    sql<string>`CASE WHEN ${column} > ${nowIso}::timestamptz - interval '1 day' THEN 'lt1d' WHEN ${column} > ${nowIso}::timestamptz - interval '7 days' THEN '1to7d' WHEN ${column} > ${nowIso}::timestamptz - interval '30 days' THEN '7to30d' ELSE 'gt30d' END`;
  const count = sql<number>`count(*)::int`;

  const vendorFormat = format(schema.applicationConfigs.encryptedValue);
  const vendorAge = age(schema.applicationConfigs.updatedAt);
  const vendorRows = await db
    .select({ format: vendorFormat, age: vendorAge, count })
    .from(schema.applicationConfigs)
    .where(and(eq(schema.applicationConfigs.isSecret, true), isNull(schema.applicationConfigs.customerId)))
    .groupBy(sql`1`, sql`2`);

  const [customerScope] = await db
    .select({ count })
    .from(schema.applicationConfigs)
    .where(and(isNotNull(schema.applicationConfigs.customerId), isNotNull(schema.applicationConfigs.encryptedValue)));

  const pendingFormat = format(schema.pendingSecrets.ciphertext);
  const pendingAge = age(schema.pendingSecrets.createdAt);
  const pendingState = sql<string>`CASE WHEN ${schema.pendingSecrets.expiresAt} > ${nowIso}::timestamptz THEN 'active' ELSE 'expired' END`;
  const pendingTier = sql<string>`CASE WHEN ${schema.pendingSecrets.deploymentId} IS NULL THEN 'staged' ELSE 'bound' END`;
  const pendingDelivered = sql<string>`CASE WHEN ${schema.pendingSecrets.deliveredAt} IS NULL THEN 'undelivered' ELSE 'delivered' END`;
  const pendingRows = await db
    .select({ format: pendingFormat, state: pendingState, tier: pendingTier, delivered: pendingDelivered, age: pendingAge, count })
    .from(schema.pendingSecrets)
    .groupBy(sql`1`, sql`2`, sql`3`, sql`4`, sql`5`);

  const vendor: Record<string, number> = {};
  for (const row of vendorRows) vendor[`${row.format}/${row.age}`] = Number(row.count);
  const pending: Record<string, number> = {};
  for (const row of pendingRows) {
    pending[`${row.format}/${row.state}/${row.tier}/${row.delivered}/${row.age}`] = Number(row.count);
  }
  return { vendor, customerScopeCiphertext: Number(customerScope?.count ?? 0), pending };
}
