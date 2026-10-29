import { and, eq, gt, inArray } from 'drizzle-orm';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { ApiError } from './errors.js';

// §39 deployment-job creation, shared by the API routes and the worker
// Lambda — both create jobs the relay picks up, and both must go through
// the same idempotency path.

/** Postgres unique-violation (23505), wherever drizzle/pg nested it. */
export function isUniqueViolation(error: unknown): boolean {
  for (let cause: unknown = error; cause; cause = (cause as { cause?: unknown }).cause) {
    if ((cause as { code?: string }).code === '23505') return true;
  }
  return error instanceof Error && /unique|duplicate key/i.test(error.message);
}

/**
 * §39 idempotency: unique-constraint-violation-as-signal. A retry (same
 * derived or client-supplied key) must return the job that already exists,
 * never create a second one and never 500.
 *
 * Two unique constraints can fire here: the idempotency key (a replay — hand
 * back the existing row) and deployment_jobs_one_active_mutating_uidx (a
 * DIFFERENT mutating job is already active on this deployment — the racing
 * request that got past the route-level idle check loses here, with the same
 * DEPLOYMENT_BUSY answer it would have gotten from the check). Postgres does
 * not guarantee which constraint reports first when both are violated, so the
 * catch always re-checks the key before concluding "busy".
 */
export async function createOrReuseJob(
  db: RuntimeDb,
  params: {
    deploymentId: string;
    type: (typeof schema.deploymentJobs.$inferInsert)['type'];
    idempotencyKey: string;
    payload: Record<string, unknown>;
    requestedBy: string | null;
  },
): Promise<{ job: typeof schema.deploymentJobs.$inferSelect; created: boolean }> {
  let inserted: (typeof schema.deploymentJobs.$inferSelect)[];
  try {
    inserted = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: params.deploymentId,
        type: params.type,
        state: 'REQUESTED',
        idempotencyKey: params.idempotencyKey,
        payload: params.payload,
        requestedBy: params.requestedBy,
      })
      .onConflictDoNothing({ target: schema.deploymentJobs.idempotencyKey })
      .returning();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    inserted = [];
  }

  if (inserted.length > 0) {
    return { job: inserted[0]!, created: true };
  }

  // Conflict: the idempotency key already exists — return the existing job
  // (200) rather than manufacturing a duplicate or 500ing on the constraint.
  const existing = await db
    .select()
    .from(schema.deploymentJobs)
    .where(eq(schema.deploymentJobs.idempotencyKey, params.idempotencyKey))
    .limit(1);
  if (existing.length === 0) {
    // No row under this key: the violation came from the one-active-job
    // index — another mutating operation won the race.
    throw new ApiError(
      409,
      'DEPLOYMENT_BUSY',
      'Another deployment operation is already in progress.',
    );
  }
  return { job: existing[0]!, created: false };
}

/**
 * Whether a READY release newer than the deployment's current release
 * exists — the exact condition under which a live deployment is
 * UPDATE_AVAILABLE rather than HEALTHY (§46). Shared by the relay result
 * route and the stuck-job watchdog to settle failed day-2 operations.
 *
 * A null currentReleaseId is not "nothing to compare against": a first
 * install runs the template-pinned image with no release row deployed yet
 * (CANARY-008), so any READY release already counts as an available update.
 * Callers with a genuinely never-installed deployment never reach here —
 * deploymentStateAfterFailedJob short-circuits to FAILED on hasCurrentRelease
 * before this result is used.
 */
