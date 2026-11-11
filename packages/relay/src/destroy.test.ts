import { describe, expect, it } from 'vitest';

import { createDestroyExecutor, createDestroyResumer, settleDestroy, type StackDeleter } from './destroy.js';
import { memoryPendingStore } from './pending.js';
import type { CacheCleanupClient, RdsCleanupClient, WaitOptions } from './recover.js';
import { createStackEventCollector, type StackEventCollector, type StackEventsReader } from './stack-events.js';
import type { CloudFormationReader, StackLookup, StackResource } from './verify.js';

const INSTALLATION_ID = 'inst-destroy-test';
const STACK_NAME = 'deployz-app';
const NO_SLEEP: WaitOptions = { pollIntervalMs: 0, maxAttempts: 3, sleep: async () => {} };

function cfnReturning(lookup: StackLookup): CloudFormationReader {
  return {
    async describeStack() {
      return lookup;
    },
    async describeStackResources() {
      return [];
    },
  };
}

function cfnMissing(): CloudFormationReader {
  return {
    async describeStack() {
      return { found: false };
    },
    async describeStackResources() {
      return [];
    },
  };
}

function deleterRecording(): StackDeleter & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    async deleteStack(stackName) {
      deleted.push(stackName);
    },
  };
}

function deps(
  cfn: CloudFormationReader,
  deleter: StackDeleter = deleterRecording(),
  extra: { rds?: RdsCleanupClient; cache?: CacheCleanupClient; wait?: WaitOptions } = {},
) {
  return {
    cfn,
    deleter,
    pending: memoryPendingStore(),
    installationId: INSTALLATION_ID,
    stackName: STACK_NAME,
    ...extra,
  };
}

function taggedStack(status: string, installationId = INSTALLATION_ID): StackLookup {
  return {
    found: true,
    stack: {
      stackName: STACK_NAME,
      status,
      tags: { 'deployz:installation': installationId },
    },
  };
}

const DB_ORPHAN: StackResource = {
  logicalId: 'Database',
  type: 'AWS::RDS::DBInstance',
  status: 'DELETE_FAILED',
  physicalId: 'deployz-app-database-1a2b3c',
};

const STUCK_SECURITY_GROUP: StackResource = {
  logicalId: 'AppSecurityGroup',
  type: 'AWS::EC2::SecurityGroup',
  status: 'DELETE_FAILED',
  physicalId: 'sg-0123456789abcdef0',
};

function rdsFake(): RdsCleanupClient & { unprotected: string[]; deleted: string[] } {
  const unprotected: string[] = [];
  const deleted: string[] = [];
  return {
    unprotected,
    deleted,
    async disableDeletionProtection(id) {
      unprotected.push(id);
    },
    async deleteInstance(id) {
      deleted.push(id);
    },
  };
}

/**
 * A DELETE_FAILED stack whose retry either clears (walking to
 * DELETE_COMPLETE, after which it reports absent — the real-world way a
 * finished delete is eventually observed) or stays stuck. `resources` is
 * what `describeStackResources` returns throughout — DELETE_FAILED stacks
 * keep their resource list readable.
 */
function scriptedDeleteFailedStack(afterRetry: string[], resources: StackResource[] = []) {
  const deleted: string[] = [];
  let walk: string[] = [];
  let polls = 0;
  let current: StackLookup = taggedStack('DELETE_FAILED');

  const cfn: CloudFormationReader = {
    async describeStack() {
      if (polls < walk.length) {
        return taggedStack(walk[polls++]!);
      }
      return current;
    },
    async describeStackResources() {
      return resources;
    },
  };

  const retained: (readonly string[])[] = [];
  const deleter: StackDeleter & { deleted: string[]; retained: (readonly string[])[] } = {
    deleted,
    retained,
    async deleteStack(stackName, retainResources) {
      deleted.push(stackName);
      if (retainResources) retained.push(retainResources);
      walk = afterRetry;
      polls = 0;
      const last = afterRetry[afterRetry.length - 1] ?? 'DELETE_IN_PROGRESS';
      current = last === 'DELETE_COMPLETE' ? { found: false } : taggedStack(last);
    },
  };

  return { cfn, deleter };
}

