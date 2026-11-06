import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import { createOrReuseJob } from './jobs.js';
import { hashRelayToken } from './relay-store.js';
import { buildServer } from './server.js';

// Deployment-resilience semantics: a failed day-2 operation must not mark a
// deployment with a running release as FAILED; a settled job must not
// reprocess a late duplicate result; and at most one mutating job may be
// active per deployment (enforced by the partial unique index, not only the
// route-level check).
describe('failure semantics, duplicate results and operation exclusivity', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let cookie: string;
  let organizationId: string;
  let applicationId: string;
  let customerId: string;

  const REPO = '151955775369.dkr.ecr.us-east-1.amazonaws.com/deployz-images';
  const DIGEST = 'sha256:' + 'b'.repeat(64);

  async function seedDeployment(
    overrides: Partial<typeof schema.deployments.$inferInsert> = {},
  ): Promise<{ id: string; installationId: string; token: string }> {
    const token = 'tok-' + crypto.randomUUID();
    const installationId = 'inst-' + crypto.randomUUID();
    const [row] = await db
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
        ...overrides,
      })
      .returning();
    return { id: row!.id, installationId, token };
  }

  async function seedRelease(version: string, createdAt: Date): Promise<string> {
    const [row] = await db
      .insert(schema.releases)
      .values({
        applicationId,
        version,
        gitSha: 'abc123',
        imageDigest: `${REPO}@${DIGEST}`,
        buildStatus: 'SUCCEEDED',
        releaseStatus: 'READY',
        createdAt,
      })
      .returning();
    return row!.id;
  }

  async function seedJob(
    deploymentId: string,
    type: (typeof schema.deploymentJobs.$inferInsert)['type'],
    state: (typeof schema.deploymentJobs.$inferInsert)['state'] = 'RUNNING',
    payload: Record<string, unknown> = {},
  ): Promise<string> {
    const [row] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId,
        type,
        state,
        idempotencyKey: `${deploymentId}:${type}:${crypto.randomUUID()}`,
        payload,
      })
      .returning();
    return row!.id;
  }

  function postResult(jobId: string, token: string, body: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/api/relay/commands/${jobId}/result`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
  }

  async function getDeploymentRow(id: string) {
    const [row] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, id));
    return row!;
  }

  async function getDerived(id: string) {
    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${id}`,
      headers: { cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as {
      state: string;
      deploymentStatus: { stage: string; failure: { code: string | null } | null };
    };
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);

    const email = 'failure-semantics@example.com';
    const password = 'super-secret-1';
    await auth.api.signUpEmail({ body: { email, password, name: 'Semantics' } });
    const signin = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    const setCookie = signin.headers.get('set-cookie');
    if (!setCookie) throw new Error('no session cookie');
    cookie = setCookie;

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
        repoFullName: `acme/fs-${crypto.randomUUID().slice(0, 8)}`,
        repoUrl: 'https://github.com/acme/fs',
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

  it('keeps a deployment live (UPDATE_AVAILABLE) when an update fails and a newer READY release exists', async () => {
    const v1 = await seedRelease('1.0.0', new Date(Date.now() - 60_000));
    const v2 = await seedRelease('2.0.0', new Date());
    const deployment = await seedDeployment({ state: 'UPDATING', currentReleaseId: v1 });
    const jobId = await seedJob(deployment.id, 'DEPLOY_RELEASE', 'RUNNING', { releaseId: v2 });

    const response = await postResult(jobId, deployment.token, {
      success: false,
      error: 'rollout failed',
      failureCode: 'ECS_DEPLOYMENT_FAILED',
    });
    expect(response.statusCode, response.body).toBe(200);

    const row = await getDeploymentRow(deployment.id);
    expect(row.state).toBe('UPDATE_AVAILABLE');
    // The pointer never advances past the last successful release.
    expect(row.currentReleaseId).toBe(v1);

    // The failure is still surfaced, without the stage claiming the whole
    // deployment is down.
    const derived = await getDerived(deployment.id);
    expect(derived.deploymentStatus.stage).not.toBe('FAILED');
    expect(derived.deploymentStatus.failure?.code).toBe('ECS_DEPLOYMENT_FAILED');
  });

  it('returns a deployment to HEALTHY when a restart fails and no newer release exists', async () => {
    const v1 = await seedRelease('3.0.0', new Date());
    const deployment = await seedDeployment({ state: 'UPDATING', currentReleaseId: v1 });
    const jobId = await seedJob(deployment.id, 'RESTART');

    const response = await postResult(jobId, deployment.token, { success: false, error: 'boom' });
    expect(response.statusCode, response.body).toBe(200);

    const row = await getDeploymentRow(deployment.id);
    expect(row.state).toBe('HEALTHY');
  });

  it('still marks a first install failure as FAILED', async () => {
    const deployment = await seedDeployment({ state: 'INSTALLING', currentReleaseId: null });
    const jobId = await seedJob(deployment.id, 'INSTALL');

    const response = await postResult(jobId, deployment.token, {
      success: false,
      error: 'stack failed',
      failureCode: 'STACK_CREATE_FAILED',
    });
    expect(response.statusCode, response.body).toBe(200);

    const row = await getDeploymentRow(deployment.id);
    expect(row.state).toBe('FAILED');
  });

  // CANARY-008: a first install runs the template-pinned image with no
  // release row deployed, so currentReleaseId stays null even though the
  // deployment reached HEALTHY. A failed update must not mark it FAILED —
  // each test gets its own application so its release set is exact.
  async function seedApplication(): Promise<string> {
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'CANARY-008 App',
        repoFullName: `acme/canary-008-${crypto.randomUUID().slice(0, 8)}`,
        repoUrl: 'https://github.com/acme/canary-008',
        defaultBranch: 'main',
      })
      .returning();
    return application!.id;
  }

  it('keeps a template-image install live (UPDATE_AVAILABLE) when a deploy fails and a READY release exists (CANARY-008)', async () => {
    const appId = await seedApplication();
    const [release] = await db
      .insert(schema.releases)
      .values({
        applicationId: appId,
        version: '1.0.0',
        gitSha: 'abc123',
        imageDigest: `${REPO}@${DIGEST}`,
        buildStatus: 'SUCCEEDED',
        releaseStatus: 'READY',
      })
      .returning();
    const deployment = await seedDeployment({
      state: 'HEALTHY',
      applicationId: appId,
      currentReleaseId: null,
    });
    await seedJob(deployment.id, 'INSTALL', 'SUCCEEDED');
    const jobId = await seedJob(deployment.id, 'DEPLOY_RELEASE', 'RUNNING', { releaseId: release!.id });

    const response = await postResult(jobId, deployment.token, {
      success: false,
      error: 'migration failed',
      failureCode: 'MIGRATION_FAILED',
    });
    expect(response.statusCode, response.body).toBe(200);

    const row = await getDeploymentRow(deployment.id);
    expect(row.state).toBe('UPDATE_AVAILABLE');
    expect(row.currentReleaseId).toBeNull();
  });

  it('returns a template-image install to HEALTHY when a deploy fails and no READY release exists (CANARY-008)', async () => {
    const appId = await seedApplication();
    const deployment = await seedDeployment({
      state: 'HEALTHY',
      applicationId: appId,
      currentReleaseId: null,
    });
    await seedJob(deployment.id, 'INSTALL', 'SUCCEEDED');
    const jobId = await seedJob(deployment.id, 'DEPLOY_RELEASE', 'RUNNING', {});

    const response = await postResult(jobId, deployment.token, {
      success: false,
      error: 'migration failed',
      failureCode: 'MIGRATION_FAILED',
    });
    expect(response.statusCode, response.body).toBe(200);

    const row = await getDeploymentRow(deployment.id);
    expect(row.state).toBe('HEALTHY');
    expect(row.currentReleaseId).toBeNull();
  });

  it('marks a zero-task install FAILED when its first deploy fails — nothing was ever running (DEPLOY-009)', async () => {
    const appId = await seedApplication();
    const [release] = await db
      .insert(schema.releases)
      .values({
        applicationId: appId,
        version: '1.0.0',
        gitSha: 'abc123',
        imageDigest: `${REPO}@${DIGEST}`,
        buildStatus: 'SUCCEEDED',
        releaseStatus: 'READY',
      })
      .returning();
    const deployment = await seedDeployment({
      state: 'INSTALLING',
      applicationId: appId,
      currentReleaseId: null,
    });
    await seedJob(deployment.id, 'INSTALL', 'SUCCEEDED', { startAfterConfig: true });
    const jobId = await seedJob(deployment.id, 'DEPLOY_RELEASE', 'RUNNING', { releaseId: release!.id });

    const response = await postResult(jobId, deployment.token, {
      success: false,
      error: 'The ECS deployment circuit breaker reported a failed rollout',
      failureCode: 'ECS_DEPLOYMENT_FAILED',
    });
    expect(response.statusCode, response.body).toBe(200);

    const row = await getDeploymentRow(deployment.id);
    expect(row.state).toBe('FAILED');
    expect(row.currentReleaseId).toBeNull();
  });

  it('keeps a zero-task install live once a deploy has started it, even before the heartbeat names the release', async () => {
    const appId = await seedApplication();
    const deployment = await seedDeployment({
      state: 'HEALTHY',
      applicationId: appId,
      currentReleaseId: null,
    });
    await seedJob(deployment.id, 'INSTALL', 'SUCCEEDED', { startAfterConfig: true });
    await seedJob(deployment.id, 'DEPLOY_RELEASE', 'SUCCEEDED');
    const jobId = await seedJob(deployment.id, 'DEPLOY_RELEASE', 'RUNNING', {});

    const response = await postResult(jobId, deployment.token, {
      success: false,
      error: 'migration failed',
      failureCode: 'MIGRATION_FAILED',
    });
    expect(response.statusCode, response.body).toBe(200);

    const row = await getDeploymentRow(deployment.id);
    expect(row.state).toBe('HEALTHY');
  });

  it('leaves the deployment state alone when a CONFIG_UPDATE fails', async () => {
    const v1 = await seedRelease('4.0.0', new Date());
    const deployment = await seedDeployment({ state: 'HEALTHY', currentReleaseId: v1 });
    const jobId = await seedJob(deployment.id, 'CONFIG_UPDATE');

    const response = await postResult(jobId, deployment.token, { success: false, error: 'nope' });
    expect(response.statusCode, response.body).toBe(200);

    const row = await getDeploymentRow(deployment.id);
    expect(row.state).toBe('HEALTHY');
  });

  it('never resurrects a DELETED deployment when a PURGE fails — cleanupState carries the failure', async () => {
    const deployment = await seedDeployment({
      state: 'DELETED',
      cleanupState: 'SKIPPED_RELAY_OFFLINE',
      deletedAt: new Date(),
    });
    const jobId = await seedJob(deployment.id, 'PURGE');

    const response = await postResult(jobId, deployment.token, { success: false, error: 'denied' });
    expect(response.statusCode, response.body).toBe(200);

    const row = await getDeploymentRow(deployment.id);
    // Lifecycle and cleanup are separate concepts (Phase 5 §9.2): the
    // deployment stays DELETED, and the failed purge records itself on
    // cleanupState — never resurrecting into a deployment-failure state.
    expect(row.state).toBe('DELETED');
    expect(row.cleanupState).toBe('PURGE_FAILED');

    const [job] = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.id, jobId));
    expect(job?.state).toBe('FAILED');
  });

  it('ignores a duplicate result for a settled job (no state flip, no second event)', async () => {
    const v1 = await seedRelease('5.0.0', new Date(Date.now() - 60_000));
    const v2 = await seedRelease('5.1.0', new Date());
    const deployment = await seedDeployment({ state: 'UPDATING', currentReleaseId: v1 });
    const jobId = await seedJob(deployment.id, 'DEPLOY_RELEASE', 'RUNNING', { releaseId: v2 });

    const first = await postResult(jobId, deployment.token, { success: false, error: 'rollout failed' });
    expect(first.statusCode).toBe(200);
    const afterFirst = await getDeploymentRow(deployment.id);

    // The relay retries the report (its earlier HTTP call timed out) — and
    // this time claims success. The settled job must not reprocess.
    const second = await postResult(jobId, deployment.token, { success: true, output: {} });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ received: true, alreadySettled: true });

    const afterSecond = await getDeploymentRow(deployment.id);
    expect(afterSecond.state).toBe(afterFirst.state);
    expect(afterSecond.currentReleaseId).toBe(v1);

    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(and(eq(schema.eventLogs.deploymentId, deployment.id), eq(schema.eventLogs.eventType, 'deploy.failed')));
    expect(events).toHaveLength(1);
  });

  it('refuses a result that does not say whether the command succeeded (never a default success)', async () => {
    const v1 = await seedRelease('5.2.0', new Date(Date.now() - 60_000));
    const v2 = await seedRelease('5.3.0', new Date());
    const deployment = await seedDeployment({ state: 'UPDATING', currentReleaseId: v1 });
    const jobId = await seedJob(deployment.id, 'DEPLOY_RELEASE', 'RUNNING', { releaseId: v2 });

    const response = await postResult(jobId, deployment.token, { output: {} });
    expect(response.statusCode).toBe(400);

    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
    expect(job?.state).toBe('RUNNING');
    expect((await getDeploymentRow(deployment.id)).state).toBe('UPDATING');
  });

  it('ignores a late result for a CANCELLED (force-completed) job', async () => {
    const deployment = await seedDeployment({ state: 'DELETED', cleanupState: 'SKIPPED_RELAY_OFFLINE' });
    const jobId = await seedJob(deployment.id, 'DESTROY', 'CANCELLED');

    const response = await postResult(jobId, deployment.token, { success: true, output: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ alreadySettled: true });

    const row = await getDeploymentRow(deployment.id);
    expect(row.state).toBe('DELETED');
  });

  it('enforces one active mutating job per deployment at the database level', async () => {
    const deployment = await seedDeployment();
    await seedJob(deployment.id, 'DEPLOY_RELEASE', 'RUNNING');

    // A direct insert of a second active mutating job violates the partial
    // unique index — this is the correctness backstop behind the racing
    // requests that both pass the route-level idle check.
    await expect(
      db.insert(schema.deploymentJobs).values({
        deploymentId: deployment.id,
        type: 'DESTROY',
        state: 'REQUESTED',
        idempotencyKey: `${deployment.id}:DESTROY:race`,
      }),
    ).rejects.toThrow(/one_active_mutating|unique|duplicate|Failed query/i);

    // createOrReuseJob converts the violation into the same DEPLOYMENT_BUSY
    // answer the route-level check gives.
    await expect(
      createOrReuseJob(db, {
        deploymentId: deployment.id,
        type: 'ROLLBACK',
        idempotencyKey: `${deployment.id}:ROLLBACK:race`,
        payload: {},
        requestedBy: null,
      }),
    ).rejects.toMatchObject({ code: 'DEPLOYMENT_BUSY', statusCode: 409 });

    // Domain jobs and CONFIG_UPDATE are outside the exclusivity guard —
    // domain jobs never race an executor over the stack/service, and secret
    // delivery must be able to queue a config job during an active
    // install/deploy (the secret value rides the payload transiently) — and
    // a settled mutating job frees the slot.
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'CONFIGURE_DOMAIN',
      state: 'REQUESTED',
      idempotencyKey: `${deployment.id}:CONFIGURE_DOMAIN:ok`,
    });
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'CONFIG_UPDATE',
      state: 'REQUESTED',
      idempotencyKey: `${deployment.id}:CONFIG_UPDATE:ok`,
    });
    await db
      .update(schema.deploymentJobs)
      .set({ state: 'FAILED', finishedAt: new Date() })
      .where(and(eq(schema.deploymentJobs.deploymentId, deployment.id), eq(schema.deploymentJobs.type, 'DEPLOY_RELEASE')));
    const reopened = await createOrReuseJob(db, {
      deploymentId: deployment.id,
      type: 'ROLLBACK',
      idempotencyKey: `${deployment.id}:ROLLBACK:after-settle`,
      payload: {},
      requestedBy: null,
    });
    expect(reopened.created).toBe(true);
  });

  it('claims a WAITING job back when the relay returns', async () => {
    // The watchdog parks a job WAITING when the relay goes quiet
    // mid-operation; the relay's next command poll IS the relay returning,
    // so the claim must hand the job back out.
    const deployment = await seedDeployment({ state: 'INSTALLING' });
    const jobId = await seedJob(deployment.id, 'INSTALL', 'WAITING');

    const response = await app.inject({
      method: 'GET',
      url: `/api/relay/commands?installationId=${deployment.installationId}`,
      headers: { authorization: `Bearer ${deployment.token}` },
    });
    expect(response.statusCode, response.body).toBe(200);
    const commands = (response.json() as { commands: { id: string }[] }).commands;
    expect(commands.map((c) => c.id)).toContain(jobId);

    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
    expect(job!.state).toBe('RUNNING');
  });

  it('claims relay commands atomically — a second poll receives nothing', async () => {
    const deployment = await seedDeployment({ state: 'INSTALLING' });
    await seedJob(deployment.id, 'INSTALL', 'REQUESTED');

    const poll = () =>
      app.inject({
        method: 'GET',
        url: `/api/relay/commands?installationId=${deployment.installationId}`,
        headers: { authorization: `Bearer ${deployment.token}` },
      });

    const first = await poll();
    expect(first.statusCode, first.body).toBe(200);
    expect((first.json() as { commands: unknown[] }).commands).toHaveLength(1);

    const second = await poll();
    expect(second.statusCode).toBe(200);
    expect((second.json() as { commands: unknown[] }).commands).toHaveLength(0);
  });
  describe('service mutations never overlap', () => {
    async function seedAt(
      deploymentId: string,
      type: (typeof schema.deploymentJobs.$inferInsert)['type'],
      state: (typeof schema.deploymentJobs.$inferInsert)['state'],
      secondsAgo: number,
    ): Promise<string> {
      const [row] = await db
        .insert(schema.deploymentJobs)
        .values({
          deploymentId,
          type,
          state,
          idempotencyKey: `${deploymentId}:${type}:${crypto.randomUUID()}`,
          createdAt: new Date(Date.now() - secondsAgo * 1000),
        })
        .returning();
      return row!.id;
    }

    async function claim(deployment: { installationId: string; token: string }): Promise<string[]> {
      const response = await app.inject({
        method: 'GET',
        url: `/api/relay/commands?installationId=${deployment.installationId}`,
        headers: { authorization: `Bearer ${deployment.token}` },
      });
      expect(response.statusCode, response.body).toBe(200);
      return (response.json() as { commands: { id: string }[] }).commands.map((command) => command.id);
    }

    it('holds a CONFIG_UPDATE queued during an install until the install settles; domain jobs still flow', async () => {
      const deployment = await seedDeployment({ state: 'INSTALLING' });
      const install = await seedAt(deployment.id, 'INSTALL', 'RUNNING', 30);
      const config = await seedAt(deployment.id, 'CONFIG_UPDATE', 'REQUESTED', 20);
      const domain = await seedAt(deployment.id, 'CONFIGURE_DOMAIN', 'REQUESTED', 10);

      expect(await claim(deployment)).toEqual([domain]);

      await db.update(schema.deploymentJobs).set({ state: 'SUCCEEDED' }).where(eq(schema.deploymentJobs.id, install));
      expect(await claim(deployment)).toEqual([config]);
    });

    it('hands out a CONFIG_UPDATE only as the first service mutation of a batch', async () => {
      const behind = await seedDeployment();
      const deploy = await seedAt(behind.id, 'DEPLOY_RELEASE', 'REQUESTED', 20);
      const lateConfig = await seedAt(behind.id, 'CONFIG_UPDATE', 'REQUESTED', 10);
      expect(await claim(behind)).toEqual([deploy]);
      await db.update(schema.deploymentJobs).set({ state: 'SUCCEEDED' }).where(eq(schema.deploymentJobs.id, deploy));
      expect(await claim(behind)).toEqual([lateConfig]);

      // The post-install pair keeps its order in one batch: the relay hands
      // the deploy back if the configuration rollout has to wait.
      const first = await seedDeployment();
      const config = await seedAt(first.id, 'CONFIG_UPDATE', 'REQUESTED', 20);
      const autoDeploy = await seedAt(first.id, 'DEPLOY_RELEASE', 'REQUESTED', 10);
      expect(await claim(first)).toEqual([config, autoDeploy]);
    });

    it('does not let a deploy and a config update wait on each other at a configured first start', async () => {
      const seedFirstStart = async () => {
        const deployment = await seedDeployment();
        const install = await seedAt(deployment.id, 'INSTALL', 'SUCCEEDED', 60);
        await db
          .update(schema.deploymentJobs)
          .set({ payload: { startAfterConfig: true } })
          .where(eq(schema.deploymentJobs.id, install));
        return deployment;
      };

      // The deploy is older: the config update still goes first.
      const queued = await seedFirstStart();
      const deploy = await seedAt(queued.id, 'DEPLOY_RELEASE', 'REQUESTED', 20);
      const config = await seedAt(queued.id, 'CONFIG_UPDATE', 'REQUESTED', 10);
      expect(await claim(queued)).toEqual([config, deploy]);

      // The deploy already runs and waits for the configuration: the config update is not blocked.
      const waiting = await seedFirstStart();
      await seedAt(waiting.id, 'DEPLOY_RELEASE', 'RUNNING', 20);
      const lateConfig = await seedAt(waiting.id, 'CONFIG_UPDATE', 'REQUESTED', 10);
      expect(await claim(waiting)).toEqual([lateConfig]);

      // After the application started, a running deploy blocks a config update again.
      const started = await seedDeployment();
      await seedAt(started.id, 'DEPLOY_RELEASE', 'SUCCEEDED', 40);
      await seedAt(started.id, 'DEPLOY_RELEASE', 'RUNNING', 20);
      await seedAt(started.id, 'CONFIG_UPDATE', 'REQUESTED', 10);
      expect(await claim(started)).toEqual([]);
    });

    it('lets the relay hand back a claimed command it did not start, never one whose payload was redacted', async () => {
      const deployment = await seedDeployment();
      const config = await seedAt(deployment.id, 'CONFIG_UPDATE', 'REQUESTED', 20);
      const deploy = await seedAt(deployment.id, 'DEPLOY_RELEASE', 'REQUESTED', 10);
      expect(await claim(deployment)).toEqual([config, deploy]);

      const release = (jobId: string, token = deployment.token) =>
        app.inject({
          method: 'POST',
          url: `/api/relay/commands/${jobId}/release`,
          headers: { authorization: `Bearer ${token}` },
        });
      expect((await release(deploy, 'wrong-token')).statusCode).toBe(401);
      const handedBack = await release(deploy);
      expect(handedBack.statusCode, handedBack.body).toBe(200);
      expect(handedBack.json()).toEqual({ released: true });
      const [row] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, deploy));
      expect(row!.state).toBe('REQUESTED');
      expect((await release(config)).statusCode).toBe(409);

      // The running CONFIG_UPDATE holds the deploy until it settles.
      expect(await claim(deployment)).toEqual([]);
    });

    it('surfaces a failed CONFIG_UPDATE while the lifecycle and release pointer stay', async () => {
      const v1 = await seedRelease('5.9.1', new Date());
      const deployment = await seedDeployment({ state: 'HEALTHY', currentReleaseId: v1, healthStatus: 'HEALTHY' });
      await seedAt(deployment.id, 'INSTALL', 'SUCCEEDED', 60);
      const config = await seedAt(deployment.id, 'CONFIG_UPDATE', 'RUNNING', 10);

      const response = await postResult(config, deployment.token, {
        success: false,
        error: 'ECS rolled service back; Secret values already written to the configuration secret were not restored.',
        failureCode: 'ECS_DEPLOYMENT_FAILED',
      });
      expect(response.statusCode, response.body).toBe(200);

      const row = await getDeploymentRow(deployment.id);
      expect(row.state).toBe('HEALTHY');
      expect(row.currentReleaseId).toBe(v1);
      const derived = await getDerived(deployment.id);
      expect(derived.deploymentStatus.failure?.code).toBe('ECS_DEPLOYMENT_FAILED');
    });
  });
});
