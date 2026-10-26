import { PGlite } from '@electric-sql/pglite';
import { customerSessionHeaders } from './customer-access-fixture.js';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { errorEnvelopeSchema } from '@deployz/contracts';
import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import type { DomainCheckDeps } from './domain-check.js';
import { DOMAIN_VALIDATION_MESSAGES } from './domain-validation.js';
import { hashRelayToken } from './relay-store.js';
import { buildServer } from './server.js';

// Task 4 — POST/GET /api/deployments/:id/domain and the relay-result
// integration that applies CONFIGURE_DOMAIN outcomes to the domain row
// without ever touching deployments.state.
//
// Task 5 — the verification flow: POST .../domain/check ("Check now"),
// DELETE .../domain (removal), the unauthenticated link-scoped check route,
// and the destroy-time domain cleanup (both the request-time REMOVE_DOMAIN
// enqueue and the DESTROY-success safety net).

// ── Shared test helpers (mirrors server.test.ts) ────────────────────────────

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

/** POST a JSON body through app.inject, matching server.ts's raw-string JSON parser. */
function postJson(
  app: FastifyInstance,
  url: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    payload: JSON.stringify(body),
  });
}

// ── POST / GET /api/deployments/:id/domain ──────────────────────────────────

describe('custom domain routes', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };
  let deployment: typeof schema.deployments.$inferSelect;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    app = await buildServer({ auth, db });

    org = await signUpAndGetOrg(auth, db, 'domain-owner@example.com');
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('GET returns { domain: null } before any domain is added', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}/domain`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ domain: null });
  });

  it('unauthenticated POST is rejected', async () => {
    const response = await postJson(app, `/api/deployments/${deployment.id}/domain`, {
      hostname: 'app.customer.com',
    });
    expect(response.statusCode).toBe(401);
  });

  it('POST rejects a URL instead of a bare hostname', async () => {
    const response = await postJson(
      app,
      `/api/deployments/${deployment.id}/domain`,
      { hostname: 'https://app.customer.com' },
      { cookie: org.cookie },
    );
    expect(response.statusCode).toBe(400);
    const envelope = errorEnvelopeSchema.parse(response.json());
    expect(envelope.error.code).toBe('URL_ENTERED');
    expect(envelope.error.message).toBe(DOMAIN_VALIDATION_MESSAGES.URL_ENTERED);
  });

  it('POST for a deployment in another org 404s (IDOR guard)', async () => {
    const otherOrg = await signUpAndGetOrg(auth, db, 'other-org@example.com');
    const response = await postJson(
      app,
      `/api/deployments/${deployment.id}/domain`,
      { hostname: 'app.customer.com' },
      { cookie: otherOrg.cookie },
    );
    expect(response.statusCode).toBe(404);
  });

  it('POST with a valid hostname creates a pending domain', async () => {
    const response = await postJson(
      app,
      `/api/deployments/${deployment.id}/domain`,
      { hostname: 'app.customer.com' },
      { cookie: org.cookie },
    );
    expect(response.statusCode).toBe(201);
    const body = response.json() as { domain: { hostname: string; status: string } };
    expect(body.domain.status).toBe('pending');
    expect(body.domain.hostname).toBe('app.customer.com');

    const job = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    expect(job.some((row) => row.type === 'CONFIGURE_DOMAIN')).toBe(true);
  });

  it('GET returns the domain view after it is created', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}/domain`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { domain: { hostname: string; status: string } | null };
    expect(body.domain).not.toBeNull();
    expect(body.domain!.hostname).toBe('app.customer.com');
    expect(body.domain!.status).toBe('pending');
  });

  it('POST for a second org with the same hostname is rejected as taken, without naming the first org', async () => {
    const secondOrg = await signUpAndGetOrg(auth, db, 'second-org@example.com');
    const secondApplication = await insertApplication(db, secondOrg.organizationId);
    const secondCustomer = await insertCustomer(db, secondOrg.organizationId);
    const secondDeployment = await insertDeployment(
      db,
      secondOrg.organizationId,
      secondApplication.id,
      secondCustomer.id,
    );

    const [firstOrgRow] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.id, org.organizationId));

    const response = await postJson(
      app,
      `/api/deployments/${secondDeployment.id}/domain`,
      { hostname: 'app.customer.com' },
      { cookie: secondOrg.cookie },
    );
    expect(response.statusCode).toBe(409);
    const envelope = errorEnvelopeSchema.parse(response.json());
    expect(envelope.error.code).toBe('DOMAIN_TAKEN');
    expect(envelope.error.message).not.toContain(firstOrgRow!.name);
  });

  it('a custom-domain request body can never write the default-HTTPS routing target', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const victim = await insertDeployment(db, org.organizationId, application.id, customer.id);

    // A hostile body laces the customer-owned fields with default-HTTPS DNS
    // fields. The route only reads `hostname`; the default-HTTPS state machine
    // (deployments.default_https) is driven exclusively by relay job results.
    const response = await postJson(
      app,
      `/api/deployments/${victim.id}/domain`,
      {
        hostname: `app.${crypto.randomUUID().slice(0, 8)}.customer.com`,
        routingTarget: 'attacker-controlled-alb.example.com',
        validationName: '_x.attacker.example.com',
        validationValue: '_y.acm-validations.aws.',
        defaultHttps: {
          hostname: 'd-evil.deployz.dev',
          status: 'ACTIVE',
          routingTarget: 'attacker-controlled-alb.example.com',
        },
      },
      { cookie: org.cookie },
    );
    expect(response.statusCode).toBe(201);

    const rows = await db
      .select({ defaultHttps: schema.deployments.defaultHttps })
      .from(schema.deployments)
      .where(eq(schema.deployments.id, victim.id))
      .limit(1);
    expect(rows[0]?.defaultHttps ?? null).toBeNull();
  });
});

