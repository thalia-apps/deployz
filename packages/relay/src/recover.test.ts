import { describe, expect, it, vi } from 'vitest';

import {
  clearDeleteBlockersAndRetryDelete,
  recoverFailedInstallStack,
  type CacheCleanupClient,
  type PhysicalStackResource,
  type RecoveryCloudFormation,
  type RdsCleanupClient,
} from './recover.js';
import type { StackLookup } from './verify.js';

const STACK = 'deployz-app';
const NO_SLEEP = { pollIntervalMs: 0, maxAttempts: 3, sleep: async () => {} };

function lookup(status: string): StackLookup {
  return {
    found: true,
    stack: { stackName: STACK, status, tags: { 'deployz:installation': 'inst' } },
  };
}

interface ActorScript {
  initial?: StackLookup;
  /** One status sequence per deleteStack call; the last sequence repeats. */
  afterDelete?: string[][];
  resources?: PhysicalStackResource[];
}

/**
 * A scripted actor: `initial` is what the first DescribeStacks returns; each
 * delete call then installs its own status sequence, walked one status per
 * subsequent poll (the last status repeats). deleteStack calls are recorded.
 */
function scriptedActor(script: ActorScript): RecoveryCloudFormation & { deleteCalls: string[] } {
  const deleteCalls: string[] = [];
  let deleteIndex = 0;
  let walk: string[] = [];
  let polls = 0;

  let current = script.initial ?? { found: false as const };

  return {
    deleteCalls,
    async describeStack() {
      if (walk.length === 0) {
        return current;
      }
      const status = walk[Math.min(polls++, walk.length - 1)]!;
      return lookup(status);
    },
    async describeStackResources() {
      return script.resources ?? [];
    },
    async deleteStack(stackName) {
      deleteCalls.push(stackName);
      const seq = script.afterDelete?.[Math.min(deleteIndex++, (script.afterDelete.length - 1))] ?? [];
      walk = seq;
      polls = 0;
      current = lookup(seq[seq.length - 1] ?? 'DELETE_IN_PROGRESS');
    },
  };
}

/**
 * `alreadyDeleting` simulates a re-run: the SDK throws
 * `InvalidDBInstanceStateFault` for these ids, as it would for an instance a
 * previous pass already started deleting.
 */
function rdsFake(opts: { alreadyDeleting?: readonly string[] } = {}): RdsCleanupClient & {
  unprotected: string[];
  deleted: string[];
} {
  const unprotected: string[] = [];
  const deleted: string[] = [];
  const alreadyDeleting = new Set(opts.alreadyDeleting ?? []);
  return {
    unprotected,
    deleted,
    async disableDeletionProtection(id) {
      unprotected.push(id);
    },
    async deleteInstance(id) {
      if (alreadyDeleting.has(id)) {
        throw new Error(`InvalidDBInstanceStateFault: ${id} is already being deleted`);
      }
      deleted.push(id);
    },
  };
}

function cacheFake(): CacheCleanupClient & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    async deleteReplicationGroup(id) {
      deleted.push(id);
    },
  };
}

const DB_ORPHAN: PhysicalStackResource = {
  logicalId: 'Database',
  type: 'AWS::RDS::DBInstance',
  status: 'CREATE_COMPLETE',
  physicalId: 'deployz-app-database-1a2b3c',
};
const CACHE_ORPHAN: PhysicalStackResource = {
  logicalId: 'Cache',
  type: 'AWS::ElastiCache::ReplicationGroup',
  status: 'CREATE_COMPLETE',
  physicalId: 'deployz-app-cache-4d5e6f',
};

