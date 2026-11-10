import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import { PolarApiError, type PolarBilling, type PolarOrder } from './polar.js';
import { buildServer } from './server.js';

// GET /api/billing/account and GET /api/billing/invoices/:id. Fixture ids
// only; no test reaches the Polar API.

interface Calls {
  subscriptionGets: string[];
  orderLists: string[];
  paymentMethodLists: string[];
  invoiceUrls: string[];
  cancels: string[];
}

const OWN_PAID_ORDER = '00000000-0000-4000-8000-000000000001';
const OWN_VOID_ORDER = '00000000-0000-4000-8000-000000000002';
const OTHER_ORG_ORDER = '00000000-0000-4000-8000-000000000003';
const OWN_UNPAID_ORDER = '00000000-0000-4000-8000-000000000004';
const OWN_UNGENERATED_ORDER = '00000000-0000-4000-8000-000000000005';
const OWN_REFUNDED_ORDER = '00000000-0000-4000-8000-000000000006';
const UNKNOWN_ORDER = '00000000-0000-4000-8000-000000000009';

function order(id: string, overrides: Partial<PolarOrder> = {}): PolarOrder {
  return {
    id,
    created_at: '2026-10-01T00:00:00Z',
    status: 'paid',
    paid: true,
    total_amount: 6800,
    refunded_amount: 0,
    currency: 'usd',
    invoice_number: '2026-00002',
    is_invoice_generated: true,
    subscription_id: 'sub_own',
    description: 'Deployz',
    ...overrides,
  };
}

const ORDERS: PolarOrder[] = [
  order(OWN_PAID_ORDER),
  order(OWN_VOID_ORDER, { status: 'void', paid: false, invoice_number: null }),
  order(OTHER_ORG_ORDER, { subscription_id: 'sub_other' }),
  order(OWN_REFUNDED_ORDER, {
    created_at: '2026-10-15T00:00:00Z',
    status: 'partially_refunded',
    total_amount: 2275,
    refunded_amount: 1000,
    invoice_number: '2026-00003',
  }),
];

function fakePolar(
  options: {
    calls?: Calls;
    error?: Error;
    paymentMethodError?: Error;
    scheduledCancel?: boolean;
    cancelError?: Error;
  } = {},
): PolarBilling {
  const ordersById: Record<string, PolarOrder> = {
    [OWN_PAID_ORDER]: ORDERS[0]!,
    [OTHER_ORG_ORDER]: ORDERS[2]!,
    [OWN_REFUNDED_ORDER]: ORDERS[3]!,
    [OWN_UNPAID_ORDER]: order(OWN_UNPAID_ORDER, { status: 'pending', paid: false }),
    [OWN_UNGENERATED_ORDER]: order(OWN_UNGENERATED_ORDER, { is_invoice_generated: false }),
  };
  return {
    config: {
      token: 'test_replace_me',
      webhookSecret: 'test_replace_me',
      productId: 'prod_test_replace_me',
      environment: 'sandbox',
    },
    client: {
      getSubscription: async (id: string) => {
        if (options.error) throw options.error;
        options.calls?.subscriptionGets.push(id);
        return {
          id,
          status: 'active',
          amount: 8700,
          currency: 'usd',
          current_period_start: '2026-10-01T00:00:00Z',
          current_period_end: '2026-11-01T00:00:00Z',
          cancel_at_period_end: options.scheduledCancel ?? false,
          ends_at: options.scheduledCancel ? '2026-11-01T00:00:00Z' : null,
          customer_id: 'ctm_shared',
          product_id: 'prod_test_replace_me',
          checkout_id: null,
          units: 2,
          modified_at: null,
          metadata: {},
          prices: [{ amount_type: 'fixed', price_amount: 4900 }, { amount_type: 'seat_based' }],
        };
      },
      cancelSubscriptionAtPeriodEnd: async (subscriptionId: string) => {
        options.calls?.cancels.push(subscriptionId);
        if (options.cancelError) throw options.cancelError;
        return { current_period_end: '2026-12-10T00:00:00Z' };
      },
      listSubscriptionOrders: async (subscriptionId: string) => {
        options.calls?.orderLists.push(subscriptionId);
        return ORDERS;
      },
      listPaymentMethods: async (customerId: string) => {
        options.calls?.paymentMethodLists.push(customerId);
        if (options.paymentMethodError) throw options.paymentMethodError;
        return [{ type: 'card', method_metadata: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2030 } }];
      },
      getOrder: async (id: string) => {
        const found = ordersById[id];
        if (!found) throw new PolarApiError(404, 'not found');
        return found;
      },
      getOrderInvoiceUrl: async (found: PolarOrder) => {
        options.calls?.invoiceUrls.push(found.id);
        return found.is_invoice_generated ? `https://invoices.test/${found.id}.pdf` : null;
      },
    } as unknown as PolarBilling['client'],
  };
}

