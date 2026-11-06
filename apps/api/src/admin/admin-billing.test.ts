import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from '../auth.js';
import type { PolarBilling } from '../polar.js';
import { buildServer } from '../server.js';

// The admin's billing view and Reconcile action. Reconcile runs the SAME
// reconcileBilling the safety job runs; these tests cover the admin wrapping
// (authorization, audit, what the detail exposes), not reconciliation itself
// (billing-reconcile.test.ts). Fixture ids only.

/** A Polar double answering as a subscription at the floor of one unit. */
function fakePolar(updates: number[] = []): PolarBilling {
  return {
    config: {
      token: 'polar_oat_test_replace_me',
      webhookSecret: 'test_replace_me',
      productId: 'prod_test_1',
      environment: 'sandbox',
    },
    client: {
      getSubscription: async (id: string) => ({ id, status: 'active', units: 1 }),
      updateSubscriptionUnits: async (id: string, units: number) => {
        updates.push(units);
        return { id, status: 'active', units };
      },
    } as unknown as PolarBilling['client'],
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

function reconcile(app: FastifyInstance, vendorId: string, cookie: string) {
  return app.inject({
    method: 'POST',
    url: `/api/admin/vendors/${vendorId}/reconcile-billing`,
    headers: { cookie, 'content-type': 'application/json' },
    payload: '{}',
  });
}

function auditRows(db: Db, organizationId: string) {
  return db
    .select()
    .from(schema.eventLogs)
    .where(
      and(
        eq(schema.eventLogs.organizationId, organizationId),
        eq(schema.eventLogs.eventType, 'admin.billing.reconcile_requested'),
      ),
    )
    .orderBy(schema.eventLogs.id);
}

describe('admin billing', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let admin: { userId: string; organizationId: string; cookie: string };
  let vendor: { userId: string; organizationId: string; cookie: string };
  const updates: number[] = [];

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    admin = await signUpAndGetOrg(auth, db, `admin-${crypto.randomUUID()}@example.com`);
    await db.update(schema.user).set({ platformRole: 'ADMIN' }).where(eq(schema.user.id, admin.userId));
    vendor = await signUpAndGetOrg(auth, db, `vendor-${crypto.randomUUID()}@example.com`);
    app = await buildServer({
      auth,
      db,
      polar: fakePolar(updates),
      teamAdminEmails: [],
      teamAdminEnvGrantsEnabled: false,
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('refuses a plain vendor session with NOT_TEAM_ADMIN', async () => {
    const response = await reconcile(app, vendor.organizationId, vendor.cookie);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_TEAM_ADMIN' } });
  });

  it('404s an unknown vendor', async () => {
    const response = await reconcile(app, crypto.randomUUID(), admin.cookie);
    expect(response.statusCode).toBe(404);
  });

  it('an organization in evaluation reconciles as SKIPPED — and the attempt is still audited', async () => {
    const response = await reconcile(app, vendor.organizationId, admin.cookie);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ status: 'SKIPPED', reason: 'no subscription', expected: 1 });
    const rows = await auditRows(db, vendor.organizationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: admin.userId, result: 'SKIPPED' });
    expect(updates).toHaveLength(0);
  });

  it('a subscribed vendor with two live deployments is pushed to Polar, audited, and shown on the detail', async () => {
    await db.insert(schema.billingSubscriptions).values({
      organizationId: vendor.organizationId,
      providerCustomerId: 'ctm_test_1',
      providerSubscriptionId: 'sub_test_1',
      status: 'ACTIVE',
    });
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId: vendor.organizationId,
        name: 'Billing App',
        repoFullName: 'acme/billing',
        repoUrl: 'https://github.com/acme/billing',
      })
      .returning();
    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId: vendor.organizationId, name: 'Buyer', email: 'buyer@example.com' })
      .returning();
    for (let i = 0; i < 2; i += 1) {
      await db.insert(schema.deployments).values({
        organizationId: vendor.organizationId,
        applicationId: application!.id,
        customerId: customer!.id,
        region: 'us-east-1',
        enrollmentCode: crypto.randomUUID(),
        deploymentType: 'PRODUCTION',
        billingState: 'ACTIVE',
      });
    }

    const response = await reconcile(app, vendor.organizationId, admin.cookie);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ status: 'SUCCEEDED', action: 'QUANTITY_UPDATED', expected: 2, provider: 1 });
    expect(updates).toEqual([2]);

    const rows = await auditRows(db, vendor.organizationId);
    expect(rows).toHaveLength(2);
    expect(rows.at(-1)).toMatchObject({ result: 'SUCCEEDED' });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/admin/vendors/${vendor.organizationId}`,
      headers: { cookie: admin.cookie },
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const billing = (detail.json() as { billing: { activeProductionDeployments: number; providerDeploymentQuantity: number | null; monthlyRateDollars: number | null; subscription: { providerSubscriptionId: string; lastReconciledAt: string | null } | null; recentReconciliations: { action: string; status: string }[] } }).billing;
    expect(billing.activeProductionDeployments).toBe(2);
    expect(billing.providerDeploymentQuantity).toBe(2);
    expect(billing.monthlyRateDollars).toBe(49 + 2 * 19);
    expect(billing.subscription).toMatchObject({ providerSubscriptionId: 'sub_test_1' });
    expect(billing.subscription?.lastReconciledAt).not.toBeNull();
    expect(billing.recentReconciliations[0]).toMatchObject({ action: 'QUANTITY_UPDATED', status: 'SUCCEEDED' });
  });
});
