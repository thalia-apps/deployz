import { eq } from 'drizzle-orm';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { productionDeploymentCounts, type ProductionDeploymentCounts } from './billing-domain.js';

// Included production deployments — the one write path for the allowance.
// Only the Team Admin route calls this (docs/admin/team-admin.md); no vendor
// route can reach it, and support mode is read-only outside /api/admin/*.
//
// The update runs in one transaction with the organization row locked, so
// two admin changes in flight each read the value the other left behind and
// the audit trail never records a stale "previous". The Polar round trip is
// NOT part of the transaction (billing-reconcile.ts): the caller reconciles
// afterwards, and a provider failure never reverts what the admin decided —
// the reconciliation ledger records the drift and the safety job repairs it.

export interface IncludedDeploymentsChange {
  /** Live production deployments at the moment of the change. */
  activeProductionDeployments: number;
  previous: ProductionDeploymentCounts;
  current: ProductionDeploymentCounts;
  /** False for a same-value update: nothing was written. */
  changed: boolean;
}

/**
 * Sets the organization's included production deployments and reports the
 * billable quantity before and after. Returns null for an unknown
 * organization. Validation of the value (integer, 0..max) is the caller's;
 * the database CHECK constraint is the backstop.
 */
export async function updateIncludedProductionDeployments(
  db: RuntimeDb,
  organizationId: string,
  includedProductionDeployments: number,
): Promise<IncludedDeploymentsChange | null> {
  return db.transaction(async (tx) => {
    const [organization] = await tx
      .select({ included: schema.organization.includedProductionDeployments })
      .from(schema.organization)
      .where(eq(schema.organization.id, organizationId))
      .for('update');
    if (!organization) return null;

    const rows = await tx
      .select({
        deploymentType: schema.deployments.deploymentType,
        billingState: schema.deployments.billingState,
      })
      .from(schema.deployments)
      .where(eq(schema.deployments.organizationId, organizationId));
    const previous = productionDeploymentCounts(rows, organization.included);
    const current = productionDeploymentCounts(rows, includedProductionDeployments);
    const changed = previous.included !== current.included;

    if (changed) {
      await tx
        .update(schema.organization)
        .set({ includedProductionDeployments })
        .where(eq(schema.organization.id, organizationId));
    }

    return { activeProductionDeployments: previous.active, previous, current, changed };
  });
}
