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
import type { PolarBilling } from './polar.js';
import { requirePreflightReady, runApplicationPreflight } from './preflight.js';

// First production activation. A vendor with no subscription asks for a
// customer deployment: nothing is provisioned, no deployment row is written
// and no install link exists. The request is parked as a
// billing_checkout_intents row tied to a Polar checkout, and the vendor pays
// on Polar's hosted checkout page. When the subscription activates, the
// webhook completes the intent and only then does the deployment row appear.
//
// The checkout is for ONE unit: the subscription always bills at least one
// customer deployment ($49 + $19 = $68). The parked deployment uses that
// unit when it goes live; reconciliation (billing-reconcile.ts) raises the
// unit count only when more deployments are live than the floor covers.

/** A parked request older than this is stale: its checkout has expired, and
 *  the vendor's intent has plainly moved on. */
const CHECKOUT_INTENT_EXPIRY_MS = 24 * 60 * 60 * 1000;

export interface CheckoutDeps {
  db: RuntimeDb;
  polar: PolarBilling | null;
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
  /** Prefilled on Polar's checkout; the vendor can change it there. */
  customerEmail: string | null;
  /** Where Polar sends the vendor after paying (server-built, same origin). */
  successUrl: string;
}

export interface CreatedCheckoutIntent {
  checkoutIntentId: string;
  /** Polar's hosted checkout page; apps/web redirects the browser to it. */
  checkoutUrl: string;
}

/** Expires PENDING intents older than the window, so a checkout retried much
 *  later never resurrects a checkout Polar has long since expired. */
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
 * Parks a production deployment request and opens a Polar checkout for it. Everything that can be checked before the vendor pays is checked here
 * — organization ownership of the application and the customer, and the same
 * preflight and built-release gates createDeploymentRecord runs — so a
 * completed checkout does not land on a request that was never going to work.
 *
 * Pressing the button twice is safe: an organization has at most one PENDING
 * intent (partial unique index), so a second call updates that row with the
 * newest request and reuses its checkout while that is still open. Polar is
 * never asked for a second open checkout the vendor could also pay.
 */
export async function createCheckoutIntent(
  deps: CheckoutDeps,
  params: CreateCheckoutIntentParams,
): Promise<CreatedCheckoutIntent> {
  const { db, polar } = deps;
  const now = deps.now ?? (() => new Date());
  if (!polar) {
    throw new ApiError(503, 'BILLING_DISABLED', 'Polar billing is not configured');
  }

  // Phase 13: a checkout is the way IN to a subscription, so it is only
  // offered where there is none to fix. ACTIVE creates deployments directly
  // (the Phase 7 gate lets it through, so a second subscription must not be
  // sold). PAST_DUE and PAUSED already have a subscription — selling another
  // would double-bill; the fix is the card form or resume on Polar's portal.
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
  // simultaneous calls (a double click) both see no checkout on the intent
  // and each opens a Polar checkout, and the vendor can pay for both.
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

    // A checkout that is still open is reused. One already paid is waiting
    // for its webhook: opening another would sell a second subscription.
    // An expired or failed one is replaced on the same intent.
    if (intent.providerTransactionId) {
      let previous;
      try {
        previous = await polar.client.getCheckout(intent.providerTransactionId);
      } catch (error) {
        logCheckoutFailure(params.organizationId, error);
        return null;
      }
      if (previous.status === 'confirmed' || previous.status === 'succeeded') {
        throw new ApiError(
          409,
          'CHECKOUT_ALREADY_PAID',
          'Your payment is being confirmed. Refresh this page in a moment.',
        );
      }
      if (previous.status === 'open' && new Date(previous.expires_at) > startedAt) {
        return { checkoutIntentId: intent.id, checkoutUrl: previous.url };
      }
    }

    // The checkout is created after the intent row, so the webhook can bind
    // the subscription to this exact parked request through the checkout id.
    // A Polar failure leaves the intent PENDING with no checkout, and the
    // next call reuses the row and retries.
    let checkout;
    try {
      checkout = await polar.client.createCheckout({
        productId: polar.config.productId,
        units: 1,
        externalCustomerId: params.organizationId,
        customerEmail: params.customerEmail,
        metadata: { organizationId: params.organizationId, checkoutIntentId: intent.id },
        successUrl: params.successUrl,
      });
    } catch (error) {
      logCheckoutFailure(params.organizationId, error);
      // Returned, not thrown: the PENDING intent must commit.
      return null;
    }

    await tx
      .update(schema.billingCheckoutIntents)
      .set({ providerTransactionId: checkout.id })
      .where(eq(schema.billingCheckoutIntents.id, intent.id));

    return { checkoutIntentId: intent.id, checkoutUrl: checkout.url };
  });
  if (!created) {
    throw new ApiError(502, 'CHECKOUT_UNAVAILABLE', 'Could not start checkout. Try again.');
  }
  return created;
}

// The provider's reason is logged server-side only — the client never sees
// provider internals.
function logCheckoutFailure(organizationId: string, error: unknown): void {
  console.error(
    JSON.stringify({
      event: 'billing:checkout-failed',
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
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
 * The webhook names the intent through the subscription's checkout id;
 * without one, the organization's single PENDING intent is used.
 *
 * The deployment insert and the intent's completion run in ONE transaction
 * guarded by `WHERE status = 'PENDING'`, so a redelivered webhook — or two
 * ACTIVE events racing — can never create the deployment twice.
 *
 * Never throws: this runs inside the webhook path, and a failure to create
 * the deployment must not make Polar redeliver a subscription event that was
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
