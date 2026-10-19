/**
 * DESTROY executor — safely remove the application stack.
 *
 * The product boundary (Phase 6): disconnect removes the running application
 * and its networking while RETAINING the database, stored files, and
 * backups. The bootstrap relay stack is never touched. Because the
 * application template's CloudFormation retention policies govern what is
 * actually deleted versus retained, the executor's job is to delete the
 * stack and let CloudFormation enforce those policies — it enumerates and
 * deletes resources itself only for the narrow DELETE_FAILED recovery below,
 * and only the orphaned RDS/ElastiCache resources CloudFormation itself
 * named as retained.
 *
 * Safety: the stack must carry this installation's `deployz:installation`
 * tag. An untagged or mismatched stack is refused — the alternative is
 * deleting some other installation's (or some non-Deployz) stack by name.
 */

import type { CommandExecutor, RelayCommand, RelayCommandResult } from './commands.js';
import type { PendingStore } from './pending.js';
import {
  clearDeleteBlockersAndRetryDelete,
  type CacheCleanupClient,
  type RdsCleanupClient,
  type WaitOptions,
} from './recover.js';
import type { StackEventCollector } from './stack-events.js';
import type { CloudFormationReader, StackResource } from './verify.js';

/** The CloudFormation delete surface this module needs. */
export interface StackDeleter {
  /**
   * `retainResources` (logical ids, only valid on a DELETE_FAILED stack)
   * finishes the deletion while leaving those resources — and the data they
   * hold — in the customer's account.
   */
  deleteStack(stackName: string, retainResources?: readonly string[]): Promise<void>;
}

/**
 * Phase 5: the ECS surface needed to stop a RUNNING standalone task (a
 * scheduled job or migration mid-run) before deleting the cluster it lives
 * in. CloudFormation's own `AWS::ECS::Service` deletion already drains
 * service-managed tasks as part of the stack's normal delete sequence — this
 * exists only for the standalone ones (group `family:…`, no service) that
 * nothing else stops, and which otherwise fail the cluster's delete with
 * `ClusterContainsTasksException` (surfacing as the whole stack landing on
 * `DELETE_FAILED`).
 */
export interface EcsStandaloneTaskStopper {
  listTasks(input: { cluster: string }): Promise<{ taskArns: string[] }>;
  describeTasks(input: {
    cluster: string;
    tasks: string[];
  }): Promise<{ tasks: { taskArn?: string | undefined; group?: string | undefined }[] }>;
  stopTask(input: { cluster: string; task: string }): Promise<void>;
}

export interface DestroyDeps {
  readonly cfn: CloudFormationReader;
  readonly deleter: StackDeleter;
  readonly pending: PendingStore;
  readonly installationId: string;
  readonly stackName: string;
  readonly now?: () => string;
  /**
   * DELETE_FAILED recovery: clears retained RDS/ElastiCache orphans that
   * block the delete and retries it (see `clearDeleteBlockersAndRetryDelete`
   * in ./recover.js). Same clients the INSTALL retry path already uses;
   * omitted, a DELETE_FAILED stack just fails as before.
   */
  readonly rds?: RdsCleanupClient;
  readonly cache?: CacheCleanupClient;
  readonly wait?: WaitOptions;
  /**
   * Stops the stack's own cluster's standalone (non-service) tasks before
   * deleting it (Phase 5) — see `EcsStandaloneTaskStopper`. Optional and
   * best-effort: omitted (older wiring, or a test that doesn't care), the
   * executor behaves exactly as it did before this existed, and a task that
   * could not be stopped just leaves the stack on the same `DELETE_FAILED`
   * recovery path that already exists for any other blocked resource.
   */
  readonly ecs?: EcsStandaloneTaskStopper;
  /**
   * Builds a stack-event collector for one DESTROY invocation. Optional —
   * absent (older wiring, or a test that doesn't care about progress
   * reporting), the executor and resumer behave exactly as they did before
   * this existed: no collector, no poll, no cursor.
   *
   * Unlike INSTALL, DESTROY has no intra-invocation wait loop, so `poll` is
   * called at most once per invocation — once per one-minute resume tick —
   * right after `settleDestroy` observes or issues the delete.
   */
  readonly createStackEventCollector?: (args: {
    commandId: string;
    operationStartedAt: string;
    stackName: string;
    resumeAfter?: string;
  }) => StackEventCollector;
}

const ECS_CLUSTER_TYPE = 'AWS::ECS::Cluster';
const RDS_INSTANCE_TYPE = 'AWS::RDS::DBInstance';

