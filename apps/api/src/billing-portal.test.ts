import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import type { PolarBilling } from './polar.js';
import { buildServer } from './server.js';

// Billing Phase 12 — the customer portal. Fixture ids only
// (ctm_test_1, sub_test_1, ...); no test reaches the Polar API.

/** A Polar double: records which customer a portal URL was asked for and
 *  answers with one portal URL. */
function fakePolar(options: { calls?: string[]; error?: Error } = {}): PolarBilling {
  return {
    config: {
      token: 'test_replace_me',
      webhookSecret: 'test_replace_me',
      productId: 'prod_test_replace_me',
      environment: 'sandbox',
    },
    client: {
      createCustomerPortalUrl: async (customerId: string) => {
        if (options.error) throw options.error;
        options.calls?.push(customerId);
        return 'https://portal.test/session';
      },
    } as unknown as PolarBilling['client'],
  };
}

async function signUpAndGetOrg(
  auth: Auth,
  db: Db,
  email: string,
): Promise<{ organizationId: string; cookie: string }> {
  const password = 'super-secret-1';
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
  return { organizationId, cookie: setCookie };
}

function postPortal(app: FastifyInstance, cookie?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/billing/portal',
    headers: cookie ? { cookie } : {},
  });
}

describe('POST /api/billing/portal (billing Phase 12)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let org: { organizationId: string; cookie: string };

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, `portal-${crypto.randomUUID()}@example.com`);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('401s without a session', async () => {
    const app = await buildServer({ auth, db, polar: fakePolar() });
    try {
      expect((await postPortal(app)).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('503s when Polar is not configured', async () => {
    const app = await buildServer({ auth, db, polar: null });
    try {
      const response = await postPortal(app, org.cookie);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: 'BILLING_DISABLED' } });
    } finally {
      await app.close();
    }
  });

  it('409s an organization in evaluation — there is nothing to manage', async () => {
    const calls: string[] = [];
    const app = await buildServer({ auth, db, polar: fakePolar({ calls }) });
    try {
      const response = await postPortal(app, org.cookie);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'NO_SUBSCRIPTION' } });
      expect(calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("mints a link for the organization's OWN customer", async () => {
    await db.insert(schema.billingSubscriptions).values({
      organizationId: org.organizationId,
      providerCustomerId: 'ctm_test_1',
      providerSubscriptionId: 'sub_test_1',
      status: 'ACTIVE',
    });
    const calls: string[] = [];
    const app = await buildServer({ auth, db, polar: fakePolar({ calls }) });
    try {
      const response = await postPortal(app, org.cookie);
      expect(response.statusCode, response.body).toBe(200);
      // The session's authorization IS the customer id on file — never a
      // value from the request.
      expect(calls).toEqual(['ctm_test_1']);
      // Polar's portal has one entry page; every target lands there.
      expect(response.json()).toEqual({
        overview: 'https://portal.test/session',
        updatePaymentMethod: 'https://portal.test/session',
        cancel: 'https://portal.test/session',
      });
    } finally {
      await app.close();
    }
  });

  it('502s without leaking the provider error when Polar refuses', async () => {
    const app = await buildServer({
      auth,
      db,
      polar: fakePolar({ error: new Error('internal polar detail') }),
    });
    try {
      const response = await postPortal(app, org.cookie);
      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({ error: { code: 'PORTAL_UNAVAILABLE' } });
      expect(response.body).not.toContain('internal polar detail');
    } finally {
      await app.close();
    }
  });
});
