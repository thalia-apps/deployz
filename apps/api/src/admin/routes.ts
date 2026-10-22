import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { includedProductionDeploymentsSchema } from '@deployz/contracts';
import type { RuntimeDb } from '@deployz/db';

import { updateIncludedProductionDeployments } from '../billing-allowance.js';
import { reconcileBilling } from '../billing-reconcile.js';
import type { PaddleBilling } from '../paddle.js';
import * as schema from '@deployz/db/schema';

import { ApiError, NotFoundError } from '../errors.js';
import type { DeploymentJobRow, DeploymentRow } from '../fleet-row.js';
import type { Actor } from '../organizations.js';
import { recordAdminAuditEvent } from './audit.js';
import {
  adminSearch,
  getAuditLog,
  getConnectionDetail,
  getDeploymentDetail,
  getJobDetail,
  getOverview,
  getOverviewPilotInsights,
  getVendorDetail,
  isUuid,
  listConnections,
  listDeployments,
  listJobs,
  listVendors,
} from './queries.js';

export interface AdminRouteDeps {
  db: RuntimeDb;
  // Phase 14: the Reconcile action talks to Paddle through the same client
  // the billing routes use; null when billing is disabled.
  paddle: PaddleBilling | null;
  requireTeamAdmin: (request: FastifyRequest) => Promise<void>;
  // Safe recovery actions (docs/admin/team-admin.md's Supported admin
  // actions): the SAME domain workflows the vendor routes use, extracted in
  // server.ts's buildServer so this file never mutates state independently.
  performRetryInstall: (
    deployment: DeploymentRow,
    actorId: string | null,
  ) => Promise<
    | { replayed: true; job: DeploymentJobRow }
    | { replayed: false; created: boolean; job: DeploymentJobRow }
  >;
  performRollback: (
    deployment: DeploymentRow,
    actorId: string | null,
    releaseId: string,
    idempotencyKeyHeader: string | undefined,
  ) => Promise<{ job: DeploymentJobRow; created: boolean }>;
  performForceCompleteDestroy: (
    deployment: DeploymentRow,
    actorId: string | null,
  ) => Promise<{ state: 'DELETED'; cleanupState: 'SKIPPED_RELAY_OFFLINE'; jobId: string }>;
  performRelayReset: (
    deployment: DeploymentRow,
    actorId: string | null,
  ) => Promise<{ installLinkId: string | null; attemptNumber: number }>;
}

/** requireTeamAdmin guarantees request.user/sessionId are set before any handler here runs. */
function requireActor(request: FastifyRequest): Actor {
  const user = request.user!;
  return { id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerified };
}

/** Admin detail routes 404 on a malformed id rather than let it reach the
 *  database as a uuid-column comparison (which would throw). */
function requireUuidId(id: string): void {
  if (!isUuid(id)) {
    throw new NotFoundError('Resource not found');
  }
}

/** Loads a deployment CROSS-TENANT by id — admin recovery actions act across
 *  every vendor's organization, unlike the vendor-scoped loadOwnedDeployment
 *  in server.ts. 404s on a malformed or missing id. */
async function loadDeploymentCrossTenant(db: RuntimeDb, id: string): Promise<DeploymentRow> {
  requireUuidId(id);
  const rows = await db.select().from(schema.deployments).where(eq(schema.deployments.id, id)).limit(1);
  if (rows.length === 0) {
    throw new NotFoundError('Deployment not found');
  }
  return rows[0]!;
}

const retryInstallBodySchema = z.object({
  reason: z.string().trim().min(1).optional(),
});

const rollbackBodySchema = z.object({
  releaseId: z.string().uuid(),
  reason: z.string().trim().min(3),
});

const forceCompleteDestroyBodySchema = z.object({
  reason: z.string().trim().min(1),
});

const relayResetBodySchema = z.object({
  reason: z.string().trim().min(1),
});

const includedDeploymentsBodySchema = z.object({
  includedProductionDeployments: includedProductionDeploymentsSchema,
  reason: z.string().trim().min(1),
});

/** ?q=&filter= — the shape shared by every admin list route. */
function listQuery(request: FastifyRequest): { q?: string | undefined; filter?: string | undefined } {
  const query = request.query as { q?: string; filter?: string };
  return {
    q: typeof query.q === 'string' && query.q.length > 0 ? query.q : undefined,
    filter: typeof query.filter === 'string' && query.filter.length > 0 ? query.filter : undefined,
  };
}

const PILOT_INSIGHTS_DAYS = [7, 30, 90] as const;

/** ?days=7|30|90 — the pilot-insights window; defaults to 30. */
function pilotInsightsDays(request: FastifyRequest): number {
  const { days } = request.query as { days?: string };
  if (days === undefined) return 30;
  const parsed = Number(days);
  if (!(PILOT_INSIGHTS_DAYS as readonly number[]).includes(parsed)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'days must be one of 7, 30, or 90');
  }
  return parsed;
}

