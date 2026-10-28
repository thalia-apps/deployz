import { PGlite } from '@electric-sql/pglite';
import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import { completePendingCheckoutIntent } from './billing-checkout.js';
import { createPaddle, type PaddleBilling } from './paddle.js';
import { buildServer } from './server.js';

// Paddle migration Phase 8 — first production activation. A vendor without a
// subscription asks for a customer deployment: nothing is provisioned and no
// deployment row exists until the subscription activates. Fixture ids only
// (txn_test_1, sub_test_1, ...) — never anything that looks like a real
// Paddle id.

const WEBHOOK_SECRET = 'whsec_test_1';

const READY_METADATA = {
  hasDockerfile: true,
  dockerfilePath: 'Dockerfile',
  port: '3000',
  startupCommands: ['node dist/index.js'],
  usesPostgresql: false,
  postgres: { required: false },
  usesRedis: false,
  redis: { required: false },
  usesS3: false,
  usesLocalFilesystem: false,
  databaseState: 'none',
};

/**
 * The real client's `webhooks` (signature verification must be real) with a
 * stubbed `transactions.create` and `subscriptions` — no test ever reaches
 * the Paddle API. `subscriptions` is here because the webhook's ACTIVE path
 * also reconciles (Phase 9); reconciliation itself is tested in
 * billing-reconcile.test.ts.
 */
function buildPaddle(
  createTransaction: (body: unknown) => Promise<{ id: string }> = async () => ({
    id: 'txn_test_1',
  }),
): PaddleBilling {
  const billing = createPaddle({
    paddleApiKey: 'test_replace_me',
    paddleWebhookSecret: WEBHOOK_SECRET,
    paddleClientToken: 'pdl_sdbx_replace_me',
    paddlePricePlatform: 'pri_platform_replace_me',
    paddlePriceDeployment: 'pri_deployment_replace_me',
    paddleEnvironment: 'sandbox',
  });
  if (!billing) throw new Error('createPaddle unexpectedly returned null in the test fixture');
  return {
    config: billing.config,
    client: {
      webhooks: billing.client.webhooks,
      transactions: { create: createTransaction },
      subscriptions: {
        get: async () => ({ items: [{ price: { id: 'pri_platform_replace_me' }, quantity: 1 }] }),
        update: async () => ({}),
      },
    } as unknown as PaddleBilling['client'],
  };
}

/** Signs a webhook body the way Paddle does: `ts=<ts>;h1=<hmac-sha256(secret, "ts:body")>`. */
function signedWebhook(event: Record<string, unknown>): {
  body: string;
  headers: Record<string, string>;
} {
  const body = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const h1 = createHmac('sha256', WEBHOOK_SECRET).update(`${ts}:${body}`).digest('hex');
  return {
    body,
    headers: {
      'paddle-signature': `ts=${ts};h1=${h1}`,
      'content-type': 'application/json',
    },
  };
}

/** Paddle's wire shape (snake_case) for subscription.activated. */
function subscriptionActivated(
  organizationId: string,
  eventId: string,
  checkoutIntentId?: string,
  subscriptionId = 'sub_test_1',
): Record<string, unknown> {
  const occurredAt = new Date().toISOString();
  return {
    event_id: eventId,
    event_type: 'subscription.activated',
    occurred_at: occurredAt,
    notification_id: `ntf_${eventId}`,
    data: {
      id: subscriptionId,
      status: 'active',
      customer_id: 'ctm_test_1',
      address_id: 'add_test_1',
      currency_code: 'USD',
      created_at: occurredAt,
      updated_at: occurredAt,
      collection_mode: 'automatic',
      billing_cycle: { interval: 'month', frequency: 1 },
      current_billing_period: { starts_at: occurredAt, ends_at: occurredAt },
      scheduled_change: null,
      items: [{ status: 'active', quantity: 1, recurring: true, created_at: occurredAt, updated_at: occurredAt, price: { id: 'pri_platform_replace_me', product_id: 'pro_test_1', description: 'Test price', tax_mode: 'account_setting' } }],
      custom_data: checkoutIntentId ? { organizationId, checkoutIntentId } : { organizationId },
    },
  };
}

