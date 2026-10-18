import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createConfigDeps, createConfigStore, listVendorValues, setConfig } from './config.js';
import { compileDeploymentIntent } from './compiler-artifact.js';
import { buildInstallPayload, buildRelayConfigEntries, queuePostInstallConfig } from './install-config.js';
import { createCipherStub, createDrizzlePendingSecretStore } from './pending-secrets.js';

import type { DeploymentManifest } from '@deployz/contracts';

// AI MVP Phase 4 — the first configuration pass after a successful INSTALL:
// the relay's effective-config view carries every saved entry (plain values
// travel, secret values never do) plus one `generated` entry per app-internal
// secret the vendor did not set, and a successful INSTALL queues exactly one
// CONFIG_UPDATE job for it.

const MANIFEST_ENV = [
  { key: 'DATABASE_URL', required: true, secret: false, source: [], classification: 'deployz_managed' },
  { key: 'SESSION_SECRET', required: true, secret: true, source: [], classification: 'deployz_generated' },
  { key: 'ENCRYPTION_KEY', required: true, secret: true, source: [], classification: 'deployz_generated' },
  { key: 'LICENSE_KEY', required: true, secret: true, source: [], classification: 'customer_required' },
  { key: 'LOG_LEVEL', required: false, secret: false, source: [], classification: 'optional' },
  // An app-internal secret the analyser did not classify as generated (kutt's
  // JWT_SECRET: `str({ devDefault })`, so "optional" to the detector).
  { key: 'JWT_SECRET', required: false, secret: true, source: [], purpose: 'internal_secret', classification: 'optional' },
  // An external credential: never minted, whatever its value state.
  { key: 'OIDC_CLIENT_SECRET', required: false, secret: true, source: [], purpose: 'external_credential', classification: 'optional' },
];

// An outline-shaped manifest (DEPLOY-030): the purpose values the FIXED
// analyser now produces for the real outline minting incident (see
// packages/analysis/test/stage-b-phase3.test.ts's provider-prefix/TLS/
// location-suffix assertions). Only SECRET_KEY/UTILS_SECRET stay
// purpose: internal_secret; the rest reclassify to external_credential or
// optional_configuration, so mintableKeys's unchanged `secret && purpose ===
// 'internal_secret'` rule mints only the first two.
const OUTLINE_MANIFEST_ENV = [
  { key: 'SECRET_KEY', required: false, secret: true, source: [], purpose: 'internal_secret', classification: 'optional' },
  { key: 'UTILS_SECRET', required: false, secret: true, source: [], purpose: 'internal_secret', classification: 'unknown' },
  { key: 'SSL_KEY', required: false, secret: true, source: [], purpose: 'optional_configuration', classification: 'unknown' },
  { key: 'AWS_ACCESS_KEY_ID', required: false, secret: true, source: [], purpose: 'external_credential', classification: 'unknown' },
  { key: 'DROPBOX_APP_KEY', required: false, secret: true, source: [], purpose: 'external_credential', classification: 'unknown' },
  { key: 'GITHUB_WEBHOOK_SECRET', required: false, secret: true, source: [], purpose: 'external_credential', classification: 'unknown' },
  { key: 'SLACK_VERIFICATION_TOKEN', required: false, secret: true, source: [], purpose: 'external_credential', classification: 'unknown' },
  { key: 'OIDC_TOKEN_URI', required: false, secret: false, source: [], purpose: 'external_credential', classification: 'unknown' },
];

function manifest(variables: unknown[] = MANIFEST_ENV) {
  return {
    application: { root: '.', runtime: 'node', framework: 'express', dockerfilePath: 'Dockerfile' },
    build: { command: null, context: '.' },
    web: { command: 'node server.js', port: 3000 },
    health: { path: '/health' },
    database: { postgres: true },
    redis: { required: false, envBindings: [] },
    storage: { required: false, envBindings: [] },
    migration: { command: null },
    worker: { command: null },
    environment: { variables },
    externalServices: [],
    unsupported: [],
  };
}

/** The completed spec createDeploymentRecord persists for a manifest. */
const INSTALLATION_ID = 'Inst-0001-ABCD';

