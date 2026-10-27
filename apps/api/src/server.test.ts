import { PGlite } from '@electric-sql/pglite';
import { customerSessionHeaders } from './customer-access-fixture.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { analyseRepo, buildApplicationAnalysis } from '@deployz/analysis';
import {
  APP_API_KEY_PARAMETER,
  APP_SIGNING_SECRET_PARAMETER,
  bootstrapStackName,
  DESIRED_COUNT_PARAMETER,
  errorEnvelopeSchema,
  estimateFootprintCost,
  IMAGE_REFERENCE_PARAMETER,
  requiredAwsResources,
  resolveDeploymentFootprint,
  toPlanAwsResource,
  workloadServicesFromSpec,
} from '@deployz/contracts';
import { applyMigrations, createDb, persistDeploymentResourceSnapshot, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { ANALYSIS_VERSION } from './analysis.js';
import { createAuth, type Auth } from './auth.js';
import { compileDeploymentIntent } from './compiler-artifact.js';
import { primaryServiceLogicalIds } from './deployment-status.js';
import { readStoredDeploymentSpec, readStoredManifest } from './manifest.js';
import { buildPullStatement, type EcrClient, type EcrGrantStatement } from './ecr-grants.js';
import { env } from './env.js';
import { ApiError } from './errors.js';
import { GITHUB_FIXTURE_FILE_TREES } from './github.js';
import { createCipherStub, createDrizzlePendingSecretStore } from './pending-secrets.js';
import { installLinkToken } from './install-link-token.js';
import { createRequireAuth } from './require-auth.js';
import { hashRelayToken } from './relay-store.js';
import {
  RELEASE_IMAGE_RECHECK_MS,
  createFixtureReleaseImageClient,
  type FixtureReleaseImageClient,
} from './release-images.js';
import { AI_EXPLAINABLE_FAILURE_CODES, buildServer, redactClaimedPayload } from './server.js';

// ── Shared test helpers (used by the describe blocks below) ────────────────

/**
 * A manifest that passes `evaluateManifestReadiness` as READY. Phase 3
 * readiness gates (install-link launch, relay register) re-evaluate the stored
 * manifest on every deployment they touch, so DB-seeded fixtures carry one.
 */
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

/** Signs up a fresh user, which provisions its own vendor org (auth.ts session hook). */
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
      name: 'Test App',
      // Unique per call: one application per repo per organization is now a
      // database constraint, and several tests seed two applications in the
      // same org.
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

async function insertRelease(
  db: Db,
  applicationId: string,
  overrides: Partial<typeof schema.releases.$inferInsert> = {},
): Promise<typeof schema.releases.$inferSelect> {
  const [row] = await db
    .insert(schema.releases)
    .values({
      applicationId,
      // Unique per call: one release per version per application is now a
      // database constraint, and several tests seed two releases for one app.
      version: `v1.0.0-${crypto.randomUUID().slice(0, 8)}`,
      gitSha: 'a1b2c3d',
      ...overrides,
    })
    .returning();
  return row!;
}

/** The compiled web service's logical id — the primary service the inventory must carry. */
const WEB_SERVICE_ID = primaryServiceLogicalIds(
  compileDeploymentIntent({
    manifest: READY_MANIFEST as unknown as Parameters<typeof compileDeploymentIntent>[0]['manifest'],
    region: 'us-east-1',
  }).spec,
)[0]!;

/** A READY release with an image: deployment creation and every INSTALL refuse without one. */
async function insertDeployableRelease(
  db: Db,
  applicationId: string,
): Promise<typeof schema.releases.$inferSelect> {
  return insertRelease(db, applicationId, {
    releaseStatus: 'READY',
    imageDigest: `151955775369.dkr.ecr.us-east-1.amazonaws.com/deployz-images@sha256:${'c'.repeat(64)}`,
  });
}

/** The relay's complete healthy release evidence for a deployment's frozen spec, running `digest`. */
function healthyReleaseEvidence(deployment: typeof schema.deployments.$inferSelect, digest: string) {
  const at = new Date().toISOString();
  return {
    version: 1,
    observedAt: at,
    services: workloadServicesFromSpec(readStoredDeploymentSpec(deployment.specV2)!)!.map((workload) => ({
      workloadId: workload.id,
      serviceLogicalId: workload.serviceLogicalId,
      observed: true,
      desiredCount: 1,
      runningCount: 1,
      rolloutState: 'COMPLETED',
      runningDigests: [digest],
      targets: workload.id === 'web' ? { healthy: 1, unhealthy: 0, pending: 0, unknown: 0 } : null,
    })),
    httpProbe: { ok: true, status: 200, checkedAt: at },
  };
}

async function insertDeployment(
  db: Db,
  organizationId: string,
  applicationId: string,
  customerId: string,
  overrides: Partial<typeof schema.deployments.$inferInsert> = {},
): Promise<typeof schema.deployments.$inferSelect> {
  const desiredState =
    (overrides.desiredState as { manifest: typeof READY_MANIFEST } | undefined) ?? {
      manifest: READY_MANIFEST,
    };
  const [row] = await db
    .insert(schema.deployments)
    .values({
      organizationId,
      applicationId,
      customerId,
      region: 'us-east-1',
      state: 'NOT_INSTALLED',
      installationId: `inst-${crypto.randomUUID()}`,
      // The control plane mints this when a deployment is created; the relay
      // trades it once for its binding.
      enrollmentCode: crypto.randomUUID(),
      // Phase 3 readiness gates (install-link launch, relay register)
      // re-evaluate the stored manifest — seed a READY one so fixtures pass.
      desiredState,
      // The completed spec createDeploymentRecord persists for this manifest.
      // Fixtures that deliberately seed an invalid manifest stay spec-less,
      // exactly like a deployment the compiler never ran for.
      ...(readStoredManifest(desiredState)
        ? {
            specV2: compileDeploymentIntent({
              manifest: readStoredManifest(desiredState) as unknown as Parameters<
                typeof compileDeploymentIntent
              >[0]['manifest'],
              region: 'us-east-1',
            }).spec,
          }
        : {}),
      ...overrides,
    })
    .returning();
  return row!;
}

/** POST/PATCH/PUT a JSON body through app.inject, matching server.ts's raw-string JSON parser. */
function sendJson(
  app: FastifyInstance,
  method: 'POST' | 'PUT' | 'PATCH',
  url: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
) {
  return app.inject({
    method,
    url,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    payload: JSON.stringify(body),
  });
}

/** The pre-session fragment token; tests prove it no longer grants anything. */
function linkTokenHeader(installLinkId: string): Record<string, string> {
  return { 'x-deployz-token': installLinkToken(installLinkId) };
}

function postJson(
  app: FastifyInstance,
  url: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
) {
  return sendJson(app, 'POST', url, body, extraHeaders);
}

// Fastify base over a fresh in-memory PGlite (real Postgres semantics, full
// migrations). One signup in beforeAll; every assertion goes through
// app.inject against the real server with probe routes exercising the todo-4
// surface: auth middleware, ApiError envelope mapping, unknown-error
// containment.
describe('server (Fastify base over PGlite)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let cookie: string;
  let userId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);

    const email = 'grace@example.com';
    const password = 'super-secret-1';
    const signup = await auth.api.signUpEmail({
      body: { email, password, name: 'Grace' },
    });
    userId = signup.user.id;
    const signin = await auth.api.signInEmail({
      body: { email, password },
      asResponse: true,
    });
    const setCookie = signin.headers.get('set-cookie');
    if (!setCookie) {
      throw new Error('sign-in did not set a session cookie');
    }
    cookie = setCookie;

    app = await buildServer({ auth, db });

    const requireAuth = createRequireAuth({ auth, db });
    app.get('/api/probe-auth', { preHandler: requireAuth }, async (request) => ({
      userId: request.user?.id ?? null,
      organizationId: request.organization?.id ?? null,
    }));
    app.get('/api/probe-api-error', async () => {
      throw new ApiError(422, 'PORT_MISMATCH', 'Port 8080 is not exposed by the image', {
        port: 8080,
      });
    });
    app.get('/api/probe-unknown-error', async () => {
      throw new Error('hunter2-internal-db-password');
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('GET /health returns 200', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
  });

  it('GET /health/ready returns 200 when the DB and schema are usable (DZ-AUDIT-015)', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  // The browser writes config with PUT and renames the org with PATCH. The
  // @fastify/cors default is GET,HEAD,POST, which fails both preflights and
  // makes those saves silently impossible from the dashboard.
  it.each(['PUT', 'PATCH', 'POST', 'GET'])(
    'CORS preflight allows %s from the web origin',
    async (method) => {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/api/organization',
        headers: {
          origin: env.webUrl,
          'access-control-request-method': method,
        },
      });
      expect(response.headers['access-control-allow-methods']).toContain(method);
      expect(response.headers['access-control-allow-origin']).toBe(env.webUrl);
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    },
  );

  it('GET /api/me without a session returns 401 as a structured envelope', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/me' });
    expect(response.statusCode).toBe(401);
    const envelope = errorEnvelopeSchema.parse(response.json());
    expect(envelope.error.code).toBe('UNAUTHORIZED');
  });

  it('GET /api/me with a session cookie returns 200 with the user', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { user: { email: string } };
    expect(body.user.email).toBe('grace@example.com');
  });

  it('protected probe resolves user + organization from the session cookie', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/probe-auth',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { userId: string; organizationId: string };
    expect(body.userId).toBe(userId);
    expect(body.organizationId).toBeTruthy();
  });

  it('ApiError renders as its code/message/details envelope', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/probe-api-error' });
    expect(response.statusCode).toBe(422);
    const envelope = errorEnvelopeSchema.parse(response.json());
    expect(envelope.error.code).toBe('PORT_MISMATCH');
    expect(envelope.error.message).toBe('Port 8080 is not exposed by the image');
    expect(envelope.error.details).toStrictEqual({ port: 8080 });
  });

  it('unknown errors render 500 INTERNAL_ERROR without leaking internals', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/probe-unknown-error' });
    expect(response.statusCode).toBe(500);
    const body = response.json() as unknown;
    const envelope = errorEnvelopeSchema.parse(body);
    expect(envelope.error.code).toBe('INTERNAL_ERROR');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('hunter2-internal-db-password');
    expect(serialized).not.toContain('at '); // no stack frames
  });

  // Simulated-E2E decision D2: scenario selection lives entirely in the test
  // process, so the API defines no scenario-control route. Pinned here so a
  // route added "just for E2E convenience" cannot reach production.
  it.each([
    '/internal/e2e/scenario',
    '/api/internal/e2e/scenario',
    '/__e2e__/scenario',
    '/internal/scenario',
  ])('%s is not a route (no scenario-control surface)', async (url) => {
    for (const method of ['GET', 'POST'] as const) {
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(404);
    }
  });

  // The 5xx envelope above is generic on purpose, so the log is the ONLY place
  // the real cause survives. The API ran `logger: false`, which meant a 500
  // left no trace anywhere — three production failures in a row could only be
  // diagnosed by reading configuration and guessing.
  it('logs the real cause of a 5xx, which the envelope deliberately withholds', async () => {
    const logged: Array<Record<string, unknown>> = [];
    const recorder = {
      level: 'warn',
      error: (obj: unknown) => {
        logged.push(obj as Record<string, unknown>);
      },
      warn: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
      silent: () => {},
      child: () => recorder,
    } as unknown as Parameters<typeof buildServer>[0]['loggerInstance'];

    const logging = await buildServer({ auth, db, loggerInstance: recorder });
    logging.get('/api/probe-logged-error', async () => {
      throw new Error('hunter2-internal-db-password');
    });
    logging.get('/api/probe-logged-client-error', async () => {
      throw new ApiError(404, 'NOT_FOUND', 'nope');
    });

    await logging.inject({ method: 'GET', url: '/api/probe-logged-error' });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      method: 'GET',
      url: '/api/probe-logged-error',
      code: 'INTERNAL_ERROR',
    });
    expect((logged[0]!['err'] as Error).message).toBe('hunter2-internal-db-password');

    // A 4xx is the caller's problem, not an incident — it stays out of the log.
    await logging.inject({ method: 'GET', url: '/api/probe-logged-client-error' });
    expect(logged).toHaveLength(1);

    await logging.close();
  });
});

// ── §1: organization identity comes from the session, never the client ─────
describe('server — organization identity comes from the session, not the client (§1)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let orgA: { userId: string; organizationId: string; cookie: string };
  let orgB: { userId: string; organizationId: string; cookie: string };

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    orgA = await signUpAndGetOrg(auth, db, 'org-a@example.com');
    orgB = await signUpAndGetOrg(auth, db, 'org-b@example.com');
    // An application may only point at an installation its own organization
    // connected, so the connected installation has to exist first.
    await db.insert(schema.githubInstallations).values({
      id: 'inst-1',
      organizationId: orgA.organizationId,
      accountLogin: 'org-a',
      accountType: 'Organization',
    });
    // This describe block creates PRODUCTION deployments (the default) to
    // exercise ownership/manifest gates unrelated to billing — an ACTIVE
    // subscription keeps them past the Phase 7 entitlement gate.
    await db.insert(schema.billingSubscriptions).values({
      organizationId: orgA.organizationId,
      providerCustomerId: 'ctm_fixture_org_a',
      providerSubscriptionId: 'sub_fixture_org_a',
      status: 'ACTIVE',
    });
    app = await buildServer({ auth, db });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('GET /api/applications ignores a spoofed ?organizationId query param', async () => {
    await insertApplication(db, orgA.organizationId, { name: 'Org A App' });
    await insertApplication(db, orgB.organizationId, { name: 'Org B App' });

    const response = await app.inject({
      method: 'GET',
      url: `/api/applications?organizationId=${orgB.organizationId}`,
      headers: { cookie: orgA.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { applications: Array<{ name: string }> };
    expect(body.applications.map((a) => a.name)).toEqual(['Org A App']);
  });

  it('GET /api/applications lists a slim row: only the detected facts the list pages read, no environment settings', async () => {
    const bulky = await insertApplication(db, orgA.organizationId, {
      name: 'Slim List App',
      detectedMetadata: {
        hasDockerfile: true,
        databaseState: 'mysql',
        analysisCommitSha: 'abc123',
        readiness: { findings: Array.from({ length: 50 }, (_, i) => `finding ${i}`) },
        manifest: { large: 'x'.repeat(5000) },
      },
      environmentSettings: [{ key: 'A' }],
    });

    const list = await app.inject({ method: 'GET', url: '/api/applications', headers: { cookie: orgA.cookie } });
    const listed = (list.json() as { applications: Array<Record<string, unknown>> }).applications.find(
      (row) => row['id'] === bulky.id,
    )!;
    expect(listed['detectedMetadata']).toEqual({ hasDockerfile: true, databaseState: 'mysql', analysisCommitSha: 'abc123' });
    expect(listed).not.toHaveProperty('environmentSettings');
    expect(listed['name']).toBe('Slim List App');

    const detail = await app.inject({ method: 'GET', url: `/api/applications/${bulky.id}`, headers: { cookie: orgA.cookie } });
    expect((detail.json() as { detectedMetadata: Record<string, unknown> }).detectedMetadata['manifest']).toBeDefined();
  });

  it('POST /api/applications with no body.organizationId lands in the session org', async () => {
    const response = await postJson(
      app,
      '/api/applications',
      {
        name: 'No Org Field App',
        githubInstallationId: 'inst-1',
        repoFullName: 'acme/no-org-field',
        repoUrl: 'https://github.com/acme/no-org-field',
        defaultBranch: 'main',
      },
      { cookie: orgA.cookie },
    );
    expect(response.statusCode).toBe(201);
    expect((response.json() as { organizationId: string }).organizationId).toBe(orgA.organizationId);
  });

  it('POST /api/applications 403s when body.organizationId disagrees with the session', async () => {
    const response = await postJson(
      app,
      '/api/applications',
      {
        organizationId: orgB.organizationId,
        name: 'Spoofed Org App',
        githubInstallationId: 'inst-2',
        repoFullName: 'acme/spoofed',
        repoUrl: 'https://github.com/acme/spoofed',
        defaultBranch: 'main',
      },
      { cookie: orgA.cookie },
    );
    expect(response.statusCode).toBe(403);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('ORGANIZATION_MISMATCH');
  });

  it('POST /api/customers 403s on a cross-org body.organizationId, succeeds when it matches the session', async () => {
    const mismatch = await postJson(
      app,
      '/api/customers',
      { organizationId: orgB.organizationId, name: 'Spoofed Customer', email: 'spoofed@example.com' },
      { cookie: orgA.cookie },
    );
    expect(mismatch.statusCode).toBe(403);

    const ok = await postJson(
      app,
      '/api/customers',
      { organizationId: orgA.organizationId, name: 'Real Customer', email: 'real@example.com' },
      { cookie: orgA.cookie },
    );
    expect(ok.statusCode).toBe(201);
    expect((ok.json() as { organizationId: string }).organizationId).toBe(orgA.organizationId);
  });

  it('POST /api/deployments 403s on a cross-org body.organizationId (never silently inserts under the client-asserted org)', async () => {
    const application = await insertApplication(db, orgA.organizationId);
    const customer = await insertCustomer(db, orgA.organizationId);

    const response = await postJson(
      app,
      '/api/deployments',
      {
        applicationId: application.id,
        customerId: customer.id,
        organizationId: orgB.organizationId, // spoofed
        region: 'us-east-1',
      },
      { cookie: orgA.cookie },
    );
    expect(response.statusCode).toBe(403);
  });

  it('POST /api/deployments with the correct (or no) organizationId inserts under the session org', async () => {
    const application = await insertApplication(db, orgA.organizationId, {
      // Phase 2 readiness gate: a deployment may only be created when the
      // final manifest is READY, so an analyzed (manifest-ready) application
      // is required here.
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
    });
    await insertDeployableRelease(db, application.id);
    const customer = await insertCustomer(db, orgA.organizationId);

    const response = await postJson(
      app,
      '/api/deployments',
      { applicationId: application.id, customerId: customer.id, region: 'us-east-1' },
      { cookie: orgA.cookie },
    );
    expect(response.statusCode).toBe(201);
    expect((response.json() as { organizationId: string }).organizationId).toBe(orgA.organizationId);
  });

  it('POST /api/deployments 404s for a well-formed but non-existent applicationId (not a 500)', async () => {
    const customer = await insertCustomer(db, orgA.organizationId);

    const response = await postJson(
      app,
      '/api/deployments',
      {
        applicationId: '00000000-0000-4000-8000-000000000000',
        customerId: customer.id,
        region: 'us-east-1',
      },
      { cookie: orgA.cookie },
    );
    expect(response.statusCode).toBe(404);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
  });

  it('POST /api/deployments 404s for a well-formed but non-existent customerId (not a 500)', async () => {
    const application = await insertApplication(db, orgA.organizationId);

    const response = await postJson(
      app,
      '/api/deployments',
      {
        applicationId: application.id,
        customerId: '00000000-0000-4000-8000-000000000001',
        region: 'us-east-1',
      },
      { cookie: orgA.cookie },
    );
    expect(response.statusCode).toBe(404);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
  });

  it('POST /api/deployments 404s for an applicationId that belongs to another org', async () => {
    const otherOrgApplication = await insertApplication(db, orgB.organizationId);
    const customer = await insertCustomer(db, orgA.organizationId);

    const response = await postJson(
      app,
      '/api/deployments',
      {
        applicationId: otherOrgApplication.id,
        customerId: customer.id,
        region: 'us-east-1',
      },
      { cookie: orgA.cookie },
    );
    expect(response.statusCode).toBe(404);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
  });

  it('POST /api/deployments 404s for a customerId that belongs to another org', async () => {
    const application = await insertApplication(db, orgA.organizationId);
    const otherOrgCustomer = await insertCustomer(db, orgB.organizationId);

    const response = await postJson(
      app,
      '/api/deployments',
      {
        applicationId: application.id,
        customerId: otherOrgCustomer.id,
        region: 'us-east-1',
      },
      { cookie: orgA.cookie },
    );
    expect(response.statusCode).toBe(404);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
  });

  it('POST /api/deployments 422s MANIFEST_NOT_COMPATIBLE for an app with §11.4 unsupported architecture (§10 rejection → blocked before provisioning)', async () => {
    const application = await insertApplication(db, orgA.organizationId, {
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
        envVars: [],
        envVarModel: [],
        // A fresh Phase 7 analysis persists the full reason list; the manifest
        // gate turns ANY of it into NOT_COMPATIBLE (blocked pre-provisioning).
        unsupportedReasons: ['Unsupported architecture: Kubernetes manifests are present (kustomization.yaml).'],
      },
    });
    const customer = await insertCustomer(db, orgA.organizationId);
    const response = await postJson(
      app,
      '/api/deployments',
      { applicationId: application.id, customerId: customer.id, region: 'us-east-1' },
      { cookie: orgA.cookie },
    );
    expect(response.statusCode).toBe(422);
    const body = response.json() as { error: { code: string } };
    expect(body.error.code).toBe('MANIFEST_NOT_COMPATIBLE');
  });

  it('POST /api/deployments 422s MANIFEST_NEEDS_CONFIGURATION when a required env var has no provided value (§11.2)', async () => {
    const application = await insertApplication(db, orgA.organizationId, {
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
        envVars: ['STRIPE_SECRET_KEY'],
        envVarModel: [
          { key: 'STRIPE_SECRET_KEY', required: true, secret: true, source: ['read in src/index.ts'] },
        ],
      },
    });
    const customer = await insertCustomer(db, orgA.organizationId);
    const response = await postJson(
      app,
      '/api/deployments',
      { applicationId: application.id, customerId: customer.id, region: 'us-east-1' },
      { cookie: orgA.cookie },
    );
    expect(response.statusCode).toBe(422);
    const body = response.json() as {
      error: { code: string; details?: { findings?: Array<{ id: string }> } };
    };
    expect(body.error.code).toBe('MANIFEST_NEEDS_CONFIGURATION');
    expect(body.error.details?.findings?.some((f) => f.id === 'required-env-vars-missing')).toBe(true);
  });

  it('POST /api/deployments allows an app whose required env var is set in the application config defaults (§11.2)', async () => {
    const application = await insertApplication(db, orgA.organizationId, {
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
        envVars: ['STRIPE_SECRET_KEY'],
        envVarModel: [
          { key: 'STRIPE_SECRET_KEY', required: true, secret: true, source: ['read in src/index.ts'] },
        ],
      },
    });
    await insertDeployableRelease(db, application.id);
    const customer = await insertCustomer(db, orgA.organizationId);
    // The vendor configured the value as an application default (§31) — the
    // deployment gate now sees a provided key and lets the deployment through.
    // A vendor-scope secret only counts as deliverable with an encrypted
    // value — a legacy masked-only row would not.
    await db.insert(schema.applicationConfigs).values({
      applicationId: application.id,
      customerId: null,
      key: 'STRIPE_SECRET_KEY',
      value: '***',
      isSecret: true,
      // listProvidedConfigKeys only checks encryptedValue !== null (a real
      // ciphertext is not needed for this readiness-gate assertion).
      encryptedValue: 'enc:stub:sk_test_vendor_default',
    });

    const response = await postJson(
      app,
      '/api/deployments',
      { applicationId: application.id, customerId: customer.id, region: 'us-east-1' },
      { cookie: orgA.cookie },
    );
    expect(response.statusCode).toBe(201);
  });
});

// ── §2: IDOR guards on every :id route ──────────────────────────────────────
describe('server — IDOR guards on :id routes (§2)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let orgA: { userId: string; organizationId: string; cookie: string };
  let orgB: { userId: string; organizationId: string; cookie: string };
  let appB: typeof schema.applications.$inferSelect;
  let depB: typeof schema.deployments.$inferSelect;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    orgA = await signUpAndGetOrg(auth, db, 'idor-a@example.com');
    orgB = await signUpAndGetOrg(auth, db, 'idor-b@example.com');
    app = await buildServer({ auth, db });

    appB = await insertApplication(db, orgB.organizationId, { name: 'Org B App' });
    const customerB = await insertCustomer(db, orgB.organizationId);
    depB = await insertDeployment(db, orgB.organizationId, appB.id, customerB.id, { state: 'HEALTHY' });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  const routes: Array<[string, () => string]> = [
    ['GET', () => `/api/applications/${appB.id}`],
    ['POST', () => `/api/applications/${appB.id}/analyse`],
    ['GET', () => `/api/applications/${appB.id}/readiness`],
    ['GET', () => `/api/applications/${appB.id}/config`],
    ['PUT', () => `/api/applications/${appB.id}/config`],
    ['POST', () => `/api/applications/${appB.id}/releases`],
    ['GET', () => `/api/applications/${appB.id}/releases`],
    ['GET', () => `/api/deployments/${depB.id}`],
    ['POST', () => `/api/deployments/${depB.id}/deploy`],
    ['POST', () => `/api/deployments/${depB.id}/rollback`],
    ['POST', () => `/api/deployments/${depB.id}/destroy`],
    ['GET', () => `/api/deployments/${depB.id}/events`],
    ['GET', () => `/api/deployments/${depB.id}/diagnostics`],
    ['PATCH', () => `/api/applications/${appB.id}`],
    ['DELETE', () => `/api/applications/${appB.id}`],
  ];

  it.each(routes)('%s %s 404s for a caller outside the owning org (never leaks existence)', async (method, urlFn) => {
    const response = await app.inject({
      method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      url: urlFn(),
      headers:
        method === 'GET' || method === 'DELETE'
          ? { cookie: orgA.cookie }
          : { cookie: orgA.cookie, 'content-type': 'application/json' },
      payload:
        method === 'GET' || method === 'DELETE'
          ? undefined
          : JSON.stringify({ releaseId: crypto.randomUUID(), version: '1.0.0', gitSha: 'abc', entries: [] }),
    });
    expect(response.statusCode).toBe(404);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
  });

  it('the owning org CAN reach its own application and deployment (the guard is not over-broad)', async () => {
    const appResponse = await app.inject({
      method: 'GET',
      url: `/api/applications/${appB.id}`,
      headers: { cookie: orgB.cookie },
    });
    expect(appResponse.statusCode).toBe(200);

    const depResponse = await app.inject({
      method: 'GET',
      url: `/api/deployments/${depB.id}`,
      headers: { cookie: orgB.cookie },
    });
    expect(depResponse.statusCode).toBe(200);
  });
});

// ── §31: the config scope carries the customer NAME, and is org-owned ──────
describe('server — config scope resolution (§31,§65)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let orgA: { userId: string; organizationId: string; cookie: string };
  let orgB: { userId: string; organizationId: string; cookie: string };
  let application: typeof schema.applications.$inferSelect;
  let customer: typeof schema.customers.$inferSelect;
  let otherOrgCustomer: typeof schema.customers.$inferSelect;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    orgA = await signUpAndGetOrg(auth, db, 'config-scope-a@example.com');
    orgB = await signUpAndGetOrg(auth, db, 'config-scope-b@example.com');
    app = await buildServer({ auth, db });
    application = await insertApplication(db, orgA.organizationId, { name: 'Config Scope App' });
    customer = await insertCustomer(db, orgA.organizationId, { name: 'Acme Industries' });
    otherOrgCustomer = await insertCustomer(db, orgB.organizationId, { name: 'Other Org Customer' });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  // §65: the screen names the customer, so the id never has to be rendered.
  it('GET scoped to a customer returns that customer name', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/config?customerId=${customer.id}`,
      headers: { cookie: orgA.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ customerId: customer.id, customerName: 'Acme Industries' });
  });

  it('GET without a customer is the vendor scope — no customer id, no name', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/config`,
      headers: { cookie: orgA.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ customerId: null, customerName: null });
  });

  it('PUT scoped to a customer returns that customer name alongside the saved values', async () => {
    const response = await sendJson(
      app,
      'PUT',
      `/api/applications/${application.id}/config`,
      { customerId: customer.id, entries: [{ key: 'LOG_LEVEL', value: 'debug', isSecret: false }] },
      { cookie: orgA.cookie },
    );
    expect(response.statusCode).toBe(200);
    const body = response.json() as { customerName: string | null; customerOverrides: { key: string; value: string | null }[] };
    expect(body.customerName).toBe('Acme Industries');
    expect(body.customerOverrides).toContainEqual({ key: 'LOG_LEVEL', value: 'debug', isSecret: false });
  });

  it('PUT config refuses 409 RELAY_DISCONNECTED when a customer deployment relay is dead (§9.5)', async () => {
    await insertDeployment(db, orgA.organizationId, application.id, customer.id, {
      state: 'HEALTHY',
      relayStatus: 'DISCONNECTED',
    });
    const response = await sendJson(
      app,
      'PUT',
      `/api/applications/${application.id}/config`,
      { customerId: customer.id, entries: [{ key: 'LOG_LEVEL', value: 'warn', isSecret: false }] },
      { cookie: orgA.cookie },
    );
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'RELAY_DISCONNECTED' } });
  });

  it('a customer of another organization 404s on read and on write (§2)', async () => {
    const read = await app.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/config?customerId=${otherOrgCustomer.id}`,
      headers: { cookie: orgA.cookie },
    });
    expect(read.statusCode).toBe(404);

    const write = await sendJson(
      app,
      'PUT',
      `/api/applications/${application.id}/config`,
      { customerId: otherOrgCustomer.id, entries: [{ key: 'LEAK', value: 'no', isSecret: false }] },
      { cookie: orgA.cookie },
    );
    expect(write.statusCode).toBe(404);

    const rows = await db
      .select()
      .from(schema.applicationConfigs)
      .where(eq(schema.applicationConfigs.customerId, otherOrgCustomer.id));
    expect(rows).toHaveLength(0);
  });
});

// ── Env-var setup: GET/PUT /api/applications/:id/environment-settings,
// the release build gate, and the readiness environmentSetup counts ────────
describe('server — env-var setup (environment-settings route, release gate, readiness counts)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };
  let otherOrg: { userId: string; organizationId: string; cookie: string };

  // One customer_required secret, one build-prefixed key, one optional key.
  const ENV_SETUP_METADATA = {
    hasDockerfile: true,
    dockerfilePath: 'Dockerfile',
    framework: 'express',
    port: '3000',
    startupCommands: ['node dist/index.js'],
    hasStartupCommand: true,
    envVarModel: [
      { key: 'STRIPE_SECRET_KEY', required: true, secret: true, classification: 'customer_required', purpose: 'external_credential', source: [] },
      { key: 'NEXT_PUBLIC_API_URL', required: true, secret: false, classification: 'customer_required', purpose: 'external_credential', source: [] },
      { key: 'LOG_LEVEL', required: false, secret: false, classification: 'optional', purpose: 'optional_configuration', source: [] },
    ],
  } as Record<string, unknown>;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'env-setup-a@example.com');
    otherOrg = await signUpAndGetOrg(auth, db, 'env-setup-b@example.com');
    app = await buildServer({ auth, db });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('GET returns null settings, the effective manifest variables, and the deployz-providable keys (legacy application)', async () => {
    const application = await insertApplication(db, org.organizationId, { detectedMetadata: ENV_SETUP_METADATA });
    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/environment-settings`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as {
      settings: unknown;
      variables: { key: string }[];
      deployzKeys: string[];
      vendorValueKeys: string[];
    };
    expect(body.settings).toBeNull();
    expect(body.variables.map((v) => v.key).sort()).toEqual(['LOG_LEVEL', 'NEXT_PUBLIC_API_URL', 'STRIPE_SECRET_KEY']);
    expect(body.deployzKeys).toEqual([]);
    expect(body.vendorValueKeys).toEqual([]);
  });

  it('PUT rejects a malformed setting with 400 INVALID_ENVIRONMENT_SETTINGS', async () => {
    const application = await insertApplication(db, org.organizationId, { detectedMetadata: ENV_SETUP_METADATA });
    const response = await sendJson(
      app,
      'PUT',
      `/api/applications/${application.id}/environment-settings`,
      // A customer cannot supply a build-stage value — the schema itself refuses this.
      { settings: [{ key: 'NEXT_PUBLIC_API_URL', stage: 'build', required: true, secret: false, provider: 'customer' }] },
      { cookie: org.cookie },
    );
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_ENVIRONMENT_SETTINGS' } });
  });

  it('PUT rejects provider:deployz on a key the manifest does not allow with 422 ENVIRONMENT_SETTINGS_INVALID', async () => {
    const application = await insertApplication(db, org.organizationId, { detectedMetadata: ENV_SETUP_METADATA });
    const response = await sendJson(
      app,
      'PUT',
      `/api/applications/${application.id}/environment-settings`,
      { settings: [{ key: 'STRIPE_SECRET_KEY', stage: 'runtime', required: true, secret: true, provider: 'deployz' }] },
      { cookie: org.cookie },
    );
    expect(response.statusCode, response.body).toBe(422);
    const body = response.json() as { error: { code: string; details?: { problems?: string[] } } };
    expect(body.error.code).toBe('ENVIRONMENT_SETTINGS_INVALID');
    expect(body.error.details?.problems?.[0]).toContain('STRIPE_SECRET_KEY');
  });

  it('PUT saves valid settings and GET reflects them back, recording a counts-only event', async () => {
    const application = await insertApplication(db, org.organizationId, { detectedMetadata: ENV_SETUP_METADATA });
    const settings = [
      { key: 'STRIPE_SECRET_KEY', stage: 'runtime', required: true, secret: true, provider: 'customer' },
      { key: 'NEXT_PUBLIC_API_URL', stage: 'build', required: true, secret: false, provider: 'vendor' },
      { key: 'LOG_LEVEL', stage: 'runtime', required: false, secret: false, provider: 'none' },
    ];
    const putResponse = await sendJson(
      app,
      'PUT',
      `/api/applications/${application.id}/environment-settings`,
      { settings },
      { cookie: org.cookie },
    );
    expect(putResponse.statusCode, putResponse.body).toBe(200);
    expect((putResponse.json() as { settings: unknown }).settings).toEqual(settings);

    const getResponse = await app.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/environment-settings`,
      headers: { cookie: org.cookie },
    });
    expect((getResponse.json() as { settings: unknown }).settings).toEqual(settings);

    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.eventType, 'application.environment_settings_saved'));
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ applicationId: application.id, settingCount: 3 });
    expect(JSON.stringify(events[0]!.payload)).not.toContain('STRIPE_SECRET_KEY');
  });

  it('a cross-org application 404s on both routes', async () => {
    const application = await insertApplication(db, otherOrg.organizationId, { detectedMetadata: ENV_SETUP_METADATA });
    const get = await app.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/environment-settings`,
      headers: { cookie: org.cookie },
    });
    expect(get.statusCode).toBe(404);
    const put = await sendJson(
      app,
      'PUT',
      `/api/applications/${application.id}/environment-settings`,
      { settings: [] },
      { cookie: org.cookie },
    );
    expect(put.statusCode).toBe(404);
  });

  it('the release build gate refuses BUILD_CONFIGURATION_MISSING when a required build-stage vendor value is missing', async () => {
    const application = await insertApplication(db, org.organizationId, {
      detectedMetadata: { ...ENV_SETUP_METADATA, analysisCommitSha: 'a'.repeat(40) },
    });
    await sendJson(
      app,
      'PUT',
      `/api/applications/${application.id}/environment-settings`,
      { settings: [{ key: 'NEXT_PUBLIC_API_URL', stage: 'build', required: true, secret: false, provider: 'vendor' }] },
      { cookie: org.cookie },
    );
    const response = await sendJson(
      app,
      'POST',
      `/api/applications/${application.id}/releases`,
      { version: '1.0.0', gitSha: 'a'.repeat(40) },
      { cookie: org.cookie },
    );
    expect(response.statusCode, response.body).toBe(422);
    const body = response.json() as { error: { code: string; details?: { keys?: string[] } } };
    expect(body.error.code).toBe('BUILD_CONFIGURATION_MISSING');
    expect(body.error.details?.keys).toEqual(['NEXT_PUBLIC_API_URL']);
  });

  it('the release build gate lets the release through once the vendor value is saved', async () => {
    const application = await insertApplication(db, org.organizationId, {
      detectedMetadata: { ...ENV_SETUP_METADATA, analysisCommitSha: 'b'.repeat(40) },
    });
    await sendJson(
      app,
      'PUT',
      `/api/applications/${application.id}/environment-settings`,
      { settings: [{ key: 'NEXT_PUBLIC_API_URL', stage: 'build', required: true, secret: false, provider: 'vendor' }] },
      { cookie: org.cookie },
    );
    await sendJson(
      app,
      'PUT',
      `/api/applications/${application.id}/config`,
      { entries: [{ key: 'NEXT_PUBLIC_API_URL', value: 'https://api.example.com', isSecret: false }] },
      { cookie: org.cookie },
    );
    const response = await sendJson(
      app,
      'POST',
      `/api/applications/${application.id}/releases`,
      { version: '1.0.0', gitSha: 'b'.repeat(40) },
      { cookie: org.cookie },
    );
    expect(response.statusCode, response.body).toBe(201);
  });

  it('readiness gains environmentSetup counts once analysis is COMPLETE, null otherwise', async () => {
    const incomplete = await insertApplication(db, org.organizationId, { detectedMetadata: ENV_SETUP_METADATA });
    const incompleteReadiness = await app.inject({
      method: 'GET',
      url: `/api/applications/${incomplete.id}/readiness`,
      headers: { cookie: org.cookie },
    });
    expect((incompleteReadiness.json() as { environmentSetup: unknown }).environmentSetup).toBeNull();

    const complete = await insertApplication(db, org.organizationId, {
      detectedMetadata: ENV_SETUP_METADATA,
      analysisStatus: 'COMPLETE',
    });
    await sendJson(
      app,
      'PUT',
      `/api/applications/${complete.id}/environment-settings`,
      { settings: [{ key: 'STRIPE_SECRET_KEY', stage: 'runtime', required: true, secret: true, provider: 'customer' }] },
      { cookie: org.cookie },
    );
    const completeReadiness = await app.inject({
      method: 'GET',
      url: `/api/applications/${complete.id}/readiness`,
      headers: { cookie: org.cookie },
    });
    const body = completeReadiness.json() as {
      environmentSetup: { needsDecision: number; missingValue: number; missingBuildValue: number; customer: number; total: number };
    };
    // STRIPE_SECRET_KEY → customer (saved); NEXT_PUBLIC_API_URL → still
    // "unreviewed required" (needs a decision); LOG_LEVEL → optional.
    expect(body.environmentSetup).toEqual({ needsDecision: 1, missingValue: 0, missingBuildValue: 0, customer: 1, total: 3 });
  });

  it('readiness flags a stored analysis older than the current analyser as outdated (A1-006)', async () => {
    const readiness = async (id: string) =>
      (
        await app.inject({ method: 'GET', url: `/api/applications/${id}/readiness`, headers: { cookie: org.cookie } })
      ).json() as { analysisOutdated: boolean };

    const stale = await insertApplication(db, org.organizationId, {
      detectedMetadata: { ...ENV_SETUP_METADATA, analysisVersion: ANALYSIS_VERSION - 1 },
      analysisStatus: 'COMPLETE',
    });
    const current = await insertApplication(db, org.organizationId, {
      detectedMetadata: { ...ENV_SETUP_METADATA, analysisVersion: ANALYSIS_VERSION },
      analysisStatus: 'COMPLETE',
    });
    const incomplete = await insertApplication(db, org.organizationId, { detectedMetadata: ENV_SETUP_METADATA });

    expect((await readiness(stale.id)).analysisOutdated).toBe(true);
    expect((await readiness(current.id)).analysisOutdated).toBe(false);
    expect((await readiness(incomplete.id)).analysisOutdated).toBe(false);
  });
});

