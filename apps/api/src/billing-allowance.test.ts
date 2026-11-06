import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { updateIncludedProductionDeployments } from './billing-allowance.js';
import { reconcileBilling } from './billing-reconcile.js';
import type { PolarBilling } from './polar.js';

// Included production deployments — the write path itself, below the admin
// route: what it reports, what it refuses, and that the allowance survives
// everything that happens to the organization around it.

const ORG = 'org_allowance';

interface UpdateCall {
  subscriptionId: string;
  units: number;
}

/** A Polar double whose subscription holds `units` until an update sets them. */
function fakePolar(updates: UpdateCall[], units: number): PolarBilling {
  let current = units;
  return {
    config: {
      token: 'polar_oat_test_replace_me',
      webhookSecret: 'test_replace_me',
      productId: 'prod_test_1',
      environment: 'sandbox',
    },
    client: {
      getSubscription: async (id: string) => ({ id, status: 'active', units: current }),
      updateSubscriptionUnits: async (subscriptionId: string, next: number) => {
        updates.push({ subscriptionId, units: next });
        current = next;
        return { id: subscriptionId, status: 'active', units: next };
      },
    } as unknown as PolarBilling['client'],
  };
}

describe('updateIncludedProductionDeployments', () => {
  let client: PGlite | undefined;
  let db: Db;
  let ids: { applicationId: string; customerId: string; ownerId: string; memberId: string };

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    await db.insert(schema.organization).values({ id: ORG, name: 'Acme', slug: 'acme-allowance' });
    const [application] = await db
      .insert(schema.applications)
      .values({ organizationId: ORG, name: 'shop', repoFullName: 'acme/shop', repoUrl: 'https://github.com/acme/shop' })
      .returning();
    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId: ORG, name: 'Buyer', email: 'buyer@example.com' })
      .returning();
    await db.insert(schema.user).values([
      { id: 'owner_1', name: 'Owner', email: 'owner@example.com' },
      { id: 'member_1', name: 'Member', email: 'member@example.com' },
    ]);
    await db.insert(schema.member).values([
      { id: 'm_owner', organizationId: ORG, userId: 'owner_1', role: 'owner' },
      { id: 'm_member', organizationId: ORG, userId: 'member_1', role: 'member' },
    ]);
    ids = { applicationId: application!.id, customerId: customer!.id, ownerId: 'owner_1', memberId: 'member_1' };
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  beforeEach(async () => {
    await db.delete(schema.billingReconciliationEvents);
    await db.delete(schema.deployments);
    await db.delete(schema.billingSubscriptions);
    await db.update(schema.organization).set({ includedProductionDeployments: 0 }).where(eq(schema.organization.id, ORG));
  });

  async function addLive(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await db.insert(schema.deployments).values({
        organizationId: ORG,
        applicationId: ids.applicationId,
        customerId: ids.customerId,
        region: 'us-east-1',
        enrollmentCode: crypto.randomUUID(),
        deploymentType: 'PRODUCTION',
        billingState: 'ACTIVE',
      });
    }
  }

  async function allowance(): Promise<number> {
    const [row] = await db
      .select({ included: schema.organization.includedProductionDeployments })
      .from(schema.organization)
      .where(eq(schema.organization.id, ORG));
    return row!.included;
  }

  it('returns null for an unknown organization and writes nothing', async () => {
    expect(await updateIncludedProductionDeployments(db, 'org_missing', 3)).toBeNull();
  });

  it('reports the counts before and after, from the live deployments at that moment', async () => {
    await addLive(5);
    const change = await updateIncludedProductionDeployments(db, ORG, 2);
    expect(change).toEqual({
      activeProductionDeployments: 5,
      previous: { active: 5, paused: 0, included: 0, billable: 5 },
      current: { active: 5, paused: 0, included: 2, billable: 3 },
      changed: true,
    });
    expect(await allowance()).toBe(2);
  });

  it('a same-value update reports changed: false and still returns the counts', async () => {
    await addLive(1);
    await updateIncludedProductionDeployments(db, ORG, 1);
    const change = await updateIncludedProductionDeployments(db, ORG, 1);
    expect(change).toMatchObject({ changed: false, previous: { included: 1 }, current: { included: 1, billable: 0 } });
  });

  it('the database CHECK refuses an out-of-range value even if validation were bypassed', async () => {
    await expect(updateIncludedProductionDeployments(db, ORG, -1)).rejects.toThrow();
    await expect(updateIncludedProductionDeployments(db, ORG, 10001)).rejects.toThrow();
    expect(await allowance()).toBe(0);
  });

  it('concurrent updates serialize on the row lock: each sees the true previous value', async () => {
    const results = await Promise.all([
      updateIncludedProductionDeployments(db, ORG, 3),
      updateIncludedProductionDeployments(db, ORG, 7),
    ]);
    const previous = results.map((r) => r!.previous.included).sort((a, b) => a - b);
    expect(previous[0]).toBe(0);
    expect([3, 7]).toContain(previous[1]);
    expect([3, 7]).toContain(await allowance());
  });

  it('a deployment going live mid-change still reconciles to the absolute formula', async () => {
    await db.insert(schema.billingSubscriptions).values({
      organizationId: ORG,
      providerCustomerId: 'ctm_1',
      providerSubscriptionId: 'sub_1',
      status: 'ACTIVE',
    });
    await addLive(2);
    const updates: UpdateCall[] = [];
    // The subscription still bills the 2 live deployments from before the allowance.
    const polar = fakePolar(updates, 2);

    // Allowance change and a new live deployment interleave in either order;
    // whichever reconcile runs last pushes the unit count for the final state.
    await updateIncludedProductionDeployments(db, ORG, 2);
    await addLive(1);
    const result = await reconcileBilling({ db, polar }, ORG);
    expect(result).toMatchObject({ active: 3, included: 2, expected: 1, provider: 2 });
    expect(updates.at(-1)).toEqual({ subscriptionId: 'sub_1', units: 1 });
  });

  it('survives cancellation and is reused on reactivation', async () => {
    await updateIncludedProductionDeployments(db, ORG, 2);
    await addLive(3);
    await db.insert(schema.billingSubscriptions).values({
      organizationId: ORG,
      providerCustomerId: 'ctm_1',
      providerSubscriptionId: 'sub_1',
      status: 'CANCELED',
    });
    const updates: UpdateCall[] = [];
    // The new checkout bills all 3 live deployments until reconciliation applies the allowance.
    const polar = fakePolar(updates, 3);

    expect(await reconcileBilling({ db, polar }, ORG)).toMatchObject({ status: 'SKIPPED', included: 2, expected: 1 });
    expect(await allowance()).toBe(2);

    // Reactivated (a new subscription row after a fresh checkout, R6 semantics).
    await db.update(schema.billingSubscriptions).set({ status: 'ACTIVE', providerSubscriptionId: 'sub_2' });
    expect(await reconcileBilling({ db, polar }, ORG)).toMatchObject({ status: 'SUCCEEDED', included: 2, expected: 1 });
    expect(updates).toEqual([{ subscriptionId: 'sub_2', units: 1 }]);
  });

  it('belongs to the organization: ownership transfer and a member leaving do not touch it', async () => {
    await updateIncludedProductionDeployments(db, ORG, 4);

    // Ownership moves: the roles swap, the organization row is untouched.
    await db.update(schema.member).set({ role: 'member' }).where(eq(schema.member.userId, ids.ownerId));
    await db.update(schema.member).set({ role: 'owner' }).where(eq(schema.member.userId, ids.memberId));
    expect(await allowance()).toBe(4);

    // A member leaves.
    await db.delete(schema.member).where(eq(schema.member.userId, ids.ownerId));
    expect(await allowance()).toBe(4);
  });

  it('is pooled across applications and customers', async () => {
    const [other] = await db
      .insert(schema.applications)
      .values({ organizationId: ORG, name: 'crm', repoFullName: 'acme/crm', repoUrl: 'https://github.com/acme/crm' })
      .returning();
    const [otherCustomer] = await db
      .insert(schema.customers)
      .values({ organizationId: ORG, name: 'Other', email: 'other@example.com' })
      .returning();
    await addLive(1);
    await db.insert(schema.deployments).values({
      organizationId: ORG,
      applicationId: other!.id,
      customerId: otherCustomer!.id,
      region: 'us-east-1',
      enrollmentCode: crypto.randomUUID(),
      deploymentType: 'PRODUCTION',
      billingState: 'ACTIVE',
    });

    const change = await updateIncludedProductionDeployments(db, ORG, 2);
    // Two apps, two customers, one pool: both covered.
    expect(change).toMatchObject({ activeProductionDeployments: 2, current: { billable: 0 } });
  });
});