async function signUpAndGetOrg(
  auth: Auth,
  db: Db,
  email: string,
): Promise<{ userId: string; organizationId: string; cookie: string }> {
  const password = 'super-secret-1';
  const signup = await auth.api.signUpEmail({ body: { email, password, name: email.split('@')[0]! } });
  const signin = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const setCookie = signin.headers.get('set-cookie');
  if (!setCookie) {
    throw new Error('sign-in did not set a session cookie');
  }
  const memberships = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, signup.user.id))
    .limit(1);
  const organizationId = memberships[0]?.organizationId;
  if (!organizationId) {
    throw new Error('signup did not provision an organization');
  }
  return { userId: signup.user.id, organizationId, cookie: setCookie };
}

async function insertApplication(
  db: Db,
  organizationId: string,
): Promise<typeof schema.applications.$inferSelect> {
  const [row] = await db
    .insert(schema.applications)
    .values({
      organizationId,
      name: 'Checkout App',
      repoFullName: `acme/checkout-${crypto.randomUUID().slice(0, 8)}`,
      repoUrl: 'https://github.com/acme/checkout',
      defaultBranch: 'main',
      detectedMetadata: READY_METADATA,
    })
    .returning();
  // A built release: checkout and the parked deployment both refuse without one.
  await db.insert(schema.releases).values({
    applicationId: row!.id,
    version: '1.0.0',
    gitSha: 'a'.repeat(40),
    releaseStatus: 'READY',
    imageDigest: `123456789012.dkr.ecr.us-east-1.amazonaws.com/deployz-fixture@sha256:${'b'.repeat(64)}`,
  });
  return row!;
}

async function insertCustomer(
  db: Db,
  organizationId: string,
): Promise<typeof schema.customers.$inferSelect> {
  const [row] = await db
    .insert(schema.customers)
    .values({
      organizationId,
      name: 'Checkout Customer',
      email: `checkout-${crypto.randomUUID()}@example.com`,
    })
    .returning();
  return row!;
}

function postJson(
  app: FastifyInstance,
  url: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    payload: JSON.stringify(body),
  });
}

/** Clears whatever a previous test parked — the PENDING intent is reused by
 *  design, so a test that needs a fresh checkout must start from none. */
async function clearIntents(db: Db, organizationId: string): Promise<void> {
  await db
    .delete(schema.billingCheckoutIntents)
    .where(eq(schema.billingCheckoutIntents.organizationId, organizationId));
}

function pendingIntents(db: Db, organizationId: string) {
  return db
    .select()
    .from(schema.billingCheckoutIntents)
    .where(
      and(
        eq(schema.billingCheckoutIntents.organizationId, organizationId),
        eq(schema.billingCheckoutIntents.status, 'PENDING'),
      ),
    );
}