// ── §36/§37: PATCH and DELETE /api/applications/:id ─────────────────────────
describe('server — PATCH/DELETE /api/applications/:id (§36,§37)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'patch-delete@example.com');
    app = await buildServer({ auth, db });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('PATCH updates a field and returns 200 with the new value', async () => {
    const application = await insertApplication(db, org.organizationId);
    const response = await sendJson(app, 'PATCH', `/api/applications/${application.id}`, { name: 'New Name' }, { cookie: org.cookie });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { name: string }).name).toBe('New Name');
  });

  it('PATCH with empty name returns 400 VALIDATION_ERROR', async () => {
    const application = await insertApplication(db, org.organizationId);
    const response = await sendJson(app, 'PATCH', `/api/applications/${application.id}`, { name: '' }, { cookie: org.cookie });
    expect(response.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('PATCH with empty body returns 200 with unchanged row', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Original Name' });
    const response = await sendJson(app, 'PATCH', `/api/applications/${application.id}`, {}, { cookie: org.cookie });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { name: string }).name).toBe('Original Name');
  });

  it('PATCH with healthPath: null clears the field', async () => {
    const application = await insertApplication(db, org.organizationId, { healthPath: '/health' });
    const response = await sendJson(app, 'PATCH', `/api/applications/${application.id}`, { healthPath: null }, { cookie: org.cookie });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { healthPath: string | null }).healthPath).toBeNull();
  });

  it('PATCH with databaseRequired: null resets the column to the default when nothing was detected', async () => {
    const application = await insertApplication(db, org.organizationId, { databaseRequired: true });
    const response = await sendJson(app, 'PATCH', `/api/applications/${application.id}`, { databaseRequired: null }, { cookie: org.cookie });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { databaseRequired: boolean }).databaseRequired).toBe(false);
  });

  it('PATCH with identity-locked field silently ignores it', async () => {
    const application = await insertApplication(db, org.organizationId, { repoFullName: 'acme/test-app' });
    const response = await sendJson(app, 'PATCH', `/api/applications/${application.id}`, { repoFullName: 'evil/repo' }, { cookie: org.cookie });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { repoFullName: string }).repoFullName).toBe('acme/test-app');
  });

  it('PATCH with non-uuid id returns 404 NOT_FOUND', async () => {
    const response = await sendJson(app, 'PATCH', '/api/applications/not-a-uuid', { name: 'test' }, { cookie: org.cookie });
    expect(response.statusCode).toBe(404);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
  });

  it('PATCH records a changed contract field as a vendor override', async () => {
    const application = await insertApplication(db, org.organizationId, { containerPort: 3000 });
    const response = await sendJson(app, 'PATCH', `/api/applications/${application.id}`, { containerPort: 8080 }, { cookie: org.cookie });
    expect(response.statusCode).toBe(200);
    const metadata = (response.json() as { detectedMetadata: { vendorOverrides?: string[] } }).detectedMetadata;
    expect(metadata.vendorOverrides).toEqual(['containerPort']);
  });

  it('PATCH does not claim a contract field the vendor re-submitted unchanged', async () => {
    const application = await insertApplication(db, org.organizationId, {
      containerPort: 3000,
      healthPath: '/health',
      detectedMetadata: { vendorOverrides: [] },
    });
    const response = await sendJson(app, 'PATCH', `/api/applications/${application.id}`, { containerPort: 3000, healthPath: '/live' }, { cookie: org.cookie });
    expect(response.statusCode).toBe(200);
    const metadata = (response.json() as { detectedMetadata: { vendorOverrides?: string[] } }).detectedMetadata;
    expect(metadata.vendorOverrides).toEqual(['healthPath']);
  });

  it('PATCH on a legacy row keeps its other saved values vendor-owned', async () => {
    const application = await insertApplication(db, org.organizationId, {
      containerPort: 3000,
      migrationCommand: 'npm run migrate',
      workerCommand: 'node worker.js',
    });
    const response = await sendJson(app, 'PATCH', `/api/applications/${application.id}`, { healthPath: '/live' }, { cookie: org.cookie });
    expect(response.statusCode).toBe(200);
    const metadata = (response.json() as { detectedMetadata: { vendorOverrides?: string[] } }).detectedMetadata;
    expect([...metadata.vendorOverrides!].sort()).toEqual(['containerPort', 'healthPath', 'migrationCommand', 'workerCommand']);
  });

  it('concurrent PATCHes of different fields both keep their override', async () => {
    const application = await insertApplication(db, org.organizationId, { detectedMetadata: { vendorOverrides: [] } });
    const responses = await Promise.all([
      sendJson(app, 'PATCH', `/api/applications/${application.id}`, { containerPort: 8080 }, { cookie: org.cookie }),
      sendJson(app, 'PATCH', `/api/applications/${application.id}`, { healthPath: '/live' }, { cookie: org.cookie }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    const [row] = await db.select().from(schema.applications).where(eq(schema.applications.id, application.id));
    expect([...(row!.detectedMetadata as { vendorOverrides: string[] }).vendorOverrides].sort()).toEqual(['containerPort', 'healthPath']);
  });

  it('PATCH keeps the analysis findings on detectedMetadata when claiming a field', async () => {
    const application = await insertApplication(db, org.organizationId, {
      containerPort: 3000,
      detectedMetadata: { checks: { ready: [{ label: 'Dockerfile found' }] } },
    });
    const response = await sendJson(app, 'PATCH', `/api/applications/${application.id}`, { containerPort: 8080 }, { cookie: org.cookie });
    expect(response.statusCode).toBe(200);
    const metadata = (response.json() as { detectedMetadata: Record<string, unknown> }).detectedMetadata;
    expect(metadata['checks']).toEqual({ ready: [{ label: 'Dockerfile found' }] });
  });

  it('PATCH sets updatedBy to the session user id', async () => {
    const application = await insertApplication(db, org.organizationId);
    const response = await sendJson(app, 'PATCH', `/api/applications/${application.id}`, { name: 'Updated' }, { cookie: org.cookie });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { updatedBy: string | null }).updatedBy).toBe(org.userId);
  });

  it('PATCH with null removes the field from vendorOverrides', async () => {
    const application = await insertApplication(db, org.organizationId, {
      containerPort: 3000,
      healthPath: '/health',
      detectedMetadata: { vendorOverrides: ['containerPort', 'healthPath'] },
    });
    // Set containerPort to null — the field is released from vendor ownership.
    let response = await sendJson(
      app, 'PATCH', `/api/applications/${application.id}`,
      { containerPort: null }, { cookie: org.cookie },
    );
    expect(response.statusCode).toBe(200);
    let metadata = (response.json() as { detectedMetadata: { vendorOverrides?: string[] } }).detectedMetadata;
    expect(metadata.vendorOverrides).toEqual(['healthPath']);
    // Set healthPath to null — released too.
    response = await sendJson(
      app, 'PATCH', `/api/applications/${application.id}`,
      { healthPath: null }, { cookie: org.cookie },
    );
    expect(response.statusCode).toBe(200);
    metadata = (response.json() as { detectedMetadata: { vendorOverrides?: string[] } }).detectedMetadata;
    expect(metadata.vendorOverrides).toEqual([]);
    // An absent field does not touch vendorOverrides.
    response = await sendJson(
      app, 'PATCH', `/api/applications/${application.id}`,
      { name: 'Still Auto' }, { cookie: org.cookie },
    );
    expect(response.statusCode).toBe(200);
    metadata = (response.json() as { detectedMetadata: { vendorOverrides?: string[] } }).detectedMetadata;
    expect(metadata.vendorOverrides).toEqual([]);
    // A non-null value claims the field normally.
    response = await sendJson(
      app, 'PATCH', `/api/applications/${application.id}`,
      { containerPort: 8080 }, { cookie: org.cookie },
    );
    expect(response.statusCode).toBe(200);
    metadata = (response.json() as { detectedMetadata: { vendorOverrides?: string[] } }).detectedMetadata;
    expect(metadata.vendorOverrides).toEqual(['containerPort']);
    // Column value is null after release.
    expect((response.json() as { containerPort: number | null }).containerPort).toBe(8080);
  });

  it('DELETE removes the application and logs an event', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'To Delete' });
    const response = await app.inject({ method: 'DELETE', url: `/api/applications/${application.id}`, headers: { cookie: org.cookie } });
    expect(response.statusCode).toBe(204);

    const rows = await db.select().from(schema.applications).where(eq(schema.applications.id, application.id));
    expect(rows).toHaveLength(0);

    const events = await db.select().from(schema.eventLogs).where(eq(schema.eventLogs.eventType, 'APPLICATION_DELETED'));
    expect(events.length).toBeGreaterThanOrEqual(1);
    const deleteEvent = events[events.length - 1]!;
    expect((deleteEvent.payload as { applicationName?: string }).applicationName).toBe('To Delete');
  });

  it('DELETE with a deployment returns 409 APPLICATION_HAS_DEPLOYMENTS', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    await insertDeployment(db, org.organizationId, application.id, customer.id);

    const response = await app.inject({ method: 'DELETE', url: `/api/applications/${application.id}`, headers: { cookie: org.cookie } });
    expect(response.statusCode).toBe(409);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('APPLICATION_HAS_DEPLOYMENTS');

    const rows = await db.select().from(schema.applications).where(eq(schema.applications.id, application.id));
    expect(rows).toHaveLength(1);
  });

  it('DELETE cascades releases when there are no deployments', async () => {
    const application = await insertApplication(db, org.organizationId);
    await insertRelease(db, application.id);

    const response = await app.inject({ method: 'DELETE', url: `/api/applications/${application.id}`, headers: { cookie: org.cookie } });
    expect(response.statusCode).toBe(204);

    const releases = await db.select().from(schema.releases).where(eq(schema.releases.applicationId, application.id));
    expect(releases).toHaveLength(0);
  });

  it('DELETE is idempotent — second call returns 404', async () => {
    const application = await insertApplication(db, org.organizationId);
    const first = await app.inject({ method: 'DELETE', url: `/api/applications/${application.id}`, headers: { cookie: org.cookie } });
    expect(first.statusCode).toBe(204);

    const second = await app.inject({ method: 'DELETE', url: `/api/applications/${application.id}`, headers: { cookie: org.cookie } });
    expect(second.statusCode).toBe(404);
    expect(errorEnvelopeSchema.parse(second.json()).error.code).toBe('NOT_FOUND');
  });

  it('DELETE with non-uuid id returns 404 NOT_FOUND', async () => {
    const response = await app.inject({ method: 'DELETE', url: '/api/applications/not-a-uuid', headers: { cookie: org.cookie } });
    expect(response.statusCode).toBe(404);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
  });
});

// ── §31: job-payload redaction at claim time ───────────────────────────────
describe('redactClaimedPayload', () => {
  it('scrubs CONFIG_UPDATE secret values down to key stubs', () => {
    const redacted = redactClaimedPayload({
      type: 'CONFIG_UPDATE',
      payload: {
        changedKeys: ['API_KEY', 'DATABASE_URL'],
        secrets: [
          { key: 'API_KEY', value: 'plain-1' },
          { key: 'DATABASE_URL', value: 'plain-2' },
        ],
        removedKeys: ['OLD_KEY'],
      },
    });
    expect(JSON.stringify(redacted)).not.toContain('plain-1');
    expect(JSON.stringify(redacted)).not.toContain('plain-2');
    expect(redacted).toEqual({
      changedKeys: ['API_KEY', 'DATABASE_URL'],
      secrets: [{ key: 'API_KEY' }, { key: 'DATABASE_URL' }],
      removedKeys: ['OLD_KEY'],
    });
  });

  it('masks generated secret parameters from INSTALL payloads and keeps plain ones', () => {
    const redacted = redactClaimedPayload({
      type: 'INSTALL',
      payload: {
        parameters: {
          [APP_API_KEY_PARAMETER]: 'gen-secret-a',
          [APP_SIGNING_SECRET_PARAMETER]: 'gen-secret-b',
          [IMAGE_REFERENCE_PARAMETER]: 'registry@sha256:abc',
          [DESIRED_COUNT_PARAMETER]: '0',
        },
      },
    });
    expect(JSON.stringify(redacted)).not.toContain('gen-secret-a');
    expect(JSON.stringify(redacted)).not.toContain('gen-secret-b');
    expect((redacted as { parameters: Record<string, string> }).parameters).toEqual({
      [APP_API_KEY_PARAMETER]: '***',
      [APP_SIGNING_SECRET_PARAMETER]: '***',
      [IMAGE_REFERENCE_PARAMETER]: 'registry@sha256:abc',
      [DESIRED_COUNT_PARAMETER]: '0',
    });
  });

  it('leaves payloads without secrets untouched', () => {
    const payload = { releaseId: 'rel-1', imageDigest: 'sha256:abc' };
    expect(redactClaimedPayload({ type: 'DEPLOY_RELEASE', payload })).toEqual(payload);
    expect(redactClaimedPayload({ type: 'CONFIG_UPDATE', payload: { changedKeys: ['LOG_LEVEL'] } })).toEqual({
      changedKeys: ['LOG_LEVEL'],
    });
  });
});