/** The network resources the retained database's ENI pins. */
const DATABASE_PINNED_TYPES: ReadonlySet<string> = new Set([
  'AWS::RDS::DBSubnetGroup',
  'AWS::EC2::SecurityGroup',
  'AWS::EC2::Subnet',
  'AWS::EC2::VPC',
  'AWS::EC2::VPCCidrBlock',
]);

/**
 * Splits the DELETE_FAILED resources into the ones the data-preserving
 * recovery may retain (the retained database and the network it pins) and
 * the ones that are a genuine deletion failure. Network types are retainable
 * only while the database itself is blocked or already retained in this
 * stack; with no database, they are a real failure.
 */
function partitionDeleteFailed(resources: readonly StackResource[]): {
  retainable: string[];
  unrelated: StackResource[];
} {
  const databaseBlocked = resources.some(
    (r) =>
      r.type === RDS_INSTANCE_TYPE && (r.status === 'DELETE_FAILED' || r.status === 'DELETE_SKIPPED'),
  );
  const retainable: string[] = [];
  const unrelated: StackResource[] = [];
  for (const resource of resources.filter((r) => r.status === 'DELETE_FAILED')) {
    if (resource.type === RDS_INSTANCE_TYPE || (databaseBlocked && DATABASE_PINNED_TYPES.has(resource.type))) {
      retainable.push(resource.logicalId);
    } else {
      unrelated.push(resource);
    }
  }
  return { retainable, unrelated };
}

/**
 * Best-effort: stops every standalone (group `family:…`, no service) task
 * running in the stack's own cluster, right before asking CloudFormation to
 * delete it. Scoped to THIS stack's cluster only — read from the stack's own
 * resources, never a name or account-wide list. A failure here (unreadable
 * cluster, a task that would not stop) never blocks the delete call that
 * follows it: CloudFormation's existing DELETE_FAILED recovery is the
 * backstop for whatever this pass could not clear.
 */
async function stopStandaloneTasks(deps: DestroyDeps): Promise<void> {
  if (!deps.ecs) return;
  try {
    const resources = await deps.cfn.describeStackResources(deps.stackName);
    const cluster = resources.find((r) => r.type === ECS_CLUSTER_TYPE)?.physicalId;
    if (!cluster) return;
    const { taskArns } = await deps.ecs.listTasks({ cluster });
    if (taskArns.length === 0) return;
    const { tasks } = await deps.ecs.describeTasks({ cluster, tasks: taskArns });
    const standalone = tasks.flatMap((task) =>
      task.taskArn !== undefined && task.group?.startsWith('family:') === true ? [task.taskArn] : [],
    );
    for (const taskArn of standalone) {
      try {
        await deps.ecs.stopTask({ cluster, task: taskArn });
      } catch {
        // Best effort — the delete call this precedes, and its existing
        // DELETE_FAILED recovery, are the backstop.
      }
    }
  } catch {
    // Best effort — never block the delete itself.
  }
}

type DestroyOutcome =
  | { readonly state: 'succeeded'; readonly alreadyAbsent: boolean }
  | { readonly state: 'failed'; readonly reason: string }
  | { readonly state: 'deleting' };

/**
 * Runs the destroy to whatever conclusion is available right now. Reads
 * before writes: a stack already absent is success (idempotent retry), a
 * stack mid-deletion is deferred, a DELETE_FAILED stack is a failure.
 */
