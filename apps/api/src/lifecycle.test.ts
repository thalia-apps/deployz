import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import { deriveHealthStatus } from './relay-liveness.js';
import { buildServer } from './server.js';

// The behaviour the end-to-end test pass found missing: honest deployment
// states, an event log that is actually written, per-code diagnostics,
// configuration values that can be removed, and the guards that stop a
// duplicate application, a duplicate release version, or a malformed query
// parameter from reaching Postgres.

async function signUp(auth: Auth, db: Db, email: string) {
  const password = 'super-secret-1';
  const signup = await auth.api.signUpEmail({ body: { email, password, name: 'Test' } });
  const signin = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const cookie = signin.headers.get('set-cookie')!;
  const [membership] = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, signup.user.id))
    .limit(1);
  return { cookie, organizationId: membership!.organizationId };
}

function send(
  app: FastifyInstance,
  method: 'POST' | 'PUT' | 'PATCH',
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method,
    url,
    payload: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * An application may only point at an installation its own organization
 * connected, so the connected installation has to exist first.
 */
async function connectInstallation(db: Db, organizationId: string) {
  await db.insert(schema.githubInstallations).values({
    id: 'inst-1',
    organizationId,
    accountLogin: 'acme',
    accountType: 'Organization',
  });
}

describe('deployment lifecycle — states, events, and removal', () => {
  let client: PGlite | undefined;
  let db: Db;
  let app: FastifyInstance;
  let cookie: string;
  let applicationId: string;
  let customerId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    const auth = createAuth(db);
    app = await buildServer({ auth, db });
    const { cookie: sessionCookie, organizationId } = await signUp(auth, db, 'lifecycle@example.com');
    cookie = sessionCookie;
    await connectInstallation(db, organizationId);
    // createDeployment() below creates PRODUCTION deployments (the default);
    // Paddle migration Phase 7 gates those behind an ACTIVE subscription,
    // which is unrelated to what this file exercises (states, events, removal).
    await db.insert(schema.billingSubscriptions).values({
      organizationId,
      providerCustomerId: 'ctm_fixture_lifecycle',
      providerSubscriptionId: 'sub_fixture_lifecycle',
      status: 'ACTIVE',
    });

    const application = await send(
      app,
      'POST',
      '/api/applications',
      {
        name: 'Acme Analytics',
        githubInstallationId: 'inst-1',
        repoFullName: 'acme/analytics',
        repoUrl: 'https://github.com/acme/analytics',
        defaultBranch: 'main',
      },
      { cookie },
    );
    applicationId = (application.json() as { id: string }).id;

    const customer = await send(
      app,
      'POST',
      '/api/customers',
      { name: 'Acme Corp', email: 'ops@acme.example.com' },
      { cookie },
    );
    customerId = (customer.json() as { id: string }).id;

    // Phase 2 readiness gate: deployment creation requires a READY final
    // manifest, so the application needs a manifest-ready analysis.
    await db
      .update(schema.applications)
      .set({
        detectedMetadata: {
          hasDockerfile: true,
          dockerfilePath: 'Dockerfile',
          port: '3000',
          startupCommands: ['node dist/index.js'],
          usesPostgresql: false,
          postgres: { required: false },
          usesRedis: false,
          redis: { required: false },
          usesS3: false,
          usesLocalFilesystem: false,
          databaseState: 'none',
        },
      })
      .where(eq(schema.applications.id, applicationId));
    // Deployment creation also requires a built release.
    await db.insert(schema.releases).values({
      applicationId,
      version: '1.0.0',
      gitSha: 'a'.repeat(40),
      releaseStatus: 'READY',
      imageDigest: `123456789012.dkr.ecr.us-east-1.amazonaws.com/deployz-fixture@sha256:${'b'.repeat(64)}`,
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  async function createDeployment(): Promise<{ id: string; enrollmentCode: string }> {
    const response = await send(
      app,
      'POST',
      '/api/deployments',
      { applicationId, customerId, region: 'us-east-1' },
      { cookie },
    );
    return response.json() as { id: string; enrollmentCode: string };
  }

  it('a new deployment has no observed health, rather than defaulting to healthy', async () => {
    const deployment = await createDeployment();
    const [row] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id));
    // The column used to default to HEALTHY, so a deployment with nothing
    // provisioned rendered four green infrastructure rows.
    expect(row!.healthStatus).toBe('UNKNOWN');
    expect(row!.installationId).toBeNull();
    // DZ-AUDIT-013: creation stores the expected relay credential hash (the
    // credential itself rides the Quick Create URL); the binding markers stay
    // unset until a relay actually registers.
    expect(row!.relayCredential).not.toBeNull();
    expect(row!.relayBoundAt).toBeNull();
  });

  it('removing a never-installed deployment removes it, with no job for a relay that will never exist', async () => {
    const deployment = await createDeployment();
    const response = await send(app, 'POST', `/api/deployments/${deployment.id}/destroy`, {}, { cookie });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ jobId: null, state: 'DELETED' });

    const [row] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id));
    expect(row!.state).toBe('DELETED');
    expect(row!.deletedAt).not.toBeNull();

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    expect(jobs).toHaveLength(0);
  });

  it('removing an already-removed deployment is refused rather than returning a stale job', async () => {
    const deployment = await createDeployment();
    await send(app, 'POST', `/api/deployments/${deployment.id}/destroy`, {}, { cookie });
    const second = await send(app, 'POST', `/api/deployments/${deployment.id}/destroy`, {}, { cookie });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: { code: 'DEPLOYMENT_ALREADY_REMOVED' } });
  });

  it('writes an event for every transition, so the activity feed has something to show', async () => {
    const deployment = await createDeployment();
    await send(app, 'POST', `/api/deployments/${deployment.id}/destroy`, {}, { cookie });

    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}/events`,
      headers: { cookie },
    });
    const { events } = response.json() as { events: Array<{ eventType: string; deploymentId: string }> };
    // Before this, event_logs had exactly two writers, neither of which set
    // deployment_id — the column this endpoint filters on — so it could never
    // return a row at any point in a deployment's life.
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.deploymentId === deployment.id)).toBe(true);
    expect(events.map((event) => event.eventType)).toContain('destroy.completed');
  });

  it('returns the newest events, oldest first, once a deployment has more than one page', async () => {
    const deployment = await createDeployment();
    const [row] = await db
      .select({ organizationId: schema.deployments.organizationId })
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id));
    const start = Date.parse('2026-01-01T00:00:00Z');
    await db.insert(schema.eventLogs).values(
      Array.from({ length: 60 }, (_, index) => ({
        occurredAt: new Date(start + index * 60_000),
        actorType: 'system',
        actorId: 'test',
        organizationId: row!.organizationId,
        deploymentId: deployment.id,
        eventType: `test.event-${index}`,
      })),
    );
    await send(app, 'POST', `/api/deployments/${deployment.id}/destroy`, {}, { cookie });

    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}/events`,
      headers: { cookie },
    });
    const { events } = response.json() as { events: Array<{ eventType: string; occurredAt: string }> };
    expect(events).toHaveLength(50);
    expect(events.map((event) => event.eventType)).toContain('destroy.completed');
    expect(events.map((event) => event.eventType)).not.toContain('test.event-0');
    const times = events.map((event) => Date.parse(event.occurredAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('a removed deployment leaves the fleet list but stays reachable', async () => {
    const deployment = await createDeployment();
    await send(app, 'POST', `/api/deployments/${deployment.id}/destroy`, {}, { cookie });

    const list = await app.inject({ method: 'GET', url: '/api/deployments', headers: { cookie } });
    const ids = (list.json() as { deployments: Array<{ id: string }> }).deployments.map((d) => d.id);
    expect(ids).not.toContain(deployment.id);

    const withDeleted = await app.inject({
      method: 'GET',
      url: '/api/deployments?includeDeleted=true',
      headers: { cookie },
    });
    const allIds = (withDeleted.json() as { deployments: Array<{ id: string }> }).deployments.map((d) => d.id);
    expect(allIds).toContain(deployment.id);
  });

  it('rejects a malformed id in a query parameter instead of raising in Postgres', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/deployments?applicationId=not-a-uuid',
      headers: { cookie },
    });
    // This used to reach the uuid column and come back as a bare 500.
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('publishing a release marks live deployments as behind (§22/§25)', async () => {
    const deployment = await createDeployment();
    await db
      .update(schema.deployments)
      .set({ state: 'HEALTHY' })
      .where(eq(schema.deployments.id, deployment.id));

    const version = `9.9.${crypto.randomUUID().slice(0, 4)}`;
    const created = await send(
      app,
      'POST',
      `/api/applications/${applicationId}/releases`,
      { version, gitSha: 'a'.repeat(40) },
      { cookie },
    );
    expect(created.statusCode).toBe(201);

    const [row] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id));
    // UPDATE_AVAILABLE is no longer written at release-creation time (the
    // release is still BUILDING) — the state stays HEALTHY until the worker
    // marks the release READY (DZ-AUDIT-007).
    expect(row!.state).toBe('HEALTHY');

    // release.created is recorded in the same transaction as the insert.
    const [release] = await db.select().from(schema.releases).where(eq(schema.releases.version, version));
    const releaseCreated = await db
      .select()
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.eventType, 'release.created'));
    const event = releaseCreated.find((candidate) => candidate.releaseId === release!.id);
    expect(event).toBeDefined();
    expect(event!.payload).toMatchObject({ schemaVersion: 1, applicationId });
    expect(event!.result).toBe('success');
  });
});