describe('POST /api/billing/checkout (Paddle migration Phase 8)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let org: { userId: string; organizationId: string; cookie: string };

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, `checkout-${crypto.randomUUID()}@example.com`);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('401s without a session', async () => {
    const app = await buildServer({ auth, db, paddle: buildPaddle() });
    try {
      const response = await postJson(app, '/api/billing/checkout', {});
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('503s when Paddle is not configured', async () => {
    const app = await buildServer({ auth, db, paddle: null });
    try {
      const application = await insertApplication(db, org.organizationId);
      const customer = await insertCustomer(db, org.organizationId);
      const response = await postJson(
        app,
        '/api/billing/checkout',
        { applicationId: application.id, customerId: customer.id, region: 'us-east-1' },
        { cookie: org.cookie },
      );
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: 'BILLING_DISABLED' } });
    } finally {
      await app.close();
    }
  });

  it('parks the request as a PENDING intent and returns the transaction id — no deployment row', async () => {
    const created: unknown[] = [];
    const app = await buildServer({
      auth,
      db,
      paddle: buildPaddle(async (body) => {
        created.push(body);
        return { id: 'txn_test_1' };
      }),
    });
    try {
      const application = await insertApplication(db, org.organizationId);
      const customer = await insertCustomer(db, org.organizationId);
      const response = await postJson(
        app,
        '/api/billing/checkout',
        { applicationId: application.id, customerId: customer.id, region: 'us-east-1' },
        { cookie: org.cookie },
      );
      expect(response.statusCode, response.body).toBe(200);
      const payload = response.json() as { checkoutIntentId: string; transactionId: string };
      expect(payload.transactionId).toBe('txn_test_1');

      // The PLATFORM price only: the parked deployment is not live yet, and
      // Phase 9 reconciliation bills live deployments by quantity.
      expect(created).toEqual([
        {
          items: [{ priceId: 'pri_platform_replace_me', quantity: 1 }],
          customData: {
            organizationId: org.organizationId,
            checkoutIntentId: payload.checkoutIntentId,
          },
        },
      ]);

      const [intent] = await db
        .select()
        .from(schema.billingCheckoutIntents)
        .where(eq(schema.billingCheckoutIntents.id, payload.checkoutIntentId));
      expect(intent).toMatchObject({
        status: 'PENDING',
        providerTransactionId: 'txn_test_1',
        applicationId: application.id,
        customerId: customer.id,
        region: 'us-east-1',
        createdBy: org.userId,
        deploymentId: null,
      });

      // Nothing is provisioned before the vendor pays.
      const deployments = await db
        .select()
        .from(schema.deployments)
        .where(eq(schema.deployments.applicationId, application.id));
      expect(deployments).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('a second checkout reuses the same intent and transaction', async () => {
    let calls = 0;
    const app = await buildServer({
      auth,
      db,
      paddle: buildPaddle(async () => {
        calls += 1;
        return { id: `txn_test_reuse_${calls}` };
      }),
    });
    try {
      await clearIntents(db, org.organizationId);
      const application = await insertApplication(db, org.organizationId);
      const customer = await insertCustomer(db, org.organizationId);
      const body = { applicationId: application.id, customerId: customer.id, region: 'us-east-1' };
      const first = await postJson(app, '/api/billing/checkout', body, { cookie: org.cookie });
      const second = await postJson(app, '/api/billing/checkout', body, { cookie: org.cookie });
      expect(first.statusCode, first.body).toBe(200);
      expect(second.statusCode, second.body).toBe(200);
      // Paddle is asked once: a second transaction would be left dangling.
      expect(calls).toBe(1);
      expect(second.json()).toEqual(first.json());
      expect(await pendingIntents(db, org.organizationId)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('two simultaneous checkouts (a double click) open exactly one Paddle transaction', async () => {
    let calls = 0;
    const app = await buildServer({
      auth,
      db,
      paddle: buildPaddle(async () => {
        calls += 1;
        const id = `txn_test_race_${calls}`;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { id };
      }),
    });
    try {
      await clearIntents(db, org.organizationId);
      const [first, second] = await Promise.all([
        postJson(app, '/api/billing/checkout', {}, { cookie: org.cookie }),
        postJson(app, '/api/billing/checkout', {}, { cookie: org.cookie }),
      ]);
      expect(first.statusCode, first.body).toBe(200);
      expect(second.statusCode, second.body).toBe(200);
      expect(calls).toBe(1);
      expect(second.json()).toEqual(first.json());
      expect(await pendingIntents(db, org.organizationId)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('a later checkout replaces the parked request on the same intent', async () => {
    const app = await buildServer({ auth, db, paddle: buildPaddle() });
    try {
      const [pending] = await pendingIntents(db, org.organizationId);
      const application = await insertApplication(db, org.organizationId);
      const customer = await insertCustomer(db, org.organizationId);
      const response = await postJson(
        app,
        '/api/billing/checkout',
        { applicationId: application.id, customerId: customer.id, region: 'us-east-1' },
        { cookie: org.cookie },
      );
      expect(response.statusCode, response.body).toBe(200);
      expect((response.json() as { checkoutIntentId: string }).checkoutIntentId).toBe(pending!.id);
      const [updated] = await db
        .select()
        .from(schema.billingCheckoutIntents)
        .where(eq(schema.billingCheckoutIntents.id, pending!.id));
      expect(updated).toMatchObject({
        applicationId: application.id,
        customerId: customer.id,
        status: 'PENDING',
      });
    } finally {
      await app.close();
    }
  });

  it('422s on a region that is not deployable, before any intent exists', async () => {
    const app = await buildServer({ auth, db, paddle: buildPaddle() });
    try {
      const application = await insertApplication(db, org.organizationId);
      const customer = await insertCustomer(db, org.organizationId);
      const before = await pendingIntents(db, org.organizationId);
      const response = await postJson(
        app,
        '/api/billing/checkout',
        { applicationId: application.id, customerId: customer.id, region: 'ap-south-1' },
        { cookie: org.cookie },
      );
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ error: { code: 'REGION_NOT_SUPPORTED' } });
      expect(await pendingIntents(db, org.organizationId)).toHaveLength(before.length);
    } finally {
      await app.close();
    }
  });

  it('409s RELEASE_NOT_PUBLISHED when the application has no built release, before any intent or Paddle call', async () => {
    let paddleCalled = false;
    const app = await buildServer({
      auth,
      db,
      paddle: buildPaddle(async () => {
        paddleCalled = true;
        return { id: 'txn_should_not_exist' };
      }),
    });
    try {
      const application = await insertApplication(db, org.organizationId);
      await db.delete(schema.releases).where(eq(schema.releases.applicationId, application.id));
      const customer = await insertCustomer(db, org.organizationId);
      const before = await pendingIntents(db, org.organizationId);
      const response = await postJson(
        app,
        '/api/billing/checkout',
        { applicationId: application.id, customerId: customer.id, region: 'us-east-1' },
        { cookie: org.cookie },
      );
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'RELEASE_NOT_PUBLISHED' } });
      expect(paddleCalled).toBe(false);
      expect(await pendingIntents(db, org.organizationId)).toHaveLength(before.length);
    } finally {
      await app.close();
    }
  });

  it("404s on another organization's application", async () => {
    const app = await buildServer({ auth, db, paddle: buildPaddle() });
    try {
      const other = await signUpAndGetOrg(auth, db, `checkout-other-${crypto.randomUUID()}@example.com`);
      const application = await insertApplication(db, other.organizationId);
      const customer = await insertCustomer(db, org.organizationId);
      const response = await postJson(
        app,
        '/api/billing/checkout',
        { applicationId: application.id, customerId: customer.id, region: 'us-east-1' },
        { cookie: org.cookie },
      );
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('leaves the intent PENDING and answers 502 when Paddle refuses the transaction', async () => {
    const app = await buildServer({
      auth,
      db,
      paddle: buildPaddle(async () => {
        throw new Error('paddle is down');
      }),
    });
    try {
      await clearIntents(db, org.organizationId);
      const application = await insertApplication(db, org.organizationId);
      const customer = await insertCustomer(db, org.organizationId);
      const response = await postJson(
        app,
        '/api/billing/checkout',
        { applicationId: application.id, customerId: customer.id, region: 'us-east-1' },
        { cookie: org.cookie },
      );
      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({ error: { code: 'CHECKOUT_UNAVAILABLE' } });
      // The row survives with no transaction id, so the next call retries it
      // rather than stranding the vendor.
      const pending = await pendingIntents(db, org.organizationId);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.providerTransactionId).toBeNull();
    } finally {
      await app.close();
    }
  });
});

describe('checkout intents resume on activation (Paddle migration Phase 8)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let org: { userId: string; organizationId: string; cookie: string };

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, `resume-${crypto.randomUUID()}@example.com`);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('subscription.activated creates the parked deployment and completes the intent', async () => {
    const app = await buildServer({ auth, db, paddle: buildPaddle() });
    try {
      const application = await insertApplication(db, org.organizationId);
      const customer = await insertCustomer(db, org.organizationId);
      const checkout = await postJson(
        app,
        '/api/billing/checkout',
        { applicationId: application.id, customerId: customer.id, region: 'us-east-1' },
        { cookie: org.cookie },
      );
      expect(checkout.statusCode, checkout.body).toBe(200);
      const { checkoutIntentId } = checkout.json() as { checkoutIntentId: string };

      const { body, headers } = signedWebhook(
        subscriptionActivated(org.organizationId, 'evt_test_resume_1', checkoutIntentId),
      );
      const webhook = await app.inject({
        method: 'POST',
        url: '/api/billing/webhook',
        headers,
        payload: body,
      });
      expect(webhook.statusCode, webhook.body).toBe(200);

      const [intent] = await db
        .select()
        .from(schema.billingCheckoutIntents)
        .where(eq(schema.billingCheckoutIntents.id, checkoutIntentId));
      expect(intent!.status).toBe('COMPLETED');
      expect(intent!.deploymentId).not.toBeNull();

      const [deployment] = await db
        .select()
        .from(schema.deployments)
        .where(eq(schema.deployments.id, intent!.deploymentId!));
      expect(deployment).toMatchObject({
        organizationId: org.organizationId,
        applicationId: application.id,
        customerId: customer.id,
        region: 'us-east-1',
        deploymentType: 'PRODUCTION',
        state: 'NOT_INSTALLED',
        billingState: 'NOT_STARTED',
      });
    } finally {
      await app.close();
    }
  });

  it('a second ACTIVE delivery creates no second deployment', async () => {
    const app = await buildServer({ auth, db, paddle: buildPaddle() });
    try {
      const before = await db.select().from(schema.deployments);
      const { body, headers } = signedWebhook(
        subscriptionActivated(org.organizationId, 'evt_test_resume_2'),
      );
      const webhook = await app.inject({
        method: 'POST',
        url: '/api/billing/webhook',
        headers,
        payload: body,
      });
      expect(webhook.statusCode, webhook.body).toBe(200);
      expect(await db.select().from(schema.deployments)).toHaveLength(before.length);
    } finally {
      await app.close();
    }
  });

  it('records FAILED without throwing when the deployment cannot be created', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    // An application with no usable metadata never passes the preflight gate.
    await db
      .update(schema.applications)
      .set({ detectedMetadata: {} })
      .where(eq(schema.applications.id, application.id));
    const [intent] = await db
      .insert(schema.billingCheckoutIntents)
      .values({
        organizationId: org.organizationId,
        applicationId: application.id,
        customerId: customer.id,
        region: 'us-east-1',
        providerTransactionId: 'txn_test_2',
      })
      .returning();

    const result = await completePendingCheckoutIntent(
      { db, paddle: buildPaddle() },
      org.organizationId,
      intent!.id,
    );
    expect(result).toEqual({
      checkoutIntentId: intent!.id,
      status: 'FAILED',
      error: expect.any(String),
    });

    const [row] = await db
      .select()
      .from(schema.billingCheckoutIntents)
      .where(eq(schema.billingCheckoutIntents.id, intent!.id));
    expect(row!.status).toBe('FAILED');
    expect(row!.error).toBeTruthy();
    expect(row!.deploymentId).toBeNull();
  });

  it.each(['PAST_DUE', 'PAUSED'] as const)(
    'refuses a checkout while the subscription is %s — that is fixed on the portal, not by buying again',
    async (status) => {
      await db
        .update(schema.billingSubscriptions)
        .set({ status })
        .where(eq(schema.billingSubscriptions.organizationId, org.organizationId));
      let paddleCalled = false;
      const app = await buildServer({
        auth,
        db,
        paddle: buildPaddle(async () => {
          paddleCalled = true;
          return { id: 'txn_should_not_exist' };
        }),
      });
      try {
        const application = await insertApplication(db, org.organizationId);
        const customer = await insertCustomer(db, org.organizationId);
        const response = await postJson(
          app,
          '/api/billing/checkout',
          { applicationId: application.id, customerId: customer.id, region: 'us-east-1' },
          { cookie: org.cookie },
        );
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({
          error: { code: 'SUBSCRIPTION_NEEDS_ATTENTION', details: { subscriptionStatus: status } },
        });
        // No second subscription is ever sold.
        expect(paddleCalled).toBe(false);
      } finally {
        await db
          .update(schema.billingSubscriptions)
          .set({ status: 'ACTIVE' })
          .where(eq(schema.billingSubscriptions.organizationId, org.organizationId));
        await app.close();
      }
    },
  );

  it('allows a checkout after a cancel — a new subscription replaces the ended one', async () => {
    await db
      .update(schema.billingSubscriptions)
      .set({ status: 'CANCELED' })
      .where(eq(schema.billingSubscriptions.organizationId, org.organizationId));
    const app = await buildServer({ auth, db, paddle: buildPaddle() });
    try {
      await clearIntents(db, org.organizationId);
      const application = await insertApplication(db, org.organizationId);
      const customer = await insertCustomer(db, org.organizationId);
      const response = await postJson(
        app,
        '/api/billing/checkout',
        { applicationId: application.id, customerId: customer.id, region: 'us-east-1' },
        { cookie: org.cookie },
      );
      expect(response.statusCode, response.body).toBe(200);
    } finally {
      await db
        .update(schema.billingSubscriptions)
        .set({ status: 'ACTIVE' })
        .where(eq(schema.billingSubscriptions.organizationId, org.organizationId));
      await app.close();
    }
  });

  it('409s a checkout once the subscription is ACTIVE', async () => {
    const app = await buildServer({ auth, db, paddle: buildPaddle() });
    try {
      const application = await insertApplication(db, org.organizationId);
      const customer = await insertCustomer(db, org.organizationId);
      const response = await postJson(
        app,
        '/api/billing/checkout',
        { applicationId: application.id, customerId: customer.id, region: 'us-east-1' },
        { cookie: org.cookie },
      );
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'SUBSCRIPTION_ALREADY_ACTIVE' } });
    } finally {
      await app.close();
    }
  });
});

