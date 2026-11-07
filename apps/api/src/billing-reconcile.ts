import { eq } from 'drizzle-orm';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { productionDeploymentCounts, subscriptionUnits } from './billing-domain.js';
import { applySubscriptionSnapshot, mapSubscriptionStatus } from './billing-webhooks.js';
import { PolarApiError, type PolarBilling, type PolarSubscription } from './polar.js';

// Reconciliation. Deployz owns exactly one billing number: how many
// production deployments are actually live, less the organization's included
// allowance, with a floor of one unit (billing-domain.ts). This module pushes
// that ABSOLUTE unit count onto the Polar subscription — never a delta, never
// an increment. A missed or duplicated call therefore cannot drift the
// quantity: running it twice produces the same subscription as running it
// once. Polar never learns about the allowance itself; it only ever receives
// the final unit count.
//
// Everything here is decoupled from deployment safety (audit §4). It is
// called only after a billing state actually changed, it never runs inside
// the caller's transaction (a provider round trip must not hold a database
// connection open), and it never throws: a provider failure is recorded and
// the safety job picks the drift up on its next pass.

export interface ReconcileDeps {
  db: RuntimeDb;
  polar: PolarBilling | null;
  now?: () => Date;
}

/** What reconciliation did. Recorded verbatim in `billing_reconciliation_events.action`. */
export type ReconcileAction =
  | 'NONE' // provider already matched the expected unit count
  | 'QUANTITY_UPDATED' // the subscription units were set to the expected count
  | 'SKIPPED';

export interface ReconcileResult {
  status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
  action: ReconcileAction;
  /** Live production deployments, before the allowance. */
  active: number;
  /** The organization's included production deployments. */
  included: number;
  /** The unit count Deployz believes should be billed: max(active - included, 1). */
  expected: number;
  /** What the provider had before the update — null when it was never read. */
  provider: number | null;
  reason?: string;
}

// The subscription states whose units Deployz updates. PAUSED and CANCELED
// are left alone, and a CANCELED subscription bills nothing anyway.
const UPDATABLE_STATUSES: ReadonlySet<string> = new Set(['ACTIVE', 'PAST_DUE']);

/** Two reconciles of one organization can run at once; each re-counts after its update, at most this often. */
const MAX_PUSHES = 3;

async function recordReconciliation(
  db: RuntimeDb,
  organizationId: string,
  result: ReconcileResult,
): Promise<void> {
  await db.insert(schema.billingReconciliationEvents).values({
    organizationId,
    expectedDeploymentQuantity: result.expected,
    providerDeploymentQuantity: result.provider,
    action: result.action,
    status: result.status,
    error: result.reason ?? null,
  });
}

/** Live production deployments, the allowance, and the unit count they make. */
async function countUnits(
  db: RuntimeDb,
  organizationId: string,
): Promise<{ active: number; included: number; billable: number; expected: number }> {
  const rows = await db
    .select({
      deploymentType: schema.deployments.deploymentType,
      billingState: schema.deployments.billingState,
    })
    .from(schema.deployments)
    .where(eq(schema.deployments.organizationId, organizationId));
  const [organization] = await db
    .select({ included: schema.organization.includedProductionDeployments })
    .from(schema.organization)
    .where(eq(schema.organization.id, organizationId))
    .limit(1);
  const { active, included, billable } = productionDeploymentCounts(rows, organization?.included ?? 0);
  return { active, included, billable, expected: subscriptionUnits(billable) };
}

/**
 * Polar is the source of truth for the subscription's status and a scheduled
 * cancellation. A webhook that was lost, or that an older delivery overwrote,
 * leaves the local row wrong; this writes what Polar says through the same
 * snapshot code as the webhook, dated by Polar's own `modified_at`. It writes
 * nothing when the two agree.
 */
async function repairFromPolar(
  db: RuntimeDb,
  organizationId: string,
  local: { status: string; scheduledChangeAction: string | null },
  live: PolarSubscription,
): Promise<{ status: string; scheduledCancel: boolean }> {
  const status = mapSubscriptionStatus(live.status);
  if (!status) return { status: local.status, scheduledCancel: local.scheduledChangeAction === 'cancel' };
  const scheduledCancel = live.cancel_at_period_end && status !== 'CANCELED';
  if (status !== local.status || scheduledCancel !== (local.scheduledChangeAction === 'cancel')) {
    const observedAt = live.modified_at ? new Date(live.modified_at) : new Date();
    await db.transaction((tx) => applySubscriptionSnapshot(tx, organizationId, live, observedAt));
  }
  return { status, scheduledCancel };
}

/** Sets the units on Polar; returns the ledger note when the difference is left for a later order. */
async function pushUnits(
  polar: PolarBilling,
  subscriptionId: string,
  status: string,
  units: number,
): Promise<string | undefined> {
  // Polar owns the money math. The prorated difference is billed NOW
  // (`invoice`): a charge for a deployment that went live mid-period, a
  // credit for one that stopped. When the card is declined (402) the change
  // still lands, with the difference left for Polar's next order
  // (`prorate`): the deployment is running and must not go unbilled. A
  // PAST_DUE subscription goes straight to `prorate`, so a failing card is
  // not charged again on every pass.
  if (status === 'PAST_DUE') {
    await polar.client.updateSubscriptionUnits(subscriptionId, units, 'prorate');
    return 'subscription past due; the difference is billed at renewal';
  }
  try {
    await polar.client.updateSubscriptionUnits(subscriptionId, units, 'invoice');
    return undefined;
  } catch (error) {
    if (!(error instanceof PolarApiError && error.status === 402)) throw error;
    await polar.client.updateSubscriptionUnits(subscriptionId, units, 'prorate');
    return 'payment failed; the difference is billed at renewal';
  }
}

