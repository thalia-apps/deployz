import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from '../auth.js';
import { buildServer } from '../server.js';

// ── Shared test helpers (matches admin-overview-vendors.test.ts style) ─────

async function signUpAndGetOrg(
  auth: Auth,
  db: Db,
  email: string,
): Promise<{ userId: string; organizationId: string; cookie: string; email: string; name: string }> {
  const password = crypto.randomUUID();
  const name = email.split('@')[0]!;
  const signup = await auth.api.signUpEmail({ body: { email, password, name } });
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
  return { userId: signup.user.id, organizationId, cookie: setCookie, email, name };
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
      name: 'Test App',
      repoFullName: `acme/test-app-${crypto.randomUUID().slice(0, 8)}`,
      repoUrl: 'https://github.com/acme/test-app',
      defaultBranch: 'main',
      ...overrides,
    })
    .returning();
  return row!;
}

async function insertCustomer(
  db: Db,
  organizationId: string,
  overrides: Partial<typeof schema.customers.$inferInsert> = {},
): Promise<typeof schema.customers.$inferSelect> {
  const [row] = await db
    .insert(schema.customers)
    .values({
      organizationId,
      name: 'Test Customer',
      email: `customer-${crypto.randomUUID()}@example.com`,
      ...overrides,
    })
    .returning();
  return row!;
}

async function insertDeployment(
  db: Db,
  organizationId: string,
  applicationId: string,
  customerId: string,
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
      installationId: `inst-${crypto.randomUUID()}`,
      enrollmentCode: crypto.randomUUID(),
      ...overrides,
    })
    .returning();
  return row!;
}

async function insertJob(
  db: Db,
  deploymentId: string,
  overrides: Partial<typeof schema.deploymentJobs.$inferInsert> = {},
): Promise<typeof schema.deploymentJobs.$inferSelect> {
  const [row] = await db
    .insert(schema.deploymentJobs)
    .values({
      deploymentId,
      type: 'DEPLOY_RELEASE',
      state: 'RUNNING',
      idempotencyKey: `job-${crypto.randomUUID()}`,
      ...overrides,
    })
    .returning();
  return row!;
}

function getReq(app: FastifyInstance, url: string, cookie: string) {
  return app.inject({ method: 'GET', url, headers: { cookie } });
}

