import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import { compileDeploymentIntent } from './compiler-artifact.js';
import type { EcrClient } from './ecr-grants.js';
import { hashRelayToken } from './relay-store.js';
import { buildServer } from './server.js';

describe('relay trust boundary', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let organizationId: string;
  let applicationId: string;
  let customerId: string;
  let policy: { Statement?: Array<{ Sid: string; Principal: { AWS: string }; Condition?: unknown }> } | null = null;

  const READY_MANIFEST = {
    application: { root: '.', runtime: 'node', framework: 'express', dockerfilePath: 'Dockerfile' },
    build: { command: 'npm run build', context: '.' },
    web: { command: 'npm start', port: 3000 },
    health: { path: '/health' },
    database: { postgres: true },
    redis: { required: false, envBindings: [] },
    storage: { required: false, envBindings: [] },
    migration: { command: 'npm run db:migrate' },
    worker: { command: null },
    environment: { variables: [] },
    externalServices: [],
    unsupported: [],
  } as const;

  const fakeEcr: EcrClient = {
    async getRepositoryPolicy() {
      return policy ? { policyText: policy as unknown as Record<string, unknown> } : null;
    },
    async setRepositoryPolicy(_name, policyText) {
      policy = policyText as unknown as typeof policy;
    },
    async deleteRepositoryPolicy() {
      policy = null;
    },
  };

  async function insertDeployment(
    overrides: Partial<typeof schema.deployments.$inferInsert> = {},
  ): Promise<typeof schema.deployments.$inferSelect> {
    const [row] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        state: 'NOT_INSTALLED',
        enrollmentCode: crypto.randomUUID(),
        desiredState: { manifest: READY_MANIFEST },
        specV2: compileDeploymentIntent({
          manifest: READY_MANIFEST as unknown as Parameters<typeof compileDeploymentIntent>[0]['manifest'],
          region: 'us-east-1',
        }).spec,
        ...overrides,
      })
      .returning();
    return row!;
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);

    const email = 'audit-relay@example.com';
    const password = 'super-secret-1';
    await auth.api.signUpEmail({ body: { email, password, name: 'Audit' } });

    app = await buildServer({ auth, db, ecrClient: fakeEcr });

    const memberships = await db.select({ organizationId: schema.member.organizationId }).from(schema.member).limit(1);
    organizationId = memberships[0]!.organizationId;

    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'App',
        repoFullName: `acme/audit-${crypto.randomUUID().slice(0, 8)}`,
        repoUrl: 'https://github.com/acme/audit',
        defaultBranch: 'main',
      })
      .returning();
    applicationId = application!.id;
    await db.insert(schema.releases).values({
      applicationId,
      version: '1.0.0',
      gitSha: 'a'.repeat(40),
      releaseStatus: 'READY',
      imageDigest: `123456789012.dkr.ecr.us-east-1.amazonaws.com/deployz-fixture@sha256:${'b'.repeat(64)}`,
    });

    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId, name: 'Cust', email: `cust-${crypto.randomUUID()}@example.com` })
      .returning();
    customerId = customer!.id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('register refuses an awsAccountId that is not 12 digits and grants the valid one', async () => {
    const credential = 'cred-' + crypto.randomUUID();
    const deployment = await insertDeployment({
      relayCredential: credential,
      relayTokenHash: hashRelayToken(credential),
    });
    const headers = { authorization: `Bearer ${credential}`, 'content-type': 'application/json' };
    const bad = await app.inject({
      method: 'POST',
      url: '/api/relay/register',
      headers,
      payload: JSON.stringify({
        enrollmentCode: deployment.enrollmentCode,
        installationId: 'inst-' + crypto.randomUUID(),
        awsAccountId: 'not-an-account-id',
      }),
    });
    expect(bad.statusCode).toBe(400);
    const [unchanged] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id)).limit(1);
    expect(unchanged!.enrollmentUsedAt).toBeNull();

    const installationId = 'inst-' + crypto.randomUUID();
    const good = await app.inject({
      method: 'POST',
      url: '/api/relay/register',
      headers,
      payload: JSON.stringify({
        enrollmentCode: deployment.enrollmentCode,
        installationId,
        awsAccountId: '999999999999',
      }),
    });
    expect(good.statusCode).toBe(200);
    const statement = policy?.Statement?.find((s) => s.Sid === `deployz-pull-${installationId}`);
    expect(statement?.Principal.AWS).toBe('arn:aws:iam::999999999999:root');
  });

  it('re-enrollment revokes the grant of the previous installation', async () => {
    const credential = 'cred-' + crypto.randomUUID();
    const previousInstallationId = 'inst-' + crypto.randomUUID();
    const deployment = await insertDeployment({
      relayCredential: credential,
      relayTokenHash: hashRelayToken(credential),
      previousInstallationId,
    });
    policy = {
      Statement: [
        { Sid: `deployz-pull-${previousInstallationId}`, Principal: { AWS: 'arn:aws:iam::111111111111:root' } },
      ],
    };
    const installationId = 'inst-' + crypto.randomUUID();
    const response = await app.inject({
      method: 'POST',
      url: '/api/relay/register',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        enrollmentCode: deployment.enrollmentCode,
        installationId,
        awsAccountId: '222222222222',
      }),
    });
    expect(response.statusCode).toBe(200);
    const sids = policy?.Statement?.map((s) => s.Sid);
    expect(sids).toContain(`deployz-pull-${installationId}`);
    expect(sids).not.toContain(`deployz-pull-${previousInstallationId}`);
  });

  it('register refuses an expired install link', async () => {
    const credential = 'cred-' + crypto.randomUUID();
    const deployment = await insertDeployment({
      relayCredential: credential,
      relayTokenHash: hashRelayToken(credential),
      installLinkExpiresAt: new Date(Date.now() - 60_000),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/relay/register',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ enrollmentCode: deployment.enrollmentCode, installationId: 'inst-' + crypto.randomUUID() }),
    });
    expect(response.statusCode).toBe(410);
  });

  it('a DELETED deployment token no longer reads config or reports health', async () => {
    const token = 'tok-' + crypto.randomUUID();
    const installationId = 'inst-' + crypto.randomUUID();
    const deployment = await insertDeployment({
      state: 'DELETED',
      deletedAt: new Date(),
      installationId,
      enrollmentUsedAt: new Date(),
      relayTokenHash: hashRelayToken(token),
      relayStatus: 'DISCONNECTED',
      awsAccountId: '111111111111',
    });

    const config = await app.inject({
      method: 'GET',
      url: `/api/relay/config?installationId=${installationId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(config.statusCode).toBe(410);

    const health = await app.inject({
      method: 'POST',
      url: '/api/relay/health',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ installationId, healthStatus: 'HEALTHY', observedState: {} }),
    });
    expect(health.statusCode).toBe(410);

    const [row] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id)).limit(1);
    expect(row!.relayStatus).toBe('DISCONNECTED');
    expect(row!.healthStatus).not.toBe('HEALTHY');
  });

  it('a successful PURGE revokes the relay token', async () => {
    const token = 'tok-' + crypto.randomUUID();
    const installationId = 'inst-' + crypto.randomUUID();
    const deployment = await insertDeployment({
      state: 'DELETED',
      deletedAt: new Date(),
      installationId,
      enrollmentUsedAt: new Date(),
      relayTokenHash: hashRelayToken(token),
    });
    const [job] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: deployment.id,
        type: 'PURGE',
        state: 'RUNNING',
        startedAt: new Date(),
        idempotencyKey: `${deployment.id}:PURGE:revoke`,
        payload: {},
      })
      .returning();
    const result = await app.inject({
      method: 'POST',
      url: `/api/relay/commands/${job!.id}/result`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ success: true }),
    });
    expect(result.statusCode).toBe(200);
    const [row] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id)).limit(1);
    expect(row!.relayTokenHash).toBeNull();
    const poll = await app.inject({
      method: 'GET',
      url: `/api/relay/commands?installationId=${installationId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(poll.statusCode).toBe(401);
  });

  it('a result for an unclaimed REQUESTED DESTROY is refused and settles nothing', async () => {
    const token = 'tok-' + crypto.randomUUID();
    const installationId = 'inst-' + crypto.randomUUID();
    const deployment = await insertDeployment({
      state: 'HEALTHY',
      installationId,
      enrollmentUsedAt: new Date(),
      relayTokenHash: hashRelayToken(token),
      relayStatus: 'CONNECTED',
    });
    const [job] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: deployment.id,
        type: 'DESTROY',
        state: 'REQUESTED',
        idempotencyKey: `${deployment.id}:DESTROY:unclaimed`,
        payload: {},
      })
      .returning();

    const result = await app.inject({
      method: 'POST',
      url: `/api/relay/commands/${job!.id}/result`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ success: true, output: { note: 'nothing was destroyed' } }),
    });
    expect(result.statusCode).toBe(409);
    expect(result.json()).toMatchObject({ error: { code: 'COMMAND_NOT_CLAIMED' } });

    const [settled] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, job!.id)).limit(1);
    expect(settled!.state).toBe('REQUESTED');
    const [row] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id)).limit(1);
    expect(row!.state).toBe('HEALTHY');
  });

  it('heartbeat refuses a non-numeric account id and an oversized observedState', async () => {
    const token = 'tok-' + crypto.randomUUID();
    const installationId = 'inst-' + crypto.randomUUID();
    await insertDeployment({
      state: 'HEALTHY',
      installationId,
      enrollmentUsedAt: new Date(),
      relayTokenHash: hashRelayToken(token),
    });
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const badAccount = await app.inject({
      method: 'POST',
      url: '/api/relay/health',
      headers,
      payload: JSON.stringify({ installationId, healthStatus: 'HEALTHY', identity: { awsAccountId: 'x' } }),
    });
    expect(badAccount.statusCode).toBe(400);
    const tooLarge = await app.inject({
      method: 'POST',
      url: '/api/relay/health',
      headers,
      payload: JSON.stringify({ installationId, healthStatus: 'HEALTHY', observedState: { filler: 'x'.repeat(300_000) } }),
    });
    expect(tooLarge.statusCode).toBe(413);
  });

  // Verified control: a token of deployment A cannot touch deployment B's job
  // (binding is job -> job.deploymentId -> that row's token hash).
  it('control: result/authority/release for another deployment job are refused with 401', async () => {
    const tokenA = 'tok-' + crypto.randomUUID();
    await insertDeployment({
      installationId: 'inst-' + crypto.randomUUID(),
      enrollmentUsedAt: new Date(),
      relayTokenHash: hashRelayToken(tokenA),
    });
    const tokenB = 'tok-' + crypto.randomUUID();
    const b = await insertDeployment({
      installationId: 'inst-' + crypto.randomUUID(),
      enrollmentUsedAt: new Date(),
      relayTokenHash: hashRelayToken(tokenB),
    });
    const [jobB] = await db
      .insert(schema.deploymentJobs)
      .values({ deploymentId: b.id, type: 'RESTART', state: 'RUNNING', idempotencyKey: `${b.id}:RESTART:audit`, payload: {} })
      .returning();
    const headers = { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' };
    const result = await app.inject({ method: 'POST', url: `/api/relay/commands/${jobB!.id}/result`, headers, payload: '{"success":true}' });
    expect(result.statusCode).toBe(401);
    const authority = await app.inject({ method: 'GET', url: `/api/relay/commands/${jobB!.id}/authority`, headers });
    expect(authority.statusCode).toBe(401);
    const release = await app.inject({ method: 'POST', url: `/api/relay/commands/${jobB!.id}/release`, headers, payload: '{}' });
    expect(release.statusCode).toBe(401);
    // An old-token header matching nothing does not widen acceptance.
    const widened = await app.inject({
      method: 'POST',
      url: `/api/relay/commands/${jobB!.id}/result`,
      headers: { ...headers, 'x-deployz-old-token': 'tok-' + crypto.randomUUID() },
      payload: '{"success":true}',
    });
    expect(widened.statusCode).toBe(401);
  });
});