// ── Relay result integration ─────────────────────────────────────────────────

describe('custom domain relay result integration', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };
  const RELAY_TOKEN = 'relay-token-domain-xyz';

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    app = await buildServer({ auth, db });
    org = await signUpAndGetOrg(auth, db, 'relay-domain-org@example.com');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  /** Seeds a bound deployment + a pending custom domain + its CONFIGURE_DOMAIN job. */
  async function seedDomainInFlight() {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      // A domain being configured on an already-healthy deployment is the
      // real shape here — the regression this guards is nextState clobbering
      // an unrelated deployment lifecycle state.
      state: 'HEALTHY',
      installationId: `inst-${crypto.randomUUID()}`,
      relayTokenHash: hashRelayToken(RELAY_TOKEN),
    });
    const [domain] = await db
      .insert(schema.customDomains)
      .values({
        deploymentId: deployment.id,
        organizationId: org.organizationId,
        hostname: `app-${crypto.randomUUID().slice(0, 8)}.customer.com`,
        status: 'PENDING',
        createdBy: org.userId,
      })
      .returning();
    const [job] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: deployment.id,
        type: 'CONFIGURE_DOMAIN',
        state: 'RUNNING',
        idempotencyKey: `${deployment.id}:CONFIGURE_DOMAIN:${domain!.id}:0`,
        payload: { hostname: domain!.hostname, domainId: domain!.id },
      })
      .returning();
    return { deployment, domain: domain!, job: job! };
  }

  it('a successful CONFIGURE_DOMAIN result moves the domain to WAITING_FOR_DNS and leaves deployments.state unchanged', async () => {
    const { deployment, domain, job } = await seedDomainInFlight();

    const response = await postJson(
      app,
      `/api/relay/commands/${job.id}/result`,
      {
        success: true,
        output: {
          validationName: `_acme-challenge.${domain.hostname}`,
          validationValue: 'validation-value-abc',
        },
      },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(response.statusCode).toBe(200);

    const [updatedDomain] = await db
      .select()
      .from(schema.customDomains)
      .where(eq(schema.customDomains.id, domain.id));
    expect(updatedDomain!.status).toBe('WAITING_FOR_DNS');

    const [updatedDeployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id));
    expect(updatedDeployment!.state).toBe('HEALTHY');
  });

  it('a failed CONFIGURE_DOMAIN result moves the domain to ERROR and leaves deployments.state unchanged (regression guard)', async () => {
    const { deployment, domain, job } = await seedDomainInFlight();

    const response = await postJson(
      app,
      `/api/relay/commands/${job.id}/result`,
      { success: false, error: 'certificate request failed' },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(response.statusCode).toBe(200);

    const [updatedDomain] = await db
      .select()
      .from(schema.customDomains)
      .where(eq(schema.customDomains.id, domain.id));
    expect(updatedDomain!.status).toBe('ERROR');

    // This is the regression guard for the `nextState = 'FAILED'` pitfall:
    // a failed domain job must never drag the deployment's own lifecycle
    // state down with it.
    const [updatedDeployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id));
    expect(updatedDeployment!.state).toBe('HEALTHY');
  });
});

// ── POST /api/deployments/:id/domain/check and DELETE /api/deployments/:id/domain ──