// ── §3/§4/§6: relay bearer auth, INSTALL job creation, command/result/health ─
describe('server — relay bearer auth, INSTALL job, and command/result/health flow (§3,§4,§6)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };
  let deployment: typeof schema.deployments.$inferSelect;
  const RELAY_TOKEN = 'relay-token-abc123';
  // The id the RELAY mints for itself inside the customer's account. The
  // control plane learns it at enrollment and never before.
  const RELAY_INSTALLATION_ID = 'inst-minted-in-customer-account';

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'relay-org@example.com');
    app = await buildServer({ auth, db });

    const application = await insertApplication(db, org.organizationId);
    await insertDeployableRelease(db, application.id);
    const customer = await insertCustomer(db, org.organizationId);
    deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'NOT_INSTALLED',
      // Unbound: no relay has enrolled yet, which is the real shape of a
      // deployment a vendor has just created.
      installationId: null,
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('POST /api/relay/register without a bearer token is rejected', async () => {
    const response = await postJson(app, '/api/relay/register', {
      enrollmentCode: deployment.enrollmentCode,
      installationId: RELAY_INSTALLATION_ID,
    });
    expect(response.statusCode).toBe(401);
  });

  it('POST /api/relay/register 404s for an enrollment code with no matching deployment', async () => {
    const response = await postJson(
      app,
      '/api/relay/register',
      { enrollmentCode: 'not-a-real-code', installationId: RELAY_INSTALLATION_ID },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(response.statusCode).toBe(404);
  });

  it('binds the relay, creates the INSTALL job, and moves the deployment to INSTALLING (§6)', async () => {
    const response = await postJson(
      app,
      '/api/relay/register',
      {
        enrollmentCode: deployment.enrollmentCode,
        installationId: RELAY_INSTALLATION_ID,
        awsAccountId: '123456789012',
      },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(response.statusCode).toBe(200);

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(dep!.state).toBe('INSTALLING');
    // The binding, the relay's self-minted id and the customer's account id
    // are all learned here — none of them were knowable before this call.
    expect(dep!.installationId).toBe(RELAY_INSTALLATION_ID);
    expect(dep!.relayTokenHash).not.toBeNull();
    expect(dep!.enrollmentUsedAt).not.toBeNull();
    expect(dep!.awsAccountId).toBe('123456789012');

    const jobs = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.type).toBe('INSTALL');
    expect(jobs[0]!.state).toBe('REQUESTED');

    // The first successful enrollment emits exactly one relay.connected, in
    // the register transaction, keyed by the deploymentId column.
    const connected = await db
      .select()
      .from(schema.eventLogs)
      .where(and(eq(schema.eventLogs.eventType, 'relay.connected'), eq(schema.eventLogs.deploymentId, deployment.id)));
    expect(connected).toHaveLength(1);
    expect(connected[0]!.payload).toMatchObject({ schemaVersion: 1 });
    expect(connected[0]!.actorType).toBe('relay');
    expect(connected[0]!.actorId).toBe(RELAY_INSTALLATION_ID);
  });

  it('a replay from the same relay is idempotent and creates no second INSTALL job', async () => {
    const response = await postJson(
      app,
      '/api/relay/register',
      { enrollmentCode: deployment.enrollmentCode, installationId: RELAY_INSTALLATION_ID },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(response.statusCode).toBe(200);
    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(and(eq(schema.deploymentJobs.deploymentId, deployment.id), eq(schema.deploymentJobs.type, 'INSTALL')));
    expect(jobs).toHaveLength(1);

    // The replay is a same-relay early-return that never reaches the register
    // transaction, so relay.connected stays at exactly one row.
    const connected = await db
      .select()
      .from(schema.eventLogs)
      .where(and(eq(schema.eventLogs.eventType, 'relay.connected'), eq(schema.eventLogs.deploymentId, deployment.id)));
    expect(connected).toHaveLength(1);
  });

  // The takeover this replaced: registration used to bind whatever token the
  // caller supplied, checking only that the installation id existed — and
  // that id travelled in the customer's install URL. Anyone holding the link
  // could rebind the deployment to a token of their own, lock the real relay
  // out, read its job payloads, and drive the deployment's state into and out
  // of the states that start and stop billing.
  it('refuses a second relay with a different token, and leaves the first one working', async () => {
    const takeover = await postJson(
      app,
      '/api/relay/register',
      { enrollmentCode: deployment.enrollmentCode, installationId: 'inst-attacker' },
      { authorization: 'Bearer attacker-chosen-token' },
    );
    expect(takeover.statusCode).toBe(409);
    expect(takeover.json()).toMatchObject({ error: { code: 'RELAY_ALREADY_ENROLLED' } });

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(dep!.installationId).toBe(RELAY_INSTALLATION_ID);

    // Health, not the command poll: polling would consume the pending INSTALL
    // job that the next test asserts on, and authenticating is the point here.
    const stillWorks = await postJson(
      app,
      '/api/relay/health',
      { installationId: RELAY_INSTALLATION_ID },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(stillWorks.statusCode).toBe(200);
  });

  it('records a rejected enrollment as an event the vendor can see', async () => {
    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.deploymentId, deployment.id));
    expect(events.some((row) => row.eventType === 'install.enrollment.rejected')).toBe(true);
  });

  it('GET /api/relay/commands rejects a wrong bearer token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/relay/commands?installationId=${RELAY_INSTALLATION_ID}`,
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns the pending INSTALL command and moves it to RUNNING', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/relay/commands?installationId=${RELAY_INSTALLATION_ID}`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { commands: Array<{ id: string; type: string; deploymentId: string }> };
    expect(body.commands).toHaveLength(1);
    expect(body.commands[0]!.type).toBe('INSTALL');
    expect(body.commands[0]!.deploymentId).toBe(deployment.id);

    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, body.commands[0]!.id));
    expect(job!.state).toBe('RUNNING');
    expect(job!.startedAt).not.toBeNull();
  });

  it('a second poll returns no commands (the job already left REQUESTED/QUEUED)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/relay/commands?installationId=${RELAY_INSTALLATION_ID}`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
    });
    expect((response.json() as { commands: unknown[] }).commands).toHaveLength(0);
  });

  it('omits both databaseRequired and redisRequired from the deployment meta when the stored manifest is missing (never a guessed default)', async () => {
    // A pre-Phase-2 deployment can be bound and reporting without ever
    // having a stored manifest — the register route now requires one for a
    // NEW install, but this simulates a relay that already connected before
    // that gate existed. probeUrl still reports (it does not depend on the
    // manifest); the two requirement flags travel together or not at all.
    const token = 'relay-token-no-manifest';
    const installationId = 'inst-no-manifest';
    await insertDeployment(db, org.organizationId, deployment.applicationId, deployment.customerId, {
      state: 'HEALTHY',
      installationId,
      enrollmentCode: crypto.randomUUID(),
      enrollmentUsedAt: new Date(),
      relayTokenHash: hashRelayToken(token),
      relayStatus: 'CONNECTED',
      desiredState: {},
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/relay/commands?installationId=${installationId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { deployment: Record<string, unknown> };
    expect(body.deployment).not.toHaveProperty('databaseRequired');
    expect(body.deployment).not.toHaveProperty('redisRequired');
    expect(body.deployment).toHaveProperty('probeUrl');
  });

  it('serves a secret-bearing CONFIG_UPDATE payload once, then scrubs the stored row (§1.2)', async () => {
    // An idle deployment of its own: the INSTALL above is still RUNNING, and
    // no service mutation is handed out alongside a running one.
    const token = 'relay-token-config-redaction';
    const installationId = 'inst-config-redaction';
    const idle = await insertDeployment(db, org.organizationId, deployment.applicationId, deployment.customerId, {
      state: 'HEALTHY',
      installationId,
      enrollmentCode: crypto.randomUUID(),
      enrollmentUsedAt: new Date(),
      relayTokenHash: hashRelayToken(token),
      relayStatus: 'CONNECTED',
    });
    const secretValue = 'plaintext-rides-the-claim-once';
    const [job] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: idle.id,
        type: 'CONFIG_UPDATE',
        state: 'REQUESTED',
        idempotencyKey: `${idle.id}:CONFIG_UPDATE:secret-redaction`,
        payload: {
          changedKeys: ['API_KEY'],
          secrets: [{ key: 'API_KEY', value: secretValue }],
        },
      })
      .returning();

    const response = await app.inject({
      method: 'GET',
      url: `/api/relay/commands?installationId=${installationId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      commands: Array<{ id: string; type: string; payload: { secrets: { key: string; value: string }[] } }>;
    };
    const claimed = body.commands.find((command) => command.id === job!.id);
    // The relay receives the value exactly once, at claim time.
    expect(claimed).toBeDefined();
    expect(claimed!.payload.secrets).toEqual([{ key: 'API_KEY', value: secretValue }]);

    // The stored row is scrubbed in the same request: keys only, no value.
    const [updated] = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.id, job!.id));
    expect(updated!.state).toBe('RUNNING');
    expect(updated!.payload).toEqual({
      changedKeys: ['API_KEY'],
      secrets: [{ key: 'API_KEY' }],
    });
    expect(JSON.stringify(updated!.payload)).not.toContain(secretValue);
  });

  it('POST /api/relay/commands/:id/result rejects a wrong bearer token', async () => {
    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    const response = await postJson(app, `/api/relay/commands/${job!.id}/result`, { success: true }, { authorization: 'Bearer wrong-token' });
    expect(response.statusCode).toBe(401);
  });

  it('success:true marks the job SUCCEEDED and stores the result/finishedAt', async () => {
    const [job] = await db
      .select()
      .from(schema.deploymentJobs)
      .where(and(eq(schema.deploymentJobs.deploymentId, deployment.id), eq(schema.deploymentJobs.type, 'INSTALL')));
    const response = await postJson(
      app,
      `/api/relay/commands/${job!.id}/result`,
      { success: true, output: { foo: 'bar' } },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(response.statusCode).toBe(200);

    const [updated] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, job!.id));
    expect(updated!.state).toBe('SUCCEEDED');
    expect(updated!.finishedAt).not.toBeNull();
    expect(updated!.result).toMatchObject({ success: true, output: { foo: 'bar' } });
  });

  it('success:false with a valid failureCode marks the job FAILED with that code', async () => {
    // The INSTALL success above auto-queued a deploy of the READY release;
    // clear it so the job below is the deployment's only active mutation.
    await db
      .update(schema.deploymentJobs)
      .set({ state: 'CANCELLED' })
      .where(and(eq(schema.deploymentJobs.deploymentId, deployment.id), eq(schema.deploymentJobs.type, 'DEPLOY_RELEASE')));
    const [freshJob] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: deployment.id,
        type: 'DEPLOY_RELEASE',
        state: 'RUNNING',
        idempotencyKey: `${deployment.id}:DEPLOY_RELEASE:test-fail`,
        payload: {},
      })
      .returning();

    const response = await postJson(
      app,
      `/api/relay/commands/${freshJob!.id}/result`,
      { success: false, error: 'boom', failureCode: 'IMAGE_PULL_FAILED' },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(response.statusCode).toBe(200);

    const [updated] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, freshJob!.id));
    expect(updated!.state).toBe('FAILED');
    expect(updated!.failureCode).toBe('IMAGE_PULL_FAILED');
  });

  it('an invalid failureCode is dropped rather than persisted', async () => {
    const [freshJob] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: deployment.id,
        type: 'DEPLOY_RELEASE',
        state: 'RUNNING',
        idempotencyKey: `${deployment.id}:DEPLOY_RELEASE:test-fail-2`,
        payload: {},
      })
      .returning();

    await postJson(
      app,
      `/api/relay/commands/${freshJob!.id}/result`,
      { success: false, failureCode: 'NOT_A_REAL_CODE' },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );

    const [updated] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, freshJob!.id));
    expect(updated!.state).toBe('FAILED');
    expect(updated!.failureCode).toBeNull();
  });

  // §46: the relay reporting a finished INSTALL no longer marks the fleet
  // HEALTHY — CloudFormation completing is not the application running. The
  // deployment stays INSTALLING until the relay's runtime health verification
  // reports HEALTHY; only then is a "healthy" state honest.
  it('a successful INSTALL alone keeps the deployment INSTALLING; a healthy heartbeat then moves it to HEALTHY', async () => {
    // Fresh deployment for this lifecycle — the earlier tests in this block
    // have already moved the shared fixture to FAILED.
    const token = 'relay-install-honest-token';
    const installationId = 'inst-install-honest';
    const fresh = await insertDeployment(db, org.organizationId, deployment.applicationId, deployment.customerId);

    await postJson(
      app,
      '/api/relay/register',
      { enrollmentCode: fresh.enrollmentCode, installationId },
      { authorization: `Bearer ${token}` },
    );

    const [installJob] = await db
      .select()
      .from(schema.deploymentJobs)
      .where(and(eq(schema.deploymentJobs.deploymentId, fresh.id), eq(schema.deploymentJobs.type, 'INSTALL')));

    await db
      .update(schema.deploymentJobs)
      .set({ state: 'RUNNING', startedAt: new Date() })
      .where(eq(schema.deploymentJobs.id, installJob!.id));
    await postJson(
      app,
      `/api/relay/commands/${installJob!.id}/result`,
      { success: true },
      { authorization: `Bearer ${token}` },
    );

    const [afterInstall] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, fresh.id));
    expect(afterInstall!.state).toBe('INSTALLING');

    await postJson(
      app,
      '/api/relay/health',
      {
        installationId,
        healthStatus: 'HEALTHY',
        observedState: { releaseEvidence: healthyReleaseEvidence(fresh, 'sha256:' + '1'.repeat(64)) },
      },
      { authorization: `Bearer ${token}` },
    );

    const [afterHealth] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, fresh.id));
    expect(afterHealth!.state).toBe('HEALTHY');
  });

  it('a successful DEPLOY_RELEASE moves to HEALTHY but the pointer only advances once the HTTP probe gate passes (§10.3)', async () => {
    // A dedicated deployment for this lifecycle — the shared fixture above has
    // jobs left over from earlier relay-flow tests that would block the
    // heartbeat's promotion.
    const token = 'relay-promotion-gate-token';
    const installationId = 'inst-promotion-gate';
    const fresh = await insertDeployment(db, org.organizationId, deployment.applicationId, deployment.customerId, {
      state: 'HEALTHY',
      installationId,
      enrollmentCode: crypto.randomUUID(),
      enrollmentUsedAt: new Date(),
      relayTokenHash: hashRelayToken(token),
      relayStatus: 'CONNECTED',
    });

    const digest = 'sha256:' + 'e'.repeat(64);
    const release = await insertRelease(db, deployment.applicationId, {
      imageDigest: `acme/app@${digest}`,
      releaseStatus: 'READY',
    });
    const [job] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: fresh.id,
        type: 'DEPLOY_RELEASE',
        state: 'RUNNING',
        idempotencyKey: `${fresh.id}:DEPLOY_RELEASE:${release.id}`,
        payload: { releaseId: release.id },
      })
      .returning();

    // The relay settled the rollout, so the job succeeds and the deployment
    // becomes UPDATE_AVAILABLE (a READY release exists that hasn't been
    // promoted yet) — but the release pointers must NOT advance on the job
    // result alone: a healthy HTTP probe has not been observed yet.
    await postJson(
      app,
      `/api/relay/commands/${job!.id}/result`,
      { success: true },
      { authorization: `Bearer ${token}` },
    );

    const [afterResult] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, fresh.id));
    expect(afterResult!.state).toBe('UPDATE_AVAILABLE');
    expect(afterResult!.currentReleaseId).toBeNull();

    // The next heartbeat observes the digest actually running, a completed
    // rollout, full counts, healthy targets AND a successful HTTP probe —
    // only then does the pointer advance.
    await postJson(
      app,
      '/api/relay/health',
      {
        installationId,
        healthStatus: 'HEALTHY',
        runningImageDigest: digest,
        observedState: {
          releaseEvidence: healthyReleaseEvidence(fresh, digest),
          httpProbe: {
            ok: true,
            statusCode: 200,
            latencyMs: 12,
            checkedAt: new Date().toISOString(),
          },
        },
      },
      { authorization: `Bearer ${token}` },
    );

    const [updated] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, fresh.id));
    expect(updated!.currentReleaseId).toBe(release.id);
    expect(updated!.previousReleaseId).toBeNull();
    // Promotion resolved UPDATE_AVAILABLE → HEALTHY: the promoted release is
    // the newest READY one, so no update remains available.
    expect(updated!.state).toBe('HEALTHY');
  });

  it('promoting the newest release resolves UPDATE_AVAILABLE even when created_at has microseconds', async () => {
    // Production Postgres keeps microseconds; a JS Date keeps milliseconds.
    // The newest release must not count as newer than itself.
    const token = 'relay-microsecond-token';
    const installationId = 'inst-microsecond';
    const application = await insertApplication(db, org.organizationId);
    const fresh = await insertDeployment(db, org.organizationId, application.id, deployment.customerId, {
      state: 'INSTALLING',
      installationId,
      enrollmentCode: crypto.randomUUID(),
      enrollmentUsedAt: new Date(),
      relayTokenHash: hashRelayToken(token),
      relayStatus: 'CONNECTED',
    });
    const digest = 'sha256:' + '9'.repeat(64);
    const release = await insertRelease(db, application.id, {
      imageDigest: `acme/app@${digest}`,
      releaseStatus: 'READY',
    });
    await db
      .update(schema.releases)
      .set({ createdAt: sql`'2026-09-23T09:43:56.141234Z'::timestamptz` })
      .where(eq(schema.releases.id, release.id));
    const [job] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: fresh.id,
        type: 'DEPLOY_RELEASE',
        state: 'RUNNING',
        idempotencyKey: `${fresh.id}:DEPLOY_RELEASE:${release.id}`,
        payload: { releaseId: release.id },
      })
      .returning();

    await postJson(app, `/api/relay/commands/${job!.id}/result`, { success: true }, { authorization: `Bearer ${token}` });
    await postJson(
      app,
      '/api/relay/health',
      {
        installationId,
        healthStatus: 'HEALTHY',
        runningImageDigest: digest,
        observedState: {
          releaseEvidence: healthyReleaseEvidence(fresh, digest),
          httpProbe: { ok: true, statusCode: 200, latencyMs: 12, checkedAt: new Date().toISOString() },
        },
      },
      { authorization: `Bearer ${token}` },
    );

    const [updated] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, fresh.id));
    expect(updated!.currentReleaseId).toBe(release.id);
    expect(updated!.state).toBe('HEALTHY');
  });

  it('a failed update keeps the deployment live and diagnostics still classify it', async () => {
    // A dedicated deployment with a running release — the shape a failed
    // day-2 operation actually happens in.
    const token = 'relay-failed-update-token';
    const current = await insertRelease(db, deployment.applicationId, {
      imageDigest: 'acme/app@sha256:' + 'f'.repeat(64),
      releaseStatus: 'READY',
    });
    const fresh = await insertDeployment(db, org.organizationId, deployment.applicationId, deployment.customerId, {
      state: 'HEALTHY',
      currentReleaseId: current.id,
      installationId: 'inst-failed-update',
      enrollmentCode: crypto.randomUUID(),
      enrollmentUsedAt: new Date(),
      relayTokenHash: hashRelayToken(token),
      relayStatus: 'CONNECTED',
    });

    const [job] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: fresh.id,
        type: 'DEPLOY_RELEASE',
        state: 'RUNNING',
        idempotencyKey: `${fresh.id}:DEPLOY_RELEASE:state-fail`,
        payload: {},
      })
      .returning();

    await postJson(
      app,
      `/api/relay/commands/${job!.id}/result`,
      { success: false, failureCode: 'ECS_DEPLOYMENT_FAILED' },
      { authorization: `Bearer ${token}` },
    );

    // The previous release is still serving: a failed day-2 operation must
    // not mark the whole deployment FAILED, and the pointer never advances.
    // No newer READY release exists here, so HEALTHY.
    const [updated] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, fresh.id));
    expect(updated!.state).toBe('HEALTHY');
    expect(updated!.currentReleaseId).toBe(current.id);

    // §61: diagnostics must still report the code the relay gave — the gate
    // follows the latest mutating attempt, not only deployment.state.
    const diagnostics = await app.inject({
      method: 'GET',
      url: `/api/deployments/${fresh.id}/diagnostics`,
      headers: { cookie: org.cookie },
    });
    expect(diagnostics.statusCode).toBe(200);
    expect(diagnostics.json()).toMatchObject({ failureCode: 'ECS_DEPLOYMENT_FAILED', source: 'deterministic', confidence: null });
  });

  it('diagnostics classify an install that never verified, and deploy again stays allowed', async () => {
    const fresh = await insertDeployment(db, org.organizationId, deployment.applicationId, deployment.customerId, {
      state: 'FAILED',
      installationId: 'inst-unverified',
      enrollmentCode: crypto.randomUUID(),
      enrollmentUsedAt: new Date(),
      relayTokenHash: hashRelayToken('relay-unverified-token'),
      relayStatus: 'CONNECTED',
    });
    await db.insert(schema.deploymentJobs).values({
      deploymentId: fresh.id,
      type: 'INSTALL',
      state: 'SUCCEEDED',
      idempotencyKey: `${fresh.id}:INSTALL`,
      finishedAt: new Date(),
      result: { installVerification: { failureCode: 'CONTAINER_START_FAILED', reason: 'TASKS_INSUFFICIENT' } },
    });

    const diagnostics = await app.inject({
      method: 'GET',
      url: `/api/deployments/${fresh.id}/diagnostics`,
      headers: { cookie: org.cookie },
    });
    expect(diagnostics.statusCode).toBe(200);
    expect(diagnostics.json()).toMatchObject({ failureCode: 'CONTAINER_START_FAILED', recoverability: 'USER_ACTION' });

    const retry = await app.inject({
      method: 'POST',
      url: `/api/deployments/${fresh.id}/deploy`,
      headers: { cookie: org.cookie },
      payload: {},
    });
    expect(retry.statusCode).not.toBe(409);
  });

  // §22/§23/§42: codes outside the AI-explained set bypass AI entirely — the
  // deterministic §65 copy map is authoritative and the gateway must never
  // be invoked.
  it('a failure code outside the AI-explained set returns remediation copy directly, without calling the AI gateway', async () => {
    let calls = 0;
    const countingApp = await buildServer({
      auth,
      db,
      aiGateway: {
        async generate() {
          calls += 1;
          throw new Error('AI gateway must not be called for a code outside the AI-explained set');
        },
      },
    });
    // ECS_DEPLOYMENT_FAILED is outside AI_EXPLAINABLE_FAILURE_CODES on
    // purpose: it was just served deterministically by the test above, so
    // the two stay in sync with the gate.
    // A dedicated deployment keeps the latest-failed-job pick hermetic: the
    // shared deployment accumulates FAILED jobs from earlier flow tests with
    // real timestamps, which outrank this test's deliberately-past jobs.
    const isolated = await insertDeployment(db, org.organizationId, deployment.applicationId, deployment.customerId, {
      state: 'FAILED',
      installationId: 'inst-outside-ai-set',
      enrollmentCode: crypto.randomUUID(),
      enrollmentUsedAt: new Date(),
      relayTokenHash: hashRelayToken('relay-outside-ai-set-token'),
      relayStatus: 'CONNECTED',
    });
    for (const [index, code] of (['AWS_PERMISSION_DENIED', 'ECS_DEPLOYMENT_FAILED'] as const).entries()) {
      await db.insert(schema.deploymentJobs).values({
        deploymentId: isolated.id,
        type: 'DEPLOY_RELEASE',
        state: 'FAILED',
        failureCode: code,
        finishedAt: new Date(Date.now() - (2 - index) * 1000),
        idempotencyKey: `${isolated.id}:DEPLOY_RELEASE:deterministic-${index}`,
        payload: {},
      });
    }
    await db
      .update(schema.deployments)
      .set({ state: 'FAILED' })
      .where(eq(schema.deployments.id, isolated.id));

    const response = await countingApp.inject({
      method: 'GET',
      url: `/api/deployments/${isolated.id}/diagnostics`,
      headers: { cookie: org.cookie },
    });

    const body = response.json() as { failureCode: string; source: string; confidence: string | null; what: string; fix: string };
    expect(body.failureCode).toBe('ECS_DEPLOYMENT_FAILED');
    expect(body.source).toBe('deterministic');
    expect(body.confidence).toBeNull();
    // Code-specific guidance, not the old one-size-fits-all placeholder.
    expect(body.what).toContain('rolled out');
    expect(body.what).not.toBe('Deployment failed');
    expect(body.fix.length).toBeGreaterThan(0);
    expect(calls).toBe(0);
    await countingApp.close();
  });

  // §16/§23: an UNKNOWN failure code is the one path that calls AI, and the
  // only evidence it may see is the redacted, normalized job error — never
  // the raw text (ANSI codes, secrets) the relay reported.
  it('explains an UNKNOWN failure with AI text, sending only redacted evidence in the prompt', async () => {
    // Built from a char code rather than an embedded literal control byte, so
    // the source has no raw control character (matches redact.ts's own style).
    const ansiEsc = String.fromCharCode(27);
    let capturedPrompt = '';
    const aiApp = await buildServer({
      auth,
      db,
      aiGateway: {
        async generate(prompt) {
          capturedPrompt = prompt;
          return {
            object: {
              failureCode: 'UNKNOWN',
              what: 'The app failed for a reason the classifier could not identify.',
              why: 'The deploy reported an error that did not match a known failure pattern.',
              fix: 'Check the logs and contact support if this keeps happening.',
              confidence: 'low',
            },
            usage: { promptTokens: 20, completionTokens: 10 },
          };
        },
      },
    });
    // Set the failure state directly so the test does not depend on which
    // other tests in this file have already run.
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'DEPLOY_RELEASE',
      state: 'FAILED',
      failureCode: null,
      result: { error: `boom ${ansiEsc}[31mERR${ansiEsc}[0m postgresql://u:p@h/db` },
      finishedAt: new Date(),
      idempotencyKey: `${deployment.id}:DEPLOY_RELEASE:ai-explained`,
      payload: {},
    });
    await db
      .update(schema.deployments)
      .set({ state: 'FAILED' })
      .where(eq(schema.deployments.id, deployment.id));

    const response = await aiApp.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}/diagnostics`,
      headers: { cookie: org.cookie },
    });

    const body = response.json() as { failureCode: string; what: string; why: string; fix: string };
    expect(body.failureCode).toBe('UNKNOWN');
    expect(body.what).toBe('The app failed for a reason the classifier could not identify.');
    expect(body.fix).toBe('Check the logs and contact support if this keeps happening.');
    expect(capturedPrompt).toContain('[REDACTED]');
    expect(capturedPrompt).not.toContain('u:p');
    await aiApp.close();
  });

  // The widened gate: every code in AI_EXPLAINABLE_FAILURE_CODES gets an AI
  // explanation (one call per attempt, deterministic code preserved); the
  // set itself is pinned so adding a code here forces a test decision.
  it('every AI-explainable code gets AI text with the deterministic failureCode preserved', async () => {
    let calls = 0;
    const aiApp = await buildServer({
      auth,
      db,
      aiGateway: {
        async generate() {
          calls += 1;
          return {
            object: {
              failureCode: 'UNKNOWN',
              what: 'AI reading of the app-owned failure.',
              why: 'AI why',
              fix: 'AI fix',
              confidence: 'low',
            },
            usage: { promptTokens: 20, completionTokens: 10 },
          };
        },
      },
    });
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const fresh = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'FAILED',
    });

    const codes = [...AI_EXPLAINABLE_FAILURE_CODES];
    for (const [index, code] of codes.entries()) {
      await db.insert(schema.deploymentJobs).values({
        deploymentId: fresh.id,
        type: 'DEPLOY_RELEASE',
        state: 'FAILED',
        failureCode: code,
        finishedAt: new Date(Date.now() - (codes.length - index) * 1000),
        idempotencyKey: `${fresh.id}:DEPLOY_RELEASE:ai-set-${index}`,
        payload: {},
      });

      const response = await aiApp.inject({
        method: 'GET',
        url: `/api/deployments/${fresh.id}/diagnostics`,
        headers: { cookie: org.cookie },
      });
      const body = response.json() as { failureCode: string; source: string; confidence: string | null; what: string };
      expect(body.failureCode, `code ${code}`).toBe(code);
      expect(body.source, `code ${code}`).toBe('ai');
      expect(body.confidence, `code ${code}`).toBe('low');
      expect(body.what, `code ${code}`).toBe('AI reading of the app-owned failure.');
    }
    expect(calls).toBe(codes.length);
    await aiApp.close();
  });

  it('AI_EXPLAINABLE_FAILURE_CODES is the widened app-owned set', () => {
    expect([...AI_EXPLAINABLE_FAILURE_CODES].sort()).toEqual(
      [
        'UNKNOWN',
        'CONTAINER_START_FAILED',
        'IMAGE_HEALTH_CHECK_FAILED',
        'DATABASE_CONNECTION_FAILED',
        'MISSING_SECRET',
        'PORT_MISMATCH',
        'MIGRATION_FAILED',
      ].sort(),
    );
  });

  // §31 config writes are non-disruptive — they must not disturb the lifecycle.
  it('a CONFIG_UPDATE result leaves the deployment state untouched', async () => {
    await db.update(schema.deployments).set({ state: 'HEALTHY' }).where(eq(schema.deployments.id, deployment.id));
    const [job] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: deployment.id,
        type: 'CONFIG_UPDATE',
        state: 'RUNNING',
        idempotencyKey: `${deployment.id}:CONFIG_UPDATE:1`,
        payload: {},
      })
      .returning();

    await postJson(
      app,
      `/api/relay/commands/${job!.id}/result`,
      { success: true },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );

    const [updated] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(updated!.state).toBe('HEALTHY');
  });

  it('a successful DESTROY marks the deployment DELETED and stamps deletedAt', async () => {
    const [job] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: deployment.id,
        type: 'DESTROY',
        state: 'RUNNING',
        idempotencyKey: `${deployment.id}:DESTROY`,
        payload: {},
      })
      .returning();

    await postJson(
      app,
      `/api/relay/commands/${job!.id}/result`,
      { success: true },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );

    const [updated] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(updated!.state).toBe('DELETED');
    expect(updated!.deletedAt).not.toBeNull();
  });

  it('POST /api/relay/health rejects a wrong bearer token', async () => {
    const response = await postJson(
      app,
      '/api/relay/health',
      { installationId: RELAY_INSTALLATION_ID, healthStatus: 'HEALTHY' },
      { authorization: 'Bearer wrong-token' },
    );
    expect(response.statusCode).toBe(401);
  });

  it('persists observedState/relayStatus/lastHealthAt/healthStatus from the relay payload', async () => {
    // The previous test settled a DESTROY, which left the shared deployment DELETED.
    await db.update(schema.deployments).set({ state: 'HEALTHY' }).where(eq(schema.deployments.id, deployment.id));
    const response = await postJson(
      app,
      '/api/relay/health',
      { installationId: RELAY_INSTALLATION_ID, observedState: { tasksRunning: 2 }, healthStatus: 'DEGRADED' },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(response.statusCode).toBe(200);

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(dep!.relayStatus).toBe('CONNECTED');
    expect(dep!.healthStatus).toBe('DEGRADED');
    expect(dep!.observedState).toMatchObject({ tasksRunning: 2 });
    expect(dep!.lastHealthAt).not.toBeNull();
  });

  // ── DZ-AUDIT-001: registration with a settled INSTALL job must mint a fresh one ──

  it('DZ-AUDIT-001: registration with a FAILED INSTALL job mints a fresh retry-scoped job (NOT the settled one)', async () => {
    // Simulation: a deployment after relay/reset — state NOT_INSTALLED,
    // no enrollment, but a FAILED INSTALL job from a previous registration.
    const auditApp = await insertApplication(db, org.organizationId, { name: 'Audit Fail' });
    await insertDeployableRelease(db, auditApp.id);
    const auditCustomer = await insertCustomer(db, org.organizationId);
    const auditDeployment = await insertDeployment(db, org.organizationId, auditApp.id, auditCustomer.id, {
      state: 'NOT_INSTALLED',
      installationId: null,
      enrollmentUsedAt: null,
      relayTokenHash: null,
    });
    // Pre-seed a FAILED INSTALL job with the fixed idempotency key (the old registration).
    const oldJobKey = `${auditDeployment.id}:INSTALL`;
    await db.insert(schema.deploymentJobs).values({
      deploymentId: auditDeployment.id,
      type: 'INSTALL',
      state: 'FAILED',
      idempotencyKey: oldJobKey,
      payload: {},
      requestedBy: null,
    });

    const RELAY_TOKEN_DZ = 'audit-dz-token';
    const response = await postJson(
      app,
      '/api/relay/register',
      { enrollmentCode: auditDeployment.enrollmentCode, installationId: 'inst-audit-dz' },
      { authorization: `Bearer ${RELAY_TOKEN_DZ}` },
    );
    expect(response.statusCode).toBe(200);

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, auditDeployment.id));
    expect(dep!.state).toBe('INSTALLING');

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(and(eq(schema.deploymentJobs.deploymentId, auditDeployment.id), eq(schema.deploymentJobs.type, 'INSTALL')));
    // Two jobs: the old FAILED one (untouched) plus a fresh REQUESTED one.
    expect(jobs).toHaveLength(2);

    const oldJob = jobs.find((j) => j.state === 'FAILED');
    expect(oldJob).toBeDefined();
    expect(oldJob!.idempotencyKey).toBe(oldJobKey);

    const newJob = jobs.find((j) => j.state === 'REQUESTED');
    expect(newJob).toBeDefined();
    expect(newJob!.idempotencyKey).toBe(`${auditDeployment.id}:INSTALL:RETRY:1`);
    expect(newJob!.id).not.toBe(oldJob!.id);
    // The new job is claimable.
    const claim = await app.inject({
      method: 'GET',
      url: `/api/relay/commands?installationId=inst-audit-dz`,
      headers: { authorization: `Bearer ${RELAY_TOKEN_DZ}` },
    });
    const claimBody = claim.json() as { commands: Array<{ id: string }> };
    expect(claimBody.commands).toHaveLength(1);
    expect(claimBody.commands[0]!.id).toBe(newJob!.id);
  });

  it('DZ-AUDIT-001: registration while a legitimate INSTALL job is REQUESTED does NOT create a second job', async () => {
    const auditApp = await insertApplication(db, org.organizationId, { name: 'Audit Active' });
    await insertDeployableRelease(db, auditApp.id);
    const auditCustomer = await insertCustomer(db, org.organizationId);
    const auditDeployment = await insertDeployment(db, org.organizationId, auditApp.id, auditCustomer.id, {
      state: 'NOT_INSTALLED',
      installationId: null,
      enrollmentUsedAt: null,
      relayTokenHash: null,
    });

    // First registration should create a fresh INSTALL job.
    const RELAY_TOKEN_ACTIVE = 'audit-active-token';
    const first = await postJson(
      app,
      '/api/relay/register',
      { enrollmentCode: auditDeployment.enrollmentCode, installationId: 'inst-audit-active' },
      { authorization: `Bearer ${RELAY_TOKEN_ACTIVE}` },
    );
    expect(first.statusCode).toBe(200);

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, auditDeployment.id));
    expect(dep!.state).toBe('INSTALLING');

    // Now simulate: enrollmentUsedAt is set, installationId is set, and the
    // INSTALL job is REQUESTED. A fresh relay cold-start re-registration with
    // the same id+token should early-return and NOT create a second job.
    const second = await postJson(
      app,
      '/api/relay/register',
      { enrollmentCode: auditDeployment.enrollmentCode, installationId: 'inst-audit-active' },
      { authorization: `Bearer ${RELAY_TOKEN_ACTIVE}` },
    );
    expect(second.statusCode).toBe(200);

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(and(eq(schema.deploymentJobs.deploymentId, auditDeployment.id), eq(schema.deploymentJobs.type, 'INSTALL')));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.state).toBe('REQUESTED');
  });

  it('DZ-AUDIT-001: registration after a CANCELLED INSTALL job mints a fresh claimable job', async () => {
    // After relay/reset cancelled the previous INSTALL, re-registration must
    // produce a new job.
    const auditApp = await insertApplication(db, org.organizationId, { name: 'Audit Cancel' });
    await insertDeployableRelease(db, auditApp.id);
    const auditCustomer = await insertCustomer(db, org.organizationId);
    const auditDeployment = await insertDeployment(db, org.organizationId, auditApp.id, auditCustomer.id, {
      state: 'NOT_INSTALLED',
      installationId: null,
      enrollmentUsedAt: null,
      relayTokenHash: null,
    });
    const oldJobKey = `${auditDeployment.id}:INSTALL`;
    await db.insert(schema.deploymentJobs).values({
      deploymentId: auditDeployment.id,
      type: 'INSTALL',
      state: 'CANCELLED',
      idempotencyKey: oldJobKey,
      payload: {},
      requestedBy: null,
    });

    const RELAY_TOKEN_CANCEL = 'audit-cancel-token';
    const response = await postJson(
      app,
      '/api/relay/register',
      { enrollmentCode: auditDeployment.enrollmentCode, installationId: 'inst-audit-cancel' },
      { authorization: `Bearer ${RELAY_TOKEN_CANCEL}` },
    );
    expect(response.statusCode).toBe(200);

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, auditDeployment.id));
    expect(dep!.state).toBe('INSTALLING');

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(and(eq(schema.deploymentJobs.deploymentId, auditDeployment.id), eq(schema.deploymentJobs.type, 'INSTALL')));
    expect(jobs).toHaveLength(2);

    const newJob = jobs.find((j) => j.state === 'REQUESTED');
    expect(newJob).toBeDefined();
    expect(newJob!.idempotencyKey).toBe(`${auditDeployment.id}:INSTALL:RETRY:1`);

    // Claimable.
    const claim = await app.inject({
      method: 'GET',
      url: `/api/relay/commands?installationId=inst-audit-cancel`,
      headers: { authorization: `Bearer ${RELAY_TOKEN_CANCEL}` },
    });
    const claimBody = claim.json() as { commands: Array<{ id: string }> };
    expect(claimBody.commands).toHaveLength(1);
    expect(claimBody.commands[0]!.id).toBe(newJob!.id);
  });
});

// ── §5: idempotency ──────────────────────────────────────────────────────────
describe('server — idempotent job creation (§5)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };
  let applicationId: string;
  let customerId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'idem-org@example.com');
    app = await buildServer({ auth, db });

    const application = await insertApplication(db, org.organizationId);
    applicationId = application.id;
    const customer = await insertCustomer(db, org.organizationId);
    customerId = customer.id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  // One mutating operation per deployment: each job-creating test gets a
  // FRESH deployment so the busy gate cannot see a previous test's job, and
  // every deploy target is a READY release with a digest (the deploy
  // contract refuses anything less).
  async function freshDeployment(): Promise<typeof schema.deployments.$inferSelect> {
    return insertDeployment(db, org.organizationId, applicationId, customerId, { state: 'HEALTHY' });
  }

  async function deployableRelease(): Promise<string> {
    const release = await insertRelease(db, applicationId, {
      releaseStatus: 'READY',
      buildStatus: 'SUCCEEDED',
      imageDigest:
        '151955775369.dkr.ecr.us-east-1.amazonaws.com/deployz-images@sha256:' +
        crypto.randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
    });
    return release.id;
  }

  it('POST .../deploy twice with the same releaseId returns the SAME job (202 then 200), never a duplicate row', async () => {
    const deployment = await freshDeployment();
    const releaseId = await deployableRelease();
    const first = await postJson(app, `/api/deployments/${deployment.id}/deploy`, { releaseId }, { cookie: org.cookie });
    expect(first.statusCode, first.body).toBe(202);
    const second = await postJson(app, `/api/deployments/${deployment.id}/deploy`, { releaseId }, { cookie: org.cookie });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { jobId: string }).jobId).toBe((first.json() as { jobId: string }).jobId);

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.idempotencyKey, `${deployment.id}:DEPLOY_RELEASE:${releaseId}`));
    expect(jobs).toHaveLength(1);
  });

  // Phase 5 §9.5: a dead relay must be REFUSED up front (mirroring
  // retry-install's RELAY_DISCONNECTED), not handed a job it never claims —
  // deploy/rollback/restart all share requireDeployableState.
  it('POST .../deploy refuses 409 RELAY_DISCONNECTED when the relay is dead and no job is queued', async () => {
    const deployment = await insertDeployment(db, org.organizationId, applicationId, customerId, {
      state: 'HEALTHY',
      relayStatus: 'DISCONNECTED',
      lastHealthAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    const releaseId = await deployableRelease();

    const response = await postJson(app, `/api/deployments/${deployment.id}/deploy`, { releaseId }, { cookie: org.cookie });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'RELAY_DISCONNECTED' } });

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    expect(jobs).toHaveLength(0);
  });

  it('POST .../deploy refuses 409 RELAY_NOT_CONNECTED when no relay was ever bound', async () => {
    const deployment = await insertDeployment(db, org.organizationId, applicationId, customerId, {
      state: 'HEALTHY',
      installationId: null,
    });
    const response = await postJson(
      app,
      `/api/deployments/${deployment.id}/rollback`,
      { releaseId: await deployableRelease() },
      { cookie: org.cookie },
    );
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'RELAY_NOT_CONNECTED' } });
  });

  it('a different releaseId produces a different job once the first settles', async () => {
    const deployment = await freshDeployment();
    const r1 = await postJson(app, `/api/deployments/${deployment.id}/deploy`, { releaseId: await deployableRelease() }, { cookie: org.cookie });
    expect(r1.statusCode, r1.body).toBe(202);
    // The busy gate refuses a SECOND mutating operation while the first is
    // active - settle it, as the relay reporting success would.
    await db
      .update(schema.deploymentJobs)
      .set({ state: 'SUCCEEDED', finishedAt: new Date() })
      .where(eq(schema.deploymentJobs.id, (r1.json() as { jobId: string }).jobId));

    const r2 = await postJson(app, `/api/deployments/${deployment.id}/deploy`, { releaseId: await deployableRelease() }, { cookie: org.cookie });
    expect(r2.statusCode, r2.body).toBe(202);
    expect((r1.json() as { jobId: string }).jobId).not.toBe((r2.json() as { jobId: string }).jobId);
  });

  it('an Idempotency-Key header overrides the derived key', async () => {
    const deployment = await freshDeployment();
    const first = await postJson(
      app,
      `/api/deployments/${deployment.id}/deploy`,
      { releaseId: await deployableRelease() },
      { cookie: org.cookie, 'idempotency-key': 'client-supplied-key-1' },
    );
    expect(first.statusCode, first.body).toBe(202);

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.idempotencyKey, `${deployment.id}:DEPLOY_RELEASE:client:client-supplied-key-1`));
    expect(jobs).toHaveLength(1);

    // Same header, different releaseId - still the same idempotent operation.
    const second = await postJson(
      app,
      `/api/deployments/${deployment.id}/deploy`,
      { releaseId: await deployableRelease() },
      { cookie: org.cookie, 'idempotency-key': 'client-supplied-key-1' },
    );
    expect(second.statusCode).toBe(200);
    expect((second.json() as { jobId: string }).jobId).toBe((first.json() as { jobId: string }).jobId);
  });

  it('the same Idempotency-Key on two deployments or two operations never reuses the other job', async () => {
    const first = await freshDeployment();
    const second = await freshDeployment();
    const headers = { cookie: org.cookie, 'idempotency-key': 'shared-client-key' };

    const a = await postJson(app, `/api/deployments/${first.id}/restart`, {}, headers);
    expect(a.statusCode, a.body).toBe(202);
    const b = await postJson(app, `/api/deployments/${second.id}/restart`, {}, headers);
    expect(b.statusCode, b.body).toBe(202);
    expect((b.json() as { jobId: string }).jobId).not.toBe((a.json() as { jobId: string }).jobId);

    await db
      .update(schema.deploymentJobs)
      .set({ state: 'SUCCEEDED', finishedAt: new Date() })
      .where(eq(schema.deploymentJobs.id, (a.json() as { jobId: string }).jobId));
    const c = await postJson(app, `/api/deployments/${first.id}/destroy`, {}, headers);
    expect(c.statusCode, c.body).toBe(202);
    expect((c.json() as { jobId: string }).jobId).not.toBe((a.json() as { jobId: string }).jobId);
  });

  it('POST .../rollback twice with the same target releaseId returns the SAME job', async () => {
    const deployment = await freshDeployment();
    const releaseId = await deployableRelease();
    const first = await postJson(app, `/api/deployments/${deployment.id}/rollback`, { releaseId }, { cookie: org.cookie });
    const second = await postJson(app, `/api/deployments/${deployment.id}/rollback`, { releaseId }, { cookie: org.cookie });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect((second.json() as { jobId: string }).jobId).toBe((first.json() as { jobId: string }).jobId);
  });

  it('POST .../deploy and .../rollback 404 for a releaseId the application does not own', async () => {
    const deployment = await freshDeployment();
    const otherApplication = await insertApplication(db, org.organizationId, { name: 'Foreign Release App' });
    const foreignRelease = await insertRelease(db, otherApplication.id);

    for (const action of ['deploy', 'rollback']) {
      const missing = await postJson(
        app,
        `/api/deployments/${deployment.id}/${action}`,
        { releaseId: crypto.randomUUID() },
        { cookie: org.cookie },
      );
      expect(missing.statusCode).toBe(404);

      const foreign = await postJson(
        app,
        `/api/deployments/${deployment.id}/${action}`,
        { releaseId: foreignRelease.id },
        { cookie: org.cookie },
      );
      expect(foreign.statusCode).toBe(404);
    }
  });

  it('POST .../destroy twice returns the SAME job (a double-click must not create two DESTROY jobs)', async () => {
    const deployment = await freshDeployment();
    const first = await postJson(app, `/api/deployments/${deployment.id}/destroy`, {}, { cookie: org.cookie });
    const second = await postJson(app, `/api/deployments/${deployment.id}/destroy`, {}, { cookie: org.cookie });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect((second.json() as { jobId: string }).jobId).toBe((first.json() as { jobId: string }).jobId);

    const jobs = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.idempotencyKey, `${deployment.id}:DESTROY`));
    expect(jobs).toHaveLength(1);
  });
});

// ── §7/§8: fleet + detail joins, readiness derivation ───────────────────────
describe('server — fleet list & deployment detail joins, readiness derivation (§7,§8)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'fleet-org@example.com');
    app = await buildServer({ auth, db });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('GET /api/deployments carries customerName/applicationName/version/masked awsAccountId (§23/§24)', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Analytics API' });
    const customer = await insertCustomer(db, org.organizationId, { name: 'Acme Corp' });
    const [release] = await db
      .insert(schema.releases)
      .values({ applicationId: application.id, version: '1.4.2', gitSha: 'deadbeef' })
      .returning();
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'HEALTHY',
      region: 'us-east-1',
      currentReleaseId: release!.id,
      awsAccountId: '123456789012',
    });

    const listResponse = await app.inject({ method: 'GET', url: '/api/deployments', headers: { cookie: org.cookie } });
    expect(listResponse.statusCode).toBe(200);
    const listBody = listResponse.json() as {
      deployments: Array<{
        id: string;
        customerName: string;
        applicationName: string;
        version: string | null;
        region: string;
        state: string;
        awsAccountId: string | null;
      }>;
    };
    const row = listBody.deployments.find((d) => d.id === deployment.id);
    expect(row).toBeDefined();
    expect(row!.customerName).toBe('Acme Corp');
    expect(row!.applicationName).toBe('Analytics API');
    expect(row!.version).toBe('1.4.2');
    expect(row!.region).toBe('us-east-1');
    expect(row!.state).toBe('HEALTHY');
    expect(row!.awsAccountId).toBe(`1234${'•'.repeat(8)}`);

    const detailResponse = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}`,
      headers: { cookie: org.cookie },
    });
    expect(detailResponse.statusCode).toBe(200);
    const detailBody = detailResponse.json() as {
      customerName: string;
      applicationName: string;
      version: string | null;
      jobs: unknown[];
    };
    expect(detailBody.customerName).toBe('Acme Corp');
    expect(detailBody.applicationName).toBe('Analytics API');
    expect(detailBody.version).toBe('1.4.2');
    expect(detailBody.jobs).toEqual([]);
  });

  it('version is null when the deployment has no current release', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);

    const response = await app.inject({ method: 'GET', url: `/api/deployments/${deployment.id}`, headers: { cookie: org.cookie } });
    expect((response.json() as { version: string | null }).version).toBeNull();
  });

  it('deployment detail never returns unclaimed job secret plaintext', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);
    await db.insert(schema.deploymentJobs).values([
      {
        deploymentId: deployment.id,
        type: 'CONFIG_UPDATE',
        state: 'REQUESTED',
        idempotencyKey: `${deployment.id}:CONFIG_UPDATE:unclaimed`,
        payload: { changedKeys: ['DB_PASSWORD'], secrets: [{ key: 'DB_PASSWORD', value: 'plaintext-config-secret' }] },
      },
      {
        deploymentId: deployment.id,
        type: 'INSTALL',
        state: 'REQUESTED',
        idempotencyKey: `${deployment.id}:INSTALL:unclaimed`,
        payload: { parameters: { paramAppApiKey: 'plaintext-install-key', DesiredCount: '1' } },
      },
    ]);

    const response = await app.inject({ method: 'GET', url: `/api/deployments/${deployment.id}`, headers: { cookie: org.cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('plaintext-config-secret');
    expect(response.body).not.toContain('plaintext-install-key');
  });

  it('deployment detail derives per-component state from requirements, verification checks and relay reports', async () => {
    const redisApp = await insertApplication(db, org.organizationId, { redisRequired: true });
    const redisCustomer = await insertCustomer(db, org.organizationId);
    // Phase 2: the component requirements come from the stored manifest, not
    // the live application columns above — stateless + redis isolates the
    // redis component the way the application row alone used to.
    const redisDeployment = await insertDeployment(db, org.organizationId, redisApp.id, redisCustomer.id, {
      desiredState: {
        manifest: { ...READY_MANIFEST, database: { postgres: false }, redis: { required: true, envBindings: [] } },
      },
    });

    // Required but never observed: Not reporting (UNKNOWN). Compute and
    // ingress are always required for an installed deployment.
    const withRedis = await app.inject({
      method: 'GET',
      url: `/api/deployments/${redisDeployment.id}`,
      headers: { cookie: org.cookie },
    });
    expect((withRedis.json() as { components: Record<string, string> | null }).components).toEqual({
      application: 'UNKNOWN',
      loadBalancer: 'UNKNOWN',
      redis: 'UNKNOWN',
    });

    const noRedisApp = await insertApplication(db, org.organizationId, { redisRequired: false });
    const noRedisCustomer = await insertCustomer(db, org.organizationId);
    const noRedisDeployment = await insertDeployment(db, org.organizationId, noRedisApp.id, noRedisCustomer.id, {
      desiredState: { manifest: { ...READY_MANIFEST, database: { postgres: false } } },
    });

    const withoutRedis = await app.inject({
      method: 'GET',
      url: `/api/deployments/${noRedisDeployment.id}`,
      headers: { cookie: org.cookie },
    });
    expect((withoutRedis.json() as { components: Record<string, string> | null }).components).toEqual({
      application: 'UNKNOWN',
      loadBalancer: 'UNKNOWN',
    });

    // A component the relay HAS reported is preserved verbatim; required
    // ones it did not report (load balancer) are synthesized alongside.
    await db
      .update(schema.deployments)
      .set({ observedState: { components: { application: 'HEALTHY', redis: 'HEALTHY' } } })
      .where(eq(schema.deployments.id, redisDeployment.id));
    const reported = await app.inject({
      method: 'GET',
      url: `/api/deployments/${redisDeployment.id}`,
      headers: { cookie: org.cookie },
    });
    expect((reported.json() as { components: Record<string, string> | null }).components).toEqual({
      application: 'HEALTHY',
      loadBalancer: 'UNKNOWN',
      redis: 'HEALTHY',
    });

    // Required, verification looked, nothing there: Not provisioned.
    await db
      .update(schema.deployments)
      .set({
        observedState: {
          components: {},
          infraHealth: { verified: false, checks: [{ name: 'cache', passed: false, detail: '' }] },
        },
      })
      .where(eq(schema.deployments.id, redisDeployment.id));
    const notProvisioned = await app.inject({
      method: 'GET',
      url: `/api/deployments/${redisDeployment.id}`,
      headers: { cookie: org.cookie },
    });
    expect(
      (notProvisioned.json() as { components: Record<string, string> | null }).components?.redis,
    ).toBe('NOT_PROVISIONED');
  });

  it('the dashboard component list follows the deployment stored manifest when the live application column disagrees', async () => {
    // The application row says Redis IS required, but the deployment's
    // frozen manifest says it is NOT — the manifest must win (Phase 2).
    const application = await insertApplication(db, org.organizationId, { redisRequired: true });
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      desiredState: { manifest: { ...READY_MANIFEST, database: { postgres: false } } },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}`,
      headers: { cookie: org.cookie },
    });
    expect((response.json() as { components: Record<string, string> | null }).components).toEqual({
      application: 'UNKNOWN',
      loadBalancer: 'UNKNOWN',
    });
  });

  it('readiness: analysis not COMPLETE returns state ANALYSIS_INCOMPLETE with empty findings, never a fabricated result', async () => {
    const application = await insertApplication(db, org.organizationId, { analysisStatus: 'ANALYZING' });
    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/readiness`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({
      analysisOutdated: false,
      analysisStatus: 'ANALYZING',
      state: 'ANALYSIS_INCOMPLETE',
      requiredCount: 0,
      recommendedCount: 0,
      summary: null,
      failureReason: null,
      findings: [],
      passed: [],
      analyzedCommitSha: null,
      detected: null,
      requirements: null,
      deploymentRequirementDrift: [],
      vendorDismissedRejections: [],
      environmentSetup: null,
    });
  });

  // A FAILED analysis used to reach the page as an indistinguishable
  // "not COMPLETE yet" — same empty shape as ANALYZING, reason dropped. The
  // vendor saw "Analysing your app" for ever and Re-analyse looked inert.
  it('readiness: a FAILED analysis carries the reason it failed', async () => {
    const application = await insertApplication(db, org.organizationId, {
      analysisStatus: 'FAILED',
      compatibilityReason: 'Failed to mint a GitHub installation token',
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/readiness`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      analysisStatus: 'FAILED',
      state: 'ANALYSIS_INCOMPLETE',
      failureReason: 'Failed to mint a GitHub installation token',
    });
  });

  it('readiness: a row with a stored semantic report returns it verbatim, plus the analyzed commit sha', async () => {
    const finding = {
      id: 'health-check',
      category: 'health',
      title: 'Give Deployz a way to check your app',
      severity: 'required',
      blocking: false,
      plainEnglishExplanation: 'Deployz needs a reliable way to know when your app is running and ready.',
      whyItMatters: 'During every deployment, Deployz waits for your app to report healthy.',
      technicalEvidence: 'No health endpoint or container health check was found.',
      suggestedOutcome: 'Expose a lightweight route that returns success once the app is ready.',
      confidence: 'likely',
    };
    const readiness = {
      state: 'ALMOST_READY',
      requiredCount: 1,
      recommendedCount: 0,
      summary: 'Deployz found a few things to address before this app can be deployed reliably.',
      findings: [finding],
      passed: [{ id: 'dockerfile', label: 'Container setup found' }],
    };
    const application = await insertApplication(db, org.organizationId, {
      analysisStatus: 'COMPLETE',
      compatibilityStatus: 'NEEDS_ATTENTION',
      compatibilityReason: readiness.summary,
      detectedMetadata: { readiness, analysisCommitSha: 'deadbeef' },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/readiness`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({
      analysisOutdated: true,
      analysisStatus: 'COMPLETE',
      state: 'ALMOST_READY',
      requiredCount: 1,
      recommendedCount: 0,
      summary: readiness.summary,
      failureReason: null,
      findings: [finding],
      passed: readiness.passed,
      analyzedCommitSha: 'deadbeef',
      detected: null,
      requirements: {
        schemaVersion: 1,
        database: { detected: false, effective: false, overridden: false },
        redis: { detected: false, effective: false, overridden: false },
        storage: { detected: false, effective: false, overridden: false },
      },
      deploymentRequirementDrift: [],
      vendorDismissedRejections: [],
      environmentSetup: { needsDecision: 0, missingValue: 0, missingBuildValue: 0, customer: 0, total: 0 },
      architecture: {
        counts: { schemaVersion: 1, workloadCount: 1, resourceCount: 2, managedResourceCount: 2, unresolvedCount: 0, hasBlockingUnresolved: false },
        groups: [
          { group: 'application', nodes: [{ label: 'Web service', state: 'detected' }] },
          { group: 'storage', nodes: [{ label: 'S3 bucket', state: 'detected' }] },
          { group: 'edge', nodes: [{ label: 'Application load balancer', state: 'detected' }] },
        ],
        unresolved: [],
        externalServices: [],
      },
    });
  });

  // An external service (EXTERNAL_SAAS) is not Deployz-created — it must
  // never appear as an architecture group node, while the detected groups
  // stay intact; it is listed as information, never asked about.
  it('readiness: an external service stays out of the architecture groups', async () => {
    const readiness = { state: 'READY', requiredCount: 0, recommendedCount: 0, summary: 'ok', findings: [], passed: [] };
    const application = await insertApplication(db, org.organizationId, {
      analysisStatus: 'COMPLETE',
      compatibilityStatus: 'READY',
      detectedMetadata: { readiness, externalServices: ['SendGrid'] },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/readiness`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode).toBe(200);
    const { architecture } = response.json() as {
      architecture: {
        counts: Record<string, number | boolean>;
        groups: { group: string; nodes: { label: string }[] }[];
        unresolved: { kind: string; question: string; blocking: boolean }[];
        externalServices: string[];
      };
    };
    // 3 resources in the graph, 2 managed — the external one is counted in
    // the graph summary but grouped nowhere.
    expect(architecture.counts).toEqual({
      schemaVersion: 1,
      workloadCount: 1,
      resourceCount: 3,
      managedResourceCount: 2,
      unresolvedCount: 0,
      hasBlockingUnresolved: false,
    });
    expect(architecture.groups).toEqual([
      { group: 'application', nodes: [{ label: 'Web service', state: 'detected' }] },
      { group: 'storage', nodes: [{ label: 'S3 bucket', state: 'detected' }] },
      { group: 'edge', nodes: [{ label: 'Application load balancer', state: 'detected' }] },
    ]);
    expect(architecture.unresolved).toEqual([]);
    expect(architecture.externalServices).toEqual(['SendGrid']);
  });

  it('readiness: a stored canonical projection is served as `detected`; a malformed one reads as null', async () => {
    const detected = buildApplicationAnalysis(analyseRepo(GITHUB_FIXTURE_FILE_TREES['deployz-demo/express-api']!), {
      analysisVersion: ANALYSIS_VERSION,
      aiResolved: [],
      resolvedMigrationCommand: 'npx drizzle-kit push',
    });
    const readiness = { state: 'READY', requiredCount: 0, recommendedCount: 0, summary: 'ok', findings: [], passed: [] };
    const stored = await insertApplication(db, org.organizationId, {
      analysisStatus: 'COMPLETE',
      compatibilityStatus: 'READY',
      detectedMetadata: { readiness, application: detected },
    });
    const served = await app.inject({
      method: 'GET',
      url: `/api/applications/${stored.id}/readiness`,
      headers: { cookie: org.cookie },
    });
    expect(served.statusCode).toBe(200);
    expect((served.json() as { detected: unknown }).detected).toEqual(detected);

    const malformed = await insertApplication(db, org.organizationId, {
      analysisStatus: 'COMPLETE',
      compatibilityStatus: 'READY',
      detectedMetadata: { readiness, application: { ...detected, runtime: 'node' } },
    });
    const degraded = await app.inject({
      method: 'GET',
      url: `/api/applications/${malformed.id}/readiness`,
      headers: { cookie: org.cookie },
    });
    expect(degraded.statusCode).toBe(200);
    expect((degraded.json() as { detected: unknown }).detected).toBeNull();
  });

  // Legacy rows (analysed before the semantic readiness report existed) only
  // carry `detected_metadata.checks` — computeReadiness must degrade these
  // into equivalent findings rather than 500 or silently drop them.
  it('readiness: a legacy row (checks only, no readiness report) degrades to equivalent findings', async () => {
    const application = await insertApplication(db, org.organizationId, {
      analysisStatus: 'COMPLETE',
      compatibilityStatus: 'NEEDS_ATTENTION',
      detectedMetadata: {
        checks: {
          ready: [{ label: 'Docker container detected' }, { label: 'PostgreSQL detected' }],
          needsAttention: [
            { title: 'Health endpoint missing', detail: 'Deployz requires an HTTP health endpoint.', suggestedFix: 'GET /health -> 200' },
          ],
          unsupported: [],
        },
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/readiness`,
      headers: { cookie: org.cookie },
    });
    const body = response.json() as {
      state: string;
      findings: Array<{ id: string; severity: string; blocking: boolean; title: string }>;
      passed: Array<{ id: string; label: string }>;
    };
    expect(body.state).toBe('ALMOST_READY');
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0]).toMatchObject({ severity: 'required', blocking: false, title: 'Health endpoint missing' });
    expect(body.passed).toHaveLength(2);
    expect(body.passed).toContainEqual({ id: 'legacy-passed-0', label: 'Docker container detected' });
  });

  it('readiness: a legacy NOT_COMPATIBLE row degrades its unsupported entries into blocking required findings', async () => {
    const application = await insertApplication(db, org.organizationId, {
      analysisStatus: 'COMPLETE',
      compatibilityStatus: 'NOT_COMPATIBLE',
      compatibilityReason: 'Persistent Redis is required.',
      detectedMetadata: {
        checks: {
          ready: [],
          needsAttention: [],
          unsupported: [{ title: 'This Redis setup is not supported', reason: 'Redis Stack modules detected.' }],
        },
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/readiness`,
      headers: { cookie: org.cookie },
    });
    const body = response.json() as {
      state: string;
      findings: Array<{ severity: string; blocking: boolean; title: string }>;
    };
    expect(body.state).toBe('NEEDS_CHANGES');
    expect(body.findings).toEqual([
      expect.objectContaining({ severity: 'required', blocking: true, title: 'This Redis setup is not supported' }),
    ]);
  });

  it('readiness: a legacy fully-READY row (no issues) has passed checks and no findings', async () => {
    const application = await insertApplication(db, org.organizationId, {
      analysisStatus: 'COMPLETE',
      compatibilityStatus: 'READY',
      detectedMetadata: { checks: { ready: [{ label: 'Docker container detected' }], needsAttention: [], unsupported: [] } },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/readiness`,
      headers: { cookie: org.cookie },
    });
    const body = response.json() as { state: string; findings: unknown[]; passed: unknown[] };
    expect(body.state).toBe('READY');
    expect(body.findings).toEqual([]);
    expect(body.passed).toEqual([{ id: 'legacy-passed-0', label: 'Docker container detected' }]);
  });

  // Phase 1: the server computes database/redis/storage truth instead of the
  // web app OR-ing `application.*Required` with `detected.*.required` — an
  // OR cannot represent a vendor override to `false` (see server — §35
  // vendorOverrides).
  describe('readiness: requirements (Phase 1 server-computed database/redis/storage truth)', () => {
    // Isolate the assertion to redis: the express-api fixture's own `pg`
    // dependency + DATABASE_URL evidence would otherwise make
    // `detected.database.required` true too.
    function detectedWithRedisRequired(required: boolean) {
      const detected = buildApplicationAnalysis(analyseRepo(GITHUB_FIXTURE_FILE_TREES['deployz-demo/express-api']!), {
        analysisVersion: ANALYSIS_VERSION,
        aiResolved: [],
        resolvedMigrationCommand: null,
      });
      return {
        ...detected,
        database: { ...detected.database, required: false },
        redis: { ...detected.redis, required },
      };
    }

    it('detected redis required, no override: effective true, overridden false', async () => {
      const application = await insertApplication(db, org.organizationId, {
        analysisStatus: 'COMPLETE',
        compatibilityStatus: 'READY',
        redisRequired: true,
        detectedMetadata: { application: detectedWithRedisRequired(true) },
      });
      const response = await app.inject({
        method: 'GET',
        url: `/api/applications/${application.id}/readiness`,
        headers: { cookie: org.cookie },
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { requirements: unknown }).requirements).toEqual({
        schemaVersion: 1,
        database: { detected: false, effective: false, overridden: false },
        redis: { detected: true, effective: true, overridden: false },
        storage: { detected: false, effective: false, overridden: false },
      });
    });

    it('vendor override sets redisRequired=false while detection says true: effective false, overridden true', async () => {
      const application = await insertApplication(db, org.organizationId, {
        analysisStatus: 'COMPLETE',
        compatibilityStatus: 'READY',
        redisRequired: false,
        detectedMetadata: {
          application: detectedWithRedisRequired(true),
          vendorOverrides: ['redisRequired'],
        },
      });
      const response = await app.inject({
        method: 'GET',
        url: `/api/applications/${application.id}/readiness`,
        headers: { cookie: org.cookie },
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { requirements: unknown }).requirements).toEqual({
        schemaVersion: 1,
        database: { detected: false, effective: false, overridden: false },
        redis: { detected: true, effective: false, overridden: true },
        storage: { detected: false, effective: false, overridden: false },
      });
    });

    it('a Django app whose Dockerfile installs the MySQL driver is served as a required MySQL database', async () => {
      const analysis = analyseRepo({
        Dockerfile: 'FROM python:3.9\nRUN pip install mysqlclient\nCOPY . .\nEXPOSE 8000\nCMD ["gunicorn", "site.wsgi"]\n',
        'requirements.txt': 'Django==4.1.5\ngunicorn==20.1.0\n',
        'docker-compose.yml': 'services:\n  web:\n    build: .\n  db:\n    image: mysql\n    environment:\n      - MYSQL_DATABASE=app\n',
      });
      const application = await insertApplication(db, org.organizationId, {
        analysisStatus: 'COMPLETE',
        compatibilityStatus: 'READY',
        databaseRequired: true,
        detectedMetadata: {
          ...analysis.metadata,
          application: buildApplicationAnalysis(analysis, {
            analysisVersion: ANALYSIS_VERSION,
            aiResolved: [],
            resolvedMigrationCommand: null,
          }),
        },
      });
      const response = await app.inject({
        method: 'GET',
        url: `/api/applications/${application.id}/readiness`,
        headers: { cookie: org.cookie },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        requirements: { database: unknown };
        detected: { database: { type: string; required: boolean } };
      };
      expect(body.requirements.database).toEqual({ detected: true, effective: true, overridden: false });
      expect(body.detected.database).toMatchObject({ type: 'mysql', required: true });
    });

    it('analysis incomplete: requirements is null', async () => {
      const application = await insertApplication(db, org.organizationId, { analysisStatus: 'ANALYZING' });
      const response = await app.inject({
        method: 'GET',
        url: `/api/applications/${application.id}/readiness`,
        headers: { cookie: org.cookie },
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { requirements: unknown }).requirements).toBeNull();
    });

    // The vendor-facing drift surface: existing deployments keep their frozen
    // manifest, and the readiness API reports which ones now differ from the
    // application's effective requirements. Reported only — never repaired.
    describe('readiness: deployment requirement drift (frozen manifest vs effective requirements)', () => {
      // Same detection base as above: the express-api fixture detects a
      // database naturally; redis is forced off to isolate the database
      // dimension.
      const detected = detectedWithRedisRequired(false);

      function readinessBody(applicationId: string) {
        return app.inject({
          method: 'GET',
          url: `/api/applications/${applicationId}/readiness`,
          headers: { cookie: org.cookie },
        });
      }

      it('a vendor override flip after a deployment exists is reported, and desired_state stays byte-identical', async () => {
        const application = await insertApplication(db, org.organizationId, {
          analysisStatus: 'COMPLETE',
          compatibilityStatus: 'READY',
          databaseRequired: true,
          detectedMetadata: { application: detected },
        });
        const customer = await insertCustomer(db, org.organizationId);
        // Frozen at creation with the database required (insertDeployment's READY_MANIFEST).
        const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);
        const frozenBefore = JSON.stringify(deployment.desiredState);

        const patch = await sendJson(app, 'PATCH', `/api/applications/${application.id}`, { databaseRequired: false }, { cookie: org.cookie });
        expect(patch.statusCode, patch.body).toBe(200);

        const response = await readinessBody(application.id);
        expect(response.statusCode).toBe(200);
        expect((response.json() as { deploymentRequirementDrift: unknown }).deploymentRequirementDrift).toEqual([
          {
            deploymentId: deployment.id,
            customerName: customer.name,
            state: 'NOT_INSTALLED',
            drift: [{ kind: 'database', deployed: true, desired: false }],
          },
        ]);

        // Reported, not repaired: the frozen manifest is untouched.
        const [row] = await db
          .select({ desiredState: schema.deployments.desiredState })
          .from(schema.deployments)
          .where(eq(schema.deployments.id, deployment.id));
        expect(JSON.stringify(row!.desiredState)).toBe(frozenBefore);
      });

      it('PATCH with null resets a requirement override to the detected value and releases ownership', async () => {
        const application = await insertApplication(db, org.organizationId, {
          analysisStatus: 'COMPLETE',
          compatibilityStatus: 'READY',
          databaseRequired: true,
          detectedMetadata: { application: detected, vendorOverrides: ['databaseRequired'] },
        });

        const patch = await sendJson(app, 'PATCH', `/api/applications/${application.id}`, { databaseRequired: null }, { cookie: org.cookie });
        expect(patch.statusCode, patch.body).toBe(200);

        const body = patch.json() as { databaseRequired: boolean; detectedMetadata: { vendorOverrides: string[] } };
        expect(body.databaseRequired).toBe(false);
        expect(body.detectedMetadata.vendorOverrides).toEqual([]);

        const response = await readinessBody(application.id);
        const requirements = (response.json() as { requirements: { database: { effective: boolean; overridden: boolean } } }).requirements;
        expect(requirements.database).toMatchObject({ effective: false, overridden: false });
      });

      it('a frozen manifest aligned with the effective requirements yields an empty array', async () => {
        const application = await insertApplication(db, org.organizationId, {
          analysisStatus: 'COMPLETE',
          compatibilityStatus: 'READY',
          databaseRequired: true,
          detectedMetadata: { application: detected },
        });
        const customer = await insertCustomer(db, org.organizationId);
        await insertDeployment(db, org.organizationId, application.id, customer.id);

        const response = await readinessBody(application.id);
        expect(response.statusCode).toBe(200);
        expect((response.json() as { deploymentRequirementDrift: unknown }).deploymentRequirementDrift).toEqual([]);
      });

      it('DELETED deployments are excluded', async () => {
        // databaseRequired defaults to false, so the frozen manifest (database
        // true) would drift — but the deployment is gone.
        const application = await insertApplication(db, org.organizationId, {
          analysisStatus: 'COMPLETE',
          compatibilityStatus: 'READY',
          detectedMetadata: { application: detected },
        });
        const customer = await insertCustomer(db, org.organizationId);
        await insertDeployment(db, org.organizationId, application.id, customer.id, { state: 'DELETED' });

        const response = await readinessBody(application.id);
        expect(response.statusCode).toBe(200);
        expect((response.json() as { deploymentRequirementDrift: unknown }).deploymentRequirementDrift).toEqual([]);
      });

      it('analysis incomplete: requirements is null and deploymentRequirementDrift is [] even with a drifted deployment', async () => {
        const application = await insertApplication(db, org.organizationId, { analysisStatus: 'ANALYZING' });
        const customer = await insertCustomer(db, org.organizationId);
        await insertDeployment(db, org.organizationId, application.id, customer.id);

        const response = await readinessBody(application.id);
        expect(response.statusCode).toBe(200);
        const body = response.json() as { requirements: unknown; deploymentRequirementDrift: unknown };
        expect(body.requirements).toBeNull();
        expect(body.deploymentRequirementDrift).toEqual([]);
      });

      it('a deployment with an invalid stored manifest is skipped without error', async () => {
        const application = await insertApplication(db, org.organizationId, {
          analysisStatus: 'COMPLETE',
          compatibilityStatus: 'READY',
          databaseRequired: true,
          detectedMetadata: { application: detected },
        });
        const customer = await insertCustomer(db, org.organizationId);
        await insertDeployment(db, org.organizationId, application.id, customer.id, {
          desiredState: { manifest: { not: 'a manifest' } },
        });

        const response = await readinessBody(application.id);
        expect(response.statusCode).toBe(200);
        expect((response.json() as { deploymentRequirementDrift: unknown }).deploymentRequirementDrift).toEqual([]);
      });
    });
  });
});