/** Records every `poll` call; `lastEventAt` returns a fixed cursor once set. */
function fakeCollector(cursor: string | null = null): StackEventCollector & { polled: string[] } {
  const polled: string[] = [];
  return {
    polled,
    async poll(stackName) {
      polled.push(stackName);
    },
    lastEventAt() {
      return cursor;
    },
  };
}

/** Records the args each `createStackEventCollector` call was made with. */
function collectorFactory(collector: StackEventCollector) {
  const calls: {
    commandId: string;
    operationStartedAt: string;
    stackName: string;
    resumeAfter?: string;
  }[] = [];
  return {
    calls,
    create: (args: {
      commandId: string;
      operationStartedAt: string;
      stackName: string;
      resumeAfter?: string;
    }) => {
      calls.push(args);
      return collector;
    },
  };
}

/** A reader that always fails — `createStackEventCollector`'s `poll` must swallow this. */
const FAILING_READER: StackEventsReader = {
  async describeStackEventsPage() {
    throw new Error('boom');
  },
};

describe('settleDestroy', () => {
  it('reports success without deleting when the stack is already absent', async () => {
    const d = deps(cfnMissing());
    const deleter = d.deleter as ReturnType<typeof deleterRecording>;
    const outcome = await settleDestroy(d);
    expect(outcome).toEqual({ state: 'succeeded', alreadyAbsent: true });
    expect(deleter.deleted).toHaveLength(0);
  });

  it('refuses to delete a stack carrying a different installation tag', async () => {
    const outcome = await settleDestroy(deps(cfnReturning(taggedStack('CREATE_COMPLETE', 'inst-other'))));
    expect(outcome).toEqual({ state: 'failed', reason: expect.stringContaining('tag') });
  });

  it('refuses to delete an untagged stack', async () => {
    const lookup: StackLookup = {
      found: true,
      stack: { stackName: STACK_NAME, status: 'CREATE_COMPLETE', tags: {} },
    };
    const outcome = await settleDestroy(deps(cfnReturning(lookup)));
    expect(outcome.state).toBe('failed');
  });

  it('reports DELETE_FAILED as a failure when there are no known orphans to clear', async () => {
    const outcome = await settleDestroy(deps(cfnReturning(taggedStack('DELETE_FAILED'))));
    expect(outcome).toEqual({ state: 'failed', reason: expect.stringContaining('DELETE_FAILED') });
  });

  it('reports DELETE_IN_PROGRESS as still deleting', async () => {
    const outcome = await settleDestroy(deps(cfnReturning(taggedStack('DELETE_IN_PROGRESS'))));
    expect(outcome).toEqual({ state: 'deleting' });
  });

  it('starts deletion of a tagged, non-deleting stack', async () => {
    const deleter = deleterRecording();
    const outcome = await settleDestroy(deps(cfnReturning(taggedStack('CREATE_COMPLETE')), deleter));
    expect(outcome).toEqual({ state: 'deleting' });
    expect(deleter.deleted).toEqual([STACK_NAME]);
  });

  // Phase 5: a RUNNING standalone task (a scheduled job or migration
  // mid-run) blocks the cluster's own delete with
  // ClusterContainsTasksException. Stop it BEFORE asking CloudFormation to
  // delete the stack — never after, and never a task belonging to a
  // service (that is CloudFormation's own DeleteService to handle).
  it('stops the stack cluster\'s standalone tasks before starting deletion', async () => {
    const CLUSTER_ARN = 'arn:aws:ecs:us-east-1:151955775369:cluster/deployz-app-cluster';
    const cfn: CloudFormationReader = {
      async describeStack() {
        return taggedStack('CREATE_COMPLETE');
      },
      async describeStackResources() {
        return [{ logicalId: 'Cluster', type: 'AWS::ECS::Cluster', status: 'CREATE_COMPLETE', physicalId: CLUSTER_ARN }];
      },
    };
    const stopped: string[] = [];
    const ecs = {
      async listTasks(input: { cluster: string }) {
        expect(input.cluster).toBe(CLUSTER_ARN);
        return { taskArns: ['task-standalone', 'task-service'] };
      },
      async describeTasks(_input: { cluster: string; tasks: string[] }) {
        return {
          tasks: [
            { taskArn: 'task-standalone', group: 'family:DeployzAppCleanup' },
            { taskArn: 'task-service', group: 'service:app-service' },
          ],
        };
      },
      async stopTask(input: { cluster: string; task: string }) {
        expect(input.cluster).toBe(CLUSTER_ARN);
        stopped.push(input.task);
      },
    };
    const deleter = deleterRecording();
    const outcome = await settleDestroy({ ...deps(cfn, deleter), ecs });
    expect(outcome).toEqual({ state: 'deleting' });
    // Only the standalone (family:…) task is stopped — the service-managed
    // one is CloudFormation's own DeleteService to handle.
    expect(stopped).toEqual(['task-standalone']);
    expect(deleter.deleted).toEqual([STACK_NAME]);
  });

  it('a standalone task that cannot be stopped never blocks the delete call (best effort)', async () => {
    const cfn: CloudFormationReader = {
      async describeStack() {
        return taggedStack('CREATE_COMPLETE');
      },
      async describeStackResources() {
        return [
          {
            logicalId: 'Cluster',
            type: 'AWS::ECS::Cluster',
            status: 'CREATE_COMPLETE',
            physicalId: 'arn:aws:ecs:us-east-1:151955775369:cluster/deployz-app-cluster',
          },
        ];
      },
    };
    const ecs = {
      async listTasks() {
        return { taskArns: ['task-standalone'] };
      },
      async describeTasks() {
        return { tasks: [{ taskArn: 'task-standalone', group: 'family:DeployzAppCleanup' }] };
      },
      async stopTask(): Promise<void> {
        throw new Error('AccessDenied');
      },
    };
    const deleter = deleterRecording();
    const outcome = await settleDestroy({ ...deps(cfn, deleter), ecs });
    expect(outcome).toEqual({ state: 'deleting' });
    expect(deleter.deleted).toEqual([STACK_NAME]);
  });

  it('clears an orphaned, protected RDS instance and retries the delete on DELETE_FAILED', async () => {
    const { cfn, deleter } = scriptedDeleteFailedStack(['DELETE_IN_PROGRESS', 'DELETE_COMPLETE'], [
      DB_ORPHAN,
    ]);
    const rds = rdsFake();

    const outcome = await settleDestroy(deps(cfn, deleter, { rds, wait: NO_SLEEP }), true);

    expect(outcome).toEqual({ state: 'succeeded', alreadyAbsent: false });
    expect(rds.unprotected).toEqual([DB_ORPHAN.physicalId]);
    expect(rds.deleted).toEqual([DB_ORPHAN.physicalId]);
    expect(deleter.deleted).toEqual([STACK_NAME]);
  });

  it('reports a failure naming the still-blocked resource when the retry fails again', async () => {
    // The RDS orphan clears, but a security group the relay has no IAM to
    // touch keeps the stack stuck — the retry fails the same way.
    const { cfn, deleter } = scriptedDeleteFailedStack(['DELETE_FAILED'], [
      DB_ORPHAN,
      STUCK_SECURITY_GROUP,
    ]);
    const rds = rdsFake();

    const outcome = await settleDestroy(deps(cfn, deleter, { rds, wait: NO_SLEEP }), true);

    expect(outcome.state).toBe('failed');
    expect((outcome as { reason: string }).reason).toContain('AWS::EC2::SecurityGroup');
    expect(rds.deleted).toEqual([DB_ORPHAN.physicalId]);
    expect(deleter.deleted).toEqual([STACK_NAME]);
  });

  it('finishes a DELETE_FAILED stack by RETAINING the blocked resources when data deletion is not authorized', async () => {
    // The default path: a deployment that ever ran keeps its database. The
    // relay never touches the orphan — it re-issues the delete retaining
    // exactly the resources CloudFormation reported stuck.
    const { cfn, deleter } = scriptedDeleteFailedStack(['DELETE_IN_PROGRESS'], [
      DB_ORPHAN,
      STUCK_SECURITY_GROUP,
    ]);
    const rds = rdsFake();

    const outcome = await settleDestroy(deps(cfn, deleter, { rds, wait: NO_SLEEP }));

    expect(outcome).toEqual({ state: 'deleting' });
    expect(rds.unprotected).toEqual([]);
    expect(rds.deleted).toEqual([]);
    expect(deleter.retained).toEqual([[DB_ORPHAN.logicalId, STUCK_SECURITY_GROUP.logicalId]]);
  });

  it('retains only the database-pinned resources and surfaces an unrelated DELETE_FAILED as a failure', async () => {
    const cluster: StackResource = {
      logicalId: 'Cluster',
      type: 'AWS::ECS::Cluster',
      status: 'DELETE_FAILED',
      statusReason: 'The Cluster cannot be deleted while Container Instances are active',
    };
    const { cfn, deleter } = scriptedDeleteFailedStack(['DELETE_IN_PROGRESS'], [
      DB_ORPHAN,
      STUCK_SECURITY_GROUP,
      cluster,
    ]);

    const outcome = await settleDestroy(deps(cfn, deleter));

    expect(outcome.state).toBe('failed');
    const reason = (outcome as { reason: string }).reason;
    expect(reason).toContain('Cluster (AWS::ECS::Cluster)');
    expect(reason).toContain('Container Instances are active');
    expect(deleter.retained).toEqual([]);
  });

  // A DELETE_FAILED stack never retries by itself. A failure recorded before
  // this DESTROY began (a leftover resource the customer has since removed)
  // gets one fresh attempt, still retaining only the database and its network.
  describe('a failure that predates this operation', () => {
    const OPERATION_STARTED_AT = '2026-11-10T12:00:00.000Z';
    const gateway = (timestamp?: string): StackResource => ({
      logicalId: 'NetworkInternetGateway',
      type: 'AWS::EC2::InternetGateway',
      status: 'DELETE_FAILED',
      statusReason: "The internetGateway 'igw-1' has dependencies and cannot be deleted.",
      ...(timestamp !== undefined ? { timestamp } : {}),
    });

    it('asks CloudFormation to retry once instead of failing', async () => {
      const { cfn, deleter } = scriptedDeleteFailedStack(['DELETE_IN_PROGRESS'], [gateway('2026-11-04T05:42:00.000Z')]);

      const outcome = await settleDestroy(deps(cfn, deleter), false, OPERATION_STARTED_AT);

      expect(outcome).toEqual({ state: 'deleting' });
      expect(deleter.deleted).toEqual([STACK_NAME]);
      expect(deleter.retained).toEqual([[]]);
    });

    it('still retains the database and its network, and not the stale resource', async () => {
      const { cfn, deleter } = scriptedDeleteFailedStack(['DELETE_IN_PROGRESS'], [
        DB_ORPHAN,
        STUCK_SECURITY_GROUP,
        gateway('2026-11-04T05:42:00.000Z'),
      ]);

      const outcome = await settleDestroy(deps(cfn, deleter), false, OPERATION_STARTED_AT);

      expect(outcome).toEqual({ state: 'deleting' });
      expect(deleter.retained).toEqual([[DB_ORPHAN.logicalId, STUCK_SECURITY_GROUP.logicalId]]);
    });

    it('retains a gateway that fails again during this operation', async () => {
      const { cfn, deleter } = scriptedDeleteFailedStack(['DELETE_IN_PROGRESS'], [gateway('2026-11-10T12:00:30.000Z')]);

      const outcome = await settleDestroy(deps(cfn, deleter), false, OPERATION_STARTED_AT);

      expect(outcome).toEqual({ state: 'deleting' });
      expect(deleter.retained).toEqual([['NetworkInternetGateway']]);
    });

    it('reports a failure of any other resource during this operation as a real one', async () => {
      const bucket: StackResource = {
        logicalId: 'StorageBucket',
        type: 'AWS::S3::Bucket',
        status: 'DELETE_FAILED',
        statusReason: 'The bucket you tried to delete is not empty',
        timestamp: '2026-11-10T12:00:30.000Z',
      };
      const { cfn, deleter } = scriptedDeleteFailedStack(['DELETE_IN_PROGRESS'], [gateway('2026-11-10T12:00:30.000Z'), bucket]);

      const outcome = await settleDestroy(deps(cfn, deleter), false, OPERATION_STARTED_AT);

      expect(outcome.state).toBe('failed');
      expect((outcome as { reason: string }).reason).toContain('StorageBucket (AWS::S3::Bucket)');
      expect(deleter.retained).toEqual([]);
    });

    it('fails as before when it cannot tell how old the failure is', async () => {
      const bucket: StackResource = {
        logicalId: 'StorageBucket',
        type: 'AWS::S3::Bucket',
        status: 'DELETE_FAILED',
        statusReason: 'The bucket you tried to delete is not empty',
      };
      const { cfn, deleter } = scriptedDeleteFailedStack(['DELETE_IN_PROGRESS'], [bucket]);

      expect((await settleDestroy(deps(cfn, deleter), false, OPERATION_STARTED_AT)).state).toBe('failed');
      expect((await settleDestroy(deps(cfn, deleter))).state).toBe('failed');
      expect(deleter.retained).toEqual([]);
    });
  });

  it('treats network resources failing with no database as a genuine failure', async () => {
    const { cfn, deleter } = scriptedDeleteFailedStack(['DELETE_IN_PROGRESS'], [STUCK_SECURITY_GROUP]);

    const outcome = await settleDestroy(deps(cfn, deleter));

    expect(outcome.state).toBe('failed');
    expect(deleter.retained).toEqual([]);
  });

  it('keeps retaining the pinned network on a later pass once the database is already DELETE_SKIPPED', async () => {
    const { cfn, deleter } = scriptedDeleteFailedStack(['DELETE_IN_PROGRESS'], [
      { ...DB_ORPHAN, status: 'DELETE_SKIPPED' },
      STUCK_SECURITY_GROUP,
    ]);

    const outcome = await settleDestroy(deps(cfn, deleter));

    expect(outcome).toEqual({ state: 'deleting' });
    expect(deleter.retained).toEqual([[STUCK_SECURITY_GROUP.logicalId]]);
  });

  it('retains the secondary VPC CIDR block the retained database subnet still uses', async () => {
    const { cfn, deleter } = scriptedDeleteFailedStack(['DELETE_IN_PROGRESS'], [
      { ...DB_ORPHAN, status: 'DELETE_SKIPPED' },
      { logicalId: 'NetworkDbSubnet3', type: 'AWS::EC2::Subnet', status: 'DELETE_SKIPPED' },
      { logicalId: 'NetworkVpc', type: 'AWS::EC2::VPC', status: 'CREATE_COMPLETE' },
      { logicalId: 'NetworkDbVpcCidrBlock', type: 'AWS::EC2::VPCCidrBlock', status: 'DELETE_FAILED' },
    ]);

    const outcome = await settleDestroy(deps(cfn, deleter));

    expect(outcome).toEqual({ state: 'deleting' });
    expect(deleter.retained).toEqual([['NetworkDbVpcCidrBlock']]);
  });

  it('treats a VPC CIDR block failing with no database as a genuine failure', async () => {
    const { cfn, deleter } = scriptedDeleteFailedStack(['DELETE_IN_PROGRESS'], [
      { logicalId: 'NetworkDbVpcCidrBlock', type: 'AWS::EC2::VPCCidrBlock', status: 'DELETE_FAILED' },
    ]);

    const outcome = await settleDestroy(deps(cfn, deleter));

    expect(outcome.state).toBe('failed');
    expect(deleter.retained).toEqual([]);
  });

  it('re-running destroy after a cleared DELETE_FAILED stack is harmless', async () => {
    const { cfn, deleter } = scriptedDeleteFailedStack(['DELETE_IN_PROGRESS', 'DELETE_COMPLETE'], [
      DB_ORPHAN,
    ]);
    const rds = rdsFake();
    const d = deps(cfn, deleter, { rds, wait: NO_SLEEP });

    const first = await settleDestroy(d, true);
    expect(first).toEqual({ state: 'succeeded', alreadyAbsent: false });

    const second = await settleDestroy(d, true);
    expect(second).toEqual({ state: 'succeeded', alreadyAbsent: true });
    // No second delete attempt — the stack was already gone.
    expect(deleter.deleted).toEqual([STACK_NAME]);
  });
});