export async function newerReadyReleaseExists(
  db: RuntimeDb,
  applicationId: string,
  currentReleaseId: string | null,
): Promise<boolean> {
  if (currentReleaseId === null) {
    const [any] = await db
      .select({ id: schema.releases.id })
      .from(schema.releases)
      .where(
        and(
          eq(schema.releases.applicationId, applicationId),
          eq(schema.releases.releaseStatus, 'READY'),
        ),
      )
      .limit(1);
    return any !== undefined;
  }
  // Compared inside Postgres: created_at keeps microseconds, a JS Date only
  // milliseconds, so a round-tripped value makes the current release look
  // newer than itself. An unknown current release yields NULL — no match.
  const currentCreatedAt = db
    .select({ createdAt: schema.releases.createdAt })
    .from(schema.releases)
    .where(eq(schema.releases.id, currentReleaseId));
  const newer = await db
    .select({ id: schema.releases.id })
    .from(schema.releases)
    .where(
      and(
        eq(schema.releases.applicationId, applicationId),
        eq(schema.releases.releaseStatus, 'READY'),
        gt(schema.releases.createdAt, currentCreatedAt),
      ),
    )
    .limit(1);
  return newer.length > 0;
}

/**
 * A release just became READY (DZ-AUDIT-007): a HEALTHY deployment of the
 * application is now behind when a READY release newer than its current one
 * exists. An older release that finishes building late flips nothing.
 * Shared between the worker's recordBuildResult and the API's fixture-mode
 * build path so both writers flip the fleet identically.
 */
export async function flipHealthyDeploymentsToUpdateAvailable(
  db: RuntimeDb,
  applicationId: string,
): Promise<void> {
  const healthy = await db
    .select({ id: schema.deployments.id, currentReleaseId: schema.deployments.currentReleaseId })
    .from(schema.deployments)
    .where(
      and(eq(schema.deployments.applicationId, applicationId), eq(schema.deployments.state, 'HEALTHY')),
    );
  for (const deployment of healthy) {
    if (!(await newerReadyReleaseExists(db, applicationId, deployment.currentReleaseId))) continue;
    await db
      .update(schema.deployments)
      .set({ state: 'UPDATE_AVAILABLE' })
      .where(and(eq(schema.deployments.id, deployment.id), eq(schema.deployments.state, 'HEALTHY')));
  }
}

/**
 * Whether anything has ever run in this deployment: a SUCCEEDED install that
 * started its task, or a SUCCEEDED deploy/rollback. A zero-task install
 * (`payload.startAfterConfig`, DEPLOY-009) succeeded without starting
 * anything — its first deploy is the first start, and a failed first start
 * is a failed environment, not a failed update.
 *
 * Shared between the relay result route and the stuck-job watchdog so they
 * use the same semantics (DZ-AUDIT-011).
 */
export async function hasStartedInstall(db: RuntimeDb, deploymentId: string): Promise<boolean> {
  const jobs = await db
    .select({ type: schema.deploymentJobs.type, state: schema.deploymentJobs.state, payload: schema.deploymentJobs.payload })
    .from(schema.deploymentJobs)
    .where(
      and(
        eq(schema.deploymentJobs.deploymentId, deploymentId),
        inArray(schema.deploymentJobs.type, ['INSTALL', 'DEPLOY_RELEASE', 'ROLLBACK']),
      ),
    );
  return jobs.some((j) => {
    if (j.state !== 'SUCCEEDED' && j.state !== 'SUCCESS') return false;
    if (j.type !== 'INSTALL') return true;
    return (j.payload as Record<string, unknown> | null)?.['startAfterConfig'] !== true;
  });
}

/**
 * A zero-task install (`payload.startAfterConfig`, DEPLOY-009) succeeded and
 * no deploy has started the application since.
 */
export async function awaitsFirstStart(db: RuntimeDb, deploymentId: string): Promise<boolean> {
  if (await hasStartedInstall(db, deploymentId)) return false;
  const installs = await db
    .select({ state: schema.deploymentJobs.state, payload: schema.deploymentJobs.payload })
    .from(schema.deploymentJobs)
    .where(and(eq(schema.deploymentJobs.deploymentId, deploymentId), eq(schema.deploymentJobs.type, 'INSTALL')));
  return installs.some(
    (j) =>
      (j.state === 'SUCCEEDED' || j.state === 'SUCCESS') &&
      (j.payload as Record<string, unknown> | null)?.['startAfterConfig'] === true,
  );
}
