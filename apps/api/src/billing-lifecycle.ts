import { and, eq } from 'drizzle-orm';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import {
  applyBillingTransition,
  servingBillingEvent,
  type BillingEvent,
  type BillingSnapshot,
  type ServingSnapshot,
} from './billing-domain.js';
import { recordEvent, type EventWriter } from './events.js';

// Idempotent DB helpers for the billing transitions the deployment
// lifecycle hooks into (docs/billing/paddle-billing.md, "The lifecycle, end
// to end"). Each computes the pure domain patch, applies it with a WHERE guard
// on the expected previous billing_state (so two concurrent writers can
// never both apply it), and records the matching event. A no-op transition
// (TEST deployment, already applied, terminal STOPPED, or a guard miss)
// writes nothing and returns false.

/** The db or an open transaction — same shape recordEvent already accepts. */
type BillingWriter = Pick<RuntimeDb, 'update'> & EventWriter;

/** The subset of a deployment row the billing writes need. */
export interface BillableDeployment extends BillingSnapshot, ServingSnapshot {
  id: string;
  organizationId: string;
  customerId: string;
  installationId: string | null;
}

async function applyBillingWrite(
  db: BillingWriter,
  deployment: BillableDeployment,
  event: BillingEvent,
  now: Date,
  eventType:
    | 'deployment.billing_started'
    | 'deployment.billing_paused'
    | 'deployment.billing_resumed'
    | 'deployment.billing_stopped',
  actorType: 'user' | 'relay' | 'system',
  actorId: string,
): Promise<boolean> {
  const patch = applyBillingTransition(deployment, event, now);
  if (patch === null) return false;

  const updated = await db
    .update(schema.deployments)
    .set(patch)
    .where(
      and(
        eq(schema.deployments.id, deployment.id),
        eq(schema.deployments.billingState, deployment.billingState),
      ),
    )
    .returning();
  // The WHERE guard missed: a concurrent writer already applied this exact
  // transition. Nothing left to record.
  if (updated.length === 0) return false;

  await recordEvent(db, {
    organizationId: deployment.organizationId,
    eventType,
    actorType,
    actorId,
    deploymentId: deployment.id,
    customerId: deployment.customerId,
    payload: {
      deploymentType: deployment.deploymentType,
      billingState: patch.billingState,
      // The serving facts behind the transition, so a pause or resume is
      // auditable from the event alone.
      state: deployment.state,
      relayStatus: deployment.relayStatus,
    },
  });
  return true;
}

/**
 * The deployment is verified READY — called from
 * `advanceStepTimingsAfterWrite`, itself only ever invoked from the relay-
 * authenticated write paths (heartbeat, job-result), and from the Phase 10
 * safety job. Starts billing on the first one and resumes a PAUSED one. A
 * row that still reads FAILED or DISCONNECTED is not serving, so nothing
 * moves: resuming it would only be paused again by the next safety-job pass.
 * `actor` defaults to `relay`, which matches every other event those call
 * sites record (e.g. `deployment.reconciled`); the Phase 10 safety job
 * overrides it, because a promotion it makes was not the relay's doing.
 */
export function markDeploymentLive(
  db: BillingWriter,
  deployment: BillableDeployment,
  now: Date,
  actor: { actorType: 'user' | 'relay' | 'system'; actorId: string } = {
    actorType: 'relay',
    actorId: deployment.installationId ?? deployment.id,
  },
): Promise<boolean> {
  if (servingBillingEvent(deployment) === 'NOT_SERVING') return Promise.resolve(false);
  return applyBillingWrite(
    db,
    deployment,
    'LIVE',
    now,
    deployment.billingState === 'PAUSED' ? 'deployment.billing_resumed' : 'deployment.billing_started',
    actor.actorType,
    actor.actorId,
  );
}

/**
 * Moves billing with whether the deployment serves the customer — called
 * only from the Phase 10 safety job, so it follows the persisted signals on
 * the existing 15-minute cadence, never a single missed heartbeat
 * (servingBillingEvent). ACTIVE -> PAUSED when the deployment is FAILED or
 * its connector is DISCONNECTED; PAUSED -> ACTIVE when it is connected and
 * HEALTHY or UPDATE_AVAILABLE again. NOT_STARTED is never touched here:
 * first activation needs a verified READY stage. True when billing moved.
 */
export function syncServingBilling(
  db: BillingWriter,
  deployment: BillableDeployment,
  now: Date,
): Promise<boolean> {
  const event = servingBillingEvent(deployment);
  const actor = { actorType: 'system', actorId: 'billing-safety-job' } as const;
  if (event === 'NOT_SERVING') {
    return applyBillingWrite(db, deployment, event, now, 'deployment.billing_paused', actor.actorType, actor.actorId);
  }
  if (event === 'LIVE' && deployment.billingState === 'PAUSED') {
    return markDeploymentLive(db, deployment, now, actor);
  }
  return Promise.resolve(false);
}

/**
 * A removal was accepted — called from the destroy route's accepted-removal
 * and immediate-DELETED paths, the DESTROY job SUCCEEDED handler, and the
 * force-complete backstop. `actor` defaults to the vendor action every one
 * of those sites otherwise records; the DESTROY job SUCCEEDED handler (a
 * relay-reported result) overrides it.
 */
export function markDeploymentRemoved(
  db: BillingWriter,
  deployment: BillableDeployment,
  now: Date,
  actor: { actorType: 'user' | 'relay' | 'system'; actorId: string } = {
    actorType: 'user',
    actorId: 'system',
  },
): Promise<boolean> {
  return applyBillingWrite(
    db,
    deployment,
    'REMOVED',
    now,
    'deployment.billing_stopped',
    actor.actorType,
    actor.actorId,
  );
}
