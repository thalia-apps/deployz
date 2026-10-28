import { PGlite } from '@electric-sql/pglite';
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import { createPaddle, type PaddleBilling } from './paddle.js';
import { buildServer } from './server.js';

// ── Fixtures ─────────────────────────────────────────────────────────────
//
// Obvious fixture values only (sub_test_1, ctm_test_1, evt_test_1, ...) —
// never anything that looks like a real Paddle id.

const WEBHOOK_SECRET = 'whsec_test_1';

function buildPaddle(): PaddleBilling {
  const billing = createPaddle({
    paddleApiKey: 'test_replace_me',
    paddleWebhookSecret: WEBHOOK_SECRET,
    paddleClientToken: 'pdl_sdbx_replace_me',
    paddlePricePlatform: 'pri_platform_replace_me',
    paddlePriceDeployment: 'pri_deployment_replace_me',
    paddleEnvironment: 'sandbox',
  });
  if (!billing) throw new Error('createPaddle unexpectedly returned null in the test fixture');
  return billing;
}

/** Signs a webhook body the way Paddle does: `ts=<ts>;h1=<hmac-sha256(secret, "ts:body")>`. */
function signedWebhook(
  secret: string,
  event: Record<string, unknown>,
  tsOverride?: number,
): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(event);
  const ts = tsOverride ?? Math.floor(Date.now() / 1000);
  const h1 = createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex');
  return {
    body,
    headers: {
      'paddle-signature': `ts=${ts};h1=${h1}`,
      'content-type': 'application/json',
    },
  };
}

interface SubscriptionEventOptions {
  eventId: string;
  eventType: string;
  occurredAt: string;
  organizationId?: string;
  checkoutIntentId?: string;
  transactionId?: string;
  subscriptionId?: string;
  status: string;
  customerId?: string;
  currentBillingPeriod?: { starts_at: string; ends_at: string } | null;
  scheduledChange?: { action: string; effective_at: string } | null;
  itemPriceIds?: string[];
}

/** Paddle's wire shape (snake_case) for a subscription.* notification. */
function subscriptionEvent(options: SubscriptionEventOptions): Record<string, unknown> {
  return {
    event_id: options.eventId,
    event_type: options.eventType,
    occurred_at: options.occurredAt,
    notification_id: `ntf_${options.eventId}`,
    data: {
      id: options.subscriptionId ?? 'sub_test_1',
      transaction_id: options.transactionId,
      status: options.status,
      customer_id: options.customerId ?? 'ctm_test_1',
      address_id: 'add_test_1',
      currency_code: 'USD',
      created_at: options.occurredAt,
      updated_at: options.occurredAt,
      collection_mode: 'automatic',
      billing_cycle: { interval: 'month', frequency: 1 },
      current_billing_period:
        options.currentBillingPeriod === undefined
          ? { starts_at: '2026-01-01T00:00:00Z', ends_at: '2026-02-01T00:00:00Z' }
          : options.currentBillingPeriod,
      scheduled_change: options.scheduledChange ?? null,
      items: (options.itemPriceIds ?? ['pri_platform_replace_me']).map((priceId) => ({
        status: 'active',
        quantity: 1,
        recurring: true,
        created_at: options.occurredAt,
        updated_at: options.occurredAt,
        price: { id: priceId, product_id: 'pro_test_1', description: 'Test price', tax_mode: 'account_setting' },
      })),
      custom_data: options.organizationId
        ? { organizationId: options.organizationId, checkoutIntentId: options.checkoutIntentId }
        : null,
    },
  };
}

interface TransactionEventOptions {
  eventId: string;
  eventType: string;
  occurredAt: string;
  organizationId?: string;
  subscriptionId?: string | null;
}

/** Paddle's wire shape (snake_case) for a transaction.* notification. */
function transactionEvent(options: TransactionEventOptions): Record<string, unknown> {
  return {
    event_id: options.eventId,
    event_type: options.eventType,
    occurred_at: options.occurredAt,
    notification_id: `ntf_${options.eventId}`,
    data: {
      id: 'txn_test_1',
      status: 'completed',
      currency_code: 'USD',
      origin: 'web',
      collection_mode: 'automatic',
      subscription_id: options.subscriptionId ?? null,
      custom_data: options.organizationId ? { organizationId: options.organizationId } : null,
      items: [],
      payments: [],
      created_at: options.occurredAt,
      updated_at: options.occurredAt,
    },
  };
}