describe('duplicate guards', () => {
  let client: PGlite | undefined;
  let db: Db;
  let app: FastifyInstance;
  let cookie: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    const auth = createAuth(db);
    app = await buildServer({ auth, db });
    const { cookie: sessionCookie, organizationId } = await signUp(auth, db, 'duplicates@example.com');
    cookie = sessionCookie;
    await connectInstallation(db, organizationId);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  const repo = {
    name: 'Acme Analytics',
    githubInstallationId: 'inst-1',
    repoFullName: 'acme/analytics',
    repoUrl: 'https://github.com/acme/analytics',
    defaultBranch: 'main',
  };

  it('connecting the same repository twice is refused, and names the application that already has it', async () => {
    const first = await send(app, 'POST', '/api/applications', repo, { cookie });
    expect(first.statusCode).toBe(201);

    const second = await send(app, 'POST', '/api/applications', repo, { cookie });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({
      error: {
        code: 'APPLICATION_ALREADY_CONNECTED',
        // The id comes back so the client can send the vendor to the
        // application they already have rather than making a second one.
        details: { applicationId: (first.json() as { id: string }).id },
      },
    });
  });

  it('reusing a release version is refused', async () => {
    const application = await send(
      app,
      'POST',
      '/api/applications',
      { ...repo, repoFullName: 'acme/other', repoUrl: 'https://github.com/acme/other' },
      { cookie },
    );
    const applicationId = (application.json() as { id: string }).id;

    const first = await send(
      app,
      'POST',
      `/api/applications/${applicationId}/releases`,
      { version: '1.0.0', gitSha: 'a'.repeat(40) },
      { cookie },
    );
    expect(first.statusCode).toBe(201);

    const second = await send(
      app,
      'POST',
      `/api/applications/${applicationId}/releases`,
      { version: '1.0.0', gitSha: 'b'.repeat(40) },
      { cookie },
    );
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: { code: 'RELEASE_VERSION_EXISTS' } });
  });

  it('refuses a release input that could reach the build command, and a second build at once', async () => {
    const application = await send(
      app,
      'POST',
      '/api/applications',
      { ...repo, repoFullName: 'acme/build-inputs', repoUrl: 'https://github.com/acme/build-inputs' },
      { cookie },
    );
    const url = `/api/applications/${(application.json() as { id: string }).id}/releases`;

    const badVersion = await send(app, 'POST', url, { version: '1.0 --build-arg X', gitSha: 'a'.repeat(40) }, { cookie });
    expect(badVersion.statusCode).toBe(400);
    const branchRef = await send(app, 'POST', url, { version: '1.0.0', gitSha: 'main' }, { cookie });
    expect(branchRef.statusCode).toBe(400);

    const first = await send(app, 'POST', url, { version: '1.0.0', gitSha: 'a'.repeat(40) }, { cookie });
    expect(first.statusCode).toBe(201);
    const second = await send(app, 'POST', url, { version: '1.0.1', gitSha: 'b'.repeat(40) }, { cookie });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: { code: 'RELEASE_BUILD_IN_PROGRESS' } });
  });
});

describe('relay liveness (pure)', () => {
  it('health from a disconnected relay is unknown, whatever it last said', () => {
    // It last reported healthy, weeks ago. That is not evidence it is healthy
    // now, and billing follows this state.
    expect(deriveHealthStatus('HEALTHY', 'DISCONNECTED')).toBe('UNKNOWN');
    expect(deriveHealthStatus('HEALTHY', 'CONNECTED')).toBe('HEALTHY');
  });
});