export async function settleDestroy(
  deps: DestroyDeps,
  dataDeletionAuthorized = false,
): Promise<DestroyOutcome> {
  const lookup = await deps.cfn.describeStack(deps.stackName);

  if (!lookup.found) {
    return { state: 'succeeded', alreadyAbsent: true };
  }

  const status = lookup.stack.status;

  // A same-named stack that does not carry THIS installation's tag is not
  // ours to delete. Deleting it would cross the installation boundary.
  if (lookup.stack.tags['deployz:installation'] !== deps.installationId) {
    return {
      state: 'failed',
      reason: `Stack "${deps.stackName}" does not carry this installation's tag — refusing to delete`,
    };
  }

  if (status === 'DELETE_FAILED') {
    // Two very different recoveries, chosen by the control plane:
    //
    // The DEFAULT is data-preserving: finish the deletion while RETAINING
    // the resources CloudFormation could not delete (the retained database
    // keeps its ENI alive, which blocks its security group and subnet — so
    // those stay behind with it). Nothing holding data is ever touched.
    //
    // Only when the control plane explicitly authorized data deletion —
    // it proved this deployment NEVER completed an install, so its
    // database is an empty artifact of a failed create — are the orphaned
    // RDS/ElastiCache blockers deleted outright (same recovery the INSTALL
    // retry path runs).
    if (dataDeletionAuthorized !== true) {
      const { retainable: blocked, unrelated } = partitionDeleteFailed(
        await deps.cfn.describeStackResources(deps.stackName),
      );
      if (unrelated.length > 0) {
        const details = unrelated
          .map((r) => `${r.logicalId} (${r.type})${r.statusReason ? `: ${r.statusReason}` : ''}`)
          .join('; ');
        return {
          state: 'failed',
          reason:
            `Stack "${deps.stackName}" is DELETE_FAILED on resources that are not retained ` +
            `database data: ${details}`,
        };
      }
      if (blocked.length === 0) {
        return {
          state: 'failed',
          reason:
            `Stack "${deps.stackName}" is DELETE_FAILED but no blocking resource is ` +
            'identifiable — retry Disconnect, or remove the stack manually',
        };
      }
      // A stuck standalone task is one possible cause of this DELETE_FAILED
      // — clear it before retrying, on top of whatever CloudFormation
      // already reported as blocked.
      await stopStandaloneTasks(deps);
      await deps.deleter.deleteStack(deps.stackName, blocked);
      return { state: 'deleting' };
    }

    const cleared = await clearDeleteBlockersAndRetryDelete(
      {
        cfn: {
          describeStack: (name) => deps.cfn.describeStack(name),
          describeStackResources: async (name) =>
            (await deps.cfn.describeStackResources(name)).flatMap((r) =>
              r.physicalId ? [{ ...r, physicalId: r.physicalId }] : [],
            ),
          deleteStack: (name) => deps.deleter.deleteStack(name),
        },
        ...(deps.rds !== undefined ? { rds: deps.rds } : {}),
        ...(deps.cache !== undefined ? { cache: deps.cache } : {}),
        ...(deps.wait !== undefined ? { wait: deps.wait } : {}),
      },
      deps.stackName,
    );

    if (cleared.phase === 'STACK_DELETED') {
      return { state: 'succeeded', alreadyAbsent: false };
    }
    if (cleared.phase === 'DELETE_IN_PROGRESS') {
      return { state: 'deleting' };
    }

    const blocked =
      cleared.blockedResources.length > 0
        ? ` Still blocked by: ${cleared.blockedResources.join(', ')}.`
        : '';
    return {
      state: 'failed',
      reason:
        `Stack "${deps.stackName}" deletion previously failed (DELETE_FAILED); ` +
        `clearing known orphans (${cleared.orphansDeleted.length} cleared) did not ` +
        `unblock it.${blocked}`,
    };
  }

  if (status === 'DELETE_IN_PROGRESS') {
    return { state: 'deleting' };
  }

  // Phase 5: a RUNNING standalone task (a scheduled job or migration
  // mid-run) blocks the cluster's own delete with
  // ClusterContainsTasksException, which would otherwise land the whole
  // stack on DELETE_FAILED. Clear it first — scoped to this stack's own
  // cluster only.
  await stopStandaloneTasks(deps);

  // The stack is tagged and in a non-deleting state — start the deletion.
  // CloudFormation's per-resource retention policies are the single source
  // of truth for what is deleted versus retained.
  await deps.deleter.deleteStack(deps.stackName);
  return { state: 'deleting' };
}

function result(
  command: RelayCommand,
  success: boolean,
  extra: { output?: Record<string, unknown>; error?: string; failureCode?: string } = {},
): RelayCommandResult {
  return {
    commandId: command.id,
    idempotencyKey: command.idempotencyKey,
    success,
    ...extra,
  };
}

