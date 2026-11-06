import { eq } from 'drizzle-orm';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { productionDeploymentCounts, subscriptionUnits } from './billing-domain.js';
import type { PolarBilling } from './polar.js';

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

/**
 * Brings the organization's subscription in line with the number of live
 * production deployments.
 *
 * A no-op pass (the provider already agreed) writes no reconciliation row —
 * this runs on every billing transition and on the Phase 10 schedule, and a
 * ledger of "nothing happened" would bury the entries that matter. It still
 * stamps `lastReconciledAt`, which is what says the check ran.
 */
export async function reconcileBilling(
  deps: ReconcileDeps,
  organizationId: string,
): Promise<ReconcileResult> {
  const { db, polar } = deps;
  const now = deps.now ?? (() => new Date());

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
  const expected = subscriptionUnits(billable);

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

  if (!UPDATABLE_STATUSES.has(subscription.status)) {
    const result: ReconcileResult = {
      status: 'SKIPPED',
      action: 'SKIPPED',
      active,
      included,
      expected,
      provider: null,
      reason: `subscription is ${subscription.status}`,
    };
    if (billable > 0) await recordReconciliation(db, organizationId, result);
    return result;
  }

  try {
    const live = await polar.client.getSubscription(subscription.providerSubscriptionId);
    const provider = live.units ?? 0;

    if (provider === expected) {
      await db
        .update(schema.billingSubscriptions)
        .set({ lastReconciledAt: now() })
        .where(eq(schema.billingSubscriptions.organizationId, organizationId));
      return { status: 'SUCCEEDED', action: 'NONE', active, included, expected, provider };
    }

    // Polar owns the money math: the change applies now, and the prorated
    // difference (a charge for a deployment that went live mid-cycle, a
    // credit for one that stopped) lands on the next renewal invoice.
    await polar.client.updateSubscriptionUnits(subscription.providerSubscriptionId, expected);

    const action: ReconcileAction = 'QUANTITY_UPDATED';
    const result: ReconcileResult = { status: 'SUCCEEDED', action, active, included, expected, provider };
    await recordReconciliation(db, organizationId, result);
    await db
      .update(schema.billingSubscriptions)
      .set({ lastReconciledAt: now() })
      .where(eq(schema.billingSubscriptions.organizationId, organizationId));
    return result;
  } catch (error) {
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
