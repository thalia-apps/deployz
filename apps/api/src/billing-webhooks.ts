import { and, eq } from 'drizzle-orm';

import { EventName, type EventEntity } from '@paddle/paddle-node-sdk';

import type { BillingSubscriptionStatus } from '@deployz/contracts';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { ApiError } from './errors.js';
import type { PaddleBilling } from './paddle.js';

// Paddle migration Phase 6 — webhook verification, dedupe, ordering and
// subscription-state projection (docs/billing/paddle-billing.md). Reuses the
// raw-body carve-out in server.ts (addContentTypeParser) for signature checks.

export interface WebhookDeps {
  db: RuntimeDb;
  paddle: PaddleBilling | null;
  now?: () => Date;
  // Fired after commit, once a subscription's status actually changed.
  // Phase 8 wires this to completePendingCheckoutIntent (billing-checkout.ts);
  // Phase 9 will reconcile from here too. `checkoutIntentId` is Deployz's own
  // customData, which Paddle copies from the checkout transaction onto the
  // subscription it creates — it names the exact parked request that was paid
  // for, so the wrong one can never be resumed.
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

// The subscription lifecycle events that carry a full subscription snapshot.
// Every other subscription.* event (imported, trialing) is intentionally left
// unhandled — Deployz never imports subscriptions and does not act on trials.
const SUBSCRIPTION_SNAPSHOT_EVENTS: ReadonlySet<string> = new Set([
  EventName.SubscriptionCreated,
  EventName.SubscriptionActivated,
  EventName.SubscriptionUpdated,
  EventName.SubscriptionPastDue,
  EventName.SubscriptionPaused,
  EventName.SubscriptionResumed,
  EventName.SubscriptionCanceled,
]);

// Transaction events only ever touch lastProviderEventAt — the subscription
// events above are the authority for status.
const TRANSACTION_TOUCH_EVENTS: ReadonlySet<string> = new Set([
  EventName.TransactionCompleted,
  EventName.TransactionPaymentFailed,
]);

function organizationIdFromCustomData(customData: unknown): string | undefined {
  if (typeof customData !== 'object' || customData === null) return undefined;
  const organizationId = (customData as Record<string, unknown>).organizationId;
  return typeof organizationId === 'string' ? organizationId : undefined;
}

/** The checkout intent id Deployz set on the transaction's customData
 *  (billing-checkout.ts), copied by Paddle onto the subscription event. */
function checkoutIntentIdFromCustomData(customData: unknown): string | undefined {
  if (typeof customData !== 'object' || customData === null) return undefined;
  const checkoutIntentId = (customData as Record<string, unknown>).checkoutIntentId;
  return typeof checkoutIntentId === 'string' ? checkoutIntentId : undefined;
}

async function isPendingCheckoutOf(
  tx: RuntimeDb,
  organizationId: string,
  data: { customData?: unknown; transactionId?: string | null },
): Promise<boolean> {
  const checkoutIntentId = checkoutIntentIdFromCustomData(data.customData);
  if (!checkoutIntentId) return false;
  const [intent] = await tx
    .select({ providerTransactionId: schema.billingCheckoutIntents.providerTransactionId })
    .from(schema.billingCheckoutIntents)
    .where(
      and(
        eq(schema.billingCheckoutIntents.id, checkoutIntentId),
        eq(schema.billingCheckoutIntents.organizationId, organizationId),
        eq(schema.billingCheckoutIntents.status, 'PENDING'),
      ),
    )
    .limit(1);
  if (!intent) return false;
  return !data.transactionId || data.transactionId === intent.providerTransactionId;
}

/**
 * Resolves the organization an event belongs to: Deployz's own `customData`
 * first (set on the checkout transaction in Phase 8, copied by Paddle onto
 * the subscription), else the organization already on file for that
 * `providerSubscriptionId`. `data.id` is the subscription id for every
 * subscription.* event; for transaction.* events it is the transaction id, so
 * this fallback only ever resolves those through `customData`.
 *
 * A checkout can be opened in the browser with client-chosen `customData`, so
 * a subscription.created / activated event may bind a new subscription to an
 * organization only when its `customData` names that organization's PENDING
 * checkout intent (and, when the event carries one, that intent's transaction).
 */
async function resolveOrganizationId(
  tx: RuntimeDb,
  event: EventEntity,
): Promise<string | undefined> {
  const data = event.data as { id: string; customData?: unknown; transactionId?: string | null };
  const fromCustomData = organizationIdFromCustomData(data.customData);
  if (fromCustomData) {
    if (
      (event.eventType !== EventName.SubscriptionCreated &&
        event.eventType !== EventName.SubscriptionActivated) ||
      (await isPendingCheckoutOf(tx, fromCustomData, data))
    ) {
      return fromCustomData;
    }
  }

  const [existing] = await tx
    .select({ organizationId: schema.billingSubscriptions.organizationId })
    .from(schema.billingSubscriptions)
    .where(eq(schema.billingSubscriptions.providerSubscriptionId, data.id))
    .limit(1);
  return existing?.organizationId;
}

/** Paddle's subscription status -> Deployz's. Exported for the Phase 15
 *  matrix test; nothing outside this module calls it. Unknown values map to
 *  undefined and the event is IGNORED — never guessed. */
export function mapSubscriptionStatus(status: string): BillingSubscriptionStatus | undefined {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'ACTIVE';
    case 'past_due':
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
 * Upserts `billing_subscriptions` from a subscription.* event. Two guards
 * keep out-of-order and cross-subscription deliveries from corrupting state:
 *
 * - Regression guard: an event older than what is already recorded
 *   (`lastProviderEventAt`) is ignored — Paddle does not order deliveries.
 * - Mismatch guard: a different `providerSubscriptionId` than the one on
 *   file is only accepted when the stored subscription is CANCELED (a
 *   reactivation creates a new Paddle subscription); otherwise it is
 *   rejected, which is what stops a second active subscription from
 *   overwriting the first.
 */
async function applySubscriptionSnapshot(
  tx: RuntimeDb,
  organizationId: string,
  event: EventEntity,
  occurredAt: Date,
): Promise<SubscriptionSnapshotResult> {
  const data = event.data as {
    id: string;
    status: string;
    customerId: string;
    currentBillingPeriod?: { startsAt: string; endsAt: string } | null;
    scheduledChange?: { action: string; effectiveAt: string } | null;
  };
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

  const values = {
    organizationId,
    providerCustomerId: data.customerId,
    providerSubscriptionId: data.id,
    status: newStatus,
    currentPeriodStart: data.currentBillingPeriod?.startsAt
      ? new Date(data.currentBillingPeriod.startsAt)
      : null,
    currentPeriodEnd: data.currentBillingPeriod?.endsAt
      ? new Date(data.currentBillingPeriod.endsAt)
      : null,
    scheduledChangeAction: data.scheduledChange?.action ?? null,
    scheduledChangeAt: data.scheduledChange?.effectiveAt
      ? new Date(data.scheduledChange.effectiveAt)
      : null,
    lastProviderEventAt: occurredAt,
  };

  if (existing) {
    await tx
      .update(schema.billingSubscriptions)
      .set(values)
      .where(eq(schema.billingSubscriptions.organizationId, organizationId));
  } else {
    await tx.insert(schema.billingSubscriptions).values({ provider: 'PADDLE', ...values });
  }

  return { status: 'PROCESSED', previousStatus: existing?.status ?? null, newStatus };
}

/** Touches lastProviderEventAt for the subscription a transaction belongs to.
 *  Returns false (no-op) when the transaction names no known subscription —
 *  subscription events are the authority for status, this is bookkeeping only. */
async function touchTransactionSubscription(
  tx: RuntimeDb,
  event: EventEntity,
  occurredAt: Date,
): Promise<boolean> {
  const data = event.data as { subscriptionId?: string | null };
  if (!data.subscriptionId) return false;
  const updated = await tx
    .update(schema.billingSubscriptions)
    .set({ lastProviderEventAt: occurredAt })
    .where(eq(schema.billingSubscriptions.providerSubscriptionId, data.subscriptionId))
    .returning();
  return updated.length > 0;
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
 * Verifies, dedupes and applies one Paddle webhook delivery. Paddle retries
 * every non-2xx response for days with the same `event.eventId` — only a 2xx
 * marks delivery, so a failed verification must never return one. Nothing is
 * written before verification succeeds.
 */
export async function handlePaddleWebhook(
  deps: WebhookDeps,
  rawBody: string,
  signatureHeader: string | undefined,
): Promise<WebhookOutcome> {
  const { db, paddle } = deps;
  const now = deps.now ?? (() => new Date());

  if (!paddle) {
    throw new ApiError(503, 'BILLING_DISABLED', 'Paddle billing is not configured');
  }
  if (!signatureHeader) {
    throw new ApiError(401, 'WEBHOOK_SIGNATURE_MISSING', 'Missing Paddle-Signature header');
  }

  let event: EventEntity;
  try {
    event = await paddle.client.webhooks.unmarshal(rawBody, paddle.config.webhookSecret, signatureHeader);
  } catch {
    throw new ApiError(401, 'WEBHOOK_SIGNATURE_INVALID', 'Webhook signature verification failed');
  }

  const occurredAt = new Date(event.occurredAt);

  // Dedupe at the database, not only in application code: the unique index
  // on providerEventId is the actual guarantee. A row that exists with
  // FAILED is retried — Paddle only re-delivers when we did not 2xx, so a
  // FAILED row means our own earlier attempt crashed, not a duplicate.
  const [inserted] = await db
    .insert(schema.billingProviderEvents)
    .values({
      providerEventId: event.eventId,
      eventType: event.eventType,
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
      .where(eq(schema.billingProviderEvents.providerEventId, event.eventId))
      .limit(1);
    if (!existing || existing.processingStatus !== 'FAILED') {
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
      const organizationId = await resolveOrganizationId(tx, event);
      if (!organizationId) {
        await markEvent(tx, eventRowId, 'IGNORED', now(), undefined, 'organization not found');
        return { outcome: 'IGNORED' } as const;
      }

      if (SUBSCRIPTION_SNAPSHOT_EVENTS.has(event.eventType)) {
        const result = await applySubscriptionSnapshot(tx, organizationId, event, occurredAt);
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
            checkoutIntentId: checkoutIntentIdFromCustomData(
              (event.data as { customData?: unknown }).customData,
            ),
          };
        }
        return { outcome: result.status } as const;
      }

      if (TRANSACTION_TOUCH_EVENTS.has(event.eventType)) {
        const touched = await touchTransactionSubscription(tx, event, occurredAt);
        await markEvent(tx, eventRowId, touched ? 'PROCESSED' : 'IGNORED', now(), organizationId);
        return { outcome: touched ? 'PROCESSED' : 'IGNORED' } as const;
      }

      // Everything else is a known Paddle event Deployz does not act on.
      await markEvent(tx, eventRowId, 'IGNORED', now(), organizationId);
      return { outcome: 'IGNORED' } as const;
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
      // route answers 500 and Paddle retries.
    }
    throw error;
  }
}
