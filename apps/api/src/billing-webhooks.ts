import { eq } from 'drizzle-orm';

import type { BillingSubscriptionStatus } from '@deployz/contracts';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { ApiError } from './errors.js';
import {
  verifyPolarWebhook,
  type PolarBilling,
  type PolarOrder,
  type PolarSubscription,
  type WebhookHeaders,
} from './polar.js';

// Webhook verification, dedupe, ordering and subscription-state projection
// (docs/billing/polar-billing.md). Reuses the raw-body carve-out in server.ts
// (addContentTypeParser) for signature checks.

export interface WebhookDeps {
  db: RuntimeDb;
  polar: PolarBilling | null;
  now?: () => Date;
  // Fired after commit, once a subscription event was applied. server.ts
  // wires this to completePendingCheckoutIntent (billing-checkout.ts) and to
  // reconciliation. `checkoutIntentId` is the intent whose Polar checkout
  // created the subscription, so the wrong parked request is never resumed.
  onSubscriptionChanged?: (change: {
    organizationId: string;
    previousStatus: BillingSubscriptionStatus | null;
    status: BillingSubscriptionStatus;
    checkoutIntentId: string | undefined;
  }) => Promise<void>;
}

export type WebhookOutcome =
  | { outcome: 'PROCESSED' }
  | { outcome: 'DUPLICATE' }
  | { outcome: 'IGNORED' };

// Every subscription event carries the full subscription. The endpoint is
// subscribed to these and to REFUND_EVENT only
// (scripts/billing/polar-setup.mjs); anything else that arrives is recorded
// IGNORED.
const SUBSCRIPTION_EVENTS: ReadonlySet<string> = new Set([
  'subscription.created',
  'subscription.active',
  'subscription.updated',
  'subscription.canceled',
  'subscription.uncanceled',
  'subscription.past_due',
  'subscription.paused',
  'subscription.resumed',
  'subscription.revoked',
]);

// A refund (full or partial) of one order. It changes no subscription state:
// the subscription keeps running, and ending it is a separate cancellation in
// Polar, which arrives as subscription events. The delivery is recorded
// against the organization, so every refund is on file.
const REFUND_EVENT = 'order.refunded';

interface PolarEvent {
  type: string;
  timestamp: string;
  data: PolarSubscription | PolarOrder;
}

/** The organization whose subscription on file is `subscriptionId`. */
async function organizationForSubscription(
  tx: RuntimeDb,
  subscriptionId: string | null,
): Promise<string | undefined> {
  if (!subscriptionId) return undefined;
  const [row] = await tx
    .select({ organizationId: schema.billingSubscriptions.organizationId })
    .from(schema.billingSubscriptions)
    .where(eq(schema.billingSubscriptions.providerSubscriptionId, subscriptionId))
    .limit(1);
  return row?.organizationId;
}

/** The checkout intent whose Polar checkout created this subscription. */
async function intentForCheckout(
  tx: RuntimeDb,
  checkoutId: string | null,
): Promise<{ id: string; organizationId: string; status: string } | undefined> {
  if (!checkoutId) return undefined;
  const [intent] = await tx
    .select({
      id: schema.billingCheckoutIntents.id,
      organizationId: schema.billingCheckoutIntents.organizationId,
      status: schema.billingCheckoutIntents.status,
    })
    .from(schema.billingCheckoutIntents)
    .where(eq(schema.billingCheckoutIntents.providerTransactionId, checkoutId))
    .limit(1);
  return intent;
}

/**
 * Resolves the organization an event belongs to. A subscription already on
 * file always follows the organization on file. A subscription not yet on
 * file is bound only when its `checkout_id` is the checkout of an
 * organization's intent and it is for POLAR_PRODUCT_ID. Only Deployz creates
 * those checkouts (with its server token), so client-chosen metadata can
 * never bind a subscription to another organization. The intent's status
 * does not matter: a subscription the vendor paid for through Deployz's own
 * checkout is never dropped because the intent expired meanwhile. Only a
 * PENDING intent goes on to create its parked deployment.
 */
async function resolveOrganizationId(
  tx: RuntimeDb,
  data: PolarSubscription,
  productId: string,
  intent: { organizationId: string } | undefined,
): Promise<string | undefined> {
  const existing = await organizationForSubscription(tx, data.id);
  if (existing) return existing;
  if (intent && data.product_id === productId) return intent.organizationId;
  return undefined;
}

/** Polar's subscription status -> Deployz's. Exported for the matrix test;
 *  nothing outside this module calls it. `incomplete` is not a paid
 *  subscription yet, and unknown values map to undefined: the event is
 *  IGNORED — never guessed. */
