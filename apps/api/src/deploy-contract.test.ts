import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';
import {
  deployzTaskFamily,
  taskFamilySuffix,
  workloadServicesFromSpec,
  type DeploymentManifest,
  type DeploymentSpecV2,
} from '@deployz/contracts';

import { createAuth, type Auth } from './auth.js';
import { compileDeploymentIntent } from './compiler-artifact.js';
import { hashRelayToken } from './relay-store.js';
import { buildServer, migrationIdentity } from './server.js';

// Phase 4 contract: the deploy payload is derived server-side from a READY
// release, one mutating operation may run per deployment, and RESTART exists
// as a first-class command that never touches the release pointers.
describe('deploy contract, busy gate and restart', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let cookie: string;
  let organizationId: string;
  let applicationId: string;
  let customerId: string;

  const REPO = '151955775369.dkr.ecr.us-east-1.amazonaws.com/deployz-images';

  /** Every build produces its own digest — releases of the same repo differ by version. */
  function digestFor(version: string): string {
    return `${REPO}@sha256:${hashRelayToken(version)}`;
  }

  async function seedDeployment(
    overrides: Partial<typeof schema.deployments.$inferInsert> = {},
  ): Promise<{
    id: string;
    installationId: string;
    token: string;
  }> {
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

  /** Inserts a bare INSTALL job in the given state, for tests that need a
   *  deployment's install history without going through the real flow. */
  async function seedInstallJob(
    deploymentId: string,
    state: 'SUCCEEDED' | 'FAILED',
  ): Promise<void> {
    await db.insert(schema.deploymentJobs).values({
      deploymentId,
      type: 'INSTALL',
      state,
      idempotencyKey: `${deploymentId}:INSTALL:${crypto.randomUUID()}`,
      finishedAt: new Date(),
    });
  }

  async function seedRelease(
    version: string,
    options: {
      releaseStatus?: 'BUILDING' | 'READY' | 'FAILED';
      imageDigest?: string | null;
      migrationCommand?: string | null;
    } = {},
  ): Promise<string> {
    const [row] = await db
      .insert(schema.releases)
      .values({
        applicationId,
        version,
        gitSha: 'abc123',
        imageDigest:
          'imageDigest' in options ? options.imageDigest! : digestFor(version),
        buildStatus: options.releaseStatus === 'READY' ? 'SUCCEEDED' : 'BUILDING',
        releaseStatus: options.releaseStatus ?? 'READY',
        ...('migrationCommand' in options ? { migrationCommand: options.migrationCommand } : {}),
      })
      .returning();
    return row!.id;
  }

  function post(path: string, body: unknown) {
    return app.inject({
      method: 'POST',
      url: path,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);

    const email = 'deploy-contract@example.com';
    const password = 'super-secret-1';
    await auth.api.signUpEmail({ body: { email, password, name: 'Contract' } });
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
        repoFullName: `acme/dc-${crypto.randomUUID().slice(0, 8)}`,
        repoUrl: 'https://github.com/acme/dc',
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

  /** A manifest whose analyzed migration command froze into the graph. */
  const MIGRATING_MANIFEST: DeploymentManifest = {
    schemaVersion: 1,
    application: { root: '.', runtime: 'node', framework: null, dockerfilePath: null },
    build: { command: null, context: '.' },
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
  };

  function migratingSpec(): DeploymentSpecV2 {
    return compileDeploymentIntent({ manifest: MIGRATING_MANIFEST, region: 'us-east-1' }).spec;
  }

  function digestOf(version: string): string {
    return digestFor(version).split('@')[1]!;
  }

  /** Seeds a settled DEPLOY_RELEASE job whose payload confirmed an identity. */
  async function seedConfirmedMigration(
    deploymentId: string,
    identity: string,
    state: 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED',
  ): Promise<void> {
    await db.insert(schema.deploymentJobs).values({
      deploymentId,
      type: 'DEPLOY_RELEASE',
      state,
      idempotencyKey: `${deploymentId}:DEPLOY_RELEASE:confirmed:${crypto.randomUUID()}`,
      payload: { migrationTask: { family: 'DeployzAppMigration', identity } },
      finishedAt: new Date(),
    });
  }

  it('derives the payload server-side from a READY release', async () => {
    const deployment = await seedDeployment();
    const releaseId = await seedRelease('v1.0.0');

    const response = await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });
    expect(response.statusCode, response.body).toBe(202);

    const [job] = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    expect(job?.type).toBe('DEPLOY_RELEASE');
    expect(job?.payload).toEqual({
      releaseId,
      version: 'v1.0.0',
      imageRepository: REPO,
      imageDigest: digestFor('v1.0.0').split('@')[1],
    });
  });

  it('threads the FROZEN migration task seat into the DEPLOY_RELEASE payload (never the command)', async () => {
    const deployment = await seedDeployment({ specV2: migratingSpec() as unknown as Record<string, unknown> });
    const releaseId = await seedRelease('v0.11.0');

    const response = await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });
    expect(response.statusCode, response.body).toBe(202);

    const [job] = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    // The relay receives the compiled FAMILY plus the identity — the analyzed
    // command itself stays frozen in the spec, never on the wire.
    expect(job?.payload).toMatchObject({
      migrationTask: {
        family: deployzTaskFamily('migration', taskFamilySuffix(deployment.installationId)),
        identity: migrationIdentity('npm run db:migrate', digestOf('v0.11.0')),
      },
    });
    expect(job?.payload).not.toHaveProperty('migrationCommand');
  });

  it('names a different migration family for each installation of the same spec and image', async () => {
    const a = await seedDeployment({ specV2: migratingSpec() as unknown as Record<string, unknown> });
    const b = await seedDeployment({ specV2: migratingSpec() as unknown as Record<string, unknown> });
    const releaseId = await seedRelease('v0.11.1');
    const families: string[] = [];
    for (const deployment of [a, b]) {
      const response = await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });
      expect(response.statusCode, response.body).toBe(202);
      const [job] = await db
        .select()
        .from(schema.deploymentJobs)
        .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
      families.push((job?.payload as { migrationTask: { family: string } }).migrationTask.family);
    }
    expect(families[0]).not.toBe(families[1]);
    for (const family of families) expect(family).toMatch(/^DeployzApp[A-Za-z0-9]+$/);
  });

  it('keeps the shared family name of an artifact compiled before installation-scoped families', async () => {
    const legacy = { ...migratingSpec(), compilerVersion: 'dynamic-compiler-v2-2' };
    const deployment = await seedDeployment({ specV2: legacy as unknown as Record<string, unknown> });
    const releaseId = await seedRelease('v0.11.2');

    const response = await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });
    expect(response.statusCode, response.body).toBe(202);
    const [job] = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    expect(job?.payload).toMatchObject({ migrationTask: { family: 'DeployzAppMigration' } });
  });

  it('skips the migration seat once the same identity has a SUCCEEDED deploy', async () => {
    const deployment = await seedDeployment({ specV2: migratingSpec() as unknown as Record<string, unknown> });
    const releaseId = await seedRelease('v0.12.0');
    await seedConfirmedMigration(deployment.id, migrationIdentity('npm run db:migrate', digestOf('v0.12.0')));

    const response = await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });
    expect(response.statusCode, response.body).toBe(202);

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    const deployJob = jobs.find((job) => job.type === 'DEPLOY_RELEASE' && job.state === 'REQUESTED');
    expect(deployJob?.payload).not.toHaveProperty('migrationTask');
  });

  it('keeps the migration seat when only a FAILED deploy carried the identity (never assume success)', async () => {
    const deployment = await seedDeployment({ specV2: migratingSpec() as unknown as Record<string, unknown> });
    const releaseId = await seedRelease('v0.13.0');
    await seedConfirmedMigration(
      deployment.id,
      migrationIdentity('npm run db:migrate', digestOf('v0.13.0')),
      'FAILED',
    );

    const response = await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });
    expect(response.statusCode, response.body).toBe(202);

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    const deployJob = jobs.find((job) => job.type === 'DEPLOY_RELEASE' && job.state === 'REQUESTED');
    expect(deployJob?.payload).toMatchObject({
      migrationTask: { family: deployzTaskFamily('migration', taskFamilySuffix(deployment.installationId)) },
    });
  });

  it('a changed identity (new image digest) runs the migration again', async () => {
    const deployment = await seedDeployment({ specV2: migratingSpec() as unknown as Record<string, unknown> });
    const releaseId = await seedRelease('v0.14.0');
    // Confirmed for a DIFFERENT image digest.
    await seedConfirmedMigration(deployment.id, migrationIdentity('npm run db:migrate', 'sha256:' + 'f'.repeat(64)));

    const response = await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });
    expect(response.statusCode, response.body).toBe(202);

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    const deployJob = jobs.find((job) => job.type === 'DEPLOY_RELEASE' && job.state === 'REQUESTED');
    expect(deployJob?.payload).toMatchObject({
      migrationTask: {
        identity: migrationIdentity('npm run db:migrate', digestOf('v0.14.0')),
      },
    });
  });

  describe('migration policy snapshot (correction / no separate migration)', () => {
    const CORRECTED = 'bunx prisma migrate deploy';

    /** A fresh application (the policy is application-level), its release and a migrating deployment. */
    async function migratingSetup(version: string, spec: DeploymentSpecV2 | null = migratingSpec()) {
      const [application] = await db
        .insert(schema.applications)
        .values({
          organizationId,
          name: 'Migrating',
          repoFullName: `acme/mig-${crypto.randomUUID().slice(0, 8)}`,
          repoUrl: 'https://github.com/acme/mig',
          defaultBranch: 'main',
          migrationCommand: 'npm run db:migrate',
        })
        .returning();
      const [release] = await db
        .insert(schema.releases)
        .values({
          applicationId: application!.id,
          version,
          gitSha: 'abc123',
          imageDigest: digestFor(version),
          buildStatus: 'SUCCEEDED',
          releaseStatus: 'READY',
        })
        .returning();
      const deployment = await seedDeployment({
        applicationId: application!.id,
        ...(spec !== null ? { specV2: spec as unknown as Record<string, unknown> } : {}),
      });
      return { appId: application!.id, releaseId: release!.id, deployment };
    }

    function setMigration(appId: string, migrationCommand: string | null) {
      return app.inject({
        method: 'PATCH',
        url: `/api/applications/${appId}`,
        headers: { cookie, 'content-type': 'application/json' },
        payload: JSON.stringify({ migrationCommand }),
      });
    }

    async function deployJobs(deploymentId: string) {
      return (
        await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.deploymentId, deploymentId))
      ).filter((job) => job.type === 'DEPLOY_RELEASE');
    }

    it('records an explicit null as the vendor decision "No separate migration"', async () => {
      const { appId } = await migratingSetup('v7.0.0');
      const response = await setMigration(appId, null);
      expect(response.statusCode, response.body).toBe(200);
      const [row] = await db.select().from(schema.applications).where(eq(schema.applications.id, appId));
      expect(row?.migrationCommand).toBeNull();
      expect(row?.detectedMetadata?.['vendorOverrides']).toContain('migrationCommand');
    });

    it('snapshots a same-image correction: the command and a new identity ride the seat', async () => {
      const { appId, releaseId, deployment } = await migratingSetup('v7.1.0');
      // The frozen command already ran for this exact image.
      await seedConfirmedMigration(deployment.id, migrationIdentity('npm run db:migrate', digestOf('v7.1.0')));
      await setMigration(appId, CORRECTED);

      const response = await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });
      expect(response.statusCode, response.body).toBe(202);

      const job = (await deployJobs(deployment.id)).find((entry) => entry.state === 'REQUESTED');
      expect(job?.payload).toMatchObject({
        migrationTask: {
          family: deployzTaskFamily('migration', taskFamilySuffix(deployment.installationId)),
          identity: migrationIdentity(CORRECTED, digestOf('v7.1.0')),
          command: CORRECTED,
        },
        migrationPolicy: expect.stringMatching(/^corrected:[0-9a-f]{16}$/),
      });
      expect(job?.idempotencyKey).toMatch(new RegExp(`^${deployment.id}:DEPLOY_RELEASE:${releaseId}:migration:corrected:`));
    });

    it('skips the migration for "No separate migration" and keys the job on that policy', async () => {
      const { appId, releaseId, deployment } = await migratingSetup('v7.2.0');
      await setMigration(appId, null);

      const response = await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });
      expect(response.statusCode, response.body).toBe(202);

      const [job] = await deployJobs(deployment.id);
      expect(job?.payload).not.toHaveProperty('migrationTask');
      expect(job?.payload).toMatchObject({ migrationPolicy: 'skip' });
      expect(job?.idempotencyKey).toBe(`${deployment.id}:DEPLOY_RELEASE:${releaseId}:migration:skip`);
    });

    it('resets to detected: the marker goes and existing deployments run the frozen command again', async () => {
      const { appId, releaseId, deployment } = await migratingSetup('v7.2.1');
      await setMigration(appId, null);

      const reset = await app.inject({
        method: 'PATCH',
        url: `/api/applications/${appId}`,
        headers: { cookie, 'content-type': 'application/json' },
        payload: JSON.stringify({ resetMigrationCommand: true }),
      });
      expect(reset.statusCode, reset.body).toBe(200);
      const [row] = await db.select().from(schema.applications).where(eq(schema.applications.id, appId));
      expect(row?.detectedMetadata?.['vendorOverrides']).not.toContain('migrationCommand');

      await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });
      const [job] = await deployJobs(deployment.id);
      expect(job?.payload).not.toHaveProperty('migrationPolicy');
      expect(job?.payload).toMatchObject({
        migrationTask: { identity: migrationIdentity('npm run db:migrate', digestOf('v7.2.1')) },
      });
    });

    it('treats a correction equal to the frozen command as the frozen policy', async () => {
      const { appId, releaseId, deployment } = await migratingSetup('v7.3.0');
      await setMigration(appId, 'npm run db:migrate');
      await setMigration(appId, 'npm run db:migrate ');

      await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });

      const [job] = await deployJobs(deployment.id);
      expect(job?.payload).not.toHaveProperty('migrationPolicy');
      expect(job?.payload).toMatchObject({
        migrationTask: { identity: migrationIdentity('npm run db:migrate', digestOf('v7.3.0')) },
      });
      expect((job?.payload as { migrationTask: object }).migrationTask).not.toHaveProperty('command');
      expect(job?.idempotencyKey).toBe(`${deployment.id}:DEPLOY_RELEASE:${releaseId}`);
    });

    it('never changes an active job: a policy edit while a deploy is active is refused as busy', async () => {
      const { appId, releaseId, deployment } = await migratingSetup('v7.4.0');
      expect((await post(`/api/deployments/${deployment.id}/deploy`, { releaseId })).statusCode).toBe(202);
      const [active] = await deployJobs(deployment.id);

      await setMigration(appId, CORRECTED);
      const response = await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'DEPLOYMENT_BUSY' } });

      const jobs = await deployJobs(deployment.id);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.payload).toEqual(active?.payload);
    });

    it('refuses to enable a migration on a deployment created without a migration step', async () => {
      const { appId, releaseId, deployment } = await migratingSetup('v7.5.0', null);
      await setMigration(appId, CORRECTED);

      const response = await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'MIGRATION_WORKLOAD_MISSING' } });
      expect(await deployJobs(deployment.id)).toHaveLength(0);

      const bulk = await post(`/api/applications/${appId}/deploy-bulk`, { releaseId });
      expect(bulk.statusCode, bulk.body).toBe(200);
      expect(bulk.json().results).toEqual([
        expect.objectContaining({ deploymentId: deployment.id, status: 'SKIPPED', reason: expect.stringContaining('No separate migration') }),
      ]);
    });

    it('bulk deploy snapshots each target policy the same way as the single route', async () => {
      const { appId, releaseId, deployment } = await migratingSetup('v7.6.0');
      await setMigration(appId, CORRECTED);

      const bulk = await post(`/api/applications/${appId}/deploy-bulk`, { releaseId });
      expect(bulk.json().results).toEqual([expect.objectContaining({ status: 'REQUESTED' })]);

      const [job] = await deployJobs(deployment.id);
      expect(job?.payload).toMatchObject({ migrationTask: { command: CORRECTED } });
      expect(job?.idempotencyKey).toMatch(/:migration:corrected:/);
    });
  });

  it('rollback and restart payloads never carry the migration seat', async () => {
    const deployment = await seedDeployment({ specV2: migratingSpec() as unknown as Record<string, unknown> });
    const releaseId = await seedRelease('v0.15.0');

    await post(`/api/deployments/${deployment.id}/rollback`, { releaseId });
    await post(`/api/deployments/${deployment.id}/restart`, {});
    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    for (const job of jobs) {
      expect(job.payload, job.type).not.toHaveProperty('migrationTask');
    }
  });

  it.each(['BUILDING', 'FAILED'] as const)(
    'refuses a deploy of a %s release with 409 RELEASE_NOT_READY',
    async (releaseStatus) => {
      const deployment = await seedDeployment();
      const releaseId = await seedRelease(`v1.4.${releaseStatus === 'BUILDING' ? 0 : 1}`, {
        releaseStatus,
        imageDigest: null,
      });

      const response = await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'RELEASE_NOT_READY' } });
    },
  );

  it('refuses a READY release without a digest with 409 RELEASE_NOT_READY', async () => {
    const deployment = await seedDeployment();
    const releaseId = await seedRelease('v9.5.0', { imageDigest: null });

    const response = await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'RELEASE_NOT_READY' } });
  });

  it('refuses a deploy when the application now needs a database the frozen stack lacks (INFRASTRUCTURE_CHANGE_REQUIRED)', async () => {
    const statelessSpec = compileDeploymentIntent({
      manifest: { ...MIGRATING_MANIFEST, database: { postgres: false }, migration: { command: null } },
      region: 'us-east-1',
    }).spec;
    const [needsDb] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Needs DB',
        repoFullName: `acme/dc-db-${crypto.randomUUID().slice(0, 8)}`,
        repoUrl: 'https://github.com/acme/dc-db',
        defaultBranch: 'main',
        databaseRequired: true,
      })
      .returning();
    const deployment = await seedDeployment({
      applicationId: needsDb!.id,
      specV2: statelessSpec as unknown as Record<string, unknown>,
    });
    const [release] = await db
      .insert(schema.releases)
      .values({
        applicationId: needsDb!.id,
        version: 'v1.0.0',
        gitSha: 'abc123',
        imageDigest: digestFor('needs-db-v1'),
        buildStatus: 'SUCCEEDED',
        releaseStatus: 'READY',
      })
      .returning();

    const single = await post(`/api/deployments/${deployment.id}/deploy`, { releaseId: release!.id });
    expect(single.statusCode, single.body).toBe(409);
    expect(single.json()).toMatchObject({ error: { code: 'INFRASTRUCTURE_CHANGE_REQUIRED' } });

    const bulk = await post(`/api/applications/${needsDb!.id}/deploy-bulk`, { releaseId: release!.id });
    expect(bulk.statusCode, bulk.body).toBe(200);
    expect((bulk.json() as { results: unknown[] }).results).toEqual([
      expect.objectContaining({ deploymentId: deployment.id, status: 'SKIPPED', reason: expect.stringContaining('a database') }),
    ]);

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    expect(jobs).toEqual([]);
  });

  describe('topology the frozen stack cannot apply', () => {
    const queue = {
      id: 'jobs',
      envBindings: [{ name: 'JOBS_QUEUE_URL', kind: 'url' }],
      producers: ['web'],
      consumers: ['web'],
      source: 'src/queue.ts',
    };
    const schedule = {
      id: 'nightly',
      command: 'node job.js',
      schedule: { type: 'cron', cron: '0 3 * * *' },
      timezone: null,
      source: 'deploy.yml',
    };

    /** An application that needs the database the frozen (PostgreSQL) stack has, plus the given analysis facts. */
    async function seedApplication(
      detectedMetadata: Record<string, unknown>,
      overrides: Partial<typeof schema.applications.$inferInsert> = {},
    ) {
      const [row] = await db
        .insert(schema.applications)
        .values({
          organizationId,
          name: 'Topology App',
          repoFullName: `acme/dc-topology-${crypto.randomUUID().slice(0, 8)}`,
          repoUrl: 'https://github.com/acme/dc-topology',
          defaultBranch: 'main',
          databaseRequired: true,
          detectedMetadata,
          ...overrides,
        })
        .returning();
      const [release] = await db
        .insert(schema.releases)
        .values({
          applicationId: row!.id,
          version: 'v1.0.0',
          gitSha: 'abc123',
          imageDigest: digestFor(`topology-${row!.id}`),
          buildStatus: 'SUCCEEDED',
          releaseStatus: 'READY',
        })
        .returning();
      const deployment = await seedDeployment({
        applicationId: row!.id,
        specV2: migratingSpec() as unknown as Record<string, unknown>,
        desiredState: { manifest: MIGRATING_MANIFEST },
      });
      return { applicationId: row!.id, releaseId: release!.id, deployment };
    }

    it.each([
      ['database engine', { mysql: { required: true } }],
      ['worker', { resolvedWorkerCommands: [{ id: 'email-worker', command: 'node worker.js', source: 'Procfile' }] }],
      ['queue', { asyncQueues: [queue] }],
      ['schedule', { asyncScheduledJobs: [schedule] }],
    ])('refuses a changed %s with INFRASTRUCTURE_CHANGE_REQUIRED, skips it in bulk and reports it in the plan', async (_name, metadata) => {
      const { applicationId, releaseId, deployment } = await seedApplication(metadata);

      const single = await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });
      expect(single.statusCode, single.body).toBe(409);
      expect(single.json()).toMatchObject({ error: { code: 'INFRASTRUCTURE_CHANGE_REQUIRED' } });

      const bulk = await post(`/api/applications/${applicationId}/deploy-bulk`, { releaseId });
      expect((bulk.json() as { results: unknown[] }).results).toEqual([
        expect.objectContaining({ deploymentId: deployment.id, status: 'SKIPPED' }),
      ]);

      const plan = await app.inject({
        method: 'GET',
        url: `/api/deployments/${deployment.id}/plan?action=update`,
        headers: { cookie },
      });
      expect(plan.statusCode, plan.body).toBe(200);
      const body = plan.json() as { requirementDrift: unknown[]; infrastructureChange: unknown };
      expect(body.requirementDrift.length).toBeGreaterThan(0);
      expect(body.infrastructureChange).toEqual({ status: 'unsupported', reason: 'topology_changed' });

      expect(await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.deploymentId, deployment.id))).toEqual([]);
    });

    it('still deploys a changed port and health path', async () => {
      const { releaseId, deployment } = await seedApplication({}, { containerPort: 8080, healthPath: '/ready' });

      const response = await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });
      expect(response.statusCode, response.body).toBe(202);
    });
  });

  it('still deploys when the application dropped a database the frozen stack has', async () => {
    const deployment = await seedDeployment({ specV2: migratingSpec() as unknown as Record<string, unknown> });
    const releaseId = await seedRelease('v9.6.0');

    const response = await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });
    expect(response.statusCode, response.body).toBe(202);
  });

  it('refuses every mutating command while one is active (DEPLOYMENT_BUSY)', async () => {
    const deployment = await seedDeployment();
    const releaseId = await seedRelease('v2.0.0');
    await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });

    const other = await seedRelease('v2.1.0');
    for (const [path, body] of [
      [`/api/deployments/${deployment.id}/deploy`, { releaseId: other }],
      [`/api/deployments/${deployment.id}/rollback`, { releaseId: other }],
      [`/api/deployments/${deployment.id}/restart`, {}],
      [`/api/deployments/${deployment.id}/destroy`, { finalSnapshot: false }],
    ] as const) {
      const response = await post(path, body);
      expect(response.statusCode, `${path} ${response.body}`).toBe(409);
      expect(response.json()).toMatchObject({
        error: {
          code: 'DEPLOYMENT_BUSY',
          message: 'Another deployment operation is already in progress.',
        },
      });
    }
  });

  it('creates a RESTART job without touching the release pointers', async () => {
    const deployment = await seedDeployment();
    const current = await seedRelease('v3.0.0');
    await db
      .update(schema.deployments)
      .set({ currentReleaseId: current })
      .where(eq(schema.deployments.id, deployment.id));

    const response = await post(`/api/deployments/${deployment.id}/restart`, {});
    expect(response.statusCode, response.body).toBe(202);

    const [job] = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    expect(job?.type).toBe('RESTART');
    expect(job?.payload).toEqual({});

    const [row] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id));
    expect(row?.currentReleaseId).toBe(current);
    expect(row?.state).toBe('UPDATING');
  });

  it('rejects restart and deploy on a never-installed FAILED deployment with 409 DEPLOYMENT_NOT_DEPLOYABLE', async () => {
    const deployment = await seedDeployment({ state: 'FAILED' });
    const releaseId = await seedRelease('v5.0.0');

    for (const response of [
      await post(`/api/deployments/${deployment.id}/restart`, {}),
      await post(`/api/deployments/${deployment.id}/deploy`, { releaseId }),
    ]) {
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'DEPLOYMENT_NOT_DEPLOYABLE' } });
    }

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    expect(jobs).toHaveLength(0);
  });

  it('allows restart and deploy on a FAILED deployment that has a prior successful install', async () => {
    // Two separate deployments — restart's own job would otherwise leave the
    // deployment busy (DEPLOYMENT_BUSY) for the deploy call right after it.
    const restartTarget = await seedDeployment({ state: 'FAILED' });
    await seedInstallJob(restartTarget.id, 'SUCCEEDED');
    const restart = await post(`/api/deployments/${restartTarget.id}/restart`, {});
    expect(restart.statusCode, restart.body).toBe(202);

    const deployTarget = await seedDeployment({ state: 'FAILED' });
    await seedInstallJob(deployTarget.id, 'SUCCEEDED');
    const releaseId = await seedRelease('v5.1.0');
    const deploy = await post(`/api/deployments/${deployTarget.id}/deploy`, { releaseId });
    expect(deploy.statusCode, deploy.body).toBe(202);
  });

  it('a failed DESTROY is retryable: Disconnect after a FAILED destroy queues a fresh job', async () => {
    const deployment = await seedDeployment();

    const first = await post(`/api/deployments/${deployment.id}/destroy`, {});
    expect(first.statusCode, first.body).toBe(202);
    const { jobId: firstJobId } = first.json() as { jobId: string };

    const result = await app.inject({
      method: 'POST',
      url: `/api/relay/commands/${firstJobId}/result`,
      headers: { authorization: `Bearer ${deployment.token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ success: false, error: 'stack deletion failed' }),
    });
    expect(result.statusCode, result.body).toBe(200);

    const [deploymentRow] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id));
    expect(deploymentRow?.state).toBe('FAILED');

    const second = await post(`/api/deployments/${deployment.id}/destroy`, {});
    expect(second.statusCode, second.body).toBe(202);
    const { jobId: secondJobId } = second.json() as { jobId: string };
    expect(secondJobId).not.toBe(firstJobId);

    const destroyJobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    expect(destroyJobs.filter((j) => j.type === 'DESTROY')).toHaveLength(2);
  });

  it('a failed DEPLOY_RELEASE of the same release is retryable with a fresh job', async () => {
    // Observed live: the fixed derived key handed the FAILED job back on the
    // retry, so "Confirm Deploy" silently did nothing.
    const deployment = await seedDeployment();
    await seedInstallJob(deployment.id, 'SUCCEEDED');
    const releaseId = await seedRelease('v6.0.0');

    const first = await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });
    expect(first.statusCode, first.body).toBe(202);
    const { jobId: firstJobId } = first.json() as { jobId: string };

    const result = await app.inject({
      method: 'POST',
      url: `/api/relay/commands/${firstJobId}/result`,
      headers: { authorization: `Bearer ${deployment.token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ success: false, error: 'AccessDenied on ecs:TagResource' }),
    });
    expect(result.statusCode, result.body).toBe(200);

    const second = await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });
    expect(second.statusCode, second.body).toBe(202);
    const { jobId: secondJobId } = second.json() as { jobId: string };
    expect(secondJobId).not.toBe(firstJobId);
  });

  it('a release deployed before is deployable again as a fresh attempt once its job settled', async () => {
    // Version canary: after v2 SUCCEEDED and a rollback to v1, "Deploy
    // Update" to v2 handed back the old succeeded v2 job (200) and nothing
    // ran — v1 kept serving. Only an ACTIVE attempt absorbs a replay.
    const deployment = await seedDeployment();
    await seedInstallJob(deployment.id, 'SUCCEEDED');
    const releaseId = await seedRelease('v7.0.0');

    const first = await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });
    expect(first.statusCode, first.body).toBe(202);
    const { jobId: firstJobId } = first.json() as { jobId: string };

    // A double-click while the attempt is active replays it.
    const replay = await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });
    expect(replay.statusCode, replay.body).toBe(200);
    expect((replay.json() as { jobId: string }).jobId).toBe(firstJobId);

    const result = await app.inject({
      method: 'POST',
      url: `/api/relay/commands/${firstJobId}/result`,
      headers: { authorization: `Bearer ${deployment.token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ success: true, output: { executed: true } }),
    });
    expect(result.statusCode, result.body).toBe(200);

    const again = await post(`/api/deployments/${deployment.id}/deploy`, { releaseId });
    expect(again.statusCode, again.body).toBe(202);
    const { jobId: secondJobId } = again.json() as { jobId: string };
    expect(secondJobId).not.toBe(firstJobId);
    const jobs = await db
      .select({ idempotencyKey: schema.deploymentJobs.idempotencyKey })
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.id, secondJobId));
    expect(jobs[0]!.idempotencyKey).toBe(`${deployment.id}:DEPLOY_RELEASE:${releaseId}:RETRY:1`);
  });

  /** The relay's healthy release evidence for the migrating spec's workloads, running `digest`. */
  function healthyEvidenceFor(digest: string) {
    const at = new Date().toISOString();
    return {
      version: 1,
      observedAt: at,
      services: workloadServicesFromSpec(migratingSpec())!.map((workload) => ({
        workloadId: workload.id,
        serviceLogicalId: workload.serviceLogicalId,
        observed: true,
        desiredCount: 2,
        runningCount: 2,
        rolloutState: 'COMPLETED',
        runningDigests: [digest],
        targets: workload.id === 'web' ? { healthy: 2, unhealthy: 0, pending: 0, unknown: 0 } : null,
      })),
      httpProbe: { ok: true, status: 200, checkedAt: at },
    };
  }

  async function postHealthy(
    deployment: { id: string; installationId: string; token: string },
    digest: string,
  ): Promise<void> {
    const heartbeat = await app.inject({
      method: 'POST',
      url: '/api/relay/health',
      headers: { authorization: `Bearer ${deployment.token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        installationId: deployment.installationId,
        healthStatus: 'HEALTHY',
        runningImageDigest: digest,
        observedState: { releaseEvidence: healthyEvidenceFor(digest) },
      }),
    });
    expect(heartbeat.statusCode, heartbeat.body).toBe(200);
  }

  it('advances pointers v1 → v2 → v3 → rollback → v2 only after each rollout passes the promotion gate', async () => {
    const deployment = await seedDeployment({ specV2: migratingSpec() as unknown as Record<string, unknown> });
    const v1 = await seedRelease('v4.0.0');
    const v2 = await seedRelease('v4.1.0');
    const v3 = await seedRelease('v4.2.0');

    const releaseDigest = async (releaseId: string): Promise<string> => {
      const [row] = await db
        .select({ imageDigest: schema.releases.imageDigest })
        .from(schema.releases)
        .where(eq(schema.releases.id, releaseId));
      return row?.imageDigest ?? '';
    };

    // Reports the job's success, then the heartbeat that observes the release
    // running behind every gate (§10.3) — the only thing that promotes it.
    const reportSuccess = async (releaseId: string, type: string): Promise<void> => {
      const jobs = await db
        .select()
        .from(schema.deploymentJobs)
        .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
      const target = jobs
        .reverse()
        .find(
          (j) => j.type === type && (j.payload as { releaseId?: string }).releaseId === releaseId,
        );
      if (!target) throw new Error(`no ${type} job for ${releaseId}`);
      const response = await app.inject({
        method: 'POST',
        url: `/api/relay/commands/${target.id}/result`,
        headers: {
          authorization: `Bearer ${deployment.token}`,
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ success: true }),
      });
      expect(response.statusCode, response.body).toBe(200);

      await postHealthy(deployment, await releaseDigest(releaseId));
    };

    const pointers = async () => {
      const [row] = await db
        .select()
        .from(schema.deployments)
        .where(eq(schema.deployments.id, deployment.id));
      return { current: row?.currentReleaseId ?? null, previous: row?.previousReleaseId ?? null };
    };

    await db.update(schema.deployments).set({ currentReleaseId: v1 }).where(eq(schema.deployments.id, deployment.id));
    await post(`/api/deployments/${deployment.id}/deploy`, { releaseId: v2 });
    await reportSuccess(v2, 'DEPLOY_RELEASE');
    expect(await pointers()).toEqual({ current: v2, previous: v1 });

    await post(`/api/deployments/${deployment.id}/deploy`, { releaseId: v3 });
    await reportSuccess(v3, 'DEPLOY_RELEASE');
    expect(await pointers()).toEqual({ current: v3, previous: v2 });

    await post(`/api/deployments/${deployment.id}/rollback`, { releaseId: v2 });
    await reportSuccess(v2, 'ROLLBACK');
    expect(await pointers()).toEqual({ current: v2, previous: v3 });
  });

  it('does not present the previous release as confirmed after a failed rollback until fresh evidence re-confirms it', async () => {
    const deployment = await seedDeployment({ specV2: migratingSpec() as unknown as Record<string, unknown> });
    const v1 = await seedRelease('v8.0.0');
    const v2 = await seedRelease('v8.1.0');
    await db.update(schema.deployments).set({ currentReleaseId: v2 }).where(eq(schema.deployments.id, deployment.id));
    const digest = digestOf('v8.1.0');
    await postHealthy(deployment, digest);

    const servingRelease = async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/deployments/${deployment.id}`,
        headers: { cookie },
      });
      return (response.json() as { deploymentStatus: { servingRelease: unknown } }).deploymentStatus.servingRelease;
    };
    expect(await servingRelease()).toMatchObject({ releaseId: v2, confirmed: true });

    await post(`/api/deployments/${deployment.id}/rollback`, { releaseId: v1 });
    const [job] = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
    const failed = await app.inject({
      method: 'POST',
      url: `/api/relay/commands/${job!.id}/result`,
      headers: { authorization: `Bearer ${deployment.token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ success: false, error: 'rollout failed' }),
    });
    expect(failed.statusCode, failed.body).toBe(200);

    // The update failed: the deployment stays live on v2, but nothing has
    // re-confirmed that v2 is what serves.
    expect(await servingRelease()).toEqual({ releaseId: v2, confirmedAt: null, confirmed: false });

    await new Promise((resolve) => setTimeout(resolve, 20));
    await postHealthy(deployment, digest);
    expect(await servingRelease()).toMatchObject({ releaseId: v2, confirmed: true });
  });
});