/** A minimal product.updated notification — an event Deployz never acts on. */
function productUpdatedEvent(options: {
  eventId: string;
  occurredAt: string;
  organizationId?: string;
}): Record<string, unknown> {
  return {
    event_id: options.eventId,
    event_type: 'product.updated',
    occurred_at: options.occurredAt,
    notification_id: `ntf_${options.eventId}`,
    data: {
      id: 'pro_test_1',
      name: 'Test Product',
      tax_category: 'standard',
      status: 'active',
      created_at: options.occurredAt,
      updated_at: options.occurredAt,
      custom_data: options.organizationId ? { organizationId: options.organizationId } : null,
    },
  };
}

async function signUpAndGetOrg(
  auth: Auth,
  db: Db,
  email: string,
): Promise<{ userId: string; organizationId: string; cookie: string }> {
  const password = crypto.randomUUID();
  const signup = await auth.api.signUpEmail({ body: { email, password, name: email.split('@')[0]! } });
  const signin = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const setCookie = signin.headers.get('set-cookie');
  if (!setCookie) throw new Error('sign-in did not set a session cookie');
  const memberships = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, signup.user.id))
    .limit(1);
  const organizationId = memberships[0]?.organizationId;
  if (!organizationId) throw new Error('signup did not provision an organization');
  return { userId: signup.user.id, organizationId, cookie: setCookie };
}

async function getSubscriptionRow(db: Db, organizationId: string) {
  const [row] = await db
    .select()
    .from(schema.billingSubscriptions)
    .where(eq(schema.billingSubscriptions.organizationId, organizationId))
    .limit(1);
  return row ?? null;
}

async function getEventRow(db: Db, eventId: string) {
  const [row] = await db
    .select()
    .from(schema.billingProviderEvents)
    .where(eq(schema.billingProviderEvents.providerEventId, eventId))
    .limit(1);
  return row ?? null;
}

/** The webhook binds a new subscription to an organization only through that
 *  organization's PENDING checkout intent; this parks a fresh one (replacing any
 *  earlier intent) and returns its id for the event's customData. */
async function seedPendingIntent(db: Db, organizationId: string, providerTransactionId?: string): Promise<string> {
  await db.delete(schema.billingCheckoutIntents).where(eq(schema.billingCheckoutIntents.organizationId, organizationId));
  const [intent] = await db
    .insert(schema.billingCheckoutIntents)
    .values({ organizationId, providerTransactionId })
    .returning();
  return intent!.id;
}

let counter = 0;
function nextEmail(): string {
  counter += 1;
  return `webhook-org-${counter}-${crypto.randomUUID()}@example.com`;
}

