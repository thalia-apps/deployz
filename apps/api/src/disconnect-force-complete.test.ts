import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import { hashRelayToken } from './relay-store.js';
import { buildServer } from './server.js';

// Dead-relay disconnect: the force-complete escape hatch settles a DESTROY
// whose relay went offline mid-delete — control-plane only, never claiming
// the AWS resources were removed — plus the platform /api/health probe and
// the persisted (not derived) relay status the dashboard reads.
describe('disconnect force-complete + persisted liveness', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let organizationId: string;
  let applicationId: string;
  let customerId: string;
  let cookie: string;

  async function seedDisconnectingDeployment(overrides: {
    relayStatus: 'CONNECTED' | 'DISCONNECTED' | 'UNKNOWN';
    destroyJob: { state: 'REQUESTED' | 'RUNNING'; ageMinutes: number } | null;
  }): Promise<string> {
    const token = 'tok-' + crypto.randomUUID();
    const installationId = 'inst-' + crypto.randomUUID();
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        state: 'DELETING',
        installationId,
        enrollmentCode: crypto.randomUUID(),
        enrollmentUsedAt: new Date(),
        relayTokenHash: hashRelayToken(token),
        relayStatus: overrides.relayStatus,
      })
      .returning();
    if (overrides.destroyJob) {
      const age = new Date(Date.now() - overrides.destroyJob.ageMinutes * 60 * 1000);
      await db.insert(schema.deploymentJobs).values({
        deploymentId: deployment!.id,
        type: 'DESTROY',
        state: overrides.destroyJob.state,
        idempotencyKey: `${deployment!.id}:DESTROY`,
        payload: {},
        createdAt: age,
        startedAt: age,
        lastProgressAt: age,
      });
    }
    return deployment!.id;
  }

  function forceComplete(id: string) {
    return app.inject({
      method: 'POST',
      url: `/api/deployments/${id}/disconnect/force-complete`,
      headers: { 'content-type': 'application/json', cookie },
      payload: '{}',
    });
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);

    const email = 'force-complete@example.com';
    const password = 'super-secret-1';
    await auth.api.signUpEmail({ body: { email, password, name: 'Force' } });
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
        repoFullName: `acme/fc-${crypto.randomUUID().slice(0, 8)}`,
        repoUrl: 'https://github.com/acme/fc',
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

  it('GET /api/health answers a minimal readiness probe unauthenticated', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({ status: 'ok' });
  });

  it('returns the persisted relay status verbatim, without re-deriving it', async () => {
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
        relayTokenHash: hashRelayToken(token),
        relayStatus: 'DISCONNECTED',
        lastHealthAt: new Date(),
      })
      .returning();
    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment!.id}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().relayStatus).toBe('DISCONNECTED');
  });

  it('a returning relay heartbeat persists CONNECTED again', async () => {
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
        relayTokenHash: hashRelayToken(token),
        relayStatus: 'DISCONNECTED',
      })
      .returning();
    const response = await app.inject({
      method: 'POST',
      url: '/api/relay/health',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ installationId, observedState: {}, healthStatus: 'HEALTHY' }),
    });
    expect(response.statusCode, response.body).toBe(200);
    const [row] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment!.id));
    expect(row?.relayStatus).toBe('CONNECTED');
  });

  it('force-completes a stale DESTROY on a disconnected relay', async () => {
    const id = await seedDisconnectingDeployment({
      relayStatus: 'DISCONNECTED',
      destroyJob: { state: 'RUNNING', ageMinutes: 90 },
    });

    const response = await forceComplete(id);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toStrictEqual({ state: 'DELETED', cleanupState: 'SKIPPED_RELAY_OFFLINE' });

    const [deployment] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, id));
    expect(deployment?.state).toBe('DELETED');
    expect(deployment?.deletedAt).not.toBeNull();
    expect(deployment?.cleanupState).toBe('SKIPPED_RELAY_OFFLINE');

    const [job] = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, id));
    expect(job?.state).toBe('CANCELLED');
    expect(job?.result).toMatchObject({ forceCompleted: true, reason: 'RELAY_OFFLINE' });

    const events = await db
      .select({ eventType: schema.eventLogs.eventType })
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.deploymentId, id));
    expect(events.map((event) => event.eventType)).toContain('destroy.force_completed');

    // The warning the dashboard keeps showing rides on cleanupState.
    const detail = await app.inject({ method: 'GET', url: `/api/deployments/${id}`, headers: { cookie } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().cleanupState).toBe('SKIPPED_RELAY_OFFLINE');
  });

  it('refuses when the deployment is not disconnecting', async () => {
    const token = 'tok-' + crypto.randomUUID();
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        state: 'HEALTHY',
        installationId: 'inst-' + crypto.randomUUID(),
        enrollmentCode: crypto.randomUUID(),
        relayTokenHash: hashRelayToken(token),
        relayStatus: 'DISCONNECTED',
      })
      .returning();
    const response = await forceComplete(deployment!.id);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('NOT_DELETING');
  });

  it('refuses while the relay still reads online', async () => {
    const id = await seedDisconnectingDeployment({
      relayStatus: 'CONNECTED',
      destroyJob: { state: 'RUNNING', ageMinutes: 90 },
    });
    const response = await forceComplete(id);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('RELAY_NOT_OFFLINE');
  });

  it('refuses when no DESTROY is pending', async () => {
    const id = await seedDisconnectingDeployment({
      relayStatus: 'DISCONNECTED',
      destroyJob: null,
    });
    const response = await forceComplete(id);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('NO_PENDING_DESTROY');
  });

  it('refuses before the pending window has elapsed', async () => {
    const id = await seedDisconnectingDeployment({
      relayStatus: 'DISCONNECTED',
      destroyJob: { state: 'RUNNING', ageMinutes: 10 },
    });
    const response = await forceComplete(id);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('DESTROY_NOT_STALE');
  });

  // Phase 5 §9.4: a relay that keeps REPORTING DESTROY failure (still
  // online) leaves the vendor in FAILED with a stack that will not go away.
  // The escape hatch must open here too — with the same honest
  // "resources may remain" cleanupState — never queued forever.
  it('force-completes a live relay whose DESTROY keeps failing repeatedly', async () => {
    const token = 'tok-' + crypto.randomUUID();
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        state: 'FAILED',
        installationId: 'inst-' + crypto.randomUUID(),
        enrollmentCode: crypto.randomUUID(),
        relayTokenHash: hashRelayToken(token),
        relayStatus: 'CONNECTED',
      })
      .returning();
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const older = new Date(Date.now() - 3 * 60 * 60 * 1000);
    for (const [at, key] of [
      [older, `${deployment!.id}:DESTROY:1`],
      [old, `${deployment!.id}:DESTROY:2`],
    ] as const) {
      await db.insert(schema.deploymentJobs).values({
        deploymentId: deployment!.id,
        type: 'DESTROY',
        state: 'FAILED',
        idempotencyKey: key,
        payload: {},
        startedAt: at,
        finishedAt: at,
      });
    }

    const response = await forceComplete(deployment!.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toStrictEqual({ state: 'DELETED', cleanupState: 'SKIPPED_RELAY_OFFLINE' });

    const [row] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment!.id));
    expect(row?.state).toBe('DELETED');
    expect(row?.cleanupState).toBe('SKIPPED_RELAY_OFFLINE');

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment!.id));
    // The FAILED records stay FAILED; nothing is cancelled or resurrected.
    expect(jobs.every((job) => job.state === 'FAILED')).toBe(true);

    const events = await db
      .select({ eventType: schema.eventLogs.eventType, payload: schema.eventLogs.payload })
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.deploymentId, deployment!.id));
    const completed = events.find((e) => e.eventType === 'destroy.force_completed');
    expect(completed).toBeDefined();
    expect(completed?.payload).toMatchObject({ reason: 'REPEATED_DESTROY_FAILURE', awsResourcesRemoved: false });
  });

  it('refuses repeated-DESTROY-failure force-complete after only ONE failure', async () => {
    const token = 'tok-' + crypto.randomUUID();
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        state: 'FAILED',
        installationId: 'inst-' + crypto.randomUUID(),
        enrollmentCode: crypto.randomUUID(),
        relayTokenHash: hashRelayToken(token),
        relayStatus: 'CONNECTED',
      })
      .returning();
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment!.id,
      type: 'DESTROY',
      state: 'FAILED',
      idempotencyKey: `${deployment!.id}:DESTROY:1`,
      payload: {},
      startedAt: old,
      finishedAt: old,
    });
    const response = await forceComplete(deployment!.id);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('NO_PENDING_DESTROY');
  });

  it('refuses unauthenticated callers', async () => {
    const id = await seedDisconnectingDeployment({
      relayStatus: 'DISCONNECTED',
      destroyJob: { state: 'RUNNING', ageMinutes: 90 },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/deployments/${id}/disconnect/force-complete`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(response.statusCode).toBe(401);
  });

  // ── Purge retained resources (P2) ──────────────────────────────────────

  async function seedPurgeEligibleDeployment(overrides: {
    state?: 'DELETED' | 'HEALTHY';
    cleanupState?: 'SKIPPED_RELAY_OFFLINE' | 'COMPLETE' | null;
  } = {}): Promise<{ id: string; installationId: string; token: string }> {
    const token = 'tok-' + crypto.randomUUID();
    const installationId = 'inst-' + crypto.randomUUID();
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        state: overrides.state ?? 'DELETED',
        ...(overrides.cleanupState === undefined
          ? { cleanupState: 'SKIPPED_RELAY_OFFLINE' as const }
          : { cleanupState: overrides.cleanupState }),
        deletedAt: (overrides.state ?? 'DELETED') === 'DELETED' ? new Date() : null,
        installationId,
        enrollmentCode: crypto.randomUUID(),
        enrollmentUsedAt: new Date(),
        relayTokenHash: hashRelayToken(token),
        relayStatus: 'DISCONNECTED',
      })
      .returning();
    return { id: deployment!.id, installationId, token };
  }

  function purge(id: string, extraHeaders: Record<string, string> = {}) {
    return app.inject({
      method: 'POST',
      url: `/api/deployments/${id}/purge`,
      headers: { 'content-type': 'application/json', cookie, ...extraHeaders },
      payload: '{}',
    });
  }

  it('purge: any disconnected deployment whose resources have not been purged is eligible', async () => {
    const eligible = await seedPurgeEligibleDeployment();
    const response = await purge(eligible.id);
    expect(response.statusCode, response.body).toBe(202);
    const { jobId } = response.json() as { jobId: string };

    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
    expect(job?.type).toBe('PURGE');
    expect(job?.state).toBe('REQUESTED');

    const events = await db
      .select({ eventType: schema.eventLogs.eventType })
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.deploymentId, eligible.id));
    expect(events.map((event) => event.eventType)).toContain('purge.requested');

    const wrongState = await seedPurgeEligibleDeployment({ state: 'HEALTHY' });
    const wrongStateResponse = await purge(wrongState.id);
    expect(wrongStateResponse.statusCode).toBe(409);
    expect(wrongStateResponse.json().error.code).toBe('NOT_PURGE_ELIGIBLE');

    // A normal Disconnect (relay online, DESTROY succeeded) leaves
    // cleanupState null with the database/secrets/files retained — that
    // deployment must be purgeable too (CANARY-013).
    const normalDisconnect = await seedPurgeEligibleDeployment({ cleanupState: null });
    const normalDisconnectResponse = await purge(normalDisconnect.id);
    expect(normalDisconnectResponse.statusCode, normalDisconnectResponse.body).toBe(202);

    const alreadyPurged = await seedPurgeEligibleDeployment({ cleanupState: 'COMPLETE' });
    const alreadyPurgedResponse = await purge(alreadyPurged.id);
    expect(alreadyPurgedResponse.statusCode).toBe(409);
    expect(alreadyPurgedResponse.json().error.code).toBe('NOT_PURGE_ELIGIBLE');
  });

  it('purge: a repeat request while the job is active reuses it', async () => {
    const eligible = await seedPurgeEligibleDeployment();
    const first = await purge(eligible.id);
    expect(first.statusCode).toBe(202);
    const second = await purge(eligible.id);
    expect(second.statusCode).toBe(200);
    expect((second.json() as { jobId: string }).jobId).toBe(
      (first.json() as { jobId: string }).jobId,
    );

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, eligible.id));
    expect(jobs).toHaveLength(1);
  });

  it('purge: a relay success clears cleanupState to COMPLETE without moving the state', async () => {
    const eligible = await seedPurgeEligibleDeployment();
    const { jobId } = (await (await purge(eligible.id)).json()) as { jobId: string };

    await db
      .update(schema.deploymentJobs)
      .set({ state: 'RUNNING', startedAt: new Date() })
      .where(eq(schema.deploymentJobs.id, jobId));
    await db
      .update(schema.deployments)
      .set({ relayStatus: 'CONNECTED' })
      .where(eq(schema.deployments.id, eligible.id));
    const result = await app.inject({
      method: 'POST',
      url: `/api/relay/commands/${jobId}/result`,
      headers: {
        authorization: `Bearer ${eligible.token}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ success: true, output: { purged: true } }),
    });
    expect(result.statusCode, result.body).toBe(200);

    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
    expect(job?.state).toBe('SUCCEEDED');

    const [deployment] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, eligible.id));
    expect(deployment?.state).toBe('DELETED');
    expect(deployment?.cleanupState).toBe('COMPLETE');
    expect(deployment?.relayStatus).toBe('DISCONNECTED');

    const events = await db
      .select({ eventType: schema.eventLogs.eventType })
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.deploymentId, eligible.id));
    expect(events.map((event) => event.eventType)).toContain('purge.completed');
  });

  it('purge: a relay failure stays DELETED with PURGE_FAILED and stays retryable', async () => {
    // Phase 5 §9.2 route-level: lifecycle and cleanup are separate — the
    // failed purge must not resurrect the deployment, and the vendor must
    // be able to issue the purge again from the failed cleanup state.
    const eligible = await seedPurgeEligibleDeployment();
    const first = await purge(eligible.id);
    expect(first.statusCode, first.body).toBe(202);
    const { jobId } = first.json() as { jobId: string };

    await db
      .update(schema.deploymentJobs)
      .set({ state: 'RUNNING', startedAt: new Date() })
      .where(eq(schema.deploymentJobs.id, jobId));
    const failed = await app.inject({
      method: 'POST',
      url: `/api/relay/commands/${jobId}/result`,
      headers: {
        authorization: `Bearer ${eligible.token}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ success: false, error: 'denied', failureCode: 'AWS_PERMISSION_DENIED' }),
    });
    expect(failed.statusCode, failed.body).toBe(200);

    const [deployment] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, eligible.id));
    expect(deployment?.state).toBe('DELETED');
    expect(deployment?.cleanupState).toBe('PURGE_FAILED');

    const retried = await purge(eligible.id);
    expect(retried.statusCode, retried.body).toBe(202);
    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, eligible.id))
      .orderBy(schema.deploymentJobs.createdAt);
    // Two attempts now: the failed one (still FAILED) and the fresh retry.
    expect(jobs).toHaveLength(2);
    expect(jobs.some((job) => job.state === 'REQUESTED')).toBe(true);
    expect(jobs.some((job) => job.state === 'FAILED')).toBe(true);
  });

  it('purge: refuses unauthenticated callers', async () => {
    const eligible = await seedPurgeEligibleDeployment();
    const response = await app.inject({
      method: 'POST',
      url: `/api/deployments/${eligible.id}/purge`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(response.statusCode).toBe(401);
  });
});
