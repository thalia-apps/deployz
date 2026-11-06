import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { reconcileBilling } from './billing-reconcile.js';
import type { PolarBilling } from './polar.js';

// Reconciliation pushes the ABSOLUTE unit count — live production
// deployments beyond the allowance, with a floor of one — onto the Polar
// subscription. Fixture ids only (sub_test_1, prod_test_1, ...).

interface UpdateCall {
  subscriptionId: string;
  units: number;
}

/** A Polar double: `getSubscription` returns the units under test,
 *  `updateSubscriptionUnits` records what reconciliation asked for. */
function fakePolar(options: {
  units?: number | null;
  getError?: Error;
  updateError?: Error;
  updates?: UpdateCall[];
}): PolarBilling {
  return {
    config: {
      token: 'polar_oat_test_replace_me',
      webhookSecret: 'test_replace_me',
      productId: 'prod_test_1',
      environment: 'sandbox',
    },
    client: {
      getSubscription: async (id: string) => {
        if (options.getError) throw options.getError;
        return { id, status: 'active', units: options.units === undefined ? 1 : options.units };
      },
      updateSubscriptionUnits: async (subscriptionId: string, units: number) => {
        if (options.updateError) throw options.updateError;
        options.updates?.push({ subscriptionId, units });
        return { id: subscriptionId, status: 'active', units };
      },
    } as unknown as PolarBilling['client'],
  };
}

const ORG = 'org_reconcile';

async function seedOrg(db: Db): Promise<{ applicationId: string; customerId: string }> {
  await db.insert(schema.organization).values({ id: ORG, name: 'Acme', slug: 'acme-reconcile' });
  const [application] = await db
    .insert(schema.applications)
    .values({
      organizationId: ORG,
      name: 'shop',
      repoFullName: 'acme/shop',
      repoUrl: 'https://github.com/acme/shop',
    })
    .returning();
  const [customer] = await db
    .insert(schema.customers)
    .values({ organizationId: ORG, name: 'Buyer', email: 'buyer@example.com' })
    .returning();
  return { applicationId: application!.id, customerId: customer!.id };
}

