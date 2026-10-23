import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScheduledEvent } from 'aws-lambda';

import type { FetchFn, SecretsClient } from './auth.js';
import type { RelayCommandResult } from './commands.js';
import type { EcsDeployClient, EcsDeployDeps } from './deploy.js';
import { createInstallExecutor, createInstallResumer, createRelayHandler, type InstallExecutorDeps } from './index.js';
import { createPendingStore } from './pending.js';
import { createRestartExecutor, createRestartResumer } from './restart.js';
import type { CloudFormationReader } from './verify.js';

// One SSM parameter shared by every store the relay builds, standing in for
// the customer's Parameter Store across Lambda invocations.
const ssm = vi.hoisted(() => {
  // The relay builds its pending store once, at import, from this id.
  process.env['DEPLOYZ_INSTALLATION_ID'] = 'inst-dur';
  return { value: undefined as string | undefined };
});

vi.mock('@aws-sdk/client-ssm', () => {
  class GetParameterCommand {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class PutParameterCommand {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class DeleteParameterCommand {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class SSMClient {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof PutParameterCommand) {
        ssm.value = command.input['Value'] as string;
        return {};
      }
      if (ssm.value === undefined) {
        throw Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
      }
      if (command instanceof DeleteParameterCommand) {
        ssm.value = undefined;
        return {};
      }
      return { Parameter: { Value: ssm.value } };
    }
  }
  return { GetParameterCommand, PutParameterCommand, DeleteParameterCommand, SSMClient };
});

const SERVICE_ARN = 'arn:aws:ecs:us-east-1:151955775369:service/app-cluster/WebService';
const DEF_ARN = 'arn:aws:ecs:us-east-1:151955775369:task-definition/app:7';
const PARAMETER = '/deployz/inst-dur/pending-command';

const restart = {
  id: 'job-restart',
  deploymentId: 'dep-1',
  type: 'RESTART' as const,
  idempotencyKey: 'dep-1:RESTART',
  payload: {},
};

const stubObserve = async () => ({ verified: true, checks: [] });
const stubObserveImage = async (): Promise<string | null> => null;
const stubObserveHealth = async () => ({
  healthStatus: 'UNKNOWN' as const,
  components: { application: 'UNKNOWN' as const, loadBalancer: 'UNKNOWN' as const },
  desiredCount: null,
  runningCount: null,
  unhealthyTargetCount: null,
  pendingTargetCount: null,
  unknownTargetCount: null,
  deploymentRolloutState: null,
});

/** A one-service stack whose forced deployment completes at once. */
function awsWorld() {
  const updates: unknown[] = [];
  const cfn = {
    async describeStack() {
      return { found: true, stack: { stackName: 'deployz-app', status: 'CREATE_COMPLETE', tags: {}, stackId: 'id' } };
    },
    async describeStackResources() {
      return [];
    },
    async listStackResources() {
      return {
        resources: [
          { logicalId: 'WebService', type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE', physicalId: SERVICE_ARN },
          {
            logicalId: 'TargetGroup',
            type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
            status: 'CREATE_COMPLETE',
            physicalId: 'arn:aws:elasticloadbalancing:us-east-1:151955775369:targetgroup/app/c1b2d3e4f5a6b7c8',
          },
        ],
      };
    },
  } as unknown as CloudFormationReader;
  const ecs = {
    async describeServices() {
      return {
        services: [
          {
            desiredCount: 1,
            runningCount: 1,
            taskDefinition: DEF_ARN,
            deployments: [
              { id: `ecs-svc/${updates.length + 1}`, status: 'PRIMARY', taskDefinition: DEF_ARN, rolloutState: 'COMPLETED' },
            ],
          },
        ],
      };
    },
    async updateService(input: unknown) {
      updates.push(input);
    },
  } as unknown as EcsDeployClient;
  const deps: EcsDeployDeps = {
    cfn,
    ecs,
    elb: { async describeTargetHealth() { return { targets: [{ state: 'healthy' }] }; } },
    pending: createPendingStore(PARAMETER),
    stackName: 'deployz-app',
    installationId: 'inst-dur',
    unappliedConfiguration: async () => [],
  };
  return { deps, updates };
}

type ResultReply = 'ok' | 429 | 503 | 'network-error';

/** A control plane that offers `commands` and answers each result POST from `replies`. */
function controlPlane(commands: unknown[], replies: ResultReply[]) {
  const posted: { commandId: string; success: boolean }[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const ok = { status: 200, headers: { get: () => null }, json: async () => ({}) };
    if (url.includes('/result')) {
      const reply = replies.shift() ?? 'ok';
      if (reply === 'network-error') throw new Error('socket hang up');
      if (reply !== 'ok') return { ...ok, status: reply };
      posted.push({
        commandId: decodeURIComponent(url.split('/commands/')[1]!.split('/')[0]!),
        success: (JSON.parse(String(init?.body)) as { success: boolean }).success,
      });
      return ok;
    }
    if (url.includes('/api/relay/commands')) {
      return { ...ok, json: async () => ({ commands }) };
    }
    return ok;
  };
  return { fetchFn, posted };
}

function secretsClient(): SecretsClient {
  return { getSecretValue: async () => ({ SecretString: JSON.stringify({ token: 'tok' }) }) };
}

/** One Lambda invocation: a brand-new handler, so no in-memory state carries over. */
async function invoke(
  world: ReturnType<typeof awsWorld>,
  fetchFn: FetchFn,
  resume: () => Promise<RelayCommandResult[]> = createRestartResumer(world.deps),
): Promise<void> {
  const handler = createRelayHandler({
    secretsClient: secretsClient(),
    fetchFn,
    sleep: async () => {},
    executors: { RESTART: createRestartExecutor(world.deps) },
    resume,
    observe: stubObserve,
    observeImage: stubObserveImage,
    observeHealth: stubObserveHealth,
  });
  await handler({
    version: '0',
    id: 'event-id',
    'detail-type': 'Scheduled Event',
    source: 'aws.events',
    account: '123456789012',
    time: new Date().toISOString(),
    region: 'us-east-1',
    resources: [],
    detail: {},
  } satisfies ScheduledEvent);
}

beforeEach(() => {
  ssm.value = undefined;
  process.env['DEPLOYZ_INSTALLATION_ID'] = 'inst-dur';
  process.env['DEPLOYZ_CREDENTIAL_SECRET_ARN'] = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test';
  process.env['DEPLOYZ_CONTROL_PLANE_URL'] = 'https://api.deployz.dev';
  process.env['DEPLOYZ_ENROLLMENT_CODE'] = 'code-dur';
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a result report that is lost', () => {
  it.each<[string, ResultReply]>([
    ['a 429', 429],
    ['a 503', 503],
    ['a network error', 'network-error'],
  ])('is re-reported from the settled marker after %s, with no second restart', async (_name, failure) => {
    const world = awsWorld();
    // Retries inside one report exhaust on the failure, so the whole report is lost.
    const lost = controlPlane([], Array(8).fill(failure));

    await invoke(world, controlPlane([restart], []).fetchFn);
    expect(world.updates).toHaveLength(1);

    await invoke(world, lost.fetchFn);
    expect(lost.posted).toEqual([]);
    expect(JSON.parse(ssm.value!)).toMatchObject({ commandId: 'job-restart', phase: 'settled', result: { success: true } });

    // A later poll in a new process: the stored answer is reported, then the marker is cleared.
    const retry = controlPlane([], []);
    await invoke(world, retry.fetchFn);
    expect(retry.posted).toEqual([{ commandId: 'job-restart', success: true }]);
    expect(ssm.value).toBeUndefined();
    expect(world.updates).toHaveLength(1);
  });

  it('is answered from the marker when the control plane offers the command again', async () => {
    const world = awsWorld();
    await invoke(world, controlPlane([restart], []).fetchFn);
    await invoke(world, controlPlane([], Array(8).fill(503)).fetchFn);

    const offered = controlPlane([restart], []);
    await invoke(world, offered.fetchFn, async () => []);
    expect(offered.posted).toEqual([{ commandId: 'job-restart', success: true }]);
    expect(ssm.value).toBeUndefined();
    expect(world.updates).toHaveLength(1);
  });

  it('never clears the marker of a newer command when an older report is accepted', async () => {
    const world = awsWorld();
    ssm.value = JSON.stringify({
      commandId: 'job-newer',
      idempotencyKey: 'dep-1:DEPLOY_RELEASE',
      type: 'DEPLOY_RELEASE',
      stackName: 'deployz-app',
      startedAt: '2026-10-13T00:00:00.000Z',
      payload: {},
    });
    const older = { commandId: 'job-restart', idempotencyKey: 'dep-1:RESTART', success: true };

    const accepted = controlPlane([], []);
    await invoke(world, accepted.fetchFn, async () => [older]);

    expect(accepted.posted).toEqual([{ commandId: 'job-restart', success: true }]);
    expect(JSON.parse(ssm.value!)).toMatchObject({ commandId: 'job-newer' });
  });
});

describe('an immediate INSTALL result whose report is lost', () => {
  const install = {
    id: 'job-install',
    deploymentId: 'dep-1',
    type: 'INSTALL' as const,
    idempotencyKey: 'dep-1:INSTALL',
    payload: { redisRequired: false, databaseRequired: true, templateUrl: 'https://bucket.s3.us-east-1.amazonaws.com/t.json' },
  };

  it.each([
    ['success', { state: 'succeeded' as const, status: 'CREATE_COMPLETE', outputs: {} }, true],
    ['failure', { state: 'failed' as const, status: 'CREATE_FAILED', reason: 'boom', outputs: {} }, false],
  ])('is re-reported from the settled marker after a 503: %s', async (_name, outcome, success) => {
    const world = awsWorld();
    const createStack = vi.fn(async () => outcome);
    const installDeps: InstallExecutorDeps = {
      installationId: 'inst-dur',
      install: createStack,
      verify: async () => ({ verified: true, checks: [] }),
      pending: world.deps.pending,
    };
    const run = (fetchFn: FetchFn) =>
      createRelayHandler({
        secretsClient: secretsClient(),
        fetchFn,
        sleep: async () => {},
        executors: { INSTALL: createInstallExecutor(installDeps) },
        resume: createInstallResumer(installDeps),
        observe: stubObserve,
        observeImage: stubObserveImage,
        observeHealth: stubObserveHealth,
      })({ time: new Date().toISOString() } as ScheduledEvent);

    const lost = controlPlane([install], Array(8).fill(503));
    await run(lost.fetchFn);
    expect(lost.posted).toEqual([]);
    expect(JSON.parse(ssm.value!)).toMatchObject({ commandId: 'job-install', phase: 'settled', result: { success } });

    const retry = controlPlane([], []);
    await run(retry.fetchFn);
    expect(retry.posted).toEqual([{ commandId: 'job-install', success }]);
    expect(ssm.value).toBeUndefined();
    expect(createStack).toHaveBeenCalledTimes(1);
  });
});