// ── POST /api/applications/:id/fix-instructions ─────────────────────────────
// Generates the consolidated coding-agent prompt for the unresolved readiness
// findings. Read-only with respect to the analysis: generation never changes
// findings, readiness state, or the repository — success or failure.
describe('server — POST /api/applications/:id/fix-instructions', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let org: { userId: string; organizationId: string; cookie: string };

  const someFinding = {
    id: 'health-check',
    category: 'health',
    title: 'Give Deployz a way to check your app',
    severity: 'required',
    blocking: false,
    plainEnglishExplanation: 'Deployz needs a reliable way to know when your app is running and ready.',
    whyItMatters: 'During every deployment, Deployz waits for your app to report healthy.',
    technicalEvidence: 'No health endpoint or container health check was found.',
    suggestedOutcome: 'Expose a lightweight route that returns success once the app is ready.',
    confidence: 'likely',
  };

  async function insertAnalyzedApplication(
    overrides: Partial<typeof schema.applications.$inferInsert> = {},
  ): Promise<typeof schema.applications.$inferSelect> {
    return insertApplication(db, org.organizationId, {
      analysisStatus: 'COMPLETE',
      compatibilityStatus: 'NEEDS_ATTENTION',
      detectedMetadata: {
        readiness: {
          state: 'ALMOST_READY',
          requiredCount: 1,
          recommendedCount: 0,
          summary: 'Deployz found a few things to address before this app can be deployed reliably.',
          findings: [someFinding],
          passed: [],
        },
      },
      ...overrides,
    });
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'fix-instructions@example.com');
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('200s with an instructions document containing the guardrail sentence, the repo name, and a generatedAt', async () => {
    const application = await insertAnalyzedApplication();
    const stubApp = await buildServer({
      auth,
      db,
      fixInstructionsAiGateway: {
        async generate() {
          return {
            object: { items: [{ id: 'health-check', guidance: 'Add a /health route.' }] },
            usage: { promptTokens: 100, completionTokens: 50 },
          };
        },
      },
    });

    const response = await postJson(
      stubApp,
      `/api/applications/${application.id}/fix-instructions`,
      {},
      { cookie: org.cookie },
    );
    expect(response.statusCode).toBe(200);
    const body = response.json() as { instructions: string; generatedAt: string };
    expect(body.instructions).toContain(
      'Do not assume Deployz findings are correct. Inspect the repository first.',
    );
    expect(body.instructions).toContain(application.repoFullName);
    expect(body.generatedAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);

    await stubApp.close();
  });

  it('409s ANALYSIS_NOT_COMPLETE when the analysis has not finished', async () => {
    const application = await insertApplication(db, org.organizationId, { analysisStatus: 'ANALYZING' });
    const stubApp = await buildServer({
      auth,
      db,
      fixInstructionsAiGateway: {
        async generate() {
          throw new Error('must not be called');
        },
      },
    });

    const response = await postJson(
      stubApp,
      `/api/applications/${application.id}/fix-instructions`,
      {},
      { cookie: org.cookie },
    );
    expect(response.statusCode).toBe(409);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('ANALYSIS_NOT_COMPLETE');

    await stubApp.close();
  });

  it('409s NO_UNRESOLVED_FINDINGS when the analysis is COMPLETE with a READY report and no findings', async () => {
    const application = await insertAnalyzedApplication({
      compatibilityStatus: 'READY',
      detectedMetadata: {
        readiness: {
          state: 'READY',
          requiredCount: 0,
          recommendedCount: 0,
          summary: 'This app can be deployed through Deployz.',
          findings: [],
          passed: [{ id: 'dockerfile', label: 'Container setup found' }],
        },
      },
    });
    const stubApp = await buildServer({
      auth,
      db,
      fixInstructionsAiGateway: {
        async generate() {
          throw new Error('must not be called');
        },
      },
    });

    const response = await postJson(
      stubApp,
      `/api/applications/${application.id}/fix-instructions`,
      {},
      { cookie: org.cookie },
    );
    expect(response.statusCode).toBe(409);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('NO_UNRESOLVED_FINDINGS');

    await stubApp.close();
  });

  it('503s FIX_INSTRUCTIONS_UNAVAILABLE (retryable) when the AI gateway fails', async () => {
    const application = await insertAnalyzedApplication();
    const failingApp = await buildServer({
      auth,
      db,
      fixInstructionsAiGateway: {
        async generate() {
          throw new Error('gateway unreachable');
        },
      },
    });

    const response = await postJson(
      failingApp,
      `/api/applications/${application.id}/fix-instructions`,
      {},
      { cookie: org.cookie },
    );
    expect(response.statusCode).toBe(503);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('FIX_INSTRUCTIONS_UNAVAILABLE');

    await failingApp.close();
  });

  describe('with no fix-instructions provider configured', () => {
    const original = {
      problem: env.fixInstructionsAiProblem,
      webUrl: env.webUrl,
      aiFixtureMode: env.aiFixtureMode,
    };

    afterEach(() => {
      env.fixInstructionsAiProblem = original.problem;
      env.webUrl = original.webUrl;
      env.aiFixtureMode = original.aiFixtureMode;
    });

    async function unconfiguredResponse(problem: typeof env.fixInstructionsAiProblem, webUrl: string) {
      env.fixInstructionsAiProblem = problem;
      env.webUrl = webUrl;
      env.aiFixtureMode = false;
      const application = await insertAnalyzedApplication();
      const unconfiguredApp = await buildServer({ auth, db });
      const response = await postJson(
        unconfiguredApp,
        `/api/applications/${application.id}/fix-instructions`,
        {},
        { cookie: org.cookie },
      );
      await unconfiguredApp.close();
      return response;
    }

    it.each([
      ['missing-openrouter-key', 'OPENROUTER_API_KEY'],
      ['missing-gateway', 'AI_GATEWAY_BASE_URL'],
      ['invalid-provider', 'FIX_INSTRUCTIONS_AI_PROVIDER'],
    ] as const)('names the setting for %s on a local API', async (problem, setting) => {
      const response = await unconfiguredResponse(problem, 'http://localhost:3000');
      expect(response.statusCode).toBe(503);
      const error = errorEnvelopeSchema.parse(response.json()).error;
      expect(error.code).toBe('FIX_INSTRUCTIONS_UNAVAILABLE');
      expect(error.message).toContain(setting);
      expect(error.details).toEqual({ reason: 'not_configured' });
    });

    it('keeps the generic message on a non-local API', async () => {
      const response = await unconfiguredResponse('missing-openrouter-key', 'https://app.deployz.dev');
      expect(response.statusCode).toBe(503);
      const error = errorEnvelopeSchema.parse(response.json()).error;
      expect(error.code).toBe('FIX_INSTRUCTIONS_UNAVAILABLE');
      expect(error.message).not.toContain('OPENROUTER_API_KEY');
      expect(error.details).toEqual({ reason: 'not_configured' });
    });

    it('answers 200 in AI fixture mode', async () => {
      env.fixInstructionsAiProblem = 'missing-openrouter-key';
      env.webUrl = 'http://localhost:3000';
      env.aiFixtureMode = true;
      const application = await insertAnalyzedApplication();
      const fixtureApp = await buildServer({ auth, db });
      const response = await postJson(
        fixtureApp,
        `/api/applications/${application.id}/fix-instructions`,
        {},
        { cookie: org.cookie },
      );
      await fixtureApp.close();
      expect(response.statusCode).toBe(200);
    });
  });

  it('keeps the generic message when a configured gateway fails', async () => {
    const application = await insertAnalyzedApplication();
    const failingApp = await buildServer({
      auth,
      db,
      fixInstructionsAiGateway: {
        async generate() {
          throw new Error('gateway unreachable');
        },
      },
    });
    const response = await postJson(
      failingApp,
      `/api/applications/${application.id}/fix-instructions`,
      {},
      { cookie: org.cookie },
    );
    const error = errorEnvelopeSchema.parse(response.json()).error;
    expect(response.statusCode).toBe(503);
    expect(error.message).toBe("We couldn't generate the instructions right now. Try again in a moment.");
    expect(error.details).toBeUndefined();
    await failingApp.close();
  });

  it('never modifies the application row — readiness is identical before and after, on success and on failure', async () => {
    const application = await insertAnalyzedApplication();
    const readOnlyApp = await buildServer({ auth, db });

    const readinessBefore = await readOnlyApp.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/readiness`,
      headers: { cookie: org.cookie },
    });

    const succeedingApp = await buildServer({
      auth,
      db,
      fixInstructionsAiGateway: {
        async generate() {
          return {
            object: { items: [] },
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        },
      },
    });
    const success = await postJson(
      succeedingApp,
      `/api/applications/${application.id}/fix-instructions`,
      {},
      { cookie: org.cookie },
    );
    expect(success.statusCode).toBe(200);
    await succeedingApp.close();

    const failingApp = await buildServer({
      auth,
      db,
      fixInstructionsAiGateway: {
        async generate() {
          throw new Error('gateway unreachable');
        },
      },
    });
    // regenerate bypasses the document the first call cached, so the
    // failure path actually runs.
    const failure = await postJson(
      failingApp,
      `/api/applications/${application.id}/fix-instructions`,
      { regenerate: true },
      { cookie: org.cookie },
    );
    expect(failure.statusCode).toBe(503);
    await failingApp.close();

    const readinessAfter = await readOnlyApp.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/readiness`,
      headers: { cookie: org.cookie },
    });
    expect(readinessAfter.json()).toEqual(readinessBefore.json());
    await readOnlyApp.close();
  });
});

// ── §18/§19: POST /:id/analyse wires the injectable analysis runner ────────
describe('server — POST /api/applications/:id/analyse wires ServerDeps.analysisRunner', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let org: { userId: string; organizationId: string; cookie: string };

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'analyse-org@example.com');
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('202s immediately, sets ANALYZING, and invokes the injected runner with the applicationId', async () => {
    const calls: string[] = [];
    const app = await buildServer({
      auth,
      db,
      analysisRunner: async (applicationId) => {
        calls.push(applicationId);
      },
    });
    try {
      const application = await insertApplication(db, org.organizationId);

      const response = await app.inject({
        method: 'POST',
        url: `/api/applications/${application.id}/analyse`,
        headers: { cookie: org.cookie },
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toStrictEqual({ status: 'ANALYZING' });

      const rows = await db
        .select({ analysisStatus: schema.applications.analysisStatus })
        .from(schema.applications)
        .where(eq(schema.applications.id, application.id));
      expect(rows[0]?.analysisStatus).toBe('ANALYZING');

      // With no job queue configured the runner is awaited inline, so it has
      // already run by the time the 202 comes back.
      expect(calls).toEqual([application.id]);
    } finally {
      await app.close();
    }
  });

  // Task 6 commit-SHA analysis cache: the explicit "Re-analyse" action sends
  // `{ force: true }` in the body, which must reach the injected runner so it
  // bypasses the cache; an auto-trigger sends no body at all.
  it('threads an explicit { force: true } body through to the injected runner', async () => {
    const calls: Array<{ applicationId: string; force: boolean | undefined }> = [];
    const app = await buildServer({
      auth,
      db,
      analysisRunner: async (applicationId, options) => {
        calls.push({ applicationId, force: options?.force });
      },
    });
    try {
      const application = await insertApplication(db, org.organizationId);

      const response = await app.inject({
        method: 'POST',
        url: `/api/applications/${application.id}/analyse`,
        headers: { cookie: org.cookie },
        payload: { force: true },
      });

      expect(response.statusCode).toBe(202);
      expect(calls).toEqual([{ applicationId: application.id, force: true }]);
    } finally {
      await app.close();
    }
  });

  it('does not force a re-analysis when no body is sent', async () => {
    const calls: Array<boolean | undefined> = [];
    const app = await buildServer({
      auth,
      db,
      analysisRunner: async (_applicationId, options) => {
        calls.push(options?.force);
      },
    });
    try {
      const application = await insertApplication(db, org.organizationId);

      const response = await app.inject({
        method: 'POST',
        url: `/api/applications/${application.id}/analyse`,
        headers: { cookie: org.cookie },
      });

      expect(response.statusCode).toBe(202);
      expect(calls).toEqual([false]);
    } finally {
      await app.close();
    }
  });

  it('still 202s even when the injected runner rejects (defense-in-depth catch)', async () => {
    const app = await buildServer({
      auth,
      db,
      analysisRunner: async () => {
        throw new Error('boom — simulated runner failure');
      },
    });
    try {
      const application = await insertApplication(db, org.organizationId);

      const response = await app.inject({
        method: 'POST',
        url: `/api/applications/${application.id}/analyse`,
        headers: { cookie: org.cookie },
      });

      // A rejecting runner must not surface as an unhandled rejection or
      // turn the accepted request into a 500.
      expect(response.statusCode).toBe(202);
    } finally {
      await app.close();
    }
  });
});