describe('checkout intents carry the deployment size', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let org: { userId: string; organizationId: string; cookie: string };

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, `size-${crypto.randomUUID()}@example.com`);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('refuses a size below the minimum before any intent exists, stores the chosen size, and freezes it on activation', async () => {
    const app = await buildServer({ auth, db, paddle: buildPaddle() });
    try {
      const application = await insertApplication(db, org.organizationId);
      await db
        .update(schema.applications)
        .set({ defaultSizeProfile: 'medium', minimumSizeProfile: 'medium' })
        .where(eq(schema.applications.id, application.id));
      const customer = await insertCustomer(db, org.organizationId);
      const checkout = (sizeProfile?: string) =>
        postJson(
          app,
          '/api/billing/checkout',
          { applicationId: application.id, customerId: customer.id, region: 'us-east-1', ...(sizeProfile ? { sizeProfile } : {}) },
          { cookie: org.cookie },
        );

      const below = await checkout('small');
      expect(below.statusCode, below.body).toBe(422);
      expect(below.json()).toMatchObject({ error: { code: 'SIZE_PROFILE_NOT_ALLOWED' } });
      expect(await pendingIntents(db, org.organizationId)).toEqual([]);

      const response = await checkout('large');
      expect(response.statusCode, response.body).toBe(200);
      const { checkoutIntentId } = response.json() as { checkoutIntentId: string };
      const [parked] = await pendingIntents(db, org.organizationId);
      expect(parked).toMatchObject({ id: checkoutIntentId, sizeProfile: 'large' });

      const { body, headers } = signedWebhook(subscriptionActivated(org.organizationId, 'evt_test_size_1', checkoutIntentId));
      const webhook = await app.inject({ method: 'POST', url: '/api/billing/webhook', headers, payload: body });
      expect(webhook.statusCode, webhook.body).toBe(200);

      const [intent] = await db
        .select()
        .from(schema.billingCheckoutIntents)
        .where(eq(schema.billingCheckoutIntents.id, checkoutIntentId));
      expect(intent!.status).toBe('COMPLETED');
      const [deployment] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, intent!.deploymentId!));
      expect(deployment!.desiredState).toMatchObject({ infrastructureProfile: { id: 'large', version: 1 } });
    } finally {
      await app.close();
    }
  });
});

