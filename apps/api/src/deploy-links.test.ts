import { PGlite } from '@electric-sql/pglite';
import crypto from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applicationStackNameForInstallation } from '@deployz/contracts';
import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import { env } from './env.js';
import { buildServer } from './server.js';

// Phase 1 Deploy Links (docs/deploy-links.md) — vendor generation, the public
// resolve endpoint, revoke/regenerate, and the shared-deployment-creation
// refactor (POST /api/deployments must keep working and default source
// 'manual').

const READY_METADATA = {
  hasDockerfile: true,
  dockerfilePath: 'Dockerfile',
  framework: 'express',
  port: '3000',
  startupCommands: ['node dist/index.js'],
  hasStartupCommand: true,
  usesPostgresql: false,
  postgres: { required: false, evidence: [] },
  usesRedis: false,
  redis: { required: false, confidence: 'low', purposes: [], evidence: [], connectionEnvVars: [], compatibility: { supported: true } },
  usesS3: false,
  usesLocalFilesystem: false,
  usesWorkerProcesses: false,
  hasMigrationCommand: false,
  hasEnvVars: false,
  hasExternalServices: false,
  hasBuildCommand: false,
  buildCommands: ['npm run build'],
  envVars: ['NODE_ENV'],
  databaseState: 'none',
  externalServices: [] as string[],
  analysisVersion: 80,
} as Record<string, unknown>;

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
  overrides: Partial<typeof schema.applications.$inferInsert> = {},
): Promise<typeof schema.applications.$inferSelect> {
  const [row] = await db
    .insert(schema.applications)
    .values({
      organizationId,
      name: 'Deploy Link App',
      repoFullName: `acme/deploy-link-${crypto.randomUUID().slice(0, 8)}`,
      repoUrl: 'https://github.com/acme/deploy-link',
      defaultBranch: 'main',
      detectedMetadata: READY_METADATA,
      ...overrides,
    })
    .returning();
  // A built release: creating a deployment refuses without one.
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
      name: 'Deploy Link Customer',
      email: `deploy-link-${crypto.randomUUID()}@example.com`,
    })
    .returning();
  return row!;
}