// ── GitHub App installation binding (§15/§17) ──────────────────────────────
describe('server — GitHub installation binding', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };
  let other: { userId: string; organizationId: string; cookie: string };

  // GitHub's own view of the installation. The setup route reads the account
  // from the API rather than trusting the browser for anything but the id.
  const githubFetch = (async (url: string) => ({
    status: url.includes('/app/installations/4242') ? 200 : 404,
    headers: { get: () => null },
    json: async () => ({ account: { login: 'acme-inc', type: 'Organization' } }),
  })) as unknown as Parameters<typeof buildServer>[0]['githubFetch'];

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    app = await buildServer({
      auth,
      db,
      githubFixtureMode: false,
      githubFetch,
      githubAppInstallUrl: 'https://github.com/apps/deployz-test/installations/new',
      githubAppId: 'test-app-id',
      // A real key: the setup route signs an RS256 App JWT, so a placeholder
      // string fails inside node:crypto rather than in the route.
      githubAppPrivateKey: generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      }).privateKey,
    });
    org = await signUpAndGetOrg(auth, db, 'gh-owner@example.com');
    other = await signUpAndGetOrg(auth, db, 'gh-other@example.com');
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  const startInstall = async (cookie: string): Promise<string> => {
    const connect = await app.inject({ method: 'GET', url: '/api/github/connect', headers: { cookie } });
    expect(connect.statusCode).toBe(302);
    const location = new URL(String(connect.headers['location']));
    expect(location.origin + location.pathname).toBe('https://github.com/apps/deployz-test/installations/new');
    return location.searchParams.get('state')!;
  };

  // Production configured the App's public page. GitHub drops `state` when
  // the vendor clicks Install there, so every new binding was refused.
  it('sends the install to installations/new when the configured URL is the App page', async () => {
    const pageApp = await buildServer({
      auth,
      db,
      githubFixtureMode: false,
      githubAppInstallUrl: 'https://github.com/apps/deployz-test/',
    });
    try {
      const connect = await pageApp.inject({
        method: 'GET',
        url: '/api/github/connect',
        headers: { cookie: org.cookie },
      });
      expect(connect.statusCode).toBe(302);
      const location = new URL(String(connect.headers['location']));
      expect(location.origin + location.pathname).toBe('https://github.com/apps/deployz-test/installations/new');
      expect(location.searchParams.get('state')).toBeTruthy();
    } finally {
      await pageApp.close();
    }
  });

  it('refuses to bind an installation without a state this organization issued', async () => {
    const withoutState = await app.inject({
      method: 'GET',
      url: '/api/github/setup?installation_id=4242',
      headers: { cookie: org.cookie },
    });
    expect(withoutState.headers['location']).toContain('/dashboard/applications?github=failed');

    const otherState = await startInstall(other.cookie);
    const withOtherState = await app.inject({
      method: 'GET',
      url: `/api/github/setup?installation_id=4242&state=${encodeURIComponent(otherState)}`,
      headers: { cookie: org.cookie },
    });
    expect(withOtherState.headers['location']).toContain('/dashboard/applications?github=failed');

    const forged = await app.inject({
      method: 'GET',
      url: '/api/github/setup?installation_id=4242&state=9999999999999.x.deadbeef',
      headers: { cookie: org.cookie },
    });
    expect(forged.headers['location']).toContain('/dashboard/applications?github=failed');

    expect(await db.select().from(schema.githubInstallations)).toEqual([]);
  });

  it('binds an installation to the caller organization and redirects to the dashboard', async () => {
    const state = await startInstall(org.cookie);
    const response = await app.inject({
      method: 'GET',
      url: `/api/github/setup?installation_id=4242&state=${encodeURIComponent(state)}`,
      headers: { cookie: org.cookie },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toContain('/dashboard/applications?github=connected');

    const rows = await db.select().from(schema.githubInstallations);
    expect(rows).toEqual([
      expect.objectContaining({
        id: '4242',
        organizationId: org.organizationId,
        accountLogin: 'acme-inc',
        accountType: 'Organization',
      }),
    ]);
  });

  it('never rebinds an installation that another organization already owns', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/github/setup?installation_id=4242',
      headers: { cookie: other.cookie },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toContain('/dashboard/applications?github=failed');
    const [row] = await db
      .select()
      .from(schema.githubInstallations)
      .where(eq(schema.githubInstallations.id, '4242'));
    expect(row?.organizationId).toBe(org.organizationId);
  });

  // GitHub redirects the installing vendor here whether or not they hold a
  // Deployz session. A JSON 401 strands them on an error page with the
  // installation unbound; sign-in carries the id so the binding still
  // completes on the way back. The callback is relative because the sign-in
  // page rejects absolute URLs as open redirects.
  it('redirects a signed-out setup hit to sign-in rather than erroring', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/github/setup?installation_id=4242&state=s1',
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toContain(
      '/sign-in?callbackUrl=%2Fgithub%2Fsetup%3Finstallation_id%3D4242%26state%3Ds1',
    );
  });

  // Same principle as the signed-out case above, for the other way this route
  // fails. GitHub sends a *browser* here, so an error envelope renders raw
  // JSON at the vendor — which is what a mangled App key produced in
  // production: `{"error":{"code":"INTERNAL_ERROR",...}}` on screen, and no
  // way back. Land them on the dashboard, which says what it knows.
  it('returns a failed setup to the dashboard instead of rendering JSON', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/github/setup?installation_id=9999',
      headers: { cookie: org.cookie },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toContain('/dashboard/applications?github=failed');
    expect(response.body).not.toContain('INTERNAL_ERROR');

    // A binding that did not happen is never recorded as if it had.
    const rows = await db.select().from(schema.githubInstallations);
    expect(rows.map((row) => row.id)).not.toContain('9999');
  });

  it('lists the bound installation for its own organization only', async () => {
    const mine = await app.inject({
      method: 'GET',
      url: '/api/github/installations',
      headers: { cookie: org.cookie },
    });
    expect((mine.json() as { installations: unknown[] }).installations).toEqual([
      { id: '4242', accountLogin: 'acme-inc', accountType: 'Organization' },
    ]);

    const theirs = await app.inject({
      method: 'GET',
      url: '/api/github/installations',
      headers: { cookie: other.cookie },
    });
    expect((theirs.json() as { installations: unknown[] }).installations).toEqual([]);
  });

  // An installation id is a small integer: without this check any signed-in
  // user could list the repositories of any installation by guessing one.
  it('404s repo listing for an installation the caller does not own', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/github/repos?installationId=4242',
      headers: { cookie: other.cookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it('404s application creation against an installation the caller does not own', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/applications',
      headers: { cookie: other.cookie },
      payload: {
        name: 'Borrowed',
        githubInstallationId: '4242',
        repoFullName: 'acme-inc/private',
        repoUrl: 'https://github.com/acme-inc/private',
        defaultBranch: 'main',
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it('drops the installation on the installation.deleted webhook', async () => {
    const secret = 'webhook-secret';
    const webhookApp = await buildServer({
      auth,
      db,
      githubWebhookSecret: secret,
      githubFixtureMode: false,
      githubFetch,
    });
    try {
      const body = JSON.stringify({ action: 'deleted', installation: { id: 4242 } });
      const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

      const response = await webhookApp.inject({
        method: 'POST',
        url: '/api/github/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'installation',
          'x-hub-signature-256': signature,
        },
        payload: body,
      });

      expect(response.json()).toStrictEqual({ received: true, handled: 'removed' });
      expect(await db.select().from(schema.githubInstallations)).toEqual([]);
    } finally {
      await webhookApp.close();
    }
  });
});

// ── §9: organization settings, public install page, bulk deploy ────────────
describe('server — organization settings, public install page, and bulk deploy (§9)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'org-settings@example.com');
    app = await buildServer({ auth, db });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('GET /api/organization requires auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/organization' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /api/organization returns the session org', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/organization', headers: { cookie: org.cookie } });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { id: string; name: string; subscriptionStatus: string | null; createdAt: string };
    expect(body.id).toBe(org.organizationId);
    // Evaluation mode: no billing_subscriptions row yet.
    expect(body.subscriptionStatus).toBeNull();
    expect(typeof body.createdAt).toBe('string');
  });

  it('GET /api/organization reflects the organization\'s billing_subscriptions row', async () => {
    await db.insert(schema.billingSubscriptions).values({
      organizationId: org.organizationId,
      providerCustomerId: 'ctm_settings',
      providerSubscriptionId: 'sub_settings',
      status: 'PAST_DUE',
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/organization', headers: { cookie: org.cookie } });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { subscriptionStatus: string | null };
      expect(body.subscriptionStatus).toBe('PAST_DUE');
    } finally {
      await db
        .delete(schema.billingSubscriptions)
        .where(eq(schema.billingSubscriptions.organizationId, org.organizationId));
    }
  });

  it('PATCH /api/organization updates the name', async () => {
    const patchResponse = await sendJson(app, 'PATCH', '/api/organization', { name: 'Renamed Org' }, { cookie: org.cookie });
    expect(patchResponse.statusCode).toBe(200);
    expect((patchResponse.json() as { name: string }).name).toBe('Renamed Org');

    const getResponse = await app.inject({ method: 'GET', url: '/api/organization', headers: { cookie: org.cookie } });
    expect((getResponse.json() as { name: string }).name).toBe('Renamed Org');
  });

  it('PATCH /api/organization rejects an empty name', async () => {
    const response = await sendJson(app, 'PATCH', '/api/organization', { name: '' }, { cookie: org.cookie });
    expect(response.statusCode).toBe(400);
  });

  it('GET /api/billing/summary returns subscription: null with no billing_subscriptions row', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/billing/summary', headers: { cookie: org.cookie } });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { subscription: unknown };
    expect(body.subscription).toBeNull();
  });

  it('GET /api/billing/summary returns the organization\'s billing_subscriptions row', async () => {
    const periodStart = new Date('2026-08-01T00:00:00.000Z');
    const periodEnd = new Date('2026-09-01T00:00:00.000Z');
    await db.insert(schema.billingSubscriptions).values({
      organizationId: org.organizationId,
      providerCustomerId: 'ctm_summary',
      providerSubscriptionId: 'sub_summary',
      status: 'ACTIVE',
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/billing/summary', headers: { cookie: org.cookie } });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        subscription: { status: string; currentPeriodStart: string; currentPeriodEnd: string } | null;
      };
      expect(body.subscription).toStrictEqual({
        status: 'ACTIVE',
        currentPeriodStart: periodStart.toISOString(),
        currentPeriodEnd: periodEnd.toISOString(),
      });
    } finally {
      await db
        .delete(schema.billingSubscriptions)
        .where(eq(schema.billingSubscriptions.organizationId, org.organizationId));
    }
  });

  it('GET /api/install/:installationId returns only display fields to the verified owner (§12/§44)', async () => {
    const application = await insertApplication(db, org.organizationId, {
      name: 'Analytics Cloud',
      databaseRequired: true,
      storageRequired: false,
    });
    const customer = await insertCustomer(db, org.organizationId, { name: 'Acme Analytics' });
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      region: 'eu-west-1',
      awsAccountId: '999999999999',
    });
    const [orgRow] = await db.select().from(schema.organization).where(eq(schema.organization.id, org.organizationId));

    // Keyed on the install-LINK id. The relay's installation id is minted in
    // the customer's account and must never be the value in a public URL.
    const response = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}`, headers: await customerSessionHeaders(db, deployment.installLinkId) });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    const footprint = resolveDeploymentFootprint({
      manifest: {
        ...READY_MANIFEST,
        schemaVersion: 1,
        redis: { required: false, envBindings: [] },
        storage: { required: false, envBindings: [] },
        environment: { variables: [] },
        externalServices: [],
        unsupported: [],
      },
      region: 'eu-west-1',
    });
    expect(body).toStrictEqual({
      applicationName: 'Analytics Cloud',
      publisherName: orgRow!.name,
      customerName: 'Acme Analytics',
      region: 'eu-west-1',
      alreadyInstalled: false,
      viewer: { kind: 'customer', email: customer.email.trim().toLowerCase() },
      // Phase 5: the install page's "Deployz will create" table renders
      // directly from this plan — same schema `GET /api/deployments/:id/plan`
      // serves — instead of a separate customer-name-mapped list.
      plan: {
        schemaVersion: 1,
        action: 'INSTALL',
        region: 'eu-west-1',
        components: [
          { kind: 'application', name: 'Application', action: 'CREATE', lifecycle: 'delete' },
          { kind: 'endpoint', name: 'Secure endpoint', action: 'CREATE', lifecycle: 'delete' },
          { kind: 'database', name: 'Database', action: 'CREATE', lifecycle: 'retain' },
          { kind: 'storage', name: 'Storage', action: 'CREATE', lifecycle: 'retain' },
        ],
        awsResources: requiredAwsResources({ postgres: true, redis: false }).map(toPlanAwsResource),
        footprint,
        costEstimate: estimateFootprintCost(footprint),
        requirementDrift: [],
      },
      // No BOOTSTRAP_TEMPLATE_URL in the test environment: nothing is
      // published, so there is no link to hand out. The enrollment code
      // travels inside that link, never as a field of its own.
      quickCreateUrl: null,
      existingStackUpdate: null,
      // The install link already identifies exactly this deployment, so
      // handing back its own id/state/domain does not cross a tenant
      // boundary — it's the same scope the link already grants.
      deploymentId: deployment.id,
      deploymentState: 'NOT_INSTALLED',
      // No release is serving yet — the current_release_id pointer is still
      // null, so there is no version to name.
      releaseVersion: null,
      domain: null,
      routingTarget: null,
      // Pre-relay fields: no launch has been recorded yet, so the expected
      // bootstrap stack name is derived live (deterministic from the
      // deployment identity) and nothing is stuck.
      components: null,
      bootstrapStackName: bootstrapStackName({
        appName: 'Analytics Cloud',
        deploymentId: deployment.id,
        attempt: 0,
      }),
      waitingForRelay: false,
      relayStuck: false,
      // Nothing was removed, so no retained data was deleted.
      retainedDataDeleted: false,
      // Invitation lifecycle: a link created by insertDeployment (not the
      // deploy-links creation path) has no expiry set.
      installLinkExpiresAt: null,
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('999999999999');
    expect(serialized).not.toContain(org.organizationId);
  });

  it('GET /api/install/:installationId records one install_link.opened event for repeated reads', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Open Once' });
    const customer = await insertCustomer(db, org.organizationId, { name: 'Acme Open' });
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      region: 'eu-west-1',
    });

    for (let i = 0; i < 3; i += 1) {
      const response = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}`, headers: await customerSessionHeaders(db, deployment.installLinkId) });
      expect(response.statusCode).toBe(200);
    }

    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.deploymentId, deployment.id));
    expect(events.filter((event) => event.eventType === 'install_link.opened')).toHaveLength(1);
  });

  it('GET /api/install/:installationId names the serving release version once the pointer advanced', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Versioned App' });
    const customer = await insertCustomer(db, org.organizationId);
    const release = await insertRelease(db, application.id, { releaseStatus: 'READY' });
    // READY deployment: reconciliation advanced current_release_id to the
    // release the heartbeat observed serving.
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'HEALTHY',
      currentReleaseId: release.id,
    });

    const response = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}`, headers: await customerSessionHeaders(db, deployment.installLinkId) });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { releaseVersion: string | null };
    expect(body.releaseVersion).toBe(release.version);
    // Version only — the digest and git SHA stay off the public surface.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(release.gitSha);
  });

  it('GET /api/install/:installationId reports releaseVersion null for a NOT_INSTALLED deployment', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Unreleased App' });
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'NOT_INSTALLED',
    });

    const response = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}`, headers: await customerSessionHeaders(db, deployment.installLinkId) });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { releaseVersion: string | null };
    expect(body.releaseVersion).toBeNull();
  });

  it('GET /api/install/:installationId lists a Cache component in the install plan only when the stored manifest requires Redis', async () => {
    const application = await insertApplication(db, org.organizationId, {
      name: 'Cache App',
      databaseRequired: false,
      storageRequired: false,
      redisRequired: true,
    });
    const customer = await insertCustomer(db, org.organizationId);
    // Phase 2: the plan is derived from the deployment's frozen manifest,
    // never the live application columns above.
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      desiredState: {
        manifest: { ...READY_MANIFEST, database: { postgres: false }, redis: { required: true, envBindings: [] } },
      },
    });

    const planComponentNames = (body: unknown) =>
      (body as { plan: { components: { name: string }[] } }).plan.components.map((c) => c.name);

    const withRedis = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}`, headers: await customerSessionHeaders(db, deployment.installLinkId) });
    expect(planComponentNames(withRedis.json())).toEqual(['Application', 'Secure endpoint', 'Storage', 'Cache']);

    // Drift: the vendor turns Redis off on the LIVE application row after the
    // deployment already froze its manifest — the plan must not move.
    await db
      .update(schema.applications)
      .set({ redisRequired: false })
      .where(eq(schema.applications.id, application.id));

    const stillWithRedis = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}`, headers: await customerSessionHeaders(db, deployment.installLinkId) });
    expect(planComponentNames(stillWithRedis.json())).toEqual(['Application', 'Secure endpoint', 'Storage', 'Cache']);
  });

  it('GET /api/install/:installationId derives observed components from the stored manifest, not the live application requirement columns', async () => {
    const application = await insertApplication(db, org.organizationId, {
      name: 'Drift Components App',
      databaseRequired: true,
      storageRequired: false,
      redisRequired: false,
    });
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      desiredState: {
        manifest: { ...READY_MANIFEST, database: { postgres: true }, redis: { required: false, envBindings: [] } },
      },
      enrollmentUsedAt: new Date(),
      observedState: { components: { application: 'HEALTHY' } },
    });

    const componentsOf = (body: unknown) => (body as { components: Record<string, string> | null }).components;

    const before = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}`, headers: await customerSessionHeaders(db, deployment.installLinkId) });
    expect(componentsOf(before.json())).toEqual({ application: 'HEALTHY', loadBalancer: 'UNKNOWN', database: 'UNKNOWN' });

    // Drift: the live application row changes after the deployment's
    // manifest was frozen — the reported components must not move.
    await db
      .update(schema.applications)
      .set({ databaseRequired: false, redisRequired: true })
      .where(eq(schema.applications.id, application.id));

    const after = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}`, headers: await customerSessionHeaders(db, deployment.installLinkId) });
    expect(componentsOf(after.json())).toEqual({ application: 'HEALTHY', loadBalancer: 'UNKNOWN', database: 'UNKNOWN' });
  });

  it('GET /api/install/:installationId stops handing out a link once the code is spent', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Spent Code App' });
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);

    // env is read at module load, so publish a template for this test only.
    const mutableEnv = env as { bootstrapTemplateUrl: string | undefined };
    const previous = mutableEnv.bootstrapTemplateUrl;
    mutableEnv.bootstrapTemplateUrl = 'https://templates.example.com/bootstrap-v1.json';
    try {
      const fresh = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}`, headers: await customerSessionHeaders(db, deployment.installLinkId) });
      const freshBody = fresh.json() as Record<string, unknown>;
      expect(freshBody['alreadyInstalled']).toBe(false);
      expect(String(freshBody['quickCreateUrl'])).toContain(deployment.enrollmentCode);

      // The relay has bound: the code is spent, the page renders its
      // "already set up" state, and a replayed link must not carry the code.
      await db
        .update(schema.deployments)
        .set({ enrollmentUsedAt: new Date() })
        .where(eq(schema.deployments.id, deployment.id));

      const replayed = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}`, headers: await customerSessionHeaders(db, deployment.installLinkId) });
      const replayedBody = replayed.json() as Record<string, unknown>;
      expect(replayedBody['alreadyInstalled']).toBe(true);
      expect(replayedBody['quickCreateUrl']).toBeNull();
      expect(JSON.stringify(replayedBody)).not.toContain(deployment.enrollmentCode);
    } finally {
      mutableEnv.bootstrapTemplateUrl = previous;
    }
  });

  it('GET /api/install/:installationId resolves the template for the deployment\'s OWN region', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Regional App' });
    const customer = await insertCustomer(db, org.organizationId);
    // us-east-2 deployment: the link must point at the us-east-2 regional
    // template, never the us-east-1 legacy bucket (S3 PermanentRedirect).
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      region: 'us-east-2',
    });

    const mutableEnv = env as {
      bootstrapTemplateUrl: string | undefined;
      deployableAwsRegions: readonly string[];
    };
    const prevUrl = mutableEnv.bootstrapTemplateUrl;
    const prevRegions = mutableEnv.deployableAwsRegions;
    // A legacy us-east-1 URL is configured — it must NOT leak to us-east-2.
    mutableEnv.bootstrapTemplateUrl = 'https://legacy-bucket.s3.us-east-1.amazonaws.com/bootstrap/v1/bootstrap-template-v1.json';
    mutableEnv.deployableAwsRegions = ['us-east-1', 'us-east-2'];
    try {
      const response = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}`, headers: await customerSessionHeaders(db, deployment.installLinkId) });
      const body = response.json() as Record<string, unknown>;
      expect(response.statusCode).toBe(200);
      const url = String(body['quickCreateUrl']);
      expect(url).toContain('region=us-east-2');
      expect(url).toContain('deployz-templates-us-east-2.s3.us-east-2.amazonaws.com');
      // The legacy us-east-1 URL must never be used for a us-east-2 deployment.
      expect(url).not.toContain('legacy-bucket');
    } finally {
      mutableEnv.bootstrapTemplateUrl = prevUrl;
      mutableEnv.deployableAwsRegions = prevRegions;
    }
  });

  it('GET /api/install/:installationId fails closed (no link) for an unpublished region', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Unpublished App' });
    const customer = await insertCustomer(db, org.organizationId);
    // us-east-2 is supported but not in the default deployable set → no link.
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      region: 'us-east-2',
    });

    const mutableEnv = env as { bootstrapTemplateUrl: string | undefined };
    const prev = mutableEnv.bootstrapTemplateUrl;
    mutableEnv.bootstrapTemplateUrl = 'https://legacy-bucket.s3.us-east-1.amazonaws.com/bootstrap/v1/bootstrap-template-v1.json';
    try {
      const response = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}`, headers: await customerSessionHeaders(db, deployment.installLinkId) });
      const body = response.json() as Record<string, unknown>;
      expect(body['quickCreateUrl']).toBeNull();
    } finally {
      mutableEnv.bootstrapTemplateUrl = prev;
    }
  });

  it('GET /api/regions returns only deployable regions (auth)', async () => {
    const mutableEnv = env as { deployableAwsRegions: readonly string[] };
    const prev = mutableEnv.deployableAwsRegions;
    mutableEnv.deployableAwsRegions = ['us-east-1', 'us-east-2'];
    try {
      const response = await app.inject({ method: 'GET', url: '/api/regions', headers: { cookie: org.cookie } });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { regions: Array<{ value: string; label: string }> };
      expect(body.regions).toEqual([
        { value: 'us-east-1', label: 'US East (N. Virginia)' },
        { value: 'us-east-2', label: 'US East (Ohio)' },
      ]);
    } finally {
      mutableEnv.deployableAwsRegions = prev;
    }
  });

  it('GET /api/regions requires auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/regions' });
    expect(response.statusCode).toBe(401);
  });

  it('POST /api/deployments rejects a supported-but-unpublished region', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Guard App' });
    const customer = await insertCustomer(db, org.organizationId);

    const mutableEnv = env as { deployableAwsRegions: readonly string[] };
    const prev = mutableEnv.deployableAwsRegions;
    mutableEnv.deployableAwsRegions = ['us-east-1']; // us-east-2 not deployable
    try {
      const response = await postJson(
        app,
        '/api/deployments',
        { applicationId: application.id, customerId: customer.id, region: 'us-east-2' },
        { cookie: org.cookie },
      );
      expect(response.statusCode).toBe(422);
      expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('REGION_NOT_SUPPORTED');
    } finally {
      mutableEnv.deployableAwsRegions = prev;
    }
  });

  it('GET /api/install/:installationId 404s for an unknown installation', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/install/does-not-exist' });
    expect(response.statusCode).toBe(404);
  });

  it('POST /api/applications/:id/deploy-bulk fans out into individual per-deployment jobs and skips non-deployable states (§25)', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Bulk App' });
    const customer = await insertCustomer(db, org.organizationId);
    const healthy1 = await insertDeployment(db, org.organizationId, application.id, customer.id, { state: 'HEALTHY' });
    const healthy2 = await insertDeployment(db, org.organizationId, application.id, customer.id, { state: 'UPDATE_AVAILABLE' });
    const installing = await insertDeployment(db, org.organizationId, application.id, customer.id, { state: 'INSTALLING' });
    const releaseId = (
      await insertRelease(db, application.id, {
        releaseStatus: 'READY',
        buildStatus: 'SUCCEEDED',
        imageDigest:
          '151955775369.dkr.ecr.us-east-1.amazonaws.com/deployz-images@sha256:' +
          crypto.randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
      })
    ).id;

    const response = await postJson(app, `/api/applications/${application.id}/deploy-bulk`, { releaseId }, { cookie: org.cookie });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { results: Array<{ deploymentId: string; status: string; jobId?: string }> };
    expect(body.results).toHaveLength(3);
    const byId = new Map(body.results.map((r) => [r.deploymentId, r]));
    expect(byId.get(healthy1.id)!.status).toBe('REQUESTED');
    expect(byId.get(healthy2.id)!.status).toBe('REQUESTED');
    expect(byId.get(installing.id)!.status).toBe('SKIPPED');

    // Never one aggregate job — one DEPLOY_RELEASE job per deployable target.
    const jobs = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.type, 'DEPLOY_RELEASE'));
    const jobDeploymentIds = jobs.map((j) => j.deploymentId).sort();
    expect(jobDeploymentIds).toEqual([healthy1.id, healthy2.id].sort());

    // Idempotent: calling again returns the SAME jobs, not new ones.
    const second = await postJson(app, `/api/applications/${application.id}/deploy-bulk`, { releaseId }, { cookie: org.cookie });
    const secondBody = second.json() as { results: Array<{ deploymentId: string; status: string }> };
    const secondById = new Map(secondBody.results.map((r) => [r.deploymentId, r]));
    expect(secondById.get(healthy1.id)!.status).toBe('ALREADY_REQUESTED');

    // Telemetry parity with the single-deploy route: every bulk target that
    // got a job emits exactly one deploy.requested — and the idempotent
    // second call does not add another. Skipped targets emit none.
    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(and(eq(schema.eventLogs.eventType, 'deploy.requested'), inArray(schema.eventLogs.deploymentId, [healthy1.id, healthy2.id, installing.id])));
    const requestedByDeployment = new Map<string, number>();
    for (const event of events) {
      requestedByDeployment.set(event.deploymentId, (requestedByDeployment.get(event.deploymentId) ?? 0) + 1);
    }
    expect(requestedByDeployment.get(healthy1.id)).toBe(1);
    expect(requestedByDeployment.get(healthy2.id)).toBe(1);
    expect(requestedByDeployment.get(installing.id)).toBeUndefined();
    expect(events.every((event) => event.releaseId === releaseId)).toBe(true);
  });

  it('POST /api/applications/:id/deploy-bulk with explicit deploymentIds only targets those', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Selective Bulk App' });
    const customer = await insertCustomer(db, org.organizationId);
    const dep1 = await insertDeployment(db, org.organizationId, application.id, customer.id, { state: 'HEALTHY' });
    await insertDeployment(db, org.organizationId, application.id, customer.id, { state: 'HEALTHY' });
    const release = await insertRelease(db, application.id, {
      releaseStatus: 'READY',
      buildStatus: 'SUCCEEDED',
      imageDigest:
        '151955775369.dkr.ecr.us-east-1.amazonaws.com/deployz-images@sha256:' +
        crypto.randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
    });

    const response = await postJson(
      app,
      `/api/applications/${application.id}/deploy-bulk`,
      { releaseId: release.id, deploymentIds: [dep1.id] },
      { cookie: org.cookie },
    );
    const body = response.json() as { results: Array<{ deploymentId: string }> };
    expect(body.results.map((r) => r.deploymentId)).toEqual([dep1.id]);
  });

  // A uuid-shaped releaseId that does not belong to the application must not
  // queue a job the relay can never carry out.
  it('POST /api/applications/:id/deploy-bulk 404s for a release that is not the application’s', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Bulk Release Guard' });
    const otherApplication = await insertApplication(db, org.organizationId, { name: 'Other App' });
    const foreignRelease = await insertRelease(db, otherApplication.id);

    const missing = await postJson(
      app,
      `/api/applications/${application.id}/deploy-bulk`,
      { releaseId: crypto.randomUUID() },
      { cookie: org.cookie },
    );
    expect(missing.statusCode).toBe(404);

    const foreign = await postJson(
      app,
      `/api/applications/${application.id}/deploy-bulk`,
      { releaseId: foreignRelease.id },
      { cookie: org.cookie },
    );
    expect(foreign.statusCode).toBe(404);
  });

  it("POST /api/applications/:id/deploy-bulk 404s for an application outside the caller's org", async () => {
    const otherOrg = await signUpAndGetOrg(auth, db, 'bulk-other-org@example.com');
    const otherApp = await insertApplication(db, otherOrg.organizationId);

    const response = await postJson(
      app,
      `/api/applications/${otherApp.id}/deploy-bulk`,
      { releaseId: (await insertRelease(db, otherApp.id)).id },
      { cookie: org.cookie },
    );
    expect(response.statusCode).toBe(404);
  });
});