describe('createDestroyExecutor', () => {
  function destroyCommand() {
    return {
      id: 'job-destroy',
      deploymentId: 'dep-1',
      type: 'DESTROY' as const,
      idempotencyKey: 'dep-1:DESTROY',
      payload: {},
    };
  }

  it('returns success when the stack is already absent', async () => {
    const d = deps(cfnMissing());
    const result = await createDestroyExecutor(d)(destroyCommand());
    expect(result.success).toBe(true);
    expect((result.output as { alreadyAbsent: boolean }).alreadyAbsent).toBe(true);
  });

  it('fails with STACK_DELETE_FAILED when a DELETE_FAILED stack has no clearable orphans', async () => {
    const d = deps(cfnReturning(taggedStack('DELETE_FAILED')));
    const result = await createDestroyExecutor(d)(destroyCommand());
    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('STACK_DELETE_FAILED');
  });

  it('succeeds when clearing a DELETE_FAILED stack unblocks the retry', async () => {
    const { cfn, deleter } = scriptedDeleteFailedStack(['DELETE_IN_PROGRESS', 'DELETE_COMPLETE'], [
      DB_ORPHAN,
    ]);
    const rds = rdsFake();
    const d = deps(cfn, deleter, { rds, wait: NO_SLEEP });

    const result = await createDestroyExecutor(d)({
      ...destroyCommand(),
      payload: { dataDeletionAuthorized: true },
    });

    expect(result.success).toBe(true);
    expect((result.output as { alreadyAbsent: boolean }).alreadyAbsent).toBe(false);
  });

  it('defers through the pending store when deletion is in progress', async () => {
    const d = deps(cfnReturning(taggedStack('CREATE_COMPLETE')));
    const result = await createDestroyExecutor(d)(destroyCommand());
    expect(result.deferred).toBe(true);
    const pending = await d.pending.read();
    expect(pending?.commandId).toBe('job-destroy');
    expect(pending?.type).toBe('DESTROY');
  });

  it('polls the collector once with the stack name after issuing the delete', async () => {
    const collector = fakeCollector();
    const factory = collectorFactory(collector);
    const d = { ...deps(cfnReturning(taggedStack('CREATE_COMPLETE'))), createStackEventCollector: factory.create };

    await createDestroyExecutor(d)(destroyCommand());

    expect(collector.polled).toEqual([STACK_NAME]);
    expect(factory.calls).toHaveLength(1);
    expect(factory.calls[0]).toMatchObject({ commandId: 'job-destroy', stackName: STACK_NAME });
  });

  it('writes the collector cursor into the pending marker on defer', async () => {
    const collector = fakeCollector('2026-09-01T00:00:05.000Z');
    const factory = collectorFactory(collector);
    const d = { ...deps(cfnReturning(taggedStack('CREATE_COMPLETE'))), createStackEventCollector: factory.create };

    await createDestroyExecutor(d)(destroyCommand());

    const pending = await d.pending.read();
    expect(pending?.stackEventsCursor).toEqual({ lastEventAt: '2026-09-01T00:00:05.000Z' });
  });

  it('reports the same outcome whether or not a stack-event collector is supplied', async () => {
    const withoutFactory = deps(cfnMissing());
    const withFactory = {
      ...deps(cfnMissing()),
      createStackEventCollector: () => fakeCollector(),
    };

    const a = await createDestroyExecutor(withoutFactory)(destroyCommand());
    const b = await createDestroyExecutor(withFactory)(destroyCommand());

    expect(b.success).toBe(a.success);
    expect(b.output).toEqual(a.output);
  });

  it('does not change the destroy outcome when the real collector fails to collect events', async () => {
    const realCollector = createStackEventCollector({
      reader: FAILING_READER,
      report: async () => true,
      operationStartedAt: new Date().toISOString(),
    });
    const d = {
      ...deps(cfnReturning(taggedStack('CREATE_COMPLETE'))),
      createStackEventCollector: () => realCollector,
    };

    const result = await createDestroyExecutor(d)(destroyCommand());

    expect(result.deferred).toBe(true);
  });
});