describe('custom domain check-now and DELETE routes', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };
  let deployment: typeof schema.deployments.$inferSelect;

  // Deterministic and swappable per test — buildServer is constructed once
  // in beforeAll, so each test point these closures at what it needs rather
  // than rebuilding the server.
  let checkCnameResult: (name: string) => boolean = () => true;
  const domainCheckDeps: DomainCheckDeps = {
    minCheckIntervalMs: 0,
    checkCname: async (name) => checkCnameResult(name),
    probeHttps: async () => ({ ok: true }),
  };

  async function jobsFor(deploymentId: string, type: 'CONFIGURE_DOMAIN' | 'REMOVE_DOMAIN') {
    return db
      .select()
      .from(schema.deploymentJobs)
      .where(and(eq(schema.deploymentJobs.deploymentId, deploymentId), eq(schema.deploymentJobs.type, type)));
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    app = await buildServer({ auth, db, domainCheckDeps });

    org = await signUpAndGetOrg(auth, db, 'domain-check-owner@example.com');
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    // HEALTHY: check-now drives runDomainCheck, which now short-circuits for
    // a deployment with no running infrastructure — these tests exercise the
    // DNS/HTTPS-probing path, so the deployment must be running.
    deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'HEALTHY',
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('check-now 404s when the deployment has no active domain', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/deployments/${deployment.id}/domain/check`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('unauthenticated check-now is rejected', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/deployments/${deployment.id}/domain/check`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('unauthenticated DELETE is rejected', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/deployments/${deployment.id}/domain`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('check-now on WAITING_FOR_DNS with a failing validation CNAME reports DNS_VALIDATION_NOT_FOUND', async () => {
    const created = await postJson(
      app,
      `/api/deployments/${deployment.id}/domain`,
      { hostname: 'check.customer.com' },
      { cookie: org.cookie },
    );
    expect(created.statusCode).toBe(201);
    await db
      .update(schema.customDomains)
      .set({
        status: 'WAITING_FOR_DNS',
        validationName: '_acme.check.customer.com',
        validationValue: '_xyz.acm-validations.aws.',
      })
      .where(eq(schema.customDomains.deploymentId, deployment.id));

    checkCnameResult = () => false;
    const response = await app.inject({
      method: 'POST',
      url: `/api/deployments/${deployment.id}/domain/check`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { domain: { status: string; error: string | null } };
    expect(body.domain.status).toBe('waiting_for_dns');
    expect(body.domain.error).toBe('DNS_VALIDATION_NOT_FOUND');
  });

  it('check-now on a FAILED deployment short-circuits to DEPLOYMENT_NOT_RUNNING instead of blaming DNS/HTTPS', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const failedDeployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'FAILED',
    });
    const created = await postJson(
      app,
      `/api/deployments/${failedDeployment.id}/domain`,
      { hostname: `failed-${crypto.randomUUID().slice(0, 8)}.customer.com` },
      { cookie: org.cookie },
    );
    expect(created.statusCode).toBe(201);
    await db
      .update(schema.customDomains)
      .set({ status: 'CONFIGURING' })
      .where(eq(schema.customDomains.deploymentId, failedDeployment.id));

    const response = await app.inject({
      method: 'POST',
      url: `/api/deployments/${failedDeployment.id}/domain/check`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { domain: { status: string; error: string | null } };
    expect(body.domain.status).toBe('configuring');
    expect(body.domain.error).toBe('DEPLOYMENT_NOT_RUNNING');
  });

  it('DELETE removes the domain (removing status + a REMOVE_DOMAIN job); DELETE again is 200 with no duplicate unfinished job', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/deployments/${deployment.id}/domain`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { domain: { status: string } };
    expect(body.domain.status).toBe('removing');

    const jobsAfterFirst = await jobsFor(deployment.id, 'REMOVE_DOMAIN');
    expect(jobsAfterFirst).toHaveLength(1);

    const second = await app.inject({
      method: 'DELETE',
      url: `/api/deployments/${deployment.id}/domain`,
      headers: { cookie: org.cookie },
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { domain: { status: string } }).domain.status).toBe('removing');

    const jobsAfterSecond = await jobsFor(deployment.id, 'REMOVE_DOMAIN');
    expect(jobsAfterSecond).toHaveLength(1);
  });
});

// ── POST /api/install/:installLinkId/domain/check (link-scoped, unauthenticated) ──