// ── pre-relay install lifecycle: launch signal, WAITING_FOR_RELAY, retry ──────
describe('server — pre-relay install lifecycle (waiting-for-relay and retry)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };

  interface Seeded {
    deployment: typeof schema.deployments.$inferSelect;
    installLinkId: string;
  }

  async function seedWaiting(overrides: Partial<typeof schema.deployments.$inferInsert> = {}): Promise<Seeded> {
    const application = await insertApplication(db, org.organizationId, { name: 'Widget Suite' });
    await insertDeployableRelease(db, application.id);
    const customer = await insertCustomer(db, org.organizationId, { name: 'Widgets Inc' });
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      installationId: null,
      ...overrides,
    });
    return { deployment, installLinkId: deployment.installLinkId };
  }

  /** Component names of the public install page's "Deployz will create" plan. */
  async function installPlanNames(installLinkId: string): Promise<string[]> {
    const body = (await app.inject({ method: 'GET', url: `/api/install/${installLinkId}`, headers: await customerSessionHeaders(db, installLinkId) })).json() as {
      plan: { components: { name: string }[] } | null;
    };
    return body.plan!.components.map((component) => component.name);
  }

  /** Enrolls the seeded deployment's relay and returns the first INSTALL job's
   * payload — the frozen contract the relay provisions against. */
  async function enrollAndGetInstallPayload(seeded: Seeded, installationId: string): Promise<Record<string, unknown>> {
    const registered = await postJson(
      app,
      '/api/relay/register',
      { enrollmentCode: seeded.deployment.enrollmentCode, installationId },
      { authorization: 'Bearer install-flow-relay-token' },
    );
    expect(registered.statusCode).toBe(200);
    const [job] = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, seeded.deployment.id));
    expect(job!.type).toBe('INSTALL');
    return job!.payload as Record<string, unknown>;
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'waiting-relay@example.com');
    app = await buildServer({ auth, db });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('gives two deployments of the same application in the same region different stack names', async () => {
    const first = await seedWaiting();
    const second = await seedWaiting();

    const firstBody = (await app.inject({ method: 'GET', url: `/api/install/${first.installLinkId}`, headers: await customerSessionHeaders(db, first.installLinkId) })).json() as {
      bootstrapStackName: string;
    };
    const secondBody = (await app.inject({ method: 'GET', url: `/api/install/${second.installLinkId}`, headers: await customerSessionHeaders(db, second.installLinkId) })).json() as {
      bootstrapStackName: string;
    };

    expect(firstBody.bootstrapStackName).toBe(
      bootstrapStackName({ appName: 'Widget Suite', deploymentId: first.deployment.id, attempt: 0 }),
    );
    expect(secondBody.bootstrapStackName).toBe(
      bootstrapStackName({ appName: 'Widget Suite', deploymentId: second.deployment.id, attempt: 0 }),
    );
    expect(firstBody.bootstrapStackName).not.toBe(secondBody.bootstrapStackName);
  });

  it('POST /api/install/:installLinkId/launched moves NOT_INSTALLED to WAITING_FOR_RELAY and records the launch', async () => {
    const { deployment, installLinkId } = await seedWaiting();

    const response = await postJson(app, `/api/install/${installLinkId}/launched`, {}, await customerSessionHeaders(db, installLinkId));
    expect(response.statusCode).toBe(200);
    expect((response.json() as { state: string }).state).toBe('WAITING_FOR_RELAY');

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(dep!.state).toBe('WAITING_FOR_RELAY');
    expect(dep!.installStartedAt).not.toBeNull();
    expect(dep!.bootstrapStackName).toBe(
      bootstrapStackName({ appName: 'Widget Suite', deploymentId: deployment.id, attempt: 0 }),
    );

    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.deploymentId, deployment.id));
    expect(events.some((row) => row.eventType === 'install.launched')).toBe(true);
  });

  it('POST /api/install/:installLinkId/launched is idempotent while waiting', async () => {
    const { installLinkId } = await seedWaiting();

    const first = await postJson(app, `/api/install/${installLinkId}/launched`, {}, await customerSessionHeaders(db, installLinkId));
    const second = await postJson(app, `/api/install/${installLinkId}/launched`, {}, await customerSessionHeaders(db, installLinkId));
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
  });

  it('POST /api/install/:installLinkId/launched treats a browser body that tries to override requirements exactly like no body', async () => {
    const seeded = await seedWaiting();

    const response = await postJson(
      app,
      `/api/install/${seeded.installLinkId}/launched`,
      { databaseRequired: false, redisRequired: false, storageRequired: false },
      await customerSessionHeaders(db, seeded.installLinkId),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ state: 'WAITING_FOR_RELAY' });

    // The frozen manifest (postgres: true, redis: false) is what the relay
    // provisions against — the body's claims changed nothing.
    const payload = await enrollAndGetInstallPayload(seeded, 'inst-browser-override');
    expect(payload['databaseRequired']).toBe(true);
    expect(payload['redisRequired']).toBe(false);
  });

  it('review-then-confirm: PATCHing the application requirement columns after the install page was opened never reaches the plan or the INSTALL payload', async () => {
    const application = await insertApplication(db, org.organizationId, {
      name: 'Review Confirm App',
      databaseRequired: true,
      storageRequired: false,
    });
    await insertDeployableRelease(db, application.id);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      installationId: null,
    });
    const seeded = { deployment, installLinkId: deployment.installLinkId };

    // The customer opens the install page: the plan comes from the frozen
    // manifest (postgres: true, redis: false), never the application columns.
    const before = await installPlanNames(seeded.installLinkId);
    expect(before).toEqual(['Application', 'Secure endpoint', 'Database', 'Storage']);

    // The vendor then flips every requirement column through the normal
    // update endpoint — the review the customer already saw must not move.
    const patched = await sendJson(
      app,
      'PATCH',
      `/api/applications/${application.id}`,
      { databaseRequired: false, redisRequired: true, storageRequired: true },
      { cookie: org.cookie },
    );
    expect(patched.statusCode).toBe(200);

    expect(await installPlanNames(seeded.installLinkId)).toEqual(before);

    const launched = await postJson(app, `/api/install/${seeded.installLinkId}/launched`, {}, await customerSessionHeaders(db, seeded.installLinkId));
    expect(launched.statusCode).toBe(200);
    expect((launched.json() as { state: string }).state).toBe('WAITING_FOR_RELAY');

    const payload = await enrollAndGetInstallPayload(seeded, 'inst-review-confirm');
    expect(payload['databaseRequired']).toBe(true);
    expect(payload['redisRequired']).toBe(false);
  });

  it('live postgres and storage column flips after deployment creation leave the install plan and infrastructure expectations unchanged', async () => {
    const application = await insertApplication(db, org.organizationId, {
      name: 'Column Drift App',
      databaseRequired: true,
      storageRequired: false,
    });
    await insertDeployableRelease(db, application.id);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      installationId: null,
    });
    const seeded = { deployment, installLinkId: deployment.installLinkId };

    const before = await installPlanNames(seeded.installLinkId);
    expect(before).toEqual(['Application', 'Secure endpoint', 'Database', 'Storage']);

    // The Redis drift case lives in the install-plan suite above; this flips
    // postgres and storage directly on the live row after the deployment
    // froze its manifest.
    await db
      .update(schema.applications)
      .set({ databaseRequired: false, storageRequired: true })
      .where(eq(schema.applications.id, application.id));

    expect(await installPlanNames(seeded.installLinkId)).toEqual(before);

    const payload = await enrollAndGetInstallPayload(seeded, 'inst-column-drift');
    expect(payload['databaseRequired']).toBe(true);
  });

  it('an unknown stored manifest schemaVersion blocks launch and relay registration 422 before any job is created', async () => {
    const seeded = await seedWaiting({
      desiredState: { manifest: { ...READY_MANIFEST, schemaVersion: 2 } },
    });

    const launched = await postJson(app, `/api/install/${seeded.installLinkId}/launched`, {}, await customerSessionHeaders(db, seeded.installLinkId));
    expect(launched.statusCode).toBe(422);
    expect(errorEnvelopeSchema.parse(launched.json()).error.code).toBe('MANIFEST_NEEDS_CONFIGURATION');

    // The relay-enrollment boundary refuses the same deployment pre-AWS.
    const registered = await postJson(
      app,
      '/api/relay/register',
      { enrollmentCode: seeded.deployment.enrollmentCode, installationId: 'inst-unknown-schema' },
      { authorization: 'Bearer install-flow-relay-token' },
    );
    expect(registered.statusCode).toBe(422);
    expect(errorEnvelopeSchema.parse(registered.json()).error.code).toBe('MANIFEST_NEEDS_CONFIGURATION');

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, seeded.deployment.id));
    expect(dep!.state).toBe('NOT_INSTALLED');
    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, seeded.deployment.id));
    expect(jobs).toHaveLength(0);
  });

  it('a missing or invalid stored manifest blocks launch with the actionable error and leaves the install page at plan: null (no 500)', async () => {
    // The column is NOT NULL jsonb, so "missing" is the empty default and
    // "malformed" is a manifest value the schema rejects.
    for (const desiredState of [{}, { manifest: { invalid: true } }]) {
      const seeded = await seedWaiting({ desiredState });
      const launched = await postJson(app, `/api/install/${seeded.installLinkId}/launched`, {}, await customerSessionHeaders(db, seeded.installLinkId));
      expect(launched.statusCode).toBe(422);
      const envelope = errorEnvelopeSchema.parse(launched.json());
      expect(envelope.error.code).toBe('MANIFEST_NEEDS_CONFIGURATION');
      expect(envelope.error.message).toContain('manifest');

      const page = await app.inject({ method: 'GET', url: `/api/install/${seeded.installLinkId}`, headers: await customerSessionHeaders(db, seeded.installLinkId) });
      expect(page.statusCode).toBe(200);
      expect((page.json() as { plan: unknown }).plan).toBeNull();
    }
  });

  it.each([
    { label: 'postgres', postgres: true, redis: false },
    { label: 'postgres+redis', postgres: true, redis: true },
    { label: 'stateless', postgres: false, redis: false },
    { label: 'stateless+redis', postgres: false, redis: true },
  ])(
    'the frozen $label manifest drives the install plan, the Quick Create link, and the INSTALL payload',
    async ({ label, postgres, redis }) => {
      const seeded = await seedWaiting({
        desiredState: {
          manifest: {
            ...READY_MANIFEST,
            database: { postgres },
            // A migration command without a database is a configuration error.
            migration: { command: postgres ? READY_MANIFEST.migration.command : null },
            redis: { required: redis, envBindings: [] },
          },
        },
      });

      // env is read at module load, so publish a template for this test only.
      const mutableEnv = env as { bootstrapTemplateUrl: string | undefined };
      const previous = mutableEnv.bootstrapTemplateUrl;
      mutableEnv.bootstrapTemplateUrl = 'https://templates.example.com/bootstrap/v1/bootstrap-template-v1.json';
      let quickCreateUrl: string | null = null;
      try {
        const page = await app.inject({ method: 'GET', url: `/api/install/${seeded.installLinkId}`, headers: await customerSessionHeaders(db, seeded.installLinkId) });
        quickCreateUrl = (page.json() as { quickCreateUrl: string | null }).quickCreateUrl;
      } finally {
        mutableEnv.bootstrapTemplateUrl = previous;
      }
      // Every profile gets the same region's bootstrap template in the Quick
      // Create link — the profile selects the APPLICATION template variant,
      // and only through the INSTALL payload the relay reads.
      expect(quickCreateUrl).toContain('bootstrap-template-v1.json');

      expect(await installPlanNames(seeded.installLinkId)).toEqual([
        'Application',
        'Secure endpoint',
        ...(postgres ? ['Database'] : []),
        'Storage',
        ...(redis ? ['Cache'] : []),
      ]);

      const payload = await enrollAndGetInstallPayload(seeded, `inst-profile-${label}`);
      expect(payload['databaseRequired']).toBe(postgres);
      expect(payload['redisRequired']).toBe(redis);
    },
  );

  it('GET /api/relay/commands omits both requirement flags when the stored manifest is invalid', async () => {
    const token = 'invalid-manifest-relay-token';
    await seedWaiting({
      installationId: 'inst-invalid-manifest',
      relayTokenHash: hashRelayToken(token),
      desiredState: { manifest: { invalid: true } },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/relay/commands?installationId=inst-invalid-manifest',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const deployment = (response.json() as { deployment: Record<string, unknown> }).deployment;
    expect('databaseRequired' in deployment).toBe(false);
    expect('redisRequired' in deployment).toBe(false);
  });

  it('a sequential double launch records the launch exactly once and never queues a job', async () => {
    const seeded = await seedWaiting();
    const first = await postJson(app, `/api/install/${seeded.installLinkId}/launched`, {}, await customerSessionHeaders(db, seeded.installLinkId));
    const second = await postJson(app, `/api/install/${seeded.installLinkId}/launched`, {}, await customerSessionHeaders(db, seeded.installLinkId));
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ state: 'WAITING_FOR_RELAY' });

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, seeded.deployment.id));
    expect(dep!.state).toBe('WAITING_FOR_RELAY');

    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(
        and(
          eq(schema.eventLogs.eventType, 'install.launched'),
          eq(schema.eventLogs.deploymentId, seeded.deployment.id),
        ),
      );
    expect(events).toHaveLength(1);

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, seeded.deployment.id));
    expect(jobs).toHaveLength(0);
  });

  it('a double submit (two tabs racing) transitions exactly once', async () => {
    const seeded = await seedWaiting();
    const [first, second] = await Promise.all([
      postJson(app, `/api/install/${seeded.installLinkId}/launched`, {}, await customerSessionHeaders(db, seeded.installLinkId)),
      postJson(app, `/api/install/${seeded.installLinkId}/launched`, {}, await customerSessionHeaders(db, seeded.installLinkId)),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // Both tabs land on the waiting state — the loser sees the winner's state.
    expect(first.json()).toEqual({ state: 'WAITING_FOR_RELAY' });
    expect(second.json()).toEqual({ state: 'WAITING_FOR_RELAY' });

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, seeded.deployment.id));
    expect(dep!.state).toBe('WAITING_FOR_RELAY');

    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(
        and(
          eq(schema.eventLogs.eventType, 'install.launched'),
          eq(schema.eventLogs.deploymentId, seeded.deployment.id),
        ),
      );
    expect(events).toHaveLength(1);
  });

  it('marks the install relay-stuck (never FAILED) when no relay enrolls within the staleness window', async () => {
    const { deployment, installLinkId } = await seedWaiting({
      state: 'WAITING_FOR_RELAY',
      installStartedAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    const body = (
      await app.inject({ method: 'GET', url: `/api/install/${installLinkId}`, headers: await customerSessionHeaders(db, installLinkId) })
    ).json() as { deploymentState: string; waitingForRelay: boolean; relayStuck: boolean };
    expect(body.deploymentState).toBe('WAITING_FOR_RELAY');
    expect(body.waitingForRelay).toBe(true);
    expect(body.relayStuck).toBe(true);

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(dep!.state).toBe('WAITING_FOR_RELAY');
  });

  it('relay registration from WAITING_FOR_RELAY moves to INSTALLING and queues the first INSTALL job', async () => {
    const { deployment } = await seedWaiting({ state: 'WAITING_FOR_RELAY' });
    const rows = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id));
    const enrollmentCode = rows[0]!.enrollmentCode;

    const response = await postJson(
      app,
      '/api/relay/register',
      { enrollmentCode, installationId: 'inst-waiting-relay' },
      { authorization: 'Bearer waiting-relay-token' },
    );
    expect(response.statusCode).toBe(200);

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(dep!.state).toBe('INSTALLING');
    expect(dep!.relayBoundAt).not.toBeNull();

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.type).toBe('INSTALL');
    expect(jobs[0]!.state).toBe('REQUESTED');
  });

  it('POST /api/install/:installLinkId/retry starts a fresh attempt: new code, same connector stack, dead jobs cancelled', async () => {
    const { deployment, installLinkId } = await seedWaiting({
      state: 'WAITING_FOR_RELAY',
      installationId: 'inst-old-attempt',
      enrollmentUsedAt: null,
    });
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'INSTALL',
      state: 'REQUESTED',
      idempotencyKey: `${deployment.id}:INSTALL`,
      payload: {},
      requestedBy: null,
    });
    const oldStackName = bootstrapStackName({
      appName: 'Widget Suite',
      deploymentId: deployment.id,
      attempt: 0,
    });
    await db
      .update(schema.deployments)
      .set({ bootstrapStackName: oldStackName, installStartedAt: new Date(Date.now() - 20 * 60 * 1000) })
      .where(eq(schema.deployments.id, deployment.id));

    const response = await postJson(app, `/api/install/${installLinkId}/retry`, {}, await customerSessionHeaders(db, installLinkId));
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      state: string;
      attemptNumber: number;
      bootstrapStackName: string;
      quickCreateUrl: string | null;
    };
    expect(body.state).toBe('NOT_INSTALLED');
    expect(body.attemptNumber).toBe(1);
    // A connector registered (installationId set): the retry keeps its stack.
    expect(body.bootstrapStackName).toBe(oldStackName);
    expect(body.quickCreateUrl).toBeNull();

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(dep!.state).toBe('NOT_INSTALLED');
    expect(dep!.installationId).toBeNull();
    expect(dep!.enrollmentUsedAt).toBeNull();
    expect(dep!.attemptNumber).toBe(1);
    expect(dep!.installStartedAt).toBeNull();
    expect(dep!.enrollmentCode).not.toBe(deployment.enrollmentCode);

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    expect(jobs[0]!.state).toBe('CANCELLED');

    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.deploymentId, deployment.id));
    expect(events.some((row) => row.eventType === 'install.retry.requested')).toBe(true);
  });

  it('the install link id alone shows only who sent it: no details, no enrollment material, no retry', async () => {
    const { deployment, installLinkId } = await seedWaiting({
      state: 'NOT_INSTALLED',
      relayCredential: 'withheld-relay-credential',
    });
    const mutableEnv = env as { bootstrapTemplateUrl: string | undefined };
    const previous = mutableEnv.bootstrapTemplateUrl;
    mutableEnv.bootstrapTemplateUrl = 'https://templates.example.com/bootstrap-v1.json';
    try {
      // The old fragment token is no longer a credential (docs/customer-access.md).
      for (const headers of [{}, linkTokenHeader(installLinkId)]) {
        const bare = await app.inject({ method: 'GET', url: `/api/install/${installLinkId}`, headers });
        expect(bare.statusCode).toBe(200);
        const bareBody = bare.json() as Record<string, unknown>;
        expect(Object.keys(bareBody).sort()).toEqual(['applicationName', 'publisherName', 'signInRequired']);
        expect(JSON.stringify(bareBody)).not.toContain(deployment.enrollmentCode);
        expect(JSON.stringify(bareBody)).not.toContain('withheld-relay-credential');
      }

      const owner = await app.inject({
        method: 'GET',
        url: `/api/install/${installLinkId}`,
        headers: await customerSessionHeaders(db, installLinkId),
      });
      expect(String((owner.json() as Record<string, unknown>)['quickCreateUrl'])).toContain(deployment.enrollmentCode);
    } finally {
      mutableEnv.bootstrapTemplateUrl = previous;
    }

    for (const route of ['status', 'overview']) {
      const read = await app.inject({ method: 'GET', url: `/api/install/${installLinkId}/${route}` });
      expect(read.statusCode).toBe(404);
    }
    for (const headers of [{}, linkTokenHeader(installLinkId)]) {
      const retry = await postJson(app, `/api/install/${installLinkId}/retry`, {}, headers);
      expect(retry.statusCode).toBe(404);
    }
    const [unchanged] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(unchanged!.enrollmentCode).toBe(deployment.enrollmentCode);
    expect(unchanged!.relayCredential).toBe(deployment.relayCredential);
  });

  it('POST /api/install/:installLinkId/retry refuses while a connected relay runs the INSTALL', async () => {
    const { deployment, installLinkId } = await seedWaiting({
      state: 'INSTALLING',
      installationId: 'inst-running-install',
      relayStatus: 'CONNECTED',
      enrollmentUsedAt: new Date(),
    });
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'INSTALL',
      state: 'RUNNING',
      idempotencyKey: `${deployment.id}:INSTALL`,
      payload: {},
      requestedBy: null,
    });

    const response = await postJson(app, `/api/install/${installLinkId}/retry`, {}, await customerSessionHeaders(db, installLinkId));
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'INSTALL_IN_PROGRESS' } });
    const [unchanged] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(unchanged!.enrollmentCode).toBe(deployment.enrollmentCode);
    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    expect(job!.state).toBe('RUNNING');
  });

  it('POST /api/install/:installLinkId/retry refuses a deployment that already installed successfully', async () => {
    const { deployment, installLinkId } = await seedWaiting({ state: 'HEALTHY' });
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'INSTALL',
      state: 'SUCCEEDED',
      idempotencyKey: `${deployment.id}:INSTALL`,
      payload: {},
      requestedBy: null,
    });

    const response = await postJson(app, `/api/install/${installLinkId}/retry`, {}, await customerSessionHeaders(db, installLinkId));
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'INSTALL_ALREADY_SUCCEEDED' } });
  });

  it('two concurrent first registrations with one enrollment code admit exactly one relay', async () => {
    const seeded = await seedWaiting({ state: 'WAITING_FOR_RELAY', enrollmentUsedAt: null });
    const register = (installationId: string, token: string) =>
      postJson(
        app,
        '/api/relay/register',
        { enrollmentCode: seeded.deployment.enrollmentCode, installationId },
        { authorization: `Bearer ${token}` },
      );
    const results = await Promise.all([register('inst-race-a', 'race-token-a'), register('inst-race-b', 'race-token-b')]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, seeded.deployment.id));
    const winner = results[0]!.statusCode === 200 ? 'inst-race-a' : 'inst-race-b';
    expect(dep!.installationId).toBe(winner);
    const connected = await db
      .select()
      .from(schema.eventLogs)
      .where(and(eq(schema.eventLogs.deploymentId, seeded.deployment.id), eq(schema.eventLogs.eventType, 'relay.connected')));
    expect(connected).toHaveLength(1);
  });

  it('POST /api/install/:installLinkId/retry refuses a deployment that is being removed', async () => {
    const deleting = await seedWaiting({ state: 'DELETING', installationId: 'inst-removing' });
    const removing = await postJson(app, `/api/install/${deleting.installLinkId}/retry`, {}, await customerSessionHeaders(db, deleting.installLinkId));
    expect(removing.statusCode, removing.body).toBe(410);
    expect(removing.json()).toMatchObject({ error: { code: 'INSTALL_LINK_REVOKED' } });
    const [untouched] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deleting.deployment.id));
    expect(untouched!.state).toBe('DELETING');
    expect(untouched!.installationId).toBe('inst-removing');
  });

  it('POST /api/install/:installLinkId/retry refuses a failed install: the vendor owns that retry', async () => {
    const failed = await seedWaiting({ state: 'FAILED', installationId: 'inst-failed' });
    const response = await postJson(app, `/api/install/${failed.installLinkId}/retry`, {}, await customerSessionHeaders(db, failed.installLinkId));
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'INSTALL_NOT_RETRYABLE' } });
  });

  it('POST /api/install/:installLinkId/retry 404s for an unknown link', async () => {
    const response = await postJson(app, `/api/install/${crypto.randomUUID()}/retry`, {});
    expect(response.statusCode).toBe(404);
  });

  it('POST /api/install/:installLinkId/retry records previousInstallationId and previousBootstrapStackName before nulling installationId', async () => {
    const { deployment, installLinkId } = await seedWaiting({
      state: 'WAITING_FOR_RELAY',
      installationId: 'inst-to-be-replaced',
      enrollmentUsedAt: null,
    });
    const oldStackName = bootstrapStackName({
      appName: 'Widget Suite',
      deploymentId: deployment.id,
      attempt: 0,
    });
    await db
      .update(schema.deployments)
      .set({ bootstrapStackName: oldStackName, installStartedAt: new Date(Date.now() - 20 * 60 * 1000) })
      .where(eq(schema.deployments.id, deployment.id));
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'INSTALL',
      state: 'RUNNING',
      idempotencyKey: `${deployment.id}:INSTALL`,
      payload: {},
      requestedBy: null,
    });

    const response = await postJson(app, `/api/install/${installLinkId}/retry`, {}, await customerSessionHeaders(db, installLinkId));
    expect(response.statusCode).toBe(200);

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(dep!.installationId).toBeNull();
    expect(dep!.previousInstallationId).toBe('inst-to-be-replaced');
    expect(dep!.previousBootstrapStackName).toBe(oldStackName);
  });

  it('POST /api/install/:installLinkId/retry with installationId already null writes no previousInstallationId', async () => {
    const { deployment, installLinkId } = await seedWaiting({
      state: 'WAITING_FOR_RELAY',
      installationId: null,
      enrollmentUsedAt: null,
    });

    const response = await postJson(app, `/api/install/${installLinkId}/retry`, {}, await customerSessionHeaders(db, installLinkId));
    expect(response.statusCode).toBe(200);

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(dep!.installationId).toBeNull();
    // previousInstallationId stays as it was — the retry should not write it when installationId was already null.
    expect(dep!.previousInstallationId).toBeNull();
  });

  it('install retry of an install whose connector registered keeps the stack and offers an update, then re-enrolls the same installation with recovery', async () => {
    const stackName = 'deployz-bootstrap-widget-suite-keep-0';
    const { deployment, installLinkId } = await seedWaiting({
      state: 'INSTALLING',
      installationId: 'inst-keep',
      bootstrapStackName: stackName,
      enrollmentUsedAt: new Date(),
      relayStatus: 'CONNECTED',
    });
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'INSTALL',
      state: 'FAILED',
      idempotencyKey: `${deployment.id}:INSTALL`,
      payload: {},
      requestedBy: null,
    });

    const response = await postJson(app, `/api/install/${installLinkId}/retry`, {}, await customerSessionHeaders(db, installLinkId));
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as {
      bootstrapStackName: string;
      quickCreateUrl: string | null;
      existingStackUpdate: { stackName: string; enrollmentCode: string; relayCredential: string | null };
    };
    expect(body.bootstrapStackName).toBe(stackName);
    expect(body.quickCreateUrl).toBeNull();
    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(body.existingStackUpdate).toMatchObject({
      stackName,
      enrollmentCode: dep!.enrollmentCode,
      relayCredential: dep!.relayCredential,
    });
    expect(dep!.previousInstallationId).toBe('inst-keep');

    const registered = await postJson(
      app,
      '/api/relay/register',
      { enrollmentCode: dep!.enrollmentCode, installationId: 'inst-keep' },
      { authorization: `Bearer ${dep!.relayCredential}` },
    );
    expect(registered.statusCode, registered.body).toBe(200);
    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(and(eq(schema.deploymentJobs.deploymentId, deployment.id), eq(schema.deploymentJobs.state, 'REQUESTED')));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({ recovery: { neverInstalled: true } });
    const [enrolled] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(enrolled!.installationId).toBe('inst-keep');
    expect(enrolled!.bootstrapStackName).toBe(stackName);
  });

  it('install retry of an install whose connector never registered gives a fresh Quick Create and no recovery', async () => {
    const stackName = 'deployz-bootstrap-widget-suite-fresh-0';
    const { deployment, installLinkId } = await seedWaiting({
      state: 'WAITING_FOR_RELAY',
      installationId: null,
      bootstrapStackName: stackName,
    });
    const response = await postJson(app, `/api/install/${installLinkId}/retry`, {}, await customerSessionHeaders(db, installLinkId));
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as {
      bootstrapStackName: string;
      quickCreateUrl: string | null;
      existingStackUpdate: unknown;
    };
    expect(body.bootstrapStackName).not.toBe(stackName);
    expect(body.existingStackUpdate).toBeNull();

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    const page = (await app.inject({ method: 'GET', url: `/api/install/${installLinkId}`, headers: await customerSessionHeaders(db, installLinkId) })).json() as {
      quickCreateUrl: string | null;
    };
    expect(page.quickCreateUrl).not.toBeNull();
    const registered = await postJson(
      app,
      '/api/relay/register',
      { enrollmentCode: dep!.enrollmentCode, installationId: 'inst-new-stack' },
      { authorization: `Bearer ${dep!.relayCredential}` },
    );
    expect(registered.statusCode, registered.body).toBe(200);
    const [job] = await db
      .select()
      .from(schema.deploymentJobs)
      .where(and(eq(schema.deploymentJobs.deploymentId, deployment.id), eq(schema.deploymentJobs.state, 'REQUESTED')));
    expect(job!.payload).not.toHaveProperty('recovery');
  });

  it('relay/reset bumps the attempt, recomputes the stack name, and returns a never-installed deployment to NOT_INSTALLED', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Reset App' });
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'FAILED',
      installationId: 'inst-reset-test',
      relayStatus: 'DISCONNECTED',
    });
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'INSTALL',
      state: 'REQUESTED',
      idempotencyKey: `${deployment.id}:INSTALL`,
      payload: {},
      requestedBy: null,
    });

    const response = await postJson(app, `/api/deployments/${deployment.id}/relay/reset`, {}, { cookie: org.cookie });
    expect(response.statusCode).toBe(200);

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(dep!.state).toBe('NOT_INSTALLED');
    expect(dep!.attemptNumber).toBe(1);
    expect(dep!.installationId).toBeNull();
    expect(dep!.installStartedAt).toBeNull();
    expect(dep!.bootstrapStackName).toBe(
      bootstrapStackName({ appName: 'Reset App', deploymentId: deployment.id, attempt: 1 }),
    );

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    expect(jobs[0]!.state).toBe('CANCELLED');
  });

  it('relay/reset keeps a healthy deployment in place (credential rotation only)', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Healthy Reset App' });
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'HEALTHY',
    });
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'INSTALL',
      state: 'SUCCEEDED',
      idempotencyKey: `${deployment.id}:INSTALL`,
      payload: {},
      requestedBy: null,
    });

    const response = await postJson(app, `/api/deployments/${deployment.id}/relay/reset`, {}, { cookie: org.cookie });
    expect(response.statusCode).toBe(200);

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(dep!.state).toBe('HEALTHY');
    expect(dep!.attemptNumber).toBe(1);
    expect(dep!.installationId).toBeNull();
    expect(dep!.enrollmentCode).not.toBe(deployment.enrollmentCode);
  });

  it('relay/reset renews an expired install link so the customer can open it again', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Expired Link App' });
    await insertDeployableRelease(db, application.id);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'FAILED',
      installationId: 'inst-expired-link',
      enrollmentUsedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      installLinkExpiresAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    });

    const reset = await postJson(app, `/api/deployments/${deployment.id}/relay/reset`, {}, { cookie: org.cookie });
    expect(reset.statusCode, reset.body).toBe(200);

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(dep!.installLinkExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
    const page = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}`, headers: await customerSessionHeaders(db, deployment.installLinkId) });
    expect(page.statusCode, page.body).toBe(200);
  });

  it('relay/reset of an installed deployment offers an update of the existing connector stack, never a Quick Create', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Update Reset App' });
    const customer = await insertCustomer(db, org.organizationId);
    const installLinkId = crypto.randomUUID();
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'HEALTHY',
      installLinkId,
      installationId: 'inst-installed',
      bootstrapStackName: 'deployz-update-reset-app-1',
      enrollmentUsedAt: new Date(),
    });
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'INSTALL',
      state: 'SUCCEEDED',
      idempotencyKey: `${deployment.id}:INSTALL`,
      payload: {},
      requestedBy: null,
    });
    const reset = await postJson(app, `/api/deployments/${deployment.id}/relay/reset`, {}, { cookie: org.cookie });
    expect(reset.statusCode).toBe(200);
    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(dep!.bootstrapStackName).toBe('deployz-update-reset-app-1');

    const page = (await app.inject({ method: 'GET', url: `/api/install/${installLinkId}`, headers: await customerSessionHeaders(db, installLinkId) })).json() as {
      quickCreateUrl: string | null;
      existingStackUpdate: Record<string, unknown> | null;
    };
    expect(page.quickCreateUrl).toBeNull();
    expect(page.existingStackUpdate).toMatchObject({
      stackName: 'deployz-update-reset-app-1',
      enrollmentCode: dep!.enrollmentCode,
      relayCredential: dep!.relayCredential,
    });
    expect(String(page.existingStackUpdate!.consoleUrl)).toContain('filteringText=deployz-update-reset-app-1');
  });

  it('relay/reset of a never-installed deployment drops the certificate requested for the dead attempt', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Early Cert Reset App' });
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'FAILED',
      defaultHttps: {
        hostname: 'd-early.deployz.dev',
        status: 'WAITING_FOR_DNS',
        certificateArn: 'arn:aws:acm:us-east-1:1:certificate/early',
        validationName: '_x.d-early.deployz.dev',
        validationValue: '_y.acm-validations.aws.',
        checkCycle: 2,
        lastError: null,
      },
    });
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'CONFIGURE_DOMAIN',
      state: 'REQUESTED',
      idempotencyKey: `${deployment.id}:CONFIGURE_DOMAIN:default-https:2`,
      payload: {},
      requestedBy: null,
    });

    const reset = await postJson(app, `/api/deployments/${deployment.id}/relay/reset`, {}, { cookie: org.cookie });
    expect(reset.statusCode).toBe(200);

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(dep!.defaultHttps).toBeNull();
    const [job] = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    expect(job!.state).toBe('CANCELLED');
  });

  it('relay/reset cancels a RUNNING or WAITING default-HTTPS job of the revoked connector', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Running Cert Reset App' });
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'FAILED',
      defaultHttps: { hostname: 'd-running.deployz.dev', status: 'PENDING', checkCycle: 1, lastError: null },
    });
    for (const [cycle, state] of [[0, 'RUNNING'], [1, 'WAITING']] as const) {
      await db.insert(schema.deploymentJobs).values({
        deploymentId: deployment.id,
        type: 'CONFIGURE_DOMAIN',
        state,
        idempotencyKey: `${deployment.id}:CONFIGURE_DOMAIN:default-https:${cycle}`,
        payload: {},
        requestedBy: null,
      });
    }

    const reset = await postJson(app, `/api/deployments/${deployment.id}/relay/reset`, {}, { cookie: org.cookie });
    expect(reset.statusCode).toBe(200);

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    expect(jobs.map((job) => job.state)).toEqual(['CANCELLED', 'CANCELLED']);
  });

  it('relay/reset of a never-installed deployment keeps a Quick Create link with a fresh stack name', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Fresh Reset App' });
    const customer = await insertCustomer(db, org.organizationId);
    const installLinkId = crypto.randomUUID();
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'FAILED',
      installLinkId,
      bootstrapStackName: 'deployz-fresh-reset-app-0',
    });
    const reset = await postJson(app, `/api/deployments/${deployment.id}/relay/reset`, {}, { cookie: org.cookie });
    expect(reset.statusCode).toBe(200);
    const page = (await app.inject({ method: 'GET', url: `/api/install/${installLinkId}`, headers: await customerSessionHeaders(db, installLinkId) })).json() as {
      quickCreateUrl: string | null;
      existingStackUpdate: unknown;
    };
    expect(page.existingStackUpdate).toBeNull();
    expect(page.quickCreateUrl).not.toBeNull();
  });

  it('relay/reset records the PREVIOUS installationId/bootstrapStackName for a later purge (§9.6)', async () => {
    const application = await insertApplication(db, org.organizationId, { name: 'Reset Tracking App' });
    const customer = await insertCustomer(db, org.organizationId);
    const oldInstallationId = 'inst-orphan-candidate';
    const oldBootstrapStack = 'deployz-bootstrap-old-attempt';
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'FAILED',
      installationId: oldInstallationId,
      bootstrapStackName: oldBootstrapStack,
      relayStatus: 'DISCONNECTED',
    });
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'INSTALL',
      state: 'REQUESTED',
      idempotencyKey: `${deployment.id}:INSTALL`,
      payload: {},
      requestedBy: null,
    });

    const response = await postJson(app, `/api/deployments/${deployment.id}/relay/reset`, {}, { cookie: org.cookie });
    expect(response.statusCode).toBe(200);

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(dep!.installationId).toBeNull();
    expect(dep!.previousInstallationId).toBe(oldInstallationId);
    expect(dep!.previousBootstrapStackName).toBe(oldBootstrapStack);

    // The reset's event payload carries the same attribution for the audit trail.
    const events = await db
      .select({ payload: schema.eventLogs.payload })
      .from(schema.eventLogs)
      .where(
        and(
          eq(schema.eventLogs.deploymentId, deployment.id),
          eq(schema.eventLogs.eventType, 'relay.reenrollment.requested'),
        ),
      );
    expect(events[0]?.payload).toMatchObject({
      previousInstallationId: oldInstallationId,
      previousBootstrapStackName: oldBootstrapStack,
    });
  });

  it('serves the same §24 component view on the install page as the fleet row', async () => {
    const application = await insertApplication(db, org.organizationId, {
      name: 'Component Parity App',
      databaseRequired: true,
    });
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'HEALTHY',
      enrollmentUsedAt: new Date(),
      observedState: {
        components: { application: 'HEALTHY' },
        infraHealth: { checks: [{ name: 'database', passed: true }] },
      },
    });

    const installBody = (
      await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}`, headers: await customerSessionHeaders(db, deployment.installLinkId) })
    ).json() as { components: Record<string, string> | null; alreadyInstalled: boolean };
    expect(installBody.alreadyInstalled).toBe(true);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}`,
      headers: { cookie: org.cookie },
    });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json() as { components: Record<string, string> | null };

    expect(installBody.components).toStrictEqual(detailBody.components);
  });
});

// ── POST /api/deployments/:id/retry-install — first-install recovery ────────
describe('server — retry-install (first-install recovery)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };

  async function seedFailedInstall(
    overrides: Partial<typeof schema.deployments.$inferInsert> = {},
    jobOverrides: Partial<typeof schema.deploymentJobs.$inferInsert> = {},
  ): Promise<typeof schema.deployments.$inferSelect> {
    const application = await insertApplication(db, org.organizationId);
    await insertDeployableRelease(db, application.id);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'FAILED',
      installationId: `inst-recovery-${crypto.randomUUID()}`,
      ...overrides,
    });
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'INSTALL',
      state: 'FAILED',
      idempotencyKey: `${deployment.id}:INSTALL`,
      payload: {},
      requestedBy: null,
      ...jobOverrides,
    });
    return deployment;
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'retry-install@example.com');
    app = await buildServer({ auth, db });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('202s from FAILED: queues a fresh INSTALL job carrying recovery, moves to INSTALLING, logs the event', async () => {
    const deployment = await seedFailedInstall();

    const response = await postJson(app, `/api/deployments/${deployment.id}/retry-install`, {}, { cookie: org.cookie });
    expect(response.statusCode).toBe(202);
    const { jobId } = response.json() as { jobId: string };

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(dep!.state).toBe('INSTALLING');

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(and(eq(schema.deploymentJobs.deploymentId, deployment.id), eq(schema.deploymentJobs.type, 'INSTALL')));
    expect(jobs).toHaveLength(2);
    const retry = jobs.find((j) => j.id === jobId)!;
    expect(retry.state).toBe('REQUESTED');
    expect(retry.idempotencyKey).toBe(`${deployment.id}:INSTALL:RETRY:1`);
    // §31 parameters travel alongside recovery — see install-parameters.test.ts
    // for the parameter-value coverage.
    expect(retry.payload).toMatchObject({ recovery: { neverInstalled: true } });
    expect(retry.payload['parameters']).toBeTypeOf('object');

    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(and(eq(schema.eventLogs.deploymentId, deployment.id), eq(schema.eventLogs.eventType, 'install.retry.requested')));
    expect(events).toHaveLength(1);
    expect(events[0]!.result).toBe('pending');
  });

  it('a double-click reuses the same retry job (200, no second job)', async () => {
    const deployment = await seedFailedInstall();

    const first = await postJson(app, `/api/deployments/${deployment.id}/retry-install`, {}, { cookie: org.cookie });
    expect(first.statusCode).toBe(202);
    const second = await postJson(app, `/api/deployments/${deployment.id}/retry-install`, {}, { cookie: org.cookie });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { jobId: string }).jobId).toBe((first.json() as { jobId: string }).jobId);

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(and(eq(schema.deploymentJobs.deploymentId, deployment.id), eq(schema.deploymentJobs.type, 'INSTALL')));
    expect(jobs).toHaveLength(2);
  });

  it('409s when any earlier INSTALL ever succeeded — recovery must stay destructive-only-for-never-installed', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'FAILED',
      installationId: 'inst-once-healthy',
    });
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'INSTALL',
      state: 'SUCCEEDED',
      idempotencyKey: `${deployment.id}:INSTALL`,
      payload: {},
      requestedBy: null,
    });

    const response = await postJson(app, `/api/deployments/${deployment.id}/retry-install`, {}, { cookie: org.cookie });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'INSTALL_ALREADY_SUCCEEDED' } });
  });

  it('409s when the deployment is not in a retryable state', async () => {
    const deployment = await seedFailedInstall({ state: 'NOT_INSTALLED', installationId: null });

    const response = await postJson(app, `/api/deployments/${deployment.id}/retry-install`, {}, { cookie: org.cookie });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'INSTALL_NOT_RETRYABLE' } });
  });

  it('409s (RELAY_NOT_CONNECTED) when no relay is bound to a FAILED deployment', async () => {
    const deployment = await seedFailedInstall({ installationId: null });

    const response = await postJson(app, `/api/deployments/${deployment.id}/retry-install`, {}, { cookie: org.cookie });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'RELAY_NOT_CONNECTED' } });
  });

  // A dead relay never picks the retry job up; the watchdog would re-fail the
  // deployment an hour later. The recovery for a dead relay is
  // re-enrollment (relay/reset), which the UI can point to only if this
  // route refuses.
  it('409s (RELAY_DISCONNECTED) when the bound relay is dead — re-enrollment, not another job', async () => {
    const deployment = await seedFailedInstall({ relayStatus: 'DISCONNECTED' });

    const response = await postJson(app, `/api/deployments/${deployment.id}/retry-install`, {}, { cookie: org.cookie });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'RELAY_DISCONNECTED' } });
  });

  // The same Phase 3/5 gate the register route runs — without it, a FAILED
  // deployment with no usable stored manifest fails inside buildInstallPayload
  // with a bare 422 and no guidance instead of this named error.
  it('422s MANIFEST_NEEDS_CONFIGURATION when the FAILED deployment has no valid stored manifest — same error as the register route', async () => {
    const deployment = await seedFailedInstall({ desiredState: {} });

    const response = await postJson(app, `/api/deployments/${deployment.id}/retry-install`, {}, { cookie: org.cookie });
    expect(response.statusCode).toBe(422);
    const body = response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('MANIFEST_NEEDS_CONFIGURATION');
    expect(body.error.message).toBe(
      'Deployment has no valid deployment manifest. Run analysis or correct the application configuration first.',
    );

    // No job or state change from the refused attempt.
    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    expect(dep!.state).toBe('FAILED');
    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(and(eq(schema.deploymentJobs.deploymentId, deployment.id), eq(schema.deploymentJobs.type, 'INSTALL')));
    expect(jobs).toHaveLength(1);
  });

  it('409s while a fresh INSTALL attempt is still in flight', async () => {
    const deployment = await seedFailedInstall({ state: 'INSTALLING' }, { state: 'RUNNING', startedAt: new Date() });

    const response = await postJson(app, `/api/deployments/${deployment.id}/retry-install`, {}, { cookie: org.cookie });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'INSTALL_NOT_RETRYABLE' } });
  });

  it('supersedes a stale RUNNING install (dead relay invocation) and cancels the old job', async () => {
    const deployment = await seedFailedInstall(
      { state: 'INSTALLING' },
      { state: 'RUNNING', startedAt: new Date(Date.now() - 31 * 60 * 1000) },
    );

    const response = await postJson(app, `/api/deployments/${deployment.id}/retry-install`, {}, { cookie: org.cookie });
    expect(response.statusCode).toBe(202);

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(and(eq(schema.deploymentJobs.deploymentId, deployment.id), eq(schema.deploymentJobs.type, 'INSTALL')));
    expect(jobs.find((j) => j.idempotencyKey === `${deployment.id}:INSTALL`)!.state).toBe('CANCELLED');
    expect(jobs.find((j) => j.idempotencyKey === `${deployment.id}:INSTALL:RETRY:1`)!.state).toBe('REQUESTED');
  });
});

// ── §59: composed infrastructure inventory ───────────────────────────────────
describe('server — infrastructure inventory (§59)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };
  let applicationId: string;
  let customerId: string;
  const STACK_ID = 'arn:aws:cloudformation:us-east-1:123456789012:stack/deployz-app/test';
  const RELAY_TOKEN = 'infra-relay-token';

  interface InfraBody {
    provider: string;
    region: string;
    stackStatus: string | null;
    connectionState: string;
    snapshotState: string;
    summary: { status: string; componentCount: number; technicalResourceCount: number };
    components: Array<{
      kind: string;
      name: string;
      purpose: string;
      status: string;
      awsService: string;
      region: string;
      lifecycle: string;
      resources: Array<{
        logicalId: string;
        physicalId: string | null;
        type: string;
        status: string;
        statusReason: string | null;
      }>;
    }>;
    lastUpdatedAt: string | null;
    disconnectWarning: { lastVerifiedAt: string } | null;
    expectations: {
      schemaVersion: 1;
      components: Array<{ kind: string; expected: boolean; present: boolean }>;
      missing: string[];
      unexpected: string[];
    } | null;
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'infra-org@example.com');
    app = await buildServer({ auth, db });

    const application = await insertApplication(db, org.organizationId);
    applicationId = application.id;
    await insertDeployableRelease(db, applicationId);
    const customer = await insertCustomer(db, org.organizationId);
    customerId = customer.id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  async function newDeployment(
    overrides: Partial<typeof schema.deployments.$inferInsert> = {},
  ): Promise<typeof schema.deployments.$inferSelect> {
    return insertDeployment(db, org.organizationId, applicationId, customerId, overrides);
  }

  async function getInfrastructure(
    deploymentId: string,
    headers: Record<string, string> = {},
  ): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> {
    return app.inject({
      method: 'GET',
      url: `/api/deployments/${deploymentId}/infrastructure`,
      headers,
    });
  }

  async function persistRows(
    deploymentId: string,
    resources: Array<{ logicalId: string; type: string; status: string; statusReason?: string }>,
    observedAt: string,
  ): Promise<void> {
    await persistDeploymentResourceSnapshot(db, {
      deploymentId,
      stackId: STACK_ID,
      resources,
      observedAt,
    });
  }

  async function bindRelay(
    deploymentId: string,
    installationId: string,
  ): Promise<void> {
    const [deployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deploymentId));
    const register = await postJson(
      app,
      '/api/relay/register',
      { enrollmentCode: deployment!.enrollmentCode, installationId },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(register.statusCode, register.body).toBe(200);
  }

  it('primary service — a task definition, roles and a worker service never make the application ready', async () => {
    const deployment = await newDeployment({
      state: 'HEALTHY',
      relayStatus: 'CONNECTED',
      lastHealthAt: new Date(),
    });
    await persistRows(
      deployment.id,
      [
        { logicalId: 'TaskDef', type: 'AWS::ECS::TaskDefinition', status: 'CREATE_COMPLETE' },
        { logicalId: 'TaskRole', type: 'AWS::IAM::Role', status: 'CREATE_COMPLETE' },
        { logicalId: 'WorkerService', type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
      ],
      new Date().toISOString(),
    );
    const missing = (await getInfrastructure(deployment.id, { cookie: org.cookie })).json() as InfraBody;
    expect(missing.components.find((c) => c.kind === 'application')!.status).toBe('unknown');
    expect(missing.summary.status).toBe('unknown');
    expect(missing.expectations?.missing).toContain('application');

    await persistRows(
      deployment.id,
      [
        { logicalId: 'TaskDef', type: 'AWS::ECS::TaskDefinition', status: 'CREATE_COMPLETE' },
        { logicalId: WEB_SERVICE_ID, type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
      ],
      new Date().toISOString(),
    );
    const present = (await getInfrastructure(deployment.id, { cookie: org.cookie })).json() as InfraBody;
    expect(present.components.find((c) => c.kind === 'application')!.status).toBe('ready');
    expect(present.expectations?.missing ?? []).not.toContain('application');
  });

  it('authorization — 401 without a session, 404 for another organization', async () => {
    const deployment = await newDeployment();
    const url = `/api/deployments/${deployment.id}/infrastructure`;

    const unauth = await app.inject({ method: 'GET', url });
    expect(unauth.statusCode).toBe(401);

    const snooper = await signUpAndGetOrg(auth, db, 'infra-snooper@example.com');
    const crossOrg = await app.inject({ method: 'GET', url, headers: { cookie: snooper.cookie } });
    expect(crossOrg.statusCode).toBe(404);
  });

  it('healthy — all-ready rows serve a healthy summary, fresh and connected', async () => {
    const deployment = await newDeployment({
      state: 'HEALTHY',
      relayStatus: 'CONNECTED',
      lastHealthAt: new Date(),
      observedState: { infraHealth: { provisioning: { stackStatus: 'CREATE_COMPLETE' } } },
    });
    await persistRows(
      deployment.id,
      [
        { logicalId: WEB_SERVICE_ID, type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
        { logicalId: 'Database', type: 'AWS::RDS::DBInstance', status: 'CREATE_COMPLETE' },
        { logicalId: 'AppBucket', type: 'AWS::S3::Bucket', status: 'CREATE_COMPLETE' },
      ],
      new Date().toISOString(),
    );

    const response = await getInfrastructure(deployment.id, { cookie: org.cookie });
    expect(response.statusCode).toBe(200);
    const body = response.json() as InfraBody;

    expect(body.provider).toBe('aws');
    expect(body.region).toBe('us-east-1');
    expect(body.stackStatus).toBe('CREATE_COMPLETE');
    expect(body.connectionState).toBe('connected');
    expect(body.snapshotState).toBe('fresh');
    expect(body.summary).toEqual({ status: 'healthy', componentCount: 3, technicalResourceCount: 3 });
    expect(body.components.map((c) => [c.kind, c.status])).toEqual([
      ['application', 'ready'],
      ['database', 'ready'],
      ['storage', 'ready'],
    ]);
    expect(body.components[0]!.awsService).toBe('ECS');
    expect(body.components[2]!.awsService).toBe('S3');
    // The technical disclosure carries the RAW AWS status, not the mapped one.
    expect(body.components[1]!.resources[0]).toMatchObject({
      type: 'AWS::RDS::DBInstance',
      status: 'CREATE_COMPLETE',
    });
    expect(body.lastUpdatedAt).not.toBeNull();
    expect(body.disconnectWarning).toBeNull();
  });

  it('provisioning — in-progress rows dominate the summary', async () => {
    const deployment = await newDeployment({ state: 'INSTALLING' });
    await persistRows(
      deployment.id,
      [
        { logicalId: WEB_SERVICE_ID, type: 'AWS::ECS::Service', status: 'CREATE_IN_PROGRESS' },
        { logicalId: 'Database', type: 'AWS::RDS::DBInstance', status: 'CREATE_IN_PROGRESS' },
      ],
      new Date().toISOString(),
    );

    const body = (await getInfrastructure(deployment.id, { cookie: org.cookie })).json() as InfraBody;
    expect(body.summary.status).toBe('provisioning');
    expect(body.components.every((c) => c.status === 'provisioning')).toBe(true);
  });

  it('failure — a CREATE_FAILED resource fails its component and the summary', async () => {
    const deployment = await newDeployment({ state: 'FAILED' });
    await persistRows(
      deployment.id,
      [
        { logicalId: WEB_SERVICE_ID, type: 'AWS::ECS::Service', status: 'CREATE_FAILED', statusReason: 'No space left on device' },
        { logicalId: 'Database', type: 'AWS::RDS::DBInstance', status: 'CREATE_COMPLETE' },
      ],
      new Date().toISOString(),
    );

    const body = (await getInfrastructure(deployment.id, { cookie: org.cookie })).json() as InfraBody;
    expect(body.summary.status).toBe('failed');
    const application = body.components.find((c) => c.kind === 'application')!;
    expect(application.status).toBe('failed');
    expect(application.resources[0]).toMatchObject({
      status: 'CREATE_FAILED',
      statusReason: 'No space left on device',
    });
    expect(body.components.find((c) => c.kind === 'database')!.status).toBe('ready');
  });

  it('disconnected — a stale snapshot keeps last-known healthy statuses and warns', async () => {
    const deployment = await newDeployment({ state: 'HEALTHY' });
    // Snapshot and relay liveness both an hour old — well past the 15-minute
    // staleness window.
    await persistRows(
      deployment.id,
      [{ logicalId: WEB_SERVICE_ID, type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' }],
      new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    );
    await db
      .update(schema.deployments)
      .set({ relayStatus: 'DISCONNECTED', lastHealthAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(schema.deployments.id, deployment.id));

    const body = (await getInfrastructure(deployment.id, { cookie: org.cookie })).json() as InfraBody;
    expect(body.connectionState).toBe('disconnected');
    expect(body.snapshotState).toBe('stale');
    expect(body.disconnectWarning).not.toBeNull();
    // The disconnect never rewrites the inventory: last-known rows stay ready.
    expect(body.components[0]!.status).toBe('ready');
    expect(body.summary.status).toBe('healthy');
  });

  it('deleted — the preserved final snapshot re-derives statuses from lifecycle', async () => {
    const deployment = await newDeployment({ state: 'DELETED', deletedAt: new Date() });
    await persistRows(
      deployment.id,
      [
        { logicalId: WEB_SERVICE_ID, type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
        { logicalId: 'Database', type: 'AWS::RDS::DBInstance', status: 'CREATE_COMPLETE' },
        { logicalId: 'BackupBucket', type: 'AWS::S3::Bucket', status: 'CREATE_COMPLETE' },
      ],
      new Date().toISOString(),
    );

    const body = (await getInfrastructure(deployment.id, { cookie: org.cookie })).json() as InfraBody;
    expect(body.components.map((c) => [c.kind, c.status])).toEqual([
      ['application', 'removed'],
      ['database', 'retained'],
      ['storage', 'retained'],
    ]);
    expect(body.summary.status).toBe('retained');
    // Technical detail from the final snapshot survives the override.
    expect(body.components[0]!.resources[0].status).toBe('CREATE_COMPLETE');
  });

  it('a relay heartbeat inventory persists and serves back through the endpoint', async () => {
    const deployment = await newDeployment({ state: 'NOT_INSTALLED' });
    const installationId = `inst-heartbeat-${crypto.randomUUID()}`;
    await bindRelay(deployment.id, installationId);

    const observedAt = new Date().toISOString();
    const health = await postJson(
      app,
      '/api/relay/health',
      {
        installationId,
        healthStatus: 'HEALTHY',
        observedState: {
          infraHealth: {
            verified: true,
            checks: [],
            inventory: {
              stackId: STACK_ID,
              observedAt,
              resources: [
                { logicalId: WEB_SERVICE_ID, type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
                { logicalId: 'Database', type: 'AWS::RDS::DBInstance', status: 'CREATE_COMPLETE' },
              ],
            },
          },
        },
      },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(health.statusCode).toBe(200);

    const persisted = await db
      .select()
      .from(schema.deploymentResources)
      .where(eq(schema.deploymentResources.deploymentId, deployment.id));
    expect(persisted).toHaveLength(2);
    expect(persisted.find((r) => r.logicalResourceId === 'Database')).toMatchObject({
      resourceStatus: 'ready',
      rawResourceStatus: 'CREATE_COMPLETE',
      componentKind: 'database',
    });

    const body = (await getInfrastructure(deployment.id, { cookie: org.cookie })).json() as InfraBody;
    expect(body.summary).toEqual({ status: 'healthy', componentCount: 2, technicalResourceCount: 2 });
    expect(body.snapshotState).toBe('fresh');
  });

  it('a heartbeat WITHOUT an inventory is a no-op that preserves the previous snapshot', async () => {
    const deployment = await newDeployment({ state: 'NOT_INSTALLED' });
    const installationId = `inst-noop-${crypto.randomUUID()}`;
    await bindRelay(deployment.id, installationId);
    // One row persisted directly — the "good" snapshot a later null read must
    // never disturb.
    await persistRows(
      deployment.id,
      [{ logicalId: WEB_SERVICE_ID, type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' }],
      new Date().toISOString(),
    );

    const health = await postJson(
      app,
      '/api/relay/health',
      { installationId, healthStatus: 'HEALTHY', observedState: { infraHealth: null } },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(health.statusCode).toBe(200);

    const rows = await db
      .select()
      .from(schema.deploymentResources)
      .where(eq(schema.deploymentResources.deploymentId, deployment.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resourceStatus).toBe('ready');

const body = (await getInfrastructure(deployment.id, { cookie: org.cookie })).json() as InfraBody;
    expect(body.summary).toEqual({ status: 'healthy', componentCount: 1, technicalResourceCount: 1 });
    expect(body.components[0]!.status).toBe('ready');
  });

  // Phase 6 — requirement-aware verification: the stored manifest's
  // infrastructure profile compared against the persisted inventory.
  describe('expectations — the stored manifest compared against the inventory', () => {
    it('stateless deployment, inventory without RDS: nothing missing', async () => {
      const deployment = await newDeployment({
        state: 'HEALTHY',
        desiredState: { manifest: { ...READY_MANIFEST, database: { postgres: false } } },
      });
      await persistRows(
        deployment.id,
        [
          { logicalId: WEB_SERVICE_ID, type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
          { logicalId: 'Alb', type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', status: 'CREATE_COMPLETE' },
          { logicalId: 'AppBucket', type: 'AWS::S3::Bucket', status: 'CREATE_COMPLETE' },
        ],
        new Date().toISOString(),
      );

      const body = (await getInfrastructure(deployment.id, { cookie: org.cookie })).json() as InfraBody;
      expect(body.expectations?.missing).toEqual([]);
      expect(body.expectations?.unexpected).toEqual([]);
      expect(body.expectations?.components.find((c) => c.kind === 'database')).toEqual({
        kind: 'database',
        expected: false,
        present: false,
      });
    });

    it('postgres deployment, inventory without RDS: missing database', async () => {
      const deployment = await newDeployment({
        state: 'HEALTHY',
        desiredState: { manifest: READY_MANIFEST },
      });
      await persistRows(
        deployment.id,
        [
          { logicalId: WEB_SERVICE_ID, type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
          { logicalId: 'Alb', type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', status: 'CREATE_COMPLETE' },
          { logicalId: 'AppBucket', type: 'AWS::S3::Bucket', status: 'CREATE_COMPLETE' },
        ],
        new Date().toISOString(),
      );

      const body = (await getInfrastructure(deployment.id, { cookie: org.cookie })).json() as InfraBody;
      expect(body.expectations?.missing).toEqual(['database']);
    });

    it('redis deployment, inventory without a cache: missing cache', async () => {
      const deployment = await newDeployment({
        state: 'HEALTHY',
        desiredState: {
          manifest: { ...READY_MANIFEST, redis: { required: true, envBindings: [] } },
        },
      });
      await persistRows(
        deployment.id,
        [
          { logicalId: WEB_SERVICE_ID, type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
          { logicalId: 'Alb', type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', status: 'CREATE_COMPLETE' },
          { logicalId: 'Database', type: 'AWS::RDS::DBInstance', status: 'CREATE_COMPLETE' },
          { logicalId: 'AppBucket', type: 'AWS::S3::Bucket', status: 'CREATE_COMPLETE' },
        ],
        new Date().toISOString(),
      );

      const body = (await getInfrastructure(deployment.id, { cookie: org.cookie })).json() as InfraBody;
      expect(body.expectations?.missing).toEqual(['cache']);
    });

    it('a DELETED deployment always reports missing: [], even for a retain-lifecycle component never provisioned', async () => {
      const deployment = await newDeployment({
        state: 'DELETED',
        deletedAt: new Date(),
        desiredState: { manifest: READY_MANIFEST },
      });
      // No RDS row at all — a postgres deployment whose database never made
      // it into the inventory before deletion. A failed purge must never
      // read this as "missing" (retrying a purge only removes retained
      // resources; a deployment past DELETED reports nothing outstanding).
      await persistRows(
        deployment.id,
        [{ logicalId: WEB_SERVICE_ID, type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' }],
        new Date().toISOString(),
      );

      const body = (await getInfrastructure(deployment.id, { cookie: org.cookie })).json() as InfraBody;
      expect(body.expectations?.missing).toEqual([]);
    });

    it('a FAILED deployment with a removed cache row: missing must not include cache', async () => {
      // A FAILED destroy (docs/deployment-resilience.md) leaves the
      // deployment FAILED, not DELETED — the cache was actually torn down
      // (DELETE_COMPLETE -> 'removed') before another resource's deletion
      // failed. That row must never be reported as both "Removed" and
      // "Missing" for the same component.
      const deployment = await newDeployment({
        state: 'FAILED',
        desiredState: {
          manifest: { ...READY_MANIFEST, redis: { required: true, envBindings: [] } },
        },
      });
      await persistRows(
        deployment.id,
        [
          { logicalId: WEB_SERVICE_ID, type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
          { logicalId: 'Alb', type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', status: 'CREATE_COMPLETE' },
          { logicalId: 'Database', type: 'AWS::RDS::DBInstance', status: 'CREATE_COMPLETE' },
          { logicalId: 'AppBucket', type: 'AWS::S3::Bucket', status: 'CREATE_COMPLETE' },
          { logicalId: 'Cache', type: 'AWS::ElastiCache::ReplicationGroup', status: 'DELETE_COMPLETE' },
        ],
        new Date().toISOString(),
      );

      const body = (await getInfrastructure(deployment.id, { cookie: org.cookie })).json() as InfraBody;
      expect(body.components.find((c) => c.kind === 'cache')?.status).toBe('removed');
      expect(body.expectations?.missing).not.toContain('cache');
    });

    it('a deployment with no valid stored manifest: expectations is null', async () => {
      const deployment = await newDeployment({ state: 'HEALTHY', desiredState: {} });
      await persistRows(
        deployment.id,
        [{ logicalId: WEB_SERVICE_ID, type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' }],
        new Date().toISOString(),
      );

      const body = (await getInfrastructure(deployment.id, { cookie: org.cookie })).json() as InfraBody;
      expect(body.expectations).toBeNull();
    });
  });
});

// ── Phase 1.1: ECR pull grants + auto-deploy on INSTALL success ─────────────
// The ECR repository policy seam is injected so no grant/revoke ever leaves
// the machine; the fake records the policy reads/writes exactly like ECR
// would.
function createRecorderEcrClient(): EcrClient & {
  seed(statement: EcrGrantStatement): void;
  statements(): Array<{ Sid: string; Principal: { AWS: string } }>;
  statementFor(sid: string): { Sid: string; Principal: { AWS: string } } | undefined;
} {
  let policy: { Statement?: unknown[] } | null = null;
  return {
    async getRepositoryPolicy(): Promise<{ policyText: Record<string, unknown> } | null> {
      return policy ? { policyText: policy as unknown as Record<string, unknown> } : null;
    },
    async setRepositoryPolicy(
      _repositoryName: string,
      policyText: Record<string, unknown>,
    ): Promise<void> {
      policy = policyText as unknown as { Statement?: unknown[] };
    },
    async deleteRepositoryPolicy(_repositoryName: string): Promise<void> {
      policy = null;
    },
    // Seeds the state an installation's grant would have left behind.
    seed(statement: EcrGrantStatement): void {
      policy = { Statement: [statement] } as unknown as { Statement?: unknown[] };
    },
    statements() {
      return (
        (policy?.Statement as Array<{ Sid: string; Principal: { AWS: string } }> | undefined) ?? []
      );
    },
    statementFor(sid: string) {
      return this.statements().find((s) => s.Sid === sid);
    },
  };
}

describe('server — Phase 1.1 ECR pull grants and auto-deploy on install', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };
  let fakeEcr: ReturnType<typeof createRecorderEcrClient>;
  const RELAY_TOKEN = 'relay-token-phase-11';
  // A built release's image as CodeBuild reports it: `repository@sha256:…`.
  const READY_IMAGE_DIGEST =
    '111122223333.dkr.ecr.us-east-1.amazonaws.com/deployz-images@sha256:' + 'a'.repeat(64);

  async function seedReadyRelease(applicationId: string) {
    return insertRelease(db, applicationId, {
      buildStatus: 'SUCCEEDED',
      releaseStatus: 'READY',
      imageDigest: READY_IMAGE_DIGEST,
    });
  }

  async function claimCommands(installationId: string): Promise<Array<{ id: string; type: string }>> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/relay/commands?installationId=${installationId}`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { commands: Array<{ id: string; type: string }> }).commands;
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'phase-11@example.com');
    fakeEcr = createRecorderEcrClient();
    app = await buildServer({ auth, db, ecrClient: fakeEcr });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('relay registration grants the customer account pull access for the installation', async () => {
    const application = await insertApplication(db, org.organizationId);
    await seedReadyRelease(application.id);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'NOT_INSTALLED',
      installationId: null,
    });
    const installationId = `inst-grant-${crypto.randomUUID()}`;

    const response = await postJson(
      app,
      '/api/relay/register',
      { enrollmentCode: deployment.enrollmentCode, installationId, awsAccountId: '123456789012' },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(response.statusCode).toBe(200);

    expect(fakeEcr.statementFor(`deployz-pull-${installationId}`)).toMatchObject({
      Sid: `deployz-pull-${installationId}`,
      Principal: { AWS: 'arn:aws:iam::123456789012:root' },
    });
  });

  it('INSTALL success auto-enqueues a digest-pinned DEPLOY_RELEASE for the newest READY release', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'NOT_INSTALLED',
      installationId: null,
    });
    const release = await seedReadyRelease(application.id);
    const installationId = `inst-auto-${release.id}`;

    const register = await postJson(
      app,
      '/api/relay/register',
      { enrollmentCode: deployment.enrollmentCode, installationId, awsAccountId: '123456789012' },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(register.statusCode).toBe(200);

    const commands = await claimCommands(installationId);
    const installJob = commands.find((c) => c.type === 'INSTALL')!;
    const result = await postJson(
      app,
      `/api/relay/commands/${installJob.id}/result`,
      { success: true },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(result.statusCode).toBe(200);

    const deployJobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(
        and(
          eq(schema.deploymentJobs.deploymentId, deployment.id),
          eq(schema.deploymentJobs.type, 'DEPLOY_RELEASE'),
        ),
      );
    expect(deployJobs).toHaveLength(1);
    const [job] = deployJobs;
    expect(job!.state).toBe('REQUESTED');
    expect(job!.requestedBy).toBeNull();
    expect(job!.idempotencyKey).toBe(`${deployment.id}:DEPLOY_RELEASE:install:${installJob.id}`);
    // Digest-pinned: repository + immutable sha256, exactly what the relay's
    // readDeployRequest validates.
    expect(job!.payload).toMatchObject({
      releaseId: release.id,
      imageRepository: '111122223333.dkr.ecr.us-east-1.amazonaws.com/deployz-images',
      imageDigest: `sha256:${'a'.repeat(64)}`,
    });

    // The auto-queue must NOT advance the deployment state: INSTALLING →
    // HEALTHY belongs to runtime-health verification (INSTALL result no
    // longer sets HEALTHY), and the deploy job must not skip that gate.
    const [dep] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id));
    expect(dep!.state).toBe('INSTALLING');

    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(
        and(
          eq(schema.eventLogs.deploymentId, deployment.id),
          eq(schema.eventLogs.eventType, 'deploy.requested'),
        ),
      );
    expect(events).toHaveLength(1);
  });

  describe('install follow-ups', () => {
    const relayAuth = { authorization: `Bearer ${RELAY_TOKEN}` };

    async function installDeployment(applicationId: string) {
      const customer = await insertCustomer(db, org.organizationId);
      const deployment = await insertDeployment(db, org.organizationId, applicationId, customer.id, {
        state: 'NOT_INSTALLED',
        installationId: null,
      });
      const installationId = `inst-fu-${crypto.randomUUID()}`;
      const register = await postJson(
        app,
        '/api/relay/register',
        { enrollmentCode: deployment.enrollmentCode, installationId, awsAccountId: '123456789012' },
        relayAuth,
      );
      expect(register.statusCode).toBe(200);
      const installJob = (await claimCommands(installationId)).find((command) => command.type === 'INSTALL')!;
      return { deployment, installationId, installJobId: installJob.id };
    }

    const reportInstall = (jobId: string) =>
      postJson(app, `/api/relay/commands/${jobId}/result`, { success: true }, relayAuth);
    const heartbeat = (installationId: string) =>
      postJson(app, '/api/relay/health', { installationId }, relayAuth);
    const jobsOfType = (deploymentId: string, type: 'CONFIG_UPDATE' | 'DEPLOY_RELEASE') =>
      db
        .select()
        .from(schema.deploymentJobs)
        .where(and(eq(schema.deploymentJobs.deploymentId, deploymentId), eq(schema.deploymentJobs.type, type)));
    async function followUpsOf(installJobId: string) {
      const [row] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, installJobId));
      return (row!.result as { followUps?: { autoDeploy: string } } | null)?.followUps;
    }
    async function requireVendorConfig(applicationId: string) {
      await db
        .insert(schema.applicationConfigs)
        .values({ applicationId, customerId: null, key: 'LOG_LEVEL', value: 'debug', isSecret: false });
    }
    async function blockConfigJobs() {
      await db.execute(sql`CREATE OR REPLACE FUNCTION block_config_job() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'config job blocked'; END $$ LANGUAGE plpgsql`);
      await db.execute(sql`CREATE TRIGGER block_config_job BEFORE INSERT ON deployment_jobs FOR EACH ROW WHEN (NEW.type = 'CONFIG_UPDATE') EXECUTE FUNCTION block_config_job()`);
    }
    async function unblockConfigJobs() {
      await db.execute(sql`DROP TRIGGER block_config_job ON deployment_jobs`);
    }

    it('creates the configuration pass before the auto-deploy, keyed on the install job', async () => {
      const application = await insertApplication(db, org.organizationId);
      await requireVendorConfig(application.id);
      await seedReadyRelease(application.id);
      const { deployment, installJobId } = await installDeployment(application.id);

      expect((await reportInstall(installJobId)).statusCode).toBe(200);

      const [config] = await jobsOfType(deployment.id, 'CONFIG_UPDATE');
      const [deploy] = await jobsOfType(deployment.id, 'DEPLOY_RELEASE');
      expect(config!.idempotencyKey).toBe(`${deployment.id}:CONFIG_UPDATE:install:${installJobId}`);
      expect(deploy!.idempotencyKey).toBe(`${deployment.id}:DEPLOY_RELEASE:install:${installJobId}`);
      expect(config!.createdAt.getTime()).toBeLessThanOrEqual(deploy!.createdAt.getTime());
      expect(await followUpsOf(installJobId)).toEqual({ autoDeploy: 'queued' });
    });

    it('queues no deploy while the required configuration pass is absent, and the heartbeat repairs both in order', async () => {
      const application = await insertApplication(db, org.organizationId);
      await requireVendorConfig(application.id);
      await seedReadyRelease(application.id);
      const { deployment, installationId, installJobId } = await installDeployment(application.id);

      await blockConfigJobs();
      try {
        expect((await reportInstall(installJobId)).statusCode).toBe(200);
      } finally {
        await unblockConfigJobs();
      }
      expect(await jobsOfType(deployment.id, 'CONFIG_UPDATE')).toHaveLength(0);
      expect(await jobsOfType(deployment.id, 'DEPLOY_RELEASE')).toHaveLength(0);
      expect(await followUpsOf(installJobId)).toBeUndefined();

      expect((await heartbeat(installationId)).statusCode).toBe(200);
      const [config] = await jobsOfType(deployment.id, 'CONFIG_UPDATE');
      const [deploy] = await jobsOfType(deployment.id, 'DEPLOY_RELEASE');
      expect(config!.createdAt.getTime()).toBeLessThanOrEqual(deploy!.createdAt.getTime());

      // Repeated heartbeats and a replayed result create nothing more.
      expect((await heartbeat(installationId)).statusCode).toBe(200);
      expect((await reportInstall(installJobId)).statusCode).toBe(200);
      expect(await jobsOfType(deployment.id, 'CONFIG_UPDATE')).toHaveLength(1);
      expect(await jobsOfType(deployment.id, 'DEPLOY_RELEASE')).toHaveLength(1);
    });

    it('repairs the follow-ups when the install result is replayed', async () => {
      const application = await insertApplication(db, org.organizationId);
      await requireVendorConfig(application.id);
      await seedReadyRelease(application.id);
      const { deployment, installJobId } = await installDeployment(application.id);

      await blockConfigJobs();
      try {
        await reportInstall(installJobId);
      } finally {
        await unblockConfigJobs();
      }
      const replay = await reportInstall(installJobId);
      expect(replay.json()).toMatchObject({ alreadySettled: true });

      expect(await jobsOfType(deployment.id, 'CONFIG_UPDATE')).toHaveLength(1);
      expect(await jobsOfType(deployment.id, 'DEPLOY_RELEASE')).toHaveLength(1);
    });

    it('stops repairing once the deployment has moved on', async () => {
      const application = await insertApplication(db, org.organizationId);
      await requireVendorConfig(application.id);
      await seedReadyRelease(application.id);
      const { deployment, installationId, installJobId } = await installDeployment(application.id);

      await blockConfigJobs();
      try {
        await reportInstall(installJobId);
      } finally {
        await unblockConfigJobs();
      }
      await db.insert(schema.deploymentJobs).values({
        deploymentId: deployment.id,
        type: 'DEPLOY_RELEASE',
        state: 'SUCCEEDED',
        idempotencyKey: `${deployment.id}:DEPLOY_RELEASE:manual-${crypto.randomUUID()}`,
        finishedAt: new Date(),
      });

      expect((await heartbeat(installationId)).statusCode).toBe(200);

      expect(await jobsOfType(deployment.id, 'CONFIG_UPDATE')).toHaveLength(0);
      expect(await jobsOfType(deployment.id, 'DEPLOY_RELEASE')).toHaveLength(1);
      expect(await followUpsOf(installJobId)).toEqual({ autoDeploy: 'superseded' });
    });

    it('records a missing READY release as a decision, so a later release is not auto-deployed', async () => {
      const application = await insertApplication(db, org.organizationId);
      const release = await seedReadyRelease(application.id);
      const { deployment, installationId, installJobId } = await installDeployment(application.id);
      await db.update(schema.releases).set({ imageUnavailableAt: new Date() }).where(eq(schema.releases.id, release.id));

      expect((await reportInstall(installJobId)).statusCode).toBe(200);
      expect(await followUpsOf(installJobId)).toEqual({ autoDeploy: 'no_ready_release' });

      await seedReadyRelease(application.id);
      expect((await heartbeat(installationId)).statusCode).toBe(200);
      expect(await jobsOfType(deployment.id, 'DEPLOY_RELEASE')).toHaveLength(0);
    });

    it('does not auto-deploy onto a stack whose topology the application has outgrown', async () => {
      // The frozen stack runs PostgreSQL; the application now wants MySQL.
      const application = await insertApplication(db, org.organizationId, {
        databaseRequired: true,
        detectedMetadata: { mysql: { required: true } },
      });
      await seedReadyRelease(application.id);
      const { deployment, installJobId } = await installDeployment(application.id);

      expect((await reportInstall(installJobId)).statusCode).toBe(200);

      expect(await jobsOfType(deployment.id, 'DEPLOY_RELEASE')).toHaveLength(0);
      expect(await followUpsOf(installJobId)).toEqual({ autoDeploy: 'topology_changed' });
    });
  });

  it('a CONFIG_UPDATE success deletes only the bound secrets its job carried', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'HEALTHY',
      installationId: null,
    });
    const installationId = `inst-bound-${crypto.randomUUID()}`;
    await postJson(
      app,
      '/api/relay/register',
      { enrollmentCode: deployment.enrollmentCode, installationId, awsAccountId: '123456789012' },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    const store = createDrizzlePendingSecretStore(db, createCipherStub());
    for (const key of ['CARRIED_KEY', 'LATER_KEY']) {
      await store.upsertBound({
        organizationId: org.organizationId,
        applicationId: application.id,
        deploymentId: deployment.id,
        key,
        ciphertext: `enc:ctx:${key}`,
        encryptionContext: {},
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    }
    const [job] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: deployment.id,
        type: 'CONFIG_UPDATE',
        idempotencyKey: `${deployment.id}:CONFIG_UPDATE:${crypto.randomUUID()}`,
        state: 'RUNNING',
        startedAt: new Date(),
        payload: { changedKeys: ['CARRIED_KEY'] },
      })
      .returning();

    const result = await postJson(
      app,
      `/api/relay/commands/${job!.id}/result`,
      { success: true },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(result.statusCode).toBe(200);

    expect((await store.listBoundForDeployment(deployment.id)).map((row) => row.key)).toEqual(['LATER_KEY']);
  });

  it('skips a newest release that is not READY yet: the auto-deploy rolls the newest READY one', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'NOT_INSTALLED',
      installationId: null,
    });
    // The INSTALL itself needs a READY release, so the not-READY release is
    // the newer of two.
    const ready = await seedReadyRelease(application.id);
    // A release still building — never a deploy target.
    await insertRelease(db, application.id, { buildStatus: 'BUILDING' });
    const installationId = `inst-noready-${crypto.randomUUID()}`;

    await postJson(
      app,
      '/api/relay/register',
      { enrollmentCode: deployment.enrollmentCode, installationId, awsAccountId: '123456789012' },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    const commands = await claimCommands(installationId);
    const installJob = commands.find((c) => c.type === 'INSTALL')!;
    await postJson(
      app,
      `/api/relay/commands/${installJob.id}/result`,
      { success: true },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );

    const deployJobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(
        and(
          eq(schema.deploymentJobs.deploymentId, deployment.id),
          eq(schema.deploymentJobs.type, 'DEPLOY_RELEASE'),
        ),
      );
    expect(deployJobs).toHaveLength(1);
    expect(deployJobs[0]!.payload).toMatchObject({ releaseId: ready.id });
  });

  it('does not auto-enqueue a DEPLOY_RELEASE when the INSTALL fails', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'NOT_INSTALLED',
      installationId: null,
    });
    await seedReadyRelease(application.id);
    const installationId = `inst-fail-${crypto.randomUUID()}`;

    await postJson(
      app,
      '/api/relay/register',
      { enrollmentCode: deployment.enrollmentCode, installationId, awsAccountId: '123456789012' },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    const commands = await claimCommands(installationId);
    const installJob = commands.find((c) => c.type === 'INSTALL')!;
    const result = await postJson(
      app,
      `/api/relay/commands/${installJob.id}/result`,
      { success: false, failureCode: 'STACK_CREATE_FAILED', error: 'create rolled back' },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(result.statusCode).toBe(200);

    const deployJobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(
        and(
          eq(schema.deploymentJobs.deploymentId, deployment.id),
          eq(schema.deploymentJobs.type, 'DEPLOY_RELEASE'),
        ),
      );
    expect(deployJobs).toHaveLength(0);
  });

  it('revokes the pull grant when a DESTROY succeeds', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'HEALTHY',
      installationId: `inst-destroy-${crypto.randomUUID()}`,
      awsAccountId: '123456789012',
      relayTokenHash: hashRelayToken(RELAY_TOKEN),
    });
    // The grant the install would have made.
    fakeEcr.seed(buildPullStatement(deployment.installationId!, '123456789012'));

    const destroy = await postJson(
      app,
      `/api/deployments/${deployment.id}/destroy`,
      {},
      { cookie: org.cookie },
    );
    expect(destroy.statusCode).toBe(202);

    const commands = await claimCommands(deployment.installationId!);
    const destroyJob = commands.find((c) => c.type === 'DESTROY')!;
    const result = await postJson(
      app,
      `/api/relay/commands/${destroyJob.id}/result`,
      { success: true },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(result.statusCode).toBe(200);

    expect(fakeEcr.statementFor(`deployz-pull-${deployment.installationId}`)).toBeUndefined();
  });

  it('revokes the pull grant when a PURGE succeeds', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'DELETED',
      cleanupState: 'SKIPPED_RELAY_OFFLINE',
      installationId: `inst-purge-${crypto.randomUUID()}`,
      awsAccountId: '123456789012',
      relayTokenHash: hashRelayToken(RELAY_TOKEN),
    });
    fakeEcr.seed(buildPullStatement(deployment.installationId!, '123456789012'));

    const purge = await postJson(
      app,
      `/api/deployments/${deployment.id}/purge`,
      {},
      { cookie: org.cookie },
    );
    expect(purge.statusCode).toBe(202);

    const commands = await claimCommands(deployment.installationId!);
    const purgeJob = commands.find((c) => c.type === 'PURGE')!;
    const result = await postJson(
      app,
      `/api/relay/commands/${purgeJob.id}/result`,
      { success: true },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(result.statusCode).toBe(200);

    expect(fakeEcr.statementFor(`deployz-pull-${deployment.installationId}`)).toBeUndefined();
  });
});


