import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import type { PaddleBilling } from './paddle.js';
import { buildServer } from './server.js';

// GET /api/billing/account and GET /api/billing/invoices/:id. Fixture ids
// only; no test reaches the Paddle API.

interface Calls {
  subscriptionGets: string[];
  transactionLists: unknown[];
  invoicePdfs: string[];
}

function card(last4: string) {
  return {
    type: 'card',
    card: { type: 'visa', last4, expiryMonth: 4, expiryYear: 2030, cardholderName: 'Test' },
  };
}

const TRANSACTIONS = [
  {
    id: 'txn_methodchange',
    status: 'completed',
    origin: 'subscription_payment_method_change',
    subscriptionId: 'sub_own',
    invoiceNumber: null,
    billedAt: '2026-10-20T00:00:00Z',
    createdAt: '2026-10-20T00:00:00Z',
    currencyCode: 'USD',
    details: { totals: { grandTotal: '0' } },
    payments: [{ status: 'captured', methodDetails: card('4242') }],
  },
  {
    id: 'txn_renewal',
    status: 'completed',
    origin: 'subscription_recurring',
    subscriptionId: 'sub_own',
    invoiceNumber: '2026-00002',
    billedAt: '2026-10-01T00:00:00Z',
    createdAt: '2026-10-01T00:00:00Z',
    currencyCode: 'USD',
    details: { totals: { grandTotal: '6800' } },
    payments: [
      { status: 'captured', methodDetails: card('1111') },
      { status: 'error', methodDetails: card('0002') },
    ],
  },
];

function fakePaddle(options: { calls?: Calls; error?: Error; scheduledCancel?: boolean } = {}): PaddleBilling {
  const transactionsById: Record<string, unknown> = {
    txn_renewal: TRANSACTIONS[1],
    txn_other_org: { ...TRANSACTIONS[1], id: 'txn_other_org', subscriptionId: 'sub_other' },
    txn_draft: { ...TRANSACTIONS[1], id: 'txn_draft', invoiceNumber: null },
  };
  return {
    config: {
      apiKey: 'test_replace_me',
      webhookSecret: 'test_replace_me',
      clientToken: 'pdl_sdbx_replace_me',
      pricePlatform: 'pri_platform_replace_me',
      priceDeployment: 'pri_deployment_replace_me',
      environment: 'sandbox',
    },
    client: {
      subscriptions: {
        get: async (id: string) => {
          if (options.error) throw options.error;
          options.calls?.subscriptionGets.push(id);
          return {
            id,
            nextBilledAt: options.scheduledCancel ? null : '2026-11-01T00:00:00Z',
            scheduledChange: options.scheduledCancel
              ? { action: 'cancel', effectiveAt: '2026-11-01T00:00:00Z', resumeAt: null }
              : null,
            nextTransaction: options.scheduledCancel
              ? null
              : {
                  details: {
                    totals: { grandTotal: '8700', currencyCode: 'USD' },
                    lineItems: [
                      { product: { name: 'Deployz Platform' }, quantity: 1, totals: { total: '4900' } },
                      { product: { name: 'Customer Deployment' }, quantity: 2, totals: { total: '3800' } },
                    ],
                  },
                },
          };
        },
      },
      transactions: {
        list: (query: unknown) => {
          options.calls?.transactionLists.push(query);
          return { next: async () => TRANSACTIONS };
        },
        get: async (id: string) => {
          const found = transactionsById[id];
          if (!found) throw Object.assign(new Error('not found'), { code: 'not_found' });
          return found;
        },
        getInvoicePDF: async (id: string) => {
          options.calls?.invoicePdfs.push(id);
          return { url: `https://invoices.test/${id}.pdf` };
        },
      },
    } as unknown as PaddleBilling['client'],
  };
}

function newCalls(): Calls {
  return { subscriptionGets: [], transactionLists: [], invoicePdfs: [] };
}

async function signUp(auth: Auth, db: Db, email: string) {
  const password = 'super-secret-1';
  const signup = await auth.api.signUpEmail({ body: { email, password, name: email.split('@')[0]! } });
  const signin = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const cookie = signin.headers.get('set-cookie');
  if (!cookie) throw new Error('sign-in did not set a session cookie');
  const [membership] = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, signup.user.id))
    .limit(1);
  if (!membership) throw new Error('signup did not provision an organization');
  return { userId: signup.user.id, organizationId: membership.organizationId, cookie };
}

function get(app: FastifyInstance, url: string, cookie?: string) {
  return app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
}

