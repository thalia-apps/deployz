import { PGlite } from '@electric-sql/pglite';
import { and, desc, eq, gt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from '../auth.js';
import type { PolarBilling } from '../polar.js';
import { buildServer } from '../server.js';

// Included production deployments — the admin mutation
// (docs/billing/polar-billing.md, "Included production deployments"). These tests cover
// the admin wrapping: authorization, validation, the audit row, and that a
// real change on a subscribed organization runs reconcileBilling and pushes
// max(active − included, 1) units. The formula itself is billing-reconcile.test.ts.

interface PolarState {
  units: number;
  updates: number[];
  fail?: Error;
}

/** A Polar double whose subscription holds `units`; an update sets them. */
function fakePolar(state: PolarState): PolarBilling {
  return {
    config: {
      token: 'polar_oat_test_replace_me',
      webhookSecret: 'test_replace_me',
      productId: 'prod_test_1',
      environment: 'sandbox',
    },
    client: {
      getSubscription: async (id: string) => ({ id, status: 'active', units: state.units }),
      updateSubscriptionUnits: async (id: string, units: number) => {
        if (state.fail) throw state.fail;
        state.updates.push(units);
        state.units = units;
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

function setAllowance(app: FastifyInstance, vendorId: string, cookie: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: `/api/admin/vendors/${vendorId}/included-deployments`,
    headers: { cookie, 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

// event_logs is append-only (the immutability trigger rejects DELETE), so
// each test reads only the audit rows written after its own baseline.
let auditBaseline = 0;

function auditRows(db: Db, organizationId: string) {
  return db
    .select()
    .from(schema.eventLogs)
    .where(
      and(
        eq(schema.eventLogs.organizationId, organizationId),
        eq(schema.eventLogs.eventType, 'admin.billing.included_deployments.updated'),
        gt(schema.eventLogs.id, auditBaseline),
      ),
    )
    .orderBy(schema.eventLogs.id);
}

async function allowanceOf(db: Db, organizationId: string): Promise<number> {
  const [row] = await db
    .select({ included: schema.organization.includedProductionDeployments })
    .from(schema.organization)
    .where(eq(schema.organization.id, organizationId));
  return row!.included;
}

describe('admin included production deployments', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let admin: { userId: string; organizationId: string; cookie: string };
  let vendor: { userId: string; organizationId: string; cookie: string };
  let ids: { applicationId: string; customerId: string };
  const polarState: PolarState = { units: 1, updates: [] };

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    admin = await signUpAndGetOrg(auth, db, `admin-${crypto.randomUUID()}@example.com`);
    await db.update(schema.user).set({ platformRole: 'ADMIN' }).where(eq(schema.user.id, admin.userId));
    vendor = await signUpAndGetOrg(auth, db, `vendor-${crypto.randomUUID()}@example.com`);
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId: vendor.organizationId,
        name: 'Allowance App',
        repoFullName: 'acme/allowance',
        repoUrl: 'https://github.com/acme/allowance',
      })
      .returning();
    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId: vendor.organizationId, name: 'Buyer', email: 'buyer@example.com' })
      .returning();
    ids = { applicationId: application!.id, customerId: customer!.id };
    app = await buildServer({
      auth,
      db,
      polar: fakePolar(polarState),
      teamAdminEmails: [],
      teamAdminEnvGrantsEnabled: false,
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  beforeEach(async () => {
    const [latest] = await db
      .select({ id: schema.eventLogs.id })
      .from(schema.eventLogs)
      .orderBy(desc(schema.eventLogs.id))
      .limit(1);
    auditBaseline = latest?.id ?? 0;
    polarState.units = 1;
    polarState.updates.length = 0;
    delete polarState.fail;
    await db.delete(schema.billingReconciliationEvents);
    await db.delete(schema.deployments);
    await db.delete(schema.billingSubscriptions);
    await db
      .update(schema.organization)
      .set({ includedProductionDeployments: 0 })
      .where(eq(schema.organization.id, vendor.organizationId));
  });

  async function addLiveDeployments(count: number, deploymentType: 'TEST' | 'PRODUCTION' = 'PRODUCTION') {
    for (let i = 0; i < count; i += 1) {
      await db.insert(schema.deployments).values({
        organizationId: vendor.organizationId,
        applicationId: ids.applicationId,
        customerId: ids.customerId,
        region: 'us-east-1',
        enrollmentCode: crypto.randomUUID(),
        deploymentType,
        billingState: 'ACTIVE',
      });
    }
  }

  async function subscribe(status: 'ACTIVE' | 'PAST_DUE' | 'PAUSED' | 'CANCELED' = 'ACTIVE') {
    await db.insert(schema.billingSubscriptions).values({
      organizationId: vendor.organizationId,
      providerCustomerId: 'ctm_test_1',
      providerSubscriptionId: 'sub_test_1',
      status,
    });
  }

  describe('authorization', () => {
    it('refuses a plain vendor session with NOT_TEAM_ADMIN and writes nothing', async () => {
      const response = await setAllowance(app, vendor.organizationId, vendor.cookie, {
        includedProductionDeployments: 5,
        reason: 'self-service',
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_TEAM_ADMIN' } });
      expect(await allowanceOf(db, vendor.organizationId)).toBe(0);
      expect(await auditRows(db, vendor.organizationId)).toHaveLength(0);
    });

    it('refuses an anonymous request', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/vendors/${vendor.organizationId}/included-deployments`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ includedProductionDeployments: 1, reason: 'anon' }),
      });
      expect(response.statusCode).toBe(401);
    });

    it('404s an unknown vendor', async () => {
      const response = await setAllowance(app, crypto.randomUUID(), admin.cookie, {
        includedProductionDeployments: 1,
        reason: 'nobody',
      });
      expect(response.statusCode).toBe(404);
    });

    it('the vendor organization update endpoint ignores the field — no vendor write path exists', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/organization',
        headers: { cookie: vendor.cookie, 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'Renamed', includedProductionDeployments: 50 }),
      });
      expect([200, 404, 405]).toContain(response.statusCode);
      expect(await allowanceOf(db, vendor.organizationId)).toBe(0);
    });
  });

  describe('validation', () => {
    it.each([
      ['negative', -1],
      ['decimal', 1.5],
      ['string', '2'],
      ['over the maximum', 10001],
      ['missing', undefined],
    ])('rejects a %s value with VALIDATION_ERROR', async (_label, value) => {
      const response = await setAllowance(app, vendor.organizationId, admin.cookie, {
        includedProductionDeployments: value,
        reason: 'testing bounds',
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
      expect(await allowanceOf(db, vendor.organizationId)).toBe(0);
    });

    it.each([
      ['blank', ''],
      ['whitespace', '   '],
      ['missing', undefined],
    ])('rejects a %s reason', async (_label, reason) => {
      const response = await setAllowance(app, vendor.organizationId, admin.cookie, {
        includedProductionDeployments: 2,
        reason,
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(await allowanceOf(db, vendor.organizationId)).toBe(0);
      expect(await auditRows(db, vendor.organizationId)).toHaveLength(0);
    });

    it('accepts the maximum', async () => {
      const response = await setAllowance(app, vendor.organizationId, admin.cookie, {
        includedProductionDeployments: 10000,
        reason: 'stress',
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(await allowanceOf(db, vendor.organizationId)).toBe(10000);
    });
  });

  describe('before any subscription', () => {
    it('stores the allowance, audits it, and makes no provider call', async () => {
      const response = await setAllowance(app, vendor.organizationId, admin.cookie, {
        includedProductionDeployments: 3,
        reason: 'Design partner pilot',
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        organizationId: vendor.organizationId,
        activeProductionDeployments: 0,
        previous: { includedProductionDeployments: 0, billableDeploymentQuantity: 0 },
        current: { includedProductionDeployments: 3, billableDeploymentQuantity: 0 },
        changed: true,
        reconciliation: null,
      });
      expect(await allowanceOf(db, vendor.organizationId)).toBe(3);
      expect(polarState.updates).toHaveLength(0);
      // No subscription was created by the allowance itself.
      expect(await db.select().from(schema.billingSubscriptions)).toHaveLength(0);

      const rows = await auditRows(db, vendor.organizationId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorType: 'user', actorId: admin.userId, result: 'success' });
      expect(rows[0]!.payload).toMatchObject({
        targetType: 'organization',
        targetId: vendor.organizationId,
        reason: 'Design partner pilot',
        previousIncludedProductionDeployments: 0,
        includedProductionDeployments: 3,
        activeProductionDeployments: 0,
        previousBillableDeploymentQuantity: 0,
        billableDeploymentQuantity: 0,
        changed: true,
        reconciliationTriggered: false,
        reconciliation: null,
      });
      expect(typeof rows[0]!.payload.adminEmail).toBe('string');
      // Nothing secret in the audit row.
      expect(JSON.stringify(rows[0]!.payload)).not.toMatch(/webhookSecret|polar_oat|prod_test|sub_test/);
    });

    it('the allowance shows on the vendor detail with a zero billable quantity', async () => {
      await setAllowance(app, vendor.organizationId, admin.cookie, { includedProductionDeployments: 2, reason: 'pilot' });
      const detail = await app.inject({
        method: 'GET',
        url: `/api/admin/vendors/${vendor.organizationId}`,
        headers: { cookie: admin.cookie },
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().billing).toMatchObject({
        activeProductionDeployments: 0,
        includedProductionDeployments: 2,
        billableDeploymentQuantity: 0,
        providerDeploymentQuantity: null,
        monthlyRateDollars: null,
      });
    });
  });

  describe('with an active subscription', () => {
    it('an increase reduces the Polar units immediately (5 live, 0 → 2 included, units 5 → 3)', async () => {
      await subscribe();
      await addLiveDeployments(5);
      polarState.units = 5;

      const response = await setAllowance(app, vendor.organizationId, admin.cookie, {
        includedProductionDeployments: 2,
        reason: 'Design partner pilot',
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        activeProductionDeployments: 5,
        previous: { includedProductionDeployments: 0, billableDeploymentQuantity: 5 },
        current: { includedProductionDeployments: 2, billableDeploymentQuantity: 3 },
        changed: true,
        reconciliation: { status: 'SUCCEEDED', action: 'QUANTITY_UPDATED', expected: 3, provider: 5 },
      });
      expect(polarState.updates).toEqual([3]);

      const rows = await auditRows(db, vendor.organizationId);
      expect(rows[0]!.payload).toMatchObject({
        previousBillableDeploymentQuantity: 5,
        billableDeploymentQuantity: 3,
        reconciliationTriggered: true,
        reconciliation: { status: 'SUCCEEDED', action: 'QUANTITY_UPDATED', expected: 3, provider: 5 },
      });
    });

    it('a decrease raises the Polar units (5 live, 3 → 0 included, units 2 → 5)', async () => {
      await subscribe();
      await addLiveDeployments(5);
      await db
        .update(schema.organization)
        .set({ includedProductionDeployments: 3 })
        .where(eq(schema.organization.id, vendor.organizationId));
      polarState.units = 2;

      const response = await setAllowance(app, vendor.organizationId, admin.cookie, {
        includedProductionDeployments: 0,
        reason: 'Pilot ended',
      });
      expect(response.json()).toMatchObject({
        previous: { includedProductionDeployments: 3, billableDeploymentQuantity: 2 },
        current: { includedProductionDeployments: 0, billableDeploymentQuantity: 5 },
        reconciliation: { status: 'SUCCEEDED', action: 'QUANTITY_UPDATED', expected: 5, provider: 2 },
      });
      expect(polarState.units).toBe(5);
    });

    it('covering every live deployment drops Polar to the floor of one unit, never zero', async () => {
      await subscribe();
      await addLiveDeployments(2);
      polarState.units = 2;

      const response = await setAllowance(app, vendor.organizationId, admin.cookie, {
        includedProductionDeployments: 2,
        reason: 'pilot',
      });
      expect(response.json()).toMatchObject({
        current: { includedProductionDeployments: 2, billableDeploymentQuantity: 0 },
        reconciliation: { action: 'QUANTITY_UPDATED', expected: 1, provider: 2 },
      });
      expect(polarState.updates).toEqual([1]);
    });

    it('a same-value update is audited but reconciles nothing', async () => {
      await subscribe();
      await addLiveDeployments(1);
      await setAllowance(app, vendor.organizationId, admin.cookie, { includedProductionDeployments: 1, reason: 'a' });
      polarState.updates.length = 0;

      const response = await setAllowance(app, vendor.organizationId, admin.cookie, {
        includedProductionDeployments: 1,
        reason: 'no-op',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ changed: false, reconciliation: null });
      expect(polarState.updates).toHaveLength(0);
      const rows = await auditRows(db, vendor.organizationId);
      expect(rows).toHaveLength(2);
      expect(rows[1]!.payload).toMatchObject({ changed: false, reconciliationTriggered: false, reason: 'no-op' });
    });

    it('TEST deployments never count and never consume the allowance', async () => {
      await subscribe();
      await addLiveDeployments(1, 'TEST');
      await addLiveDeployments(1);

      const response = await setAllowance(app, vendor.organizationId, admin.cookie, {
        includedProductionDeployments: 1,
        reason: 'pilot',
      });
      expect(response.json()).toMatchObject({
        activeProductionDeployments: 1,
        current: { billableDeploymentQuantity: 0 },
      });
    });

    it('a Polar failure keeps the new allowance, records the drift, and a retry repairs it', async () => {
      await subscribe();
      await addLiveDeployments(4);
      polarState.units = 4;
      polarState.fail = new Error('polar unavailable');

      const response = await setAllowance(app, vendor.organizationId, admin.cookie, {
        includedProductionDeployments: 1,
        reason: 'pilot',
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        changed: true,
        reconciliation: { status: 'FAILED', expected: 3, reason: 'polar unavailable' },
      });
      // The admin's intent survives the outage.
      expect(await allowanceOf(db, vendor.organizationId)).toBe(1);
      const rows = await auditRows(db, vendor.organizationId);
      expect(rows[0]!.payload).toMatchObject({ reconciliation: { status: 'FAILED' } });

      // The mismatch is diagnosable on the vendor detail...
      const detail = await app.inject({
        method: 'GET',
        url: `/api/admin/vendors/${vendor.organizationId}`,
        headers: { cookie: admin.cookie },
      });
      expect(detail.json().billing).toMatchObject({
        includedProductionDeployments: 1,
        billableDeploymentQuantity: 3,
      });
      expect(detail.json().billing.recentReconciliations[0]).toMatchObject({ status: 'FAILED', expected: 3 });

      // ...and the existing Reconcile action repairs it once Polar is back.
      delete polarState.fail;
      const retry = await app.inject({
        method: 'POST',
        url: `/api/admin/vendors/${vendor.organizationId}/reconcile-billing`,
        headers: { cookie: admin.cookie, 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(retry.json()).toMatchObject({ status: 'SUCCEEDED', expected: 3, provider: 4 });
      expect(polarState.units).toBe(3);
    });

    it('two concurrent updates each audit the value the other left, and the end state is consistent', async () => {
      await subscribe();
      await addLiveDeployments(3);

      const [first, second] = await Promise.all([
        setAllowance(app, vendor.organizationId, admin.cookie, { includedProductionDeployments: 1, reason: 'one' }),
        setAllowance(app, vendor.organizationId, admin.cookie, { includedProductionDeployments: 2, reason: 'two' }),
      ]);
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);

      const rows = await auditRows(db, vendor.organizationId);
      expect(rows).toHaveLength(2);
      const previous = rows.map((row) => row.payload.previousIncludedProductionDeployments).sort();
      // One saw 0, the other saw whatever the first wrote — never both 0.
      expect(previous[0]).toBe(0);
      expect([1, 2]).toContain(previous[1]);
      const final = await allowanceOf(db, vendor.organizationId);
      expect([1, 2]).toContain(final);
      // Whatever landed last, Polar converged on the absolute formula for it.
      expect(polarState.units).toBe(Math.max(3 - final, 1));
    });
  });

  describe('subscription states', () => {
    it.each(['PAUSED', 'CANCELED'] as const)('%s: the allowance is stored, reconciliation is SKIPPED', async (status) => {
      await subscribe(status);
      await addLiveDeployments(2);

      const response = await setAllowance(app, vendor.organizationId, admin.cookie, {
        includedProductionDeployments: 1,
        reason: 'pilot',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().reconciliation).toMatchObject({ status: 'SKIPPED', expected: 1 });
      expect(await allowanceOf(db, vendor.organizationId)).toBe(1);
      expect(polarState.updates).toHaveLength(0);
    });

    it('PAST_DUE still reconciles', async () => {
      await subscribe('PAST_DUE');
      await addLiveDeployments(2);
      polarState.units = 2;

      const response = await setAllowance(app, vendor.organizationId, admin.cookie, {
        includedProductionDeployments: 1,
        reason: 'pilot',
      });
      expect(response.json().reconciliation).toMatchObject({ status: 'SUCCEEDED', expected: 1 });
    });
  });

  it('the audit event appears in the admin audit log with the reason', async () => {
    await setAllowance(app, vendor.organizationId, admin.cookie, {
      includedProductionDeployments: 4,
      reason: 'Audit visibility',
    });
    const log = await app.inject({
      method: 'GET',
      url: '/api/admin/audit-log?action=admin.billing',
      headers: { cookie: admin.cookie },
    });
    expect(log.statusCode).toBe(200);
    const events = log.json().events as { eventType: string; payload: Record<string, unknown> }[];
    const event = events.find((row) => row.eventType === 'admin.billing.included_deployments.updated');
    expect(event?.payload).toMatchObject({ reason: 'Audit visibility', includedProductionDeployments: 4 });
  });
});