// ── AI MVP Phase 2: vendor configuration reconciles readiness ─────────────
describe('server — readiness reconciliation with the application details', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };

  const portFinding = {
    id: 'port-unresolved',
    category: 'network',
    title: 'Tell Deployz which port your app listens on',
    severity: 'required',
    blocking: false,
    plainEnglishExplanation: 'Deployz could not find the network port this app listens on.',
    whyItMatters: 'Deployz routes customer traffic and health checks to one port.',
    technicalEvidence: 'No port was found.',
    suggestedOutcome: 'Declare the port the app listens on, or set it in the application details.',
    confidence: 'confirmed',
  };
  const storedReport = {
    state: 'ALMOST_READY',
    requiredCount: 1,
    recommendedCount: 0,
    summary: 'Deployz found a few things to address before this app can be deployed reliably.',
    findings: [portFinding],
    passed: [{ id: 'dockerfile', label: 'Container setup found' }],
  };

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'readiness-reconcile@example.com');
    app = await buildServer({ auth, db });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await client?.close();
  });

  it('GET readiness applies the container port the vendor set: the finding becomes a passed check and the state READY', async () => {
    const application = await insertApplication(db, org.organizationId, {
      analysisStatus: 'COMPLETE',
      compatibilityStatus: 'NEEDS_ATTENTION',
      containerPort: 8080,
      detectedMetadata: { readiness: storedReport },
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/readiness`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { state: string; requiredCount: number; findings: unknown[]; passed: { id: string }[] };
    expect(body.state).toBe('READY');
    expect(body.requiredCount).toBe(0);
    expect(body.findings).toEqual([]);
    expect(body.passed.map((p) => p.id)).toEqual(['dockerfile', 'port-unresolved']);
  });

  it('PATCH containerPort keeps the persisted verdict in step with the page, and clearing it restores the finding', async () => {
    const application = await insertApplication(db, org.organizationId, {
      analysisStatus: 'COMPLETE',
      compatibilityStatus: 'NEEDS_ATTENTION',
      compatibilityReason: storedReport.summary,
      detectedMetadata: { readiness: storedReport },
    });

    const set = await app.inject({
      method: 'PATCH',
      url: `/api/applications/${application.id}`,
      headers: { cookie: org.cookie },
      payload: { containerPort: 8080 },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({
      containerPort: 8080,
      compatibilityStatus: 'READY',
      compatibilityReason: 'This app can be deployed through Deployz.',
    });
    // The stored report itself is untouched — reconciliation is a view.
    const [row] = await db.select().from(schema.applications).where(eq(schema.applications.id, application.id));
    expect((row?.detectedMetadata as { readiness: { findings: unknown[] } }).readiness.findings).toHaveLength(1);

    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/applications/${application.id}`,
      headers: { cookie: org.cookie },
      payload: { containerPort: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({
      containerPort: null,
      compatibilityStatus: 'NEEDS_ATTENTION',
      compatibilityReason: storedReport.summary,
    });
  });

  it('PATCH refuses a migration or start command the relay would reject', async () => {
    const application = await insertApplication(db, org.organizationId, {});

    for (const payload of [
      { migrationCommand: 'x'.repeat(4097) },
      { migrationCommand: 'npm run migrate\0' },
      { migrationCommand: '   ' },
      { startCommand: 'x'.repeat(4097) },
    ]) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/applications/${application.id}`,
        headers: { cookie: org.cookie },
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('PATCH of an unrelated field leaves the verdict alone', async () => {
    const application = await insertApplication(db, org.organizationId, {
      analysisStatus: 'COMPLETE',
      compatibilityStatus: 'NEEDS_ATTENTION',
      detectedMetadata: { readiness: storedReport },
    });
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/applications/${application.id}`,
      headers: { cookie: org.cookie },
      payload: { healthPath: '/healthz' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ healthPath: '/healthz', compatibilityStatus: 'NEEDS_ATTENTION' });
  });
});


