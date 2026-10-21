import { PGlite } from '@electric-sql/pglite';
import crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';
import { REGION_LABELS, buildInstallPlan } from '@deployz/contracts';

import type { DeploymentManifest, EnvironmentSetting } from '@deployz/contracts';

import { createAuth, type Auth } from './auth.js';
import { SECRET_MASK } from './config.js';
import { env } from './env.js';
import { runApplicationPreflight } from './preflight.js';
import { publicInstallInputs } from './public-install.js';
import { buildServer } from './server.js';

// Phase 3 public install links — the customer-side installation review
// contract: the public resolve projection and the confirm flow (gates,
// idempotency, config capture through the SAME §31 path, and the no-leak
// rules for an unauthenticated surface).

const FIXTURE_SHA = crypto.randomUUID().replace(/-/g, '').slice(0, 40);

const READY_METADATA = {
  analysisCommitSha: FIXTURE_SHA,
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
  hasEnvVars: true,
  hasExternalServices: false,
  hasBuildCommand: false,
  buildCommands: ['npm run build'],
  envVars: [],
  // The §11.2 Phase 7 env model — one customer-required secret, one optional
  // value, one Deployz-generated internal secret and one managed binding, so
  // every classification branch of requiredInputs is exercised.
  envVarModel: [
    {
      key: 'STRIPE_API_KEY',
      required: true,
      secret: true,
      classification: 'customer_required',
      purpose: 'external_credential',
      confidence: 'high',
      source: ['.env.example'],
    },
    {
      key: 'SITE_TITLE',
      required: false,
      secret: false,
      classification: 'optional',
      purpose: 'optional_configuration',
      confidence: 'high',
      source: ['.env.example'],
    },
    {
      key: 'SESSION_SECRET',
      required: true,
      secret: true,
      classification: 'deployz_generated',
      generatable: true,
      purpose: 'internal_secret',
      confidence: 'high',
      source: [],
    },
    {
      key: 'AWS_S3_BUCKET',
      required: false,
      secret: false,
      classification: 'deployz_managed',
      purpose: 'infrastructure_binding',
      confidence: 'high',
      source: [],
    },
  ],
  databaseState: 'none',
  externalServices: [] as string[],
} as Record<string, unknown>;

const SECRET_VALUE = 'sk_test_super_secret_value';
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
): Promise<typeof schema.applications.$inferSelect> {
  const [row] = await db
    .insert(schema.applications)
    .values({
      organizationId,
      name: 'Public Install App',
      repoFullName: `acme/public-install-${crypto.randomUUID().slice(0, 8)}`,
      repoUrl: 'https://github.com/acme/public-install',
      defaultBranch: 'main',
      detectedMetadata: READY_METADATA,
    })
    .returning();
  return row!;
}

async function insertReadyRelease(
  db: Db,
  applicationId: string,
  version = '1.0.0',
): Promise<typeof schema.releases.$inferSelect> {
  const [row] = await db
    .insert(schema.releases)
    .values({
      applicationId,
      version,
      gitSha: crypto.randomUUID().slice(0, 8),
      imageDigest: 'registry.example.com/acme/app@sha256:' + 'a'.repeat(64),
      buildStatus: 'SUCCEEDED',
      releaseStatus: 'READY',
    })
    .returning();
  return row!;
}

// One live link per application (partial unique index), so every fixture
// gets its own application + release + enabled link.
async function insertEnabledLink(
  db: Db,
  organizationId: string,
  withRelease = true,
): Promise<{ link: typeof schema.publicInstallLinks.$inferSelect; application: typeof schema.applications.$inferSelect }> {
  const application = await insertApplication(db, organizationId);
  if (withRelease) {
    await insertReadyRelease(db, application.id);
  }
  const [link] = await db
    .insert(schema.publicInstallLinks)
    .values({ organizationId, applicationId: application.id, enabled: true })
    .returning();
  return { link: link!, application };
}

function fullConfig() {
  // SITE_TITLE is optional (classification 'optional') — the env-var setup
  // spec's legacy resolution no longer asks the customer for it, so it is
  // not part of what confirm accepts.
  return [{ key: 'STRIPE_API_KEY', value: SECRET_VALUE, isSecret: true }];
}

function confirmPayload(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: crypto.randomUUID(),
    region: 'us-east-1',
    customer: { name: 'Buyer Co', email: `buyer-${crypto.randomUUID().slice(0, 8)}@example.com` },
    config: fullConfig(),
    ...overrides,
  };
}