describe('custom domain link-scoped check route', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };
  let deployment: typeof schema.deployments.$inferSelect;

  const domainCheckDeps: DomainCheckDeps = {
    minCheckIntervalMs: 0,
    checkCname: async () => true,
    probeHttps: async () => ({ ok: true }),
  };

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    app = await buildServer({ auth, db, domainCheckDeps });

    org = await signUpAndGetOrg(auth, db, 'domain-link-owner@example.com');
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    // HEALTHY: the link-scoped check route also drives runDomainCheck.
    deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'HEALTHY',
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('404s on an unknown install link', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/install/${crypto.randomUUID()}/domain/check`,
    });
    expect(response.statusCode).toBe(404);
  });

  it('404s when the deployment behind a known install link has no active domain', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/install/${deployment.installLinkId}/domain/check`,
      headers: await customerSessionHeaders(db, deployment.installLinkId),
    });
    expect(response.statusCode).toBe(404);
  });

  it('works unauthenticated and returns the domain view once a domain exists', async () => {
    await postJson(
      app,
      `/api/deployments/${deployment.id}/domain`,
      { hostname: 'linkcheck.customer.com' },
      { cookie: org.cookie },
    );
    await db
      .update(schema.customDomains)
      .set({ status: 'CONFIGURING' })
      .where(eq(schema.customDomains.deploymentId, deployment.id));

    const response = await app.inject({
      method: 'POST',
      url: `/api/install/${deployment.installLinkId}/domain/check`,
      headers: await customerSessionHeaders(db, deployment.installLinkId),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { domain: { status: string; url: string | null } };
    expect(body.domain.status).toBe('active');
    expect(body.domain.url).toBe('https://linkcheck.customer.com');
  });

  // Task 10 — GET /api/install/:installLinkId carries the same deployment
  // and domain context the link-scoped check route above already exposes
  // unauthenticated, so the customer-facing page can render a domain card
  // without a second round trip.
  it('GET /api/install/:installLinkId includes the deployment id/state and the active domain view', async () => {
    const [domainRow] = await db
      .select()
      .from(schema.customDomains)
      .where(eq(schema.customDomains.deploymentId, deployment.id));

    const response = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}`, headers: await customerSessionHeaders(db, deployment.installLinkId) });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      deploymentId: string;
      deploymentState: string;
      domain: { status: string; hostname: string; url: string | null } | null;
      routingTarget: string | null;
    };
    expect(body.deploymentId).toBe(deployment.id);
    expect(body.deploymentState).toBe(deployment.state);
    expect(body.domain).not.toBeNull();
    expect(body.domain?.status).toBe('active');
    expect(body.domain?.hostname).toBe('linkcheck.customer.com');
    expect(body.domain?.url).toBe('https://linkcheck.customer.com');
    expect(body.routingTarget).toBe(domainRow!.routingTarget);
  });
});

// ── Destroy-time domain cleanup ──────────────────────────────────────────────

describe('custom domain destroy cleanup', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };
  const RELAY_TOKEN = 'relay-token-destroy-xyz';

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    app = await buildServer({ auth, db });
    org = await signUpAndGetOrg(auth, db, 'domain-destroy-owner@example.com');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  /** A HEALTHY, relay-bound deployment with a live custom domain — the shape
   *  that reaches the destroy route's relay-job branch (not the
   *  never-installed shortcut). */
  async function seedHealthyDeploymentWithDomain() {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'HEALTHY',
      installationId: `inst-${crypto.randomUUID()}`,
      relayTokenHash: hashRelayToken(RELAY_TOKEN),
    });
    const created = await postJson(
      app,
      `/api/deployments/${deployment.id}/domain`,
      { hostname: `destroy-${crypto.randomUUID().slice(0, 8)}.customer.com` },
      { cookie: org.cookie },
    );
    const domain = (created.json() as { domain: { hostname: string } }).domain;
    return { deployment, domain };
  }

  it('destroying a deployment also enqueues a REMOVE_DOMAIN job and marks the domain removing', async () => {
    const { deployment } = await seedHealthyDeploymentWithDomain();

    const response = await postJson(app, `/api/deployments/${deployment.id}/destroy`, {}, { cookie: org.cookie });
    expect(response.statusCode).toBe(202);

    const [domainRow] = await db
      .select()
      .from(schema.customDomains)
      .where(eq(schema.customDomains.deploymentId, deployment.id));
    expect(domainRow!.status).toBe('REMOVING');

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    expect(jobs.some((job) => job.type === 'DESTROY')).toBe(true);
    expect(jobs.some((job) => job.type === 'REMOVE_DOMAIN')).toBe(true);
  });

  it('a successful DESTROY relay result force-removes the domain even if its own REMOVE_DOMAIN job never finished (safety net)', async () => {
    const { deployment } = await seedHealthyDeploymentWithDomain();
    const destroyResponse = await postJson(
      app,
      `/api/deployments/${deployment.id}/destroy`,
      {},
      { cookie: org.cookie },
    );
    const { jobId } = destroyResponse.json() as { jobId: string };

    // The domain's own REMOVE_DOMAIN job is left RUNNING/unfinished on
    // purpose — the point of this test is that DESTROY succeeding is enough
    // on its own, without waiting on that job.
    await db
      .update(schema.deploymentJobs)
      .set({ state: 'RUNNING', startedAt: new Date() })
      .where(eq(schema.deploymentJobs.id, jobId));
    const result = await postJson(
      app,
      `/api/relay/commands/${jobId}/result`,
      { success: true },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
    expect(result.statusCode).toBe(200);

    const [domainRow] = await db
      .select()
      .from(schema.customDomains)
      .where(eq(schema.customDomains.deploymentId, deployment.id));
    expect(domainRow!.removedAt).not.toBeNull();

    const [deploymentRow] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id));
    expect(deploymentRow!.state).toBe('DELETED');
  });
});

// ── Relay-heartbeat custom-domain auto-check ─────────────────────────────────
//
// POST /api/relay/health piggybacks a best-effort runDomainCheck call onto
// the relay's existing ~5-minute heartbeat (server.ts ~2561-2575), gated on
// domain status and a 180s lastCheckedAt staleness floor. Nothing about the
// hook may ever fail the health report itself.

describe('custom domain relay-heartbeat auto-check', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };
  const RELAY_TOKEN = 'relay-token-heartbeat-xyz';

  // Swappable per test — buildServer is constructed once in beforeAll.
  let checkCname: DomainCheckDeps['checkCname'] = async () => true;
  const domainCheckDeps: DomainCheckDeps = {
    minCheckIntervalMs: 0,
    checkCname: async (name, expectedTarget) => checkCname(name, expectedTarget),
    probeHttps: async () => ({ ok: true }),
  };

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    app = await buildServer({ auth, db, domainCheckDeps });
    org = await signUpAndGetOrg(auth, db, 'domain-heartbeat-owner@example.com');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  /** A relay-bound, HEALTHY deployment with an active WAITING_FOR_DNS
   *  domain — the shape the heartbeat auto-check acts on. */
  async function seedHeartbeatDeployment(lastCheckedAt: Date | null) {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const installationId = `inst-${crypto.randomUUID()}`;
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'HEALTHY',
      installationId,
      relayTokenHash: hashRelayToken(RELAY_TOKEN),
    });
    const [domain] = await db
      .insert(schema.customDomains)
      .values({
        deploymentId: deployment.id,
        organizationId: org.organizationId,
        hostname: `heartbeat-${crypto.randomUUID().slice(0, 8)}.customer.com`,
        status: 'WAITING_FOR_DNS',
        validationName: '_acme.heartbeat.customer.com',
        validationValue: '_xyz.acm-validations.aws.',
        lastCheckedAt,
        createdBy: org.userId,
      })
      .returning();
    return { deployment, domain: domain! };
  }

  function postHeartbeat(installationId: string, healthStatus = 'HEALTHY') {
    return postJson(
      app,
      '/api/relay/health',
      { installationId, healthStatus },
      { authorization: `Bearer ${RELAY_TOKEN}` },
    );
  }

  it('fires the auto-check when the domain has never been checked (lastCheckedAt null)', async () => {
    checkCname = async () => false;
    const { deployment, domain } = await seedHeartbeatDeployment(null);

    const response = await postHeartbeat(deployment.installationId!);
    expect(response.statusCode).toBe(200);

    const [domainRow] = await db.select().from(schema.customDomains).where(eq(schema.customDomains.id, domain.id));
    // runDomainCheck ran: lastCheckedAt was stamped and the failing CNAME
    // check recorded its error.
    expect(domainRow!.lastCheckedAt).not.toBeNull();
    expect(domainRow!.lastError).toBe('DNS_VALIDATION_NOT_FOUND');
  });

  it('fires the auto-check when lastCheckedAt is stale (> 180s ago)', async () => {
    checkCname = async () => false;
    const staleAt = new Date(Date.now() - 200_000);
    const { deployment, domain } = await seedHeartbeatDeployment(staleAt);

    const response = await postHeartbeat(deployment.installationId!);
    expect(response.statusCode).toBe(200);

    const [domainRow] = await db.select().from(schema.customDomains).where(eq(schema.customDomains.id, domain.id));
    expect(domainRow!.lastCheckedAt!.getTime()).toBeGreaterThan(staleAt.getTime());
  });

  it('skips the auto-check when lastCheckedAt is fresh (< 180s ago) — the staleness gate', async () => {
    checkCname = async () => false;
    const freshAt = new Date();
    const { deployment, domain } = await seedHeartbeatDeployment(freshAt);

    const response = await postHeartbeat(deployment.installationId!);
    expect(response.statusCode).toBe(200);

    const [domainRow] = await db.select().from(schema.customDomains).where(eq(schema.customDomains.id, domain.id));
    // Unchanged down to the millisecond: the hook never touched the row.
    expect(domainRow!.lastCheckedAt!.getTime()).toBe(freshAt.getTime());
    expect(domainRow!.lastError).toBeNull();
  });

  it('is best-effort: a throwing domainCheckDeps must not fail the heartbeat, and health data is still recorded', async () => {
    checkCname = async () => {
      throw new Error('DNS resolver exploded');
    };
    const { deployment } = await seedHeartbeatDeployment(null);

    const response = await postHeartbeat(deployment.installationId!, 'DEGRADED');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    const [deploymentRow] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id));
    expect(deploymentRow!.relayStatus).toBe('CONNECTED');
    expect(deploymentRow!.lastHealthAt).not.toBeNull();
    expect(deploymentRow!.healthStatus).toBe('DEGRADED');
  });
});

// ── GET /api/deployments/:id — customDomain summary (Task 11) ───────────────
//
// The deployment-detail route attaches a compact { hostname, status }
// summary of the active custom domain, sourced via findActiveDomain — the
// fleet LIST endpoint (toFleetRow) must stay untouched.

describe('GET /api/deployments/:id customDomain summary', () => {
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
    app = await buildServer({ auth, db });
    org = await signUpAndGetOrg(auth, db, 'detail-domain-owner@example.com');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('is null when the deployment has no custom domain', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);

    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}`,
      headers: { cookie: org.cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().customDomain).toBeNull();
  });

  it('is { hostname, status } (lowercase) when an active custom domain exists', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);
    const hostname = `active-${crypto.randomUUID().slice(0, 8)}.customer.com`;
    await db.insert(schema.customDomains).values({
      deploymentId: deployment.id,
      organizationId: org.organizationId,
      hostname,
      status: 'ACTIVE',
      createdBy: org.userId,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}`,
      headers: { cookie: org.cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().customDomain).toEqual({ hostname, status: 'active' });
  });
});

// ── GET /api/deployments/:id — appUrl ────────────────────────────────────────
//
// The plan's preferred-URL model (Phase 7): an ACTIVE custom domain wins;
// every other custom-domain state (PENDING/WAITING_FOR_DNS/CONFIGURING/ERROR)
// falls to the default-HTTPS URL once it serves, and only then to the latest
// successful INSTALL job's ALB endpoint (result.output.outputs.
// ExportDeployzApplicationPublicEndpoint).

describe('GET /api/deployments/:id appUrl', () => {
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
    app = await buildServer({ auth, db });
    org = await signUpAndGetOrg(auth, db, 'app-url-owner@example.com');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  async function seedDeployment(): Promise<typeof schema.deployments.$inferSelect> {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    return insertDeployment(db, org.organizationId, application.id, customer.id);
  }

  async function seedInstallJob(
    deploymentId: string,
    overrides: Partial<typeof schema.deploymentJobs.$inferInsert> = {},
  ): Promise<void> {
    await db.insert(schema.deploymentJobs).values({
      deploymentId,
      type: 'INSTALL',
      state: 'SUCCEEDED',
      idempotencyKey: `${deploymentId}:INSTALL:${crypto.randomUUID()}`,
      finishedAt: new Date(),
      ...overrides,
    });
  }

  async function getAppUrl(deploymentId: string): Promise<unknown> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deploymentId}`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode).toBe(200);
    return response.json().appUrl;
  }

  it('is null when there are no jobs at all', async () => {
    const deployment = await seedDeployment();
    expect(await getAppUrl(deployment.id)).toBeNull();
  });

  it('is the ALB endpoint (http) for a successful INSTALL', async () => {
    const deployment = await seedDeployment();
    await seedInstallJob(deployment.id, {
      result: {
        success: true,
        output: { outputs: { ExportDeployzApplicationPublicEndpoint: 'alb-1.us-east-1.elb.amazonaws.com' } },
      },
    });
    expect(await getAppUrl(deployment.id)).toBe('http://alb-1.us-east-1.elb.amazonaws.com');
  });

  it('matches a renamed stack output key by its PublicEndpoint suffix', async () => {
    const deployment = await seedDeployment();
    await seedInstallJob(deployment.id, {
      result: {
        success: true,
        output: {
          outputs: { ExportDeployzApplicationRedisPublicEndpoint: 'alb-redis.us-east-1.elb.amazonaws.com' },
        },
      },
    });
    expect(await getAppUrl(deployment.id)).toBe('http://alb-redis.us-east-1.elb.amazonaws.com');
  });

  it('picks the latest successful INSTALL when there are several', async () => {
    const deployment = await seedDeployment();
    await seedInstallJob(deployment.id, {
      createdAt: new Date('2026-01-01T00:00:00Z'),
      result: {
        output: { outputs: { ExportDeployzApplicationPublicEndpoint: 'alb-old.us-east-1.elb.amazonaws.com' } },
      },
    });
    await seedInstallJob(deployment.id, {
      createdAt: new Date('2026-01-02T00:00:00Z'),
      result: {
        output: { outputs: { ExportDeployzApplicationPublicEndpoint: 'alb-new.us-east-1.elb.amazonaws.com' } },
      },
    });
    expect(await getAppUrl(deployment.id)).toBe('http://alb-new.us-east-1.elb.amazonaws.com');
  });

  it('ignores a failed INSTALL after a successful one and uses the older success', async () => {
    const deployment = await seedDeployment();
    await seedInstallJob(deployment.id, {
      createdAt: new Date('2026-01-01T00:00:00Z'),
      result: {
        output: { outputs: { ExportDeployzApplicationPublicEndpoint: 'alb-good.us-east-1.elb.amazonaws.com' } },
      },
    });
    await seedInstallJob(deployment.id, {
      createdAt: new Date('2026-01-02T00:00:00Z'),
      state: 'FAILED',
      result: { success: false },
    });
    expect(await getAppUrl(deployment.id)).toBe('http://alb-good.us-east-1.elb.amazonaws.com');
  });

  it('is null when every INSTALL failed', async () => {
    const deployment = await seedDeployment();
    await seedInstallJob(deployment.id, { state: 'FAILED', result: { success: false } });
    expect(await getAppUrl(deployment.id)).toBeNull();
  });

  it('is null for a successful INSTALL with no result', async () => {
    const deployment = await seedDeployment();
    await seedInstallJob(deployment.id);
    expect(await getAppUrl(deployment.id)).toBeNull();
  });

  it('is null for a successful INSTALL with a result missing output.outputs', async () => {
    const deployment = await seedDeployment();
    await seedInstallJob(deployment.id, { result: { success: true } });
    expect(await getAppUrl(deployment.id)).toBeNull();
  });

  it('is null for a successful INSTALL whose outputs is not an object', async () => {
    const deployment = await seedDeployment();
    await seedInstallJob(deployment.id, { result: { output: { outputs: 'nope' } } });
    expect(await getAppUrl(deployment.id)).toBeNull();
  });

  it('is null for a successful INSTALL with a non-string endpoint', async () => {
    const deployment = await seedDeployment();
    await seedInstallJob(deployment.id, {
      result: { output: { outputs: { ExportDeployzApplicationPublicEndpoint: 42 } } },
    });
    expect(await getAppUrl(deployment.id)).toBeNull();
  });

  it('is null for a successful INSTALL with an empty endpoint', async () => {
    const deployment = await seedDeployment();
    await seedInstallJob(deployment.id, {
      result: { output: { outputs: { ExportDeployzApplicationPublicEndpoint: '' } } },
    });
    expect(await getAppUrl(deployment.id)).toBeNull();
  });

  it('prefers an ACTIVE custom domain over a successful INSTALL endpoint', async () => {
    const deployment = await seedDeployment();
    await seedInstallJob(deployment.id, {
      result: {
        output: { outputs: { ExportDeployzApplicationPublicEndpoint: 'alb.us-east-1.elb.amazonaws.com' } },
      },
    });
    const hostname = `active-${crypto.randomUUID().slice(0, 8)}.customer.com`;
    await db.insert(schema.customDomains).values({
      deploymentId: deployment.id,
      organizationId: org.organizationId,
      hostname,
      status: 'ACTIVE',
      createdBy: org.userId,
    });
    expect(await getAppUrl(deployment.id)).toBe(`https://${hostname}`);
  });

  it('falls back to the INSTALL endpoint when the domain is not yet ACTIVE', async () => {
    const deployment = await seedDeployment();
    await seedInstallJob(deployment.id, {
      result: {
        output: { outputs: { ExportDeployzApplicationPublicEndpoint: 'alb.us-east-1.elb.amazonaws.com' } },
      },
    });
    const hostname = `pending-${crypto.randomUUID().slice(0, 8)}.customer.com`;
    await db.insert(schema.customDomains).values({
      deploymentId: deployment.id,
      organizationId: org.organizationId,
      hostname,
      status: 'WAITING_FOR_DNS',
      createdBy: org.userId,
    });
    expect(await getAppUrl(deployment.id)).toBe('http://alb.us-east-1.elb.amazonaws.com');
  });

  it('a CONFIGURING custom domain does not win: falls back to the ALB endpoint when no default HTTPS serves yet', async () => {
    // Phase 7: only an ACTIVE custom domain is preferred. A CONFIGURING domain
    // (cert issued, HTTPS still being verified) is not yet preferred, so with
    // no default-HTTPS URL the resolution falls to the ALB endpoint.
    const deployment = await seedDeployment();
    await seedInstallJob(deployment.id, {
      result: {
        output: { outputs: { ExportDeployzApplicationPublicEndpoint: 'alb.us-east-1.elb.amazonaws.com' } },
      },
    });
    const hostname = `configuring-${crypto.randomUUID().slice(0, 8)}.customer.com`;
    await db.insert(schema.customDomains).values({
      deploymentId: deployment.id,
      organizationId: org.organizationId,
      hostname,
      status: 'CONFIGURING',
      createdBy: org.userId,
    });
    expect(await getAppUrl(deployment.id)).toBe('http://alb.us-east-1.elb.amazonaws.com');
  });

  it('prefers the default HTTPS URL over a CONFIGURING custom domain', async () => {
    const deployment = await seedDeployment();
    await seedInstallJob(deployment.id, {
      result: {
        output: { outputs: { ExportDeployzApplicationPublicEndpoint: 'alb.us-east-1.elb.amazonaws.com' } },
      },
    });
    await db
      .update(schema.deployments)
      .set({
        defaultHttps: {
          hostname: `d-${deployment.id}.deployz.dev`,
          status: 'ACTIVE',
          checkCycle: 0,
          lastError: null,
        },
      })
      .where(eq(schema.deployments.id, deployment.id));
    await db.insert(schema.customDomains).values({
      deploymentId: deployment.id,
      organizationId: org.organizationId,
      hostname: `configuring-${crypto.randomUUID().slice(0, 8)}.customer.com`,
      status: 'CONFIGURING',
      createdBy: org.userId,
    });
    expect(await getAppUrl(deployment.id)).toBe(`https://d-${deployment.id}.deployz.dev`);
  });

  it('uses the default HTTPS URL once it is ACTIVE even with no custom domain', async () => {
    const deployment = await seedDeployment();
    await seedInstallJob(deployment.id, {
      result: {
        output: { outputs: { ExportDeployzApplicationPublicEndpoint: 'alb.us-east-1.elb.amazonaws.com' } },
      },
    });
    await db
      .update(schema.deployments)
      .set({
        defaultHttps: {
          hostname: `d-${deployment.id}.deployz.dev`,
          status: 'ACTIVE',
          checkCycle: 0,
          lastError: null,
        },
      })
      .where(eq(schema.deployments.id, deployment.id));
    expect(await getAppUrl(deployment.id)).toBe(`https://d-${deployment.id}.deployz.dev`);
  });

  it('prefers an ACTIVE custom domain over an ACTIVE default HTTPS URL', async () => {
    const deployment = await seedDeployment();
    await seedInstallJob(deployment.id, {
      result: {
        output: { outputs: { ExportDeployzApplicationPublicEndpoint: 'alb.us-east-1.elb.amazonaws.com' } },
      },
    });
    await db
      .update(schema.deployments)
      .set({
        defaultHttps: {
          hostname: `d-${deployment.id}.deployz.dev`,
          status: 'ACTIVE',
          checkCycle: 0,
          lastError: null,
        },
      })
      .where(eq(schema.deployments.id, deployment.id));
    const hostname = `active-${crypto.randomUUID().slice(0, 8)}.customer.com`;
    await db.insert(schema.customDomains).values({
      deploymentId: deployment.id,
      organizationId: org.organizationId,
      hostname,
      status: 'ACTIVE',
      createdBy: org.userId,
    });
    expect(await getAppUrl(deployment.id)).toBe(`https://${hostname}`);
  });

  it('exposes defaultUrl from the stored default-HTTPS hostname, whatever its status', async () => {
    const deployment = await seedDeployment();
    const hostname = `d-${deployment.id}.deployz.dev`;
    await db
      .update(schema.deployments)
      .set({ defaultHttps: { hostname, status: 'CONFIGURING', checkCycle: 0, lastError: null } })
      .where(eq(schema.deployments.id, deployment.id));

    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { defaultUrl: string | null }).defaultUrl).toBe(`https://${hostname}`);
  });

  it('leaves defaultUrl null when no default-HTTPS state exists', async () => {
    const deployment = await seedDeployment();

    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { defaultUrl: string | null }).defaultUrl).toBeNull();
  });
});

