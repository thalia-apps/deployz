import { PGlite } from '@electric-sql/pglite';
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import { mapSubscriptionStatus } from './billing-webhooks.js';
import type { PolarBilling, PolarClient, PolarSubscription } from './polar.js';
import { buildServer } from './server.js';

// ── Fixtures ─────────────────────────────────────────────────────────────
//
// Obvious fixture values only (sub_test_1, cus_test_1, msg_test_1,
// chk_test_1, ...) — never anything that looks like a real Polar id.

const WEBHOOK_SECRET = 'polar_whs_test_1';
const PRODUCT_ID = 'product_replace_me';

/** A Polar double: no test ever reaches the Polar API. The ACTIVE path
 *  reconciles (Phase 9), so the two calls reconciliation makes are here;
 *  reconciliation itself is tested in billing-reconcile.test.ts. */
function buildPolar(): PolarBilling {
  return {
    client: {
      getSubscription: async (id: string) => ({ id, units: 1 }) as PolarSubscription,
      updateSubscriptionUnits: async (id: string, units: number) => ({ id, units }) as PolarSubscription,
    } as Partial<PolarClient> as PolarClient,
    config: {
      token: 'polar_oat_replace_me',
      webhookSecret: WEBHOOK_SECRET,
      productId: PRODUCT_ID,
      environment: 'sandbox',
    },
  };
}

/** Signs a delivery the way Polar does (Standard Webhooks): HMAC-SHA256 of
 *  `id.timestamp.body` keyed by the secret's bytes, sent as `v1,<base64>`. */
function signedWebhook(
  secret: string,
  webhookId: string,
  event: Record<string, unknown>,
  timestampOverride?: number,
): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(event);
  const timestamp = timestampOverride ?? Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(`${webhookId}.${timestamp}.${body}`)
    .digest('base64');
  return {
    body,
    headers: {
      'webhook-id': webhookId,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': `v1,${signature}`,
      'content-type': 'application/json',
    },
  };
}

interface SubscriptionEventOptions {
  type: string;
  timestamp: string;
  status: string;
  subscriptionId?: string;
  checkoutId?: string | null;
  productId?: string;
  customerId?: string;
  cancelAtPeriodEnd?: boolean;
  endsAt?: string | null;
  metadata?: Record<string, string>;
}