describe('subscribe-only checkout intents (invitation-first flow)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let org: { organizationId: string; cookie: string };

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    const email = `billing-subscribe-only-${Math.random().toString(36).slice(2)}@example.com`;
    const password = 'super-secret-1';
    const signup = await auth.api.signUpEmail({
      body: { email, password, name: email.split('@')[0]! },
    });
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
    org = { organizationId, cookie: setCookie };
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  async function clearIntents(db: Db, organizationId: string): Promise<void> {
    await db
      .delete(schema.billingCheckoutIntents)
      .where(eq(schema.billingCheckoutIntents.organizationId, organizationId));
  }

  it('creates a subscribe-only intent (empty body) with null application/customer/region', async () => {
    await clearIntents(db, org.organizationId);
    const app = await buildServer({ auth, db, paddle: buildPaddle() });
    try {
      const response = await postJson(app, '/api/billing/checkout', {}, { cookie: org.cookie });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as { checkoutIntentId: string; transactionId: string };
      expect(body.checkoutIntentId).toBeTruthy();
      expect(body.transactionId).toBe('txn_test_1');

      const [intent] = await db
        .select()
        .from(schema.billingCheckoutIntents)
        .where(eq(schema.billingCheckoutIntents.id, body.checkoutIntentId));
      expect(intent).toBeDefined();
      expect(intent!.status).toBe('PENDING');
      expect(intent!.applicationId).toBeNull();
      expect(intent!.customerId).toBeNull();
      expect(intent!.region).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('rejects partial fields with 422 VALIDATION_ERROR (all-or-none)', async () => {
    await clearIntents(db, org.organizationId);
    const app = await buildServer({ auth, db, paddle: buildPaddle() });
    try {
      const application = await insertApplication(db, org.organizationId);
      const customer = await insertCustomer(db, org.organizationId);

      // Only applicationId (missing customerId and region)
      let response = await postJson(
        app,
        '/api/billing/checkout',
        { applicationId: application.id },
        { cookie: org.cookie },
      );
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

      // Only customerId (missing applicationId and region)
      response = await postJson(
        app,
        '/api/billing/checkout',
        { customerId: customer.id },
        { cookie: org.cookie },
      );
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

      // Only region (missing applicationId and customerId)
      response = await postJson(
        app,
        '/api/billing/checkout',
        { region: 'us-east-1' },
        { cookie: org.cookie },
      );
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

      // Two fields (missing one)
      response = await postJson(
        app,
        '/api/billing/checkout',
        { applicationId: application.id, customerId: customer.id },
        { cookie: org.cookie },
      );
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    } finally {
      await app.close();
    }
  });

  it('completes a subscribe-only intent without creating a deployment', async () => {
    await clearIntents(db, org.organizationId);
    const app = await buildServer({ auth, db, paddle: buildPaddle() });
    try {
      // Create subscribe-only intent
      const intentResponse = await postJson(app, '/api/billing/checkout', {}, { cookie: org.cookie });
      expect(intentResponse.statusCode).toBe(200);
      const { checkoutIntentId } = intentResponse.json() as { checkoutIntentId: string };

      // Simulate webhook: subscription.activated
      const webhookEvent = subscriptionActivated(org.organizationId, 'evt_subscribe_only_1', checkoutIntentId);
      const { body, headers } = signedWebhook(webhookEvent);
      const webhookResponse = await app.inject({
        method: 'POST',
        url: '/api/billing/webhook',
        headers,
        payload: body,
      });
      expect(webhookResponse.statusCode, webhookResponse.body).toBe(200);

      // Intent should be COMPLETED with no deployment
      const [intent] = await db
        .select()
        .from(schema.billingCheckoutIntents)
        .where(eq(schema.billingCheckoutIntents.id, checkoutIntentId));
      expect(intent!.status).toBe('COMPLETED');
      expect(intent!.deploymentId).toBeNull();

      // No deployment should exist
      const deployments = await db
        .select()
        .from(schema.deployments)
        .where(eq(schema.deployments.organizationId, org.organizationId));
      expect(deployments).toHaveLength(0);

      // Redelivery should no-op (no PENDING intent)
      const redeliveryResponse = await app.inject({
        method: 'POST',
        url: '/api/billing/webhook',
        headers,
        payload: body,
      });
      expect(redeliveryResponse.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