describe('billing account and invoices', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let owner: Awaited<ReturnType<typeof signUp>>;
  let evaluating: Awaited<ReturnType<typeof signUp>>;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    owner = await signUp(auth, db, `account-${crypto.randomUUID()}@example.com`);
    evaluating = await signUp(auth, db, `account-eval-${crypto.randomUUID()}@example.com`);
    await db.insert(schema.billingSubscriptions).values({
      organizationId: owner.organizationId,
      providerCustomerId: 'ctm_shared',
      providerSubscriptionId: 'sub_own',
      status: 'ACTIVE',
    });
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('401s without a session', async () => {
    const app = await buildServer({ auth, db, paddle: fakePaddle() });
    try {
      expect((await get(app, '/api/billing/account')).statusCode).toBe(401);
      expect((await get(app, '/api/billing/invoices/txn_renewal')).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('503s when Paddle is not configured', async () => {
    const app = await buildServer({ auth, db, paddle: null });
    try {
      const response = await get(app, '/api/billing/account', owner.cookie);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: 'BILLING_DISABLED' } });
    } finally {
      await app.close();
    }
  });

  it('409s an organization in evaluation', async () => {
    const calls = newCalls();
    const app = await buildServer({ auth, db, paddle: fakePaddle({ calls }) });
    try {
      const response = await get(app, '/api/billing/account', evaluating.cookie);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'NO_SUBSCRIPTION' } });
      expect(calls.subscriptionGets).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("reads the next payment, payment method and invoices of the organization's own subscription", async () => {
    const calls = newCalls();
    const app = await buildServer({ auth, db, paddle: fakePaddle({ calls }) });
    try {
      const response = await get(app, '/api/billing/account', owner.cookie);
      expect(response.statusCode, response.body).toBe(200);
      expect(calls.subscriptionGets).toEqual(['sub_own']);
      // Scoped by subscription, never by the (shareable) customer id.
      expect(calls.transactionLists).toEqual([
        expect.objectContaining({ subscriptionId: ['sub_own'] }),
      ]);
      expect(calls.transactionLists[0]).not.toHaveProperty('customerId');
      expect(response.json()).toEqual({
        nextPayment: {
          date: '2026-11-01T00:00:00Z',
          amount: '8700',
          currencyCode: 'USD',
          lines: [
            { description: 'Deployz Platform', quantity: 1, amount: '4900', currencyCode: 'USD' },
            { description: 'Customer Deployment', quantity: 2, amount: '3800', currencyCode: 'USD' },
          ],
        },
        scheduledChange: null,
        // The newest captured payment: the payment-method change.
        paymentMethod: { type: 'card', cardBrand: 'visa', last4: '4242', expiryMonth: 4, expiryYear: 2030 },
        // The $0 payment-method change is not an invoice.
        transactions: [
          {
            id: 'txn_renewal',
            status: 'completed',
            billedAt: '2026-10-01T00:00:00Z',
            invoiceNumber: '2026-00002',
            amount: '6800',
            currencyCode: 'USD',
          },
        ],
      });
    } finally {
      await app.close();
    }
  });

  it('shows a scheduled cancellation and no next payment', async () => {
    const app = await buildServer({ auth, db, paddle: fakePaddle({ scheduledCancel: true }) });
    try {
      const response = await get(app, '/api/billing/account', owner.cookie);
      expect(response.json()).toMatchObject({
        nextPayment: null,
        scheduledChange: { action: 'cancel', effectiveAt: '2026-11-01T00:00:00Z' },
      });
    } finally {
      await app.close();
    }
  });

  it('502s without leaking the provider error', async () => {
    const app = await buildServer({
      auth,
      db,
      paddle: fakePaddle({ error: new Error('internal paddle detail') }),
    });
    try {
      const response = await get(app, '/api/billing/account', owner.cookie);
      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({ error: { code: 'BILLING_DETAILS_UNAVAILABLE' } });
      expect(response.body).not.toContain('internal paddle detail');
    } finally {
      await app.close();
    }
  });

  it("returns an invoice link for the organization's own transaction", async () => {
    const calls = newCalls();
    const app = await buildServer({ auth, db, paddle: fakePaddle({ calls }) });
    try {
      const response = await get(app, '/api/billing/invoices/txn_renewal', owner.cookie);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ url: 'https://invoices.test/txn_renewal.pdf' });
    } finally {
      await app.close();
    }
  });

  it.each([
    ['another organization’s transaction', 'txn_other_org'],
    ['a transaction with no invoice', 'txn_draft'],
    ['an unknown transaction', 'txn_unknown'],
    ['a malformed id', '..%2Fsubscriptions'],
  ])('404s %s and mints no link', async (_label, transactionId) => {
    const calls = newCalls();
    const app = await buildServer({ auth, db, paddle: fakePaddle({ calls }) });
    try {
      const response = await get(app, `/api/billing/invoices/${transactionId}`, owner.cookie);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'INVOICE_NOT_FOUND' } });
      expect(calls.invoicePdfs).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('403s a member who is not an owner or admin', async () => {
    const member = await signUp(auth, db, `account-member-${crypto.randomUUID()}@example.com`);
    await db.insert(schema.member).values({
      id: crypto.randomUUID(),
      organizationId: owner.organizationId,
      userId: member.userId,
      role: 'member',
    });
    await db
      .update(schema.session)
      .set({ activeOrganizationId: owner.organizationId })
      .where(eq(schema.session.userId, member.userId));
    const app = await buildServer({ auth, db, paddle: fakePaddle() });
    try {
      expect((await get(app, '/api/billing/account', member.cookie)).statusCode).toBe(403);
      expect((await get(app, '/api/billing/invoices/txn_renewal', member.cookie)).statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