export function mapSubscriptionStatus(status: string): BillingSubscriptionStatus | undefined {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'ACTIVE';
    case 'past_due':
    case 'unpaid':
      return 'PAST_DUE';
    case 'paused':
      return 'PAUSED';
    case 'canceled':
      return 'CANCELED';
    default:
      return undefined;
  }
}

type SubscriptionSnapshotResult =
  | { status: 'PROCESSED'; previousStatus: BillingSubscriptionStatus | null; newStatus: BillingSubscriptionStatus }
  | { status: 'IGNORED'; error?: string };

/**
 * Upserts `billing_subscriptions` from a subscription event. Two guards keep
 * out-of-order and cross-subscription deliveries from corrupting state:
 *
 * - Regression guard: an event older than what is already recorded
 *   (`lastProviderEventAt`) is ignored — deliveries are not ordered.
 * - Mismatch guard: a different subscription id than the one on file is only
 *   accepted when the stored subscription is CANCELED (a resubscribe creates
 *   a new subscription); otherwise it is rejected, which is what stops a
 *   second active subscription from overwriting the first.
 */
async function applySubscriptionSnapshot(
  tx: RuntimeDb,
  organizationId: string,
  data: PolarSubscription,
  occurredAt: Date,
): Promise<SubscriptionSnapshotResult> {
  const newStatus = mapSubscriptionStatus(data.status);
  if (!newStatus) {
    return { status: 'IGNORED' };
  }

  const [existing] = await tx
    .select()
    .from(schema.billingSubscriptions)
    .where(eq(schema.billingSubscriptions.organizationId, organizationId))
    .limit(1);

  if (existing) {
    if (existing.lastProviderEventAt && existing.lastProviderEventAt > occurredAt) {
      return { status: 'IGNORED', error: 'stale event' };
    }
    if (existing.providerSubscriptionId !== data.id && existing.status !== 'CANCELED') {
      return { status: 'IGNORED', error: 'subscription mismatch' };
    }
  }

  // A cancellation the vendor scheduled keeps the subscription active until
  // the period ends; it is shown, never enforced, before then.
  const scheduledCancel = data.cancel_at_period_end && newStatus !== 'CANCELED';
  const values = {
    organizationId,
    provider: 'POLAR' as const,
    providerCustomerId: data.customer_id,
    providerSubscriptionId: data.id,
    status: newStatus,
    currentPeriodStart: data.current_period_start ? new Date(data.current_period_start) : null,
    currentPeriodEnd: data.current_period_end ? new Date(data.current_period_end) : null,
    scheduledChangeAction: scheduledCancel ? 'cancel' : null,
    scheduledChangeAt: scheduledCancel ? new Date(data.ends_at ?? data.current_period_end) : null,
    lastProviderEventAt: occurredAt,
  };

  if (existing) {
    await tx
      .update(schema.billingSubscriptions)
      .set(values)
      .where(eq(schema.billingSubscriptions.organizationId, organizationId));
  } else {
    await tx.insert(schema.billingSubscriptions).values(values);
  }

  return { status: 'PROCESSED', previousStatus: existing?.status ?? null, newStatus };
}

async function markEvent(
  tx: RuntimeDb,
  eventRowId: string,
  processingStatus: 'PROCESSED' | 'IGNORED',
  processedAt: Date,
  organizationId: string | undefined,
  error?: string,
): Promise<void> {
  await tx
    .update(schema.billingProviderEvents)
    .set({
      processingStatus,
      processedAt,
      error: error ?? null,
      ...(organizationId ? { organizationId } : {}),
    })
    .where(eq(schema.billingProviderEvents.id, eventRowId));
}

/**
 * Verifies, dedupes and applies one Polar webhook delivery. Polar retries
 * every non-2xx response with the same `webhook-id` — only a 2xx marks
 * delivery, so a failed verification must never return one. Nothing is
 * written before verification succeeds.
 */