// Team Admin API routes (docs/admin/team-admin.md): the read-only
// overview/vendors/deployments/jobs/connections/audit-log/search routes,
// plus the "View as Vendor" support-session lifecycle.
export function registerAdminRoutes(
  app: FastifyInstance,
  {
    db,
    paddle,
    requireTeamAdmin,
    performRetryInstall,
    performRollback,
    performForceCompleteDestroy,
    performRelayReset,
  }: AdminRouteDeps,
): void {
  // GET /api/admin/overview — items needing attention across every tenant,
  // plus the pilot-insights funnel for the trailing ?days= window.
  app.get('/api/admin/overview', { preHandler: requireTeamAdmin }, async (request) => {
    const overview = await getOverview(db);
    return { ...overview, pilotInsights: await getOverviewPilotInsights(db, pilotInsightsDays(request)) };
  });

  // GET /api/admin/vendors — cross-tenant vendor list.
  app.get('/api/admin/vendors', { preHandler: requireTeamAdmin }, async (request) =>
    ({ vendors: await listVendors(db, listQuery(request)) }),
  );

  // GET /api/admin/vendors/:id — 360° vendor detail.
  app.get('/api/admin/vendors/:id', { preHandler: requireTeamAdmin }, async (request) => {
    const { id } = request.params as { id: string };
    const detail = await getVendorDetail(db, id);
    if (!detail) throw new NotFoundError('Vendor not found');
    return detail;
  });

  // GET /api/admin/deployments — cross-tenant deployment command-center list.
  app.get('/api/admin/deployments', { preHandler: requireTeamAdmin }, async (request) =>
    ({ deployments: await listDeployments(db, listQuery(request)) }),
  );

  // GET /api/admin/deployments/:id — deployment command-center detail.
  app.get('/api/admin/deployments/:id', { preHandler: requireTeamAdmin }, async (request) => {
    const { id } = request.params as { id: string };
    requireUuidId(id);
    const detail = await getDeploymentDetail(db, id);
    if (!detail) throw new NotFoundError('Deployment not found');
    return detail;
  });

  // GET /api/admin/jobs — global async-work view.
  app.get('/api/admin/jobs', { preHandler: requireTeamAdmin }, async (request) =>
    ({ jobs: await listJobs(db, listQuery(request)) }),
  );

  // GET /api/admin/jobs/:id — job detail + timeline.
  app.get('/api/admin/jobs/:id', { preHandler: requireTeamAdmin }, async (request) => {
    const { id } = request.params as { id: string };
    requireUuidId(id);
    const detail = await getJobDetail(db, id);
    if (!detail) throw new NotFoundError('Job not found');
    return detail;
  });

  // GET /api/admin/connections — relay/bootstrap connectivity per installed deployment.
  app.get('/api/admin/connections', { preHandler: requireTeamAdmin }, async (request) =>
    ({ connections: await listConnections(db, listQuery(request)) }),
  );

  // GET /api/admin/connections/:id — connection detail (id = deployment id).
  app.get('/api/admin/connections/:id', { preHandler: requireTeamAdmin }, async (request) => {
    const { id } = request.params as { id: string };
    requireUuidId(id);
    const detail = await getConnectionDetail(db, id);
    if (!detail) throw new NotFoundError('Connection not found');
    return detail;
  });

  // GET /api/admin/search?q=… — resolve common identifiers to admin detail pages.
  app.get('/api/admin/search', { preHandler: requireTeamAdmin }, async (request) => {
    const { q } = request.query as { q?: string };
    return adminSearch(db, q ?? '');
  });

  // GET /api/admin/audit-log — admin.* event_logs, newest first.
  app.get('/api/admin/audit-log', { preHandler: requireTeamAdmin }, async (request) => {
    const query = request.query as {
      actor?: string;
      action?: string;
      targetType?: string;
      from?: string;
      to?: string;
      limit?: string;
      before?: string;
    };
    return getAuditLog(db, {
      actor: query.actor,
      action: query.action,
      targetType: query.targetType,
      from: query.from,
      to: query.to,
      limit: query.limit !== undefined ? Number(query.limit) : undefined,
      before: query.before !== undefined ? Number(query.before) : undefined,
    });
  });

  // Enter support mode: point the ADMIN's own session at the vendor's
  // organization. The vendor's credentials, sessions and browser are never
  // touched.
  app.post(
    '/api/admin/vendors/:id/support-session',
    { preHandler: requireTeamAdmin },
    async (request) => {
      const { id } = request.params as { id: string };
      const [organization] = await db
        .select()
        .from(schema.organization)
        .where(eq(schema.organization.id, id))
        .limit(1);
      if (!organization) {
        throw new NotFoundError('Vendor not found');
      }

      await db
        .update(schema.session)
        .set({ supportOrganizationId: organization.id })
        .where(eq(schema.session.id, request.sessionId!));

      await recordAdminAuditEvent(db, {
        actor: requireActor(request),
        eventType: 'admin.support_session.started',
        organizationId: organization.id,
        targetType: 'organization',
        targetId: organization.id,
      });

      return { organizationId: organization.id, organizationName: organization.name };
    },
  );

  // Exit support mode. Idempotent: clearing an already-clear pointer writes
  // no audit event.
  app.delete(
    '/api/admin/support-session',
    { preHandler: requireTeamAdmin },
    async (request, reply) => {
      const sessionId = request.sessionId!;
      const [sessionRow] = await db
        .select({ supportOrganizationId: schema.session.supportOrganizationId })
        .from(schema.session)
        .where(eq(schema.session.id, sessionId))
        .limit(1);
      const activeSupportOrganizationId = sessionRow?.supportOrganizationId;

      await db
        .update(schema.session)
        .set({ supportOrganizationId: null })
        .where(eq(schema.session.id, sessionId));

      if (activeSupportOrganizationId) {
        await recordAdminAuditEvent(db, {
          actor: requireActor(request),
          eventType: 'admin.support_session.ended',
          organizationId: activeSupportOrganizationId,
          targetType: 'organization',
          targetId: activeSupportOrganizationId,
        });
      }

      return reply.code(204).send();
    },
  );

  // ── Safe recovery actions ───────────────────────────────────────────────
  // Each wraps the SAME domain workflow the vendor route uses (never a
  // direct state mutation), loads the deployment cross-tenant, and writes an
  // admin.* audit event only after the workflow succeeds — a guard refusal
  // propagates without an audit row.

  // POST /api/admin/vendors/:id/reconcile-billing — Paddle migration Phase
  // 14. Runs the SAME reconcileBilling the lifecycle hooks and the safety job
  // run: it pushes the absolute live-deployment count onto the subscription
  // and records its own ledger row, so an admin can settle a "why was I
  // billed for N?" question with one click and one audit trail. Safe action:
  // reconcileBilling never throws and is idempotent, so reason is optional.
  app.post(
    '/api/admin/vendors/:id/reconcile-billing',
    { preHandler: requireTeamAdmin },
    async (request) => {
      const { id } = request.params as { id: string };
      const detail = await getVendorDetail(db, id);
      if (!detail) throw new NotFoundError('Vendor not found');
      const body = retryInstallBodySchema.parse(request.body ?? {});
      const actor = requireActor(request);
      const result = await reconcileBilling({ db, paddle }, id);

      await recordAdminAuditEvent(db, {
        actor,
        eventType: 'admin.billing.reconcile_requested',
        organizationId: id,
        targetType: 'organization',
        targetId: id,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
        result: result.status,
        payload: { action: result.action, expected: result.expected, provider: result.provider },
      });

      return result;
    },
  );

  // POST /api/admin/vendors/:id/included-deployments — the included
  // production deployment allowance (docs/billing/included-deployments-
  // implementation.md). The ONLY write path for the value: it belongs to the
  // organization, changes only the per-deployment quantity Paddle bills, and
  // never touches the platform item or any deployment. Commercial action:
  // reason is required, every call is audited with the old and new state,
  // and a real change on a subscribed organization runs the SAME
  // reconcileBilling the lifecycle hooks and the safety job run. A Paddle
  // failure there never reverts the allowance — the ledger row and the
  // Reconcile action / safety job repair the drift.
  app.post(
    '/api/admin/vendors/:id/included-deployments',
    { preHandler: requireTeamAdmin },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = includedDeploymentsBodySchema.parse(request.body);
      const actor = requireActor(request);

      const change = await updateIncludedProductionDeployments(db, id, body.includedProductionDeployments);
      if (!change) throw new NotFoundError('Vendor not found');

      // Only a subscription can be reconciled; before one exists the
      // allowance is simply stored, and no provider call is made.
      const [subscription] = await db
        .select({ status: schema.billingSubscriptions.status })
        .from(schema.billingSubscriptions)
        .where(eq(schema.billingSubscriptions.organizationId, id))
        .limit(1);
      const reconciliationTriggered = change.changed && subscription !== undefined;
      const reconciliation = reconciliationTriggered ? await reconcileBilling({ db, paddle }, id) : null;

      await recordAdminAuditEvent(db, {
        actor,
        eventType: 'admin.billing.included_deployments.updated',
        organizationId: id,
        targetType: 'organization',
        targetId: id,
        reason: body.reason,
        payload: {
          previousIncludedProductionDeployments: change.previous.included,
          includedProductionDeployments: change.current.included,
          activeProductionDeployments: change.activeProductionDeployments,
          previousBillableDeploymentQuantity: change.previous.billable,
          billableDeploymentQuantity: change.current.billable,
          changed: change.changed,
          reconciliationTriggered,
          reconciliation: reconciliation
            ? {
                status: reconciliation.status,
                action: reconciliation.action,
                expected: reconciliation.expected,
                provider: reconciliation.provider,
                ...(reconciliation.reason !== undefined ? { reason: reconciliation.reason } : {}),
              }
            : null,
        },
      });

      return {
        organizationId: id,
        activeProductionDeployments: change.activeProductionDeployments,
        previous: {
          includedProductionDeployments: change.previous.included,
          billableDeploymentQuantity: change.previous.billable,
        },
        current: {
          includedProductionDeployments: change.current.included,
          billableDeploymentQuantity: change.current.billable,
        },
        changed: change.changed,
        reconciliation,
      };
    },
  );

  // POST /api/admin/deployments/:id/retry-install — same guarded flow as the
  // vendor retry-install route. Safe action: reason is optional.
  app.post(
    '/api/admin/deployments/:id/retry-install',
    { preHandler: requireTeamAdmin },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const deployment = await loadDeploymentCrossTenant(db, id);
      const body = retryInstallBodySchema.parse(request.body ?? {});
      const actor = requireActor(request);
      const result = await performRetryInstall(deployment, actor.id);
      const statusCode = result.replayed ? 200 : result.created ? 202 : 200;

      await recordAdminAuditEvent(db, {
        actor,
        eventType: 'admin.install.retry_requested',
        organizationId: deployment.organizationId,
        targetType: 'deployment',
        targetId: deployment.id,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
        payload: { jobId: result.job.id },
      });

      return reply.code(statusCode).send({ jobId: result.job.id, state: result.job.state });
    },
  );

  // POST /api/admin/deployments/:id/rollback — same flow as the vendor
  // rollback route. Risky action: reason is required.
  app.post(
    '/api/admin/deployments/:id/rollback',
    { preHandler: requireTeamAdmin },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const deployment = await loadDeploymentCrossTenant(db, id);
      const body = rollbackBodySchema.parse(request.body);
      const actor = requireActor(request);
      const { job, created } = await performRollback(deployment, actor.id, body.releaseId, undefined);

      await recordAdminAuditEvent(db, {
        actor,
        eventType: 'admin.rollback.requested',
        organizationId: deployment.organizationId,
        targetType: 'deployment',
        targetId: deployment.id,
        reason: body.reason,
        payload: { releaseId: body.releaseId, jobId: job.id },
      });

      return reply.code(created ? 202 : 200).send({ jobId: job.id, state: job.state });
    },
  );

  // POST /api/admin/deployments/:id/force-complete-destroy — same guarded
  // flow as the vendor disconnect/force-complete route. Risky action: reason
  // is required.
  app.post(
    '/api/admin/deployments/:id/force-complete-destroy',
    { preHandler: requireTeamAdmin },
    async (request) => {
      const { id } = request.params as { id: string };
      const deployment = await loadDeploymentCrossTenant(db, id);
      const body = forceCompleteDestroyBodySchema.parse(request.body);
      const actor = requireActor(request);
      const result = await performForceCompleteDestroy(deployment, actor.id);

      await recordAdminAuditEvent(db, {
        actor,
        eventType: 'admin.destroy.force_completed',
        organizationId: deployment.organizationId,
        targetType: 'deployment',
        targetId: deployment.id,
        reason: body.reason,
        payload: { jobId: result.jobId, cleanupState: result.cleanupState },
      });

      return { state: result.state, cleanupState: result.cleanupState };
    },
  );

  // POST /api/admin/deployments/:id/relay-reset — same flow as the vendor
  // relay/reset route. Risky action: reason is required.
  app.post(
    '/api/admin/deployments/:id/relay-reset',
    { preHandler: requireTeamAdmin },
    async (request) => {
      const { id } = request.params as { id: string };
      const deployment = await loadDeploymentCrossTenant(db, id);
      const body = relayResetBodySchema.parse(request.body);
      const actor = requireActor(request);
      const result = await performRelayReset(deployment, actor.id);

      await recordAdminAuditEvent(db, {
        actor,
        eventType: 'admin.relay.reset_requested',
        organizationId: deployment.organizationId,
        targetType: 'deployment',
        targetId: deployment.id,
        reason: body.reason,
        payload: { attemptNumber: result.attemptNumber },
      });

      return { installLinkId: result.installLinkId };
    },
  );
}
