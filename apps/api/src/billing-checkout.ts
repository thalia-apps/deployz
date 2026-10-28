import { and, eq, lt, sql } from 'drizzle-orm';

import type { InfrastructureSizeTier, Region } from '@deployz/contracts';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createDeploymentRecord, loadOwnedApplication, loadOwnedCustomer, materializePendingSecretsForDeployment } from './deploy-links.js';
import { resolveSizeSelection } from './deployment-size.js';
import { ApiError } from './errors.js';
import { recordEvent } from './events.js';
import { newestDeployableRelease, releaseRequiredError } from './install-parameters.js';
import { getSubscriptionStatus } from './organizations.js';
import type { PaddleBilling } from './paddle.js';
import { requirePreflightReady, runApplicationPreflight } from './preflight.js';

// Paddle migration Phase 8 — first production activation. A vendor with no
// subscription asks for a customer deployment: nothing is provisioned, no
// deployment row is written and no install link exists. The request is parked
// as a billing_checkout_intents row tied to a Paddle transaction, and the
// vendor pays through Paddle.js. When the subscription activates, the Phase 6
// webhook completes the intent and only then does the deployment row appear.
//
// The transaction carries the PLATFORM price only. The per-deployment price
// is billed by quantity through Phase 9 reconciliation, which counts
// deployments that are actually live (billing_state ACTIVE) — a deployment
// that has not installed yet is not live, so charging $19 here would bill for
// something that is not running.

/** A parked request older than this is stale: Paddle may have dropped its
 *  transaction, and the vendor's intent has plainly moved on. */
const CHECKOUT_INTENT_EXPIRY_MS = 24 * 60 * 60 * 1000;

export interface CheckoutDeps {
  db: RuntimeDb;
  paddle: PaddleBilling | null;
  /** DEPLOY-027 (Phase 4) — materialization seam (see deploy-links.ts). */
  materialization?: import('./deploy-links.js').MaterializationDeps;
  /** Compiler-v2 — artifact publication seam (see compiler-artifact.ts). */
  templatePublisher?: import('./compiler-artifact.js').TemplatePublisher;
  now?: () => Date;
}

export interface CreateCheckoutIntentParams {
  organizationId: string;
  /** Optional: a subscribe-only intent (invitation-first flow) parks no
   *  deployment request — activation just starts the subscription. When any
   *  of the three is given, all three are required together. */
  applicationId?: string;
  customerId?: string;
  region?: Region;
  /** The size for the parked deployment; absent = the application default. */
  sizeProfile?: InfrastructureSizeTier;
  createdBy: string | null;
}

export interface CreatedCheckoutIntent {
  checkoutIntentId: string;
  transactionId: string;
}

/** Expires PENDING intents older than the window, so a checkout retried much
 *  later never resurrects a transaction Paddle has long since dropped. */
async function expireStalePendingIntents(
  db: RuntimeDb,
  organizationId: string,
  now: Date,
): Promise<void> {
  await db
    .update(schema.billingCheckoutIntents)
    .set({ status: 'EXPIRED', resolvedAt: now })
    .where(
      and(
        eq(schema.billingCheckoutIntents.organizationId, organizationId),
        eq(schema.billingCheckoutIntents.status, 'PENDING'),
        lt(schema.billingCheckoutIntents.createdAt, new Date(now.getTime() - CHECKOUT_INTENT_EXPIRY_MS)),
      ),
    );
}

/**
 * Parks a production deployment request and opens a Paddle transaction for
 * it. Everything that can be checked before the vendor pays is checked here
 * — organization ownership of the application and the customer, and the same
 * preflight and built-release gates createDeploymentRecord runs — so a
 * completed checkout does not land on a request that was never going to work.
 *
 * Pressing the button twice is safe: an organization has at most one PENDING
 * intent (partial unique index), so a second call updates that row with the
 * newest request and reuses its transaction. Paddle is never asked for a
 * second transaction the first checkout would leave dangling.
 */
