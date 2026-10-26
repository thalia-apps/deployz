import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

// §40/§62 event log — the append-only audit stream.
//
// Every deployment-lifecycle transition writes one row here. Before this, the
// only writers were application deletion and the organization routes, and
// neither set deployment_id — which is the column
// GET /api/deployments/:id/events filters on, so that endpoint could never
// return anything and "Recent activity" was permanently empty.
//
// Rows are immutable: drizzle/0001_event_logs_immutable.sql installs a
// trigger that raises on UPDATE, DELETE and TRUNCATE. An event has to be
// correct when it is written; there is no patching it afterwards.
//
// Write inside the same transaction as the state change it describes, so an
// event can never disagree with the row it is about.

/** §40 event vocabulary. Families are install/deploy/rollback/destroy/config/health/relay. */
export type DeploymentEventType =
  | 'install.requested'
  | 'install.launched'
  | 'install.completed'
  | 'install.failed'
  | 'install.retry.requested'
  | 'install.enrollment.rejected'
  | 'deploy.requested'
  | 'deploy.completed'
  | 'deploy.failed'
  | 'rollback.requested'
  | 'rollback.completed'
  | 'rollback.failed'
  | 'restart.requested'
  | 'restart.completed'
  | 'restart.failed'
  | 'destroy.requested'
  | 'destroy.completed'
  | 'destroy.failed'
  // Control-plane-only completion of a disconnect whose relay went offline:
  // AWS resources were NOT verified or removed (see cleanupState).
  | 'destroy.force_completed'
  // Runtime observation corrected the release pointer (never a deploy claim).
  | 'deployment.reconciled'
  // A healthy heartbeat cleared a stale FAILED on an installed deployment.
  | 'deployment.state_recovered'
  // An installed application never passed release evidence within its window.
  | 'deployment.install_not_verified'
  // The watchdog failed a stuck mutating job (Phase 7).
  | 'operation.timeout'
  // The watchdog parked an in-flight job because the relay went quiet —
  // never a failure claim; the relay's next command poll claims it back.
  | 'operation.waiting_for_relay'
  // The watchdog re-offered a stuck job to a live relay (reconcile-before-
  // fail); the describe-first executors converge on real AWS state.
  | 'operation.requeued'
  // Funnel: a deployment record was created (manual POST /api/deployments or
  // a deploy link) — origin attribution rides in payload.source.
  | 'deployment.created'
  // A derived deployment `step` (apps/api/src/deployment-status.ts) finished —
  // written by apps/api/src/step-timings.ts's advanceStepTimings, from the
  // relay-authenticated write paths only. Not a lifecycle transition; the
  // append-only record IS the duration dataset for a future P50/P90.
  | 'deployment.step_completed'
  // Paddle migration Phase 2 billing state machine
  // (apps/api/src/billing-domain.ts / billing-lifecycle.ts).
  | 'deployment.billing_started'
  | 'deployment.billing_stopped'
  | 'deployment.billing_paused'
  | 'deployment.billing_resumed'
  // Paddle migration Phase 8 — a parked production deployment was created
  // from the Paddle ACTIVE webhook (apps/api/src/billing-checkout.ts).
  | 'billing.subscription_activated'
  | 'config.updated'
  | 'config.failed'
  | 'health.reported'
  | 'health.degraded'
  | 'health.unhealthy'
  | 'health.recovered'
  | 'ecs.rollout_failed'
  // The relay's first successful enrollment (written inside the register tx —
  // replays early-return before it). A re-enrollment after an admin relay
  // reset is a distinguishable new first connection and emits again.
  | 'relay.connected'
  | 'relay.reenrollment.requested'
  // domain family — custom-domains MVP.
  | 'domain.added'
  | 'domain.activated'
  | 'domain.failed'
  | 'domain.removed'
  // purge family — explicit removal of retained AWS resources on an
  // already-disconnected deployment.
  | 'purge.requested'
  | 'purge.completed'
  | 'purge.failed'
  // deploy-link family — vendor-generated tokenized entry points
  // (apps/api/src/deploy-links.ts).
  | 'deploy_link.created'
  | 'deploy_link.opened'
  | 'deploy_link.launched'
  | 'deploy_link.retry.requested'
  | 'deploy_link.revoked'
  | 'deploy_link.regenerated'
  // public-install-link family — the vendor-side lifecycle of the app-level
  // public install entry points (apps/api/src/public-install.ts). The links
  // carry no secret, so payloads record ids only.
  | 'public_install_link.created'
  | 'public_install_link.enabled'
  | 'public_install_link.disabled'
  | 'public_install_link.revoked'
  | 'public_install_link.regenerated'
  // install-link family — the per-deployment customer invitation, recorded
  // by the public GET route.
  | 'install_link.opened'
  // invitation family — targeted installation invitations (MVP Readiness 2,
  // Phase 6; written by apps/api/src/public-install.ts). One event per step of
  // the invitation lifecycle: created by the vendor; opened, region chosen,
  // and confirmed by the customer; deployment + configuration delivery
  // recorded inside the confirm transaction. Payloads carry ids and counts
  // only — never the token, the resolved URL, config values, or customer
  // name/email.
  | 'invitation.created'
  | 'invitation.opened'
  | 'invitation.regenerated'
  | 'invitation.revoked'
  | 'invitation.confirmed'
  | 'invitation.region_selected'
  | 'invitation.deployment_created'
  | 'invitation.configuration_delivered'
  // application/analysis funnel — PR1 telemetry. The application id rides in
  // `payload.applicationId` (event_logs has no application_id column).
  | 'application.created'
  | 'application.analysis_started'
  | 'application.analysis_completed'
  | 'application.analysis_failed'
  | 'application.preflight_evaluated'
  | 'application.configuration_saved'
  | 'application.environment_settings_saved'
  // A vendor's "not used in production" answer on an allowlisted blocker.
  // The payload names the finding id only, never the evidence text.
  | 'application.analysis_disputed'
  | 'application.analysis_dispute_withdrawn'
  | 'customer.created'
  // Customer page access (docs/customer-access.md). Ids only, never the email.
  | 'customer.signed_in'
  | 'customer.signed_out'
  | 'customer.owner_claimed'
  // release/build telemetry. `release.created` is written by the release
  // route; `release.build_*` by the cdk worker (packages/cdk/src/lambda/
  // worker.ts, which cannot import this module and writes the rows directly —
  // same vocabulary, same payload contract).
  | 'release.created'
  | 'release.build_started'
  | 'release.build_completed'
  | 'release.build_failed';