describe('createDestroyResumer', () => {
  it('settles once the stack is gone', async () => {
    let absent = false;
    const cfn: CloudFormationReader = {
      async describeStack() {
        return absent ? { found: false } : taggedStack('DELETE_IN_PROGRESS');
      },
      async describeStackResources() {
        return [];
      },
    };
    const d = deps(cfn);
    await d.pending.write({
      commandId: 'job-destroy',
      idempotencyKey: 'dep-1:DESTROY',
      type: 'DESTROY',
      stackName: STACK_NAME,
      startedAt: new Date().toISOString(),
      payload: {},
    });

    const waiting = await createDestroyResumer(d)();
    expect(waiting).toHaveLength(0);

    absent = true;
    const settled = await createDestroyResumer(d)();
    expect(settled).toHaveLength(1);
    expect(settled[0]!.success).toBe(true);
    expect(await d.pending.read()).toBeNull();
  });

  it('ignores pending commands of other types', async () => {
    const d = deps(cfnMissing());
    await d.pending.write({
      commandId: 'job-install',
      idempotencyKey: 'dep-1:INSTALL',
      type: 'INSTALL',
      stackName: STACK_NAME,
      startedAt: new Date().toISOString(),
      payload: {},
    });
    const results = await createDestroyResumer(d)();
    expect(results).toHaveLength(0);
  });

  it('builds the collector with the pending startedAt and cursor, and polls once', async () => {
    const collector = fakeCollector();
    const factory = collectorFactory(collector);
    const d = { ...deps(cfnReturning(taggedStack('DELETE_IN_PROGRESS'))), createStackEventCollector: factory.create };
    await d.pending.write({
      commandId: 'job-destroy',
      idempotencyKey: 'dep-1:DESTROY',
      type: 'DESTROY',
      stackName: STACK_NAME,
      startedAt: '2026-09-01T00:00:00.000Z',
      payload: {},
      stackEventsCursor: { lastEventAt: '2026-09-01T00:00:03.000Z' },
    });

    await createDestroyResumer(d)();

    expect(factory.calls).toEqual([
      {
        commandId: 'job-destroy',
        operationStartedAt: '2026-09-01T00:00:00.000Z',
        stackName: STACK_NAME,
        resumeAfter: '2026-09-01T00:00:03.000Z',
      },
    ]);
    expect(collector.polled).toEqual([STACK_NAME]);
  });

  it('re-defers with the updated cursor while deletion is still in progress', async () => {
    const collector = fakeCollector('2026-09-01T00:00:09.000Z');
    const d = {
      ...deps(cfnReturning(taggedStack('DELETE_IN_PROGRESS'))),
      createStackEventCollector: () => collector,
    };
    await d.pending.write({
      commandId: 'job-destroy',
      idempotencyKey: 'dep-1:DESTROY',
      type: 'DESTROY',
      stackName: STACK_NAME,
      startedAt: new Date().toISOString(),
      payload: {},
    });

    const results = await createDestroyResumer(d)();

    expect(results).toHaveLength(0);
    const pending = await d.pending.read();
    expect(pending?.stackEventsCursor).toEqual({ lastEventAt: '2026-09-01T00:00:09.000Z' });
  });

  it('resumes to the same outcome whether or not a stack-event collector is supplied', async () => {
    let absent = false;
    const cfn: CloudFormationReader = {
      async describeStack() {
        return absent ? { found: false } : taggedStack('DELETE_IN_PROGRESS');
      },
      async describeStackResources() {
        return [];
      },
    };
    const withoutFactory = deps(cfn);
    const withFactory = { ...deps(cfn), createStackEventCollector: () => fakeCollector() };
    for (const d of [withoutFactory, withFactory]) {
      await d.pending.write({
        commandId: 'job-destroy',
        idempotencyKey: 'dep-1:DESTROY',
        type: 'DESTROY',
        stackName: STACK_NAME,
        startedAt: new Date().toISOString(),
        payload: {},
      });
    }

    absent = true;
    const a = await createDestroyResumer(withoutFactory)();
    const b = await createDestroyResumer(withFactory)();

    expect(b[0]!.success).toBe(a[0]!.success);
    expect(b[0]!.output).toEqual(a[0]!.output);
  });
});