function completedSpecFor(variables: unknown[] = MANIFEST_ENV) {
  return compileDeploymentIntent({
    manifest: manifest(variables) as unknown as DeploymentManifest,
    region: 'us-east-1',
  }).spec;
}

describe('post-install configuration', () => {
  let client: PGlite | undefined;
  let db: Db;
  let applicationId: string;
  let customerId: string;
  let deploymentId: string;
  const organizationId = 'org-install-config';

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    await db.insert(schema.organization).values({ id: organizationId, name: 'Acme', slug: organizationId });
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'App',
        repoFullName: 'acme/app',
        repoUrl: 'https://github.com/acme/app',
        defaultBranch: 'main',
        analysisStatus: 'COMPLETE',
      })
      .returning();
    applicationId = application!.id;
    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId, name: 'Customer', email: 'customer@example.com' })
      .returning();
    customerId = customer!.id;
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        state: 'INSTALLING',
        desiredState: { manifest: manifest() },
        specV2: completedSpecFor(),
        enrollmentCode: 'enrol-1',
      })
      .returning();
    deploymentId = deployment!.id;
    await db.insert(schema.applicationConfigs).values([
      { applicationId, customerId: null, key: 'LOG_LEVEL', value: 'debug', isSecret: false },
      { applicationId, customerId, key: 'LICENSE_KEY', value: '***', isSecret: true },
      { applicationId, customerId, key: 'ENCRYPTION_KEY', value: '***', isSecret: true },
      // Vendor-typed before any install: write-only, so no value can reach a
      // later install — the relay mints one unless the store already has it.
      { applicationId, customerId: null, key: 'JWT_SECRET', value: '***', isSecret: true },
      { applicationId, customerId: null, key: 'OIDC_CLIENT_SECRET', value: '***', isSecret: true },
    ]);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('lists the effective config plus a generated entry for each unconfigured generated key, never a secret value', async () => {
    const [deployment] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId));
    const entries = await buildRelayConfigEntries(db, deployment!, createConfigStore(db));
    const byKey = [...entries].sort((a, b) => a.key.localeCompare(b.key));
    expect(byKey).toEqual([
      // Vendor-typed secrets are write-only: the relay keeps the value if it
      // ever reached the customer's store, and mints an app-internal one
      // otherwise (DEPLOY-013). An external credential is never minted.
      { key: 'ENCRYPTION_KEY', isSecret: true, source: 'customer', generated: true },
      { key: 'JWT_SECRET', isSecret: true, source: 'vendor', generated: true },
      { key: 'LICENSE_KEY', isSecret: true, source: 'customer' },
      { key: 'LOG_LEVEL', isSecret: false, value: 'debug', source: 'vendor' },
      { key: 'OIDC_CLIENT_SECRET', isSecret: true, source: 'vendor' },
      { key: 'SESSION_SECRET', isSecret: true, source: 'generated', generated: true },
    ]);
    expect(JSON.stringify(entries)).not.toContain('***');
  });

  it('marks the INSTALL payload startAfterConfig with a zero task count when configuration waits and a release exists (DEPLOY-009)', async () => {
    const [deployment] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId));
    const [release] = await db
      .insert(schema.releases)
      .values({
        applicationId,
        version: '1.0.0',
        gitSha: 'abc1234',
        imageDigest: '111122223333.dkr.ecr.us-east-1.amazonaws.com/deployz-images@sha256:' + 'a'.repeat(64),
        buildStatus: 'SUCCEEDED',
        releaseStatus: 'READY',
      })
      .returning();

    const payload = await buildInstallPayload(db, deployment!, createConfigStore(db), INSTALLATION_ID);

    expect(payload['startAfterConfig']).toBe(true);
    expect((payload['parameters'] as Record<string, string>)['paramDesiredCount']).toBe('0');
    // Every task family the stack creates is unique to this installation.
    expect((payload['parameters'] as Record<string, string>)['paramTaskFamilySuffix']).toBe('inst0001abcd');
    expect(payload['redisRequired']).toBe(false);
    expect(payload['databaseRequired']).toBe(true);
    // The INSTALL points at the frozen compiled artifact, not a template variant.
    expect(payload['templateUrl']).toBe(
      'https://deployz-templates-us-east-1.s3.us-east-1.amazonaws.com/compiler-v2/' +
        completedSpecFor()['templateHash'] +
        '.json',
    );
    expect(payload['manifest']).toMatchObject({ web: { port: 3000 } });
    // Control-plane-minted identity tags — stable internal ids only, with the
    // selected release named because one exists.
    expect(payload['tags']).toEqual({
      'deployz:managed-by': 'deployz',
      'deployz:deployment-id': deploymentId,
      'deployz:application-id': applicationId,
      'deployz:customer-id': customerId,
      'deployz:vendor-id': organizationId,
      'deployz:release-id': release!.id,
      'deployz:environment': 'production',
    });
  });

  it('refuses the INSTALL payload of an installation-scoped stack without a registered installation', async () => {
    const [deployment] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId));
    await expect(buildInstallPayload(db, deployment!, createConfigStore(db), null)).rejects.toMatchObject({
      statusCode: 409,
      code: 'RELAY_NOT_CONNECTED',
    });
  });

  // The release-id tag omission itself is covered in @deployz/contracts
  // tags.test.ts; an install can no longer reach it without a release.
  it('refuses the INSTALL payload when no release can be selected (never the template default image)', async () => {
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Releaseless',
        repoFullName: 'acme/releaseless',
        repoUrl: 'https://github.com/acme/releaseless',
        defaultBranch: 'main',
        analysisStatus: 'COMPLETE',
      })
      .returning();
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId: application!.id,
        customerId,
        region: 'us-east-1',
        state: 'INSTALLING',
        desiredState: { manifest: manifest([MANIFEST_ENV[0]!]) },
        specV2: completedSpecFor([MANIFEST_ENV[0]!]),
        enrollmentCode: 'enrol-releaseless',
      })
      .returning();

    await expect(buildInstallPayload(db, deployment!, createConfigStore(db), INSTALLATION_ID)).rejects.toMatchObject({
      statusCode: 409,
      code: 'RELEASE_NOT_PUBLISHED',
    });
  });

  it('refuses the INSTALL payload closed when the deployment carries no compiled spec (pre-compiler row)', async () => {
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Specless',
        repoFullName: 'acme/specless',
        repoUrl: 'https://github.com/acme/specless',
        defaultBranch: 'main',
        analysisStatus: 'COMPLETE',
      })
      .returning();
    await db.insert(schema.releases).values({
      applicationId: application!.id,
      version: '1.0.0',
      gitSha: 'abc1234',
      imageDigest: '111122223333.dkr.ecr.us-east-1.amazonaws.com/deployz-images@sha256:' + 'c'.repeat(64),
      buildStatus: 'SUCCEEDED',
      releaseStatus: 'READY',
    });
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId: application!.id,
        customerId,
        region: 'us-east-1',
        state: 'INSTALLING',
        desiredState: { manifest: manifest([MANIFEST_ENV[0]!]) },
        enrollmentCode: 'enrol-specless',
      })
      .returning();

    await expect(buildInstallPayload(db, deployment!, createConfigStore(db), INSTALLATION_ID)).rejects.toMatchObject({
      statusCode: 422,
      code: 'DEPLOYMENT_SPEC_MISSING',
    });
  });

  it('starts the install normally when nothing waits to be configured', async () => {
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Bare',
        repoFullName: 'acme/bare-install',
        repoUrl: 'https://github.com/acme/bare-install',
        defaultBranch: 'main',
        analysisStatus: 'COMPLETE',
      })
      .returning();
    await db.insert(schema.releases).values({
      applicationId: application!.id,
      version: '1.0.0',
      gitSha: 'abc1234',
      imageDigest: '111122223333.dkr.ecr.us-east-1.amazonaws.com/deployz-images@sha256:' + 'b'.repeat(64),
      buildStatus: 'SUCCEEDED',
      releaseStatus: 'READY',
    });
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId: application!.id,
        customerId,
        region: 'us-east-1',
        state: 'INSTALLING',
        desiredState: { manifest: manifest([MANIFEST_ENV[0]!, MANIFEST_ENV[4]!]) },
        specV2: completedSpecFor([MANIFEST_ENV[0]!, MANIFEST_ENV[4]!]),
        enrollmentCode: 'enrol-bare-install',
      })
      .returning();

    const payload = await buildInstallPayload(db, deployment!, createConfigStore(db), INSTALLATION_ID);

    expect(payload['startAfterConfig']).toBeUndefined();
    expect((payload['parameters'] as Record<string, string>)['paramDesiredCount']).toBeUndefined();
  });

  it('queues one CONFIG_UPDATE job per install, with key names only, and reuses it on a replay', async () => {
    const [deployment] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId));
    const store = createConfigStore(db);
    expect(await queuePostInstallConfig(db, deployment!, 'install-job-1', store)).toEqual({ queued: true });
    expect(await queuePostInstallConfig(db, deployment!, 'install-job-1', store)).toEqual({ queued: false });

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(and(eq(schema.deploymentJobs.deploymentId, deploymentId), eq(schema.deploymentJobs.type, 'CONFIG_UPDATE')));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      state: 'REQUESTED',
      idempotencyKey: `${deploymentId}:CONFIG_UPDATE:install:install-job-1`,
      payload: { reason: 'install' },
    });
    expect([...((jobs[0]!.payload as { changedKeys: string[] }).changedKeys)].sort()).toEqual(
      ['ENCRYPTION_KEY', 'JWT_SECRET', 'LICENSE_KEY', 'LOG_LEVEL', 'OIDC_CLIENT_SECRET', 'SESSION_SECRET'],
    );
    expect(JSON.stringify(jobs[0]!.payload)).not.toContain('debug');
  });

  it('a vendor secret with no bound pending-secret value decrypts through vault.readVendorSecret, never through the job payload', async () => {
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Secret delivery app',
        repoFullName: 'acme/secret-delivery',
        repoUrl: 'https://github.com/acme/secret-delivery',
        defaultBranch: 'main',
        analysisStatus: 'COMPLETE',
      })
      .returning();
    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId, name: 'Secret Customer', email: 'secret-customer@example.com' })
      .returning();
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId: application!.id,
        customerId: customer!.id,
        region: 'us-east-1',
        state: 'INSTALLING',
        desiredState: { manifest: manifest([MANIFEST_ENV[4]!]) }, // LOG_LEVEL only — no minted keys to keep this focused
        enrollmentCode: 'enrol-secret-delivery',
      })
      .returning();

    // A vendor-typed secret saved through setConfig (so it is actually
    // encrypted onto application_configs.encrypted_value) BEFORE this install
    // exists — it has no pending-secret vault row (that path is customer-
    // only), so the only way it can ever reach a deployment is the relay's
    // GET /api/relay/config read decrypting it directly.
    const store = createConfigStore(db);
    const cipher = createCipherStub();
    await setConfig(
      application!.id,
      null,
      [{ key: 'API_SECRET', value: 'sk_live_delivered', isSecret: true }],
      createConfigDeps(db, createDrizzlePendingSecretStore(db, cipher), cipher),
    );

    // queuePostInstallConfig never carries secret values — only key names.
    const { queued } = await queuePostInstallConfig(db, deployment!, 'install-job-secret-delivery', store);
    expect(queued).toBe(true);
    const [job] = await db
      .select()
      .from(schema.deploymentJobs)
      .where(
        and(
          eq(schema.deploymentJobs.deploymentId, deployment!.id),
          eq(schema.deploymentJobs.idempotencyKey, `${deployment!.id}:CONFIG_UPDATE:install:install-job-secret-delivery`),
        ),
      );
    expect(job!.payload).toEqual({
      reason: 'install',
      changedKeys: expect.arrayContaining(['API_SECRET']),
    });
    expect(JSON.stringify(job!.payload)).not.toContain('sk_live_delivered');

    // The relay's own read (buildRelayConfigEntries with a vault) is the one
    // place the plaintext surfaces.
    const entries = await buildRelayConfigEntries(db, deployment!, store, {
      async readBound() {
        return undefined; // no customer-scope pending-secret row for this key
      },
      async stampDelivery() {},
      async readVendorSecret(applicationId, key) {
        const values = await listVendorValues(db, applicationId, [key], cipher);
        return values[key];
      },
    });
    expect(entries.find((entry) => entry.key === 'API_SECRET')).toEqual({
      key: 'API_SECRET',
      isSecret: true,
      value: 'sk_live_delivered',
      source: 'vendor',
    });
  });

  it('queues nothing when there is nothing to apply', async () => {
    const [bare] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId: (
          await db
            .insert(schema.customers)
            .values({ organizationId, name: 'Bare', email: 'bare@example.com' })
            .returning()
        )[0]!.id,
        region: 'us-east-1',
        state: 'INSTALLING',
        desiredState: { manifest: manifest([]) },
        enrollmentCode: 'enrol-2',
      })
      .returning();
    // The vendor default LOG_LEVEL still applies to every customer.
    expect(await queuePostInstallConfig(db, bare!, 'install-job-2', createConfigStore(db))).toEqual({ queued: true });

    const [noConfigApp] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Bare app',
        repoFullName: 'acme/bare',
        repoUrl: 'https://github.com/acme/bare',
        defaultBranch: 'main',
        analysisStatus: 'COMPLETE',
      })
      .returning();
    const [nothing] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId: noConfigApp!.id,
        customerId: bare!.customerId,
        region: 'us-east-1',
        state: 'INSTALLING',
        desiredState: { manifest: manifest([]) },
        enrollmentCode: 'enrol-3',
      })
      .returning();
    expect(await queuePostInstallConfig(db, nothing!, 'install-job-3', createConfigStore(db))).toEqual({ queued: false });
  });

  it('mints only SECRET_KEY/UTILS_SECRET for an outline manifest produced by the fixed analyser (DEPLOY-030)', async () => {
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Outline',
        repoFullName: 'acme/outline',
        repoUrl: 'https://github.com/acme/outline',
        defaultBranch: 'main',
        analysisStatus: 'COMPLETE',
      })
      .returning();
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId: application!.id,
        customerId,
        region: 'us-east-1',
        state: 'INSTALLING',
        desiredState: { manifest: manifest(OUTLINE_MANIFEST_ENV) },
        enrollmentCode: 'enrol-outline',
      })
      .returning();

    const entries = await buildRelayConfigEntries(db, deployment!, createConfigStore(db));

    expect([...entries].sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: 'SECRET_KEY', isSecret: true, source: 'generated', generated: true },
      { key: 'UTILS_SECRET', isSecret: true, source: 'generated', generated: true },
    ]);
  });

  it('derives S3 region/endpoint from the deployment region, below any explicit value', async () => {
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Media',
        repoFullName: 'acme/media',
        repoUrl: 'https://github.com/acme/media',
        defaultBranch: 'main',
        analysisStatus: 'COMPLETE',
      })
      .returning();
    const read = ['read in src/env.ts'];
    const variables = [
      { key: 'S3_REGION', required: true, secret: false, source: read, classification: 'deployz_managed' },
      { key: 'S3_ENDPOINT', required: true, secret: false, source: read, classification: 'deployz_managed' },
      { key: 'S3_ACCESS_KEY_ID', required: true, secret: true, source: read, classification: 'customer_required' },
      { key: 'S3_PUBLIC_BASE_URL', required: true, secret: false, source: read, classification: 'customer_required' },
    ];
    const withStorage = { ...manifest(variables), storage: { required: true, envBindings: [] } };
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId: application!.id,
        customerId,
        region: 'eu-west-1',
        state: 'INSTALLING',
        desiredState: { manifest: withStorage },
        enrollmentCode: 'enrol-media',
      })
      .returning();

    const derived = await buildRelayConfigEntries(db, deployment!, createConfigStore(db));
    expect([...derived].sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: 'S3_ENDPOINT', isSecret: false, value: 'https://s3.eu-west-1.amazonaws.com', source: 'derived' },
      { key: 'S3_REGION', isSecret: false, value: 'eu-west-1', source: 'derived' },
    ]);

    // An explicit vendor or customer value always wins over the derived one.
    await db.insert(schema.applicationConfigs).values([
      { applicationId: application!.id, customerId: null, key: 'S3_ENDPOINT', value: 'https://vendor.example', isSecret: false },
      { applicationId: application!.id, customerId, key: 'S3_REGION', value: 'us-west-2', isSecret: false },
    ]);
    const explicit = await buildRelayConfigEntries(db, deployment!, createConfigStore(db));
    expect([...explicit].sort((a, b) => a.key.localeCompare(b.key))).toMatchObject([
      { key: 'S3_ENDPOINT', value: 'https://vendor.example', source: 'vendor' },
      { key: 'S3_REGION', value: 'us-west-2', source: 'customer' },
    ]);
    expect(explicit).toHaveLength(2);

    // Nothing is derived when the deployment provisions no storage.
    const [noStorage] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId: application!.id,
        customerId,
        region: 'eu-west-1',
        state: 'INSTALLING',
        desiredState: { manifest: manifest(variables) },
        enrollmentCode: 'enrol-media-2',
      })
      .returning();
    const none = await buildRelayConfigEntries(db, noStorage!, createConfigStore(db));
    expect(none.some((entry) => entry.source === 'derived')).toBe(false);
  });

  it('derives the application public URL from the default HTTPS URL, below any explicit value', async () => {
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Wiki',
        repoFullName: 'acme/wiki',
        repoUrl: 'https://github.com/acme/wiki',
        defaultBranch: 'main',
        analysisStatus: 'COMPLETE',
      })
      .returning();
    const read = ['read in src/server.ts'];
    const variables = [
      { key: 'APP_URL', required: true, secret: false, source: read, classification: 'deployz_managed' },
      { key: 'NEXTAUTH_URL', required: true, secret: false, source: read, classification: 'deployz_managed' },
      { key: 'OPENAI_BASE_URL', required: true, secret: false, source: read, classification: 'customer_required' },
      { key: 'NEXT_PUBLIC_APP_URL', required: true, secret: false, source: read, classification: 'customer_required' },
    ];
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId: application!.id,
        customerId,
        region: 'eu-west-1',
        state: 'INSTALLING',
        desiredState: { manifest: manifest(variables) },
        enrollmentCode: 'enrol-wiki',
      })
      .returning();

    const url = `https://d-${deployment!.id}.deployz.dev`;
    const derived = await buildRelayConfigEntries(db, deployment!, createConfigStore(db));
    expect([...derived].sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: 'APP_URL', isSecret: false, value: url, source: 'derived' },
      { key: 'NEXTAUTH_URL', isSecret: false, value: url, source: 'derived' },
    ]);

    // The URL uses the running control plane's prefix and zone.
    const staging = await buildRelayConfigEntries(
      db,
      { ...deployment!, defaultHostname: { prefix: 's-', zone: 'deployz.test' } },
      createConfigStore(db),
    );
    expect(staging.find((entry) => entry.key === 'APP_URL')?.value).toBe(`https://s-${deployment!.id}.deployz.test`);

    // An explicit vendor value always wins over the derived one.
    await db
      .insert(schema.applicationConfigs)
      .values({ applicationId: application!.id, customerId: null, key: 'APP_URL', value: 'https://wiki.example', isSecret: false });
    const explicit = await buildRelayConfigEntries(db, deployment!, createConfigStore(db));
    expect([...explicit].sort((a, b) => a.key.localeCompare(b.key))).toMatchObject([
      { key: 'APP_URL', value: 'https://wiki.example', source: 'vendor' },
      { key: 'NEXTAUTH_URL', value: url, source: 'derived' },
    ]);
  });
});