describe('recoverFailedInstallStack', () => {
  it('deletes a ROLLBACK_COMPLETE stack cleanly when nothing is retained', async () => {
    const actor = scriptedActor({
      initial: lookup('ROLLBACK_COMPLETE'),
      afterDelete: [['DELETE_IN_PROGRESS', 'DELETE_COMPLETE']],
    });
    const rds = rdsFake();

    const report = await recoverFailedInstallStack(
      { cfn: actor, rds, wait: NO_SLEEP },
      { stackName: STACK },
    );

    expect(report.phase).toBe('STACK_DELETED');
    expect(actor.deleteCalls).toEqual([STACK]);
    expect(rds.deleted).toHaveLength(0);
  });

  it('clears retained blockers (RDS deletion protection, cache) before deleting a DELETE_FAILED stack', async () => {
    const actor = scriptedActor({
      initial: lookup('DELETE_FAILED'),
      afterDelete: [['DELETE_COMPLETE']],
      resources: [DB_ORPHAN, CACHE_ORPHAN],
    });
    const rds = rdsFake();
    const cache = cacheFake();

    const report = await recoverFailedInstallStack(
      { cfn: actor, rds, cache, wait: NO_SLEEP },
      { stackName: STACK },
    );

    expect(report.phase).toBe('BLOCKERS_CLEARED_STACK_GONE');
    expect(report.orphansDeleted).toEqual([DB_ORPHAN.physicalId, CACHE_ORPHAN.physicalId]);
    expect(rds.unprotected).toEqual([DB_ORPHAN.physicalId]);
    expect(rds.deleted).toEqual([DB_ORPHAN.physicalId]);
    expect(cache.deleted).toEqual([CACHE_ORPHAN.physicalId]);
    // Orphans are cleared BEFORE the delete attempt, not after a failed one —
    // a single DeleteStack call is enough once the blockers are gone.
    expect(actor.deleteCalls).toEqual([STACK]);
  });

  it('leaves a healthy stack untouched, whatever the caller claims', async () => {
    const actor = scriptedActor({ initial: lookup('CREATE_COMPLETE') });
    const rds = rdsFake();

    const report = await recoverFailedInstallStack(
      { cfn: actor, rds, wait: NO_SLEEP },
      { stackName: STACK },
    );

    expect(report.phase).toBe('REFUSED_LIVE_STACK');
    expect(actor.deleteCalls).toHaveLength(0);
    expect(rds.deleted).toHaveLength(0);
  });

  it('refuses an in-progress stack (another mutation is running)', async () => {
    const actor = scriptedActor({ initial: lookup('CREATE_IN_PROGRESS') });

    const report = await recoverFailedInstallStack(
      { cfn: actor, wait: NO_SLEEP },
      { stackName: STACK },
    );

    expect(report.phase).toBe('REFUSED_IN_PROGRESS');
    expect(actor.deleteCalls).toHaveLength(0);
  });

  it('is a no-op when no stack exists', async () => {
    const actor = scriptedActor({});

    const report = await recoverFailedInstallStack(
      { cfn: actor, wait: NO_SLEEP },
      { stackName: STACK },
    );

    expect(report.phase).toBe('ALREADY_ABSENT');
    expect(actor.deleteCalls).toHaveLength(0);
  });

  it('reports DELETE_STUCK when the re-delete fails again', async () => {
    const actor = scriptedActor({
      initial: lookup('DELETE_FAILED'),
      afterDelete: [['DELETE_FAILED'], ['DELETE_FAILED']],
      resources: [DB_ORPHAN],
    });
    const rds = rdsFake();

    const report = await recoverFailedInstallStack(
      { cfn: actor, rds, wait: NO_SLEEP },
      { stackName: STACK },
    );

    expect(report.phase).toBe('DELETE_STUCK');
    expect(report.orphansDeleted).toEqual([DB_ORPHAN.physicalId]);
    expect(actor.deleteCalls).toEqual([STACK, STACK]);
  });

  it('skips orphan cleanup for a type with no matching client, but still retries the delete', async () => {
    const actor = scriptedActor({
      initial: lookup('DELETE_FAILED'),
      afterDelete: [['DELETE_FAILED']],
      resources: [CACHE_ORPHAN],
    });
    const rds = rdsFake();
    // no cache client injected

    const report = await recoverFailedInstallStack(
      { cfn: actor, rds, wait: NO_SLEEP },
      { stackName: STACK },
    );

    expect(report.orphansDeleted).toEqual([]);
    // CACHE_ORPHAN is still an orphan candidate even with nothing able to
    // clear it, so the delete is retried rather than short-circuited to
    // DELETE_STUCK — CloudFormation, not the absence of a client, is the
    // honest judge of whether the stack can finish.
    expect(actor.deleteCalls).toEqual([STACK, STACK]);
    expect(report.phase).toBe('DELETE_STUCK');
  });

  it('reports DELETE_IN_PROGRESS when the delete budget runs out', async () => {
    const actor = scriptedActor({
      initial: lookup('ROLLBACK_COMPLETE'),
      afterDelete: [['DELETE_IN_PROGRESS']],
    });

    const report = await recoverFailedInstallStack(
      { cfn: actor, wait: NO_SLEEP },
      { stackName: STACK },
    );

    expect(report.phase).toBe('DELETE_IN_PROGRESS');
    expect(report.lastStackStatus).toBe('DELETE_IN_PROGRESS');
  });

  it('leaves phase DELETE_IN_PROGRESS with orphans already cleared when the delete budget runs out mid-delete', async () => {
    const actor = scriptedActor({
      initial: lookup('ROLLBACK_COMPLETE'),
      afterDelete: [['DELETE_IN_PROGRESS']],
      resources: [DB_ORPHAN],
    });
    const rds = rdsFake();

    const report = await recoverFailedInstallStack(
      { cfn: actor, rds, wait: NO_SLEEP },
      { stackName: STACK },
    );

    // The orphan is cleared BEFORE the delete attempt, so even when the
    // real ~17-minute delete outlives this invocation's wait budget, the
    // RDS instance is already on its way out — not still sitting there
    // untouched the way it would be with a delete-then-clear order.
    expect(report.phase).toBe('DELETE_IN_PROGRESS');
    expect(report.orphansDeleted).toEqual([DB_ORPHAN.physicalId]);
    expect(rds.deleted).toEqual([DB_ORPHAN.physicalId]);
    expect(actor.deleteCalls).toEqual([STACK]);
  });
});