export async function handlePolarWebhook(
  deps: WebhookDeps,
  rawBody: string,
  headers: WebhookHeaders,
): Promise<WebhookOutcome> {
  const { db, polar } = deps;
  const now = deps.now ?? (() => new Date());

  if (!polar) {
    throw new ApiError(503, 'BILLING_DISABLED', 'Polar billing is not configured');
  }
  if (!headers.id || !headers.timestamp || !headers.signature) {
    throw new ApiError(401, 'WEBHOOK_SIGNATURE_MISSING', 'Missing webhook signature headers');
  }
  if (!verifyPolarWebhook(rawBody, headers, polar.config.webhookSecret, now().getTime() / 1000)) {
    throw new ApiError(401, 'WEBHOOK_SIGNATURE_INVALID', 'Webhook signature verification failed');
  }

  const event = JSON.parse(rawBody) as PolarEvent;
  const providerEventId = headers.id;
  const occurredAt = new Date(event.timestamp);

  // Dedupe at the database, not only in application code: the unique index
  // on providerEventId is the actual guarantee. A row that exists with
  // FAILED is retried — Polar only re-delivers when we did not 2xx, so a
  // FAILED row means our own earlier attempt crashed, not a duplicate. An
  // IGNORED row is evaluated again: an operator redelivers an event after
  // fixing what made it unattributable, and every check below is guarded.
  const [inserted] = await db
    .insert(schema.billingProviderEvents)
    .values({
      provider: 'POLAR',
      providerEventId,
      eventType: event.type,
      occurredAt,
      processingStatus: 'RECEIVED',
    })
    .onConflictDoNothing({ target: schema.billingProviderEvents.providerEventId })
    .returning();

  let eventRowId: string;
  if (inserted) {
    eventRowId = inserted.id;
  } else {
    const [existing] = await db
      .select()
      .from(schema.billingProviderEvents)
      .where(eq(schema.billingProviderEvents.providerEventId, providerEventId))
      .limit(1);
    if (!existing || (existing.processingStatus !== 'FAILED' && existing.processingStatus !== 'IGNORED')) {
      return { outcome: 'DUPLICATE' };
    }
    await db
      .update(schema.billingProviderEvents)
      .set({ processingStatus: 'RECEIVED', error: null })
      .where(eq(schema.billingProviderEvents.id, existing.id));
    eventRowId = existing.id;
  }

  let subscriptionChange:
    | {
        organizationId: string;
        previousStatus: BillingSubscriptionStatus | null;
        status: BillingSubscriptionStatus;
        checkoutIntentId: string | undefined;
      }
    | undefined;

  try {
    const outcome = await db.transaction(async (tx) => {
      if (event.type === REFUND_EVENT) {
        const order = event.data as PolarOrder;
        const organizationId = await organizationForSubscription(tx, order.subscription_id);
        if (!organizationId) {
          await markEvent(tx, eventRowId, 'IGNORED', now(), undefined, 'organization not found');
          return { outcome: 'IGNORED' } as const;
        }
        await markEvent(tx, eventRowId, 'PROCESSED', now(), organizationId);
        return { outcome: 'PROCESSED' } as const;
      }
      if (!SUBSCRIPTION_EVENTS.has(event.type)) {
        await markEvent(tx, eventRowId, 'IGNORED', now(), undefined);
        return { outcome: 'IGNORED' } as const;
      }

      const data = event.data as PolarSubscription;
      const intent = await intentForCheckout(tx, data.checkout_id);
      const organizationId = await resolveOrganizationId(tx, data, polar.config.productId, intent);
      if (!organizationId) {
        await markEvent(tx, eventRowId, 'IGNORED', now(), undefined, 'organization not found');
        return { outcome: 'IGNORED' } as const;
      }

      const result = await applySubscriptionSnapshot(tx, organizationId, data, occurredAt);
      await markEvent(
        tx,
        eventRowId,
        result.status,
        now(),
        organizationId,
        result.status === 'IGNORED' ? result.error : undefined,
      );
      if (result.status === 'PROCESSED') {
        subscriptionChange = {
          organizationId,
          previousStatus: result.previousStatus,
          status: result.newStatus,
          checkoutIntentId: intent?.organizationId === organizationId ? intent.id : undefined,
        };
      }
      return { outcome: result.status } as const;
    });

    if (subscriptionChange) {
      await deps.onSubscriptionChanged?.(subscriptionChange);
    }

    return outcome;
  } catch (error) {
    try {
      await db
        .update(schema.billingProviderEvents)
        .set({
          processingStatus: 'FAILED',
          error: error instanceof Error ? error.message : String(error),
        })
        .where(eq(schema.billingProviderEvents.id, eventRowId));
    } catch {
      // Best effort — the original error is what matters; rethrow it so the
      // route answers 500 and Polar retries.
    }
    throw error;
  }
}

/** Reads the three Standard Webhooks headers from a request. */
export function webhookHeaders(headers: Record<string, string | string[] | undefined>): WebhookHeaders {
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  return {
    id: first(headers['webhook-id']),
    timestamp: first(headers['webhook-timestamp']),
    signature: first(headers['webhook-signature']),
  };
}