/** Polar's wire shape for a subscription.* delivery. */
function subscriptionEvent(options: SubscriptionEventOptions): Record<string, unknown> {
  return {
    type: options.type,
    timestamp: options.timestamp,
    data: {
      id: options.subscriptionId ?? 'sub_test_1',
      status: options.status,
      amount: 6800,
      currency: 'usd',
      current_period_start: '2026-01-01T00:00:00Z',
      current_period_end: '2026-02-01T00:00:00Z',
      cancel_at_period_end: options.cancelAtPeriodEnd ?? false,
      ends_at: options.endsAt ?? null,
      customer_id: options.customerId ?? 'cus_test_1',
      product_id: options.productId ?? PRODUCT_ID,
      checkout_id: options.checkoutId ?? null,
      units: 1,
      modified_at: options.timestamp,
      metadata: options.metadata ?? {},
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

async function getEventRow(db: Db, webhookId: string) {
  const [row] = await db
    .select()
    .from(schema.billingProviderEvents)
    .where(eq(schema.billingProviderEvents.providerEventId, webhookId))
    .limit(1);
  return row ?? null;
}

/** The webhook binds a new subscription to an organization only through the
 *  Polar checkout of that organization's PENDING checkout intent; this parks
 *  a fresh one (replacing any earlier intent) tied to `checkoutId`. */
async function seedPendingIntent(db: Db, organizationId: string, checkoutId: string): Promise<string> {
  await db.delete(schema.billingCheckoutIntents).where(eq(schema.billingCheckoutIntents.organizationId, organizationId));
  const [intent] = await db
    .insert(schema.billingCheckoutIntents)
    .values({ organizationId, providerTransactionId: checkoutId })
    .returning();
  return intent!.id;
}

let counter = 0;
function nextEmail(): string {
  counter += 1;
  return `webhook-org-${counter}-${crypto.randomUUID()}@example.com`;
}

describe('mapSubscriptionStatus', () => {
  it.each([
    ['active', 'ACTIVE'],
    ['trialing', 'ACTIVE'],
    ['past_due', 'PAST_DUE'],
    ['unpaid', 'PAST_DUE'],
    ['paused', 'PAUSED'],
    ['canceled', 'CANCELED'],
    ['incomplete', undefined],
    ['incomplete_expired', undefined],
    ['some_future_status', undefined],
  ])('maps %s to %s', (status, expected) => {
    expect(mapSubscriptionStatus(status)).toBe(expected);
  });
});

describe('POST /api/billing/webhook (Polar)', () => {
  let client: PGlite;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;

  async function post(headers: Record<string, string>, body: string) {
    return app.inject({ method: 'POST', url: '/api/billing/webhook', headers, payload: body });
  }

  async function send(webhookId: string, event: Record<string, unknown>) {
    const signed = signedWebhook(WEBHOOK_SECRET, webhookId, event);
    const response = await post(signed.headers, signed.body);
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as { received: boolean; outcome: string };
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    app = await buildServer({ auth, db, polar: buildPolar() });
  });

  afterAll(async () => {
    await app.close();
    await client.close();
  });

  it('rejects a forged signature (wrong secret) with 401 and writes nothing', async () => {
    const org = await signUpAndGetOrg(auth, db, nextEmail());
    await seedPendingIntent(db, org.organizationId, 'chk_forged');
    const event = subscriptionEvent({
      type: 'subscription.created',
      timestamp: new Date().toISOString(),
      checkoutId: 'chk_forged',
      status: 'active',
    });
    const { body, headers } = signedWebhook('polar_whs_wrong_secret', 'msg_test_1', event);

    const response = await post(headers, body);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'WEBHOOK_SIGNATURE_INVALID' } });
    expect(await getEventRow(db, 'msg_test_1')).toBeNull();
    expect(await getSubscriptionRow(db, org.organizationId)).toBeNull();
  });

  it.each(['webhook-id', 'webhook-timestamp', 'webhook-signature'])(
    'rejects a delivery without the %s header with 401 and writes nothing',
    async (header) => {
      const event = subscriptionEvent({
        type: 'subscription.created',
        timestamp: new Date().toISOString(),
        status: 'active',
      });
      const { body, headers } = signedWebhook(WEBHOOK_SECRET, `msg_missing_${header}`, event);
      delete headers[header];

      const response = await post(headers, body);

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'WEBHOOK_SIGNATURE_MISSING' } });
      expect(await getEventRow(db, `msg_missing_${header}`)).toBeNull();
    },
  );

  it('rejects a malformed signature header with 401', async () => {
    const event = subscriptionEvent({
      type: 'subscription.created',
      timestamp: new Date().toISOString(),
      status: 'active',
    });
    const { body, headers } = signedWebhook(WEBHOOK_SECRET, 'msg_malformed', event);

    const response = await post({ ...headers, 'webhook-signature': 'v1,bm90LWEtc2lnbmF0dXJl' }, body);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'WEBHOOK_SIGNATURE_INVALID' } });
    expect(await getEventRow(db, 'msg_malformed')).toBeNull();
  });

  it('rejects a signature made for another webhook id with 401', async () => {
    const event = subscriptionEvent({
      type: 'subscription.created',
      timestamp: new Date().toISOString(),
      status: 'active',
    });
    const { body, headers } = signedWebhook(WEBHOOK_SECRET, 'msg_signed_id', event);

    const response = await post({ ...headers, 'webhook-id': 'msg_other_id' }, body);

    expect(response.statusCode).toBe(401);
    expect(await getEventRow(db, 'msg_other_id')).toBeNull();
  });

  it('rejects a stale timestamp (outside the 300 s tolerance) with 401', async () => {
    const org = await signUpAndGetOrg(auth, db, nextEmail());
    await seedPendingIntent(db, org.organizationId, 'chk_stale');
    const event = subscriptionEvent({
      type: 'subscription.created',
      timestamp: new Date().toISOString(),
      checkoutId: 'chk_stale',
      status: 'active',
    });
    const staleTs = Math.floor(Date.now() / 1000) - 600;
    const { body, headers } = signedWebhook(WEBHOOK_SECRET, 'msg_test_3', event, staleTs);

    const response = await post(headers, body);

    expect(response.statusCode).toBe(401);
    expect(await getEventRow(db, 'msg_test_3')).toBeNull();
    expect(await getSubscriptionRow(db, org.organizationId)).toBeNull();
  });

  it('applies subscription.created (active) — subscription row ACTIVE, event row PROCESSED', async () => {
    const org = await signUpAndGetOrg(auth, db, nextEmail());
    await seedPendingIntent(db, org.organizationId, 'chk_test_4');

    const result = await send(
      'msg_test_4',
      subscriptionEvent({
        type: 'subscription.created',
        timestamp: new Date().toISOString(),
        checkoutId: 'chk_test_4',
        subscriptionId: 'sub_test_4',
        customerId: 'cus_test_4',
        status: 'active',
      }),
    );

    expect(result).toMatchObject({ received: true, outcome: 'PROCESSED' });

    const row = await getSubscriptionRow(db, org.organizationId);
    expect(row).not.toBeNull();
    expect(row!.provider).toBe('POLAR');
    expect(row!.status).toBe('ACTIVE');
    expect(row!.providerCustomerId).toBe('cus_test_4');
    expect(row!.providerSubscriptionId).toBe('sub_test_4');
    expect(row!.currentPeriodStart?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(row!.currentPeriodEnd?.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(row!.scheduledChangeAction).toBeNull();

    const eventRow = await getEventRow(db, 'msg_test_4');
    expect(eventRow).toMatchObject({
      provider: 'POLAR',
      eventType: 'subscription.created',
      processingStatus: 'PROCESSED',
      organizationId: org.organizationId,
    });
  });

  it('answers DUPLICATE on a second delivery of the same webhook-id — exactly one event row, unchanged', async () => {
    const org = await signUpAndGetOrg(auth, db, nextEmail());
    await seedPendingIntent(db, org.organizationId, 'chk_test_5');
    const signed = signedWebhook(
      WEBHOOK_SECRET,
      'msg_test_5',
      subscriptionEvent({
        type: 'subscription.created',
        timestamp: new Date().toISOString(),
        checkoutId: 'chk_test_5',
        subscriptionId: 'sub_test_5',
        status: 'active',
      }),
    );

    const first = await post(signed.headers, signed.body);
    expect(first.statusCode).toBe(200);
    const rowAfterFirst = await getSubscriptionRow(db, org.organizationId);

    const second = await post(signed.headers, signed.body);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ received: true, outcome: 'DUPLICATE' });

    const rows = await db
      .select()
      .from(schema.billingProviderEvents)
      .where(eq(schema.billingProviderEvents.providerEventId, 'msg_test_5'));
    expect(rows).toHaveLength(1);

    expect(await getSubscriptionRow(db, org.organizationId)).toStrictEqual(rowAfterFirst);
  });

  it('dedupes on the webhook-id header, not on the body — the same body under a new id is a new delivery', async () => {
    const org = await signUpAndGetOrg(auth, db, nextEmail());
    await seedPendingIntent(db, org.organizationId, 'chk_dedupe_key');
    const event = subscriptionEvent({
      type: 'subscription.updated',
      timestamp: '2026-05-10T00:00:00.000Z',
      checkoutId: 'chk_dedupe_key',
      subscriptionId: 'sub_dedupe_key',
      status: 'active',
    });

    expect((await send('msg_dedupe_key_a', event)).outcome).toBe('PROCESSED');
    expect((await send('msg_dedupe_key_b', event)).outcome).toBe('PROCESSED');
    expect(await getEventRow(db, 'msg_dedupe_key_a')).not.toBeNull();
    expect(await getEventRow(db, 'msg_dedupe_key_b')).not.toBeNull();
  });

  it('evaluates a redelivered event again when its earlier attempt was IGNORED', async () => {
    const org = await signUpAndGetOrg(auth, db, nextEmail());
    const event = subscriptionEvent({
      type: 'subscription.created',
      timestamp: new Date().toISOString(),
      checkoutId: 'chk_redeliver_ignored',
      subscriptionId: 'sub_redeliver_ignored',
      status: 'active',
    });

    expect((await send('msg_redeliver_ignored', event)).outcome).toBe('IGNORED');
    await seedPendingIntent(db, org.organizationId, 'chk_redeliver_ignored');

    expect((await send('msg_redeliver_ignored', event)).outcome).toBe('PROCESSED');
    expect(await getSubscriptionRow(db, org.organizationId)).toMatchObject({
      providerSubscriptionId: 'sub_redeliver_ignored',
      status: 'ACTIVE',
    });
    const rows = await db
      .select()
      .from(schema.billingProviderEvents)
      .where(eq(schema.billingProviderEvents.providerEventId, 'msg_redeliver_ignored'));
    expect(rows).toHaveLength(1);
  });

  it('retries a delivery whose earlier attempt is recorded FAILED', async () => {
    const org = await signUpAndGetOrg(auth, db, nextEmail());
    await seedPendingIntent(db, org.organizationId, 'chk_retry');
    await db.insert(schema.billingProviderEvents).values({
      provider: 'POLAR',
      providerEventId: 'msg_retry',
      eventType: 'subscription.created',
      occurredAt: new Date('2026-05-01T00:00:00.000Z'),
      processingStatus: 'FAILED',
      error: 'connection reset',
    });

    const result = await send(
      'msg_retry',
      subscriptionEvent({
        type: 'subscription.created',
        timestamp: '2026-05-01T00:00:00.000Z',
        checkoutId: 'chk_retry',
        subscriptionId: 'sub_retry',
        status: 'active',
      }),
    );

    expect(result.outcome).toBe('PROCESSED');
    expect(await getEventRow(db, 'msg_retry')).toMatchObject({ processingStatus: 'PROCESSED', error: null });
    expect((await getSubscriptionRow(db, org.organizationId))?.status).toBe('ACTIVE');
  });

  it('ignores an out-of-order delivery as a stale event — status stays at the later value', async () => {
    const org = await signUpAndGetOrg(auth, db, nextEmail());
    await seedPendingIntent(db, org.organizationId, 'chk_test_6');

    const later = await send(
      'msg_test_6a',
      subscriptionEvent({
        type: 'subscription.past_due',
        timestamp: '2026-01-01T00:00:10.000Z',
        checkoutId: 'chk_test_6',
        subscriptionId: 'sub_test_6',
        status: 'past_due',
      }),
    );
    expect(later.outcome).toBe('PROCESSED');

    const earlier = await send(
      'msg_test_6b',
      subscriptionEvent({
        type: 'subscription.created',
        timestamp: '2026-01-01T00:00:00.000Z',
        checkoutId: 'chk_test_6',
        subscriptionId: 'sub_test_6',
        status: 'active',
      }),
    );
    expect(earlier.outcome).toBe('IGNORED');

    const row = await getSubscriptionRow(db, org.organizationId);
    expect(row!.status).toBe('PAST_DUE');
    expect(row!.lastProviderEventAt!.toISOString()).toBe('2026-01-01T00:00:10.000Z');

    const ignoredEventRow = await getEventRow(db, 'msg_test_6b');
    expect(ignoredEventRow?.processingStatus).toBe('IGNORED');
    expect(ignoredEventRow?.error).toBe('stale event');
  });

  it('maps paused / resumed / past_due / unpaid / trialing / canceled through the status vocabulary', async () => {
    const org = await signUpAndGetOrg(auth, db, nextEmail());
    await seedPendingIntent(db, org.organizationId, 'chk_test_7');
    let t = new Date('2026-02-01T00:00:00.000Z').getTime();
    const deliver = async (webhookId: string, type: string, status: string) => {
      t += 1000;
      const result = await send(
        webhookId,
        subscriptionEvent({
          type,
          timestamp: new Date(t).toISOString(),
          checkoutId: 'chk_test_7',
          subscriptionId: 'sub_test_7',
          status,
        }),
      );
      expect(result.outcome).toBe('PROCESSED');
      return (await getSubscriptionRow(db, org.organizationId))!.status;
    };

    expect(await deliver('msg_test_7a', 'subscription.created', 'active')).toBe('ACTIVE');
    expect(await deliver('msg_test_7b', 'subscription.paused', 'paused')).toBe('PAUSED');
    expect(await deliver('msg_test_7c', 'subscription.resumed', 'active')).toBe('ACTIVE');
    expect(await deliver('msg_test_7d', 'subscription.past_due', 'past_due')).toBe('PAST_DUE');
    expect(await deliver('msg_test_7e', 'subscription.updated', 'unpaid')).toBe('PAST_DUE');
    expect(await deliver('msg_test_7f', 'subscription.updated', 'trialing')).toBe('ACTIVE');
    expect(await deliver('msg_test_7g', 'subscription.revoked', 'canceled')).toBe('CANCELED');
  });

  it.each(['incomplete', 'incomplete_expired', 'some_future_status'])(
    'ignores a subscription in status %s — never guessed, nothing written',
    async (status) => {
      const org = await signUpAndGetOrg(auth, db, nextEmail());
      await seedPendingIntent(db, org.organizationId, `chk_status_${status}`);

      const result = await send(
        `msg_status_${status}`,
        subscriptionEvent({
          type: 'subscription.created',
          timestamp: new Date().toISOString(),
          checkoutId: `chk_status_${status}`,
          subscriptionId: `sub_status_${status}`,
          status,
        }),
      );

      expect(result.outcome).toBe('IGNORED');
      expect(await getSubscriptionRow(db, org.organizationId)).toBeNull();
      expect((await getEventRow(db, `msg_status_${status}`))?.processingStatus).toBe('IGNORED');
    },
  );

  it('records a scheduled cancellation at ends_at and clears it on uncancel', async () => {
    const org = await signUpAndGetOrg(auth, db, nextEmail());
    await seedPendingIntent(db, org.organizationId, 'chk_test_8');

    await send(
      'msg_test_8a',
      subscriptionEvent({
        type: 'subscription.canceled',
        timestamp: '2026-03-01T00:00:00.000Z',
        checkoutId: 'chk_test_8',
        subscriptionId: 'sub_test_8',
        status: 'active',
        cancelAtPeriodEnd: true,
        endsAt: '2026-04-01T00:00:00.000Z',
      }),
    );

    let row = await getSubscriptionRow(db, org.organizationId);
    expect(row!.status).toBe('ACTIVE');
    expect(row!.scheduledChangeAction).toBe('cancel');
    expect(row!.scheduledChangeAt?.toISOString()).toBe('2026-04-01T00:00:00.000Z');

    await send(
      'msg_test_8b',
      subscriptionEvent({
        type: 'subscription.uncanceled',
        timestamp: '2026-03-02T00:00:00.000Z',
        checkoutId: 'chk_test_8',
        subscriptionId: 'sub_test_8',
        status: 'active',
      }),
    );

    row = await getSubscriptionRow(db, org.organizationId);
    expect(row!.scheduledChangeAction).toBeNull();
    expect(row!.scheduledChangeAt).toBeNull();
  });

  it('falls back to current_period_end for a scheduled cancellation without ends_at', async () => {
    const org = await signUpAndGetOrg(auth, db, nextEmail());
    await seedPendingIntent(db, org.organizationId, 'chk_test_8c');

    await send(
      'msg_test_8c',
      subscriptionEvent({
        type: 'subscription.updated',
        timestamp: '2026-03-01T00:00:00.000Z',
        checkoutId: 'chk_test_8c',
        subscriptionId: 'sub_test_8c',
        status: 'active',
        cancelAtPeriodEnd: true,
        endsAt: null,
      }),
    );

    const row = await getSubscriptionRow(db, org.organizationId);
    expect(row!.scheduledChangeAction).toBe('cancel');
    expect(row!.scheduledChangeAt?.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('records no scheduled change once the subscription is CANCELED', async () => {
    const org = await signUpAndGetOrg(auth, db, nextEmail());
    await seedPendingIntent(db, org.organizationId, 'chk_test_8d');

    await send(
      'msg_test_8d',
      subscriptionEvent({
        type: 'subscription.revoked',
        timestamp: '2026-03-01T00:00:00.000Z',
        checkoutId: 'chk_test_8d',
        subscriptionId: 'sub_test_8d',
        status: 'canceled',
        cancelAtPeriodEnd: true,
        endsAt: '2026-03-01T00:00:00.000Z',
      }),
    );

    const row = await getSubscriptionRow(db, org.organizationId);
    expect(row!.status).toBe('CANCELED');
    expect(row!.scheduledChangeAction).toBeNull();
    expect(row!.scheduledChangeAt).toBeNull();
  });

  it('ignores a second, different active subscription for the same organization as a mismatch', async () => {
    const org = await signUpAndGetOrg(auth, db, nextEmail());
    await seedPendingIntent(db, org.organizationId, 'chk_test_9a');
    await send(
      'msg_test_9a',
      subscriptionEvent({
        type: 'subscription.created',
        timestamp: '2026-05-01T00:00:00.000Z',
        checkoutId: 'chk_test_9a',
        subscriptionId: 'sub_test_9',
        status: 'active',
      }),
    );
    const rowAfterFirst = await getSubscriptionRow(db, org.organizationId);
    expect(rowAfterFirst!.status).toBe('ACTIVE');

    await seedPendingIntent(db, org.organizationId, 'chk_test_9b');
    const result = await send(
      'msg_test_9b',
      subscriptionEvent({
        type: 'subscription.created',
        timestamp: '2026-05-02T00:00:00.000Z',
        checkoutId: 'chk_test_9b',
        subscriptionId: 'sub_test_9b',
        status: 'active',
      }),
    );
    expect(result.outcome).toBe('IGNORED');

    expect(await getSubscriptionRow(db, org.organizationId)).toStrictEqual(rowAfterFirst);
    expect((await getEventRow(db, 'msg_test_9b'))?.error).toBe('subscription mismatch');
  });

  it.each(['PAST_DUE', 'PAUSED'] as const)(
    'ignores a different active subscription id while the stored one is %s — only CANCELED may be replaced',
    async (status) => {
      const org = await signUpAndGetOrg(auth, db, nextEmail());
      const storedSubscriptionId = `sub_test_a_${status}`;
      await db.insert(schema.billingSubscriptions).values({
        organizationId: org.organizationId,
        provider: 'POLAR',
        providerCustomerId: 'cus_test_1',
        providerSubscriptionId: storedSubscriptionId,
        status,
        lastProviderEventAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      await seedPendingIntent(db, org.organizationId, `chk_mismatch_${status}`);

      const result = await send(
        `msg_mismatch_${status}`,
        subscriptionEvent({
          type: 'subscription.active',
          timestamp: '2026-01-02T00:00:00.000Z',
          checkoutId: `chk_mismatch_${status}`,
          subscriptionId: `sub_test_b_${status}`,
          status: 'active',
        }),
      );
      expect(result.outcome).toBe('IGNORED');

      const rows = await db
        .select()
        .from(schema.billingSubscriptions)
        .where(eq(schema.billingSubscriptions.organizationId, org.organizationId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.providerSubscriptionId).toBe(storedSubscriptionId);
      expect(rows[0]!.status).toBe(status);

      const eventRow = await getEventRow(db, `msg_mismatch_${status}`);
      expect(eventRow?.processingStatus).toBe('IGNORED');
      expect(eventRow?.error).toBe('subscription mismatch');
    },
  );

  it('a resubscription after CANCELED updates the one row in place to the new subscription id — never a second row', async () => {
    const org = await signUpAndGetOrg(auth, db, nextEmail());
    await db.insert(schema.billingSubscriptions).values({
      organizationId: org.organizationId,
      provider: 'POLAR',
      providerCustomerId: 'cus_test_1',
      providerSubscriptionId: 'sub_test_old',
      status: 'CANCELED',
      lastProviderEventAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await seedPendingIntent(db, org.organizationId, 'chk_resub_1');

    const result = await send(
      'msg_resub_1',
      subscriptionEvent({
        type: 'subscription.active',
        timestamp: '2026-01-02T00:00:00.000Z',
        checkoutId: 'chk_resub_1',
        subscriptionId: 'sub_test_new',
        status: 'active',
      }),
    );
    expect(result.outcome).toBe('PROCESSED');

    const rows = await db
      .select()
      .from(schema.billingSubscriptions)
      .where(eq(schema.billingSubscriptions.organizationId, org.organizationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.providerSubscriptionId).toBe('sub_test_new');
    expect(rows[0]!.status).toBe('ACTIVE');
  });

  it.each(['order.paid', 'checkout.updated', 'customer.updated'])(
    'ignores a %s event but still records the event row',
    async (type) => {
      const result = await send(`msg_other_${type}`, {
        type,
        timestamp: new Date().toISOString(),
        data: { id: 'obj_test_1' },
      });

      expect(result.outcome).toBe('IGNORED');
      const eventRow = await getEventRow(db, `msg_other_${type}`);
      expect(eventRow).toMatchObject({ processingStatus: 'IGNORED', eventType: type, error: null });
    },
  );

  it('ignores an event whose organization cannot be resolved', async () => {
    const result = await send(
      'msg_test_11',
      subscriptionEvent({
        type: 'subscription.created',
        timestamp: new Date().toISOString(),
        subscriptionId: 'sub_test_unresolvable',
        status: 'active',
        // No checkout_id, and no billing_subscriptions row anywhere has this
        // providerSubscriptionId.
      }),
    );

    expect(result.outcome).toBe('IGNORED');
    const eventRow = await getEventRow(db, 'msg_test_11');
    expect(eventRow?.error).toBe('organization not found');
    expect(eventRow?.organizationId).toBeNull();

    const rows = await db
      .select()
      .from(schema.billingSubscriptions)
      .where(eq(schema.billingSubscriptions.providerSubscriptionId, 'sub_test_unresolvable'));
    expect(rows).toHaveLength(0);
  });

  describe('order.refunded', () => {
    function refundEvent(subscriptionId: string | null): Record<string, unknown> {
      return {
        type: 'order.refunded',
        timestamp: new Date().toISOString(),
        data: {
          id: 'ord_test_refund',
          created_at: '2026-01-15T00:00:00Z',
          status: 'partially_refunded',
          paid: true,
          total_amount: 2275,
          refunded_amount: 1000,
          currency: 'usd',
          invoice_number: '2026-00003',
          is_invoice_generated: true,
          subscription_id: subscriptionId,
          description: 'Deployz',
        },
      };
    }

    it("records a refund against the subscription's organization and changes no subscription state", async () => {
      const org = await signUpAndGetOrg(auth, db, nextEmail());
      const lastEventAt = new Date('2026-01-10T00:00:00Z');
      await db.insert(schema.billingSubscriptions).values({
        organizationId: org.organizationId,
        providerCustomerId: 'cus_test_refund',
        providerSubscriptionId: 'sub_test_refund',
        status: 'ACTIVE',
        lastProviderEventAt: lastEventAt,
      });

      const result = await send('msg_test_refund_1', refundEvent('sub_test_refund'));

      expect(result.outcome).toBe('PROCESSED');
      expect(await getEventRow(db, 'msg_test_refund_1')).toMatchObject({
        eventType: 'order.refunded',
        processingStatus: 'PROCESSED',
        organizationId: org.organizationId,
        error: null,
      });
      const row = await getSubscriptionRow(db, org.organizationId);
      expect(row).toMatchObject({ status: 'ACTIVE', scheduledChangeAction: null });
      expect(row!.lastProviderEventAt?.toISOString()).toBe(lastEventAt.toISOString());

      expect((await send('msg_test_refund_1', refundEvent('sub_test_refund'))).outcome).toBe('DUPLICATE');
    });

    it('ignores a refund of an order for no subscription on file', async () => {
      expect((await send('msg_test_refund_2', refundEvent('sub_test_unknown'))).outcome).toBe('IGNORED');
      expect(await getEventRow(db, 'msg_test_refund_2')).toMatchObject({
        processingStatus: 'IGNORED',
        organizationId: null,
        error: 'organization not found',
      });
      expect((await send('msg_test_refund_3', refundEvent(null))).outcome).toBe('IGNORED');
    });
  });

  describe("binding a new subscription through its checkout_id", () => {
    it('ignores forged metadata naming an organization when there is no checkout_id', async () => {
      const victim = await signUpAndGetOrg(auth, db, nextEmail());
      await seedPendingIntent(db, victim.organizationId, 'chk_bind_victim_open');

      const result = await send(
        'msg_bind_metadata_only',
        subscriptionEvent({
          type: 'subscription.created',
          timestamp: new Date().toISOString(),
          subscriptionId: 'sub_bind_metadata_only',
          status: 'active',
          metadata: { organizationId: victim.organizationId },
        }),
      );

      expect(result.outcome).toBe('IGNORED');
      expect(await getSubscriptionRow(db, victim.organizationId)).toBeNull();
      expect((await getEventRow(db, 'msg_bind_metadata_only'))?.error).toBe('organization not found');
    });

    it("binds to the checkout's organization, never to the organization the metadata names", async () => {
      const victim = await signUpAndGetOrg(auth, db, nextEmail());
      const payer = await signUpAndGetOrg(auth, db, nextEmail());
      const victimIntentId = await seedPendingIntent(db, victim.organizationId, 'chk_bind_victim');
      await seedPendingIntent(db, payer.organizationId, 'chk_bind_payer');

      const result = await send(
        'msg_bind_forged_metadata',
        subscriptionEvent({
          type: 'subscription.created',
          timestamp: new Date().toISOString(),
          checkoutId: 'chk_bind_payer',
          subscriptionId: 'sub_bind_forged_metadata',
          status: 'active',
          metadata: { organizationId: victim.organizationId, checkoutIntentId: victimIntentId },
        }),
      );

      expect(result.outcome).toBe('PROCESSED');
      expect(await getSubscriptionRow(db, victim.organizationId)).toBeNull();
      expect((await getSubscriptionRow(db, payer.organizationId))?.providerSubscriptionId).toBe(
        'sub_bind_forged_metadata',
      );
    });

    it('ignores a checkout_id that is no PENDING intent', async () => {
      const org = await signUpAndGetOrg(auth, db, nextEmail());
      await seedPendingIntent(db, org.organizationId, 'chk_bind_expected');

      const result = await send(
        'msg_bind_unknown_checkout',
        subscriptionEvent({
          type: 'subscription.created',
          timestamp: new Date().toISOString(),
          checkoutId: 'chk_bind_unknown',
          subscriptionId: 'sub_bind_unknown_checkout',
          status: 'active',
        }),
      );

      expect(result.outcome).toBe('IGNORED');
      expect(await getSubscriptionRow(db, org.organizationId)).toBeNull();
    });

    it.each(['COMPLETED', 'EXPIRED', 'FAILED'] as const)(
      'binds a checkout_id whose intent is %s: the vendor paid through Deployz\'s checkout',
      async (status) => {
        const org = await signUpAndGetOrg(auth, db, nextEmail());
        const intentId = await seedPendingIntent(db, org.organizationId, `chk_bind_${status}`);
        await db
          .update(schema.billingCheckoutIntents)
          .set({ status, resolvedAt: new Date() })
          .where(eq(schema.billingCheckoutIntents.id, intentId));

        const result = await send(
          `msg_bind_${status}`,
          subscriptionEvent({
            type: 'subscription.created',
            timestamp: new Date().toISOString(),
            checkoutId: `chk_bind_${status}`,
            subscriptionId: `sub_bind_${status}`,
            status: 'active',
          }),
        );

        expect(result.outcome).toBe('PROCESSED');
        expect(await getSubscriptionRow(db, org.organizationId)).toMatchObject({
          providerSubscriptionId: `sub_bind_${status}`,
          status: 'ACTIVE',
        });
        const [intent] = await db
          .select({ status: schema.billingCheckoutIntents.status })
          .from(schema.billingCheckoutIntents)
          .where(eq(schema.billingCheckoutIntents.id, intentId));
        expect(intent!.status).toBe(status);
      },
    );

    it('ignores a subscription for another product, even from a PENDING checkout', async () => {
      const org = await signUpAndGetOrg(auth, db, nextEmail());
      await seedPendingIntent(db, org.organizationId, 'chk_bind_wrong_product');

      const result = await send(
        'msg_bind_wrong_product',
        subscriptionEvent({
          type: 'subscription.created',
          timestamp: new Date().toISOString(),
          checkoutId: 'chk_bind_wrong_product',
          productId: 'product_other_replace_me',
          subscriptionId: 'sub_bind_wrong_product',
          status: 'active',
        }),
      );

      expect(result.outcome).toBe('IGNORED');
      expect(await getSubscriptionRow(db, org.organizationId)).toBeNull();
      expect((await getEventRow(db, 'msg_bind_wrong_product'))?.error).toBe('organization not found');
    });

    it("binds a subscription whose checkout_id is the PENDING intent's checkout", async () => {
      const org = await signUpAndGetOrg(auth, db, nextEmail());
      await seedPendingIntent(db, org.organizationId, 'chk_bind_ok');

      const result = await send(
        'msg_bind_ok',
        subscriptionEvent({
          type: 'subscription.created',
          timestamp: new Date().toISOString(),
          checkoutId: 'chk_bind_ok',
          subscriptionId: 'sub_bind_ok',
          status: 'active',
        }),
      );

      expect(result.outcome).toBe('PROCESSED');
      expect((await getSubscriptionRow(db, org.organizationId))?.providerSubscriptionId).toBe('sub_bind_ok');
    });

    it('follows the organization on file for a known subscription, whatever its checkout_id', async () => {
      const owner = await signUpAndGetOrg(auth, db, nextEmail());
      const other = await signUpAndGetOrg(auth, db, nextEmail());
      await seedPendingIntent(db, owner.organizationId, 'chk_on_file_owner');
      await send(
        'msg_on_file_created',
        subscriptionEvent({
          type: 'subscription.created',
          timestamp: '2026-06-01T00:00:00.000Z',
          checkoutId: 'chk_on_file_owner',
          subscriptionId: 'sub_on_file',
          status: 'active',
        }),
      );
      await seedPendingIntent(db, other.organizationId, 'chk_on_file_other');

      const result = await send(
        'msg_on_file_updated',
        subscriptionEvent({
          type: 'subscription.updated',
          timestamp: '2026-06-02T00:00:00.000Z',
          checkoutId: 'chk_on_file_other',
          subscriptionId: 'sub_on_file',
          status: 'past_due',
          metadata: { organizationId: other.organizationId },
        }),
      );

      expect(result.outcome).toBe('PROCESSED');
      expect(await getSubscriptionRow(db, other.organizationId)).toBeNull();
      expect((await getSubscriptionRow(db, owner.organizationId))?.status).toBe('PAST_DUE');
    });
  });

  it('reflects the new subscription status through GET /api/organization', async () => {
    const org = await signUpAndGetOrg(auth, db, nextEmail());
    await seedPendingIntent(db, org.organizationId, 'chk_test_13');
    await send(
      'msg_test_13',
      subscriptionEvent({
        type: 'subscription.created',
        timestamp: new Date().toISOString(),
        checkoutId: 'chk_test_13',
        subscriptionId: 'sub_test_13',
        status: 'active',
      }),
    );

    const orgResponse = await app.inject({
      method: 'GET',
      url: '/api/organization',
      headers: { cookie: org.cookie },
    });
    expect(orgResponse.statusCode).toBe(200);
    expect(orgResponse.json()).toMatchObject({ subscriptionStatus: 'ACTIVE' });
  });

  it('answers 503 when Polar is not configured', async () => {
    const disabledApp = await buildServer({ auth, db, polar: null });
    try {
      const signed = signedWebhook(
        WEBHOOK_SECRET,
        'msg_test_14',
        subscriptionEvent({
          type: 'subscription.created',
          timestamp: new Date().toISOString(),
          status: 'active',
        }),
      );

      const response = await disabledApp.inject({
        method: 'POST',
        url: '/api/billing/webhook',
        headers: signed.headers,
        payload: signed.body,
      });

      expect(response.statusCode).toBe(503);
      expect(await getEventRow(db, 'msg_test_14')).toBeNull();
    } finally {
      await disabledApp.close();
    }
  });
});