// ── Custom-domain removal and re-add (Phase 10) ──────────────────────────────
//
// Removal is the only domain-change path (there is no in-place hostname
// change — the MVP is remove → add). Once the DELETE flow completes
// (removedAt set), findActiveDomain no longer sees the domain and the
// preferred URL reverts to the permanent default-HTTPS URL, which Phase 7
// kept reconciling the whole time. A fresh domain can then be added to the
// same deployment; its machine starts a new cycle-0 and is preferred only
// once ACTIVE again.

describe('custom domain removal and re-add (Phase 10)', () => {
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
    app = await buildServer({ auth, db });
    org = await signUpAndGetOrg(auth, db, 'domain-remove-owner@example.com');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  /** A deployment with a successful INSTALL (ALB endpoint) and an ACTIVE
   *  default-HTTPS URL — the permanent fallback the removal reverts to. */
  async function seedWithDefaultActive(): Promise<typeof schema.deployments.$inferSelect> {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      state: 'HEALTHY',
    });
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'INSTALL',
      state: 'SUCCEEDED',
      idempotencyKey: `${deployment.id}:INSTALL:${crypto.randomUUID()}`,
      finishedAt: new Date(),
      result: {
        success: true,
        output: { outputs: { ExportDeployzApplicationPublicEndpoint: 'alb.us-east-1.elb.amazonaws.com' } },
      },
    });
    await db
      .update(schema.deployments)
      .set({
        defaultHttps: {
          hostname: `d-${deployment.id}.deployz.dev`,
          status: 'ACTIVE',
          checkCycle: 0,
          lastError: null,
        },
      })
      .where(eq(schema.deployments.id, deployment.id));
    return deployment;
  }

  async function getAppUrl(deploymentId: string): Promise<unknown> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deploymentId}`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode).toBe(200);
    return response.json().appUrl;
  }

  it('after the removal flow completes (removedAt set) the preferred URL reverts to the default', async () => {
    const deployment = await seedWithDefaultActive();
    const oldHostname = `old-${crypto.randomUUID().slice(0, 8)}.customer.com`;
    await db.insert(schema.customDomains).values({
      deploymentId: deployment.id,
      organizationId: org.organizationId,
      hostname: oldHostname,
      status: 'ACTIVE',
      createdBy: org.userId,
    });
    expect(await getAppUrl(deployment.id)).toBe(`https://${oldHostname}`);

    // The REMOVE_DOMAIN relay result success is what sets removedAt; write the
    // terminal state directly, exactly as applyDomainJobResult does.
    await db
      .update(schema.customDomains)
      .set({ removedAt: new Date() })
      .where(and(eq(schema.customDomains.deploymentId, deployment.id), isNull(schema.customDomains.removedAt)));

    expect(await getAppUrl(deployment.id)).toBe(`https://d-${deployment.id}.deployz.dev`);
  });

  it('a new domain can be added after removal (remove → add), starting a fresh cycle, and ACTIVE is preferred again', async () => {
    const deployment = await seedWithDefaultActive();
    await db.insert(schema.customDomains).values({
      deploymentId: deployment.id,
      organizationId: org.organizationId,
      hostname: `old-${crypto.randomUUID().slice(0, 8)}.customer.com`,
      status: 'ACTIVE',
      createdBy: org.userId,
    });
    await db
      .update(schema.customDomains)
      .set({ removedAt: new Date() })
      .where(eq(schema.customDomains.deploymentId, deployment.id));

    const newHostname = `new-${crypto.randomUUID().slice(0, 8)}.customer.com`;
    const created = await postJson(
      app,
      `/api/deployments/${deployment.id}/domain`,
      { hostname: newHostname },
      { cookie: org.cookie },
    );
    expect(created.statusCode).toBe(201);
    expect((created.json() as { domain: { status: string } }).domain.status).toBe('pending');

    // The fresh machine starts at cycle-0 — the removed domain's cycle history
    // is not reused, so its job idempotency keys can never collide.
    const [freshRow] = await db
      .select()
      .from(schema.customDomains)
      .where(eq(schema.customDomains.deploymentId, deployment.id));
    expect(freshRow!.checkCycle).toBe(0);

    // The default URL is preferred while the fresh domain is still PENDING.
    expect(await getAppUrl(deployment.id)).toBe(`https://d-${deployment.id}.deployz.dev`);

    // Once the new domain reaches ACTIVE, its machine is preferred again.
    await db
      .update(schema.customDomains)
      .set({ status: 'ACTIVE' })
      .where(eq(schema.customDomains.deploymentId, deployment.id));
    expect(await getAppUrl(deployment.id)).toBe(`https://${newHostname}`);
  });
});