/**
 * Brings the organization's subscription in line with the number of live
 * production deployments.
 *
 * A no-op pass (the provider already agreed) writes no reconciliation row —
 * this runs on every billing transition and on the Phase 10 schedule, and a
 * ledger of "nothing happened" would bury the entries that matter. It still
 * stamps `lastReconciledAt`, which is what says the check ran.
 *
 * Nothing serializes two reconciles of one organization (a Polar round trip
 * must not hold a database connection). Instead every pass re-counts after
 * its own update and pushes again when the count moved, so the last pass to
 * finish leaves Polar at the current count.
 */
export async function reconcileBilling(
  deps: ReconcileDeps,
  organizationId: string,
): Promise<ReconcileResult> {
  const { db, polar } = deps;
  const now = deps.now ?? (() => new Date());

  let { active, included, billable, expected } = await countUnits(db, organizationId);

  if (!polar) {
    // Billing is switched off for this deployment of the control plane; there
    // is no provider to disagree with.
    return {
      status: 'SKIPPED',
      action: 'SKIPPED',
      active,
      included,
      expected,
      provider: null,
      reason: 'billing disabled',
    };
  }

  const [subscription] = await db
    .select()
    .from(schema.billingSubscriptions)
    .where(eq(schema.billingSubscriptions.organizationId, organizationId))
    .limit(1);

  if (!subscription) {
    // Evaluation mode. Nothing was ever sold, so nothing can be reconciled.
    // Recorded only when a live production deployment beyond the allowance
    // has no subscription behind it.
    const result: ReconcileResult = {
      status: 'SKIPPED',
      action: 'SKIPPED',
      active,
      included,
      expected,
      provider: null,
      reason: 'no subscription',
    };
    if (billable > 0) await recordReconciliation(db, organizationId, result);
    return result;
  }

  const stamp = async () => {
    await db
      .update(schema.billingSubscriptions)
      .set({ lastReconciledAt: now() })
      .where(eq(schema.billingSubscriptions.organizationId, organizationId));
  };
  const skipped = async (status: string): Promise<ReconcileResult> => {
    const result: ReconcileResult = {
      status: 'SKIPPED',
      action: 'SKIPPED',
      active,
      included,
      expected,
      provider: null,
      reason: `subscription is ${status}`,
    };
    if (billable > 0) await recordReconciliation(db, organizationId, result);
    return result;
  };
  // A subscription set to end at the period end cannot change units on
  // Polar's side (403 AlreadyCanceledSubscription), and new customer
  // deployments are refused meanwhile (billing-entitlements.ts). Stamped, so
  // the safety job does not retry it every pass; resuming the subscription
  // reconciles again (the webhook path, or the next pass reading Polar). A
  // deployment already live that resumes in this window runs unbilled until
  // the period ends: an accepted, bounded loss.
  const cancellationScheduled: ReconcileResult = {
    status: 'SKIPPED',
    action: 'SKIPPED',
    active,
    included,
    expected,
    provider: null,
    reason: 'cancellation scheduled',
  };

  if (!UPDATABLE_STATUSES.has(subscription.status)) return skipped(subscription.status);

  try {
    const live = await polar.client.getSubscription(subscription.providerSubscriptionId);
    const { status, scheduledCancel } = await repairFromPolar(db, organizationId, subscription, live);
    if (scheduledCancel) {
      await stamp();
      return cancellationScheduled;
    }
    if (!UPDATABLE_STATUSES.has(status)) return await skipped(status);

    const provider = live.units ?? 0;
    let pushed = provider;
    let note: string | undefined;
    for (let pushes = 0; pushed !== expected && pushes < MAX_PUSHES; pushes += 1) {
      note = (await pushUnits(polar, subscription.providerSubscriptionId, status, expected)) ?? note;
      pushed = expected;
      ({ active, included, billable, expected } = await countUnits(db, organizationId));
    }

    if (pushed === provider) {
      await stamp();
      return { status: 'SUCCEEDED', action: 'NONE', active, included, expected, provider };
    }

    const result: ReconcileResult = {
      status: 'SUCCEEDED',
      action: 'QUANTITY_UPDATED',
      active,
      included,
      expected,
      provider,
      ...(note ? { reason: note } : {}),
    };
    await recordReconciliation(db, organizationId, result);
    await stamp();
    return result;
  } catch (error) {
    // Polar set the subscription to end meanwhile (the webhook has not
    // arrived yet): the same as the scheduled-cancel skip above.
    if (error instanceof PolarApiError && error.code === 'AlreadyCanceledSubscription') {
      return cancellationScheduled;
    }
    const result: ReconcileResult = {
      status: 'FAILED',
      action: 'NONE',
      active,
      included,
      expected,
      provider: null,
      reason: error instanceof Error ? error.message : String(error),
    };
    await recordReconciliation(db, organizationId, result).catch(() => {
      // The ledger write is best effort — losing it must not turn a billing
      // problem into a failed deployment request.
    });
    return result;
  }
}