export interface DeploymentEvent {
  readonly organizationId: string;
  readonly eventType: DeploymentEventType;
  /** 'user' for a vendor action, 'relay' for anything the relay reports, 'customer' for the customer page. */
  readonly actorType: 'user' | 'relay' | 'system' | 'customer';
  /** Better Auth user id, or the deployment id for a relay actor. */
  readonly actorId: string;
  readonly deploymentId?: string | undefined;
  readonly customerId?: string | undefined;
  readonly jobId?: string | undefined;
  readonly releaseId?: string | undefined;
  readonly previousState?: string | null | undefined;
  readonly requestedState?: string | null | undefined;
  readonly result?: 'success' | 'failure' | 'pending' | undefined;
  readonly payload?: Record<string, unknown> | undefined;
}

/**
 * The db or an open transaction. Typed off RuntimeDb's own insert so a
 * transaction handle — which carries the identical signature — satisfies it
 * without the row type being widened to something drizzle cannot check.
 */
export type EventWriter = Pick<RuntimeDb, 'insert'>;

/**
 * Append one event. Takes the db or an open transaction so callers can keep
 * the event and the state change atomic.
 */
export async function recordEvent(tx: EventWriter, event: DeploymentEvent): Promise<void> {
  await tx.insert(schema.eventLogs).values({
    actorType: event.actorType,
    actorId: event.actorId,
    organizationId: event.organizationId,
    customerId: event.customerId ?? null,
    deploymentId: event.deploymentId ?? null,
    jobId: event.jobId ?? null,
    releaseId: event.releaseId ?? null,
    eventType: event.eventType,
    previousState: event.previousState ?? null,
    requestedState: event.requestedState ?? null,
    result: event.result ?? 'success',
    payload: event.payload ?? {},
  });
}
