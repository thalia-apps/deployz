import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import { healthyReleaseEvidence, webOnlySpec } from './release-evidence-fixture.js';
import { hashRelayToken } from './relay-store.js';
import { buildServer } from './server.js';

// Paddle migration Phase 2: the billing state machine is wired into the
// deployment lifecycle at exactly three points (docs/billing/paddle-billing.md,
// "The lifecycle, end to end") — the relay-authenticated write paths that can observe
// derived stage READY, and the destroy/force-complete family that accepts a
// removal. This exercises those hook sites end to end, through the real
// routes, against a PGlite database.
describe('billing lifecycle', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let cookie: string;
  let organizationId: string;
  let applicationId: string;
  let customerId: string;
  const spec = webOnlySpec();

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);

    const email = 'billing-lifecycle@example.com';
    const password = 'super-secret-1';
    await auth.api.signUpEmail({ body: { email, password, name: 'Billing' } });
    const signin = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    cookie = signin.headers.get('set-cookie')!;

    app = await buildServer({ auth, db });

    const memberships = await db
      .select({ organizationId: schema.member.organizationId })
      .from(schema.member)
      .limit(1);
    organizationId = memberships[0]!.organizationId;

    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'App',
        repoFullName: `acme/bl-${crypto.randomUUID().slice(0, 8)}`,
        repoUrl: 'https://github.com/acme/bl',
        defaultBranch: 'main',
      })
      .returning();
    applicationId = application!.id;

    const [customer] = await db
      .insert(schema.customers)
      .values({
        organizationId,
        name: 'Cust',
        email: `cust-${crypto.randomUUID()}@example.com`,
      })
      .returning();
    customerId = customer!.id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  async function seedDeployment(
    overrides: Partial<typeof schema.deployments.$inferInsert> = {},
  ): Promise<{ deployment: typeof schema.deployments.$inferSelect; token: string; installationId: string }> {
    const token = 'tok-' + crypto.randomUUID();
    const installationId = 'inst-' + crypto.randomUUID();
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        state: 'HEALTHY',
        installationId,
        enrollmentCode: crypto.randomUUID(),
        enrollmentUsedAt: new Date(),
        relayTokenHash: hashRelayToken(token),
        relayStatus: 'CONNECTED',
        healthStatus: 'UNKNOWN',
        specV2: spec as unknown as Record<string, unknown>,
        ...overrides,
      })
      .returning();
    return { deployment: deployment!, token, installationId };
  }

  async function fetchDeployment(id: string): Promise<typeof schema.deployments.$inferSelect> {
    const [row] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, id));
    return row!;
  }

  function heartbeat(installationId: string, token: string) {
    return app.inject({
      method: 'POST',
      url: '/api/relay/health',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        installationId,
        observedState: { releaseEvidence: healthyReleaseEvidence(spec, 'sha256:' + 'a'.repeat(64)) },
        healthStatus: 'HEALTHY',
      }),
    });
  }

  it('1. a PRODUCTION deployment that reaches READY through the relay heartbeat activates billing exactly once', async () => {
    const { deployment, token, installationId } = await seedDeployment({
      deploymentType: 'PRODUCTION',
      defaultHttps: { hostname: 'd-bl-1.deployz.dev', status: 'ACTIVE', checkCycle: 1, lastError: null },
    });

    const first = await heartbeat(installationId, token);
    expect(first.statusCode, first.body).toBe(200);
    const afterFirst = await fetchDeployment(deployment.id);
    expect(afterFirst.billingState).toBe('ACTIVE');
    expect(afterFirst.billingStartedAt).not.toBeNull();
    const startedAt = afterFirst.billingStartedAt;

    const second = await heartbeat(installationId, token);
    expect(second.statusCode, second.body).toBe(200);
    const afterSecond = await fetchDeployment(deployment.id);
    expect(afterSecond.billingState).toBe('ACTIVE');
    expect(afterSecond.billingStartedAt).toEqual(startedAt);

    const events = await db
      .select({ eventType: schema.eventLogs.eventType })
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.deploymentId, deployment.id));
    expect(events.filter((e) => e.eventType === 'deployment.billing_started')).toHaveLength(1);
  });

  it('1b. a PAUSED deployment resumes billing at its next verified READY heartbeat', async () => {
    const startedAt = new Date('2026-01-01T00:00:00.000Z');
    const { deployment, token, installationId } = await seedDeployment({
      deploymentType: 'PRODUCTION',
      relayStatus: 'DISCONNECTED',
      billingState: 'PAUSED',
      billingStartedAt: startedAt,
      defaultHttps: { hostname: 'd-bl-1b.deployz.dev', status: 'ACTIVE', checkCycle: 1, lastError: null },
    });

    const response = await heartbeat(installationId, token);
    expect(response.statusCode, response.body).toBe(200);

    const row = await fetchDeployment(deployment.id);
    expect(row.billingState).toBe('ACTIVE');
    expect(row.billingStartedAt).toEqual(startedAt);
    const events = await db
      .select({ eventType: schema.eventLogs.eventType })
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.deploymentId, deployment.id));
    expect(events.filter((e) => e.eventType === 'deployment.billing_resumed')).toHaveLength(1);
    expect(events.filter((e) => e.eventType === 'deployment.billing_started')).toHaveLength(0);
  });

  it('2. a TEST deployment that reaches READY stays NOT_STARTED', async () => {
    const { deployment, token, installationId } = await seedDeployment({
      deploymentType: 'TEST',
      defaultHttps: { hostname: 'd-bl-2.deployz.dev', status: 'ACTIVE', checkCycle: 1, lastError: null },
    });

    const response = await heartbeat(installationId, token);
    expect(response.statusCode, response.body).toBe(200);
    const row = await fetchDeployment(deployment.id);
    expect(row.billingState).toBe('NOT_STARTED');
    expect(row.billingStartedAt).toBeNull();
  });

  it('3. a PRODUCTION deployment at HEALTHY without an HTTPS URL (not READY) stays NOT_STARTED', async () => {
    const { deployment, token, installationId } = await seedDeployment({
      deploymentType: 'PRODUCTION',
      defaultHttps: null,
    });

    const response = await heartbeat(installationId, token);
    expect(response.statusCode, response.body).toBe(200);
    const row = await fetchDeployment(deployment.id);
    expect(row.billingState).toBe('NOT_STARTED');
    expect(row.billingStartedAt).toBeNull();
  });

  it('4. a failed DEPLOY_RELEASE over a running release keeps ACTIVE', async () => {
    const [release] = await db
      .insert(schema.releases)
      .values({
        applicationId,
        version: '1.0.0-bl4',
        gitSha: 'abc123',
        buildStatus: 'SUCCEEDED',
        releaseStatus: 'READY',
      })
      .returning();
    const startedAt = new Date('2026-01-01T00:00:00.000Z');
    const { deployment, token } = await seedDeployment({
      deploymentType: 'PRODUCTION',
      currentReleaseId: release!.id,
      billingState: 'ACTIVE',
      billingStartedAt: startedAt,
    });
    const [job] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: deployment.id,
        type: 'DEPLOY_RELEASE',
        state: 'RUNNING',
        idempotencyKey: `${deployment.id}:DEPLOY_RELEASE:${release!.id}`,
        payload: { releaseId: release!.id },
      })
      .returning();

    const result = await app.inject({
      method: 'POST',
      url: `/api/relay/commands/${job!.id}/result`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ success: false, error: 'boom', failureCode: 'ECS_DEPLOYMENT_FAILED' }),
    });
    expect(result.statusCode, result.body).toBe(200);

    const row = await fetchDeployment(deployment.id);
    expect(row.billingState).toBe('ACTIVE');
    expect(row.billingStartedAt).toEqual(startedAt);
  });

  it('4b. a relay failure message is redacted before it reaches the job result and the event payload', async () => {
    const { deployment, token } = await seedDeployment({ deploymentType: 'PRODUCTION', billingState: 'ACTIVE' });
    const [job] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: deployment.id,
        type: 'DEPLOY_RELEASE',
        state: 'RUNNING',
        idempotencyKey: `${deployment.id}:DEPLOY_RELEASE:redact`,
        payload: {},
      })
      .returning();

    const result = await app.inject({
      method: 'POST',
      url: `/api/relay/commands/${job!.id}/result`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        success: false,
        error: 'migration failed for postgresql://admin:hunter2secret@db.internal/app',
        failureCode: 'ECS_DEPLOYMENT_FAILED',
      }),
    });
    expect(result.statusCode, result.body).toBe(200);

    const [stored] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, job!.id));
    const events = await db.select().from(schema.eventLogs).where(eq(schema.eventLogs.deploymentId, deployment.id));
    expect(JSON.stringify(stored!.result)).not.toContain('hunter2secret');
    expect(JSON.stringify(events)).not.toContain('hunter2secret');
  });

  it('5. POST /destroy sets STOPPED on an ACTIVE deployment; a later DESTROY success leaves it unchanged', async () => {
    const startedAt = new Date('2026-01-01T00:00:00.000Z');
    const { deployment, token } = await seedDeployment({
      deploymentType: 'PRODUCTION',
      billingState: 'ACTIVE',
      billingStartedAt: startedAt,
    });

    const destroyResponse = await app.inject({
      method: 'POST',
      url: `/api/deployments/${deployment.id}/destroy`,
      headers: { 'content-type': 'application/json', cookie },
      payload: '{}',
    });
    expect(destroyResponse.statusCode, destroyResponse.body).toBe(202);
    const { jobId } = destroyResponse.json() as { jobId: string };

    const afterRequest = await fetchDeployment(deployment.id);
    expect(afterRequest.billingState).toBe('STOPPED');
    expect(afterRequest.billingStoppedAt).not.toBeNull();
    const stoppedAt = afterRequest.billingStoppedAt;

    const result = await app.inject({
      method: 'POST',
      url: `/api/relay/commands/${jobId}/result`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ success: true, output: {} }),
    });
    expect(result.statusCode, result.body).toBe(200);

    const afterSuccess = await fetchDeployment(deployment.id);
    expect(afterSuccess.billingState).toBe('STOPPED');
    expect(afterSuccess.billingStoppedAt).toEqual(stoppedAt);

    const events = await db
      .select({ eventType: schema.eventLogs.eventType })
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.deploymentId, deployment.id));
    // Exactly one billing_stopped event — the DESTROY-success backstop found
    // billing already STOPPED and wrote nothing more.
    expect(events.filter((e) => e.eventType === 'deployment.billing_stopped')).toHaveLength(1);
  });

  it('5b. POST /destroy stops billing for a PAUSED deployment for good', async () => {
    const { deployment } = await seedDeployment({
      deploymentType: 'PRODUCTION',
      billingState: 'PAUSED',
      billingStartedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const destroyResponse = await app.inject({
      method: 'POST',
      url: `/api/deployments/${deployment.id}/destroy`,
      headers: { 'content-type': 'application/json', cookie },
      payload: '{}',
    });
    expect(destroyResponse.statusCode, destroyResponse.body).toBe(202);

    const row = await fetchDeployment(deployment.id);
    expect(row.billingState).toBe('STOPPED');
    expect(row.billingStoppedAt).not.toBeNull();
  });

  it('6. POST /destroy on a never-installed PRODUCTION deployment sets STOPPED', async () => {
    const { deployment } = await seedDeployment({
      deploymentType: 'PRODUCTION',
      state: 'NOT_INSTALLED',
    });

    const destroyResponse = await app.inject({
      method: 'POST',
      url: `/api/deployments/${deployment.id}/destroy`,
      headers: { 'content-type': 'application/json', cookie },
      payload: '{}',
    });
    expect(destroyResponse.statusCode, destroyResponse.body).toBe(200);
    expect(destroyResponse.json()).toMatchObject({ state: 'DELETED' });

    const row = await fetchDeployment(deployment.id);
    expect(row.billingState).toBe('STOPPED');
    expect(row.billingStoppedAt).not.toBeNull();
  });

  it('7. force-complete on an already-STOPPED deployment leaves timestamps unchanged', async () => {
    const stoppedAt = new Date('2026-02-01T00:00:00.000Z');
    const { deployment } = await seedDeployment({
      deploymentType: 'PRODUCTION',
      state: 'DELETING',
      relayStatus: 'DISCONNECTED',
      billingState: 'STOPPED',
      billingStoppedAt: stoppedAt,
    });
    const age = new Date(Date.now() - 90 * 60 * 1000);
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'DESTROY',
      state: 'RUNNING',
      idempotencyKey: `${deployment.id}:DESTROY`,
      payload: {},
      startedAt: age,
      lastProgressAt: age,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/deployments/${deployment.id}/disconnect/force-complete`,
      headers: { 'content-type': 'application/json', cookie },
      payload: '{}',
    });
    expect(response.statusCode, response.body).toBe(200);

    const row = await fetchDeployment(deployment.id);
    expect(row.billingState).toBe('STOPPED');
    expect(row.billingStoppedAt).toEqual(stoppedAt);
  });

  it('8. GET /api/billing/summary lists only ACTIVE PRODUCTION deployments', async () => {
    await seedDeployment({ deploymentType: 'PRODUCTION', billingState: 'ACTIVE', billingStartedAt: new Date() });
    await seedDeployment({ deploymentType: 'PRODUCTION', billingState: 'NOT_STARTED' });
    await seedDeployment({ deploymentType: 'PRODUCTION', billingState: 'STOPPED', billingStoppedAt: new Date() });
    await seedDeployment({ deploymentType: 'PRODUCTION', billingState: 'PAUSED', billingStartedAt: new Date() });
    // Hand-crafted inconsistent row (never reachable through the domain
    // rules) to prove the summary route filters on BOTH columns, not just
    // billingState. A separate application avoids the Phase 7 one-active-
    // TEST-per-application index — test 2 above already left a live TEST
    // row on the shared applicationId.
    const [otherApplication] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'App 8b',
        repoFullName: `acme/bl-8b-${crypto.randomUUID().slice(0, 8)}`,
        repoUrl: 'https://github.com/acme/bl-8b',
        defaultBranch: 'main',
      })
      .returning();
    await seedDeployment({
      applicationId: otherApplication!.id,
      deploymentType: 'TEST',
      billingState: 'ACTIVE',
      billingStartedAt: new Date(),
    });

    const rows = await db
      .select({ deploymentType: schema.deployments.deploymentType, billingState: schema.deployments.billingState })
      .from(schema.deployments)
      .where(eq(schema.deployments.organizationId, organizationId));
    const expectedCount = rows.filter(
      (row) => row.deploymentType === 'PRODUCTION' && row.billingState === 'ACTIVE',
    ).length;

    const response = await app.inject({ method: 'GET', url: '/api/billing/summary', headers: { cookie } });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as {
      deployments: unknown[];
      total: number;
      productionDeployments: { active: number; paused: number };
    };
    expect(body.deployments).toHaveLength(expectedCount);
    expect(body.total).toBe(49 + expectedCount * 19);
    expect(body.productionDeployments.active).toBe(expectedCount);
    expect(body.productionDeployments.paused).toBe(1);
  });
});
