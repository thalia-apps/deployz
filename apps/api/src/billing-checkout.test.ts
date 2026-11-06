import { PGlite } from '@electric-sql/pglite';
import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import { completePendingCheckoutIntent } from './billing-checkout.js';
import { env } from './env.js';
import type { CreateCheckoutInput, PolarBilling, PolarCheckout, PolarClient, PolarSubscription } from './polar.js';
import { buildServer } from './server.js';

// First production activation. A vendor without a subscription asks for a
// customer deployment: nothing is provisioned and no deployment row exists
// until the subscription activates. Fixture ids only (chk_test_1,
// sub_test_1, ...) — never anything that looks like a real Polar id.

const WEBHOOK_SECRET = 'polar_whs_test_1';
const PRODUCT_ID = 'product_replace_me';

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

let checkoutCounter = 0;

function openCheckout(id: string): PolarCheckout {
  return {
    id,
    status: 'open',
    url: `https://sandbox.polar.sh/checkout/${id}`,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
}

/**
 * A Polar double — no test ever reaches the Polar API. `getSubscription` and
 * `updateSubscriptionUnits` are here because the webhook's ACTIVE path also
 * reconciles (Phase 9); reconciliation itself is tested in
 * billing-reconcile.test.ts. Every checkout gets a fresh fixture id, because
 * the intent's checkout id is unique.
 */
function buildPolar(
  options: {
    createCheckout?: (input: CreateCheckoutInput) => Promise<PolarCheckout>;
    getCheckout?: (id: string) => Promise<PolarCheckout>;
  } = {},
): PolarBilling {
  const client = {
    createCheckout:
      options.createCheckout ??
      (async () => {
        checkoutCounter += 1;
        return openCheckout(`chk_test_${checkoutCounter}`);
      }),
    getCheckout: options.getCheckout ?? (async (id: string) => openCheckout(id)),
    getSubscription: async (id: string) => ({ id, units: 1 }) as PolarSubscription,
    updateSubscriptionUnits: async (id: string, units: number) => ({ id, units }) as PolarSubscription,
  } as Partial<PolarClient> as PolarClient;
  return {
    client,
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
  webhookId: string,
  event: Record<string, unknown>,
): {
  body: string;
  headers: Record<string, string>;
} {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', Buffer.from(WEBHOOK_SECRET, 'utf8'))
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

/** Polar's wire shape for subscription.active, created by `checkoutId`. */
function subscriptionActive(checkoutId: string | null, subscriptionId = 'sub_test_1'): Record<string, unknown> {
  const timestamp = new Date().toISOString();
  return {
    type: 'subscription.active',
    timestamp,
    data: {
      id: subscriptionId,
      status: 'active',
      amount: 6800,
      currency: 'usd',
      current_period_start: timestamp,
      current_period_end: timestamp,
      cancel_at_period_end: false,
      ends_at: null,
      customer_id: 'cus_test_1',
      product_id: PRODUCT_ID,
      checkout_id: checkoutId,
      units: 1,
      modified_at: timestamp,
      metadata: {},
    },
  };
}

/** The Polar checkout id stored on an intent. */
async function checkoutIdOf(db: Db, checkoutIntentId: string): Promise<string> {
  const [intent] = await db
    .select({ providerTransactionId: schema.billingCheckoutIntents.providerTransactionId })
    .from(schema.billingCheckoutIntents)
    .where(eq(schema.billingCheckoutIntents.id, checkoutIntentId));
  return intent!.providerTransactionId!;
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

describe('POST /api/billing/checkout', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let org: { userId: string; organizationId: string; cookie: string };
  let orgEmail: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    orgEmail = `checkout-${crypto.randomUUID()}@example.com`;
    org = await signUpAndGetOrg(auth, db, orgEmail);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('401s without a session', async () => {
    const app = await buildServer({ auth, db, polar: buildPolar() });
    try {
      const response = await postJson(app, '/api/billing/checkout', {});
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('503s when Polar is not configured', async () => {
    const app = await buildServer({ auth, db, polar: null });
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

  it('parks the request as a PENDING intent and returns the checkout URL — no deployment row', async () => {
    const created: CreateCheckoutInput[] = [];
    const app = await buildServer({
      auth,
      db,
      polar: buildPolar({
        createCheckout: async (input) => {
          created.push(input);
          return openCheckout('chk_test_park');
        },
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
      const payload = response.json() as { checkoutIntentId: string; checkoutUrl: string };
      expect(payload.checkoutUrl).toBe('https://sandbox.polar.sh/checkout/chk_test_park');

      // ONE unit of the configured product: the subscription always bills at
      // least one customer deployment, and reconciliation raises it later.
      expect(created).toEqual([
        {
          productId: PRODUCT_ID,
          units: 1,
          externalCustomerId: org.organizationId,
          customerEmail: orgEmail,
          metadata: {
            organizationId: org.organizationId,
            checkoutIntentId: payload.checkoutIntentId,
          },
          successUrl: `${env.webUrl}/dashboard/settings/billing?checkout=complete`,
        },
      ]);

      const [intent] = await db
        .select()
        .from(schema.billingCheckoutIntents)
        .where(eq(schema.billingCheckoutIntents.id, payload.checkoutIntentId));
      expect(intent).toMatchObject({
        status: 'PENDING',
        providerTransactionId: 'chk_test_park',
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

  it('builds the success URL from returnPath on WEB_URL', async () => {
    const created: CreateCheckoutInput[] = [];
    const app = await buildServer({
      auth,
      db,
      polar: buildPolar({
        createCheckout: async (input) => {
          created.push(input);
          checkoutCounter += 1;
          return openCheckout(`chk_test_${checkoutCounter}`);
        },
      }),
    });
    try {
      await clearIntents(db, org.organizationId);
      const response = await postJson(
        app,
        '/api/billing/checkout',
        { returnPath: '/dashboard/deployments/new' },
        { cookie: org.cookie },
      );
      expect(response.statusCode, response.body).toBe(200);
      expect(created).toHaveLength(1);
      expect(created[0]!.successUrl).toBe(`${env.webUrl}/dashboard/deployments/new?checkout=complete`);
    } finally {
      await app.close();
    }
  });

  it.each([
    'https://evil.example.com/dashboard',
    '//evil.example.com/dashboard',
    '/dashboard/../settings',
    '/dashboard?next=https://evil.example.com',
    '/settings/billing',
    '/dashboard/Settings',
  ])('rejects returnPath %s before any intent or Polar call', async (returnPath) => {
    let polarCalled = false;
    const app = await buildServer({
      auth,
      db,
      polar: buildPolar({
        createCheckout: async () => {
          polarCalled = true;
          return openCheckout('chk_should_not_exist');
        },
      }),
    });
    try {
      await clearIntents(db, org.organizationId);
      const response = await postJson(app, '/api/billing/checkout', { returnPath }, { cookie: org.cookie });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
      expect(polarCalled).toBe(false);
      expect(await pendingIntents(db, org.organizationId)).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('a second checkout reuses the same intent and its open checkout', async () => {
    let creates = 0;
    const lookedUp: string[] = [];
    const app = await buildServer({
      auth,
      db,
      polar: buildPolar({
        createCheckout: async () => {
          creates += 1;
          return openCheckout(`chk_test_reuse_${creates}`);
        },
        getCheckout: async (id) => {
          lookedUp.push(id);
          return openCheckout(id);
        },
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
      // Polar is asked once: a second open checkout could also be paid.
      expect(creates).toBe(1);
      expect(lookedUp).toEqual(['chk_test_reuse_1']);
      expect(second.json()).toEqual(first.json());
      expect(await pendingIntents(db, org.organizationId)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it.each([
    { label: 'expired', checkout: (id: string) => ({ ...openCheckout(id), status: 'expired' }) },
    { label: 'failed', checkout: (id: string) => ({ ...openCheckout(id), status: 'failed' }) },
    {
      label: 'open but past its expiry',
      checkout: (id: string) => ({ ...openCheckout(id), expires_at: new Date(Date.now() - 1000).toISOString() }),
    },
  ])('replaces a checkout that is $label with a new one on the same intent', async ({ checkout }) => {
    let creates = 0;
    const app = await buildServer({
      auth,
      db,
      polar: buildPolar({
        createCheckout: async () => {
          creates += 1;
          checkoutCounter += 1;
          return openCheckout(`chk_test_${checkoutCounter}`);
        },
        getCheckout: async (id) => checkout(id),
      }),
    });
    try {
      await clearIntents(db, org.organizationId);
      const first = await postJson(app, '/api/billing/checkout', {}, { cookie: org.cookie });
      const second = await postJson(app, '/api/billing/checkout', {}, { cookie: org.cookie });
      expect(first.statusCode, first.body).toBe(200);
      expect(second.statusCode, second.body).toBe(200);
      expect(creates).toBe(2);
      const firstBody = first.json() as { checkoutIntentId: string; checkoutUrl: string };
      const secondBody = second.json() as { checkoutIntentId: string; checkoutUrl: string };
      expect(secondBody.checkoutIntentId).toBe(firstBody.checkoutIntentId);
      expect(secondBody.checkoutUrl).not.toBe(firstBody.checkoutUrl);
      const pending = await pendingIntents(db, org.organizationId);
      expect(pending).toHaveLength(1);
      expect(`https://sandbox.polar.sh/checkout/${pending[0]!.providerTransactionId}`).toBe(secondBody.checkoutUrl);
    } finally {
      await app.close();
    }
  });

  it.each(['confirmed', 'succeeded'])(
    '409s CHECKOUT_ALREADY_PAID when the stored checkout is %s — no second checkout is sold',
    async (status) => {
      let creates = 0;
      const app = await buildServer({
        auth,
        db,
        polar: buildPolar({
          createCheckout: async () => {
            creates += 1;
            checkoutCounter += 1;
            return openCheckout(`chk_test_${checkoutCounter}`);
          },
          getCheckout: async (id) => ({ ...openCheckout(id), status }),
        }),
      });
      try {
        await clearIntents(db, org.organizationId);
        const first = await postJson(app, '/api/billing/checkout', {}, { cookie: org.cookie });
        expect(first.statusCode, first.body).toBe(200);
        const second = await postJson(app, '/api/billing/checkout', {}, { cookie: org.cookie });
        expect(second.statusCode).toBe(409);
        expect(second.json()).toMatchObject({ error: { code: 'CHECKOUT_ALREADY_PAID' } });
        expect(creates).toBe(1);
        expect(await pendingIntents(db, org.organizationId)).toHaveLength(1);
      } finally {
        await app.close();
      }
    },
  );

  it('two simultaneous checkouts (a double click) open exactly one Polar checkout', async () => {
    let calls = 0;
    const app = await buildServer({
      auth,
      db,
      polar: buildPolar({
        createCheckout: async () => {
          calls += 1;
          const id = `chk_test_race_${calls}`;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return openCheckout(id);
        },
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
    const app = await buildServer({ auth, db, polar: buildPolar() });
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
    const app = await buildServer({ auth, db, polar: buildPolar() });
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

  it('409s RELEASE_NOT_PUBLISHED when the application has no built release, before any intent or Polar call', async () => {
    let polarCalled = false;
    const app = await buildServer({
      auth,
      db,
      polar: buildPolar({
        createCheckout: async () => {
          polarCalled = true;
          return openCheckout('chk_should_not_exist');
        },
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
      expect(polarCalled).toBe(false);
      expect(await pendingIntents(db, org.organizationId)).toHaveLength(before.length);
    } finally {
      await app.close();
    }
  });

  it("404s on another organization's application", async () => {
    const app = await buildServer({ auth, db, polar: buildPolar() });
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

  it('leaves the intent PENDING and answers 502 when Polar refuses the checkout', async () => {
    const app = await buildServer({
      auth,
      db,
      polar: buildPolar({
        createCheckout: async () => {
          throw new Error('polar is down');
        },
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
      // The row survives with no checkout id, so the next call retries it
      // rather than stranding the vendor.
      const pending = await pendingIntents(db, org.organizationId);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.providerTransactionId).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('answers 502 and keeps the intent and its checkout when Polar cannot look up the stored checkout', async () => {
    let failLookup = false;
    const app = await buildServer({
      auth,
      db,
      polar: buildPolar({
        getCheckout: async (id) => {
          if (failLookup) throw new Error('polar is down');
          return openCheckout(id);
        },
      }),
    });
    try {
      await clearIntents(db, org.organizationId);
      const first = await postJson(app, '/api/billing/checkout', {}, { cookie: org.cookie });
      expect(first.statusCode, first.body).toBe(200);
      const [before] = await pendingIntents(db, org.organizationId);

      failLookup = true;
      const second = await postJson(app, '/api/billing/checkout', {}, { cookie: org.cookie });
      expect(second.statusCode).toBe(502);
      expect(second.json()).toMatchObject({ error: { code: 'CHECKOUT_UNAVAILABLE' } });
      const pending = await pendingIntents(db, org.organizationId);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.providerTransactionId).toBe(before!.providerTransactionId);
    } finally {
      await app.close();
    }
  });
});

describe('checkout intents resume on activation', () => {
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

  it('subscription.active creates the parked deployment and completes the intent', async () => {
    const app = await buildServer({ auth, db, polar: buildPolar() });
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
        'msg_test_resume_1',
        subscriptionActive(await checkoutIdOf(db, checkoutIntentId)),
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
    const app = await buildServer({ auth, db, polar: buildPolar() });
    try {
      const before = await db.select().from(schema.deployments);
      const { body, headers } = signedWebhook('msg_test_resume_2', subscriptionActive(null));
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
        providerTransactionId: 'chk_test_failed_1',
      })
      .returning();

    const result = await completePendingCheckoutIntent(
      { db, polar: buildPolar() },
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
      let polarCalled = false;
      const app = await buildServer({
        auth,
        db,
        polar: buildPolar({
          createCheckout: async () => {
            polarCalled = true;
            return openCheckout('chk_should_not_exist');
          },
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
        expect(polarCalled).toBe(false);
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
    const app = await buildServer({ auth, db, polar: buildPolar() });
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
    const app = await buildServer({ auth, db, polar: buildPolar() });
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
    const app = await buildServer({ auth, db, polar: buildPolar() });
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

      const { body, headers } = signedWebhook(
        'msg_test_size_1',
        subscriptionActive(await checkoutIdOf(db, checkoutIntentId)),
      );
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
    const app = await buildServer({ auth, db, polar: buildPolar() });
    try {
      const response = await postJson(app, '/api/billing/checkout', {}, { cookie: org.cookie });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as { checkoutIntentId: string; checkoutUrl: string };
      expect(body.checkoutIntentId).toBeTruthy();

      const [intent] = await db
        .select()
        .from(schema.billingCheckoutIntents)
        .where(eq(schema.billingCheckoutIntents.id, body.checkoutIntentId));
      expect(intent).toBeDefined();
      expect(intent!.status).toBe('PENDING');
      expect(body.checkoutUrl).toBe(`https://sandbox.polar.sh/checkout/${intent!.providerTransactionId}`);
      expect(intent!.applicationId).toBeNull();
      expect(intent!.customerId).toBeNull();
      expect(intent!.region).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('rejects partial fields with 422 VALIDATION_ERROR (all-or-none)', async () => {
    await clearIntents(db, org.organizationId);
    const app = await buildServer({ auth, db, polar: buildPolar() });
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
    const app = await buildServer({ auth, db, polar: buildPolar() });
    try {
      // Create subscribe-only intent
      const intentResponse = await postJson(app, '/api/billing/checkout', {}, { cookie: org.cookie });
      expect(intentResponse.statusCode).toBe(200);
      const { checkoutIntentId } = intentResponse.json() as { checkoutIntentId: string };

      // Simulate webhook: subscription.active
      const webhookEvent = subscriptionActive(await checkoutIdOf(db, checkoutIntentId));
      const { body, headers } = signedWebhook('msg_subscribe_only_1', webhookEvent);
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

      // Redelivery of the same webhook id is a no-op duplicate
      const redeliveryResponse = await app.inject({
        method: 'POST',
        url: '/api/billing/webhook',
        headers,
        payload: body,
      });
      expect(redeliveryResponse.statusCode).toBe(200);
      expect(redeliveryResponse.json()).toMatchObject({ outcome: 'DUPLICATE' });
    } finally {
      await app.close();
    }
  });
});
