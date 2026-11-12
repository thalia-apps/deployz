import { classifyResource, mapResourceStatus, type ResourceClassification } from '@deployz/contracts';
import { and, eq, lte, ne, sql } from 'drizzle-orm';

import { deploymentResources } from './schema/deployment-resources.js';
import type { RuntimeDb } from './client.js';

// Idempotent persistence of the relay's raw infrastructure inventory.
//
// One heartbeat → one complete ListStackResources read → one snapshot. This
// merge is a pure roll-forward: `null` (a partial read, or a stack that
// vanished) is a NO-OP — the previous complete snapshot is kept, because a
// partial read must never overwrite a good one. Rows are never deleted when a
// stack disappears: the last complete snapshot IS the final snapshot. The one
// exception is a stack the deployment replaced: a complete snapshot of a new
// stack drops the older rows of any other stack of the same deployment (a
// failed first attempt that was deleted and created again), so the inventory
// never mixes two stacks.

/** The minimal resource shape the persist helper needs. The relay's
 *  `StackResource` (packages/relay) satisfies this structurally. */
export interface ObservedStackResource {
  readonly logicalId: string;
  readonly type: string;
  readonly status: string;
  readonly physicalId?: string;
  readonly statusReason?: string;
}

export interface PersistResourceSnapshotInput {
  readonly deploymentId: string;
  readonly stackId: string;
  /** ISO 8601 — the relay's observation time. */
  readonly observedAt: string;
  /** Raw resources, or null when the relay could not complete the read. */
  readonly resources: readonly ObservedStackResource[] | null;
  /**
   * Compiler-derived classification by CFN logical id (from the deployment's
   * frozen spec). Wins over type-based classifyResource; unlisted resources
   * fall back to classifyResource.
   */
  readonly classificationByLogicalId?: ReadonlyMap<string, ResourceClassification>;
}

export type PersistResourceSnapshotResult =
  | { readonly persisted: false; readonly reason: 'no-snapshot' }
  | { readonly persisted: true; readonly count: number };

export async function persistDeploymentResourceSnapshot(
  db: RuntimeDb,
  input: PersistResourceSnapshotInput,
): Promise<PersistResourceSnapshotResult> {
  if (input.resources === null) {
    return { persisted: false, reason: 'no-snapshot' };
  }

  const observedAt = new Date(input.observedAt);
  const values = input.resources.map((resource) => {
    const classification =
      input.classificationByLogicalId?.get(resource.logicalId) ?? classifyResource(resource.type, resource.logicalId);
    return {
      deploymentId: input.deploymentId,
      stackId: input.stackId,
      logicalResourceId: resource.logicalId,
      physicalResourceId: resource.physicalId ?? null,
      resourceType: resource.type,
      resourceStatus: mapResourceStatus(resource.status),
      rawResourceStatus: resource.status,
      resourceStatusReason: resource.statusReason ?? null,
      componentKind: classification.componentKind,
      resourceRole: classification.role,
      lifecyclePolicy: classification.lifecycle,
      lastUpdatedAt: observedAt,
      firstSeenAt: observedAt,
    };
  });

  // Stale guard: never overwrite a newer snapshot with a stale one. Rows that
  // fail the guarded update are simply left untouched (counted as not
  // persisted this call). firstSeenAt is only ever set on insert.
  const rows = await db.transaction(async (tx) => {
    if (values.length > 0) {
      await tx
        .delete(deploymentResources)
        .where(
          and(
            eq(deploymentResources.deploymentId, input.deploymentId),
            ne(deploymentResources.stackId, input.stackId),
            lte(deploymentResources.lastUpdatedAt, observedAt),
          ),
        );
    }
    return tx
      .insert(deploymentResources)
      .values(values)
      .onConflictDoUpdate({
        target: [
          deploymentResources.deploymentId,
          deploymentResources.stackId,
          deploymentResources.logicalResourceId,
        ],
        set: {
          physicalResourceId: sql`excluded.physical_resource_id`,
          resourceType: sql`excluded.resource_type`,
          resourceStatus: sql`excluded.resource_status`,
          rawResourceStatus: sql`excluded.raw_resource_status`,
          resourceStatusReason: sql`excluded.resource_status_reason`,
          componentKind: sql`excluded.component_kind`,
          resourceRole: sql`excluded.resource_role`,
          lifecyclePolicy: sql`excluded.lifecycle_policy`,
          lastUpdatedAt: sql`excluded.last_updated_at`,
        },
        setWhere: sql`${deploymentResources.lastUpdatedAt} <= excluded.last_updated_at`,
      })
      .returning();
  });

  return { persisted: true, count: rows.length };
}