describe('relay config follows the vendor decision for each key', () => {
  let client: PGlite | undefined;
  let db: Db;
  let applicationId: string;
  let customerId: string;
  let otherCustomerId: string;
  const organizationId = 'org-install-config-ownership';
  const variables = [
    { key: 'DATABASE_URL', required: true, secret: false, source: [], classification: 'deployz_managed' },
    { key: 'API_URL', required: true, secret: false, source: [], classification: 'customer_required' },
    { key: 'FEATURE_FLAG', required: false, secret: false, source: [], classification: 'optional' },
    { key: 'LOG_LEVEL', required: false, secret: false, source: [], classification: 'optional' },
    { key: 'SUPPORT_EMAIL', required: false, secret: false, source: [], classification: 'optional' },
    { key: 'INTERNAL_TOKEN', required: true, secret: true, source: [], purpose: 'internal_secret', classification: 'customer_required' },
    { key: 'OPENSHIP_ACME_EAB_HMAC_KEY', required: false, secret: true, source: [], purpose: 'internal_secret', classification: 'optional' },
  ];

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    await db.insert(schema.organization).values({ id: organizationId, name: 'Acme', slug: organizationId });
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'App',
        repoFullName: 'acme/ownership',
        repoUrl: 'https://github.com/acme/ownership',
        defaultBranch: 'main',
        analysisStatus: 'COMPLETE',
        environmentSettings: [
          // Was vendor-provided, now the customer's: the old vendor value must not reach anyone.
          { key: 'API_URL', stage: 'runtime', required: true, secret: false, provider: 'customer' },
          // Was customer-provided, now the vendor's: vendor default plus vendor overrides.
          { key: 'LOG_LEVEL', stage: 'runtime', required: false, secret: false, provider: 'vendor' },
          // Now not needed: no saved value is delivered.
          { key: 'FEATURE_FLAG', stage: 'runtime', required: false, secret: false, provider: 'none' },
          // Managed by Deployz: a stale vendor value never overrides the managed binding.
          { key: 'DATABASE_URL', stage: 'runtime', required: true, secret: false, provider: 'deployz' },
          { key: 'INTERNAL_TOKEN', stage: 'runtime', required: true, secret: true, provider: 'deployz' },
        ],
      })
      .returning();
    applicationId = application!.id;
    const customers = await db
      .insert(schema.customers)
      .values([
        { organizationId, name: 'Customer A', email: 'a@example.com' },
        { organizationId, name: 'Customer B', email: 'b@example.com' },
      ])
      .returning();
    customerId = customers[0]!.id;
    otherCustomerId = customers[1]!.id;
    await db.insert(schema.applicationConfigs).values([
      { applicationId, customerId: null, key: 'API_URL', value: 'https://stale-vendor.example.com', isSecret: false },
      { applicationId, customerId: null, key: 'FEATURE_FLAG', value: 'on', isSecret: false },
      { applicationId, customerId: null, key: 'DATABASE_URL', value: 'postgres://localhost/dev', isSecret: false },
      { applicationId, customerId: null, key: 'LOG_LEVEL', value: 'info', isSecret: false },
      { applicationId, customerId: null, key: 'SUPPORT_EMAIL', value: 'help@vendor.example.com', isSecret: false },
      { applicationId, customerId, key: 'API_URL', value: 'https://a.example.com', isSecret: false },
      { applicationId, customerId, key: 'LOG_LEVEL', value: 'debug', isSecret: false },
      { applicationId, customerId: otherCustomerId, key: 'API_URL', value: 'https://b.example.com', isSecret: false },
    ]);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  function deploymentFor(customer: string) {
    return { applicationId, customerId: customer, region: 'us-east-1', desiredState: { manifest: manifest(variables) } };
  }

  it('delivers each key only from its current source, per customer', async () => {
    const a = await buildRelayConfigEntries(db, deploymentFor(customerId), createConfigStore(db));
    expect(Object.fromEntries(a.map((entry) => [entry.key, entry.value ?? (entry.generated ? 'generated' : null)]))).toEqual({
      API_URL: 'https://a.example.com',
      LOG_LEVEL: 'debug',
      SUPPORT_EMAIL: 'help@vendor.example.com',
      INTERNAL_TOKEN: 'generated',
    });
    const b = await buildRelayConfigEntries(db, deploymentFor(otherCustomerId), createConfigStore(db));
    expect(Object.fromEntries(b.map((entry) => [entry.key, entry.value ?? (entry.generated ? 'generated' : null)]))).toEqual({
      API_URL: 'https://b.example.com',
      LOG_LEVEL: 'info',
      SUPPORT_EMAIL: 'help@vendor.example.com',
      INTERNAL_TOKEN: 'generated',
    });
  });
});
