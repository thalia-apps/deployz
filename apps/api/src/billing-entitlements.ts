import { and, eq, ne } from 'drizzle-orm';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { ApiError } from './errors.js';
import { getSubscriptionStatus } from './organizations.js';

// Paddle migration Phase 7 — free evaluation entitlements. Evaluation is
// free and never expires: signup, application analysis, configuration, AI
// recommendations, customer records, release builds, and ONE active vendor
// TEST deployment per application. None of that consults billing. Only a
// PRODUCTION deployment requires an ACTIVE subscription (Phase 8 turns the
// refusal below into the checkout flow).

/**
 * A PRODUCTION deployment requires an ACTIVE Deployz subscription that is
 * not set to end. PAST_DUE, PAUSED, CANCELED and no row at all refuse the
 * same way. A subscription set to end at the period end is ACTIVE but
 * refuses too: Polar accepts no unit change on it, so a new deployment
 * would run unbilled. Resuming the subscription in the billing portal lifts
 * the refusal; existing deployments are never affected.
 *
 * `enforcementPaused` is the BILLING_ENFORCEMENT=off kill switch (env.ts):
 * when it is true the gate opens for every organization, whatever its
 * subscription status. Passed in rather than read here so tests and the
 * two call sites keep the same injection shape as the rest of env.
 */
export async function assertProductionDeploymentAllowed(
  db: RuntimeDb,
  organizationId: string,
  enforcementPaused = false,
): Promise<void> {
  if (enforcementPaused) {
    return;
  }
  const subscriptionStatus = await getSubscriptionStatus(db, organizationId);
  if (subscriptionStatus !== 'ACTIVE') {
    throw new ApiError(
      402,
      'SUBSCRIPTION_REQUIRED',
      'A production deployment needs an active Deployz subscription.',
      { subscriptionStatus },
    );
  }
  const [scheduled] = await db
    .select({ action: schema.billingSubscriptions.scheduledChangeAction, at: schema.billingSubscriptions.scheduledChangeAt })
    .from(schema.billingSubscriptions)
    .where(eq(schema.billingSubscriptions.organizationId, organizationId))
    .limit(1);
  if (scheduled?.action === 'cancel') {
    throw new ApiError(
      402,
      'SUBSCRIPTION_REQUIRED',
      'Your subscription is set to end. Resume it in the billing portal to add customer deployments.',
      { subscriptionStatus, cancelAt: scheduled.at?.toISOString() ?? null },
    );
  }
}

/**
 * At most one TEST deployment may be active (state <> 'DELETED') per
 * application at a time — retries and recreates are allowed once the
 * previous one is removed. This is the friendly pre-check; the partial
 * unique index `deployments_one_active_test_per_application_uidx`
 * (packages/db/src/schema/deployments.ts) is the database-level backstop
 * for two concurrent creates that both pass this check before either
 * inserts — see isTestDeploymentSlotViolation below.
 */
export async function assertTestDeploymentSlot(
  db: RuntimeDb,
  organizationId: string,
  applicationId: string,
): Promise<void> {
  const [existing] = await db
    .select({ id: schema.deployments.id })
    .from(schema.deployments)
    .where(
      and(
        eq(schema.deployments.organizationId, organizationId),
        eq(schema.deployments.applicationId, applicationId),
        eq(schema.deployments.deploymentType, 'TEST'),
        ne(schema.deployments.state, 'DELETED'),
      ),
    )
    .limit(1);
  if (existing) {
    throw new ApiError(
      409,
      'TEST_DEPLOYMENT_EXISTS',
      'This application already has a test deployment. Remove it before you create another.',
      { deploymentId: existing.id },
    );
  }
}

/**
 * Whether an error is a Postgres unique-violation (23505) on the one-
 * active-test-per-application partial index — the race between two
 * concurrent creates that both passed assertTestDeploymentSlot before
 * either inserted. Walks `.cause` the way drizzle/pg nests the driver error.
 */
export function isTestDeploymentSlotViolation(error: unknown): boolean {
  for (let cause: unknown = error; cause; cause = (cause as { cause?: unknown }).cause) {
    const c = cause as { code?: string; constraint?: string };
    if (c.code === '23505') {
      return c.constraint === 'deployments_one_active_test_per_application_uidx';
    }
  }
  return false;
}