// ── AI MVP Phase 3: fix-instructions cache ──────────────────────────────────
describe('server — POST /api/applications/:id/fix-instructions (cache)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let org: { userId: string; organizationId: string; cookie: string };

  const healthFinding = {
    id: 'health-check',
    category: 'health',
    title: 'Give Deployz a way to check your app',
    severity: 'required',
    blocking: false,
    plainEnglishExplanation: 'Deployz needs a reliable way to know when your app is running and ready.',
    whyItMatters: 'During every deployment, Deployz waits for your app to report healthy.',
    technicalEvidence: 'No health endpoint or container health check was found.',
    suggestedOutcome: 'Expose a lightweight route that returns success once the app is ready.',
    confidence: 'likely',
  };
  const readinessWith = (findings: unknown[]) => ({
    state: 'ALMOST_READY',
    requiredCount: findings.length,
    recommendedCount: 0,
    summary: 'Deployz found a few things to address before this app can be deployed reliably.',
    findings,
    passed: [],
  });

  function countingGateway(): { gateway: { generate: () => Promise<unknown> }; calls: () => number } {
    let calls = 0;
    return {
      gateway: {
        async generate() {
          calls += 1;
          return {
            object: { items: [{ id: 'health-check', guidance: `Guidance #${calls}` }] },
            usage: { promptTokens: 100, completionTokens: 50 },
          };
        },
      },
      calls: () => calls,
    };
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'fix-instructions-cache@example.com');
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('reuses the document for the same commit, analysis version and findings; regenerate bypasses; a changed finding set misses', async () => {
    const application = await insertApplication(db, org.organizationId, {
      analysisStatus: 'COMPLETE',
      compatibilityStatus: 'NEEDS_ATTENTION',
      detectedMetadata: { readiness: readinessWith([healthFinding]), analysisCommitSha: 'abc123', analysisVersion: 13 },
    });
    const counting = countingGateway();
    const stubApp = await buildServer({ auth, db, fixInstructionsAiGateway: counting.gateway as never });
    const url = `/api/applications/${application.id}/fix-instructions`;

    const first = await postJson(stubApp, url, {}, { cookie: org.cookie });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { instructions: string; generatedAt: string; cached: boolean };
    expect(firstBody.cached).toBe(false);
    expect(firstBody.instructions).toContain('Guidance #1');
    expect(counting.calls()).toBe(1);

    const second = await postJson(stubApp, url, {}, { cookie: org.cookie });
    const secondBody = second.json() as { instructions: string; generatedAt: string; cached: boolean };
    expect(secondBody).toEqual({ ...firstBody, cached: true });
    expect(counting.calls()).toBe(1);

    const regenerated = await postJson(stubApp, url, { regenerate: true }, { cookie: org.cookie });
    const regeneratedBody = regenerated.json() as { instructions: string; cached: boolean };
    expect(regeneratedBody.cached).toBe(false);
    expect(regeneratedBody.instructions).toContain('Guidance #2');
    expect(counting.calls()).toBe(2);

    // The finding set changed (a re-analysis found one more thing) → miss.
    await db
      .update(schema.applications)
      .set({
        detectedMetadata: {
          ...(await db.select().from(schema.applications).where(eq(schema.applications.id, application.id)))[0]!
            .detectedMetadata,
          readiness: readinessWith([healthFinding, { ...healthFinding, id: 'localhost-binding', title: 'Your app only listens on localhost' }]),
        },
      })
      .where(eq(schema.applications.id, application.id));
    const changed = await postJson(stubApp, url, {}, { cookie: org.cookie });
    expect((changed.json() as { cached: boolean }).cached).toBe(false);
    expect(counting.calls()).toBe(3);

    await stubApp.close();
  });

  it('a generation failure leaves an earlier cached document untouched', async () => {
    const application = await insertApplication(db, org.organizationId, {
      analysisStatus: 'COMPLETE',
      compatibilityStatus: 'NEEDS_ATTENTION',
      detectedMetadata: { readiness: readinessWith([healthFinding]), analysisCommitSha: 'def456', analysisVersion: 13 },
    });
    const counting = countingGateway();
    const okApp = await buildServer({ auth, db, fixInstructionsAiGateway: counting.gateway as never });
    const url = `/api/applications/${application.id}/fix-instructions`;
    const first = (await postJson(okApp, url, {}, { cookie: org.cookie })).json() as { instructions: string };
    await okApp.close();

    const failingApp = await buildServer({
      auth,
      db,
      fixInstructionsAiGateway: {
        async generate() {
          throw new Error('gateway down');
        },
      },
    });
    const regenerate = await postJson(failingApp, url, { regenerate: true }, { cookie: org.cookie });
    expect(regenerate.statusCode).toBe(503);
    const reused = await postJson(failingApp, url, {}, { cookie: org.cookie });
    expect(reused.statusCode).toBe(200);
    expect(reused.json()).toMatchObject({ instructions: first.instructions, cached: true });
    await failingApp.close();
  });
});

// ── Final review: the technical detail is redacted like the context ────────
describe('server — diagnostics technical detail is redacted', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'diagnostics-redaction@example.com');
    app = await buildServer({ auth, db });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await client?.close();
  });

  it('never serves a secret-shaped value in technicalDetail, while keeping the rest of the relay text', async () => {
    const application = await insertApplication(db, org.organizationId, { analysisStatus: 'COMPLETE', compatibilityStatus: 'READY' });
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, { state: 'FAILED' });
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'INSTALL',
      state: 'FAILED',
      idempotencyKey: `${deployment.id}:INSTALL:redaction`,
      payload: {},
      failureCode: 'STACK_CREATE_FAILED',
      result: { success: false, error: 'CreateStack failed: DATABASE_PASSWORD=hunter2 rejected by the database' },
      finishedAt: new Date(),
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}/diagnostics`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { technicalDetail: string | null; context: { message: string | null } };
    expect(body.technicalDetail).toBe('CreateStack failed: DATABASE_PASSWORD=[REDACTED] rejected by the database');
    expect(body.context.message).toBe('CreateStack failed: DATABASE_PASSWORD=[REDACTED] rejected by the database');
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });
});

// ── P0 hardening: secure-endpoint truth and unavailable releases ─────────────
describe('server — P0 hardening', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };
  let applicationId: string;
  let customerId: string;
  let registry: FixtureReleaseImageClient;
  const STACK_ID = 'arn:aws:cloudformation:us-east-1:123456789012:stack/deployz-app/p0';
  const RELAY_TOKEN = 'p0-relay-token';
  const REPOSITORY = '111122223333.dkr.ecr.us-east-1.amazonaws.com/deployz-images';

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'p0-hardening@example.com');
    registry = createFixtureReleaseImageClient();
    app = await buildServer({ auth, db, releaseImages: registry });
    const application = await insertApplication(db, org.organizationId);
    applicationId = application.id;
    const customer = await insertCustomer(db, org.organizationId);
    customerId = customer.id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  function digestFor(seed: string): string {
    return `sha256:${createHmac('sha256', 'p0').update(seed).digest('hex')}`;
  }

  async function readyRelease(): Promise<{ id: string; digest: string; version: string }> {
    const digest = digestFor(crypto.randomUUID());
    const release = await insertRelease(db, applicationId, {
      buildStatus: 'SUCCEEDED',
      releaseStatus: 'READY',
      imageDigest: `${REPOSITORY}@${digest}`,
    });
    return { id: release.id, digest, version: release.version };
  }

  async function listReleases(): Promise<Array<{ id: string; status: string }>> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${applicationId}/releases`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    return (response.json() as { releases: Array<{ id: string; status: string }> }).releases;
  }

  describe('GET /api/deployments/:id/infrastructure — the secure endpoint is READY only when HTTPS serves', () => {
    async function deploymentWithAlb(
      overrides: Partial<typeof schema.deployments.$inferInsert> = {},
    ): Promise<typeof schema.deployments.$inferSelect> {
      const deployment = await insertDeployment(db, org.organizationId, applicationId, customerId, {
        state: 'HEALTHY',
        ...overrides,
      });
      await persistDeploymentResourceSnapshot(db, {
        deploymentId: deployment.id,
        stackId: STACK_ID,
        resources: [
          { logicalId: WEB_SERVICE_ID, type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
          { logicalId: 'Alb', type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', status: 'CREATE_COMPLETE' },
          { logicalId: 'Listener', type: 'AWS::ElasticLoadBalancingV2::Listener', status: 'CREATE_COMPLETE' },
        ],
        observedAt: new Date().toISOString(),
      });
      return deployment;
    }

    async function endpoint(deploymentId: string) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/deployments/${deploymentId}/infrastructure`,
        headers: { cookie: org.cookie },
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as {
        summary: { status: string };
        components: Array<{ kind: string; status: string; httpsState?: string }>;
      };
      return { summary: body.summary.status, endpoint: body.components.find((c) => c.kind === 'endpoint')! };
    }

    it('a complete load balancer with no HTTPS machine reads Setting up, never Ready', async () => {
      const deployment = await deploymentWithAlb({ defaultHttps: null });
      const view = await endpoint(deployment.id);
      expect(view.endpoint.status).toBe('provisioning');
      expect(view.endpoint.httpsState).toBe('SETTING_UP');
      expect(view.summary).toBe('provisioning');
    });

    it('follows the default-HTTPS machine: waiting for the certificate, activating, then ready', async () => {
      const hostname = 'd-p0.deployz.dev';
      const deployment = await deploymentWithAlb({
        defaultHttps: { hostname, status: 'WAITING_FOR_DNS', checkCycle: 0, lastError: null },
      });
      expect(await endpoint(deployment.id)).toMatchObject({
        summary: 'provisioning',
        endpoint: { status: 'provisioning', httpsState: 'WAITING_FOR_CERTIFICATE' },
      });

      await db
        .update(schema.deployments)
        .set({ defaultHttps: { hostname, status: 'CONFIGURING', checkCycle: 1, lastError: null } })
        .where(eq(schema.deployments.id, deployment.id));
      expect((await endpoint(deployment.id)).endpoint).toMatchObject({ status: 'provisioning', httpsState: 'ACTIVATING' });

      await db
        .update(schema.deployments)
        .set({ defaultHttps: { hostname, status: 'ACTIVE', checkCycle: 1, lastError: null } })
        .where(eq(schema.deployments.id, deployment.id));
      expect(await endpoint(deployment.id)).toMatchObject({
        summary: 'healthy',
        endpoint: { status: 'ready', httpsState: 'READY' },
      });

      await db
        .update(schema.deployments)
        .set({ defaultHttps: { hostname, status: 'ERROR', checkCycle: 2, lastError: 'boom' } })
        .where(eq(schema.deployments.id, deployment.id));
      expect(await endpoint(deployment.id)).toMatchObject({
        summary: 'failed',
        endpoint: { status: 'failed', httpsState: 'FAILED' },
      });
    });

    it('reports the default-HTTPS status apart from a custom domain error', async () => {
      const deployment = await deploymentWithAlb({
        defaultHttps: { hostname: 'd-p0-split.deployz.dev', status: 'ACTIVE', checkCycle: 1, lastError: null },
      });
      await db.insert(schema.customDomains).values({
        deploymentId: deployment.id,
        organizationId: org.organizationId,
        hostname: 'broken.acme.example',
        status: 'ERROR',
      });
      expect((await endpoint(deployment.id)).endpoint).toMatchObject({ httpsState: 'READY', defaultHttpsStatus: 'ACTIVE' });

      await db
        .update(schema.deployments)
        .set({ defaultHttps: { hostname: 'd-p0-split.deployz.dev', status: 'CONFIGURING', checkCycle: 1, lastError: null } })
        .where(eq(schema.deployments.id, deployment.id));
      expect((await endpoint(deployment.id)).endpoint).toMatchObject({ defaultHttpsStatus: 'CONFIGURING' });
    });

    it('an ACTIVE custom domain makes the endpoint ready while the default machine is still pending', async () => {
      const deployment = await deploymentWithAlb({
        defaultHttps: { hostname: 'd-p0-custom.deployz.dev', status: 'PENDING', checkCycle: 0, lastError: null },
      });
      await db.insert(schema.customDomains).values({
        deploymentId: deployment.id,
        organizationId: org.organizationId,
        hostname: 'app.acme.example',
        status: 'ACTIVE',
      });
      expect((await endpoint(deployment.id)).endpoint).toMatchObject({ status: 'ready', httpsState: 'READY' });
    });

    it('a load balancer still being created keeps its CloudFormation status and gets no HTTPS overlay', async () => {
      const deployment = await insertDeployment(db, org.organizationId, applicationId, customerId, {
        state: 'INSTALLING',
        defaultHttps: null,
      });
      await persistDeploymentResourceSnapshot(db, {
        deploymentId: deployment.id,
        stackId: STACK_ID,
        resources: [{ logicalId: 'Alb', type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', status: 'CREATE_IN_PROGRESS' }],
        observedAt: new Date().toISOString(),
      });
      const view = await endpoint(deployment.id);
      expect(view.endpoint.status).toBe('provisioning');
      expect(view.endpoint.httpsState).toBeUndefined();
    });

    it('the application is not Ready until a configured first start has started it', async () => {
      const deployment = await deploymentWithAlb({ defaultHttps: null });
      const applicationStatus = async () => {
        const response = await app.inject({
          method: 'GET',
          url: `/api/deployments/${deployment.id}/infrastructure`,
          headers: { cookie: org.cookie },
        });
        const body = response.json() as { components: Array<{ kind: string; status: string }> };
        return body.components.find((c) => c.kind === 'application')!.status;
      };
      expect(await applicationStatus()).toBe('ready');

      await db.insert(schema.deploymentJobs).values({
        deploymentId: deployment.id,
        type: 'INSTALL',
        state: 'SUCCEEDED',
        idempotencyKey: `${deployment.id}:INSTALL:zero-task`,
        payload: { startAfterConfig: true },
      });
      expect(await applicationStatus()).toBe('pending');

      await db.insert(schema.deploymentJobs).values({
        deploymentId: deployment.id,
        type: 'DEPLOY_RELEASE',
        state: 'SUCCEEDED',
        idempotencyKey: `${deployment.id}:DEPLOY_RELEASE:first-start`,
        payload: {},
      });
      expect(await applicationStatus()).toBe('ready');
    });

    it('a removed deployment keeps the post-deletion view (no overlay)', async () => {
      const deployment = await deploymentWithAlb({
        state: 'DELETED',
        defaultHttps: { hostname: 'd-p0-gone.deployz.dev', status: 'ACTIVE', checkCycle: 1, lastError: null },
      });
      const view = await endpoint(deployment.id);
      expect(view.endpoint.status).toBe('removed');
      expect(view.endpoint.httpsState).toBeUndefined();
    });
  });

  describe('unavailable releases — a READY release whose image is gone is not deployable', () => {
    it('the release list reads UNAVAILABLE once the registry no longer holds the image', async () => {
      const release = await readyRelease();
      expect((await listReleases()).find((r) => r.id === release.id)?.status).toBe('READY');

      registry.markMissing(release.digest);
      // Inside the recheck window the list keeps its last answer.
      expect((await listReleases()).find((r) => r.id === release.id)?.status).toBe('READY');
      // Once the window has passed the registry is asked again.
      await db
        .update(schema.releases)
        .set({ imageCheckedAt: new Date(Date.now() - RELEASE_IMAGE_RECHECK_MS - 1) })
        .where(eq(schema.releases.id, release.id));
      expect((await listReleases()).find((r) => r.id === release.id)?.status).toBe('UNAVAILABLE');
    });

    it('the deploy route refuses a release listed as READY before its image was deleted, and leaves the running release alone', async () => {
      const running = await readyRelease();
      const stale = await readyRelease();
      const deployment = await insertDeployment(db, org.organizationId, applicationId, customerId, {
        state: 'HEALTHY',
        currentReleaseId: running.id,
      });
      // The page loaded the list while the image still existed, then the
      // image was deleted, then the vendor pressed Deploy.
      expect((await listReleases()).find((r) => r.id === stale.id)?.status).toBe('READY');
      registry.markMissing(stale.digest);

      const response = await postJson(app, `/api/deployments/${deployment.id}/deploy`, { releaseId: stale.id }, { cookie: org.cookie });
      expect(response.statusCode, response.body).toBe(409);
      const body = response.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe('RELEASE_UNAVAILABLE');
      expect(body.error.message).toContain(stale.version);
      expect(body.error.message).toContain('Create a new release');
      expect(body.error.message).not.toMatch(/ECR|digest|registry/i);

      const jobs = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.deploymentId, deployment.id));
      expect(jobs).toHaveLength(0);
      const [after] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
      expect(after!.state).toBe('HEALTHY');
      expect(after!.currentReleaseId).toBe(running.id);
      expect((await listReleases()).find((r) => r.id === stale.id)?.status).toBe('UNAVAILABLE');

      // A known-unavailable release is refused deterministically on retry too.
      const retry = await postJson(app, `/api/deployments/${deployment.id}/deploy`, { releaseId: stale.id }, { cookie: org.cookie });
      expect(retry.statusCode).toBe(409);
      expect((retry.json() as { error: { code: string } }).error.code).toBe('RELEASE_UNAVAILABLE');
    });

    it('rollback and bulk deploy apply the same guard', async () => {
      const gone = await readyRelease();
      registry.markMissing(gone.digest);
      const deployment = await insertDeployment(db, org.organizationId, applicationId, customerId, { state: 'HEALTHY' });

      const rollback = await postJson(app, `/api/deployments/${deployment.id}/rollback`, { releaseId: gone.id }, { cookie: org.cookie });
      expect(rollback.statusCode, rollback.body).toBe(409);
      expect((rollback.json() as { error: { code: string } }).error.code).toBe('RELEASE_UNAVAILABLE');

      const bulk = await postJson(app, `/api/applications/${applicationId}/deploy-bulk`, { releaseId: gone.id }, { cookie: org.cookie });
      expect(bulk.statusCode, bulk.body).toBe(409);
      expect((bulk.json() as { error: { code: string } }).error.code).toBe('RELEASE_UNAVAILABLE');

      const jobs = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.deploymentId, deployment.id));
      expect(jobs).toHaveLength(0);
    });

    it('a healthy release still deploys (202) after the guard ran', async () => {
      const release = await readyRelease();
      const deployment = await insertDeployment(db, org.organizationId, applicationId, customerId, { state: 'HEALTHY' });
      const response = await postJson(app, `/api/deployments/${deployment.id}/deploy`, { releaseId: release.id }, { cookie: org.cookie });
      expect(response.statusCode, response.body).toBe(202);
    });

    it('INSTALL success auto-deploys the newest release whose image still exists, skipping an unavailable newer one', async () => {
      const application = await insertApplication(db, org.organizationId);
      const older = await insertRelease(db, application.id, {
        buildStatus: 'SUCCEEDED',
        releaseStatus: 'READY',
        imageDigest: `${REPOSITORY}@${digestFor('older')}`,
      });
      const newerDigest = digestFor('newer');
      const newer = await insertRelease(db, application.id, {
        buildStatus: 'SUCCEEDED',
        releaseStatus: 'READY',
        imageDigest: `${REPOSITORY}@${newerDigest}`,
        createdAt: new Date(Date.now() + 1000),
      });
      registry.markMissing(newerDigest);
      const deployment = await insertDeployment(db, org.organizationId, application.id, customerId, {
        state: 'NOT_INSTALLED',
        installationId: null,
      });
      const installationId = `inst-p0-${crypto.randomUUID()}`;
      const register = await postJson(
        app,
        '/api/relay/register',
        { enrollmentCode: deployment.enrollmentCode, installationId, awsAccountId: '123456789012' },
        { authorization: `Bearer ${RELAY_TOKEN}` },
      );
      expect(register.statusCode, register.body).toBe(200);
      const claimed = await app.inject({
        method: 'GET',
        url: `/api/relay/commands?installationId=${installationId}`,
        headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      });
      const installJob = (claimed.json() as { commands: Array<{ id: string; type: string }> }).commands.find(
        (c) => c.type === 'INSTALL',
      )!;
      const result = await postJson(
        app,
        `/api/relay/commands/${installJob.id}/result`,
        { success: true },
        { authorization: `Bearer ${RELAY_TOKEN}` },
      );
      expect(result.statusCode, result.body).toBe(200);

      const deployJobs = await db
        .select()
        .from(schema.deploymentJobs)
        .where(and(eq(schema.deploymentJobs.deploymentId, deployment.id), eq(schema.deploymentJobs.type, 'DEPLOY_RELEASE')));
      expect(deployJobs).toHaveLength(1);
      expect(deployJobs[0]!.payload).toMatchObject({ releaseId: older.id });
      const [markedNewer] = await db.select().from(schema.releases).where(eq(schema.releases.id, newer.id));
      expect(markedNewer!.imageUnavailableAt).not.toBeNull();
    });
  });

  describe('relay heartbeat — verification check text is redacted at ingest', () => {
    it('stores the relay checks with secret-looking values redacted', async () => {
      const token = 'p0-heartbeat-token';
      const installationId = `inst-p0-hb-${crypto.randomUUID()}`;
      const deployment = await insertDeployment(db, org.organizationId, applicationId, customerId, {
        state: 'HEALTHY',
        installationId,
        enrollmentCode: crypto.randomUUID(),
        enrollmentUsedAt: new Date(),
        relayTokenHash: hashRelayToken(token),
        relayStatus: 'CONNECTED',
      });
      const response = await postJson(
        app,
        '/api/relay/health',
        {
          installationId,
          healthStatus: 'HEALTHY',
          observedState: {
            infraHealth: {
              checks: [
                { name: 'stack-exists', passed: true, detail: 'Stack "deployz-app" found' },
                { name: 'database', passed: false, detail: 'DATABASE_PASSWORD=hunter2 rejected by the database' },
              ],
            },
          },
        },
        { authorization: `Bearer ${token}` },
      );
      expect(response.statusCode, response.body).toBe(200);
      const [row] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
      const checks = (row!.observedState as { infraHealth: { checks: Array<{ detail: string }> } }).infraHealth.checks;
      expect(checks[0]!.detail).toBe('Stack "deployz-app" found');
      expect(checks[1]!.detail).not.toContain('hunter2');
      expect(checks[1]!.detail).toContain('[REDACTED]');
    });
  });
});

// ── Commit selector (releases) — real (non-fixture) GitHub routes ──────────
describe('server — commit selector (releases)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };
  let other: { userId: string; organizationId: string; cookie: string };
  let applicationId: string;

  const FULL_SHA = 'a'.repeat(40);

  const githubFetch = (async (url: string) => {
    if (url.includes('/access_tokens')) {
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => ({ token: 'commit-installation-token', expires_at: new Date().toISOString() }),
      };
    }
    if (url.includes(`/commits/${FULL_SHA}`)) {
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          sha: FULL_SHA,
          commit: { message: 'Fix the thing', author: { name: 'Jane', date: '2026-09-23T10:00:00Z' } },
        }),
      };
    }
    if (url.includes('/commits/')) {
      return { status: 404, headers: { get: () => null }, json: async () => ({ message: 'No commit found' }) };
    }
    if (url.includes('/repos/acme/widgets/commits?sha=main')) {
      return {
        status: 200,
        headers: { get: () => null },
        json: async () =>
          Array.from({ length: 30 }, (_, i) => ({
            sha: i.toString(16).padStart(40, '0'),
            commit: { message: `Commit ${i}`, author: { name: 'Jane', date: '2026-09-23T10:00:00Z' } },
          })),
      };
    }
    return { status: 404, headers: { get: () => null }, json: async () => ({ message: 'Not Found' }) };
  }) as unknown as Parameters<typeof buildServer>[0]['githubFetch'];

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    app = await buildServer({
      auth,
      db,
      githubFixtureMode: false,
      githubFetch,
      githubAppId: 'test-app-id',
      githubAppPrivateKey: generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      }).privateKey,
    });
    org = await signUpAndGetOrg(auth, db, 'commits-owner@example.com');
    other = await signUpAndGetOrg(auth, db, 'commits-other@example.com');
    await db.insert(schema.githubInstallations).values({
      id: 'inst-commits-owner',
      organizationId: org.organizationId,
      accountLogin: 'acme',
      accountType: 'Organization',
    });
    await db.insert(schema.githubInstallations).values({
      id: 'inst-commits-other',
      organizationId: other.organizationId,
      accountLogin: 'other-org',
      accountType: 'Organization',
    });
    const application = await insertApplication(db, org.organizationId, {
      githubInstallationId: 'inst-commits-owner',
      repoFullName: 'acme/widgets',
      defaultBranch: 'main',
    });
    applicationId = application.id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('lists a real page of commits scoped to the application repo/branch', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${applicationId}/commits?page=1`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as {
      repoFullName: string;
      branch: string;
      commits: unknown[];
      nextPage: number | null;
    };
    expect(body.repoFullName).toBe('acme/widgets');
    expect(body.branch).toBe('main');
    expect(body.commits).toHaveLength(30);
    expect(body.nextPage).toBe(2);
  });

  it('404s a cross-org application (authorization boundary)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${applicationId}/commits`,
      headers: { cookie: other.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects unauthenticated access with 401', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/applications/${applicationId}/commits` });
    expect(response.statusCode).toBe(401);
  });

  it('409s GITHUB_NOT_CONNECTED when the application has no githubInstallationId', async () => {
    const unconnected = await insertApplication(db, org.organizationId, {
      repoFullName: 'acme/unconnected',
      defaultBranch: 'main',
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${unconnected.id}/commits`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode).toBe(409);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('GITHUB_NOT_CONNECTED');
  });

  it('409s GITHUB_NOT_CONNECTED when the installation is owned by a different org', async () => {
    const orphan = await insertApplication(db, org.organizationId, {
      githubInstallationId: 'inst-commits-other',
      repoFullName: 'acme/orphan',
      defaultBranch: 'main',
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${orphan.id}/commits`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode).toBe(409);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('GITHUB_NOT_CONNECTED');
  });

  it('resolves a valid full sha via the manual-entry route', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${applicationId}/commits/${FULL_SHA}`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as { commit: { sha: string; title: string } };
    expect(body.commit.sha).toBe(FULL_SHA);
    expect(body.commit.title).toBe('Fix the thing');
  });

  it('rejects a branch name as an invalid sha format with 400 INVALID_COMMIT_SHA', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${applicationId}/commits/main`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('INVALID_COMMIT_SHA');
  });

  it('404s COMMIT_NOT_FOUND for a well-formed but unknown sha', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${applicationId}/commits/${'b'.repeat(40)}`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('COMMIT_NOT_FOUND');
  });
});

// ── Releases list — gitSha field (commit selector, §22 additive change) ────
describe('server — releases list includes gitSha', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };
  let applicationId: string;

  const LEGACY_GIT_SHA = 'sha-1.0.0';
  const FULL_GIT_SHA = 'c'.repeat(40);

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    app = await buildServer({ auth, db });
    org = await signUpAndGetOrg(auth, db, 'releases-gitsha@example.com');
    const application = await insertApplication(db, org.organizationId);
    applicationId = application.id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('returns gitSha for each release, including a legacy non-hex value', async () => {
    await insertRelease(db, applicationId, { version: 'v1.0.0', gitSha: FULL_GIT_SHA });
    // Backwards compatibility: releases created before the commit selector
    // stored arbitrary strings (e.g. e2e fixtures posting "sha-1.0.0") and the
    // create route still accepts them — the list route must not choke on one.
    await insertRelease(db, applicationId, { version: LEGACY_GIT_SHA, gitSha: LEGACY_GIT_SHA });

    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${applicationId}/releases`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const releases = (response.json() as { releases: Array<{ version: string; gitSha: string }> }).releases;
    expect(releases.find((r) => r.version === 'v1.0.0')?.gitSha).toBe(FULL_GIT_SHA);
    expect(releases.find((r) => r.version === LEGACY_GIT_SHA)?.gitSha).toBe(LEGACY_GIT_SHA);
  });
});
