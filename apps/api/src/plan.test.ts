import { PGlite } from '@electric-sql/pglite';
import { customerSessionHeaders } from './customer-access-fixture.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { analyseRepo, normalizeDeploymentManifest } from '@deployz/analysis';
import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';
import {
  buildDestroyPlan,
  buildInstallPlan,
  derivePlanComponentsFromSpec,
  estimateFootprintCost,
  MEDIUM_PROFILE,
  requiredAwsResources,
  resolveDeploymentFootprint,
  SMALL_V2_PROFILE,
  toPlanAwsResource,
  type DeploymentManifest,
  type DeploymentPlan,
} from '@deployz/contracts';

import { createAuth, type Auth } from './auth.js';
import { compileDeploymentIntent } from './compiler-artifact.js';
import { getFileTreeForAnalysis } from './github.js';
import { buildServer } from './server.js';

// Phase 4 — GET /api/applications/:id/plan and GET /api/deployments/:id/plan,
// and the public install response's `plan` field. Mirrors
// install-parameters.test.ts's compact harness (own PGlite instance, no
// shared helpers module).

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
      name: 'Plan Test App',
      repoFullName: `acme/plan-test-${crypto.randomUUID().slice(0, 8)}`,
      repoUrl: 'https://github.com/acme/plan-test',
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
      name: 'Plan Test Customer',
      email: `plan-test-${crypto.randomUUID()}@example.com`,
      ...overrides,
    })
    .returning();
  return row!;
}

/** A stored manifest with a PostgreSQL database and no Redis, no Storage need. */
const POSTGRES_MANIFEST: DeploymentManifest = {
  schemaVersion: 1,
  application: { root: '.', runtime: 'node', framework: 'express', dockerfilePath: 'Dockerfile' },
  build: { command: 'npm run build', context: '.' },
  web: { command: 'npm start', port: 3000 },
  health: { path: '/health' },
  database: { postgres: true },
  redis: { required: false, envBindings: [] },
  storage: { required: false, envBindings: [] },
  migration: { command: null },
  worker: { command: null },
  environment: { variables: [] },
  externalServices: [],
  unsupported: [],
};

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
      desiredState: { manifest: POSTGRES_MANIFEST },
      ...overrides,
    })
    .returning();
  return row!;
}