describe('deploy links', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let orgA: { userId: string; organizationId: string; cookie: string };
  let orgB: { userId: string; organizationId: string; cookie: string };
  let application: typeof schema.applications.$inferSelect;
  let customer: typeof schema.customers.$inferSelect;

  function generateLink() {
    return app.inject({
      method: 'POST',
      url: `/api/customers/${customer.id}/deploy-links`,
      headers: { cookie: orgA.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ applicationId: application.id, region: 'us-east-1' }),
    });
  }

  function resolveLink(publicId: string, token: string) {
    return app.inject({
      method: 'GET',
      url: `/api/deploy-links/${publicId}`,
      headers: { 'x-deployz-token': token },
    });
  }

  async function createLink(): Promise<{
    publicId: string;
    token: string;
    deploymentId: string;
    linkId: string;
  }> {
    const response = await generateLink();
    expect(response.statusCode, response.body).toBe(201);
    const body = response.json() as {
      link: { id: string; deploymentId: string; status: string };
      deployment: { id: string; source: string; state: string };
      token: string;
    };
    expect(body.deployment.source).toBe('deploy_link');
    expect(body.deployment.state).toBe('NOT_INSTALLED');
    expect(body.link.status).toBe('active');
    expect(body.link.deploymentId).toBe(body.deployment.id);
    expect(response.body).not.toMatch(/enrollmentCode|relayCredential|relayTokenHash/);
    return {
      publicId: body.link.id,
      token: body.token,
      deploymentId: body.deployment.id,
      linkId: body.link.id,
    };
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);

    orgA = await signUpAndGetOrg(auth, db, 'vendor-a@example.com');
    orgB = await signUpAndGetOrg(auth, db, 'vendor-b@example.com');
    application = await insertApplication(db, orgA.organizationId);
    customer = await insertCustomer(db, orgA.organizationId);

    // Deploy links always create a PRODUCTION deployment (Paddle migration
    // Phase 7 gates that behind an ACTIVE subscription) — this file is about
    // deploy-link lifecycle, not billing, so orgA gets one up front.
    await db.insert(schema.billingSubscriptions).values({
      organizationId: orgA.organizationId,
      providerCustomerId: 'ctm_fixture_vendor_a',
      providerSubscriptionId: 'sub_fixture_vendor_a',
      status: 'ACTIVE',
    });

    app = await buildServer({ auth, db });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('unauthenticated generate 401s', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/customers/${customer.id}/deploy-links`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ applicationId: application.id, region: 'us-east-1' }),
    });
    expect(response.statusCode).toBe(401);
  });

  it('generate with another org application 404s', async () => {
    const otherApplication = await insertApplication(db, orgB.organizationId);
    const response = await app.inject({
      method: 'POST',
      url: `/api/customers/${customer.id}/deploy-links`,
      headers: { cookie: orgA.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ applicationId: otherApplication.id, region: 'us-east-1' }),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('generate with another org customer path 404s', async () => {
    const otherCustomer = await insertCustomer(db, orgB.organizationId);
    const response = await app.inject({
      method: 'POST',
      url: `/api/customers/${otherCustomer.id}/deploy-links`,
      headers: { cookie: orgA.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ applicationId: application.id, region: 'us-east-1' }),
    });
    expect(response.statusCode).toBe(404);
  });

  it('generate rejects an unsupported region (422 REGION_NOT_SUPPORTED)', async () => {
    const mutableEnv = env as { deployableAwsRegions: readonly string[] };
    const prevRegions = mutableEnv.deployableAwsRegions;
    try {
      mutableEnv.deployableAwsRegions = ['us-east-1'];
      const response = await app.inject({
        method: 'POST',
        url: `/api/customers/${customer.id}/deploy-links`,
        headers: { cookie: orgA.cookie, 'content-type': 'application/json' },
        payload: JSON.stringify({ applicationId: application.id, region: 'eu-west-1' }),
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ error: { code: 'REGION_NOT_SUPPORTED' } });
    } finally {
      mutableEnv.deployableAwsRegions = prevRegions;
    }
  });

  it('generate writes a deployment_link deployment and an audit event, and never persists the raw token', async () => {
    const { publicId, token, deploymentId } = await createLink();

    const [deployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deploymentId));
    expect(deployment!.source).toBe('deploy_link');
    expect(deployment!.state).toBe('NOT_INSTALLED');
    expect(deployment!.installLinkId).not.toBeNull();
    expect(deployment!.enrollmentCode).not.toBeNull();

    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(and(eq(schema.eventLogs.eventType, 'deploy_link.created'), eq(schema.eventLogs.deploymentId, deploymentId)));
    expect(events).toHaveLength(1);
    expect(events[0]!.actorType).toBe('user');
    expect(events[0]!.actorId).toBe(orgA.userId);

    // The shared creation funnel: a deploy-link deployment records
    // deployment.created with the source the insert actually wrote.
    const created = await db
      .select()
      .from(schema.eventLogs)
      .where(and(eq(schema.eventLogs.eventType, 'deployment.created'), eq(schema.eventLogs.deploymentId, deploymentId)));
    expect(created).toHaveLength(1);
    expect(created[0]!.payload).toMatchObject({ schemaVersion: 1, source: 'deploy_link', analysisVersion: 80 });
    expect(created[0]!.actorId).toBe(orgA.userId);

    const [link] = await db.select().from(schema.deployLinks).where(eq(schema.deployLinks.id, publicId));
    // Only the sha256 hash is stored — never the raw secret, and no 'token' column exists.
    expect(link!.tokenHash).toBeDefined();
    expect(link!.tokenHash).not.toBe(token);
    expect(link!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    const linkRecord = link as unknown as Record<string, unknown>;
    expect(Object.keys(linkRecord).includes('token')).toBe(false);
    expect(Object.values(linkRecord).includes(token)).toBe(false);
  });

  it('resolves a valid token with the customer projection (200)', async () => {
    const { publicId, token } = await createLink();
    const response = await resolveLink(publicId, token);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as {
      link: { status: string };
      application: { name: string };
      customer: { name: string };
      region: string;
      plan: { action: string; components: { kind: string; name: string; action: string; lifecycle: string }[] };
      status: { stage: string };
    };
    expect(body.link).toEqual({ status: 'active' });
    expect(body.application.name).toBe('Deploy Link App');
    expect(body.customer.name).toBe('Deploy Link Customer');
    expect(body.region).toBe('us-east-1');
    expect(body.plan).toMatchObject({
      action: 'INSTALL',
      components: [
        { kind: 'application', name: 'Application', action: 'CREATE' },
        { kind: 'endpoint', name: 'Secure endpoint', action: 'CREATE' },
        { kind: 'storage', name: 'Storage', action: 'CREATE', lifecycle: 'retain' },
      ],
    });
    expect(body.status.stage).toBe('WAITING_FOR_AWS');
    // The public payload must never leak internal identifiers or credentials.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('organizationId');
    expect(serialized).not.toContain('installLinkId');
    expect(serialized).not.toContain('enrollmentCode');
    expect(serialized).not.toContain('token_hash');
    expect(serialized).not.toContain('deploymentId');
  });

  it('resolve records deploy_link.opened once and throttles repeats', async () => {
    const { publicId, token, deploymentId } = await createLink();
    await resolveLink(publicId, token);
    const opened = await db
      .select()
      .from(schema.eventLogs)
      .where(and(eq(schema.eventLogs.eventType, 'deploy_link.opened'), eq(schema.eventLogs.deploymentId, deploymentId)));
    expect(opened).toHaveLength(1);
    expect(opened[0]!.actorType).toBe('system');
    expect(opened[0]!.actorId).toBe(`deploy-link:${publicId}`);
    const [link] = await db.select().from(schema.deployLinks).where(eq(schema.deployLinks.id, publicId));
    expect(link!.lastUsedAt).not.toBeNull();
    const lastUsedAt = link!.lastUsedAt!.getTime();

    // A second open inside the throttle window neither rewrites last_used_at
    // nor appends another event.
    await resolveLink(publicId, token);
    const [again] = await db.select().from(schema.deployLinks).where(eq(schema.deployLinks.id, publicId));
    expect(again!.lastUsedAt!.getTime()).toBe(lastUsedAt);
    const openedAfter = await db
      .select()
      .from(schema.eventLogs)
      .where(and(eq(schema.eventLogs.eventType, 'deploy_link.opened'), eq(schema.eventLogs.deploymentId, deploymentId)));
    expect(openedAfter).toHaveLength(1);
  });

  it('wrong token, malformed publicId and unknown publicId all 404 without leaking which', async () => {
    const { publicId } = await createLink();
    const wrongToken = await resolveLink(publicId, '0'.repeat(64));
    expect(wrongToken.statusCode).toBe(404);
    expect(wrongToken.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    const noToken = await app.inject({ method: 'GET', url: `/api/deploy-links/${publicId}` });
    expect(noToken.statusCode).toBe(404);

    const malformed = await resolveLink('not-a-uuid', '0'.repeat(64));
    expect(malformed.statusCode).toBe(404);

    const unknown = await resolveLink(crypto.randomUUID(), '0'.repeat(64));
    expect(unknown.statusCode).toBe(404);
  });

  it('revoked link resolves 410 DEPLOY_LINK_REVOKED', async () => {
    const { publicId, token } = await createLink();
    await db
      .update(schema.deployLinks)
      .set({ revokedAt: new Date() })
      .where(eq(schema.deployLinks.id, publicId));
    const response = await resolveLink(publicId, token);
    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ error: { code: 'DEPLOY_LINK_REVOKED' } });
  });

  it('expired link resolves 410 DEPLOY_LINK_EXPIRED', async () => {
    const { publicId, token } = await createLink();
    await db
      .update(schema.deployLinks)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.deployLinks.id, publicId));
    const response = await resolveLink(publicId, token);
    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ error: { code: 'DEPLOY_LINK_EXPIRED' } });
  });

  it('revoke is org-scoped and idempotent', async () => {
    const { publicId } = await createLink();

    const crossOrg = await app.inject({
      method: 'POST',
      url: `/api/deploy-links/${publicId}/revoke`,
      headers: { cookie: orgB.cookie, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(crossOrg.statusCode).toBe(404);

    const revoked = await app.inject({
      method: 'POST',
      url: `/api/deploy-links/${publicId}/revoke`,
      headers: { cookie: orgA.cookie, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ link: { id: publicId, status: 'revoked' } });

    const again = await app.inject({
      method: 'POST',
      url: `/api/deploy-links/${publicId}/revoke`,
      headers: { cookie: orgA.cookie, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ link: { id: publicId, status: 'revoked' } });

    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.eventType, 'deploy_link.revoked'));
    expect(events).toHaveLength(1);
  });

  it('regenerate rotates the secret (old token 404s, new token resolves)', async () => {
    const { publicId, token: oldToken } = await createLink();

    const regenerated = await app.inject({
      method: 'POST',
      url: `/api/deploy-links/${publicId}/regenerate`,
      headers: { cookie: orgA.cookie, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(regenerated.statusCode, regenerated.body).toBe(200);
    const newToken = (regenerated.json() as { token: string; link: { status: string } }).token;
    expect(newToken).not.toBe(oldToken);

    const oldResolve = await resolveLink(publicId, oldToken);
    expect(oldResolve.statusCode).toBe(404);
    const newResolve = await resolveLink(publicId, newToken);
    expect(newResolve.statusCode).toBe(200);
  });

  it('regenerate revives a revoked link with a fresh expiry', async () => {
    const { publicId, token: oldToken } = await createLink();
    await app.inject({
      method: 'POST',
      url: `/api/deploy-links/${publicId}/revoke`,
      headers: { cookie: orgA.cookie, 'content-type': 'application/json' },
      payload: '{}',
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/deploy-links/${publicId}/regenerate`,
      headers: { cookie: orgA.cookie, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as { token: string; link: { status: string; revokedAt: null; expiresAt: string } };
    expect(body.link.status).toBe('active');
    expect(body.link.revokedAt).toBeNull();
    expect(new Date(body.link.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const [link] = await db.select().from(schema.deployLinks).where(eq(schema.deployLinks.id, publicId));
    expect(link!.lastUsedAt).toBeNull();
    expect(link!.tokenHash).not.toBe(oldToken);

    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(and(eq(schema.eventLogs.eventType, 'deploy_link.regenerated'), eq(schema.eventLogs.deploymentId, link!.deploymentId)));
    expect(events).toHaveLength(1);
  });

  it('regenerate is org-scoped and 409s once the deployment has started', async () => {
    const { publicId, deploymentId } = await createLink();

    const crossOrg = await app.inject({
      method: 'POST',
      url: `/api/deploy-links/${publicId}/regenerate`,
      headers: { cookie: orgB.cookie, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(crossOrg.statusCode).toBe(404);

    await db
      .update(schema.deployments)
      .set({ state: 'WAITING_FOR_RELAY' })
      .where(eq(schema.deployments.id, deploymentId));
    const started = await app.inject({
      method: 'POST',
      url: `/api/deploy-links/${publicId}/regenerate`,
      headers: { cookie: orgA.cookie, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(started.statusCode).toBe(409);
    expect(started.json()).toMatchObject({ error: { code: 'DEPLOYMENT_ALREADY_STARTED' } });
  });

  it('list is org-scoped, newest first, with derived statuses', async () => {
    const customerA = customer;
    const customerB = await insertCustomer(db, orgB.organizationId);

    const { publicId } = await createLink();
    await db
      .update(schema.deployLinks)
      .set({ revokedAt: new Date() })
      .where(eq(schema.deployLinks.id, publicId));

    const crossOrg = await app.inject({
      method: 'GET',
      url: `/api/customers/${customerA.id}/deploy-links`,
      headers: { cookie: orgB.cookie },
    });
    expect(crossOrg.statusCode).toBe(404);

    const empty = await app.inject({
      method: 'GET',
      url: `/api/customers/${customerB.id}/deploy-links`,
      headers: { cookie: orgB.cookie },
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ links: [] });

    const list = await app.inject({
      method: 'GET',
      url: `/api/customers/${customerA.id}/deploy-links`,
      headers: { cookie: orgA.cookie },
    });
    expect(list.statusCode).toBe(200);
    const links = (list.json() as {
      links: Array<{ id: string; status: string; deploymentId: string }>;
    }).links;
    expect(links.length).toBeGreaterThan(0);
    expect(links[0]!.status).toBe('revoked');
    expect(links[0]!.id).toBe(publicId);
    // Newest first, matching the persisted order.
    const expectedIds = (
      await db
        .select({ id: schema.deployLinks.id })
        .from(schema.deployLinks)
        .where(and(eq(schema.deployLinks.organizationId, orgA.organizationId), eq(schema.deployLinks.customerId, customerA.id)))
        .orderBy(schema.deployLinks.createdAt)
    )
      .reverse()
      .map((row) => row.id);
    expect(links.map((link) => link.id)).toEqual(expectedIds);
  });

  it('manual POST /api/deployments still works and defaults source manual', async () => {
    const manual = await app.inject({
      method: 'POST',
      url: '/api/deployments',
      headers: { cookie: orgA.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        applicationId: application.id,
        customerId: customer.id,
        region: 'us-east-1',
      }),
    });
    expect(manual.statusCode, manual.body).toBe(201);
    const body = manual.json() as { source: string; id: string };
    expect(body.source).toBe('manual');

    // The shared creation funnel records deployment.created with the manual
    // origin on the same handle as the insert.
    const created = await db
      .select()
      .from(schema.eventLogs)
      .where(and(eq(schema.eventLogs.eventType, 'deployment.created'), eq(schema.eventLogs.deploymentId, body.id)));
    expect(created).toHaveLength(1);
    expect(created[0]!.payload).toMatchObject({ schemaVersion: 1, source: 'manual' });
    expect(created[0]!.actorType).toBe('user');
    expect(created[0]!.actorId).toBe(orgA.userId);
  });

  it('POST /api/deployments freezes the requested size, else the application default, and refuses one below the minimum', async () => {
    const sized = await insertApplication(db, orgA.organizationId);
    await db
      .update(schema.applications)
      .set({ defaultSizeProfile: 'medium', minimumSizeProfile: 'medium' })
      .where(eq(schema.applications.id, sized.id));
    const create = async (payload: Record<string, unknown>) => {
      const target = await insertCustomer(db, orgA.organizationId);
      return app.inject({
        method: 'POST',
        url: '/api/deployments',
        headers: { cookie: orgA.cookie, 'content-type': 'application/json' },
        payload: JSON.stringify({ applicationId: sized.id, customerId: target.id, region: 'us-east-1', ...payload }),
      });
    };
    const frozen = async (response: { statusCode: number; body: string; json: () => unknown }) => {
      expect(response.statusCode, response.body).toBe(201);
      const [row] = await db
        .select()
        .from(schema.deployments)
        .where(eq(schema.deployments.id, (response.json() as { id: string }).id));
      const workload = (row!.specV2 as { footprint: { workloads: { compute: { cpuUnits: number } }[] } }).footprint.workloads[0]!;
      return { profile: (row!.desiredState as { infrastructureProfile: unknown }).infrastructureProfile, cpuUnits: workload.compute.cpuUnits };
    };

    expect(await frozen(await create({ sizeProfile: 'large' }))).toEqual({ profile: { id: 'large', version: 1 }, cpuUnits: 2048 });
    expect(await frozen(await create({}))).toEqual({ profile: { id: 'medium', version: 1 }, cpuUnits: 1024 });

    const below = await create({ sizeProfile: 'small' });
    expect(below.statusCode, below.body).toBe(422);
    expect(below.json()).toMatchObject({ error: { code: 'SIZE_PROFILE_NOT_ALLOWED' } });
    const rows = await db.select({ id: schema.deployments.id }).from(schema.deployments).where(eq(schema.deployments.applicationId, sized.id));
    expect(rows).toHaveLength(2);
  });

  it('POST /api/deployments refuses an application with no built release (409 RELEASE_NOT_PUBLISHED) and creates no deployment', async () => {
    const unbuilt = await insertApplication(db, orgA.organizationId);
    await db
      .update(schema.releases)
      .set({ releaseStatus: 'BUILDING', imageDigest: null })
      .where(eq(schema.releases.applicationId, unbuilt.id));

    const response = await app.inject({
      method: 'POST',
      url: '/api/deployments',
      headers: { cookie: orgA.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ applicationId: unbuilt.id, customerId: customer.id, region: 'us-east-1' }),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'RELEASE_NOT_PUBLISHED' } });

    const rows = await db
      .select({ id: schema.deployments.id })
      .from(schema.deployments)
      .where(eq(schema.deployments.applicationId, unbuilt.id));
    expect(rows).toEqual([]);
  });

  // ── Phase 3: the hosted customer page's public flow routes ────────────────

  function launched(publicId: string, token: string) {
    return app.inject({
      method: 'POST',
      url: `/api/deploy-links/${publicId}/launched`,
      headers: { 'x-deployz-token': token },
    });
  }

  function status(publicId: string, token: string) {
    return app.inject({
      method: 'GET',
      url: `/api/deploy-links/${publicId}/status`,
      headers: { 'x-deployz-token': token },
    });
  }

  function retry(publicId: string, token: string) {
    return app.inject({
      method: 'POST',
      url: `/api/deploy-links/${publicId}/retry`,
      headers: { 'x-deployz-token': token },
    });
  }

  function domainCheck(publicId: string, token: string) {
    return app.inject({
      method: 'POST',
      url: `/api/deploy-links/${publicId}/domain/check`,
      headers: { 'x-deployz-token': token },
    });
  }

  it('resolve exposes the Quick Create link and page fields without internals', async () => {
    const { publicId, token } = await createLink();
    const response = await resolveLink(publicId, token);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as {
      quickCreateUrl: string | null;
      bootstrapStackName: string;
      waitingForRelay: boolean;
      relayStuck: boolean;
      deploymentState: string;
    };
    // us-east-1 has a published bootstrap template, so the page gets a link.
    expect(typeof body.quickCreateUrl).toBe('string');
    expect(body.bootstrapStackName).toMatch(/^deployz-bootstrap-/);
    expect(body.waitingForRelay).toBe(false);
    expect(body.relayStuck).toBe(false);
    expect(body.deploymentState).toBe('NOT_INSTALLED');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('enrollmentCode');
    expect(serialized).not.toContain('installLinkId');
    expect(serialized).not.toContain('organizationId');
  });

  it('launched moves NOT_INSTALLED to WAITING_FOR_RELAY and records the event', async () => {
    const { publicId, token, deploymentId } = await createLink();
    const response = await launched(publicId, token);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ state: 'WAITING_FOR_RELAY' });

    const [deployment] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId));
    expect(deployment!.state).toBe('WAITING_FOR_RELAY');
    expect(deployment!.installStartedAt).not.toBeNull();
    expect(deployment!.bootstrapStackName).toMatch(/^deployz-bootstrap-/);

    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(and(eq(schema.eventLogs.eventType, 'deploy_link.launched'), eq(schema.eventLogs.deploymentId, deploymentId)));
    expect(events).toHaveLength(1);
    expect(events[0]!.actorId).toBe(`deploy-link:${publicId}`);
  });

  it('launched is idempotent once the deployment left NOT_INSTALLED', async () => {
    const { publicId, token, deploymentId } = await createLink();
    await launched(publicId, token);
    const again = await launched(publicId, token);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ state: 'WAITING_FOR_RELAY' });

    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(and(eq(schema.eventLogs.eventType, 'deploy_link.launched'), eq(schema.eventLogs.deploymentId, deploymentId)));
    expect(events).toHaveLength(1);
  });

  it('a double submit (two tabs racing) launches exactly once', async () => {
    const { publicId, token, deploymentId } = await createLink();
    const [first, second] = await Promise.all([launched(publicId, token), launched(publicId, token)]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // Both tabs land on the waiting state — the loser sees the winner's state.
    expect(first.json()).toEqual({ state: 'WAITING_FOR_RELAY' });
    expect(second.json()).toEqual({ state: 'WAITING_FOR_RELAY' });

    const [deployment] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId));
    expect(deployment!.state).toBe('WAITING_FOR_RELAY');

    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(and(eq(schema.eventLogs.eventType, 'deploy_link.launched'), eq(schema.eventLogs.deploymentId, deploymentId)));
    expect(events).toHaveLength(1);
  });

  it('a deliberate second link for the same customer and application creates an independent deployment', async () => {
    const first = await createLink();
    const second = await createLink();
    expect(second.deploymentId).not.toBe(first.deploymentId);
    expect(second.publicId).not.toBe(first.publicId);

    const rows = await db
      .select({ id: schema.deployments.id, source: schema.deployments.source })
      .from(schema.deployments)
      .where(inArray(schema.deployments.id, [first.deploymentId, second.deploymentId]));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.source === 'deploy_link')).toBe(true);
  });

  it('a wrong token cannot launch (404) and a revoked link can never start a deployment (410)', async () => {
    const { publicId, token, deploymentId } = await createLink();

    const wrong = await launched(publicId, '0'.repeat(64));
    expect(wrong.statusCode).toBe(404);

    await db.update(schema.deployLinks).set({ revokedAt: new Date() }).where(eq(schema.deployLinks.id, publicId));
    const revoked = await launched(publicId, token);
    expect(revoked.statusCode).toBe(410);
    expect(revoked.json()).toMatchObject({ error: { code: 'DEPLOY_LINK_REVOKED' } });

    const [deployment] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId));
    expect(deployment!.state).toBe('NOT_INSTALLED');
  });

  it('status reflects live job progress and hides internals', async () => {
    const { publicId, token, deploymentId } = await createLink();

    const before = await status(publicId, token);
    expect(before.statusCode, before.body).toBe(200);
    expect((before.json() as { stage: string }).stage).toBe('WAITING_FOR_AWS');

    // Relay registered: INSTALLING plus a claimed INSTALL job reads as PROVISIONING.
    await db.update(schema.deployments).set({ state: 'INSTALLING' }).where(eq(schema.deployments.id, deploymentId));
    await db.insert(schema.deploymentJobs).values({
      deploymentId,
      type: 'INSTALL',
      state: 'RUNNING',
      idempotencyKey: `${deploymentId}:INSTALL`,
      payload: {},
    });
    const after = await status(publicId, token);
    expect(after.statusCode).toBe(200);
    expect((after.json() as { stage: string }).stage).toBe('PROVISIONING');

    const serialized = JSON.stringify(after.json());
    expect(serialized).not.toContain('enrollmentCode');
    expect(serialized).not.toContain('installLinkId');
    expect(serialized).not.toContain('organizationId');

    const wrong = await status(publicId, '0'.repeat(64));
    expect(wrong.statusCode).toBe(404);
  });

  it('retry mints a fresh attempt, clears the relay binding, and records the event', async () => {
    const { publicId, token, deploymentId } = await createLink();
    await db
      .update(schema.deployments)
      .set({
        state: 'WAITING_FOR_RELAY',
        installationId: 'inst-stale',
        relayTokenHash: 'stale-hash',
        bootstrapStackName: `deployz-bootstrap-kept-${deploymentId}`,
      })
      .where(eq(schema.deployments.id, deploymentId));
    const [original] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId));

    const response = await retry(publicId, token);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as {
      state: string;
      attemptNumber: number;
      bootstrapStackName: string;
      quickCreateUrl: string | null;
      existingStackUpdate: { stackName: string } | null;
    };
    expect(body.state).toBe('NOT_INSTALLED');
    expect(body.attemptNumber).toBe(original!.attemptNumber + 1);
    expect(body.bootstrapStackName).toMatch(/^deployz-bootstrap-/);
    // A connector registered (installationId set), so the retry keeps its stack.
    expect(body.bootstrapStackName).toBe(original!.bootstrapStackName);
    expect(body.quickCreateUrl).toBeNull();
    expect(body.existingStackUpdate).toMatchObject({ stackName: original!.bootstrapStackName });

    const [deployment] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId));
    expect(deployment!.enrollmentCode).not.toBe(original!.enrollmentCode);
    expect(deployment!.installationId).toBeNull();
    // DZ-AUDIT-013: the retry mints a fresh relay credential — the stored
    // hash is the NEW credential's (never the stale one, never null), and the
    // plaintext rides the rebuilt Quick Create URL.
    expect(deployment!.relayTokenHash).not.toBeNull();
    expect(deployment!.relayTokenHash).not.toBe('stale-hash');
    expect(deployment!.relayCredential).not.toBeNull();
    expect(deployment!.attemptNumber).toBe(body.attemptNumber);

    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(and(eq(schema.eventLogs.eventType, 'deploy_link.retry.requested'), eq(schema.eventLogs.deploymentId, deploymentId)));
    expect(events).toHaveLength(1);
    expect(events[0]!.actorId).toBe(`deploy-link:${publicId}`);
  });

  it('retry of a link whose connector never registered gives a fresh Quick Create with a new stack name', async () => {
    const { publicId, token, deploymentId } = await createLink();
    await db
      .update(schema.deployments)
      .set({ state: 'WAITING_FOR_RELAY', installationId: null })
      .where(eq(schema.deployments.id, deploymentId));
    const [original] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId));

    const response = await retry(publicId, token);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as {
      bootstrapStackName: string;
      quickCreateUrl: string | null;
      existingStackUpdate: unknown;
    };
    expect(body.bootstrapStackName).not.toBe(original!.bootstrapStackName);
    expect(typeof body.quickCreateUrl).toBe('string');
    expect(body.existingStackUpdate).toBeNull();
  });

  it('retry records previousInstallationId and previousBootstrapStackName before nulling installationId', async () => {
    const { publicId, token, deploymentId } = await createLink();
    const oldStackName = `deployz-bootstrap-old-${deploymentId}`;
    await db
      .update(schema.deployments)
      .set({
        state: 'WAITING_FOR_RELAY',
        installationId: 'inst-link-stale',
        bootstrapStackName: oldStackName,
        relayTokenHash: 'stale-hash',
      })
      .where(eq(schema.deployments.id, deploymentId));

    const response = await retry(publicId, token);
    expect(response.statusCode, response.body).toBe(200);

    const [deployment] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId));
    expect(deployment!.installationId).toBeNull();
    expect(deployment!.previousInstallationId).toBe('inst-link-stale');
    expect(deployment!.previousBootstrapStackName).toBe(oldStackName);
  });

  it('retry refuses a deployment that ever installed successfully (409)', async () => {
    const { publicId, token, deploymentId } = await createLink();
    await db.insert(schema.deploymentJobs).values({
      deploymentId,
      type: 'INSTALL',
      state: 'SUCCEEDED',
      idempotencyKey: `${deploymentId}:INSTALL`,
      payload: {},
    });
    const response = await retry(publicId, token);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'INSTALL_ALREADY_SUCCEEDED' } });
  });

  it('domain/check without a custom domain 404s', async () => {
    const { publicId, token } = await createLink();
    const response = await domainCheck(publicId, token);
    expect(response.statusCode).toBe(404);
  });

  // ── Phase 4: the reused AWS connection flow, proven for deploy links ──────

  it('a link revoked mid-connection can no longer read status or launch (410)', async () => {
    const { publicId, token, deploymentId } = await createLink();
    await launched(publicId, token);
    await db.update(schema.deployLinks).set({ revokedAt: new Date() }).where(eq(schema.deployLinks.id, publicId));

    const statusAfter = await status(publicId, token);
    expect(statusAfter.statusCode).toBe(410);
    expect(statusAfter.json()).toMatchObject({ error: { code: 'DEPLOY_LINK_REVOKED' } });

    const launchedAfter = await launched(publicId, token);
    expect(launchedAfter.statusCode).toBe(410);

    const [deployment] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId));
    // The running deployment itself is untouched — revocation kills the link,
    // never the customer's in-flight infrastructure.
    expect(deployment!.state).toBe('WAITING_FOR_RELAY');
  });

  it('resolve reflects the waiting state so reopening the link resumes the same deployment', async () => {
    const { publicId, token } = await createLink();
    await launched(publicId, token);

    const response = await resolveLink(publicId, token);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as { waitingForRelay: boolean; deploymentState: string; quickCreateUrl: string | null };
    expect(body.waitingForRelay).toBe(true);
    expect(body.deploymentState).toBe('WAITING_FOR_RELAY');
    // The enrollment code is only spent when a relay actually connects, so
    // the customer can re-open the CloudFormation console from the same link.
    expect(typeof body.quickCreateUrl).toBe('string');
  });

  it('a failed install reaches the customer projection as a normalized failure', async () => {
    const { publicId, token, deploymentId } = await createLink();
    await db.update(schema.deployments).set({ state: 'FAILED' }).where(eq(schema.deployments.id, deploymentId));
    await db.insert(schema.deploymentJobs).values({
      deploymentId,
      type: 'INSTALL',
      state: 'FAILED',
      failureCode: 'STACK_CREATE_FAILED',
      idempotencyKey: `${deploymentId}:INSTALL`,
      payload: {},
    });

    const response = await status(publicId, token);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as { stage: string; failure: { customerMessage: string } | null };
    expect(body.stage).toBe('FAILED');
    expect(body.failure?.customerMessage).toBeTruthy();
    // §65: no raw CloudFormation status, stack names or role ARNs in the
    // customer projection.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('STACK_CREATE_FAILED');
    expect(serialized).not.toContain('arn:');
  });

  it('a relay outage surfaces as statusUpdatesUnavailable, never as a fake failure', async () => {
    const { publicId, token, deploymentId } = await createLink();
    await db
      .update(schema.deployments)
      .set({ state: 'HEALTHY', healthStatus: 'HEALTHY', relayStatus: 'DISCONNECTED' })
      .where(eq(schema.deployments.id, deploymentId));

    const response = await status(publicId, token);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as { stage: string; statusUpdatesUnavailable: boolean };
    expect(body.stage).not.toBe('FAILED');
    expect(body.statusUpdatesUnavailable).toBe(true);
  });

  it('status carries awsSummary only once the deployment is READY and enrolled', async () => {
    const { publicId, token, deploymentId } = await createLink();
    const installationId = 'inst-aws-summary';
    const fetchBody = async () =>
      (await status(publicId, token)).json() as {
        stage: string;
        awsSummary?: { applicationStackName: string; region: string; releaseVersion: string | null } | null;
      };

    // Enrolled but still connecting: no summary before READY.
    await db
      .update(schema.deployments)
      .set({ state: 'WAITING_FOR_RELAY', enrollmentUsedAt: new Date(), installationId })
      .where(eq(schema.deployments.id, deploymentId));
    const connecting = await fetchBody();
    expect(connecting.stage).toBe('CONNECTING');
    expect(connecting.awsSummary).toBeUndefined();

    // READY needs confirmed health plus an https URL — the stored
    // default-HTTPS state supplies the address, the release pointer the
    // version.
    const [release] = await db
      .insert(schema.releases)
      .values({
        applicationId: application.id,
        version: `v1.2.3-${crypto.randomUUID().slice(0, 8)}`,
        gitSha: 'deadbee',
      })
      .returning();
    await db
      .update(schema.deployments)
      .set({
        state: 'HEALTHY',
        healthStatus: 'HEALTHY',
        currentReleaseId: release!.id,
        defaultHttps: { hostname: 'd-summary.deployz.dev', status: 'ACTIVE' },
        observedState: { releaseVerdict: { pass: true, reason: null, notStarted: false } },
      })
      .where(eq(schema.deployments.id, deploymentId));
    const ready = await fetchBody();
    expect(ready.stage).toBe('READY');
    expect(ready.awsSummary).toEqual({
      applicationStackName: applicationStackNameForInstallation(installationId),
      region: 'us-east-1',
      releaseVersion: release!.version,
    });

    // FAILED never carries a summary, whatever it enrolled before.
    await db
      .update(schema.deployments)
      .set({ state: 'FAILED', currentReleaseId: null, defaultHttps: null })
      .where(eq(schema.deployments.id, deploymentId));
    const failed = await fetchBody();
    expect(failed.stage).toBe('FAILED');
    expect(failed.awsSummary).toBeUndefined();
  });

  it('a READY deployment with no installationId or no release pointer degrades the summary away', async () => {
    const { publicId, token, deploymentId } = await createLink();

    // READY but never enrolled: no application stack exists to name, so the
    // whole summary is omitted.
    await db
      .update(schema.deployments)
      .set({
        state: 'HEALTHY',
        healthStatus: 'HEALTHY',
        installationId: null,
        defaultHttps: { hostname: 'd-unenrolled.deployz.dev', status: 'ACTIVE' },
        observedState: { releaseVerdict: { pass: true, reason: null, notStarted: false } },
      })
      .where(eq(schema.deployments.id, deploymentId));
    const unenrolled = (await status(publicId, token)).json() as {
      stage: string;
      awsSummary?: unknown;
    };
    expect(unenrolled.stage).toBe('READY');
    expect(unenrolled.awsSummary).toBeUndefined();

    // Enrolled with no serving release yet: the summary names the stack and
    // region, releaseVersion null.
    await db
      .update(schema.deployments)
      .set({ installationId: 'inst-no-release' })
      .where(eq(schema.deployments.id, deploymentId));
    const noRelease = (await status(publicId, token)).json() as {
      awsSummary?: { applicationStackName: string; region: string; releaseVersion: string | null };
    };
    expect(noRelease.awsSummary).toEqual({
      applicationStackName: applicationStackNameForInstallation('inst-no-release'),
      region: 'us-east-1',
      releaseVersion: null,
    });
  });

  it('the deploy-link token grants no relay (AWS) permissions', async () => {
    const { token } = await createLink();
    // Relay routes authenticate with the relay's own bearer token, minted
    // inside the customer's account — a deploy-link token is not one.
    const commands = await app.inject({
      method: 'GET',
      url: '/api/relay/commands',
      headers: { 'x-deployz-token': token },
    });
    expect(commands.statusCode).toBe(401);

    const register = await app.inject({
      method: 'POST',
      url: '/api/relay/register',
      headers: { 'x-deployz-token': token, 'content-type': 'application/json' },
      payload: JSON.stringify({ installationId: 'inst-evil', enrollmentCode: 'code' }),
    });
    expect(register.statusCode).toBe(401);
  });

  // ── Phase 6: deploy-link deployments behave exactly like manual ones ──────

  it('a deploy-link deployment appears in the vendor fleet with its source', async () => {
    const { deploymentId } = await createLink();
    const response = await app.inject({
      method: 'GET',
      url: '/api/deployments',
      headers: { cookie: orgA.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as {
      deployments: Array<{ id: string; source: string; customerName: string; applicationName: string }>;
    };
    const row = body.deployments.find((deployment) => deployment.id === deploymentId);
    expect(row).toBeDefined();
    expect(row!.source).toBe('deploy_link');
    expect(row!.customerName).toBe('Deploy Link Customer');
    expect(row!.applicationName).toBe('Deploy Link App');
  });

  it('a deploy-link deployment is destroyed through the normal route and the link then fails closed', async () => {
    const { publicId, token, deploymentId } = await createLink();
    const destroy = await app.inject({
      method: 'POST',
      url: `/api/deployments/${deploymentId}/destroy`,
      headers: { cookie: orgA.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(destroy.statusCode, destroy.body).toBeLessThan(300);

    const [deployment] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId));
    expect(deployment!.state).toBe('DELETED');

    // A destroyed deployment invalidates its link — the customer page fails
    // closed instead of offering a dead flow.
    const resolveAfter = await resolveLink(publicId, token);
    expect(resolveAfter.statusCode).toBe(404);
  });

  // ── Phase 7: lifecycle, authorization and edge-case hardening ─────────────

  it('an expired link cannot launch a deployment (410 DEPLOY_LINK_EXPIRED)', async () => {
    const { publicId, token, deploymentId } = await createLink();
    await db
      .update(schema.deployLinks)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.deployLinks.id, publicId));

    const response = await launched(publicId, token);
    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ error: { code: 'DEPLOY_LINK_EXPIRED' } });

    const [deployment] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId));
    expect(deployment!.state).toBe('NOT_INSTALLED');
  });

  it('regenerate is refused for a destroyed deployment (409)', async () => {
    const { publicId, deploymentId } = await createLink();
    await db
      .update(schema.deployments)
      .set({ state: 'DELETED', deletedAt: new Date() })
      .where(eq(schema.deployments.id, deploymentId));

    const response = await app.inject({
      method: 'POST',
      url: `/api/deploy-links/${publicId}/regenerate`,
      headers: { cookie: orgA.cookie, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'DEPLOYMENT_ALREADY_STARTED' } });
  });

  it('the vendor list and views never carry the raw token', async () => {
    const { publicId, token } = await createLink();
    const response = await app.inject({
      method: 'GET',
      url: `/api/customers/${customer.id}/deploy-links`,
      headers: { cookie: orgA.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const serialized = response.body;
    // The link id is public; the SECRET must appear nowhere — not raw, not as
    // a column, not leaked through the hash field.
    expect(serialized).not.toContain('"token"');
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('token_hash');
    expect(serialized).toContain(publicId);
  });
});