describe('POST /api/billing/webhook (Paddle)', () => {
  let client: PGlite;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    app = await buildServer({ auth, db, paddle: buildPaddle() });
  });

  afterAll(async () => {
    await app.close();
    await client.close();
  });

  it('rejects a forged signature (wrong secret) with 401 and writes nothing', async () => {
    const org = await signUpAndGetOrg(auth, db, nextEmail());
    const event = subscriptionEvent({
      eventId: 'evt_test_1',
      eventType: 'subscription.created',
      occurredAt: new Date().toISOString(),
      organizationId: org.organizationId,
      checkoutIntentId: await seedPendingIntent(db, org.organizationId),
      status: 'active',
    });
    const { body, headers } = signedWebhook('whsec_wrong_secret', event);

    const response = await app.inject({ method: 'POST', url: '/api/billing/webhook', headers, payload: body });

    expect(response.statusCode).toBe(401);
    expect(await getEventRow(db, 'evt_test_1')).toBeNull();
    expect(await getSubscriptionRow(db, org.organizationId)).toBeNull();
  });

  it('rejects a missing Paddle-Signature header with 401', async () => {
    const org = await signUpAndGetOrg(auth, db, nextEmail());
    const event = subscriptionEvent({
      eventId: 'evt_test_2',
      eventType: 'subscription.created',
      occurredAt: new Date().toISOString(),
      organizationId: org.organizationId,
      checkoutIntentId: await seedPendingIntent(db, org.organizationId),
      status: 'active',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(event),
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects a stale timestamp (outside the 5s tolerance) with 401', async () => {
    const org = await signUpAndGetOrg(auth, db, nextEmail());
    const event = subscriptionEvent({
      eventId: 'evt_test_3',
      eventType: 'subscription.created',
      occurredAt: new Date().toISOString(),
      organizationId: org.organizationId,
      checkoutIntentId: await seedPendingIntent(db, org.organizationId),
      status: 'active',
    });
    const staleTs = Math.floor(Date.now() / 1000) - 600;
    const { body, headers } = signedWebhook(WEBHOOK_SECRET, event, staleTs);

    const response = await app.inject({ method: 'POST', url: '/api/billing/webhook', headers, payload: body });

    expect(response.statusCode).toBe(401);
    expect(await getEventRow(db, 'evt_test_3')).toBeNull();
  });

  it('applies subscription.created (active) — subscription row ACTIVE, event row PROCESSED', async () => {
    const org = await signUpAndGetOrg(auth, db, nextEmail());
    const occurredAt = new Date().toISOString();
    const event = subscriptionEvent({
      eventId: 'evt_test_4',
      eventType: 'subscription.created',
      occurredAt,
      organizationId: org.organizationId,
      checkoutIntentId: await seedPendingIntent(db, org.organizationId),
      subscriptionId: 'sub_test_1',
      customerId: 'ctm_test_1',
      status: 'active',
    });
    const { body, headers } = signedWebhook(WEBHOOK_SECRET, event);

    const response = await app.inject({ method: 'POST', url: '/api/billing/webhook', headers, payload: body });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ received: true, outcome: 'PROCESSED' });

    const row = await getSubscriptionRow(db, org.organizationId);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('ACTIVE');
    expect(row!.providerCustomerId).toBe('ctm_test_1');
    expect(row!.providerSubscriptionId).toBe('sub_test_1');
    expect(row!.currentPeriodStart?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(row!.currentPeriodEnd?.toISOString()).toBe('2026-02-01T00:00:00.000Z');

    const eventRow = await getEventRow(db, 'evt_test_4');
    expect(eventRow?.processingStatus).toBe('PROCESSED');
  });

  it('answers DUPLICATE on a second delivery of the same event id — exactly one event row, unchanged', async () => {
    const org = await signUpAndGetOrg(auth, db, nextEmail());
    const occurredAt = new Date().toISOString();
    const event = subscriptionEvent({
      eventId: 'evt_test_5',
      eventType: 'subscription.created',
      occurredAt,
      organizationId: org.organizationId,
      checkoutIntentId: await seedPendingIntent(db, org.organizationId),
      subscriptionId: 'sub_test_5',
      status: 'active',
    });
    const signed = signedWebhook(WEBHOOK_SECRET, event);

    const first = await app.inject({ method: 'POST', url: '/api/billing/webhook', headers: signed.headers, payload: signed.body });
    expect(first.statusCode).toBe(200);
    const rowAfterFirst = await getSubscriptionRow(db, org.organizationId);

    const second = await app.inject({ method: 'POST', url: '/api/billing/webhook', headers: signed.headers, payload: signed.body });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ received: true, outcome: 'DUPLICATE' });

    const rows = await db
      .select()
      .from(schema.billingProviderEvents)
      .where(eq(schema.billingProviderEvents.providerEventId, 'evt_test_5'));
    expect(rows).toHaveLength(1);

    const rowAfterSecond = await getSubscriptionRow(db, org.organizationId);
    expect(rowAfterSecond).toStrictEqual(rowAfterFirst);
  });

  it('ignores an out-of-order delivery as a stale event — status stays at the later value', async () => {
    const org = await signUpAndGetOrg(auth, db, nextEmail());
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const t10 = new Date('2026-01-01T00:00:10.000Z');
    const checkoutIntentId = await seedPendingIntent(db, org.organizationId);

    const later = subscriptionEvent({
      eventId: 'evt_test_6a',
      eventType: 'subscription.updated',
      occurredAt: t10.toISOString(),
      organizationId: org.organizationId,
      checkoutIntentId,
      subscriptionId: 'sub_test_6',
      status: 'past_due',
    });
    const laterSigned = signedWebhook(WEBHOOK_SECRET, later);
    const laterResponse = await app.inject({ method: 'POST', url: '/api/billing/webhook', headers: laterSigned.headers, payload: laterSigned.body });
    expect(laterResponse.statusCode).toBe(200);
    expect(laterResponse.json()).toMatchObject({ outcome: 'PROCESSED' });

    const earlier = subscriptionEvent({
      eventId: 'evt_test_6b',
      eventType: 'subscription.created',
      occurredAt: t0.toISOString(),
      organizationId: org.organizationId,
      checkoutIntentId,
      subscriptionId: 'sub_test_6',
      status: 'active',
    });
    const earlierSigned = signedWebhook(WEBHOOK_SECRET, earlier);
    const earlierResponse = await app.inject({ method: 'POST', url: '/api/billing/webhook', headers: earlierSigned.headers, payload: earlierSigned.body });
    expect(earlierResponse.statusCode).toBe(200);
    expect(earlierResponse.json()).toMatchObject({ outcome: 'IGNORED' });

    const row = await getSubscriptionRow(db, org.organizationId);
    expect(row!.status).toBe('PAST_DUE');

    const ignoredEventRow = await getEventRow(db, 'evt_test_6b');
    expect(ignoredEventRow?.processingStatus).toBe('IGNORED');
    expect(ignoredEventRow?.error).toBe('stale event');
  });

  it('maps paused / resumed / canceled / past_due through the status vocabulary', async () => {
    const org = await signUpAndGetOrg(auth, db, nextEmail());
    let t = new Date('2026-02-01T00:00:00.000Z').getTime();
    const checkoutIntentId = await seedPendingIntent(db, org.organizationId);
    const post = async (eventId: string, eventType: string, status: string) => {
      t += 1000;
      const event = subscriptionEvent({
        eventId,
        eventType,
        occurredAt: new Date(t).toISOString(),
        organizationId: org.organizationId,
        checkoutIntentId,
        subscriptionId: 'sub_test_7',
        status,
      });
      const signed = signedWebhook(WEBHOOK_SECRET, event);
      const response = await app.inject({ method: 'POST', url: '/api/billing/webhook', headers: signed.headers, payload: signed.body });
      expect(response.statusCode).toBe(200);
    };

    await post('evt_test_7a', 'subscription.created', 'active');
    await post('evt_test_7b', 'subscription.paused', 'paused');
    expect((await getSubscriptionRow(db, org.organizationId))!.status).toBe('PAUSED');

    await post('evt_test_7c', 'subscription.resumed', 'active');
    expect((await getSubscriptionRow(db, org.organizationId))!.status).toBe('ACTIVE');

    await post('evt_test_7d', 'subscription.past_due', 'past_due');
    expect((await getSubscriptionRow(db, org.organizationId))!.status).toBe('PAST_DUE');

    await post('evt_test_7e', 'subscription.canceled', 'canceled');
    expect((await getSubscriptionRow(db, org.organizationId))!.status).toBe('CANCELED');
  });

  it('records and clears a scheduled cancellation', async () => {
    const org = await signUpAndGetOrg(auth, db, nextEmail());
    const t0 = new Date('2026-03-01T00:00:00.000Z');
    const t1 = new Date('2026-03-02T00:00:00.000Z');
    const checkoutIntentId = await seedPendingIntent(db, org.organizationId);

    const scheduled = subscriptionEvent({
      eventId: 'evt_test_8a',
      eventType: 'subscription.updated',
      occurredAt: t0.toISOString(),
      organizationId: org.organizationId,
      checkoutIntentId,
      subscriptionId: 'sub_test_8',
      status: 'active',
      scheduledChange: { action: 'cancel', effective_at: '2026-04-01T00:00:00.000Z' },
    });
    const scheduledSigned = signedWebhook(WEBHOOK_SECRET, scheduled);
    const scheduledResponse = await app.inject({ method: 'POST', url: '/api/billing/webhook', headers: scheduledSigned.headers, payload: scheduledSigned.body });
    expect(scheduledResponse.statusCode).toBe(200);

    let row = await getSubscriptionRow(db, org.organizationId);
    expect(row!.status).toBe('ACTIVE');
    expect(row!.scheduledChangeAction).toBe('cancel');
    expect(row!.scheduledChangeAt?.toISOString()).toBe('2026-04-01T00:00:00.000Z');

    const cleared = subscriptionEvent({
      eventId: 'evt_test_8b',
      eventType: 'subscription.updated',
      occurredAt: t1.toISOString(),
      organizationId: org.organizationId,
      checkoutIntentId,
      subscriptionId: 'sub_test_8',
      status: 'active',
      scheduledChange: null,
    });
    const clearedSigned = signedWebhook(WEBHOOK_SECRET, cleared);
    const clearedResponse = await app.inject({ method: 'POST', url: '/api/billing/webhook', headers: clearedSigned.headers, payload: clearedSigned.body });
    expect(clearedResponse.statusCode).toBe(200);

    row = await getSubscriptionRow(db, org.organizationId);
    expect(row!.scheduledChangeAction).toBeNull();
    expect(row!.scheduledChangeAt).toBeNull();
  });

  it('ignores a second, different active subscription for the same organization as a mismatch', async () => {
    const org = await signUpAndGetOrg(auth, db, nextEmail());
    const first = subscriptionEvent({
      eventId: 'evt_test_9a',
      eventType: 'subscription.created',
      occurredAt: '2026-05-01T00:00:00.000Z',
      organizationId: org.organizationId,
      checkoutIntentId: await seedPendingIntent(db, org.organizationId),
      subscriptionId: 'sub_test_9',
      status: 'active',
    });
    const firstSigned = signedWebhook(WEBHOOK_SECRET, first);
    await app.inject({ method: 'POST', url: '/api/billing/webhook', headers: firstSigned.headers, payload: firstSigned.body });
    const rowAfterFirst = await getSubscriptionRow(db, org.organizationId);
    expect(rowAfterFirst!.status).toBe('ACTIVE');

    const second = subscriptionEvent({
      eventId: 'evt_test_9b',
      eventType: 'subscription.created',
      occurredAt: '2026-05-02T00:00:00.000Z',
      organizationId: org.organizationId,
      checkoutIntentId: await seedPendingIntent(db, org.organizationId),
      subscriptionId: 'sub_test_9b',
      status: 'active',
    });
    const secondSigned = signedWebhook(WEBHOOK_SECRET, second);
    const response = await app.inject({ method: 'POST', url: '/api/billing/webhook', headers: secondSigned.headers, payload: secondSigned.body });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ outcome: 'IGNORED' });

    const rowAfterSecond = await getSubscriptionRow(db, org.organizationId);
    expect(rowAfterSecond).toStrictEqual(rowAfterFirst);

    const eventRow = await getEventRow(db, 'evt_test_9b');
    expect(eventRow?.error).toBe('subscription mismatch');
  });

  it.each(['PAST_DUE', 'PAUSED'] as const)(
    'ignores a different active subscription id while the stored one is %s — only CANCELED may be replaced',
    async (status) => {
      const org = await signUpAndGetOrg(auth, db, nextEmail());
      const storedSubscriptionId = `sub_test_a_${status}`;
      await db.insert(schema.billingSubscriptions).values({
        organizationId: org.organizationId,
        providerCustomerId: 'ctm_test_1',
        providerSubscriptionId: storedSubscriptionId,
        status,
        lastProviderEventAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      const event = subscriptionEvent({
        eventId: `evt_mismatch_${status}`,
        eventType: 'subscription.activated',
        occurredAt: '2026-01-02T00:00:00.000Z',
        organizationId: org.organizationId,
        checkoutIntentId: await seedPendingIntent(db, org.organizationId),
        subscriptionId: `sub_test_b_${status}`,
        status: 'active',
      });
      const signed = signedWebhook(WEBHOOK_SECRET, event);
      const response = await app.inject({ method: 'POST', url: '/api/billing/webhook', headers: signed.headers, payload: signed.body });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ outcome: 'IGNORED' });

      const rows = await db
        .select()
        .from(schema.billingSubscriptions)
        .where(eq(schema.billingSubscriptions.organizationId, org.organizationId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.providerSubscriptionId).toBe(storedSubscriptionId);
      expect(rows[0]!.status).toBe(status);

      const eventRow = await getEventRow(db, `evt_mismatch_${status}`);
      expect(eventRow?.processingStatus).toBe('IGNORED');
      expect(eventRow?.error).toBe('subscription mismatch');
    },
  );

  it('a resubscription after CANCELED updates the one row in place to the new subscription id — never a second row', async () => {
    const org = await signUpAndGetOrg(auth, db, nextEmail());
    await db.insert(schema.billingSubscriptions).values({
      organizationId: org.organizationId,
      providerCustomerId: 'ctm_test_1',
      providerSubscriptionId: 'sub_test_old',
      status: 'CANCELED',
      lastProviderEventAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const event = subscriptionEvent({
      eventId: 'evt_resub_1',
      eventType: 'subscription.activated',
      occurredAt: '2026-01-02T00:00:00.000Z',
      organizationId: org.organizationId,
      checkoutIntentId: await seedPendingIntent(db, org.organizationId),
      subscriptionId: 'sub_test_new',
      status: 'active',
    });
    const signed = signedWebhook(WEBHOOK_SECRET, event);
    const response = await app.inject({ method: 'POST', url: '/api/billing/webhook', headers: signed.headers, payload: signed.body });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ outcome: 'PROCESSED' });

    const rows = await db
      .select()
      .from(schema.billingSubscriptions)
      .where(eq(schema.billingSubscriptions.organizationId, org.organizationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.providerSubscriptionId).toBe('sub_test_new');
    expect(rows[0]!.status).toBe('ACTIVE');
  });

  it('ignores an unknown event type but still records the event row', async () => {
    const org = await signUpAndGetOrg(auth, db, nextEmail());
    const event = productUpdatedEvent({
      eventId: 'evt_test_10',
      occurredAt: new Date().toISOString(),
      organizationId: org.organizationId,
    });
    const signed = signedWebhook(WEBHOOK_SECRET, event);

    const response = await app.inject({ method: 'POST', url: '/api/billing/webhook', headers: signed.headers, payload: signed.body });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ outcome: 'IGNORED' });

    const eventRow = await getEventRow(db, 'evt_test_10');
    expect(eventRow?.processingStatus).toBe('IGNORED');
    expect(eventRow?.error).toBeNull();
  });

  it('ignores an event whose organization cannot be resolved', async () => {
    const event = subscriptionEvent({
      eventId: 'evt_test_11',
      eventType: 'subscription.created',
      occurredAt: new Date().toISOString(),
      subscriptionId: 'sub_test_unresolvable',
      status: 'active',
      // No organizationId — no customData, and no billing_subscriptions row
      // anywhere has this providerSubscriptionId.
    });
    const signed = signedWebhook(WEBHOOK_SECRET, event);

    const response = await app.inject({ method: 'POST', url: '/api/billing/webhook', headers: signed.headers, payload: signed.body });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ outcome: 'IGNORED' });

    const eventRow = await getEventRow(db, 'evt_test_11');
    expect(eventRow?.error).toBe('organization not found');
    expect(eventRow?.organizationId).toBeNull();

    const rows = await db
      .select()
      .from(schema.billingSubscriptions)
      .where(eq(schema.billingSubscriptions.providerSubscriptionId, 'sub_test_unresolvable'));
    expect(rows).toHaveLength(0);
  });

  describe('binding a new subscription to the organization in customData', () => {
    async function send(event: Record<string, unknown>) {
      const signed = signedWebhook(WEBHOOK_SECRET, event);
      const response = await app.inject({ method: 'POST', url: '/api/billing/webhook', headers: signed.headers, payload: signed.body });
      expect(response.statusCode).toBe(200);
      return response.json() as { outcome: string };
    }

    it('ignores a subscription whose customData names an organization with no PENDING checkout intent', async () => {
      const victim = await signUpAndGetOrg(auth, db, nextEmail());

      const result = await send(
        subscriptionEvent({
          eventId: 'evt_bind_no_intent',
          eventType: 'subscription.created',
          occurredAt: new Date().toISOString(),
          organizationId: victim.organizationId,
          subscriptionId: 'sub_bind_no_intent',
          status: 'active',
        }),
      );

      expect(result.outcome).toBe('IGNORED');
      expect(await getSubscriptionRow(db, victim.organizationId)).toBeNull();
      expect((await getEventRow(db, 'evt_bind_no_intent'))?.error).toBe('organization not found');
    });

    it("ignores a subscription that names another organization's PENDING intent", async () => {
      const victim = await signUpAndGetOrg(auth, db, nextEmail());
      const attacker = await signUpAndGetOrg(auth, db, nextEmail());
      const attackerIntentId = await seedPendingIntent(db, attacker.organizationId);

      const result = await send(
        subscriptionEvent({
          eventId: 'evt_bind_other_org',
          eventType: 'subscription.activated',
          occurredAt: new Date().toISOString(),
          organizationId: victim.organizationId,
          checkoutIntentId: attackerIntentId,
          subscriptionId: 'sub_bind_other_org',
          status: 'active',
        }),
      );

      expect(result.outcome).toBe('IGNORED');
      expect(await getSubscriptionRow(db, victim.organizationId)).toBeNull();
    });

    it("ignores a subscription whose transaction is not the intent's transaction", async () => {
      const org = await signUpAndGetOrg(auth, db, nextEmail());
      const intentId = await seedPendingIntent(db, org.organizationId, 'txn_bind_expected');

      const result = await send(
        subscriptionEvent({
          eventId: 'evt_bind_wrong_txn',
          eventType: 'subscription.created',
          occurredAt: new Date().toISOString(),
          organizationId: org.organizationId,
          checkoutIntentId: intentId,
          transactionId: 'txn_bind_other',
          subscriptionId: 'sub_bind_wrong_txn',
          status: 'active',
        }),
      );

      expect(result.outcome).toBe('IGNORED');
      expect(await getSubscriptionRow(db, org.organizationId)).toBeNull();
    });

    it.each(['subscription.activated', 'subscription.updated'])(
      "ignores a %s event without the platform price, which carries no transaction id to check",
      async (eventType) => {
        const org = await signUpAndGetOrg(auth, db, nextEmail());
        const intentId = await seedPendingIntent(db, org.organizationId, `txn_bind_${eventType}`);

        const result = await send(
          subscriptionEvent({
            eventId: `evt_bind_no_platform_${eventType}`,
            eventType,
            occurredAt: new Date().toISOString(),
            organizationId: org.organizationId,
            checkoutIntentId: intentId,
            subscriptionId: `sub_bind_no_platform_${eventType}`,
            status: 'active',
            itemPriceIds: ['pri_deployment_replace_me'],
          }),
        );

        expect(result.outcome).toBe('IGNORED');
        expect(await getSubscriptionRow(db, org.organizationId)).toBeNull();
      },
    );

    it("binds a subscription whose transaction is the PENDING intent's transaction", async () => {
      const org = await signUpAndGetOrg(auth, db, nextEmail());
      const intentId = await seedPendingIntent(db, org.organizationId, 'txn_bind_ok');

      const result = await send(
        subscriptionEvent({
          eventId: 'evt_bind_ok',
          eventType: 'subscription.created',
          occurredAt: new Date().toISOString(),
          organizationId: org.organizationId,
          checkoutIntentId: intentId,
          transactionId: 'txn_bind_ok',
          subscriptionId: 'sub_bind_ok',
          status: 'active',
        }),
      );

      expect(result.outcome).toBe('PROCESSED');
      expect((await getSubscriptionRow(db, org.organizationId))?.providerSubscriptionId).toBe('sub_bind_ok');
    });

    it.each(['subscription.updated', 'subscription.canceled', 'subscription.past_due'])(
      'ignores a %s event whose customData names an organization with no PENDING intent',
      async (eventType) => {
        const victim = await signUpAndGetOrg(auth, db, nextEmail());

        const result = await send(
          subscriptionEvent({
            eventId: `evt_bind_later_${eventType}`,
            eventType,
            occurredAt: new Date().toISOString(),
            organizationId: victim.organizationId,
            subscriptionId: `sub_bind_later_${eventType}`,
            status: 'active',
          }),
        );

        expect(result.outcome).toBe('IGNORED');
        expect(await getSubscriptionRow(db, victim.organizationId)).toBeNull();
      },
    );

    it('follows the organization on file, not customData, for a known subscription', async () => {
      const owner = await signUpAndGetOrg(auth, db, nextEmail());
      const victim = await signUpAndGetOrg(auth, db, nextEmail());
      await send(
        subscriptionEvent({
          eventId: 'evt_on_file_created',
          eventType: 'subscription.created',
          occurredAt: '2026-06-01T00:00:00.000Z',
          organizationId: owner.organizationId,
          checkoutIntentId: await seedPendingIntent(db, owner.organizationId),
          subscriptionId: 'sub_on_file',
          status: 'active',
        }),
      );

      const result = await send(
        subscriptionEvent({
          eventId: 'evt_on_file_updated',
          eventType: 'subscription.updated',
          occurredAt: '2026-06-02T00:00:00.000Z',
          organizationId: victim.organizationId,
          subscriptionId: 'sub_on_file',
          status: 'past_due',
        }),
      );

      expect(result.outcome).toBe('PROCESSED');
      expect(await getSubscriptionRow(db, victim.organizationId)).toBeNull();
      expect((await getSubscriptionRow(db, owner.organizationId))?.status).toBe('PAST_DUE');
    });
  });

  it('touches lastProviderEventAt on transaction.completed for a known subscription, status unchanged', async () => {
    const org = await signUpAndGetOrg(auth, db, nextEmail());
    const created = subscriptionEvent({
      eventId: 'evt_test_12a',
      eventType: 'subscription.created',
      occurredAt: '2026-06-01T00:00:00.000Z',
      organizationId: org.organizationId,
      checkoutIntentId: await seedPendingIntent(db, org.organizationId),
      subscriptionId: 'sub_test_12',
      status: 'active',
    });
    const createdSigned = signedWebhook(WEBHOOK_SECRET, created);
    await app.inject({ method: 'POST', url: '/api/billing/webhook', headers: createdSigned.headers, payload: createdSigned.body });
    const rowAfterCreate = await getSubscriptionRow(db, org.organizationId);

    const transaction = transactionEvent({
      eventId: 'evt_test_12b',
      eventType: 'transaction.completed',
      occurredAt: '2026-06-02T00:00:00.000Z',
      organizationId: org.organizationId,
      subscriptionId: 'sub_test_12',
    });
    const transactionSigned = signedWebhook(WEBHOOK_SECRET, transaction);
    const response = await app.inject({ method: 'POST', url: '/api/billing/webhook', headers: transactionSigned.headers, payload: transactionSigned.body });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ outcome: 'PROCESSED' });

    const rowAfterTransaction = await getSubscriptionRow(db, org.organizationId);
    expect(rowAfterTransaction!.status).toBe(rowAfterCreate!.status);
    expect(rowAfterTransaction!.lastProviderEventAt!.toISOString()).toBe('2026-06-02T00:00:00.000Z');
    expect(rowAfterTransaction!.lastProviderEventAt!.getTime()).toBeGreaterThan(
      rowAfterCreate!.lastProviderEventAt!.getTime(),
    );
  });

  it('a delayed transaction event never moves the stale-event watermark backwards', async () => {
    const org = await signUpAndGetOrg(auth, db, nextEmail());
    const send = async (event: Record<string, unknown>) => {
      const signed = signedWebhook(WEBHOOK_SECRET, event);
      const response = await app.inject({ method: 'POST', url: '/api/billing/webhook', headers: signed.headers, payload: signed.body });
      expect(response.statusCode).toBe(200);
      return response.json() as { outcome: string };
    };
    await send(
      subscriptionEvent({
        eventId: 'evt_wm_1',
        eventType: 'subscription.created',
        occurredAt: '2026-06-01T00:00:10.000Z',
        organizationId: org.organizationId,
        checkoutIntentId: await seedPendingIntent(db, org.organizationId),
        subscriptionId: 'sub_wm',
        status: 'past_due',
      }),
    );

    await send(
      transactionEvent({
        eventId: 'evt_wm_2',
        eventType: 'transaction.payment_failed',
        occurredAt: '2026-06-01T00:00:05.000Z',
        organizationId: org.organizationId,
        subscriptionId: 'sub_wm',
      }),
    );
    const late = await send(
      subscriptionEvent({
        eventId: 'evt_wm_3',
        eventType: 'subscription.activated',
        occurredAt: '2026-06-01T00:00:07.000Z',
        organizationId: org.organizationId,
        subscriptionId: 'sub_wm',
        status: 'active',
      }),
    );

    expect(late.outcome).toBe('IGNORED');
    const row = await getSubscriptionRow(db, org.organizationId);
    expect(row!.status).toBe('PAST_DUE');
    expect(row!.lastProviderEventAt!.toISOString()).toBe('2026-06-01T00:00:10.000Z');
  });

  it('reflects the new subscription status through GET /api/organization', async () => {
    const org = await signUpAndGetOrg(auth, db, nextEmail());
    const event = subscriptionEvent({
      eventId: 'evt_test_13',
      eventType: 'subscription.created',
      occurredAt: new Date().toISOString(),
      organizationId: org.organizationId,
      checkoutIntentId: await seedPendingIntent(db, org.organizationId),
      subscriptionId: 'sub_test_13',
      status: 'active',
    });
    const signed = signedWebhook(WEBHOOK_SECRET, event);
    const webhookResponse = await app.inject({ method: 'POST', url: '/api/billing/webhook', headers: signed.headers, payload: signed.body });
    expect(webhookResponse.statusCode).toBe(200);

    const orgResponse = await app.inject({
      method: 'GET',
      url: '/api/organization',
      headers: { cookie: org.cookie },
    });
    expect(orgResponse.statusCode).toBe(200);
    expect(orgResponse.json()).toMatchObject({ subscriptionStatus: 'ACTIVE' });
  });

  it('answers 503 when Paddle is not configured', async () => {
    const disabledApp = await buildServer({ auth, db, paddle: null });
    try {
      const event = subscriptionEvent({
        eventId: 'evt_test_14',
        eventType: 'subscription.created',
        occurredAt: new Date().toISOString(),
        status: 'active',
      });
      const signed = signedWebhook(WEBHOOK_SECRET, event);

      const response = await disabledApp.inject({
        method: 'POST',
        url: '/api/billing/webhook',
        headers: signed.headers,
        payload: signed.body,
      });

      expect(response.statusCode).toBe(503);
      expect(await getEventRow(db, 'evt_test_14')).toBeNull();
    } finally {
      await disabledApp.close();
    }
  });
});