export async function createCheckoutIntent(
  deps: CheckoutDeps,
  params: CreateCheckoutIntentParams,
): Promise<CreatedCheckoutIntent> {
  const { db, paddle } = deps;
  const now = deps.now ?? (() => new Date());
  if (!paddle) {
    throw new ApiError(503, 'BILLING_DISABLED', 'Paddle billing is not configured');
  }

  // Phase 13: a checkout is the way IN to a subscription, so it is only
  // offered where there is none to fix. ACTIVE creates deployments directly
  // (the Phase 7 gate lets it through, so a second subscription must not be
  // sold). PAST_DUE and PAUSED already have a subscription — selling another
  // would double-bill; the fix is the card form or resume on Paddle's portal.
  // Only evaluation (no row) and CANCELED (the old subscription is over,
  // and the webhook's mismatch guard accepts a new id after a cancel) may
  // start a checkout.
  const subscriptionStatus = await getSubscriptionStatus(db, params.organizationId);
  if (subscriptionStatus === 'ACTIVE') {
    throw new ApiError(
      409,
      'SUBSCRIPTION_ALREADY_ACTIVE',
      'This organization already has an active subscription. Create the deployment directly.',
    );
  }
  if (subscriptionStatus === 'PAST_DUE' || subscriptionStatus === 'PAUSED') {
    throw new ApiError(
      409,
      'SUBSCRIPTION_NEEDS_ATTENTION',
      subscriptionStatus === 'PAST_DUE'
        ? 'Your last payment did not go through. Update your payment details to continue.'
        : 'Your subscription is paused. Resume it to continue.',
      { subscriptionStatus },
    );
  }

  const parksDeployment =
    params.applicationId !== undefined || params.customerId !== undefined || params.region !== undefined;
  if (parksDeployment) {
    const { applicationId, customerId, region } = params;
    // All-or-none: a parked deployment request needs every parameter.
    if (applicationId === undefined || customerId === undefined || region === undefined) {
      throw new ApiError(
        422,
        'VALIDATION_ERROR',
        'A checkout that parks a deployment needs an application, a customer, and a region.',
      );
    }
    const application = await loadOwnedApplication(db, applicationId, params.organizationId);
    await loadOwnedCustomer(db, customerId, params.organizationId);
    resolveSizeSelection(application, params.sizeProfile);
    const { result } = await runApplicationPreflight(db, application, customerId);
    requirePreflightReady(result);
    if (!(await newestDeployableRelease(db, applicationId))) throw releaseRequiredError();
  }

  // One checkout at a time per organization: without this lock two
  // simultaneous calls (a double click) both see no transaction on the intent
  // and each opens a Paddle transaction, and the vendor can pay for both.
  const created = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'billing-checkout:' + params.organizationId}))`);
    const startedAt = now();
    await expireStalePendingIntents(tx, params.organizationId, startedAt);

    const [existing] = await tx
      .select()
      .from(schema.billingCheckoutIntents)
      .where(
        and(
          eq(schema.billingCheckoutIntents.organizationId, params.organizationId),
          eq(schema.billingCheckoutIntents.status, 'PENDING'),
        ),
      )
      .limit(1);

    const request = {
      applicationId: params.applicationId ?? null,
      customerId: params.customerId ?? null,
      region: params.region ?? null,
      sizeProfile: params.sizeProfile ?? null,
      createdBy: params.createdBy,
    };
    let intent: typeof schema.billingCheckoutIntents.$inferSelect;
    if (existing) {
      const [updated] = await tx
        .update(schema.billingCheckoutIntents)
        .set(request)
        .where(eq(schema.billingCheckoutIntents.id, existing.id))
        .returning();
      intent = updated!;
    } else {
      const [inserted] = await tx
        .insert(schema.billingCheckoutIntents)
        .values({ organizationId: params.organizationId, ...request })
        .returning();
      intent = inserted!;
    }

    if (intent.providerTransactionId) {
      return { checkoutIntentId: intent.id, transactionId: intent.providerTransactionId };
    }

    // The intent id travels in customData so the webhook can attribute the
    // subscription to this organization — and to this exact parked request —
    // before any subscription row exists. Hence the row must exist first; a
    // Paddle failure leaves it PENDING with no transaction, and the next call
    // reuses the row and retries.
    let transactionId: string;
    try {
      const transaction = await paddle.client.transactions.create({
        items: [{ priceId: paddle.config.pricePlatform, quantity: 1 }],
        customData: { organizationId: params.organizationId, checkoutIntentId: intent.id },
      });
      transactionId = transaction.id;
    } catch (error) {
      // Phase 16 finding: the provider's reason was swallowed entirely, which
      // turned a malformed API key into an undiagnosable 502. Logged server-side
      // only — the client never sees provider internals.
      console.error(
        JSON.stringify({
          event: 'billing:checkout-transaction-failed',
          organizationId: params.organizationId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      // Returned, not thrown: the PENDING intent must commit.
      return null;
    }

    await tx
      .update(schema.billingCheckoutIntents)
      .set({ providerTransactionId: transactionId })
      .where(eq(schema.billingCheckoutIntents.id, intent.id));

    return { checkoutIntentId: intent.id, transactionId };
  });
  if (!created) {
    throw new ApiError(502, 'CHECKOUT_UNAVAILABLE', 'Could not start checkout. Try again.');
  }
  return created;
}

export interface CompletedCheckoutIntent {
  checkoutIntentId: string;
  status: 'COMPLETED' | 'FAILED';
  deploymentId?: string;
  // Internal-only fields used by the DEPLOY-027 materialization hook — never
  // surfaced to callers, kept optional so the public shape is unchanged.
  applicationId?: string;
  customerId?: string;
  error?: string;
}

/**
 * Creates the deployment for the intent an activated subscription paid for.
 * The event names the intent through Deployz's own `customData`, which Paddle
 * copies from the checkout transaction onto the subscription; without one,
 * the organization's single PENDING intent is used.
 *
 * The deployment insert and the intent's completion run in ONE transaction
 * guarded by `WHERE status = 'PENDING'`, so a redelivered webhook — or two
 * ACTIVE events racing — can never create the deployment twice.
 *
 * Never throws: this runs inside the webhook path, and a failure to create
 * the deployment must not make Paddle redeliver a subscription event that was
 * applied correctly. A failed intent is recorded FAILED with its reason — the
 * subscription is real, so the vendor now passes the Phase 7 gate and can
 * create the deployment directly.
 */
export async function completePendingCheckoutIntent(
  deps: CheckoutDeps,
  organizationId: string,
  checkoutIntentId: string | undefined,
): Promise<CompletedCheckoutIntent | null> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  let intentId: string | undefined;
  try {
    const completed: CompletedCheckoutIntent | null = await db.transaction(async (tx) => {
      const [intent] = await tx
        .select()
        .from(schema.billingCheckoutIntents)
        .where(
          and(
            eq(schema.billingCheckoutIntents.organizationId, organizationId),
            eq(schema.billingCheckoutIntents.status, 'PENDING'),
            ...(checkoutIntentId ? [eq(schema.billingCheckoutIntents.id, checkoutIntentId)] : []),
          ),
        )
        .limit(1);
      // An ACTIVE subscription with nothing parked on it — a resubscribe, or
      // an intent another delivery already completed.
      if (!intent) return null;
      intentId = intent.id;

      // A parked deployment request completes by creating that deployment; a
      // subscribe-only intent (invitation-first flow) parks nothing, so
      // activation just starts the subscription.
      if (intent.applicationId === null || intent.customerId === null || intent.region === null) {
        const resolvedAt = now();
        await tx
          .update(schema.billingCheckoutIntents)
          .set({ status: 'COMPLETED', resolvedAt })
          .where(
            and(
              eq(schema.billingCheckoutIntents.id, intent.id),
              eq(schema.billingCheckoutIntents.status, 'PENDING'),
            ),
          );
        await recordEvent(tx, {
          organizationId,
          eventType: 'billing.subscription_activated',
          actorType: 'system',
          actorId: 'billing-webhook',
          payload: { schemaVersion: 1, checkoutIntentId: intent.id },
        });
        return { checkoutIntentId: intent.id, status: 'COMPLETED' as const };
      }

      const { deployment } = await createDeploymentRecord(
        tx,
        {
          organizationId,
          applicationId: intent.applicationId,
          customerId: intent.customerId,
          region: intent.region,
          ...(intent.sizeProfile !== null ? { sizeProfile: intent.sizeProfile } : {}),
          deploymentType: 'PRODUCTION',
          createdBy: intent.createdBy,
          updatedBy: intent.createdBy,
          source: 'manual',
        },
        deps.templatePublisher ? { templatePublisher: deps.templatePublisher } : undefined,
      );
      const resolvedAt = now();
      await tx
        .update(schema.billingCheckoutIntents)
        .set({ status: 'COMPLETED', deploymentId: deployment.id, resolvedAt })
        .where(
          and(
            eq(schema.billingCheckoutIntents.id, intent.id),
            eq(schema.billingCheckoutIntents.status, 'PENDING'),
          ),
        );
      await recordEvent(tx, {
        organizationId,
        eventType: 'billing.subscription_activated',
        actorType: 'system',
        actorId: 'billing-webhook',
        deploymentId: deployment.id,
        customerId: intent.customerId,
        payload: { schemaVersion: 1, checkoutIntentId: intent.id, deploymentId: deployment.id },
      });
      return { checkoutIntentId: intent.id, status: 'COMPLETED' as const, deploymentId: deployment.id, applicationId: intent.applicationId, customerId: intent.customerId };
    });
    // DEPLOY-027 (Phase 4): materialization runs OUTSIDE the tx so the
    // pending-secrets drizzle queries do not contend with the connection
    // the tx holds.
    if (completed !== null && completed.deploymentId !== undefined && deps.materialization !== undefined) {
      await materializePendingSecretsForDeployment(deps.materialization, {
        organizationId,
        id: completed.deploymentId,
        applicationId: completed.applicationId!,
        customerId: completed.customerId!,
      });
    }
    return completed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!intentId) return null;
    // Outside the rolled-back transaction, so the reason survives.
    await db
      .update(schema.billingCheckoutIntents)
      .set({ status: 'FAILED', error: message, resolvedAt: now() })
      .where(eq(schema.billingCheckoutIntents.id, intentId));
    return { checkoutIntentId: intentId, status: 'FAILED', error: message };
  }
}