describe('deployment plans (Phase 4)', () => {
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
    org = await signUpAndGetOrg(auth, db, 'plan-test@example.com');
    app = await buildServer({ auth, db });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('GET /api/applications/:id/plan 409s while analysis has not completed', async () => {
    const application = await insertApplication(db, org.organizationId);
    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/plan`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'ANALYSIS_NOT_COMPLETE' } });
  });

  it('GET /api/applications/:id/plan: a redis-required app carries a Cache CREATE entry', async () => {
    const application = await insertApplication(db, org.organizationId, {
      analysisStatus: 'COMPLETE',
      redisRequired: true,
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/plan`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const plan = response.json() as { action: string; region: string | null; components: unknown[] };
    expect(plan.action).toBe('INSTALL');
    expect(plan.region).toBeNull();
    expect(plan.components).toContainEqual({ kind: 'cache', name: 'Cache', action: 'CREATE', lifecycle: 'delete' });
  });

  it('GET /api/applications/:id/plan lists the worker, queues, dead-letter queue and schedule the compiler provisions', async () => {
    const analysis = analyseRepo(await getFileTreeForAnalysis('deployz-demo/async-app', { fixtureMode: true }));
    const application = await insertApplication(db, org.organizationId, {
      analysisStatus: 'COMPLETE',
      detectedMetadata: analysis.metadata,
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/applications/${application.id}/plan?region=us-east-1`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const plan = response.json() as DeploymentPlan;

    // The same ids and names as the components of the frozen spec the compiler produces.
    const manifest = normalizeDeploymentManifest(analysis, {});
    const spec = compileDeploymentIntent({ manifest, region: 'us-east-1' }).spec;
    const provisioned = derivePlanComponentsFromSpec(spec).filter(
      (entry) => entry.componentId !== 'web' && ['application', 'worker', 'queue', 'schedule'].includes(entry.kind),
    );
    expect(provisioned.map((entry) => entry.componentId)).toEqual(
      expect.arrayContaining(['worker', 'cleanup', 'orders-queue', 'orders-queue-dlq', 'cleanup-schedule']),
    );
    const listed = plan.components.filter((component) => component.componentId !== undefined);
    expect(listed.map((component) => [component.componentId, component.name]).sort()).toEqual(
      provisioned.map((entry) => [entry.componentId, entry.name]).sort(),
    );
    expect(plan.awsResources.map((resource) => resource.id)).toEqual(
      expect.arrayContaining(provisioned.map((entry) => entry.componentId!)),
    );
    expect(plan.costEstimate?.items.filter((item) => item.pricingStatus === 'usage_based').map((item) => item.resourceId)).toEqual(
      expect.arrayContaining(['orders-queue', 'orders-queue-dlq', 'cleanup-schedule']),
    );
  });

  it('GET /api/deployments/:id/plan?action=destroy: RETAINs Database and Storage, DELETEs Application and Secure endpoint', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);

    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}/plan?action=destroy`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const footprint = resolveDeploymentFootprint({ manifest: POSTGRES_MANIFEST, region: 'us-east-1' });
    expect(response.json()).toStrictEqual({
      schemaVersion: 1,
      action: 'DESTROY',
      region: 'us-east-1',
      components: [
        { kind: 'application', name: 'Application', action: 'DELETE', lifecycle: 'delete' },
        { kind: 'endpoint', name: 'Secure endpoint', action: 'DELETE', lifecycle: 'delete' },
        { kind: 'database', name: 'Database', action: 'RETAIN', lifecycle: 'retain' },
        { kind: 'storage', name: 'Storage', action: 'RETAIN', lifecycle: 'retain' },
      ],
      awsResources: requiredAwsResources({ postgres: true, redis: false }).map(toPlanAwsResource),
      footprint,
      costEstimate: estimateFootprintCost(footprint),
      requirementDrift: [],
    });
  });

  it('GET /api/deployments/:id/plan?action=update: reports drift, never a CREATE, when the application gains Redis after the deployment was created', async () => {
    // databaseRequired: true matches POSTGRES_MANIFEST (the deployment's
    // frozen manifest) so only the Redis flip below produces drift.
    const application = await insertApplication(db, org.organizationId, { databaseRequired: true });
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);

    // The application's live requirements diverge from the deployment's
    // frozen manifest — the MVP architecture cannot apply this in place.
    await db.update(schema.applications).set({ redisRequired: true }).where(eq(schema.applications.id, application.id));

    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}/plan?action=update`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const plan = response.json() as {
      components: Array<{ kind: string }>;
      requirementDrift: unknown[];
      infrastructureChange: unknown;
    };
    expect(plan.components.map((component) => component.kind)).not.toContain('cache');
    expect(plan.requirementDrift).toEqual([{ kind: 'cache', deployed: false, desired: true }]);
    // Fail closed: requirement drift means the release needs infrastructure
    // changes the MVP cannot apply, whatever the feasibility analysis says.
    expect(plan.infrastructureChange).toEqual({ status: 'unsupported', reason: 'topology_changed' });
  });

  it('GET /api/deployments/:id/plan with an unknown action 400s', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);

    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}/plan?action=bogus`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode, response.body).toBe(400);
  });

  it('GET /api/deployments/:id/plan?action=install: a frozen spec adds componentId/group and changes nothing else', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const spec = compileDeploymentIntent({ manifest: POSTGRES_MANIFEST, region: 'us-east-1' }).spec;
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      specV2: spec as unknown as Record<string, unknown>,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}/plan?action=install`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const plan = response.json() as Record<string, unknown>;

    // The base plan is exactly what the builder produces for this manifest
    // with the compiled footprint — the spec only upgrades the components.
    const expectedBase = buildInstallPlan({
      manifest: POSTGRES_MANIFEST,
      region: 'us-east-1',
      compiledFootprint: spec.footprint,
    });
    const { components, ...rest } = plan;
    const { components: _baseComponents, ...expectedRest } = expectedBase as unknown as Record<string, unknown>;
    expect(rest).toEqual(expectedRest);
    expect(components).toEqual([
      { kind: 'application', name: 'Application', action: 'CREATE', lifecycle: 'delete', componentId: 'web', group: 'application' },
      { kind: 'endpoint', name: 'Secure endpoint', action: 'CREATE', lifecycle: 'delete', componentId: 'endpoint', group: 'edge' },
      { kind: 'database', name: 'Database', action: 'CREATE', lifecycle: 'retain', componentId: 'primary-db', group: 'data' },
      { kind: 'storage', name: 'Storage', action: 'CREATE', lifecycle: 'retain', componentId: 'storage', group: 'storage' },
    ]);
  });

  it('GET /api/deployments/:id/plan?action=destroy: a frozen spec adds componentId/group and keeps the builder actions/lifecycle/retention', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    // Today's full deployment shape: web + PostgreSQL + Redis + storage.
    const manifest: DeploymentManifest = {
      ...POSTGRES_MANIFEST,
      redis: { required: true, envBindings: [] },
      storage: { required: true, envBindings: [] },
    };
    const spec = compileDeploymentIntent({ manifest, region: 'us-east-1' }).spec;
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      desiredState: { manifest },
      specV2: spec as unknown as Record<string, unknown>,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}/plan?action=destroy`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const plan = response.json() as Record<string, unknown>;

    // The base plan is exactly what the builder produces for this manifest
    // with the compiled footprint — the spec only upgrades the components.
    const expectedBase = buildDestroyPlan({
      manifest,
      region: 'us-east-1',
      compiledFootprint: spec.footprint,
    });
    const { components, ...rest } = plan;
    const { components: _baseComponents, ...expectedRest } = expectedBase as unknown as Record<string, unknown>;
    expect(rest).toEqual(expectedRest);
    // Every builder entry keeps its name/action/lifecycle (DELETE vs RETAIN
    // per resource) and gains its spec-derived identity. Compared by name:
    // the spec presents IR order (cache before storage), the builder catalog
    // order differs — actions/retention are the parity contract, not order.
    const componentByName = new Map(
      (components as Array<Record<string, unknown>>).map((component) => [component.name as string, component]),
    );
    expect(componentByName.size).toBe(expectedBase.components.length);
    for (const component of expectedBase.components) {
      expect(componentByName.get(component.name)).toEqual({
        kind: component.kind,
        name: component.name,
        action: component.action,
        lifecycle: component.lifecycle,
        componentId: expect.any(String),
        group: expect.any(String),
      });
    }
  });

  it('GET /api/deployments/:id/plan?action=update: states no infrastructure change when requirements match', async () => {
    // databaseRequired: true matches POSTGRES_MANIFEST (the deployment's
    // frozen manifest) so nothing drifts.
    const application = await insertApplication(db, org.organizationId, { databaseRequired: true });
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);

    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}/plan?action=update`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const plan = response.json() as { requirementDrift: unknown[]; infrastructureChange: unknown };
    expect(plan.requirementDrift).toEqual([]);
    expect(plan.infrastructureChange).toEqual({ status: 'none' });
  });

  it('GET /api/deployments/:id/plan?action=install and destroy: infrastructureChange stays absent', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);

    for (const action of ['install', 'destroy']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/deployments/${deployment.id}/plan?action=${action}`,
        headers: { cookie: org.cookie },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect('infrastructureChange' in response.json()).toBe(false);
    }
  });

  it('GET /api/deployments/:id/plan 422s when the deployment has no stored manifest', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      desiredState: {},
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}/plan?action=install`,
      headers: { cookie: org.cookie },
    });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'MANIFEST_NEEDS_CONFIGURATION' } });
  });

  it('the public install response\'s plan equals GET /api/deployments/:id/plan?action=install', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id);

    const installResponse = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}`, headers: await customerSessionHeaders(db, deployment.installLinkId) });
    expect(installResponse.statusCode, installResponse.body).toBe(200);
    const installBody = installResponse.json() as { plan: unknown };

    const deploymentPlanResponse = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}/plan?action=install`,
      headers: { cookie: org.cookie },
    });
    expect(deploymentPlanResponse.statusCode, deploymentPlanResponse.body).toBe(200);

    expect(installBody.plan).toEqual(deploymentPlanResponse.json());
  });

  // ── Deployment sizes ─────────────────────────────────────────────────────

  const workloadOf = (plan: unknown) =>
    (plan as { footprint: { workloads: { compute: { cpuUnits: number; sizeLabel: string } }[] } }).footprint.workloads[0]!.compute;
  const getApplicationPlan = (applicationId: string, query = '') =>
    app.inject({ method: 'GET', url: `/api/applications/${applicationId}/plan${query}`, headers: { cookie: org.cookie } });
  const patchApplication = (applicationId: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: `/api/applications/${applicationId}`,
      headers: { cookie: org.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });

  it('GET /api/applications/:id/plan sizes the plan by ?profile, else the application default; an unknown profile is 422', async () => {
    const application = await insertApplication(db, org.organizationId, { analysisStatus: 'COMPLETE' });
    expect(workloadOf((await getApplicationPlan(application.id)).json())).toMatchObject({ cpuUnits: 256, sizeLabel: 'Small' });
    expect(workloadOf((await getApplicationPlan(application.id, '?profile=large')).json())).toMatchObject({
      cpuUnits: 2048,
      sizeLabel: 'Large',
    });

    const sized = await insertApplication(db, org.organizationId, { analysisStatus: 'COMPLETE', defaultSizeProfile: 'medium' });
    expect(workloadOf((await getApplicationPlan(sized.id)).json())).toMatchObject({ cpuUnits: 1024, sizeLabel: 'Medium' });

    const unknown = await getApplicationPlan(application.id, '?profile=huge');
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json()).toMatchObject({ error: { code: 'UNKNOWN_PROFILE' } });
  });

  it('PATCH /api/applications/:id persists valid size settings and refuses a default below the minimum', async () => {
    const application = await insertApplication(db, org.organizationId);
    const saved = await patchApplication(application.id, { defaultSizeProfile: 'medium', minimumSizeProfile: 'medium' });
    expect(saved.statusCode, saved.body).toBe(200);
    const [row] = await db.select().from(schema.applications).where(eq(schema.applications.id, application.id));
    expect(row).toMatchObject({ defaultSizeProfile: 'medium', minimumSizeProfile: 'medium' });

    for (const payload of [{ defaultSizeProfile: 'small' }, { minimumSizeProfile: 'large' }, { defaultSizeProfile: 'small', minimumSizeProfile: 'large' }]) {
      const refused = await patchApplication(application.id, payload);
      expect(refused.statusCode, refused.body).toBe(422);
      expect(refused.json()).toMatchObject({ error: { code: 'SIZE_DEFAULT_BELOW_MINIMUM' } });
    }
    const [unchanged] = await db.select().from(schema.applications).where(eq(schema.applications.id, application.id));
    expect(unchanged).toMatchObject({ defaultSizeProfile: 'medium', minimumSizeProfile: 'medium' });
  });

  it('GET /api/deployments/:id/plan: a legacy deployment (no stored profile) plans as small-v2; a stored medium-v1 ref plans as medium', async () => {
    const application = await insertApplication(db, org.organizationId);
    const customer = await insertCustomer(db, org.organizationId);
    const planOf = async (deployment: { id: string }) => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/deployments/${deployment.id}/plan?action=install`,
        headers: { cookie: org.cookie },
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json();
    };

    const legacy = await planOf(await insertDeployment(db, org.organizationId, application.id, customer.id));
    expect(legacy).toMatchObject({
      footprint: resolveDeploymentFootprint({ manifest: POSTGRES_MANIFEST, region: 'us-east-1', profile: SMALL_V2_PROFILE }),
    });
    expect(workloadOf(legacy)).toMatchObject({ cpuUnits: 256, sizeLabel: 'Small' });

    const medium = await planOf(
      await insertDeployment(db, org.organizationId, application.id, customer.id, {
        desiredState: { manifest: POSTGRES_MANIFEST, infrastructureProfile: { id: 'medium', version: 1 } },
      }),
    );
    expect(medium).toMatchObject({
      footprint: resolveDeploymentFootprint({ manifest: POSTGRES_MANIFEST, region: 'us-east-1', profile: MEDIUM_PROFILE }),
    });
    expect(workloadOf(medium)).toMatchObject({ cpuUnits: 1024, sizeLabel: 'Medium' });
  });
});