describe('public install links', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };
  let publisherName: string;

  const resolve = (linkId: string) => app.inject({ method: 'GET', url: `/api/public-install/${linkId}` });
  // Approves the plan the way the install page does: fetch the plan for the
  // payload's Region and size, then echo its fingerprint. A link that cannot
  // serve a plan gets a well-formed fingerprint that matches nothing.
  const approvePlan = async (linkId: string, payload: Record<string, unknown>) => {
    if ('planFingerprint' in payload) return payload;
    const sizeProfile = (payload['sizeProfile'] as string | undefined) ?? 'small';
    const plan = await app.inject({
      method: 'GET',
      url: `/api/public-install/${linkId}/plan?region=${String(payload['region'])}&profile=${sizeProfile}`,
    });
    const fingerprint = plan.statusCode === 200 ? (plan.json() as { planFingerprint: string | null }).planFingerprint : null;
    return { ...payload, sizeProfile, planFingerprint: fingerprint ?? '0'.repeat(64) };
  };
  const confirm = async (linkId: string, payload: Record<string, unknown>, query = '') =>
    app.inject({
      method: 'POST',
      url: `/api/public-install/${linkId}/confirm${query}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(await approvePlan(linkId, payload)),
    });
  // ── Vendor management routes ────────────────────────────────────────────
  type LinkView = { id: string; url: string; status: string; createdAt: string; revokedAt: string | null };
  type CreatedLinkView = { id: string; url: string; htmlSnippet: string; enabled: boolean; createdAt: string };
  const linksUrl = (applicationId: string) => `/api/applications/${applicationId}/public-install-links`;
  const createLink = (applicationId: string, cookie = org.cookie) =>
    app.inject({ method: 'POST', url: linksUrl(applicationId), headers: { cookie } });
  const listLinks = (applicationId: string, cookie = org.cookie) =>
    app.inject({ method: 'GET', url: linksUrl(applicationId), headers: { cookie } });
  const linkAction = (
    linkId: string,
    action: 'enable' | 'disable' | 'revoke' | 'regenerate',
    cookie = org.cookie,
  ) => app.inject({ method: 'POST', url: `/api/public-install-links/${linkId}/${action}`, headers: { cookie } });
  const createdLinkId = (applicationId: string) =>
    createLink(applicationId).then((response) => {
      expect(response.statusCode, response.body).toBe(201);
      return (response.json() as CreatedLinkView).id;
    });
  const countOrgCustomers = async (): Promise<number> => {
    const rows = await db
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(eq(schema.customers.organizationId, org.organizationId));
    return rows.length;
  };

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);

    org = await signUpAndGetOrg(auth, db, 'public-install-vendor@example.com');
    const [organizationRow] = await db
      .select({ name: schema.organization.name })
      .from(schema.organization)
      .where(eq(schema.organization.id, org.organizationId));
    publisherName = organizationRow!.name;

    // Confirm always creates a PRODUCTION deployment (the same ACTIVE
    // subscription gate as POST /api/deployments and deploy links) — this
    // file is about the public-install contract, not billing, so the org
    // gets a subscription up front; the 402 path has its own test below.
    await db.insert(schema.billingSubscriptions).values({
      organizationId: org.organizationId,
      providerCustomerId: 'ctm_fixture_public_install',
      providerSubscriptionId: 'sub_fixture_public_install',
      status: 'ACTIVE',
    });

    app = await buildServer({ auth, db });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  // ── GET /api/public-install/:linkId (resolve) ─────────────────────────────

  it('resolves the review projection: app, publisher, release, regions, requiredInputs, plan', async () => {
    const { link, application } = await insertEnabledLink(db, org.organizationId);
    const mutableEnv = env as { deployableAwsRegions: readonly string[] };
    const prevRegions = mutableEnv.deployableAwsRegions;
    try {
      mutableEnv.deployableAwsRegions = ['us-east-1', 'eu-west-1'];
      const response = await resolve(link.id);
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as {
        application: { name: string };
        publisher: { name: string };
        release: { version: string; createdAt: string };
        regions: { value: string; label: string }[];
        requiredInputs: { key: string; required: boolean; secret: boolean; classification?: string }[];
        plan: { action: string };
      };
      expect(body.application).toEqual({ name: 'Public Install App' });
      expect(body.publisher).toEqual({ name: publisherName });
      expect(body.release.version).toBe('1.0.0');
      expect(body.regions).toEqual([
        { value: 'us-east-1', label: REGION_LABELS['us-east-1'] },
        { value: 'eu-west-1', label: REGION_LABELS['eu-west-1'] },
      ]);
      // Only the customer-suppliable inputs: the generated internal secret
      // and the managed binding are minted/injected by the relay and never
      // asked for; an optional key (SITE_TITLE) is not asked either.
      expect(body.requiredInputs).toEqual([
        { key: 'STRIPE_API_KEY', required: true, secret: true, classification: 'customer_required', purpose: 'external_credential' },
      ]);
      // The plan is exactly buildInstallPlan of the application's effective
      // manifest — the same construction the vendor plan endpoint serves.
      const { manifest } = await runApplicationPreflight(db, application, null);
      expect(body.plan).toEqual(buildInstallPlan({ manifest, region: null }));

      // No secrets, no manifest, no template URLs, no internal ids: the
      // opaque link id is the only identifier this surface ever sees.
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('SESSION_SECRET');
      expect(serialized).not.toContain('AWS_S3_BUCKET');
      expect(serialized).not.toContain('manifest');
      expect(serialized).not.toContain('template');
      expect(serialized).not.toContain('amazonaws.com');
      expect(serialized).not.toContain('enrollmentCode');
      expect(serialized).not.toContain('organizationId');
      expect(serialized).not.toContain('applicationId');
      expect(serialized).not.toContain('customerId');
    } finally {
      mutableEnv.deployableAwsRegions = prevRegions;
    }
  });

  it('unknown and malformed link ids 404', async () => {
    expect((await resolve(crypto.randomUUID())).statusCode).toBe(404);
    expect((await resolve('not-a-uuid')).statusCode).toBe(404);
  });

  it('a revoked link resolves 410 PUBLIC_INSTALL_LINK_REVOKED', async () => {
    const { link } = await insertEnabledLink(db, org.organizationId);
    await db
      .update(schema.publicInstallLinks)
      .set({ revokedAt: new Date() })
      .where(eq(schema.publicInstallLinks.id, link.id));
    const response = await resolve(link.id);
    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ error: { code: 'PUBLIC_INSTALL_LINK_REVOKED' } });
  });

  it('a disabled link resolves 410 with its own code', async () => {
    const { link } = await insertEnabledLink(db, org.organizationId);
    await db
      .update(schema.publicInstallLinks)
      .set({ enabled: false })
      .where(eq(schema.publicInstallLinks.id, link.id));
    const response = await resolve(link.id);
    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ error: { code: 'PUBLIC_INSTALL_LINK_DISABLED' } });
  });

  it('a link without a published release resolves 410 RELEASE_NOT_PUBLISHED', async () => {
    const { link } = await insertEnabledLink(db, org.organizationId, false);
    const response = await resolve(link.id);
    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ error: { code: 'RELEASE_NOT_PUBLISHED' } });
  });

  // ── POST /api/public-install/:linkId/confirm ──────────────────────────────

  it('confirm creates one public_link deployment with the frozen effective manifest, a fresh customer and the config', async () => {
    const { link, application } = await insertEnabledLink(db, org.organizationId);
    const payload = confirmPayload();
    const response = await confirm(link.id, payload);
    expect(response.statusCode, response.body).toBe(201);
    const body = response.json() as { installLinkId: string };
    expect(body.installLinkId).toMatch(UUID_SHAPE);

    const [deployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.installLinkId, body.installLinkId));
    expect(deployment!).toBeDefined();
    expect(deployment!.source).toBe('public_link');
    expect(deployment!.state).toBe('NOT_INSTALLED');
    expect(deployment!.region).toBe('us-east-1');
    expect(deployment!.publicInstallLinkId).toBe(link.id);
    expect(deployment!.confirmKey).toBe(payload.idempotencyKey);
    // The frozen desired state is exactly the application's effective
    // manifest at confirm time.
    const { manifest } = await runApplicationPreflight(db, application, null);
    expect(deployment!.desiredState).toEqual({ manifest, infrastructureProfile: { id: 'small', version: 2 } });

    // One customer row with the submitted contact details.
    const [customer] = await db.select().from(schema.customers).where(eq(schema.customers.id, deployment!.customerId));
    expect(customer!.name).toBe(payload.customer.name);
    expect(customer!.email).toBe(payload.customer.email);

    // Non-secret config lands as plaintext customer-scoped rows; the secret
    // persists only as the §31 mask — never the plaintext.
    const configRows = await db
      .select()
      .from(schema.applicationConfigs)
      .where(
        and(eq(schema.applicationConfigs.applicationId, application.id), eq(schema.applicationConfigs.customerId, customer!.id)),
      );
    const byKey = new Map(configRows.map((row) => [row.key, row]));
    expect(byKey.get('STRIPE_API_KEY')).toMatchObject({ value: SECRET_MASK, isSecret: true });

    // The funnel event attributes the public_link origin.
    const created = await db
      .select()
      .from(schema.eventLogs)
      .where(and(eq(schema.eventLogs.eventType, 'deployment.created'), eq(schema.eventLogs.deploymentId, deployment!.id)));
    expect(created).toHaveLength(1);
    expect(created[0]!.payload).toMatchObject({ schemaVersion: 1, source: 'public_link' });

    // The existing install flow already serves the new deployment.
    const install = await app.inject({ method: 'GET', url: `/api/install/${body.installLinkId}` });
    expect(install.statusCode).toBe(200);
  });

  it('a replayed confirm re-binds a lost pending secret but never resets one already bound', async () => {
    const { link } = await insertEnabledLink(db, org.organizationId);
    const payload = confirmPayload();
    const first = await confirm(link.id, payload);
    expect(first.statusCode, first.body).toBe(201);
    const [deployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.installLinkId, (first.json() as { installLinkId: string }).installLinkId));
    const bound = () =>
      db.select().from(schema.pendingSecrets).where(eq(schema.pendingSecrets.deploymentId, deployment!.id));
    expect(await bound()).toHaveLength(1);

    // Delivery state of an already-bound row survives a replay.
    await db
      .update(schema.pendingSecrets)
      .set({ deliveryAttempts: 3 })
      .where(eq(schema.pendingSecrets.deploymentId, deployment!.id));
    expect((await confirm(link.id, payload)).statusCode).toBe(200);
    expect((await bound())[0]!.deliveryAttempts).toBe(3);

    // A binding the first attempt never wrote (materialization failed) is re-created.
    await db.delete(schema.pendingSecrets).where(eq(schema.pendingSecrets.deploymentId, deployment!.id));
    expect((await confirm(link.id, payload)).statusCode).toBe(200);
    expect(await bound()).toHaveLength(1);
  });

  it('a repeated confirm with the same key returns the existing deployment and creates nothing new', async () => {
    const { link } = await insertEnabledLink(db, org.organizationId);
    const customersBefore = await countOrgCustomers();
    const payload = confirmPayload();
    const first = await confirm(link.id, payload);
    expect(first.statusCode, first.body).toBe(201);
    const second = await confirm(link.id, payload);
    expect(second.statusCode, second.body).toBe(200);
    expect((second.json() as { installLinkId: string }).installLinkId).toBe(
      (first.json() as { installLinkId: string }).installLinkId,
    );

    const deployments = await db
      .select({ id: schema.deployments.id })
      .from(schema.deployments)
      .where(eq(schema.deployments.publicInstallLinkId, link.id));
    expect(deployments).toHaveLength(1);
    // Exactly one customer row was created for the (link, key) pair.
    expect(await countOrgCustomers()).toBe(customersBefore + 1);
  });

  it('a replayed key with a different size or Region is refused, never sent to the old deployment', async () => {
    const { link } = await insertEnabledLink(db, org.organizationId);
    const payload = confirmPayload();
    expect((await confirm(link.id, payload)).statusCode).toBe(201);
    const otherSize = await confirm(link.id, { ...payload, sizeProfile: 'large' });
    expect(otherSize.statusCode, otherSize.body).toBe(409);
    expect(otherSize.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } });
    const mutableEnv = env as { deployableAwsRegions: readonly string[] };
    const prevRegions = mutableEnv.deployableAwsRegions;
    try {
      mutableEnv.deployableAwsRegions = ['us-east-1', 'eu-west-1'];
      const otherRegion = await confirm(link.id, { ...payload, region: 'eu-west-1' });
      expect(otherRegion.statusCode, otherRegion.body).toBe(409);
      expect(otherRegion.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } });
    } finally {
      mutableEnv.deployableAwsRegions = prevRegions;
    }
    const deployments = await db
      .select({ id: schema.deployments.id })
      .from(schema.deployments)
      .where(eq(schema.deployments.publicInstallLinkId, link.id));
    expect(deployments).toHaveLength(1);
  });

  it('a different key creates a different deployment', async () => {
    const { link } = await insertEnabledLink(db, org.organizationId);
    const first = await confirm(link.id, confirmPayload());
    const second = await confirm(link.id, confirmPayload());
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect((second.json() as { installLinkId: string }).installLinkId).not.toBe(
      (first.json() as { installLinkId: string }).installLinkId,
    );
    const deployments = await db
      .select({ id: schema.deployments.id })
      .from(schema.deployments)
      .where(eq(schema.deployments.publicInstallLinkId, link.id));
    expect(deployments).toHaveLength(2);
  });

  it('two concurrent confirms with the same key create exactly one deployment', async () => {
    const { link } = await insertEnabledLink(db, org.organizationId);
    const customersBefore = await countOrgCustomers();
    const payload = confirmPayload();
    const [first, second] = await Promise.all([confirm(link.id, payload), confirm(link.id, payload)]);
    expect(first.statusCode, first.body).toBeLessThan(300);
    expect(second.statusCode, second.body).toBeLessThan(300);
    expect((first.json() as { installLinkId: string }).installLinkId).toBe(
      (second.json() as { installLinkId: string }).installLinkId,
    );
    const deployments = await db
      .select({ id: schema.deployments.id })
      .from(schema.deployments)
      .where(eq(schema.deployments.publicInstallLinkId, link.id));
    expect(deployments).toHaveLength(1);
    // The loser returns the winner's deployment — no second customer row.
    expect(await countOrgCustomers()).toBe(customersBefore + 1);
  });

  it('an unsupported region is refused with 422 REGION_NOT_SUPPORTED', async () => {
    const { link } = await insertEnabledLink(db, org.organizationId);
    const mutableEnv = env as { deployableAwsRegions: readonly string[] };
    const prevRegions = mutableEnv.deployableAwsRegions;
    try {
      mutableEnv.deployableAwsRegions = ['us-east-1'];
      const response = await confirm(link.id, confirmPayload({ region: 'eu-west-1' }));
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ error: { code: 'REGION_NOT_SUPPORTED' } });
      const deployments = await db
        .select({ id: schema.deployments.id })
        .from(schema.deployments)
        .where(eq(schema.deployments.publicInstallLinkId, link.id));
      expect(deployments).toHaveLength(0);
    } finally {
      mutableEnv.deployableAwsRegions = prevRegions;
    }
  });

  it('a missing required input is refused with 422 and names the key', async () => {
    const { link } = await insertEnabledLink(db, org.organizationId);
    const response = await confirm(link.id, confirmPayload({ config: [{ key: 'SITE_TITLE', value: 'x', isSecret: false }] }));
    expect(response.statusCode).toBe(422);
    const body = response.json() as {
      error: { code: string; message: string; details?: { findings?: { message: string }[] } };
    };
    expect(body.error.code).toBe('MANIFEST_NEEDS_CONFIGURATION');
    // The per-key finding names the missing input.
    expect(
      (body.error.details?.findings ?? []).some((finding) => finding.message.includes('STRIPE_API_KEY')),
    ).toBe(true);
    const deployments = await db
      .select({ id: schema.deployments.id })
      .from(schema.deployments)
      .where(eq(schema.deployments.publicInstallLinkId, link.id));
    expect(deployments).toHaveLength(0);
  });

  it('a blank or whitespace-only value never satisfies a required input', async () => {
    const { link } = await insertEnabledLink(db, org.organizationId);
    for (const value of ['', '   ']) {
      const response = await confirm(link.id, confirmPayload({ config: [{ key: 'STRIPE_API_KEY', value, isSecret: true }] }));
      expect(response.statusCode, value).toBe(422);
    }
    const deployments = await db
      .select({ id: schema.deployments.id })
      .from(schema.deployments)
      .where(eq(schema.deployments.publicInstallLinkId, link.id));
    expect(deployments).toHaveLength(0);
  });

  it('stores a secret input masked even when the client says it is not secret', async () => {
    const { link, application } = await insertEnabledLink(db, org.organizationId);
    const response = await confirm(
      link.id,
      confirmPayload({ config: [{ key: 'STRIPE_API_KEY', value: SECRET_VALUE, isSecret: false }] }),
    );
    expect(response.statusCode, response.body).toBe(201);
    const rows = await db
      .select()
      .from(schema.applicationConfigs)
      .where(and(eq(schema.applicationConfigs.applicationId, application.id), eq(schema.applicationConfigs.key, 'STRIPE_API_KEY')));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ value: SECRET_MASK, isSecret: true });
  });

  it('an unexpected config key is rejected with 422 and the key named', async () => {
    const { link } = await insertEnabledLink(db, org.organizationId);
    const response = await confirm(link.id, confirmPayload({ config: [...fullConfig(), { key: 'EVIL_KEY', value: 'x', isSecret: false }] }));
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: 'PUBLIC_INSTALL_CONFIG_INVALID', details: { unexpected: ['EVIL_KEY'] } },
    });
    const deployments = await db
      .select({ id: schema.deployments.id })
      .from(schema.deployments)
      .where(eq(schema.deployments.publicInstallLinkId, link.id));
    expect(deployments).toHaveLength(0);
  });

  it('disabled, revoked and unpublished links refuse to confirm', async () => {
    const disabled = await insertEnabledLink(db, org.organizationId);
    await db
      .update(schema.publicInstallLinks)
      .set({ enabled: false })
      .where(eq(schema.publicInstallLinks.id, disabled.link.id));
    expect((await confirm(disabled.link.id, confirmPayload())).statusCode).toBe(410);

    const revoked = await insertEnabledLink(db, org.organizationId);
    await db
      .update(schema.publicInstallLinks)
      .set({ revokedAt: new Date() })
      .where(eq(schema.publicInstallLinks.id, revoked.link.id));
    expect((await confirm(revoked.link.id, confirmPayload())).statusCode).toBe(410);

    const unpublished = await insertEnabledLink(db, org.organizationId, false);
    const response = await confirm(unpublished.link.id, confirmPayload());
    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ error: { code: 'RELEASE_NOT_PUBLISHED' } });
  });

  it('query parameters are ignored — the body alone decides', async () => {
    const { link } = await insertEnabledLink(db, org.organizationId);
    const withQuery = await confirm(
      link.id,
      confirmPayload(),
      `?region=eu-west-1&databaseRequired=true&source=manual&organizationId=other-org`,
    );
    expect(withQuery.statusCode, withQuery.body).toBe(201);
    const [deployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.publicInstallLinkId, link.id));
    expect(deployment!.region).toBe('us-east-1');
    expect(deployment!.organizationId).toBe(org.organizationId);
  });

  it('confirm without an ACTIVE subscription is refused 402 and creates no rows', async () => {
    const brokeOrg = await signUpAndGetOrg(auth, db, 'public-install-broke-vendor@example.com');
    const { link } = await insertEnabledLink(db, brokeOrg.organizationId);

    const countBrokeOrgCustomers = async (): Promise<number> => {
      const rows = await db
        .select({ id: schema.customers.id })
        .from(schema.customers)
        .where(eq(schema.customers.organizationId, brokeOrg.organizationId));
      return rows.length;
    };
    const before = await countBrokeOrgCustomers();
    const response = await confirm(link.id, confirmPayload());
    expect(response.statusCode, response.body).toBe(402);
    const body = response.json() as { error: { code: string; details?: { subscriptionStatus: unknown } } };
    expect(body.error.code).toBe('SUBSCRIPTION_REQUIRED');
    expect(body.error.details?.subscriptionStatus).toBeNull();

    const deployments = await db
      .select({ id: schema.deployments.id })
      .from(schema.deployments)
      .where(eq(schema.deployments.publicInstallLinkId, link.id));
    expect(deployments).toHaveLength(0);
    expect(await countBrokeOrgCustomers()).toBe(before);

    // Once the subscription is ACTIVE, confirming works normally.
    await db.insert(schema.billingSubscriptions).values({
      organizationId: brokeOrg.organizationId,
      providerCustomerId: 'ctm_fixture_public_install_broke',
      providerSubscriptionId: 'sub_fixture_public_install_broke',
      status: 'ACTIVE',
    });
    const retried = await confirm(link.id, confirmPayload());
    expect(retried.statusCode, retried.body).toBe(201);
  });

  it('no secret value appears in the response or in any recorded event payload', async () => {
    const { link } = await insertEnabledLink(db, org.organizationId);
    const response = await confirm(link.id, confirmPayload());
    expect(response.statusCode).toBe(201);
    expect(response.body).not.toContain(SECRET_VALUE);

    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.organizationId, org.organizationId));
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(JSON.stringify(event.payload)).not.toContain(SECRET_VALUE);
    }

    // And never in the control-plane config rows.
    const rows = await db
      .select()
      .from(schema.applicationConfigs)
      .where(eq(schema.applicationConfigs.key, 'STRIPE_API_KEY'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.value).not.toContain(SECRET_VALUE);
    }
  });

  it('hostile body keys cannot influence the manifest or the profile', async () => {
    const { link, application } = await insertEnabledLink(db, org.organizationId);
    const hostile = await confirm(link.id, {
      ...confirmPayload(),
      databaseRequired: true,
      redisRequired: true,
      storageRequired: true,
      source: 'manual',
      organizationId: 'org-evil',
      deploymentType: 'TEST',
    });
    expect(hostile.statusCode).toBe(400);
    expect(hostile.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    // A subsequent honest confirm still freezes the application's own
    // effective manifest — nothing from the hostile body stuck.
    const honest = await confirm(link.id, confirmPayload());
    expect(honest.statusCode, honest.body).toBe(201);
    const [deployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.publicInstallLinkId, link.id));
    const { manifest } = await runApplicationPreflight(db, application, null);
    expect(deployment!.desiredState).toEqual({ manifest, infrastructureProfile: { id: 'small', version: 2 } });
    expect(manifest.database.postgres).toBe(false);
    expect(manifest.redis.required).toBe(false);
    expect(deployment!.organizationId).toBe(org.organizationId);
  });

  // ── Vendor management: public-install-links routes (org-scoped) ──────────

  it('the vendor management routes require authentication', async () => {
    const application = await insertApplication(db, org.organizationId);
    await insertReadyRelease(db, application.id);
    expect((await app.inject({ method: 'POST', url: linksUrl(application.id) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: linksUrl(application.id) })).statusCode).toBe(401);
    const linkId = crypto.randomUUID();
    for (const action of ['enable', 'disable', 'revoke', 'regenerate'] as const) {
      expect((await app.inject({ method: 'POST', url: `/api/public-install-links/${linkId}/${action}` })).statusCode).toBe(401);
    }
  });

  it('cross-org application and link ids 404', async () => {
    const other = await signUpAndGetOrg(auth, db, 'public-install-other-vendor@example.com');
    const application = await insertApplication(db, org.organizationId);
    await insertReadyRelease(db, application.id);
    // Another org's application never resolves for the other session.
    expect((await createLink(application.id, other.cookie)).statusCode).toBe(404);
    expect((await listLinks(application.id, other.cookie)).statusCode).toBe(404);
    // And another org cannot act on this org's link.
    const linkId = await createdLinkId(application.id);
    for (const action of ['enable', 'disable', 'revoke', 'regenerate'] as const) {
      expect((await linkAction(linkId, action, other.cookie)).statusCode).toBe(404);
    }
  });

  it('create returns the public url and the FIXED snippet, and records the created event', async () => {
    const application = await insertApplication(db, org.organizationId);
    await insertReadyRelease(db, application.id);
    const response = await createLink(application.id);
    expect(response.statusCode, response.body).toBe(201);
    const body = response.json() as CreatedLinkView;
    expect(body.id).toMatch(UUID_SHAPE);
    expect(body.enabled).toBe(true);
    expect(body.url).toBe(`${env.webUrl}/install/${body.id}`);
    // FIXED shape: only the fixed anchor text and the opaque url — never the
    // application name or anything else.
    expect(body.htmlSnippet).toBe(`<a href="${body.url}">Deploy to AWS with Deployz</a>`);
    // The link is live on the public surface immediately.
    expect((await resolve(body.id)).statusCode).toBe(200);
    const created = await db
      .select({ id: schema.eventLogs.id })
      .from(schema.eventLogs)
      .where(
        and(eq(schema.eventLogs.eventType, 'public_install_link.created'), eq(schema.eventLogs.organizationId, org.organizationId)),
      );
    expect(created.length).toBeGreaterThan(0);
  });

  it('create auto-creates the initial release from the analyzed snapshot', async () => {
    const application = await insertApplication(db, org.organizationId);
    const response = await createLink(application.id);
    expect(response.statusCode, response.body).toBe(201);

    const releases = await db
      .select({ id: schema.releases.id, gitSha: schema.releases.gitSha, version: schema.releases.version })
      .from(schema.releases)
      .where(eq(schema.releases.applicationId, application.id));
    expect(releases).toHaveLength(1);
    expect(releases[0]!.gitSha).toBe(FIXTURE_SHA);
    expect(releases[0]!.version).toBe(FIXTURE_SHA.slice(0, 12));
  });

  it('create reuses an existing release without duplicating it', async () => {
    const application = await insertApplication(db, org.organizationId);
    await insertReadyRelease(db, application.id);
    const before = await db
      .select({ id: schema.releases.id })
      .from(schema.releases)
      .where(eq(schema.releases.applicationId, application.id));
    expect(before).toHaveLength(1);

    const response = await createLink(application.id);
    expect(response.statusCode, response.body).toBe(201);

    const after = await db
      .select({ id: schema.releases.id })
      .from(schema.releases)
      .where(eq(schema.releases.applicationId, application.id));
    expect(after).toHaveLength(1);
  });

  it('create without an analyzed commit SHA is refused 422 RELEASE_NOT_PUBLISHED', async () => {
    const application = await insertApplication(db, org.organizationId);
    // Override detectedMetadata to remove the analysisCommitSha so the
    // auto-create path cannot derive a commit to build from.
    await db
      .update(schema.applications)
      .set({ detectedMetadata: { ...READY_METADATA, analysisCommitSha: undefined } })
      .where(eq(schema.applications.id, application.id));
    const response = await createLink(application.id);
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'RELEASE_NOT_PUBLISHED' } });
  });

  it('a second live link for the same application is refused 409 with the existing id', async () => {
    const application = await insertApplication(db, org.organizationId);
    await insertReadyRelease(db, application.id);
    const first = await createLink(application.id);
    expect(first.statusCode, first.body).toBe(201);
    const second = await createLink(application.id);
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json()).toMatchObject({
      error: { code: 'PUBLIC_INSTALL_LINK_EXISTS', details: { id: (first.json() as CreatedLinkView).id } },
    });
  });

  it("a customer invitation is never listed or reported as the application's link", async () => {
    const application = await insertApplication(db, org.organizationId);
    await insertReadyRelease(db, application.id);
    const linkId = await createdLinkId(application.id);
    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId: org.organizationId, name: 'Invited Customer', email: 'invited@example.com' })
      .returning();
    await db.insert(schema.publicInstallLinks).values({
      organizationId: org.organizationId,
      applicationId: application.id,
      customerId: customer!.id,
      tokenHash: 'invitation-token-hash',
      enabled: true,
    });

    const listed = await listLinks(application.id);
    expect((listed.json() as { links: { id: string }[] }).links.map((link) => link.id)).toEqual([linkId]);
    const second = await createLink(application.id);
    expect(second.json()).toMatchObject({ error: { code: 'PUBLIC_INSTALL_LINK_EXISTS', details: { id: linkId } } });
  });

  it('disable and enable round-trip through the public resolve endpoint', async () => {
    const application = await insertApplication(db, org.organizationId);
    await insertReadyRelease(db, application.id);
    const linkId = await createdLinkId(application.id);
    expect((await resolve(linkId)).statusCode).toBe(200);

    const disabled = await linkAction(linkId, 'disable');
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect((disabled.json() as { link: LinkView }).link.status).toBe('disabled');
    const gone = await resolve(linkId);
    expect(gone.statusCode).toBe(410);
    expect(gone.json()).toMatchObject({ error: { code: 'PUBLIC_INSTALL_LINK_DISABLED' } });

    const enabled = await linkAction(linkId, 'enable');
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect((enabled.json() as { link: LinkView }).link.status).toBe('active');
    expect((await resolve(linkId)).statusCode).toBe(200);
  });

  it('revoke is idempotent and a revoked link cannot be enabled', async () => {
    const application = await insertApplication(db, org.organizationId);
    await insertReadyRelease(db, application.id);
    const linkId = await createdLinkId(application.id);

    const first = await linkAction(linkId, 'revoke');
    expect(first.statusCode, first.body).toBe(200);
    const firstView = (first.json() as { link: LinkView }).link;
    expect(firstView.status).toBe('revoked');
    expect(firstView.revokedAt).not.toBeNull();
    // Already revoked → 200 with the same state.
    const again = await linkAction(linkId, 'revoke');
    expect(again.statusCode, again.body).toBe(200);
    expect((again.json() as { link: LinkView }).link.revokedAt).toBe(firstView.revokedAt);
    // Revoked is terminal: enabling is refused and the public surface is 410.
    const enable = await linkAction(linkId, 'enable');
    expect(enable.statusCode, enable.body).toBe(409);
    expect(enable.json()).toMatchObject({ error: { code: 'PUBLIC_INSTALL_LINK_REVOKED' } });
    const gone = await resolve(linkId);
    expect(gone.statusCode).toBe(410);
    expect(gone.json()).toMatchObject({ error: { code: 'PUBLIC_INSTALL_LINK_REVOKED' } });
  });

  it('regenerate revokes the old link and issues a fresh resolving one', async () => {
    const application = await insertApplication(db, org.organizationId);
    await insertReadyRelease(db, application.id);
    const oldId = await createdLinkId(application.id);

    const regenerated = await linkAction(oldId, 'regenerate');
    expect(regenerated.statusCode, regenerated.body).toBe(200);
    const body = regenerated.json() as CreatedLinkView;
    expect(body.id).not.toBe(oldId);
    expect(body.url).toBe(`${env.webUrl}/install/${body.id}`);
    expect(body.htmlSnippet).toBe(`<a href="${body.url}">Deploy to AWS with Deployz</a>`);
    expect(body.enabled).toBe(true);

    // The old id is revoked on the public surface and refuses to confirm…
    const oldResolve = await resolve(oldId);
    expect(oldResolve.statusCode).toBe(410);
    expect(oldResolve.json()).toMatchObject({ error: { code: 'PUBLIC_INSTALL_LINK_REVOKED' } });
    expect((await confirm(oldId, confirmPayload())).statusCode).toBe(410);
    // …and the fresh one serves the review.
    expect((await resolve(body.id)).statusCode).toBe(200);
  });

  it('list returns newest-first links with the derived statuses', async () => {
    const application = await insertApplication(db, org.organizationId);
    await insertReadyRelease(db, application.id);
    const firstId = await createdLinkId(application.id);

    await linkAction(firstId, 'disable');
    const disabledList = await listLinks(application.id);
    expect(disabledList.statusCode, disabledList.body).toBe(200);
    const disabledBody = (disabledList.json() as { links: LinkView[] }).links;
    expect(disabledBody).toHaveLength(1);
    expect(disabledBody[0]).toMatchObject({ id: firstId, status: 'disabled', revokedAt: null });
    expect(disabledBody[0]!.url).toBe(`${env.webUrl}/install/${firstId}`);

    await linkAction(firstId, 'enable');
    await linkAction(firstId, 'revoke');
    const freshId = ((await linkAction(firstId, 'regenerate')).json() as CreatedLinkView).id;
    const response = await listLinks(application.id);
    expect(response.statusCode, response.body).toBe(200);
    const links = (response.json() as { links: LinkView[] }).links;
    expect(links.map((link) => [link.id, link.status])).toEqual([
      [freshId, 'active'],
      [firstId, 'revoked'],
    ]);
    expect(links[1]!.revokedAt).not.toBeNull();
  });

  // ── Deployment sizes ─────────────────────────────────────────────────────

  type SizedPlan = {
    sizeProfile: string;
    planFingerprint: string | null;
    costEstimate: { monthlyMax: number | null } | null;
    footprint: { workloads: { compute: { cpuUnits: number } }[] };
  };
  type Sizing = { recommended: string; minimum: string; options: { id: string; recommended: boolean; workload: { cpuUnits: number } }[] };
  const planOf = (linkId: string, region: string, profile?: string) =>
    app.inject({
      method: 'GET',
      url: `/api/public-install/${linkId}/plan?region=${region}${profile ? `&profile=${profile}` : ''}`,
    });
  const sizedPlan = async (linkId: string, region: string, profile?: string) => {
    const response = await planOf(linkId, region, profile);
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as SizedPlan;
  };
  const sizingOf = async (linkId: string) => ((await resolve(linkId)).json() as { sizing: Sizing }).sizing;
  const patchApplication = (applicationId: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: `/api/applications/${applicationId}`,
      headers: { cookie: org.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });
  const createSizedLink = (applicationId: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: linksUrl(applicationId),
      headers: { cookie: org.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });
  const linkDeployments = (linkId: string) =>
    db.select().from(schema.deployments).where(eq(schema.deployments.publicInstallLinkId, linkId));

  it('resolve returns the permitted sizes; a legacy link (null sizing) follows the current application settings', async () => {
    const { link, application } = await insertEnabledLink(db, org.organizationId);
    expect(link.recommendedSizeProfile).toBeNull();
    expect(link.minimumSizeProfile).toBeNull();

    const initial = await sizingOf(link.id);
    expect(initial).toMatchObject({ recommended: 'small', minimum: 'small' });
    expect(initial.options.map((option) => [option.id, option.recommended, option.workload.cpuUnits])).toEqual([
      ['small', true, 256],
      ['medium', false, 1024],
      ['large', false, 2048],
    ]);

    expect((await patchApplication(application.id, { minimumSizeProfile: 'medium', defaultSizeProfile: 'large' })).statusCode).toBe(200);
    const followed = await sizingOf(link.id);
    expect(followed).toMatchObject({ recommended: 'large', minimum: 'medium' });
    expect(followed.options.map((option) => option.id)).toEqual(['medium', 'large']);
  });

  it('plan: each size has its own footprint, cost and fingerprint, and each Region changes the fingerprint', async () => {
    const { link } = await insertEnabledLink(db, org.organizationId);
    const small = await sizedPlan(link.id, 'us-east-1');
    const medium = await sizedPlan(link.id, 'us-east-1', 'medium');
    const large = await sizedPlan(link.id, 'us-east-1', 'large');
    expect([small, medium, large].map((plan) => plan.sizeProfile)).toEqual(['small', 'medium', 'large']);
    expect([small, medium, large].map((plan) => plan.footprint.workloads[0]!.compute.cpuUnits)).toEqual([256, 1024, 2048]);
    expect(small.costEstimate!.monthlyMax!).toBeLessThan(medium.costEstimate!.monthlyMax!);
    expect(medium.costEstimate!.monthlyMax!).toBeLessThan(large.costEstimate!.monthlyMax!);
    expect(new Set([small, medium, large].map((plan) => plan.planFingerprint)).size).toBe(3);
    expect(await sizedPlan(link.id, 'us-east-1', 'small')).toEqual(small);

    const mutableEnv = env as { deployableAwsRegions: readonly string[] };
    const previous = mutableEnv.deployableAwsRegions;
    try {
      mutableEnv.deployableAwsRegions = ['us-east-1', 'eu-west-1'];
      const europe = await sizedPlan(link.id, 'eu-west-1', 'medium');
      expect(europe.planFingerprint).not.toBe(medium.planFingerprint);
    } finally {
      mutableEnv.deployableAwsRegions = previous;
    }

    const unknown = await planOf(link.id, 'us-east-1', 'huge');
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json()).toMatchObject({ error: { code: 'UNKNOWN_PROFILE' } });
  });

  it('a size below the minimum is refused at plan and at confirm with 422, and creates nothing', async () => {
    const { link, application } = await insertEnabledLink(db, org.organizationId);
    expect((await patchApplication(application.id, { defaultSizeProfile: 'medium', minimumSizeProfile: 'medium' })).statusCode).toBe(200);
    const customers = await countOrgCustomers();

    const plan = await planOf(link.id, 'us-east-1', 'small');
    expect(plan.statusCode).toBe(422);
    expect(plan.json()).toMatchObject({ error: { code: 'SIZE_PROFILE_NOT_ALLOWED' } });

    const response = await confirm(link.id, confirmPayload({ sizeProfile: 'small' }));
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'SIZE_PROFILE_NOT_ALLOWED' } });
    expect(await linkDeployments(link.id)).toEqual([]);
    expect(await countOrgCustomers()).toBe(customers);
  });

  it('confirm with medium freezes medium-v1 and compiles the medium workload size', async () => {
    const { link } = await insertEnabledLink(db, org.organizationId);
    const response = await confirm(link.id, confirmPayload({ sizeProfile: 'medium' }));
    expect(response.statusCode, response.body).toBe(201);
    const [deployment] = await linkDeployments(link.id);
    expect(deployment!.desiredState).toMatchObject({ infrastructureProfile: { id: 'medium', version: 1 } });
    const footprint = (deployment!.specV2 as { footprint: { workloads: { compute: { cpuUnits: number; memoryMiB: number; sizeLabel: string } }[] } }).footprint;
    expect(footprint.workloads[0]!.compute).toMatchObject({ cpuUnits: 1024, memoryMiB: 2048, sizeLabel: 'Medium' });
  });

  it('confirm refuses a plan approved for another size, or a wrong fingerprint, with 409 PLAN_CHANGED and rolls everything back', async () => {
    const { link } = await insertEnabledLink(db, org.organizationId);
    const small = await sizedPlan(link.id, 'us-east-1', 'small');
    const customers = await countOrgCustomers();

    const otherSize = await confirm(link.id, confirmPayload({ sizeProfile: 'medium', planFingerprint: small.planFingerprint }));
    expect(otherSize.statusCode, otherSize.body).toBe(409);
    expect(otherSize.json()).toMatchObject({ error: { code: 'PLAN_CHANGED' } });

    const wrong = await confirm(link.id, confirmPayload({ sizeProfile: 'small', planFingerprint: 'f'.repeat(64) }));
    expect(wrong.statusCode, wrong.body).toBe(409);
    expect(wrong.json()).toMatchObject({ error: { code: 'PLAN_CHANGED' } });

    expect(await linkDeployments(link.id)).toEqual([]);
    expect(await countOrgCustomers()).toBe(customers);
  });

  it('confirm without a sizeProfile is a 400 VALIDATION_ERROR', async () => {
    const { link } = await insertEnabledLink(db, org.organizationId);
    const response = await confirm(link.id, confirmPayload({ planFingerprint: 'a'.repeat(64) }));
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('a link freezes its sizing: later application edits change only links created afterwards, and regenerate takes the current minimum', async () => {
    const first = await insertApplication(db, org.organizationId);
    await insertReadyRelease(db, first.id);
    const created = await createSizedLink(first.id, { recommendedSizeProfile: 'large' });
    expect(created.statusCode, created.body).toBe(201);
    const frozenId = (created.json() as CreatedLinkView).id;
    const [row] = await db.select().from(schema.publicInstallLinks).where(eq(schema.publicInstallLinks.id, frozenId));
    expect(row).toMatchObject({ recommendedSizeProfile: 'large', minimumSizeProfile: 'small' });

    expect((await patchApplication(first.id, { defaultSizeProfile: 'medium', minimumSizeProfile: 'medium' })).statusCode).toBe(200);
    const frozen = await sizingOf(frozenId);
    expect(frozen).toMatchObject({ recommended: 'large', minimum: 'small' });
    expect(frozen.options.map((option) => option.id)).toEqual(['small', 'medium', 'large']);
    expect((await planOf(frozenId, 'us-east-1', 'small')).statusCode).toBe(200);

    // Regenerate keeps the link's recommendation and takes the application's current minimum.
    const regenerated = (await linkAction(frozenId, 'regenerate')).json() as CreatedLinkView;
    expect(await sizingOf(regenerated.id)).toMatchObject({ recommended: 'large', minimum: 'medium' });

    // A link created after the edit freezes the new settings.
    const second = await insertApplication(db, org.organizationId);
    await insertReadyRelease(db, second.id);
    expect((await patchApplication(second.id, { defaultSizeProfile: 'medium', minimumSizeProfile: 'medium' })).statusCode).toBe(200);
    const later = await createSizedLink(second.id, {});
    expect(later.statusCode, later.body).toBe(201);
    const laterSizing = await sizingOf((later.json() as CreatedLinkView).id);
    expect(laterSizing).toMatchObject({ recommended: 'medium', minimum: 'medium' });

    // A recommendation below the application minimum cannot be frozen.
    await linkAction((later.json() as CreatedLinkView).id, 'revoke');
    const tooSmall = await createSizedLink(second.id, { recommendedSizeProfile: 'small' });
    expect(tooSmall.statusCode, tooSmall.body).toBe(422);
    expect(tooSmall.json()).toMatchObject({ error: { code: 'SIZE_DEFAULT_BELOW_MINIMUM' } });
  });

  it('regenerate raises a recommendation that is below the current minimum', async () => {
    const application = await insertApplication(db, org.organizationId);
    await insertReadyRelease(db, application.id);
    const created = await createSizedLink(application.id, { recommendedSizeProfile: 'small' });
    expect(created.statusCode, created.body).toBe(201);
    expect((await patchApplication(application.id, { defaultSizeProfile: 'large', minimumSizeProfile: 'large' })).statusCode).toBe(200);
    const regenerated = (await linkAction((created.json() as CreatedLinkView).id, 'regenerate')).json() as CreatedLinkView;
    const sizing = await sizingOf(regenerated.id);
    expect(sizing).toMatchObject({ recommended: 'large', minimum: 'large' });
    expect(sizing.options.map((option) => option.id)).toEqual(['large']);
  });

  it('a customer size below the link minimum is refused 422 even when the application minimum is lower', async () => {
    const application = await insertApplication(db, org.organizationId);
    await insertReadyRelease(db, application.id);
    expect((await patchApplication(application.id, { defaultSizeProfile: 'medium', minimumSizeProfile: 'medium' })).statusCode).toBe(200);
    const linkId = await createdLinkId(application.id);
    expect((await patchApplication(application.id, { minimumSizeProfile: 'small' })).statusCode).toBe(200);

    const response = await confirm(linkId, confirmPayload({ sizeProfile: 'small' }));
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'SIZE_PROFILE_NOT_ALLOWED' } });
    expect(await linkDeployments(linkId)).toEqual([]);
  });
});

// publicInstallInputs — pure, no DB. Env-var setup: only customer-scope
// runtime keys (a saved 'customer' setting, or legacy "unreviewed required")
// are asked; optional/vendor/deployz/build keys are not.
describe('publicInstallInputs', () => {
  function inputsManifest(): DeploymentManifest {
    return {
      application: { root: '.', runtime: 'node', framework: 'express', dockerfilePath: 'Dockerfile' },
      build: { command: 'tsc', context: '.' },
      web: { command: 'node dist/index.js', port: 3000 },
      health: { path: '/health' },
      database: { postgres: false },
      redis: { required: false, envBindings: [] },
      storage: { required: false, envBindings: [] },
      migration: { command: null },
      worker: { command: null },
      environment: {
        variables: [
          { key: 'DATABASE_URL', required: true, secret: false, source: [], classification: 'deployz_managed' },
          { key: 'STRIPE_SECRET_KEY', required: true, secret: true, source: [], classification: 'customer_required' },
          { key: 'LOG_LEVEL', required: false, secret: false, source: [], classification: 'optional' },
        ],
      },
      externalServices: [],
      unsupported: [],
    };
  }

  it('legacy (no settings): asks only for the unreviewed required key, optional keys are not asked', () => {
    const inputs = publicInstallInputs(inputsManifest(), null);
    expect(inputs.map((input) => input.key)).toEqual(['STRIPE_SECRET_KEY']);
    expect(inputs[0]).toMatchObject({ required: true, secret: true });
  });

  it('a saved provider:none setting is not asked, even though the key is required in the manifest', () => {
    const settings: EnvironmentSetting[] = [
      { key: 'STRIPE_SECRET_KEY', stage: 'runtime', required: false, secret: true, provider: 'none' },
    ];
    const inputs = publicInstallInputs(inputsManifest(), settings);
    expect(inputs).toEqual([]);
  });

  it('a saved provider:customer setting passes its label and help through', () => {
    const settings: EnvironmentSetting[] = [
      {
        key: 'STRIPE_SECRET_KEY',
        stage: 'runtime',
        required: true,
        secret: true,
        provider: 'customer',
        label: 'Stripe secret key',
        help: 'Found in the Stripe dashboard under API keys.',
      },
    ];
    const inputs = publicInstallInputs(inputsManifest(), settings);
    expect(inputs).toEqual([
      expect.objectContaining({
        key: 'STRIPE_SECRET_KEY',
        required: true,
        secret: true,
        label: 'Stripe secret key',
        help: 'Found in the Stripe dashboard under API keys.',
      }),
    ]);
  });

  it('a saved provider:vendor setting is not asked (the vendor supplies it)', () => {
    const settings: EnvironmentSetting[] = [
      { key: 'STRIPE_SECRET_KEY', stage: 'runtime', required: true, secret: true, provider: 'vendor' },
    ];
    expect(publicInstallInputs(inputsManifest(), settings)).toEqual([]);
  });

  it('asks for a required internal secret Deployz cannot mint, with or without a decision', () => {
    const manifest = inputsManifest();
    manifest.environment.variables.push({
      key: 'LICENSE_KEY',
      required: true,
      secret: true,
      source: [],
      purpose: 'internal_secret',
      classification: 'customer_required',
    });
    // A licence key is shared with another party: minting a random one never works.
    expect(publicInstallInputs(manifest, null).map((input) => input.key)).toEqual(['LICENSE_KEY', 'STRIPE_SECRET_KEY']);
    const settings: EnvironmentSetting[] = [
      { key: 'LICENSE_KEY', stage: 'runtime', required: true, secret: true, provider: 'customer', label: 'License key' },
    ];
    expect(publicInstallInputs(manifest, settings).map((input) => input.key)).toEqual(['STRIPE_SECRET_KEY', 'LICENSE_KEY']);
  });
});