describe('recoverFailedInstallStack — leftovers of the failed attempt', () => {
  function sweepClients(opts: { failList?: boolean } = {}) {
    const calls: string[] = [];
    return {
      calls,
      s3: {
        listOwnedBuckets: async () => {
          if (opts.failList) throw new Error('AccessDenied');
          return ['old-bucket'];
        },
        emptyBucket: async (name: string) => void calls.push(`empty:${name}`),
        deleteBucket: async (name: string) => void calls.push(`delete-bucket:${name}`),
      },
      secrets: {
        listOwnedSecrets: async () => ['PrimaryDbMasterSecret-old'],
        deleteSecret: async (name: string) => void calls.push(`delete-secret:${name}`),
      },
    };
  }

  it('removes the bucket and credential secrets once the failed stack is gone', async () => {
    const cfn = scriptedActor({ initial: lookup('ROLLBACK_COMPLETE'), afterDelete: [['DELETE_COMPLETE']] });
    const clients = sweepClients();

    const report = await recoverFailedInstallStack({ cfn, wait: NO_SLEEP, ...clients }, { stackName: STACK });

    expect(report.phase).toBe('STACK_DELETED');
    expect(report.leftoversRemoved).toEqual({ buckets: ['old-bucket'], secrets: ['PrimaryDbMasterSecret-old'] });
    expect(clients.calls).toEqual(['empty:old-bucket', 'delete-bucket:old-bucket', 'delete-secret:PrimaryDbMasterSecret-old']);
  });

  it('removes nothing while the stack is still deleting', async () => {
    const cfn = scriptedActor({ initial: lookup('ROLLBACK_COMPLETE'), afterDelete: [['DELETE_IN_PROGRESS']] });
    const clients = sweepClients();

    const report = await recoverFailedInstallStack({ cfn, wait: NO_SLEEP, ...clients }, { stackName: STACK });

    expect(report.phase).toBe('DELETE_IN_PROGRESS');
    expect(clients.calls).toEqual([]);
  });

  it('removes nothing from a healthy stack', async () => {
    const cfn = scriptedActor({ initial: lookup('CREATE_COMPLETE') });
    const clients = sweepClients();

    const report = await recoverFailedInstallStack({ cfn, wait: NO_SLEEP, ...clients }, { stackName: STACK });

    expect(report.phase).toBe('REFUSED_LIVE_STACK');
    expect(clients.calls).toEqual([]);
  });

  it('cleans leftovers when no stack exists, as on a retry after the stack was deleted', async () => {
    const cfn = scriptedActor({});
    const clients = sweepClients();

    const report = await recoverFailedInstallStack({ cfn, wait: NO_SLEEP, ...clients }, { stackName: STACK });

    expect(report.phase).toBe('ALREADY_ABSENT');
    expect(report.leftoversRemoved?.buckets).toEqual(['old-bucket']);
  });

  it('never blocks the recovery when the sweep fails', async () => {
    const cfn = scriptedActor({ initial: lookup('ROLLBACK_COMPLETE'), afterDelete: [['DELETE_COMPLETE']] });
    const clients = sweepClients({ failList: true });

    const report = await recoverFailedInstallStack({ cfn, wait: NO_SLEEP, ...clients }, { stackName: STACK });

    expect(report.phase).toBe('STACK_DELETED');
    expect(report.leftoverSweepError).toBe('AccessDenied');
    expect(report.leftoversRemoved).toBeUndefined();
  });
});

describe('clearDeleteBlockersAndRetryDelete', () => {
  it('tolerates an orphan already mid-deletion from a previous pass and still retries the delete', async () => {
    const actor = scriptedActor({
      afterDelete: [['DELETE_COMPLETE']],
      resources: [DB_ORPHAN],
    });
    const rds = rdsFake({ alreadyDeleting: [DB_ORPHAN.physicalId] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const report = await clearDeleteBlockersAndRetryDelete({ cfn: actor, rds, wait: NO_SLEEP }, STACK);

      // Nothing was newly cleared this pass (the SDK threw
      // InvalidDBInstanceStateFault, tolerated) — but the orphan is still a
      // candidate, so the delete is retried anyway, and this time it works.
      expect(report.phase).toBe('STACK_DELETED');
      expect(report.orphansDeleted).toEqual([]);
      expect(actor.deleteCalls).toEqual([STACK]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