describe('Team Admin: deployments + jobs + connections read models', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;

  let admin: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let org: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let application: typeof schema.applications.$inferSelect;
  let customer: typeof schema.customers.$inferSelect;

  let depActive: typeof schema.deployments.$inferSelect;
  let depFailed: typeof schema.deployments.$inferSelect;
  let depUnhealthy: typeof schema.deployments.$inferSelect;
  let depStuck: typeof schema.deployments.$inferSelect;
  let depDeleting: typeof schema.deployments.$inferSelect;
  let depDisconnected: typeof schema.deployments.$inferSelect;
  let depDegraded: typeof schema.deployments.$inferSelect;
  let depBootstrapIncomplete: typeof schema.deployments.$inferSelect;
  let depWithInfra: typeof schema.deployments.$inferSelect;

  let stuckJob: typeof schema.deploymentJobs.$inferSelect;
  let queuedJob: typeof schema.deploymentJobs.$inferSelect;
  let failedJobWithSecret: typeof schema.deploymentJobs.$inferSelect;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);

    admin = await signUpAndGetOrg(auth, db, `admin-${crypto.randomUUID()}@example.com`);
    await db.update(schema.user).set({ platformRole: 'ADMIN' }).where(eq(schema.user.id, admin.userId));
    app = await buildServer({ auth, db, teamAdminEmails: [], teamAdminEnvGrantsEnabled: false });

    org = await signUpAndGetOrg(auth, db, `vendor-${crypto.randomUUID()}@example.com`);
    application = await insertApplication(db, org.organizationId, { databaseRequired: true });
    customer = await insertCustomer(db, org.organizationId, { name: 'Acme Co', email: 'acme@example.com' });

    depActive = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'INSTALLING',
      relayStatus: 'UNKNOWN',
    });

    depFailed = await insertDeployment(db, org.organizationId, application.id, customer.id, { state: 'FAILED' });

    depUnhealthy = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'HEALTHY',
      healthStatus: 'UNHEALTHY',
      relayStatus: 'CONNECTED',
      lastHealthAt: new Date(),
    });

    depStuck = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'UPDATING',
      relayStatus: 'CONNECTED',
      lastHealthAt: new Date(),
    });
    const stuckSignalAt = new Date(Date.now() - 25 * 60 * 1000);
    stuckJob = await insertJob(db, depStuck.id, {
      type: 'DEPLOY_RELEASE',
      state: 'RUNNING',
      startedAt: stuckSignalAt,
      lastProgressAt: stuckSignalAt,
    });

    depDeleting = await insertDeployment(db, org.organizationId, application.id, customer.id, { state: 'DELETING' });

    depDisconnected = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'HEALTHY',
      relayStatus: 'DISCONNECTED',
    });

    // DEGRADED connection: relay reports CONNECTED but the last heartbeat is stale.
    depDegraded = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'HEALTHY',
      relayStatus: 'CONNECTED',
      lastHealthAt: new Date(Date.now() - 30 * 60 * 1000),
    });

    // BOOTSTRAP_INCOMPLETE: relay never bound (installationId null, still waiting).
    depBootstrapIncomplete = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'WAITING_FOR_RELAY',
      relayStatus: 'UNKNOWN',
      installationId: null,
    });

    // A deployment with a seeded infrastructure inventory across component kinds.
    depWithInfra = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'HEALTHY',
      relayStatus: 'CONNECTED',
      healthStatus: 'HEALTHY',
      lastHealthAt: new Date(),
    });
    await db.insert(schema.deploymentResources).values([
      {
        deploymentId: depWithInfra.id,
        stackId: 'stack-1',
        logicalResourceId: 'AppService',
        resourceType: 'AWS::ECS::Service',
        resourceStatus: 'ready',
        componentKind: 'application',
        resourceRole: 'primary',
        lifecyclePolicy: 'delete',
        lastUpdatedAt: new Date(),
        firstSeenAt: new Date(),
      },
      {
        deploymentId: depWithInfra.id,
        stackId: 'stack-1',
        logicalResourceId: 'AppDb',
        resourceType: 'AWS::RDS::DBInstance',
        resourceStatus: 'ready',
        componentKind: 'database',
        resourceRole: 'primary',
        lifecyclePolicy: 'retain',
        lastUpdatedAt: new Date(),
        firstSeenAt: new Date(),
      },
      {
        deploymentId: depWithInfra.id,
        stackId: 'stack-1',
        logicalResourceId: 'AppVpc',
        resourceType: 'AWS::EC2::VPC',
        resourceStatus: 'ready',
        componentKind: 'network',
        resourceRole: 'supporting',
        lifecyclePolicy: 'delete',
        lastUpdatedAt: new Date(),
        firstSeenAt: new Date(),
      },
    ]);
    await db.insert(schema.deploymentJobs).values({
      deploymentId: depWithInfra.id,
      type: 'INSTALL',
      state: 'SUCCEEDED',
      idempotencyKey: `job-${crypto.randomUUID()}`,
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    await db.insert(schema.eventLogs).values({
      actorType: 'system',
      actorId: 'relay',
      organizationId: org.organizationId,
      deploymentId: depWithInfra.id,
      eventType: 'health.report',
      result: 'success',
    });
    await db.insert(schema.deploymentStackEvents).values({
      deploymentId: depWithInfra.id,
      providerEventId: `evt-${crypto.randomUUID()}`,
      eventAt: new Date(),
      logicalResourceId: 'AppService',
      resourceType: 'AWS::ECS::Service',
      resourceStatus: 'CREATE_COMPLETE',
    });

    // Queued job (a different type/deployment) for the jobs list `queued` filter.
    queuedJob = await insertJob(db, depActive.id, { type: 'INSTALL', state: 'QUEUED' });

    // A FAILED job whose error text carries a secret — must never leak.
    // Its payload mirrors buildInstallParameters' shape: REAL per-deployment
    // secrets under camelCase keys the env-text regexes never match.
    failedJobWithSecret = await insertJob(db, depFailed.id, {
      type: 'INSTALL',
      state: 'FAILED',
      failureCode: 'DATABASE_CONNECTION_FAILED',
      startedAt: new Date(),
      finishedAt: new Date(),
      payload: {
        recovery: { neverInstalled: true },
        parameters: {
          paramNextauthSecret: 'nextauth-secret-value',
          paramEncryptionKey: 'encryption-key-value',
        },
      },
      result: { error: 'connection failed: postgres://user:secret@host:5432/db' },
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  describe('GET /api/admin/deployments', () => {
    it('lists cross-tenant deployment rows with a stuck flag', async () => {
      const response = await getReq(app, '/api/admin/deployments', admin.cookie);
      expect(response.statusCode).toBe(200);
      const body = response.json() as { deployments: { id: string; stuck: boolean }[] };
      const stuckRow = body.deployments.find((d) => d.id === depStuck.id);
      expect(stuckRow?.stuck).toBe(true);
      const activeRow = body.deployments.find((d) => d.id === depActive.id);
      expect(activeRow?.stuck).toBe(false);
    });

    it('each filter includes its matching deployment', async () => {
      const cases: [string, () => string][] = [
        ['active', () => depActive.id],
        ['failed', () => depFailed.id],
        ['unhealthy', () => depUnhealthy.id],
        ['stuck', () => depStuck.id],
        ['deleting', () => depDeleting.id],
        ['disconnected', () => depDisconnected.id],
      ];
      for (const [filter, expectedId] of cases) {
        const response = await getReq(app, `/api/admin/deployments?filter=${filter}`, admin.cookie);
        const body = response.json() as { deployments: { id: string }[] };
        expect.soft(body.deployments.map((d) => d.id), filter).toContain(expectedId());
      }
    });

    it('q matches customer, application, org names, awsAccountId and region', async () => {
      const response = await getReq(app, '/api/admin/deployments?q=Acme%20Co', admin.cookie);
      const body = response.json() as { deployments: { id: string }[] };
      expect(body.deployments.map((d) => d.id)).toContain(depFailed.id);
    });
  });

  describe('GET /api/admin/deployments/:id', () => {
    it('composes the command-center detail with status, infra, jobs, connection', async () => {
      const response = await getReq(app, `/api/admin/deployments/${depWithInfra.id}`, admin.cookie);
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        deploymentStatus: { stage: string; step: string };
        infrastructure: { components: { kind: string }[]; summary: { componentCount: number } };
        jobs: { stuck: boolean }[];
        connection: { communicationPossible: boolean };
        recentEvents: unknown[];
        recentStackEvents: unknown[];
        vendor: { organizationId: string };
        customer: { name: string };
        application: { id: string };
      };

      expect(body.deploymentStatus.stage).toBeTruthy();
      expect(body.deploymentStatus.step).toBeTruthy();

      const kinds = body.infrastructure.components.map((c) => c.kind).sort();
      expect(kinds).toEqual(['application', 'database', 'network']);
      expect(body.infrastructure.summary.componentCount).toBe(3);

      expect(body.jobs.length).toBeGreaterThan(0);
      expect(body.connection.communicationPossible).toBe(true);
      expect(body.recentEvents.length).toBeGreaterThan(0);
      expect(body.recentStackEvents.length).toBeGreaterThan(0);
      expect(body.vendor.organizationId).toBe(org.organizationId);
      expect(body.customer.name).toBe('Acme Co');
      expect(body.application.id).toBe(application.id);
    });

    it('deploymentStatus components follow the deployment stored manifest when the live application column disagrees', async () => {
      // `application` (shared fixture, above) has databaseRequired: true —
      // this deployment's frozen manifest says otherwise. The manifest must
      // win (Phase 2): admin/queries.ts derives the booleans the same way
      // server.ts does, never from the live application row.
      const drifted = await insertDeployment(db, org.organizationId, application.id, customer.id, {
        state: 'HEALTHY',
        relayStatus: 'CONNECTED',
        healthStatus: 'HEALTHY',
        lastHealthAt: new Date(),
        desiredState: {
          manifest: {
            application: { root: '.', runtime: 'node', framework: null, dockerfilePath: null },
            build: { command: null, context: '.' },
            web: { command: null, port: 3000 },
            health: { path: '/health' },
            database: { postgres: false },
            redis: { required: false, envBindings: [] },
            storage: { required: false, envBindings: [] },
            migration: { command: null },
            worker: { command: null },
            environment: { variables: [] },
            externalServices: [],
            unsupported: [],
          },
        },
      });

      const response = await getReq(app, `/api/admin/deployments/${drifted.id}`, admin.cookie);
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        deploymentStatus: { components: { key: string; status: string }[] };
      };
      const database = body.deploymentStatus.components.find((c) => c.key === 'database');
      expect(database?.status).toBe('NOT_REQUIRED');
    });

    it('communicationPossible is false when the last heartbeat is stale', async () => {
      const response = await getReq(app, `/api/admin/deployments/${depDegraded.id}`, admin.cookie);
      const body = response.json() as { connection: { communicationPossible: boolean; relayStatus: string } };
      expect(body.connection.relayStatus).toBe('CONNECTED');
      expect(body.connection.communicationPossible).toBe(false);
    });

    it('404s for an unknown deployment id', async () => {
      const response = await getReq(app, `/api/admin/deployments/${crypto.randomUUID()}`, admin.cookie);
      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /api/admin/jobs', () => {
    it('filter=queued/stuck/failed select the right rows', async () => {
      const queued = await getReq(app, '/api/admin/jobs?filter=queued', admin.cookie);
      expect((queued.json() as { jobs: { id: string }[] }).jobs.map((j) => j.id)).toContain(queuedJob.id);

      const stuck = await getReq(app, '/api/admin/jobs?filter=stuck', admin.cookie);
      const stuckJobs = (stuck.json() as { jobs: { id: string; stuck: boolean }[] }).jobs;
      expect(stuckJobs.map((j) => j.id)).toContain(stuckJob.id);
      expect(stuckJobs.every((j) => j.stuck)).toBe(true);

      const failed = await getReq(app, '/api/admin/jobs?filter=failed', admin.cookie);
      expect((failed.json() as { jobs: { id: string }[] }).jobs.map((j) => j.id)).toContain(failedJobWithSecret.id);
    });

    it('never leaks a secret from a job error into errorDetail', async () => {
      const response = await getReq(app, '/api/admin/jobs?filter=failed', admin.cookie);
      const body = response.json() as { jobs: { id: string; errorDetail: string | null }[] };
      const row = body.jobs.find((j) => j.id === failedJobWithSecret.id);
      expect(row?.errorDetail).toBeTruthy();
      expect(row!.errorDetail).not.toContain('secret');
      expect(row!.errorDetail).toContain('[REDACTED]');
    });

    it('never leaks install-parameter secrets from job payloads on the deployment detail', async () => {
      const response = await getReq(app, `/api/admin/deployments/${depFailed.id}`, admin.cookie);
      expect(response.statusCode).toBe(200);
      const raw = response.body;
      expect(raw).not.toContain('nextauth-secret-value');
      expect(raw).not.toContain('encryption-key-value');
      const body = response.json() as {
        jobs: { id: string; payload: { parameters?: Record<string, string> } }[];
      };
      const row = body.jobs.find((j) => j.id === failedJobWithSecret.id);
      expect(row?.payload.parameters?.paramNextauthSecret).toBe('[REDACTED]');
    });
  });

  describe('GET /api/admin/jobs/:id', () => {
    it('returns a timeline ordered chronologically and a redacted errorDetail', async () => {
      const response = await getReq(app, `/api/admin/jobs/${failedJobWithSecret.id}`, admin.cookie);
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        errorDetail: string;
        timeline: { at: string; label: string }[];
        vendor: { organizationId: string };
        deployment: { id: string };
      };
      expect(body.errorDetail).not.toContain('secret');
      expect(response.body).not.toContain('nextauth-secret-value');
      expect(response.body).not.toContain('encryption-key-value');
      const times = body.timeline.map((entry) => entry.at);
      const sorted = [...times].sort();
      expect(times).toEqual(sorted);
      expect(body.timeline.some((entry) => entry.label === 'created')).toBe(true);
      expect(body.vendor.organizationId).toBe(org.organizationId);
      expect(body.deployment.id).toBe(depFailed.id);
    });

    it('never returns an unclaimed CONFIG_UPDATE secret value', async () => {
      const job = await insertJob(db, depFailed.id, {
        type: 'CONFIG_UPDATE',
        state: 'REQUESTED',
        payload: { changedKeys: ['DB_PASSWORD'], secrets: [{ key: 'DB_PASSWORD', value: 'hunter2-plain-customer-value' }] },
      });
      const response = await getReq(app, `/api/admin/jobs/${job.id}`, admin.cookie);
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('hunter2-plain-customer-value');
      const deployment = await getReq(app, `/api/admin/deployments/${depFailed.id}`, admin.cookie);
      expect(deployment.body).not.toContain('hunter2-plain-customer-value');
    });

    it('404s for an unknown job id', async () => {
      const response = await getReq(app, `/api/admin/jobs/${crypto.randomUUID()}`, admin.cookie);
      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /api/admin/connections', () => {
    it('derives DEGRADED for a stale heartbeat and BOOTSTRAP_INCOMPLETE for an unbound relay', async () => {
      const response = await getReq(app, '/api/admin/connections', admin.cookie);
      const body = response.json() as { connections: { deploymentId: string; connectionState: string }[] };
      const degraded = body.connections.find((c) => c.deploymentId === depDegraded.id);
      expect(degraded?.connectionState).toBe('DEGRADED');
      const incomplete = body.connections.find((c) => c.deploymentId === depBootstrapIncomplete.id);
      expect(incomplete?.connectionState).toBe('BOOTSTRAP_INCOMPLETE');
      const disconnected = body.connections.find((c) => c.deploymentId === depDisconnected.id);
      expect(disconnected?.connectionState).toBe('DISCONNECTED');
    });

    it('filter=degraded returns only degraded connections', async () => {
      const response = await getReq(app, '/api/admin/connections?filter=degraded', admin.cookie);
      const body = response.json() as { connections: { deploymentId: string }[] };
      expect(body.connections.map((c) => c.deploymentId)).toEqual([depDegraded.id]);
    });
  });

  describe('GET /api/admin/connections/:id', () => {
    it('returns the connection block plus recent jobs', async () => {
      const response = await getReq(app, `/api/admin/connections/${depStuck.id}`, admin.cookie);
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        connection: { bootstrapStackName: string | null; attemptNumber: number };
        jobs: { id: string }[];
      };
      expect(body.jobs.map((j) => j.id)).toContain(stuckJob.id);
      expect(body.connection).toHaveProperty('bootstrapStackName');
      expect(body.connection).toHaveProperty('attemptNumber');
    });

    it('404s for an unknown deployment id', async () => {
      const response = await getReq(app, `/api/admin/connections/${crypto.randomUUID()}`, admin.cookie);
      expect(response.statusCode).toBe(404);
    });
  });
});
