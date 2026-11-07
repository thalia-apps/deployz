import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createAiGateway, type ReadinessReport } from '@deployz/analysis';
import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { ANALYSIS_VERSION } from './analysis.js';
import { createAuth, type Auth } from './auth.js';
import { buildServer } from './server.js';

// PR1 application/analysis-funnel telemetry: the new §40 event vocabulary is
// written next to the state changes it describes — same transaction where one
// exists, and never twice for one guarded action.

const READY_REPO = 'deployz-demo/express-api';
const NOT_COMPATIBLE_REPO = 'deployz-demo/legacy-redis';

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

describe('application/analysis funnel events (PR1)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };
  let readyApplicationId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'telemetry-funnel@example.com');
    // Deploy-link creation below is always PRODUCTION; billing
    // Phase 7 gates that behind an ACTIVE subscription, unrelated to what
    // this file exercises (application/analysis funnel telemetry).
    await db.insert(schema.billingSubscriptions).values({
      organizationId: org.organizationId,
      providerCustomerId: 'ctm_fixture_telemetry_funnel',
      providerSubscriptionId: 'sub_fixture_telemetry_funnel',
      status: 'ACTIVE',
    });
    // Fixture-mode GitHub so the /analyse route runs the real deterministic
    // analyser on a fixture tree with no network. The AI gateway is disabled
    // explicitly (env.aiGateway may be configured on a developer machine);
    // the analysis runner degrades its §15 fallback and still completes.
    app = await buildServer({ auth, db, githubFixtureMode: true, aiGateway: createAiGateway(undefined) });
    // One analysed READY application, shared by the preflight-gate tests.
    readyApplicationId = await createApplication(READY_REPO);
    await runAnalysis(readyApplicationId);
    // A built release: deploy-link creation refuses without one.
    await db.insert(schema.releases).values({
      applicationId: readyApplicationId,
      version: '1.0.0',
      gitSha: 'a'.repeat(40),
      releaseStatus: 'READY',
      imageDigest: `123456789012.dkr.ecr.us-east-1.amazonaws.com/deployz-fixture@sha256:${'b'.repeat(64)}`,
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  async function events(eventType: string): Promise<typeof schema.eventLogs.$inferSelect[]> {
    return db.select().from(schema.eventLogs).where(eq(schema.eventLogs.eventType, eventType));
  }

  async function loadApplication(id: string): Promise<typeof schema.applications.$inferSelect> {
    const rows = await db.select().from(schema.applications).where(eq(schema.applications.id, id)).limit(1);
    return rows[0]!;
  }

  async function createApplication(repoFullName: string): Promise<string> {
    const response = await send(
      app,
      'POST',
      '/api/applications',
      {
        name: repoFullName.split('/')[1]!,
        githubInstallationId: 'fixture-install-1',
        repoFullName,
        repoUrl: `https://github.com/${repoFullName}`,
        defaultBranch: 'main',
      },
      { cookie: org.cookie },
    );
    expect(response.statusCode, response.body).toBe(201);
    return (response.json() as { id: string }).id;
  }

  async function runAnalysis(applicationId: string): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/applications/${applicationId}/analyse`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode, response.body).toBe(202);
  }

  it('application.created: one event per create, applicationId in payload, no runtime', async () => {
    const applicationId = await createApplication('deployz-demo/static-api');

    const created = (await events('application.created')).filter(
      (event) => event.payload['applicationId'] === applicationId,
    );
    expect(created).toHaveLength(1);
    // Deep-equal: exactly schemaVersion + applicationId — runtime is only
    // added when known at creation, and it never is (analysis has not run).
    expect(created[0]!.payload).toEqual({ schemaVersion: 1, applicationId });
    expect(created[0]!.actorType).toBe('user');
    expect(created[0]!.organizationId).toBe(org.organizationId);

    // A duplicate-repo create is refused before the insert: no second event.
    const dup = await send(
      app,
      'POST',
      '/api/applications',
      {
        name: 'duplicate',
        githubInstallationId: 'fixture-install-1',
        repoFullName: 'deployz-demo/static-api',
        repoUrl: 'https://github.com/deployz-demo/static-api',
        defaultBranch: 'main',
      },
      { cookie: org.cookie },
    );
    expect(dup.statusCode).toBe(409);
    const afterDup = (await events('application.created')).filter(
      (event) => event.payload['applicationId'] === applicationId,
    );
    expect(afterDup).toHaveLength(1);

    // A validation failure never reaches the insert: the total is unchanged.
    const beforeInvalid = (await events('application.created')).length;
    const invalid = await send(
      app,
      'POST',
      '/api/applications',
      { name: 'incomplete' },
      { cookie: org.cookie },
    );
    expect(invalid.statusCode).toBe(400);
    expect(await events('application.created')).toHaveLength(beforeInvalid);
  });

  it('analysis_started + analysis_completed: payload matches the persisted verdict', async () => {
    const applicationId = readyApplicationId;
    const row = await loadApplication(applicationId);
    expect(row.analysisStatus).toBe('COMPLETE');

    const started = (await events('application.analysis_started')).filter(
      (event) => event.payload['applicationId'] === applicationId,
    );
    expect(started).toHaveLength(1);
    expect(started[0]!.payload).toEqual({ schemaVersion: 1, applicationId });

    const completed = (await events('application.analysis_completed')).filter(
      (event) => event.payload['applicationId'] === applicationId,
    );
    expect(completed).toHaveLength(1);
    const payload = completed[0]!.payload;
    expect(payload['schemaVersion']).toBe(1);
    expect(payload['applicationId']).toBe(applicationId);
    expect(payload['analysisVersion']).toBe(ANALYSIS_VERSION);
    expect(payload['runtime']).toBe('node');
    expect(payload['durationMs']).toEqual(expect.any(Number));
    expect(completed[0]!.actorType).toBe('system');

    // The counts/readiness/compatibility mirror exactly what was persisted.
    const stored = (row.detectedMetadata as { readiness: ReadinessReport }).readiness;
    expect(payload['readiness']).toBe(stored.state);
    expect(payload['compatibility']).toBe(row.compatibilityStatus);
    expect(payload['findingCount']).toBe(stored.findings.length);
    expect(payload['blockingCount']).toBe(stored.findings.filter((finding) => finding.blocking).length);
    // express-api is fully ready — no findings.
    expect(payload['compatibility']).toBe('READY');
    expect(payload['findingCount']).toBe(0);
  });

  it('analysis_completed carries a NOT_COMPATIBLE readiness verdict when analysis finds one', async () => {
    const applicationId = await createApplication(NOT_COMPATIBLE_REPO);
    await runAnalysis(applicationId);

    const row = await loadApplication(applicationId);
    expect(row.compatibilityStatus).toBe('NOT_COMPATIBLE');

    const completed = (await events('application.analysis_completed')).filter(
      (event) => event.payload['applicationId'] === applicationId,
    );
    expect(completed).toHaveLength(1);
    const payload = completed[0]!.payload;
    const stored = (row.detectedMetadata as { readiness: ReadinessReport }).readiness;
    expect(payload['readiness']).toBe(stored.state);
    expect(payload['compatibility']).toBe('NOT_COMPATIBLE');
    expect(payload['findingCount']).toBe(stored.findings.length);
    expect(payload['findingCount']).toBeGreaterThan(0);
    expect(payload['blockingCount']).toBeGreaterThan(0);
  });

  it('analysis_failed: stable failureCode and no exception text', async () => {
    // Not in GITHUB_FIXTURE_FILE_TREES → the tree fetch 404s and the runner
    // persists FAILED (never throws).
    const applicationId = await createApplication('deployz-demo/does-not-exist');
    await runAnalysis(applicationId);

    const row = await loadApplication(applicationId);
    expect(row.analysisStatus).toBe('FAILED');

    const failed = (await events('application.analysis_failed')).filter(
      (event) => event.payload['applicationId'] === applicationId,
    );
    expect(failed).toHaveLength(1);
    const payload = failed[0]!.payload;
    // Stable deterministic code derived from the ApiError — never the
    // exception text or the vendor-facing reason.
    expect(payload).toMatchObject({
      schemaVersion: 1,
      applicationId,
      failureCode: 'repository_unavailable',
    });
    expect(typeof payload['durationMs']).toBe('number');
    expect(Object.keys(payload).sort()).toEqual(['applicationId', 'durationMs', 'failureCode', 'schemaVersion']);
    // The raw exception text ("Repository not found") never reaches the payload.
    expect(JSON.stringify(payload).toLowerCase()).not.toContain('not found');
    expect(failed[0]!.payload['reason']).toBeUndefined();
    expect(failed[0]!.payload['message']).toBeUndefined();
  });

  it('preflight_evaluated: emitted by the deploy-link creation gate, never by the preflight GET', async () => {
    const applicationId = readyApplicationId;
    const customerId = (
      await send(app, 'POST', '/api/customers', { name: 'Acme Corp', email: 'preflight@acme.example.com' }, { cookie: org.cookie })
    ).json() as { id: string };

    // The read-only GET runs the same evaluation but must stay event-free.
    const read = await app.inject({
      method: 'GET',
      url: `/api/applications/${applicationId}/preflight?customerId=${customerId.id}`,
      headers: { cookie: org.cookie },
    });
    expect(read.statusCode, read.body).toBe(200);
    const readEvents = (await events('application.preflight_evaluated')).filter(
      (event) => event.payload['applicationId'] === applicationId,
    );
    expect(readEvents).toHaveLength(0);

    // Deploy-link creation is the gating action: preflight runs and passes.
    const linkResponse = await send(
      app,
      'POST',
      `/api/customers/${customerId.id}/deploy-links`,
      { applicationId, region: 'us-east-1' },
      { cookie: org.cookie },
    );
    expect(linkResponse.statusCode, linkResponse.body).toBe(201);
    const body = linkResponse.json() as { link: { id: string; deploymentId: string } };

    const gated = (await events('application.preflight_evaluated')).filter(
      (event) => event.payload['applicationId'] === applicationId,
    );
    expect(gated).toHaveLength(1);
    expect(gated[0]!.payload).toMatchObject({
      schemaVersion: 1,
      applicationId,
      result: 'pass',
      blockingCount: 0,
    });
    expect(typeof gated[0]!.payload['warningCount']).toBe('number');
    expect(gated[0]!.deploymentId).toBe(body.link.deploymentId);
  });

  it('preflight launch pass is recorded once per guarded action (retried launch does not duplicate)', async () => {
    const applicationId = readyApplicationId;
    const customerId = (
      await send(app, 'POST', '/api/customers', { name: 'Acme Corp', email: 'launch@acme.example.com' }, { cookie: org.cookie })
    ).json() as { id: string };
    const linkResponse = await send(
      app,
      'POST',
      `/api/customers/${customerId.id}/deploy-links`,
      { applicationId, region: 'us-east-1' },
      { cookie: org.cookie },
    );
    const link = linkResponse.json() as { link: { id: string; deploymentId: string }; token: string };

    const launch = () =>
      app.inject({
        method: 'POST',
        url: `/api/deploy-links/${link.link.id}/launched`,
        headers: { 'x-deployz-token': link.token },
      });

    const first = await launch();
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ state: 'WAITING_FOR_RELAY' });

    // One pass event from deploy-link creation, one from the launch.
    const deploymentPreflights = async () =>
      (await events('application.preflight_evaluated')).filter(
        (event) => event.deploymentId === link.link.deploymentId,
      );
    expect(await deploymentPreflights()).toHaveLength(2);
    for (const event of await deploymentPreflights()) {
      expect(event.payload).toMatchObject({ schemaVersion: 1, applicationId, result: 'pass' });
    }
    const launchedEvents = (await events('deploy_link.launched')).filter(
      (event) => event.deploymentId === link.link.deploymentId,
    );
    expect(launchedEvents).toHaveLength(1);

    // Retry: the idempotency guard returns the current state and neither the
    // launch event nor the preflight evaluation fires again.
    const second = await launch();
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toMatchObject({ state: 'WAITING_FOR_RELAY' });
    expect(await deploymentPreflights()).toHaveLength(2);
    expect((await events('deploy_link.launched')).filter((event) => event.deploymentId === link.link.deploymentId)).toHaveLength(1);
  });

  it('configuration_saved: one event per save with a count, never key values', async () => {
    const applicationId = await createApplication(`acme/config-app-${crypto.randomUUID().slice(0, 8)}`);

    const save = await send(
      app,
      'PUT',
      `/api/applications/${applicationId}/config`,
      {
        entries: [
          { key: 'API_PORT', value: '8080', isSecret: false },
          { key: 'API_TOKEN', value: 'super-secret-value', isSecret: true },
        ],
      },
      { cookie: org.cookie },
    );
    expect(save.statusCode, save.body).toBe(200);

    const saved = (await events('application.configuration_saved')).filter(
      (event) => event.payload['applicationId'] === applicationId,
    );
    expect(saved).toHaveLength(1);
    // Deep-equal to the expected keys: a count only — no key names, no values.
    expect(saved[0]!.payload).toEqual({ schemaVersion: 1, applicationId, changedKeyCount: 2 });
    expect(JSON.stringify(saved[0]!.payload)).not.toMatch(/8080|API_PORT|super-secret-value/);
    expect(saved[0]!.actorType).toBe('user');

    // A second successful save is a second save (this route has no guard),
    // so it emits its own event.
    await send(
      app,
      'PUT',
      `/api/applications/${applicationId}/config`,
      { entries: [{ key: 'API_PORT', value: '9090', isSecret: false }] },
      { cookie: org.cookie },
    );
    const savedTwice = (await events('application.configuration_saved')).filter(
      (event) => event.payload['applicationId'] === applicationId,
    );
    expect(savedTwice).toHaveLength(2);

    // A failing save (duplicate keys are rejected inside setConfig) changes
    // nothing and leaves no event behind.
    const failing = await send(
      app,
      'PUT',
      `/api/applications/${applicationId}/config`,
      {
        entries: [
          { key: 'DUP', value: 'a', isSecret: false },
          { key: 'DUP', value: 'b', isSecret: false },
        ],
      },
      { cookie: org.cookie },
    );
    expect(failing.statusCode, failing.body).toBe(400);
    const afterFailure = (await events('application.configuration_saved')).filter(
      (event) => event.payload['applicationId'] === applicationId,
    );
    expect(afterFailure).toHaveLength(2);
  });

  it('customer.created: customerId in the column and the payload', async () => {
    const response = await send(
      app,
      'POST',
      '/api/customers',
      { name: 'Acme Corp', email: `customer-${crypto.randomUUID()}@acme.example.com` },
      { cookie: org.cookie },
    );
    expect(response.statusCode, response.body).toBe(201);
    const customerId = (response.json() as { id: string }).id;

    const created = (await events('customer.created')).filter(
      (event) => event.customerId === customerId,
    );
    expect(created).toHaveLength(1);
    expect(created[0]!.payload).toEqual({ schemaVersion: 1, customerId });
    expect(created[0]!.customerId).toBe(customerId);
    expect(created[0]!.actorType).toBe('user');
    expect(created[0]!.organizationId).toBe(org.organizationId);
  });

  it('relay-register blocked evaluations: one event per deployment per throttle window', async () => {
    // A READY-shaped manifest with one required customer key nothing provides:
    // preflight RETURNS not-ready (instead of throwing on a missing manifest),
    // which is the blocked-registration path the relay hits on every retry.
    const blockedManifest = {
      application: { root: '.', runtime: 'node', framework: 'express', dockerfilePath: 'Dockerfile' },
      build: { command: 'npm run build', context: '.' },
      web: { command: 'npm start', port: 3000 },
      health: { path: '/health' },
      database: { postgres: true },
      redis: { required: false, envBindings: [] },
      storage: { required: false, envBindings: [] },
      migration: { command: null },
      worker: { command: null },
      environment: {
        variables: [
          {
            key: 'REQUIRED_API_KEY',
            required: true,
            secret: false,
            source: ['fixture:telemetry'],
            classification: 'customer_required' as const,
          },
        ],
      },
      externalServices: [],
      unsupported: [],
    };
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId: org.organizationId,
        name: 'relay-blocked',
        repoFullName: `acme/relay-blocked-${crypto.randomUUID().slice(0, 8)}`,
        repoUrl: 'https://github.com/acme/relay-blocked',
        defaultBranch: 'main',
      })
      .returning();
    const [customer] = await db
      .insert(schema.customers)
      .values({
        organizationId: org.organizationId,
        name: 'Blocked Corp',
        email: `blocked-${crypto.randomUUID()}@acme.example.com`,
      })
      .returning();
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId: org.organizationId,
        applicationId: application!.id,
        customerId: customer!.id,
        region: 'us-east-1',
        state: 'NOT_INSTALLED',
        // Unbound: a fresh deployment the relay has not enrolled against yet.
        installationId: null,
        enrollmentCode: crypto.randomUUID(),
        desiredState: { manifest: blockedManifest },
      })
      .returning();

    const register = () =>
      app.inject({
        method: 'POST',
        url: '/api/relay/register',
        payload: JSON.stringify({
          enrollmentCode: deployment!.enrollmentCode,
          installationId: 'inst-blocked-relay',
        }),
        headers: { 'content-type': 'application/json', authorization: 'Bearer relay-token-blocked' },
      });

    const blockedEvents = async () =>
      (await events('application.preflight_evaluated')).filter(
        (event) => event.deploymentId === deployment!.id && event.payload['result'] === 'blocked',
      );

    const first = await register();
    expect(first.statusCode, first.body).toBe(422);
    expect(await blockedEvents()).toHaveLength(1);
    expect(await blockedEvents()).toMatchObject([
      { payload: { schemaVersion: 1, applicationId: application!.id, result: 'blocked' } },
    ]);
    expect((await blockedEvents())[0]!.payload['blockingCount']).toBeGreaterThan(0);

    // A refused relay retries — inside the window the throttle keeps it at
    // one event.
    const second = await register();
    expect(second.statusCode, second.body).toBe(422);
    expect(await blockedEvents()).toHaveLength(1);

    // Past the window the next refusal is recorded again.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 16 * 60 * 1000);
      const third = await register();
      expect(third.statusCode, third.body).toBe(422);
      expect(await blockedEvents()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
