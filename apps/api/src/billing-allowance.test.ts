import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { updateIncludedProductionDeployments } from './billing-allowance.js';
import { reconcileBilling } from './billing-reconcile.js';
import type { PaddleBilling } from './paddle.js';

// Included production deployments — the write path itself, below the admin
// route: what it reports, what it refuses, and that the allowance survives
// everything that happens to the organization around it.

const PRICE_PLATFORM = 'pri_platform_test';
const PRICE_DEPLOYMENT = 'pri_deployment_test';
const ORG = 'org_allowance';

function fakePaddle(updates: { items: { priceId: string; quantity: number }[] }[]): PaddleBilling {
  return {
    config: {
      apiKey: 'test_replace_me',
      webhookSecret: 'test_replace_me',
      clientToken: 'pdl_sdbx_replace_me',
      pricePlatform: PRICE_PLATFORM,
      priceDeployment: PRICE_DEPLOYMENT,
      environment: 'sandbox',
    },
    client: {
      subscriptions: {
        get: async () => ({ items: [{ price: { id: PRICE_PLATFORM }, quantity: 1, status: 'active' }] }),
        update: async (_id: string, body: { items: { priceId: string; quantity: number }[] }) => {
          updates.push(body);
          return {};
        },
      },
    } as unknown as PaddleBilling['client'],
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
    const updates: { items: { priceId: string; quantity: number }[] }[] = [];
    const paddle = fakePaddle(updates);

    // Allowance change and a new live deployment interleave in either order;
    // whichever reconcile runs last pushes the quantity for the final state.
    await updateIncludedProductionDeployments(db, ORG, 2);
    await addLive(1);
    const result = await reconcileBilling({ db, paddle }, ORG);
    expect(result).toMatchObject({ active: 3, included: 2, expected: 1 });
    expect(updates.at(-1)!.items).toEqual([
      { priceId: PRICE_PLATFORM, quantity: 1 },
      { priceId: PRICE_DEPLOYMENT, quantity: 1 },
    ]);
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
    const updates: { items: { priceId: string; quantity: number }[] }[] = [];
    const paddle = fakePaddle(updates);

    expect(await reconcileBilling({ db, paddle }, ORG)).toMatchObject({ status: 'SKIPPED', included: 2, expected: 1 });
    expect(await allowance()).toBe(2);

    // Reactivated (a new subscription row after a fresh checkout, R6 semantics).
    await db.update(schema.billingSubscriptions).set({ status: 'ACTIVE', providerSubscriptionId: 'sub_2' });
    expect(await reconcileBilling({ db, paddle }, ORG)).toMatchObject({ status: 'SUCCEEDED', included: 2, expected: 1 });
    expect(updates[0]!.items).toEqual([
      { priceId: PRICE_PLATFORM, quantity: 1 },
      { priceId: PRICE_DEPLOYMENT, quantity: 1 },
    ]);
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