describe('reconcileBilling', () => {
  let client: PGlite | undefined;
  let db: Db;
  let ids: { applicationId: string; customerId: string };

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    ids = await seedOrg(db);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  beforeEach(async () => {
    await db.delete(schema.billingReconciliationEvents);
    await db.delete(schema.deployments);
    await db.delete(schema.billingSubscriptions);
    await setIncluded(0);
  });

  /** The organization's included production deployments (admin-set allowance). */
  async function setIncluded(included: number): Promise<void> {
    await db
      .update(schema.organization)
      .set({ includedProductionDeployments: included })
      .where(eq(schema.organization.id, ORG));
  }

  async function addDeployment(
    deploymentType: 'TEST' | 'PRODUCTION',
    billingState: 'NOT_STARTED' | 'ACTIVE' | 'STOPPED',
  ): Promise<void> {
    await db.insert(schema.deployments).values({
      organizationId: ORG,
      applicationId: ids.applicationId,
      customerId: ids.customerId,
      region: 'us-east-1',
      enrollmentCode: crypto.randomUUID(),
      deploymentType,
      billingState,
    });
  }

  async function addSubscription(status: 'ACTIVE' | 'PAST_DUE' | 'PAUSED' | 'CANCELED'): Promise<void> {
    await db.insert(schema.billingSubscriptions).values({
      organizationId: ORG,
      providerCustomerId: 'ctm_test_1',
      providerSubscriptionId: 'sub_test_1',
      status,
    });
  }

  function reconciliationRows() {
    return db
      .select()
      .from(schema.billingReconciliationEvents)
      .where(eq(schema.billingReconciliationEvents.organizationId, ORG));
  }

  it('counts only live PRODUCTION deployments — TEST and non-ACTIVE never bill', async () => {
    await addSubscription('ACTIVE');
    await addDeployment('PRODUCTION', 'ACTIVE');
    await addDeployment('PRODUCTION', 'ACTIVE');
    await addDeployment('PRODUCTION', 'NOT_STARTED');
    await addDeployment('PRODUCTION', 'STOPPED');
    await addDeployment('TEST', 'ACTIVE');
    const updates: UpdateCall[] = [];

    const result = await reconcileBilling({ db, polar: fakePolar({ units: 1, updates }) }, ORG);

    expect(result).toMatchObject({ status: 'SUCCEEDED', action: 'QUANTITY_UPDATED', expected: 2, provider: 1 });
    expect(updates).toEqual([{ subscriptionId: 'sub_test_1', units: 2 }]);
  });

  it('sends the absolute unit count, so running twice is the same as running once', async () => {
    await addSubscription('ACTIVE');
    await addDeployment('PRODUCTION', 'ACTIVE');
    await addDeployment('PRODUCTION', 'ACTIVE');
    await addDeployment('PRODUCTION', 'ACTIVE');
    const updates: UpdateCall[] = [];
    const polar = fakePolar({ units: 1, updates });

    await reconcileBilling({ db, polar }, ORG);
    await reconcileBilling({ db, polar }, ORG);

    // Both passes ask for 3 — never 1 + 2, and never 3 + 3.
    expect(updates.map((u) => u.units)).toEqual([3, 3]);
  });

  it('keeps the floor of one unit when the last live deployment goes away', async () => {
    await addSubscription('ACTIVE');
    await addDeployment('PRODUCTION', 'STOPPED');
    const updates: UpdateCall[] = [];

    const result = await reconcileBilling({ db, polar: fakePolar({ units: 2, updates }) }, ORG);

    expect(result).toMatchObject({ status: 'SUCCEEDED', action: 'QUANTITY_UPDATED', active: 0, expected: 1, provider: 2 });
    // Never zero units: the subscription always bills one customer deployment.
    expect(updates).toEqual([{ subscriptionId: 'sub_test_1', units: 1 }]);
  });

  it('treats a subscription with no units as zero and sets the floor', async () => {
    await addSubscription('ACTIVE');
    const updates: UpdateCall[] = [];

    const result = await reconcileBilling({ db, polar: fakePolar({ units: null, updates }) }, ORG);

    expect(result).toMatchObject({ status: 'SUCCEEDED', action: 'QUANTITY_UPDATED', active: 0, expected: 1, provider: 0 });
    expect(updates).toEqual([{ subscriptionId: 'sub_test_1', units: 1 }]);
  });

  it('writes no reconciliation row when the provider already agrees, but stamps lastReconciledAt', async () => {
    await addSubscription('ACTIVE');
    await addDeployment('PRODUCTION', 'ACTIVE');
    const updates: UpdateCall[] = [];

    const result = await reconcileBilling({ db, polar: fakePolar({ units: 1, updates }) }, ORG);

    expect(result).toMatchObject({ status: 'SUCCEEDED', action: 'NONE', expected: 1, provider: 1 });
    expect(updates).toHaveLength(0);
    expect(await reconciliationRows()).toHaveLength(0);
    const [subscription] = await db
      .select()
      .from(schema.billingSubscriptions)
      .where(eq(schema.billingSubscriptions.organizationId, ORG));
    expect(subscription!.lastReconciledAt).not.toBeNull();
  });

  it('leaves a subscription with no live deployment at one unit alone', async () => {
    await addSubscription('ACTIVE');
    const updates: UpdateCall[] = [];

    const result = await reconcileBilling({ db, polar: fakePolar({ units: 1, updates }) }, ORG);

    expect(result).toMatchObject({ status: 'SUCCEEDED', action: 'NONE', active: 0, expected: 1, provider: 1 });
    expect(updates).toHaveLength(0);
  });

  it('records the change it made', async () => {
    await addSubscription('ACTIVE');
    await addDeployment('PRODUCTION', 'ACTIVE');
    await addDeployment('PRODUCTION', 'ACTIVE');

    await reconcileBilling({ db, polar: fakePolar({ units: 5 }) }, ORG);

    const rows = await reconciliationRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      expectedDeploymentQuantity: 2,
      providerDeploymentQuantity: 5,
      action: 'QUANTITY_UPDATED',
      status: 'SUCCEEDED',
    });
  });

  it('never throws when Polar fails — it records FAILED and returns', async () => {
    await addSubscription('ACTIVE');
    await addDeployment('PRODUCTION', 'ACTIVE');

    const result = await reconcileBilling(
      { db, polar: fakePolar({ units: 0, updateError: new Error('polar is down') }) },
      ORG,
    );

    expect(result).toMatchObject({ status: 'FAILED', expected: 1, reason: 'polar is down' });
    const rows = await reconciliationRows();
    expect(rows[0]).toMatchObject({ status: 'FAILED', error: 'polar is down', expectedDeploymentQuantity: 1 });
  });

  it('records FAILED when reading the subscription fails', async () => {
    await addSubscription('ACTIVE');
    await addDeployment('PRODUCTION', 'ACTIVE');
    const updates: UpdateCall[] = [];

    const result = await reconcileBilling(
      { db, polar: fakePolar({ getError: new Error('polar read failed'), updates }) },
      ORG,
    );

    expect(result).toMatchObject({ status: 'FAILED', provider: null, reason: 'polar read failed' });
    expect(updates).toHaveLength(0);
    expect(await reconciliationRows()).toHaveLength(1);
  });

  it('skips silently when billing is not configured', async () => {
    await addSubscription('ACTIVE');
    await addDeployment('PRODUCTION', 'ACTIVE');

    const result = await reconcileBilling({ db, polar: null }, ORG);

    expect(result).toMatchObject({ status: 'SKIPPED', reason: 'billing disabled', expected: 1 });
    expect(await reconciliationRows()).toHaveLength(0);
  });

  it('skips an organization in evaluation with nothing to bill, and writes no row', async () => {
    await addDeployment('TEST', 'ACTIVE');

    const result = await reconcileBilling({ db, polar: fakePolar({}) }, ORG);

    expect(result).toMatchObject({ status: 'SKIPPED', reason: 'no subscription', active: 0, expected: 1 });
    expect(await reconciliationRows()).toHaveLength(0);
  });

  it('records the anomaly of a live production deployment with no subscription', async () => {
    await addDeployment('PRODUCTION', 'ACTIVE');

    const result = await reconcileBilling({ db, polar: fakePolar({}) }, ORG);

    expect(result).toMatchObject({ status: 'SKIPPED', reason: 'no subscription', expected: 1 });
    const rows = await reconciliationRows();
    expect(rows[0]).toMatchObject({ status: 'SKIPPED', expectedDeploymentQuantity: 1, error: 'no subscription' });
  });

  it.each(['PAUSED', 'CANCELED'] as const)(
    'does not try to update a %s subscription',
    async (status) => {
      await addSubscription(status);
      await addDeployment('PRODUCTION', 'ACTIVE');
      const updates: UpdateCall[] = [];

      const result = await reconcileBilling({ db, polar: fakePolar({ units: 0, updates }) }, ORG);

      expect(result).toMatchObject({ status: 'SKIPPED', reason: `subscription is ${status}` });
      expect(updates).toHaveLength(0);
      expect(await reconciliationRows()).toHaveLength(1);
    },
  );

  it('writes no anomaly row for a CANCELED subscription with nothing beyond the allowance', async () => {
    await addSubscription('CANCELED');
    const updates: UpdateCall[] = [];

    const result = await reconcileBilling({ db, polar: fakePolar({ units: 0, updates }) }, ORG);

    expect(result).toMatchObject({ status: 'SKIPPED', reason: 'subscription is CANCELED', expected: 1 });
    expect(updates).toHaveLength(0);
    expect(await reconciliationRows()).toHaveLength(0);
  });

  it('reconciles a PAST_DUE subscription — Polar is still billing it', async () => {
    await addSubscription('PAST_DUE');
    await addDeployment('PRODUCTION', 'ACTIVE');
    await addDeployment('PRODUCTION', 'ACTIVE');
    const updates: UpdateCall[] = [];

    const result = await reconcileBilling({ db, polar: fakePolar({ units: 1, updates }) }, ORG);

    expect(result.status).toBe('SUCCEEDED');
    expect(updates).toEqual([{ subscriptionId: 'sub_test_1', units: 2 }]);
  });

  // ── Included production deployments ─────────────────────────────────────
  // The allowance reduces ONLY the billable count: Polar receives
  // max(active - included, 1) units and never learns the allowance itself.
  describe('included production deployments', () => {
    it('subtracts the allowance from the live count', async () => {
      await addSubscription('ACTIVE');
      await setIncluded(2);
      for (let i = 0; i < 5; i += 1) await addDeployment('PRODUCTION', 'ACTIVE');
      const updates: UpdateCall[] = [];

      const result = await reconcileBilling({ db, polar: fakePolar({ units: 1, updates }) }, ORG);

      expect(result).toMatchObject({ status: 'SUCCEEDED', action: 'QUANTITY_UPDATED', active: 5, included: 2, expected: 3 });
      expect(updates).toEqual([{ subscriptionId: 'sub_test_1', units: 3 }]);
    });

    it('drops to the floor of one unit when every live deployment is included', async () => {
      await addSubscription('ACTIVE');
      await setIncluded(3);
      for (let i = 0; i < 3; i += 1) await addDeployment('PRODUCTION', 'ACTIVE');
      const updates: UpdateCall[] = [];

      const result = await reconcileBilling({ db, polar: fakePolar({ units: 3, updates }) }, ORG);

      expect(result).toMatchObject({
        status: 'SUCCEEDED',
        action: 'QUANTITY_UPDATED',
        active: 3,
        included: 3,
        expected: 1,
        provider: 3,
      });
      // Never zero units — the allowance never takes the total under the minimum.
      expect(updates).toEqual([{ subscriptionId: 'sub_test_1', units: 1 }]);
    });

    it('never goes under one unit when the allowance exceeds the live count', async () => {
      await addSubscription('ACTIVE');
      await setIncluded(10000);
      await addDeployment('PRODUCTION', 'ACTIVE');
      const updates: UpdateCall[] = [];

      const result = await reconcileBilling({ db, polar: fakePolar({ units: 1, updates }) }, ORG);

      expect(result).toMatchObject({ status: 'SUCCEEDED', action: 'NONE', active: 1, included: 10000, expected: 1, provider: 1 });
      expect(updates).toHaveLength(0);
    });

    it('a TEST deployment neither counts nor consumes the allowance', async () => {
      await addSubscription('ACTIVE');
      await setIncluded(1);
      await addDeployment('TEST', 'ACTIVE');
      await addDeployment('PRODUCTION', 'ACTIVE');
      const updates: UpdateCall[] = [];

      const result = await reconcileBilling({ db, polar: fakePolar({ units: 1, updates }) }, ORG);

      expect(result).toMatchObject({ active: 1, included: 1, expected: 1 });
      expect(updates).toHaveLength(0);
    });

    it('converges to the absolute formula whichever order the allowance and the count change in', async () => {
      await addSubscription('ACTIVE');
      const updates: UpdateCall[] = [];
      const polar = fakePolar({ units: 1, updates });

      // 2 live, allowance 0 → 2; allowance becomes 2 → floor of 1; a third
      // deployment goes live → 1; allowance back to 0 → 3. Every pass sends the
      // absolute unit count for the state at that moment.
      await addDeployment('PRODUCTION', 'ACTIVE');
      await addDeployment('PRODUCTION', 'ACTIVE');
      expect((await reconcileBilling({ db, polar }, ORG)).expected).toBe(2);
      await setIncluded(2);
      expect((await reconcileBilling({ db, polar }, ORG)).expected).toBe(1);
      await addDeployment('PRODUCTION', 'ACTIVE');
      expect((await reconcileBilling({ db, polar }, ORG)).expected).toBe(1);
      await setIncluded(0);
      expect((await reconcileBilling({ db, polar }, ORG)).expected).toBe(3);

      // The fake always reports one unit, so the passes that expected 1 were
      // no-ops and every other pass pushed.
      expect(updates.map((u) => u.units)).toEqual([2, 3]);
    });

    it('with no subscription the allowance changes nothing: no Polar call, no ledger row', async () => {
      await setIncluded(3);
      await addDeployment('PRODUCTION', 'ACTIVE');
      const updates: UpdateCall[] = [];

      const result = await reconcileBilling({ db, polar: fakePolar({ updates }) }, ORG);

      expect(result).toMatchObject({ status: 'SKIPPED', reason: 'no subscription', active: 1, included: 3, expected: 1 });
      expect(updates).toHaveLength(0);
      // Nothing is billable beyond the allowance, so the "live deployment with
      // no subscription" anomaly row is not written either.
      expect(await reconciliationRows()).toHaveLength(0);
    });

    it('a Polar failure records the expected unit count under the allowance for the retry', async () => {
      await addSubscription('ACTIVE');
      await setIncluded(1);
      for (let i = 0; i < 4; i += 1) await addDeployment('PRODUCTION', 'ACTIVE');

      const result = await reconcileBilling(
        { db, polar: fakePolar({ units: 1, updateError: new Error('polar down') }) },
        ORG,
      );

      expect(result).toMatchObject({ status: 'FAILED', expected: 3, reason: 'polar down' });
      const rows = await reconciliationRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ expectedDeploymentQuantity: 3, status: 'FAILED' });
    });
  });
});
