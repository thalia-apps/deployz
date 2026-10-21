import type { DeploymentBillingState, DeploymentState, DeploymentType, RelayStatus } from '@deployz/contracts';

// Billing domain rules (Paddle migration Phase 2) — pure functions that
// decide whether, and when, a deployment becomes billable. Deployz displays
// prices but does no money math; the billing provider is the source of
// truth for charges and invoices. Provider-independent on purpose: nothing
// here names Paddle.

export const PLATFORM_PRICE_DOLLARS = 49; // base platform price, display only
export const DEPLOYMENT_PRICE_DOLLARS = 19; // price per billable deployment, display only

// ── Billing state machine ────────────────────────────────────────────────

/** The lifecycle facts the billing state machine reacts to. */
export type BillingEvent = 'LIVE' | 'NOT_SERVING' | 'REMOVED';

/** The subset of a deployment row the billing rules need. */
export interface BillingSnapshot {
  deploymentType: DeploymentType;
  billingState: DeploymentBillingState;
}

/** The patch to persist for a transition — `null` means no change at all. */
export interface BillingPatch {
  billingState: DeploymentBillingState;
  billingStartedAt?: Date;
  billingStoppedAt?: Date;
}

/**
 * Applies one billing event to a deployment's current billing snapshot.
 * A production deployment is billed only while it serves the customer.
 * Three events exist:
 *
 *   - LIVE:        the deployment is verified READY (the relay write paths),
 *                  or the safety job sees it serving again (servingBillingEvent).
 *   - NOT_SERVING: the safety job sees it FAILED or its connector
 *                  DISCONNECTED (servingBillingEvent).
 *   - REMOVED:     a removal was accepted (destroy requested, or a destroy/
 *                  force-complete backstop).
 *
 * Rules:
 *   1. TEST deployments never become billable — every event returns null.
 *   2. PRODUCTION + NOT_STARTED + LIVE -> ACTIVE, billingStartedAt = now.
 *   3. PRODUCTION + PAUSED + LIVE -> ACTIVE (billing resumes). ACTIVE + LIVE
 *      is a no-op; billingStartedAt is write-once.
 *   4. PRODUCTION + ACTIVE + NOT_SERVING -> PAUSED. NOT_STARTED stays
 *      NOT_STARTED: a deployment that never went live was never billed.
 *   5. PRODUCTION + not STOPPED + REMOVED -> STOPPED, billingStoppedAt = now
 *      (a never-live production deployment also stops, so it can never
 *      activate later).
 *   6. STOPPED is terminal — every event returns null.
 */
export function applyBillingTransition(
  deployment: BillingSnapshot,
  event: BillingEvent,
  now: Date,
): BillingPatch | null {
  if (deployment.deploymentType === 'TEST') return null;
  if (deployment.billingState === 'STOPPED') return null;

  if (event === 'LIVE') {
    if (deployment.billingState === 'NOT_STARTED') return { billingState: 'ACTIVE', billingStartedAt: now };
    if (deployment.billingState === 'PAUSED') return { billingState: 'ACTIVE' };
    return null;
  }

  if (event === 'NOT_SERVING') {
    return deployment.billingState === 'ACTIVE' ? { billingState: 'PAUSED' } : null;
  }

  // event === 'REMOVED'
  return { billingState: 'STOPPED', billingStoppedAt: now };
}

/** The deployment and connector facts that say whether it serves the customer. */
export interface ServingSnapshot {
  state: DeploymentState;
  relayStatus: RelayStatus;
}

/**
 * What the safety job concludes from a deployment's persisted state:
 *
 *   - NOT_SERVING when the deployment is FAILED (nothing runs for the
 *     customer) or its connector is DISCONNECTED. relayStatus is persisted
 *     only after RELAY_STALE_AFTER_MS without a check-in, so a short
 *     heartbeat gap never pauses billing.
 *   - LIVE when the connector is CONNECTED and the deployment is HEALTHY or
 *     UPDATE_AVAILABLE — states entered only from verified runtime health.
 *   - null otherwise (installing, updating, deleting): keep the billing state.
 *
 * A failed update never reaches FAILED while the previous release still
 * serves (deploymentStateAfterFailedJob), so it stays billed.
 */
export function servingBillingEvent(deployment: ServingSnapshot): 'LIVE' | 'NOT_SERVING' | null {
  if (deployment.state === 'FAILED' || deployment.relayStatus === 'DISCONNECTED') return 'NOT_SERVING';
  if (
    deployment.relayStatus === 'CONNECTED' &&
    (deployment.state === 'HEALTHY' || deployment.state === 'UPDATE_AVAILABLE')
  ) {
    return 'LIVE';
  }
  return null;
}

/** True only for a PRODUCTION deployment whose billing is ACTIVE. */
export function isBillableDeployment(deployment: BillingSnapshot): boolean {
  return deployment.deploymentType === 'PRODUCTION' && deployment.billingState === 'ACTIVE';
}

/** Number of serving PRODUCTION rows — the active production deployment count. */
export function countBillableDeployments(rows: readonly BillingSnapshot[]): number {
  return rows.filter(isBillableDeployment).length;
}

// ── Included production deployments ──────────────────────────────────────
//
// An organization may carry an admin-set allowance of included production
// deployments (organization.included_production_deployments). It is a
// pooled, concurrent allowance across every application and customer in the
// organization — not credits that are consumed, not a per-deployment flag.
// It reduces ONLY the per-deployment quantity the provider bills; the
// platform subscription is untouched, and no deployment is ever marked free.

/**
 * The quantity the provider bills for: live production deployments beyond
 * the allowance, never negative. This is the ONLY number reconciliation ever
 * pushes to the provider.
 */
export function billableDeploymentQuantity(
  activeProductionDeployments: number,
  includedProductionDeployments: number,
): number {
  return Math.max(activeProductionDeployments - includedProductionDeployments, 0);
}

/** The counts every billing surface shows: active, paused, included, billable. */
export interface ProductionDeploymentCounts {
  active: number;
  /** Live once, but not serving now (failed or disconnected): not billed. */
  paused: number;
  included: number;
  billable: number;
}

export function productionDeploymentCounts(
  rows: readonly BillingSnapshot[],
  includedProductionDeployments: number,
): ProductionDeploymentCounts {
  const active = countBillableDeployments(rows);
  return {
    active,
    paused: rows.filter((row) => row.deploymentType === 'PRODUCTION' && row.billingState === 'PAUSED').length,
    included: includedProductionDeployments,
    billable: billableDeploymentQuantity(active, includedProductionDeployments),
  };
}