export function createDestroyExecutor(deps: DestroyDeps): CommandExecutor {
  return async (command) => {
    console.log(
      JSON.stringify({
        event: 'relay:command-executed',
        commandId: command.id,
        type: command.type,
        deploymentId: command.deploymentId,
        idempotencyKey: command.idempotencyKey,
      }),
    );

    const startedAt = (deps.now ?? (() => new Date().toISOString()))();
    const collector = deps.createStackEventCollector?.({
      commandId: command.id,
      operationStartedAt: startedAt,
      stackName: deps.stackName,
    });

    let outcome: DestroyOutcome;
    try {
      outcome = await settleDestroy(deps, readDataDeletionAuthorized(command.payload));
    } catch (err) {
      return result(command, false, {
        error: String(err),
        failureCode: 'AWS_PERMISSION_DENIED',
      });
    }

    // Best-effort, once per invocation — DESTROY has no intra-invocation wait
    // loop, so this is the only chance to collect progress before the
    // resumer's next one-minute tick. `poll` never throws.
    await collector?.poll(deps.stackName);

    if (outcome.state === 'failed') {
      console.log(
        JSON.stringify({
          event: 'relay:command-failed',
          commandId: command.id,
          type: command.type,
          reason: outcome.reason,
        }),
      );
      return result(command, false, {
        error: outcome.reason,
        // DELETE_FAILED on the stack itself is the common terminal state;
        // a tag refusal or permission error surfaces through the same
        // mechanism and is distinguished by its message.
        failureCode: 'STACK_DELETE_FAILED',
      });
    }

    if (outcome.state === 'succeeded') {
      console.log(
        JSON.stringify({
          event: 'relay:command-succeeded',
          commandId: command.id,
          type: command.type,
          alreadyAbsent: outcome.alreadyAbsent,
        }),
      );
      return result(command, true, {
        output: { executed: true, type: command.type, alreadyAbsent: outcome.alreadyAbsent },
      });
    }

    // Deletion is in progress and will outlive this invocation — record the
    // debt so the resumer picks it up on a later poll.
    const lastEventAt = collector?.lastEventAt() ?? null;
    const recorded = await deps.pending.write({
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      type: command.type,
      stackName: deps.stackName,
      startedAt,
      payload: command.payload,
      ...(lastEventAt !== null ? { stackEventsCursor: { lastEventAt } } : {}),
    });
    if (!recorded) {
      return result(command, false, {
        error: 'Deletion in progress, but the relay could not record that it must report back',
      });
    }

    console.log(
      JSON.stringify({
        event: 'relay:command-deferred',
        commandId: command.id,
        type: command.type,
        stackName: deps.stackName,
      }),
    );
    return {
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      success: false,
      deferred: true,
    };
  };
}

/**
 * Whether the control plane explicitly authorized deleting data-holding
 * resources. Anything but a literal `true` means NO — the default is always
 * the data-preserving path.
 */
function readDataDeletionAuthorized(payload: Record<string, unknown>): boolean {
  return payload['dataDeletionAuthorized'] === true;
}

/** The other half: finish a destroy an earlier invocation started. */
export function createDestroyResumer(deps: DestroyDeps): () => Promise<RelayCommandResult[]> {
  return async () => {
    const pending = await deps.pending.read();
    if (pending === null || pending.type !== 'DESTROY') return [];

    const resumeAfter = pending.stackEventsCursor?.lastEventAt;
    const collector = deps.createStackEventCollector?.({
      commandId: pending.commandId,
      operationStartedAt: pending.startedAt,
      stackName: pending.stackName,
      ...(resumeAfter !== undefined ? { resumeAfter } : {}),
    });

    const outcome = await settleDestroy(deps, readDataDeletionAuthorized(pending.payload));

    // Best-effort, once per resume tick — same rule as the executor above.
    await collector?.poll(pending.stackName);

    if (outcome.state === 'deleting') {
      // Re-defer: carry forward whatever new events this tick collected so
      // the next resume does not re-walk history it already reported.
      const lastEventAt = collector?.lastEventAt() ?? null;
      if (lastEventAt !== null) {
        await deps.pending.write({ ...pending, stackEventsCursor: { lastEventAt } });
      }
      console.log(
        JSON.stringify({
          event: 'relay:command-still-pending',
          commandId: pending.commandId,
          type: pending.type,
          startedAt: pending.startedAt,
        }),
      );
      return [];
    }

    await deps.pending.clear();
    console.log(
      JSON.stringify({
        event: 'relay:command-resumed',
        commandId: pending.commandId,
        type: pending.type,
        success: outcome.state === 'succeeded',
        startedAt: pending.startedAt,
      }),
    );
    return [
      outcome.state === 'succeeded'
        ? {
            commandId: pending.commandId,
            idempotencyKey: pending.idempotencyKey,
            success: true,
            output: {
              executed: true,
              type: pending.type,
              alreadyAbsent: outcome.alreadyAbsent,
            },
          }
        : {
            commandId: pending.commandId,
            idempotencyKey: pending.idempotencyKey,
            success: false,
            error: outcome.reason,
            failureCode: 'STACK_DELETE_FAILED',
          },
    ];
  };
}