function newCalls(): Calls {
  return { subscriptionGets: [], orderLists: [], paymentMethodLists: [], invoiceUrls: [], cancels: [] };
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

function post(app: FastifyInstance, url: string, cookie?: string) {
  return app.inject({ method: 'POST', url, headers: cookie ? { cookie } : {} });
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

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('401s without a session', async () => {
    const app = await buildServer({ auth, db, polar: fakePolar() });
    try {
      expect((await get(app, '/api/billing/account')).statusCode).toBe(401);
      expect((await get(app, `/api/billing/invoices/${OWN_PAID_ORDER}`)).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('503s when Polar is not configured', async () => {
    const app = await buildServer({ auth, db, polar: null });
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
    const app = await buildServer({ auth, db, polar: fakePolar({ calls }) });
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
    const app = await buildServer({ auth, db, polar: fakePolar({ calls }) });
    try {
      const response = await get(app, '/api/billing/account', owner.cookie);
      expect(response.statusCode, response.body).toBe(200);
      expect(calls.subscriptionGets).toEqual(['sub_own']);
      // Orders are scoped by subscription, never by the (shareable) customer id.
      expect(calls.orderLists).toEqual(['sub_own']);
      expect(calls.paymentMethodLists).toEqual(['ctm_shared']);
      expect(response.json()).toEqual({
        nextPayment: {
          date: '2026-11-01T00:00:00Z',
          amount: '8700',
          currencyCode: 'USD',
          lines: [
            { description: 'Platform', quantity: 1, amount: '4900', currencyCode: 'USD' },
            { description: 'Customer deployments', quantity: 2, amount: '3800', currencyCode: 'USD' },
          ],
        },
        scheduledChange: null,
        paymentMethod: { type: 'card', cardBrand: 'visa', last4: '4242', expiryMonth: 4, expiryYear: 2030 },
        // A void order and another subscription's order are not invoices.
        transactions: [
          {
            id: OWN_PAID_ORDER,
            status: 'paid',
            billedAt: '2026-10-01T00:00:00Z',
            invoiceNumber: '2026-00002',
            amount: '6800',
            refundedAmount: '0',
            currencyCode: 'USD',
          },
          // A refund keeps the order on the list, with what was refunded.
          {
            id: OWN_REFUNDED_ORDER,
            status: 'partially_refunded',
            billedAt: '2026-10-15T00:00:00Z',
            invoiceNumber: '2026-00003',
            amount: '2275',
            refundedAmount: '1000',
            currencyCode: 'USD',
          },
        ],
      });
    } finally {
      await app.close();
    }
  });

  it('still answers without a payment method when Polar cannot list it', async () => {
    const app = await buildServer({
      auth,
      db,
      polar: fakePolar({ paymentMethodError: new Error('internal polar detail') }),
    });
    try {
      const response = await get(app, '/api/billing/account', owner.cookie);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ paymentMethod: null, nextPayment: { amount: '8700' } });
      expect(response.body).not.toContain('internal polar detail');
    } finally {
      await app.close();
    }
  });

  it('shows a scheduled cancellation and no next payment', async () => {
    const app = await buildServer({ auth, db, polar: fakePolar({ scheduledCancel: true }) });
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
      polar: fakePolar({ error: new Error('internal polar detail') }),
    });
    try {
      const response = await get(app, '/api/billing/account', owner.cookie);
      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({ error: { code: 'BILLING_DETAILS_UNAVAILABLE' } });
      expect(response.body).not.toContain('internal polar detail');
    } finally {
      await app.close();
    }
  });

  it("returns an invoice link for the organization's own order, refunded or not", async () => {
    const calls = newCalls();
    const app = await buildServer({ auth, db, polar: fakePolar({ calls }) });
    try {
      const response = await get(app, `/api/billing/invoices/${OWN_PAID_ORDER}`, owner.cookie);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ url: `https://invoices.test/${OWN_PAID_ORDER}.pdf` });
      const refunded = await get(app, `/api/billing/invoices/${OWN_REFUNDED_ORDER}`, owner.cookie);
      expect(refunded.json()).toEqual({ url: `https://invoices.test/${OWN_REFUNDED_ORDER}.pdf` });
    } finally {
      await app.close();
    }
  });

  it('409s while Polar is still generating the invoice', async () => {
    const calls = newCalls();
    const app = await buildServer({ auth, db, polar: fakePolar({ calls }) });
    try {
      const response = await get(app, `/api/billing/invoices/${OWN_UNGENERATED_ORDER}`, owner.cookie);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'INVOICE_NOT_READY' } });
      expect(calls.invoiceUrls).toEqual([OWN_UNGENERATED_ORDER]);
    } finally {
      await app.close();
    }
  });

  it.each([
    ['another organization’s order', OTHER_ORG_ORDER],
    ['an unpaid order', OWN_UNPAID_ORDER],
    ['an unknown order', UNKNOWN_ORDER],
    ['a malformed id', '..%2Fsubscriptions'],
  ])('404s %s and mints no link', async (_label, orderId) => {
    const calls = newCalls();
    const app = await buildServer({ auth, db, polar: fakePolar({ calls }) });
    try {
      const response = await get(app, `/api/billing/invoices/${orderId}`, owner.cookie);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'INVOICE_NOT_FOUND' } });
      expect(calls.invoiceUrls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('cancels at the end of the period and returns the end date', async () => {
    const calls = newCalls();
    const app = await buildServer({ auth, db, polar: fakePolar({ calls }) });
    try {
      const response = await post(app, '/api/billing/cancel', owner.cookie);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ endsAt: '2026-12-10T00:00:00Z' });
      expect(calls.cancels).toEqual(['sub_own']);
    } finally {
      await app.close();
    }
  });

  it('409s a subscription that already ends, and 502s other Polar failures without leaking them', async () => {
    const already = await buildServer({
      auth,
      db,
      polar: fakePolar({ cancelError: new PolarApiError(403, 'already', 'AlreadyCanceledSubscription') }),
    });
    const broken = await buildServer({ auth, db, polar: fakePolar({ cancelError: new Error('secret provider detail') }) });
    try {
      const first = await post(already, '/api/billing/cancel', owner.cookie);
      expect(first.statusCode).toBe(409);
      expect(first.json()).toMatchObject({ error: { code: 'ALREADY_CANCELLING' } });
      const second = await post(broken, '/api/billing/cancel', owner.cookie);
      expect(second.statusCode).toBe(502);
      expect(second.body).not.toContain('secret provider detail');
    } finally {
      await already.close();
      await broken.close();
    }
  });

  it('409s a cancel from an organization in evaluation and 401s without a session', async () => {
    const calls = newCalls();
    const app = await buildServer({ auth, db, polar: fakePolar({ calls }) });
    try {
      const response = await post(app, '/api/billing/cancel', evaluating.cookie);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'NO_SUBSCRIPTION' } });
      expect((await post(app, '/api/billing/cancel')).statusCode).toBe(401);
      expect(calls.cancels).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('serves the invoice PDF itself from Deployz', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        if (String(input).startsWith('https://invoices.test/')) {
          return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 });
        }
        throw new Error(`unexpected fetch ${String(input)}`);
      }),
    );
    const app = await buildServer({ auth, db, polar: fakePolar() });
    try {
      const response = await get(app, `/api/billing/invoices/${OWN_PAID_ORDER}/file`, owner.cookie);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['content-type']).toBe('application/pdf');
      expect(response.headers['content-disposition']).toContain('attachment');
      expect(response.rawPayload.toString('latin1')).toBe('%PDF');
    } finally {
      await app.close();
    }
  });

  it('409s the invoice file while it is being prepared and 404s an order of another organization', async () => {
    const app = await buildServer({ auth, db, polar: fakePolar() });
    try {
      const notReady = await get(app, `/api/billing/invoices/${OWN_UNGENERATED_ORDER}/file`, owner.cookie);
      expect(notReady.statusCode).toBe(409);
      expect(notReady.json()).toMatchObject({ error: { code: 'INVOICE_NOT_READY' } });
      const other = await get(app, `/api/billing/invoices/${OTHER_ORG_ORDER}/file`, owner.cookie);
      expect(other.statusCode).toBe(404);
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
    const app = await buildServer({ auth, db, polar: fakePolar() });
    try {
      expect((await get(app, '/api/billing/account', member.cookie)).statusCode).toBe(403);
      expect((await get(app, `/api/billing/invoices/${OWN_PAID_ORDER}`, member.cookie)).statusCode).toBe(403);
      expect((await get(app, `/api/billing/invoices/${OWN_PAID_ORDER}/file`, member.cookie)).statusCode).toBe(403);
      expect((await post(app, '/api/billing/cancel', member.cookie)).statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
