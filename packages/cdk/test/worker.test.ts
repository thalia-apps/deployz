import { PGlite } from '@electric-sql/pglite';
import { and, eq, inArray } from 'drizzle-orm';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createConfigDeps, setConfig } from '@deployz/api/config';
import type { JevFailureShadowParams } from '@deployz/api/jev-shadow';
import { createCipherStub, createDrizzlePendingSecretStore } from '@deployz/api/pending-secrets';

import {
  buildFailureDetail,
  handleMessage,
  loadBuildVariablesFromDb,
  normalizeBuildId,
  recordBuildResult,
  resolveBuildContext,
  sweepRelayLiveness,
  sweepStuckBuilds,
  sweepStuckJobs,
  type CodeBuildStateChangeEvent,
  type WorkerDeps,
} from '../src/lambda/worker.js';

// The worker is what makes a queued job actually happen. Every case below is
// a step that silently did nothing before it existed: an analysis that never
// ran, a release that stayed BUILDING for ever, a config write that never
// reached the relay.
describe('worker handler', () => {
  let client: PGlite | undefined;
  let db: Db;
  let organizationId: string;
  let applicationId: string;
  let customerId: string;

  const started: { projectName: string; environmentVariables: { name: string; value: string }[] }[] =
    [];
  const uploaded: { bucket: string; key: string }[] = [];
  const analysed: string[] = [];

  function deps(): WorkerDeps {
    return {
      db: db,
      fetchFn: (async () => ({
        status: 200,
        headers: { get: () => null },
        json: async () => ({ token: 'ghs_test', expires_at: '2099-01-01T00:00:00Z' }),
        arrayBuffer: async () => new TextEncoder().encode('tarball').buffer,
        text: async () => '',
      })) as unknown as WorkerDeps['fetchFn'],
      s3: {
        async putObject(params) {
          uploaded.push({ bucket: params.bucket, key: params.key });
        },
      },
      async startBuild(input) {
        started.push(input);
        // StartBuild resolves the short "project:uuid" form, not an ARN.
        return `deployz-build:started-${started.length}`;
      },
      async batchGetBuilds() {
        return [];
      },
      async runAnalysis(id) {
        analysed.push(id);
      },
      async loadBuildVariables() {
        return [];
      },
    };
  }

  beforeAll(async () => {
    process.env.GITHUB_APP_ID = 'test-app';
    // A real key: minting the installation token signs an RS256 JWT, so a
    // placeholder string fails inside node:crypto rather than in our code.
    process.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
    process.env.SOURCE_BUCKET = 'source-bucket';
    process.env.BUILD_PROJECT_NAME = 'deployz-build';

    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);

    const [org] = await db
      .insert(schema.organization)
      .values({ id: 'org-worker', name: 'Worker Org', slug: 'worker-org-1234' })
      .returning();
    organizationId = org!.id;
    // The build mints a token only for an active binding of the organization.
    await db.insert(schema.githubInstallations).values({
      id: '4242',
      organizationId,
      accountLogin: 'acme',
      accountType: 'Organization',
    });

    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Docs App',
        githubInstallationId: '4242',
        repoFullName: 'acme/docs',
        repoUrl: 'https://github.com/acme/docs',
        defaultBranch: 'main',
        detectedMetadata: { dockerfilePath: 'docker/Dockerfile' },
      })
      .returning();
    applicationId = application!.id;

    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId, name: 'Acme', email: 'ops@acme.test' })
      .returning();
    customerId = customer!.id;
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  async function insertRelease(version: string) {
    const [release] = await db
      .insert(schema.releases)
      .values({ applicationId, version, gitSha: 'abc1230' })
      .returning();
    return release!;
  }

  it('runs the analysis for an ANALYSE_APPLICATION message', async () => {
    await handleMessage(deps(), { type: 'ANALYSE_APPLICATION', applicationId }, 'msg-1');
    expect(analysed).toEqual([applicationId]);
  });

  it('uploads the source and starts a build for BUILD_RELEASE', async () => {
    const release = await insertRelease('v1.0.0');

    await handleMessage(deps(), { type: 'BUILD_RELEASE', releaseId: release.id }, 'msg-2');

    expect(uploaded).toEqual([
      { bucket: 'source-bucket', key: `build-source/${applicationId}/${release.id}/abc1230.tar.gz` },
    ]);
    const build = started[0];
    expect(build?.projectName).toBe('deployz-build');
    // The build must be able to find the release again when it finishes, and
    // must build the Dockerfile the analyser actually found.
    expect(build?.environmentVariables).toContainEqual({ name: 'RELEASE_ID', value: release.id });
    expect(build?.environmentVariables).toContainEqual({
      name: 'DOCKERFILE_PATH',
      value: 'docker/Dockerfile',
    });
    // `docker/Dockerfile` is the repo-root-context convention: the build
    // must be told to build from `.`, not the Dockerfile's own directory.
    expect(build?.environmentVariables).toContainEqual({ name: 'BUILD_CONTEXT', value: '.' });

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.buildStatus).toBe('BUILDING');

    // build_started lands with the BUILDING pin, keyed by the release id.
    const startedEvents = await db
      .select()
      .from(schema.eventLogs)
      .where(and(eq(schema.eventLogs.eventType, 'release.build_started'), eq(schema.eventLogs.releaseId, release.id)));
    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0]!.payload).toMatchObject({ schemaVersion: 1, applicationId });
  });

  it('namespaces RELEASE_VERSION as <applicationId>-<version> (DZ-AUDIT-002)', async () => {
    const release = await insertRelease('v1.3.0');
    const prevLength = started.length;

    await handleMessage(deps(), { type: 'BUILD_RELEASE', releaseId: release.id }, 'msg-2d');

    const build = started[prevLength];
    expect(build?.environmentVariables).toContainEqual({
      name: 'RELEASE_VERSION',
      value: `${applicationId}-v1.3.0`,
    });
  });

  it('produces distinct RELEASE_VERSION for two apps releasing the same version (DZ-AUDIT-002)', async () => {
    const [app1] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'App A',
        githubInstallationId: '4242',
        repoFullName: 'acme/app-a',
        repoUrl: 'https://github.com/acme/app-a',
        defaultBranch: 'main',
        detectedMetadata: { dockerfilePath: 'Dockerfile' },
      })
      .returning();
    const [app2] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'App B',
        githubInstallationId: '4242',
        repoFullName: 'acme/app-b',
        repoUrl: 'https://github.com/acme/app-b',
        defaultBranch: 'main',
        detectedMetadata: { dockerfilePath: 'Dockerfile' },
      })
      .returning();

    const [release1] = await db
      .insert(schema.releases)
      .values({ applicationId: app1!.id, version: '1.0.0', gitSha: 'abc2010' })
      .returning();
    const [release2] = await db
      .insert(schema.releases)
      .values({ applicationId: app2!.id, version: '1.0.0', gitSha: 'abc2020' })
      .returning();

    const prevLength = started.length;

    await handleMessage(deps(), { type: 'BUILD_RELEASE', releaseId: release1!.id }, 'msg-2e');
    await handleMessage(deps(), { type: 'BUILD_RELEASE', releaseId: release2!.id }, 'msg-2f');

    const build1 = started[prevLength];
    const build2 = started[prevLength + 1];

    expect(build1?.environmentVariables).toContainEqual({
      name: 'RELEASE_VERSION',
      value: `${app1!.id}-1.0.0`,
    });
    expect(build2?.environmentVariables).toContainEqual({
      name: 'RELEASE_VERSION',
      value: `${app2!.id}-1.0.0`,
    });
    expect(
      build1?.environmentVariables.find((v) => v.name === 'RELEASE_VERSION')?.value,
    ).not.toBe(
      build2?.environmentVariables.find((v) => v.name === 'RELEASE_VERSION')?.value,
    );
  });

  it('does not pass BUILD_CONTEXT for a non-`docker/` Dockerfile path', async () => {
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Backend App',
        githubInstallationId: '4242',
        repoFullName: 'acme/backend',
        repoUrl: 'https://github.com/acme/backend',
        defaultBranch: 'main',
        detectedMetadata: { dockerfilePath: 'backend/Dockerfile' },
      })
      .returning();
    const [release] = await db
      .insert(schema.releases)
      .values({ applicationId: application!.id, version: 'v1.1.0', gitSha: 'abc1240' })
      .returning();

    await handleMessage(deps(), { type: 'BUILD_RELEASE', releaseId: release!.id }, 'msg-2b');

    const build = started[started.length - 1];
    expect(build?.environmentVariables).toContainEqual({
      name: 'DOCKERFILE_PATH',
      value: 'backend/Dockerfile',
    });
    expect(build?.environmentVariables.some((v) => v.name === 'BUILD_CONTEXT')).toBe(false);
  });

  it('builds from vendor manifest overrides (dockerfilePath/buildContext) when the vendor corrected them (§11.1)', async () => {
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Monorepo App',
        githubInstallationId: '4242',
        repoFullName: 'acme/monorepo',
        repoUrl: 'https://github.com/acme/monorepo',
        defaultBranch: 'main',
        // Detection guessed the root Dockerfile; the vendor corrected it to the
        // app under apps/api with a repo-root build context. The release build
        // must follow the corrected manifest, or it builds the wrong image.
        detectedMetadata: {
          dockerfilePath: 'Dockerfile',
          manifestOverrides: { dockerfilePath: 'apps/api/Dockerfile', buildContext: '.' },
        },
      })
      .returning();
    const [release] = await db
      .insert(schema.releases)
      .values({ applicationId: application!.id, version: 'v1.2.0', gitSha: 'abc1250' })
      .returning();

    await handleMessage(deps(), { type: 'BUILD_RELEASE', releaseId: release!.id }, 'msg-2c');

    const build = started[started.length - 1];
    expect(build?.environmentVariables).toContainEqual({
      name: 'DOCKERFILE_PATH',
      value: 'apps/api/Dockerfile',
    });
    expect(build?.environmentVariables).toContainEqual({ name: 'BUILD_CONTEXT', value: '.' });
  });

  it('builds from the repository root when analysis found a root-context Dockerfile under a subdirectory', async () => {
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Turbo App',
        githubInstallationId: '4242',
        repoFullName: 'acme/turbo',
        repoUrl: 'https://github.com/acme/turbo',
        defaultBranch: 'main',
        detectedMetadata: { dockerfilePath: 'apps/web/Dockerfile', dockerfileBuildContext: '.' },
      })
      .returning();
    const [release] = await db
      .insert(schema.releases)
      .values({ applicationId: application!.id, version: 'v1.3.0', gitSha: 'abc1260' })
      .returning();

    await handleMessage(deps(), { type: 'BUILD_RELEASE', releaseId: release!.id }, 'msg-2d');

    const build = started[started.length - 1];
    expect(build?.environmentVariables).toContainEqual({ name: 'DOCKERFILE_PATH', value: 'apps/web/Dockerfile' });
    expect(build?.environmentVariables).toContainEqual({ name: 'BUILD_CONTEXT', value: '.' });
  });

  it('builds the detected application stage, and not for an overridden Dockerfile', async () => {
    const insert = async (name: string, detectedMetadata: Record<string, unknown>) => {
      const [application] = await db
        .insert(schema.applications)
        .values({
          organizationId,
          name,
          githubInstallationId: '4242',
          repoFullName: `acme/${name}`,
          repoUrl: `https://github.com/acme/${name}`,
          defaultBranch: 'main',
          detectedMetadata,
        })
        .returning();
      const [release] = await db
        .insert(schema.releases)
        .values({ applicationId: application!.id, version: 'v1.0.0', gitSha: 'abc1234' })
        .returning();
      await handleMessage(deps(), { type: 'BUILD_RELEASE', releaseId: release!.id }, `msg-${name}`);
      return started[started.length - 1]?.environmentVariables ?? [];
    };

    expect(await insert('kuma', { dockerfilePath: 'docker/dockerfile', dockerfileBuildTarget: 'release' })).toContainEqual({
      name: 'BUILD_TARGET',
      value: 'release',
    });
    const overridden = await insert('kuma-override', {
      dockerfilePath: 'docker/dockerfile',
      dockerfileBuildTarget: 'release',
      manifestOverrides: { dockerfilePath: 'Dockerfile' },
    });
    expect(overridden.some((variable) => variable.name === 'BUILD_TARGET')).toBe(false);
    const unsafe = await insert('kuma-unsafe', { dockerfilePath: 'Dockerfile', dockerfileBuildTarget: 'release; rm -rf /' });
    expect(unsafe.some((variable) => variable.name === 'BUILD_TARGET')).toBe(false);
  });

  it('fails the release when the application has no GitHub installation', async () => {
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Unlinked',
        repoFullName: 'acme/unlinked',
        repoUrl: 'https://github.com/acme/unlinked',
        defaultBranch: 'main',
      })
      .returning();
    const [release] = await db
      .insert(schema.releases)
      .values({ applicationId: application!.id, version: 'v0.1.0', gitSha: 'def4560' })
      .returning();

    await handleMessage(deps(), { type: 'BUILD_RELEASE', releaseId: release!.id }, 'msg-3');

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release!.id));
    expect(row?.buildStatus).toBe('FAILED');
    expect(row?.releaseStatus).toBe('FAILED');

    const failed = await db
      .select()
      .from(schema.eventLogs)
      .where(and(eq(schema.eventLogs.eventType, 'release.build_failed'), eq(schema.eventLogs.releaseId, release!.id)));
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ schemaVersion: 1, applicationId: application!.id, failureCode: 'build_failed' });
  });

  // A build queued before the organization disconnected GitHub starts after
  // it: the worker checks the connection when the build starts, mints no
  // token, and settles the release as failed with the reason.
  it('fails a queued build without a token once GitHub is disconnected', async () => {
    await db.insert(schema.githubInstallations).values({
      id: '5353',
      organizationId,
      accountLogin: 'acme-disconnected',
      accountType: 'Organization',
      status: 'disconnected',
    });
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Disconnected',
        githubInstallationId: '5353',
        repoFullName: 'acme/disconnected',
        repoUrl: 'https://github.com/acme/disconnected',
        defaultBranch: 'main',
      })
      .returning();
    const [release] = await db
      .insert(schema.releases)
      .values({ applicationId: application!.id, version: 'v0.2.0', gitSha: 'def4561' })
      .returning();
    const fetched: string[] = [];
    const startedBefore = started.length;

    await handleMessage(
      {
        ...deps(),
        fetchFn: (async (url: string) => {
          fetched.push(url);
          throw new Error('should never be called');
        }) as unknown as WorkerDeps['fetchFn'],
      },
      { type: 'BUILD_RELEASE', releaseId: release!.id },
      'msg-disconnected',
    );

    expect(fetched).toEqual([]);
    expect(started).toHaveLength(startedBefore);
    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release!.id));
    expect(row?.releaseStatus).toBe('FAILED');
    expect(row?.failureReason).toBe('GitHub is disconnected for this organization. Reconnect GitHub to continue.');
  });

  it('§31 env setup: passes vendor build-stage variables as their own CodeBuild env vars, named by DEPLOYZ_BUILD_ARG_NAMES', async () => {
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Build Args App',
        githubInstallationId: '4242',
        repoFullName: 'acme/build-args',
        repoUrl: 'https://github.com/acme/build-args',
        defaultBranch: 'main',
        environmentSettings: [
          { key: 'BUILD_TIME_FLAG', stage: 'build', provider: 'vendor', required: false, secret: false },
          { key: 'BUILD_TIME_SECRET', stage: 'build', provider: 'vendor', required: false, secret: true },
          // Runtime-stage vendor settings never become build args.
          { key: 'RUNTIME_ONLY', stage: 'runtime', provider: 'vendor', required: false, secret: false },
          // A reserved name is dropped, not forwarded.
          { key: 'AWS_REGION', stage: 'build', provider: 'vendor', required: false, secret: false },
        ],
      })
      .returning();

    const cipher = createCipherStub();
    await setConfig(
      application!.id,
      null,
      [
        { key: 'BUILD_TIME_FLAG', value: 'enabled', isSecret: false },
        { key: 'BUILD_TIME_SECRET', value: 'sk_build_secret', isSecret: true },
      ],
      createConfigDeps(db, createDrizzlePendingSecretStore(db, cipher), cipher),
    );

    const [release] = await db
      .insert(schema.releases)
      .values({ applicationId: application!.id, version: 'v1.0.0', gitSha: 'b0a1d2e' })
      .returning();

    const buildArgsDeps: WorkerDeps = {
      ...deps(),
      loadBuildVariables: (buildDb, applicationId) => loadBuildVariablesFromDb(buildDb, applicationId, createCipherStub()),
    };
    await handleMessage(buildArgsDeps, { type: 'BUILD_RELEASE', releaseId: release!.id }, 'msg-build-args');

    const build = started[started.length - 1];
    expect(build?.environmentVariables).toContainEqual({ name: 'BUILD_TIME_FLAG', value: 'enabled' });
    expect(build?.environmentVariables).toContainEqual({ name: 'BUILD_TIME_SECRET', value: 'sk_build_secret' });
    expect(build?.environmentVariables.some((v) => v.name === 'RUNTIME_ONLY')).toBe(false);
    expect(build?.environmentVariables.some((v) => v.name === 'AWS_REGION')).toBe(false);
    const namesVar = build?.environmentVariables.find((v) => v.name === 'DEPLOYZ_BUILD_ARG_NAMES');
    expect(namesVar?.value.split(' ').sort()).toEqual(['BUILD_TIME_FLAG', 'BUILD_TIME_SECRET']);
  });

  it('loadBuildVariablesFromDb returns nothing for an application with no build/vendor settings', async () => {
    const values = await loadBuildVariablesFromDb(db, applicationId, createCipherStub());
    expect(values).toEqual([]);
  });

  describe('resolveBuildContext', () => {
    it('returns "." for a top-level docker/ Dockerfile', () => {
      expect(resolveBuildContext('docker/Dockerfile')).toBe('.');
    });

    it('returns undefined for a root Dockerfile', () => {
      expect(resolveBuildContext('Dockerfile')).toBeUndefined();
    });

    it('returns undefined for a Dockerfile in another subdirectory', () => {
      expect(resolveBuildContext('backend/Dockerfile')).toBeUndefined();
    });
  });

  it('creates a relay job per deployment for CONFIG_UPDATE', async () => {
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        // A state a relay can actually act on — pre-install and removed
        // deployments are skipped by the fanout (see configUpdate).
        state: 'HEALTHY',
        installationId: randomUUID(),
        // Single-use enrollment code the bootstrap stack carries; NOT NULL,
        // because a deployment no relay can ever enrol with is not a
        // deployment.
        enrollmentCode: randomUUID(),
      })
      .returning();

    const message = {
      type: 'CONFIG_UPDATE' as const,
      customerId,
      changedKeys: ['API_KEY', 'DATABASE_URL'],
      // Newly-entered secret values ride the job payload transiently so the
      // relay can persist them into the customer's Secrets Manager.
      secrets: [{ key: 'DATABASE_URL', value: 'postgres://relay-transport-only' }],
    };
    await handleMessage(deps(), message, 'msg-4');
    // A redelivery of the same message must not create a second job.
    await handleMessage(deps(), message, 'msg-4');

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment!.id));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.type).toBe('CONFIG_UPDATE');
    // The durable payload carries the transport values exactly once here;
    // `GET /api/relay/commands` serves them to the relay and scrubs the
    // stored row in the same request (see `redactClaimedPayload`).
    expect(jobs[0]?.payload).toEqual({
      changedKeys: ['API_KEY', 'DATABASE_URL'],
      secrets: [{ key: 'DATABASE_URL', value: 'postgres://relay-transport-only' }],
    });

    // A deployment no relay can act on gets no job: nothing is enrolled
    // before install, nothing remains during/after removal.
    await db
      .update(schema.deployments)
      .set({ state: 'DELETED' })
      .where(eq(schema.deployments.id, deployment!.id));
    await handleMessage(deps(), { ...message, changedKeys: ['OTHER'] }, 'msg-5');
    const after = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment!.id));
    expect(after).toHaveLength(1);
  });

  it("sends a CONFIG_UPDATE only to the saved application's deployments of that customer", async () => {
    // Its own customer and applications: a running deployment of the shared
    // application would be picked up by the build-completion tests below.
    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId, name: 'Two apps', email: 'two-apps@acme.test' })
      .returning();
    const applications = await db
      .insert(schema.applications)
      .values(
        ['acme/scoped-a', 'acme/scoped-b'].map((repo) => ({
          organizationId,
          name: repo,
          repoFullName: repo,
          repoUrl: `https://github.com/${repo}`,
        })),
      )
      .returning();
    const deployments = await db
      .insert(schema.deployments)
      .values(
        applications.map((application) => ({
          organizationId,
          applicationId: application.id,
          customerId: customer!.id,
          region: 'us-east-1',
          state: 'HEALTHY' as const,
          installationId: randomUUID(),
          enrollmentCode: randomUUID(),
        })),
      )
      .returning();

    await handleMessage(
      deps(),
      {
        type: 'CONFIG_UPDATE',
        customerId: customer!.id,
        applicationId: applications[0]!.id,
        secrets: [{ key: 'STRIPE_SECRET_KEY', value: 'sk_app_a_only' }],
        removedKeys: ['LOG_LEVEL'],
      },
      'msg-app-scoped',
    );

    const jobsFor = async (deploymentId: string) =>
      db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.deploymentId, deploymentId));
    expect(await jobsFor(deployments[0]!.id)).toHaveLength(1);
    // The other application never receives this application's secret value or removal.
    expect(await jobsFor(deployments[1]!.id)).toHaveLength(0);
  });

  function buildEvent(
    releaseId: string,
    status: string,
    digest?: string,
    buildId?: string,
  ): CodeBuildStateChangeEvent {
    return {
      'detail-type': 'CodeBuild Build State Change',
      detail: {
        'build-status': status,
        ...(buildId ? { 'build-id': buildId } : {}),
        'additional-information': {
          environment: { 'environment-variables': [{ name: 'RELEASE_ID', value: releaseId }] },
        },
        ...(digest
          ? { 'exported-environment-variables': [{ name: 'IMAGE_DIGEST', value: digest }] }
          : {}),
      },
    };
  }

  const DIGEST_A = 'acme/docs@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const DIGEST_B = 'acme/docs@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  async function pinBuild(releaseId: string, buildId: string): Promise<void> {
    await db
      .update(schema.releases)
      .set({ currentBuildId: buildId, buildStatus: 'BUILDING', releaseStatus: 'BUILDING' })
      .where(eq(schema.releases.id, releaseId));
  }

  it('records the image digest when a build succeeds', async () => {
    const release = await insertRelease('v2.0.0');
    const digest =
      'acme/docs@sha256:1111111111111111111111111111111111111111111111111111111111111111';

    await recordBuildResult(
      db,
      buildEvent(release.id, 'SUCCEEDED', digest),
    );

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.imageDigest).toBe(digest);
    expect(row?.buildStatus).toBe('SUCCEEDED');
    expect(row?.releaseStatus).toBe('READY');

    const completed = await db
      .select()
      .from(schema.eventLogs)
      .where(and(eq(schema.eventLogs.eventType, 'release.build_completed'), eq(schema.eventLogs.releaseId, release.id)));
    expect(completed).toHaveLength(1);
    expect(completed[0]!.payload).toMatchObject({ schemaVersion: 1, applicationId });
    expect(completed[0]!.result).toBe('success');
  });

  it('records the digest when the event nests exported vars under additional-information (real EventBridge shape)', async () => {
    const release = await insertRelease('v2.0.5');
    const digest =
      'acme/docs@sha256:5555555555555555555555555555555555555555555555555555555555555555';

    await recordBuildResult(db, {
      'detail-type': 'CodeBuild Build State Change',
      detail: {
        'build-status': 'SUCCEEDED',
        'additional-information': {
          environment: { 'environment-variables': [{ name: 'RELEASE_ID', value: release.id }] },
          'exported-environment-variables': [{ name: 'IMAGE_DIGEST', value: digest }],
        },
      },
    });

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.imageDigest).toBe(digest);
    expect(row?.releaseStatus).toBe('READY');
  });

  it('fails the release when a build fails', async () => {
    const release = await insertRelease('v2.1.0');

    await recordBuildResult(db, buildEvent(release.id, 'FAILED'));

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.buildStatus).toBe('FAILED');
    expect(row?.imageDigest).toBeNull();
    expect(row?.failureReason).toBe('CodeBuild reported FAILED');

    // The event row carries the stable code, never the failure-reason text.
    const failed = await db
      .select()
      .from(schema.eventLogs)
      .where(and(eq(schema.eventLogs.eventType, 'release.build_failed'), eq(schema.eventLogs.releaseId, release.id)));
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ schemaVersion: 1, applicationId, failureCode: 'build_failed' });
    expect(failed[0]!.result).toBe('failure');
  });

  // A metered base-image pull says nothing about the repository. Recorded as
  // a plain build failure it blames an application that builds perfectly
  // well an hour later — the false verdict the corpus run collected twice.
  it('records build_registry_rate_limited when the registry metered the pull', async () => {
    const release = await insertRelease('v2.1.6');

    await recordBuildResult(db, {
      ...buildEvent(release.id, 'FAILED'),
      detail: {
        ...buildEvent(release.id, 'FAILED').detail,
        'additional-information': {
          environment: { 'environment-variables': [{ name: 'RELEASE_ID', value: release.id }] },
          phases: [
            {
              'phase-type': 'BUILD',
              'phase-status': 'FAILED',
              'phase-context': [
                'COMMAND_EXECUTION_ERROR: Error while executing command: if [ "$(cat /tmp/deployz-build-outcome)" = rate_limited ]; then echo "Docker Hub rate limit (HTTP 429) blocked the base image download" >&2; exit 1; fi. Reason: exit status 1',
              ],
            },
          ],
        },
      },
    });

    const failed = await db
      .select()
      .from(schema.eventLogs)
      .where(and(eq(schema.eventLogs.eventType, 'release.build_failed'), eq(schema.eventLogs.releaseId, release.id)));
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ failureCode: 'build_registry_rate_limited' });
  });

  // The rate-limit branch must not swallow ordinary build errors — the
  // buildspec keeps the two on separate commands for exactly this reason.
  it('still records build_failed for an ordinary image-build error', async () => {
    const release = await insertRelease('v2.1.7');

    await recordBuildResult(db, {
      ...buildEvent(release.id, 'FAILED'),
      detail: {
        ...buildEvent(release.id, 'FAILED').detail,
        'additional-information': {
          environment: { 'environment-variables': [{ name: 'RELEASE_ID', value: release.id }] },
          phases: [
            {
              'phase-type': 'BUILD',
              'phase-status': 'FAILED',
              'phase-context': [
                'COMMAND_EXECUTION_ERROR: Error while executing command: if [ "$(cat /tmp/deployz-build-outcome)" != ok ]; then echo "The image build did not produce an image" >&2; exit 1; fi. Reason: exit status 1',
              ],
            },
          ],
        },
      },
    });

    const failed = await db
      .select()
      .from(schema.eventLogs)
      .where(and(eq(schema.eventLogs.eventType, 'release.build_failed'), eq(schema.eventLogs.releaseId, release.id)));
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ failureCode: 'build_failed' });
  });

  it('records build_cancelled when CodeBuild reports STOPPED', async () => {
    const release = await insertRelease('v2.1.5');

    await recordBuildResult(db, buildEvent(release.id, 'STOPPED'));

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.releaseStatus).toBe('FAILED');
    const failed = await db
      .select()
      .from(schema.eventLogs)
      .where(and(eq(schema.eventLogs.eventType, 'release.build_failed'), eq(schema.eventLogs.releaseId, release.id)));
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ failureCode: 'build_cancelled' });
  });

  // A success with no digest is not a usable release: §21 pins deployments to
  // the digest, so "SUCCEEDED, digest unknown" must not read as ready.
  it('fails the release when a successful build reports no digest', async () => {
    const release = await insertRelease('v2.2.0');

    await recordBuildResult(db, buildEvent(release.id, 'SUCCEEDED'));

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.buildStatus).toBe('FAILED');
  });

  // ── Build-attempt correlation ────────────────────────────────────────────

  it('ignores a stale failure arriving after the current build succeeded', async () => {
    const release = await insertRelease('v3.0.0');
    await pinBuild(release.id, 'build-new');
    await recordBuildResult(db, buildEvent(release.id, 'SUCCEEDED', DIGEST_A, 'build-new'));

    await recordBuildResult(db, buildEvent(release.id, 'FAILED', undefined, 'build-old'));

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.releaseStatus).toBe('READY');
    expect(row?.imageDigest).toBe(DIGEST_A);
  });

  it('ignores a stale success arriving after the current build failed', async () => {
    const release = await insertRelease('v3.1.0');
    await pinBuild(release.id, 'build-new');
    await recordBuildResult(db, buildEvent(release.id, 'FAILED', undefined, 'build-new'));

    await recordBuildResult(db, buildEvent(release.id, 'SUCCEEDED', DIGEST_A, 'build-old'));

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.releaseStatus).toBe('FAILED');
    expect(row?.imageDigest).toBeNull();
  });

  it('is idempotent on a duplicate success for the same build', async () => {
    const release = await insertRelease('v3.2.0');
    await pinBuild(release.id, 'build-1');
    await recordBuildResult(db, buildEvent(release.id, 'SUCCEEDED', DIGEST_A, 'build-1'));

    await recordBuildResult(db, buildEvent(release.id, 'SUCCEEDED', DIGEST_B, 'build-1'));

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.releaseStatus).toBe('READY');
    expect(row?.imageDigest).toBe(DIGEST_A);
  });

  it('is idempotent on a duplicate failure for the same build', async () => {
    const release = await insertRelease('v3.3.0');
    await pinBuild(release.id, 'build-1');
    await recordBuildResult(db, buildEvent(release.id, 'FAILED', undefined, 'build-1'));
    await recordBuildResult(db, buildEvent(release.id, 'FAILED', undefined, 'build-1'));

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.releaseStatus).toBe('FAILED');
  });

  it('applies the current successful build', async () => {
    const release = await insertRelease('v3.4.0');
    await pinBuild(release.id, 'build-current');

    await recordBuildResult(db, buildEvent(release.id, 'SUCCEEDED', DIGEST_B, 'build-current'));

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.releaseStatus).toBe('READY');
    expect(row?.imageDigest).toBe(DIGEST_B);
  });

  it('applies the current failed build', async () => {
    const release = await insertRelease('v3.5.0');
    await pinBuild(release.id, 'build-current');

    await recordBuildResult(db, buildEvent(release.id, 'FAILED', undefined, 'build-current'));

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.releaseStatus).toBe('FAILED');
    expect(row?.failureReason).toBe('CodeBuild reported FAILED');
  });

  // StartBuild resolves the short "project:uuid" form of a build id, but the
  // EventBridge state-change event's build-id is the full ARN wrapping that
  // same id. Without normalizing both sides, every real completion event
  // reads as stale and the release never leaves BUILDING (audit blocker N2).
  it('reaches READY from a real build-then-event round trip, where the event carries the ARN form', async () => {
    const release = await insertRelease('v3.6.0');

    await handleMessage(deps(), { type: 'BUILD_RELEASE', releaseId: release.id }, 'msg-n2');
    const [building] = await db
      .select()
      .from(schema.releases)
      .where(eq(schema.releases.id, release.id));
    // buildRelease pins the release to startBuild's short-form return value.
    expect(building?.currentBuildId).not.toContain('arn:');

    const shortBuildId = building!.currentBuildId!;
    const arnBuildId = `arn:aws:codebuild:us-east-1:151955775369:build/${shortBuildId}`;
    await recordBuildResult(db, buildEvent(release.id, 'SUCCEEDED', DIGEST_A, arnBuildId));

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.releaseStatus).toBe('READY');
    expect(row?.imageDigest).toBe(DIGEST_A);
  });

  it('a redelivered BUILD_RELEASE never rebuilds a READY release', async () => {
    const release = await insertRelease('v3.7.0');
    await db
      .update(schema.releases)
      .set({ buildStatus: 'SUCCEEDED', releaseStatus: 'READY', imageDigest: DIGEST_A, currentBuildId: 'build-done' })
      .where(eq(schema.releases.id, release.id));
    const startedBefore = started.length;

    await handleMessage(deps(), { type: 'BUILD_RELEASE', releaseId: release.id }, 'msg-redelivered');

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(started.length).toBe(startedBefore);
    expect(row?.releaseStatus).toBe('READY');
    expect(row?.imageDigest).toBe(DIGEST_A);
    expect(row?.currentBuildId).toBe('build-done');
  });

  it('a redelivered BUILD_RELEASE does not start a second build for a running one', async () => {
    const release = await insertRelease('v3.8.0');
    await handleMessage(deps(), { type: 'BUILD_RELEASE', releaseId: release.id }, 'msg-first');
    const [first] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    const startedAfterFirst = started.length;

    await handleMessage(deps(), { type: 'BUILD_RELEASE', releaseId: release.id }, 'msg-first');

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(started.length).toBe(startedAfterFirst);
    expect(row?.currentBuildId).toBe(first?.currentBuildId);
  });

  // ── DZ-AUDIT-007: deployment state after build ──────────────────────────────

  it('DZ-AUDIT-007: build failure does NOT flip HEALTHY→UPDATE_AVAILABLE (no READY release)', async () => {
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        state: 'HEALTHY',
        installationId: `inst-${randomUUID()}`,
        enrollmentCode: randomUUID(),
      })
      .returning();
    const [release] = await db
      .insert(schema.releases)
      .values({
        applicationId,
        version: `fail-v-${randomUUID().slice(0, 4)}`,
        gitSha: 'abc',
        releaseStatus: 'BUILDING',
        buildStatus: 'BUILDING',
      })
      .returning();

    // Simulate a CodeBuild FAILED event for this release.
    const event: CodeBuildStateChangeEvent = {
      source: 'aws.codebuild',
      'detail-type': 'CodeBuild Build State Change',
      detail: {
        'build-status': 'FAILED',
        'build-id': `deployz-build:${release!.id}`,
        'exported-environment-variables': [{ name: 'RELEASE_ID', value: release!.id }],
        'additional-information': {
          'exported-environment-variables': [{ name: 'RELEASE_ID', value: release!.id }],
          environment: { 'environment-variables': [] },
          phases: [],
        },
      },
    };
    await recordBuildResult(db, event);

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment!.id));
    // Must stay HEALTHY — the build failed, no READY release exists.
    expect(dep?.state).toBe('HEALTHY');
  });

  it('DZ-AUDIT-007: build success flips HEALTHY→UPDATE_AVAILABLE', async () => {
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        state: 'HEALTHY',
        installationId: `inst-${randomUUID()}`,
        enrollmentCode: randomUUID(),
      })
      .returning();
    const [release] = await db
      .insert(schema.releases)
      .values({
        applicationId,
        version: `ok-v-${randomUUID().slice(0, 4)}`,
        gitSha: 'abc',
        releaseStatus: 'BUILDING',
        buildStatus: 'BUILDING',
      })
      .returning();

    const event: CodeBuildStateChangeEvent = {
      source: 'aws.codebuild',
      'detail-type': 'CodeBuild Build State Change',
      detail: {
        'build-status': 'SUCCEEDED',
        'build-id': `deployz-build:${release!.id}`,
        'exported-environment-variables': [
          { name: 'RELEASE_ID', value: release!.id },
          { name: 'IMAGE_DIGEST', value: `sha256:${'a'.repeat(64)}` },
        ],
        'additional-information': {
          'exported-environment-variables': [
            { name: 'RELEASE_ID', value: release!.id },
            { name: 'IMAGE_DIGEST', value: `sha256:${'a'.repeat(64)}` },
          ],
          environment: { 'environment-variables': [] },
          phases: [],
        },
      },
    };
    await recordBuildResult(db, event);

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment!.id));
    // The build succeeded: HEALTHY deployments of this app become UPDATE_AVAILABLE.
    expect(dep?.state).toBe('UPDATE_AVAILABLE');
  });

  it('an older release that finishes building late never flips a deployment already on a newer one', async () => {
    const [older] = await db
      .insert(schema.releases)
      .values({
        applicationId,
        version: `old-v-${randomUUID().slice(0, 4)}`,
        gitSha: 'abc',
        releaseStatus: 'BUILDING',
        buildStatus: 'BUILDING',
        currentBuildId: 'build-late',
        createdAt: new Date(Date.now() - 3_600_000),
      })
      .returning();
    const [newer] = await db
      .insert(schema.releases)
      .values({
        applicationId,
        version: `new-v-${randomUUID().slice(0, 4)}`,
        gitSha: 'def',
        releaseStatus: 'READY',
        buildStatus: 'SUCCEEDED',
        imageDigest: DIGEST_B,
      })
      .returning();
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        state: 'HEALTHY',
        currentReleaseId: newer!.id,
        installationId: `inst-${randomUUID()}`,
        enrollmentCode: randomUUID(),
      })
      .returning();

    await recordBuildResult(db, buildEvent(older!.id, 'SUCCEEDED', DIGEST_A, 'build-late'));

    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment!.id));
    expect(dep?.state).toBe('HEALTHY');
  });
});

describe('normalizeBuildId', () => {
  it('strips an ARN down to the short "project:uuid" form', () => {
    expect(
      normalizeBuildId('arn:aws:codebuild:us-east-1:151955775369:build/deployz-build:some-uuid'),
    ).toBe('deployz-build:some-uuid');
  });

  it('leaves an already-short build id unchanged', () => {
    expect(normalizeBuildId('deployz-build:some-uuid')).toBe('deployz-build:some-uuid');
  });

  it('returns input unchanged when the ":build/" marker is absent', () => {
    expect(normalizeBuildId('some-opaque-id')).toBe('some-opaque-id');
  });
});

describe('buildFailureDetail', () => {
  const event = (phases: unknown): CodeBuildStateChangeEvent =>
    ({
      'detail-type': 'CodeBuild Build State Change',
      detail: {
        'build-status': 'FAILED',
        'additional-information': { phases },
      },
    }) as CodeBuildStateChangeEvent;

  it('returns the first failed phase with its context', () => {
    expect(
      buildFailureDetail(
        event([
          { 'phase-type': 'BUILD', 'phase-status': 'SUCCEEDED', 'phase-context': [': '] },
          {
            'phase-type': 'POST_BUILD',
            'phase-status': 'FAILED',
            'phase-context': [
              'COMMAND_EXECUTION_ERROR: Error while executing command: docker push …. Reason: exit status 1',
            ],
          },
        ]),
      ),
    ).toBe(
      'POST_BUILD: COMMAND_EXECUTION_ERROR: Error while executing command: docker push …. Reason: exit status 1',
    );
  });

  it('returns null when no failed phase carries a context message', () => {
    expect(
      buildFailureDetail(
        event([{ 'phase-type': 'BUILD', 'phase-status': 'FAILED', 'phase-context': [] }]),
      ),
    ).toBeNull();
    expect(buildFailureDetail(event(undefined))).toBeNull();
  });
});

// ── Stuck-job watchdog (Phase 7) ──────────────────────────────────────────

describe('sweepStuckJobs', () => {
  let client: PGlite | undefined;
  let db: Db;
  let organizationId: string;
  let applicationId: string;
  let customerId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);

    const [org] = await db
      .insert(schema.organization)
      .values({ id: 'org-watchdog', name: 'Watchdog Org', slug: 'watchdog-org' })
      .returning();
    organizationId = org!.id;

    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'App',
        repoFullName: 'acme/watchdog-app',
        repoUrl: 'https://github.com/acme/watchdog-app',
        defaultBranch: 'main',
      })
      .returning();
    applicationId = application!.id;

    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId, name: 'Cust', email: 'watchdog@example.test' })
      .returning();
    customerId = customer!.id;
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  async function seedJobAndDeployment(
    type: 'INSTALL' | 'DEPLOY_RELEASE' | 'ROLLBACK' | 'RESTART' | 'CONFIG_UPDATE' | 'DESTROY',
    state: 'REQUESTED' | 'QUEUED' | 'WAITING' | 'RUNNING' | 'SUCCEEDED',
    startedMinutesAgo: number,
    lastProgressMinutesAgo: number | null,
    options: {
      relayStatus?: 'CONNECTED' | 'DISCONNECTED' | 'UNKNOWN';
      reconcileCount?: number;
    } = {},
  ): Promise<{ jobId: string; deploymentId: string }> {
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        state: 'UPDATING',
        relayStatus: options.relayStatus ?? 'UNKNOWN',
        installationId: `inst-${randomUUID()}`,
        enrollmentCode: randomUUID(),
      })
      .returning();

    const started = new Date(Date.now() - startedMinutesAgo * 60 * 1000);
    const [job] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: deployment!.id,
        type,
        state,
        idempotencyKey: `watchdog:${randomUUID()}`,
        payload: {},
        startedAt: started,
        reconcileCount: options.reconcileCount ?? 0,
        ...(lastProgressMinutesAgo !== null
          ? { lastProgressAt: new Date(Date.now() - lastProgressMinutesAgo * 60 * 1000) }
          : {}),
      })
      .returning();

    return { jobId: job!.id, deploymentId: deployment!.id };
  }

  it('parks a stale job WAITING when the relay is quiet — never a false FAILED', async () => {
    const { jobId, deploymentId } = await seedJobAndDeployment('DEPLOY_RELEASE', 'RUNNING', 30, 25);
    const settled = await sweepStuckJobs(db);
    expect(settled).toBeGreaterThanOrEqual(1);

    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
    expect(job?.state).toBe('WAITING');

    // The deployment is untouched: the operation may have finished in AWS
    // and a returning relay resumes from its checkpoint.
    const [deployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deploymentId));
    expect(deployment?.state).toBe('UPDATING');

    const events = await db.select().from(schema.eventLogs).where(eq(schema.eventLogs.jobId, jobId));
    expect(events.some((e) => e.eventType === 'operation.waiting_for_relay')).toBe(true);
  });

  it('fails a WAITING job as RELAY_DISCONNECTED once the relay grace elapses', async () => {
    // 20-minute timeout + 24h grace, all long exceeded.
    const { jobId, deploymentId } = await seedJobAndDeployment(
      'DEPLOY_RELEASE',
      'WAITING',
      26 * 60,
      25 * 60,
      { relayStatus: 'DISCONNECTED' },
    );
    await sweepStuckJobs(db);

    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
    expect(job?.state).toBe('FAILED');
    expect(job?.failureCode).toBe('RELAY_DISCONNECTED');
    expect(job?.result).toMatchObject({ timeout: true });

    const [deployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deploymentId));
    expect(deployment?.state).toBe('FAILED');
  });

  it('re-offers a stuck job to a live relay before ever failing it', async () => {
    const { jobId, deploymentId } = await seedJobAndDeployment('DEPLOY_RELEASE', 'RUNNING', 30, 25, {
      relayStatus: 'CONNECTED',
    });
    await sweepStuckJobs(db);

    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
    expect(job?.state).toBe('REQUESTED');
    expect(job?.reconcileCount).toBe(1);

    const [deployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deploymentId));
    expect(deployment?.state).toBe('UPDATING');

    const events = await db.select().from(schema.eventLogs).where(eq(schema.eventLogs.jobId, jobId));
    expect(events.some((e) => e.eventType === 'operation.requeued')).toBe(true);
  });

  it('re-offers a RUNNING job past its runtime bound even while heartbeats keep it fresh (orphaned invocation)', async () => {
    // A relay invocation died between the AWS mutation and its checkpoint
    // write: heartbeats keep refreshing lastProgressAt, so only the runtime
    // clock can see the job is going nowhere.
    const { jobId } = await seedJobAndDeployment('INSTALL', 'RUNNING', 100, 1, {
      relayStatus: 'CONNECTED',
    });
    await sweepStuckJobs(db);

    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
    expect(job?.state).toBe('REQUESTED');
    expect(job?.reconcileCount).toBe(1);
  });

  it('keeps a deployment with a running release live when a day-2 job finally fails', async () => {
    const { jobId, deploymentId } = await seedJobAndDeployment('DEPLOY_RELEASE', 'RUNNING', 30, 25, {
      relayStatus: 'CONNECTED',
      reconcileCount: 3,
    });
    const [release] = await db
      .insert(schema.releases)
      .values({
        applicationId,
        version: `w-${randomUUID().slice(0, 8)}`,
        gitSha: 'abc',
        releaseStatus: 'READY',
        buildStatus: 'SUCCEEDED',
      })
      .returning();
    await db
      .update(schema.deployments)
      .set({ currentReleaseId: release!.id })
      .where(eq(schema.deployments.id, deploymentId));

    await sweepStuckJobs(db);

    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
    expect(job?.state).toBe('FAILED');
    expect(job?.result).toMatchObject({ timeout: true, reconcileAttempts: 3 });
    // The previous release is still serving: the deployment returns to a
    // live state instead of FAILED (no newer READY release here -> HEALTHY).
    const [deployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deploymentId));
    expect(deployment?.state).toBe('HEALTHY');
  });

  it('keeps a deployment with a SUCCEEDED install but no deployed release live when a day-2 job finally fails (CANARY-008)', async () => {
    const { jobId, deploymentId } = await seedJobAndDeployment('DEPLOY_RELEASE', 'RUNNING', 30, 25, {
      relayStatus: 'CONNECTED',
      reconcileCount: 3,
    });
    // A first install runs the template-pinned image: the INSTALL job
    // SUCCEEDED, but no release row was ever deployed, so currentReleaseId
    // stays null — the same shape as a real install of the template image.
    await db.insert(schema.deploymentJobs).values({
      deploymentId,
      type: 'INSTALL',
      state: 'SUCCEEDED',
      idempotencyKey: `watchdog:${randomUUID()}`,
      payload: {},
    });
    await db.insert(schema.releases).values({
      applicationId,
      version: `w-${randomUUID().slice(0, 8)}`,
      gitSha: 'abc',
      releaseStatus: 'READY',
      buildStatus: 'SUCCEEDED',
    });

    await sweepStuckJobs(db);

    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
    expect(job?.state).toBe('FAILED');

    const [deployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deploymentId));
    // A running install counts even with currentReleaseId still null: the
    // deployment must not be marked FAILED, and the READY release counts as
    // an available update.
    expect(deployment?.state).toBe('UPDATE_AVAILABLE');
    expect(deployment?.currentReleaseId).toBeNull();
  });

  it('leaves the deployment state alone when a CONFIG_UPDATE finally fails', async () => {
    const { jobId, deploymentId } = await seedJobAndDeployment('CONFIG_UPDATE', 'RUNNING', 30, 25, {
      relayStatus: 'CONNECTED',
      reconcileCount: 3,
    });
    await sweepStuckJobs(db);
    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
    expect(job?.state).toBe('FAILED');
    const [deployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deploymentId));
    expect(deployment?.state).toBe('UPDATING');
  });

  it('records an operation.timeout event with the job evidence', async () => {
    const { jobId } = await seedJobAndDeployment('ROLLBACK', 'RUNNING', 30, 25, {
      relayStatus: 'CONNECTED',
      reconcileCount: 3,
    });
    await sweepStuckJobs(db);

    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.jobId, jobId));
    const timeout = events.find((e) => e.eventType === 'operation.timeout');
    expect(timeout).toBeDefined();
    expect(timeout?.payload).toMatchObject({
      jobType: 'ROLLBACK',
      relayStatus: expect.any(String),
      reconcileCount: 3,
    });
  });

  it('does not sweep a job whose progress is recent', async () => {
    const { jobId } = await seedJobAndDeployment('DEPLOY_RELEASE', 'RUNNING', 10, 5);
    const before = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.id, jobId));
    await sweepStuckJobs(db);
    const after = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.id, jobId));
    expect(after[0]?.state).toBe(before[0]?.state);
  });

  it('does not sweep an INSTALL inside its 60-minute budget', async () => {
    const { jobId } = await seedJobAndDeployment('INSTALL', 'RUNNING', 45, 40);
    await sweepStuckJobs(db);
    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
    expect(job?.state).toBe('RUNNING');
  });

  it('parks an INSTALL past its 60-minute budget on a quiet relay', async () => {
    const { jobId } = await seedJobAndDeployment('INSTALL', 'RUNNING', 75, 70);
    await sweepStuckJobs(db);
    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
    expect(job?.state).toBe('WAITING');
  });

  it('never sweeps a finished job', async () => {
    const { jobId } = await seedJobAndDeployment('DEPLOY_RELEASE', 'SUCCEEDED', 120, 120);
    await sweepStuckJobs(db);
    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
    expect(job?.state).toBe('SUCCEEDED');
  });

  // A timed-out DESTROY only ever means the relay is dead (heartbeats refresh
  // lastProgressAt while it lives). Failing it here would strand the
  // deployment in FAILED with no disconnect path; force-complete owns the
  // dead-relay DESTROY instead.
  it('never fails a DESTROY, however stale', async () => {
    const { jobId, deploymentId } = await seedJobAndDeployment('DESTROY', 'RUNNING', 120, 120);
    await sweepStuckJobs(db);
    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
    expect(job?.state).toBe('RUNNING');
    const [deployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deploymentId));
    expect(deployment?.state).toBe('UPDATING');
  });

  it('re-offers a stale DESTROY to a live relay (but never fails it)', async () => {
    const { jobId } = await seedJobAndDeployment('DESTROY', 'RUNNING', 120, 120, {
      relayStatus: 'CONNECTED',
      reconcileCount: 3,
    });
    await sweepStuckJobs(db);
    // Re-offers exhausted: a DESTROY still never fails from the watchdog —
    // the vendor's force-complete escape hatch owns the dead-end case.
    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
    expect(job?.state).toBe('RUNNING');
  });

  // Phase 5 §9.3: CONFIGURE_DOMAIN/REMOVE_DOMAIN previously had no watchdog
  // entry, so a stuck domain job idled in RUNNING forever. Now it is failed
  // with a clear code, the DEPLOYMENT is untouched (separate lifecycle),
  // and the domain row carries the error so the next cycle can retry.
  it('fails a CONFIGURE_DOMAIN stuck past the window with DOMAIN_OPERATION_TIMEOUT, leaving the deployment alone', async () => {
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        state: 'HEALTHY',
        relayStatus: 'CONNECTED',
        installationId: `inst-${randomUUID()}`,
        enrollmentCode: randomUUID(),
      })
      .returning();
    const [domain] = await db
      .insert(schema.customDomains)
      .values({
        deploymentId: deployment!.id,
        organizationId,
        hostname: 'example.com',
        status: 'CONFIGURING',
        createdBy: 'system',
      })
      .returning();

    const started = new Date(Date.now() - 95 * 60 * 1000);
    const [job] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: deployment!.id,
        type: 'CONFIGURE_DOMAIN',
        state: 'RUNNING',
        idempotencyKey: `domain:${randomUUID()}`,
        payload: { hostname: 'example.com', domainId: domain!.id },
        startedAt: started,
        lastProgressAt: new Date(Date.now() - 65 * 60 * 1000),
        reconcileCount: 3,
      })
      .returning();

    await sweepStuckJobs(db);

    const [jobRow] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, job!.id));
    expect(jobRow?.state).toBe('FAILED');
    expect(jobRow?.failureCode).toBe('DOMAIN_OPERATION_TIMEOUT');
    expect(jobRow?.result).toMatchObject({ timeout: true });

    const [deploymentRow] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment!.id));
    expect(deploymentRow?.state).toBe('HEALTHY');

    const [domainRow] = await db.select().from(schema.customDomains).where(eq(schema.customDomains.id, domain!.id));
    expect(domainRow?.lastError).toBe('DOMAIN_OPERATION_TIMEOUT');
  });

  // ── DZ-AUDIT-006: watchdog must not overwrite a job the result route settled ──

  it('DZ-AUDIT-006: does not overwrite a job already settled by the result route', async () => {
    const { jobId } = await seedJobAndDeployment('DEPLOY_RELEASE', 'RUNNING', 30, 25, {
      relayStatus: 'CONNECTED',
      reconcileCount: 3,
    });
    // Simulate the result route settling the job first.
    await db
      .update(schema.deploymentJobs)
      .set({ state: 'SUCCEEDED', finishedAt: new Date() })
      .where(eq(schema.deploymentJobs.id, jobId));

    await sweepStuckJobs(db);

    // Must still be SUCCEEDED — the watchdog must not flip it back.
    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
    expect(job?.state).toBe('SUCCEEDED');
  });

  // ── DZ-AUDIT-011: zero-task install timeout must settle FAILED, not HEALTHY ──

  it('DZ-AUDIT-011: a zero-task INSTALL (startAfterConfig) that times out in the watchdog settles FAILED', async () => {
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        state: 'INSTALLING',
        relayStatus: 'CONNECTED',
        installationId: `inst-${randomUUID()}`,
        enrollmentCode: randomUUID(),
      })
      .returning();
    const started = new Date(Date.now() - 100 * 60 * 1000);
    const [job] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: deployment!.id,
        type: 'INSTALL',
        state: 'RUNNING',
        idempotencyKey: `watchdog:${randomUUID()}`,
        payload: { startAfterConfig: true },
        startedAt: started,
        reconcileCount: 3,
      })
      .returning();

    await sweepStuckJobs(db);

    const [j] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, job!.id));
    expect(j?.state).toBe('FAILED');
    // hasStartedInstall returns false for a zero-task install with no deploy,
    // so deploymentStateAfterFailedJob sees hasCurrentRelease=false → FAILED.
    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment!.id));
    expect(dep?.state).toBe('FAILED');
  });
});

// ── Relay-liveness sweep (persisted DISCONNECTED) ─────────────────────────
describe('sweepRelayLiveness', () => {
  let client: PGlite | undefined;
  let db: Db;
  let organizationId: string;
  let applicationId: string;
  let customerId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);

    const [org] = await db
      .insert(schema.organization)
      .values({ id: 'org-liveness', name: 'Liveness Org', slug: 'liveness-org' })
      .returning();
    organizationId = org!.id;

    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'App',
        repoFullName: 'acme/liveness-app',
        repoUrl: 'https://github.com/acme/liveness-app',
        defaultBranch: 'main',
      })
      .returning();
    applicationId = application!.id;

    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId, name: 'Cust', email: 'liveness@example.test' })
      .returning();
    customerId = customer!.id;
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  async function seedRelay(overrides: {
    relayStatus: 'CONNECTED' | 'DISCONNECTED' | 'UNKNOWN';
    lastHealthMinutesAgo: number | null;
    relayBoundMinutesAgo?: number | null;
  }): Promise<string> {
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        state: 'HEALTHY',
        installationId: `inst-${randomUUID()}`,
        enrollmentCode: randomUUID(),
        relayStatus: overrides.relayStatus,
        ...(overrides.lastHealthMinutesAgo !== null
          ? { lastHealthAt: new Date(Date.now() - overrides.lastHealthMinutesAgo * 60 * 1000) }
          : {}),
        ...(overrides.relayBoundMinutesAgo !== undefined
          ? { relayBoundAt: new Date(Date.now() - overrides.relayBoundMinutesAgo * 60 * 1000) }
          : {}),
      })
      .returning();
    return deployment!.id;
  }

  it('persists DISCONNECTED once the check-in window is missed', async () => {
    const id = await seedRelay({ relayStatus: 'CONNECTED', lastHealthMinutesAgo: 30 });
    await sweepRelayLiveness(db);
    const [row] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, id));
    expect(row?.relayStatus).toBe('DISCONNECTED');
  });

  it('keeps a CONNECTED relay whose last check-in is recent', async () => {
    const id = await seedRelay({ relayStatus: 'CONNECTED', lastHealthMinutesAgo: 5 });
    await sweepRelayLiveness(db);
    const [row] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, id));
    expect(row?.relayStatus).toBe('CONNECTED');
  });

  it('counts a registered-but-never-reporting relay from relayBoundAt', async () => {
    const stale = await seedRelay({ relayStatus: 'CONNECTED', lastHealthMinutesAgo: null, relayBoundMinutesAgo: 60 });
    const fresh = await seedRelay({ relayStatus: 'CONNECTED', lastHealthMinutesAgo: null, relayBoundMinutesAgo: 5 });
    await sweepRelayLiveness(db);
    const rows = await db
      .select()
      .from(schema.deployments)
      .where(inArray(schema.deployments.id, [stale, fresh]));
    const byId = new Map(rows.map((row) => [row.id, row.relayStatus]));
    expect(byId.get(stale)).toBe('DISCONNECTED');
    expect(byId.get(fresh)).toBe('CONNECTED');
  });

  it('never touches UNKNOWN or already-DISCONNECTED rows', async () => {
    const unknown = await seedRelay({ relayStatus: 'UNKNOWN', lastHealthMinutesAgo: 60 });
    const disconnected = await seedRelay({ relayStatus: 'DISCONNECTED', lastHealthMinutesAgo: 60 });
    const swept = await sweepRelayLiveness(db);
    expect(swept).toBe(0);
    const rows = await db
      .select()
      .from(schema.deployments)
      .where(inArray(schema.deployments.id, [unknown, disconnected]));
    const byId = new Map(rows.map((row) => [row.id, row.relayStatus]));
    expect(byId.get(unknown)).toBe('UNKNOWN');
    expect(byId.get(disconnected)).toBe('DISCONNECTED');
  });
});

// ── Stuck-build watchdog (audit blocker N2) ───────────────────────────────
//
// A missed or lost CodeBuild state-change event otherwise leaves a release
// BUILDING forever — nothing else ever moves it on. sweepStuckBuilds asks
// CodeBuild directly once a release has gone quiet past the timeout.
describe('sweepStuckBuilds', () => {
  let client: PGlite | undefined;
  let db: Db;
  let applicationId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);

    const [org] = await db
      .insert(schema.organization)
      .values({ id: 'org-build-watchdog', name: 'Build Watchdog Org', slug: 'build-watchdog-org' })
      .returning();

    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId: org!.id,
        name: 'App',
        repoFullName: 'acme/build-watchdog-app',
        repoUrl: 'https://github.com/acme/build-watchdog-app',
        defaultBranch: 'main',
      })
      .returning();
    applicationId = application!.id;
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  async function insertStuckRelease(version: string, minutesAgo: number, buildId: string) {
    const [release] = await db
      .insert(schema.releases)
      .values({
        applicationId,
        version,
        gitSha: 'abc1230',
        currentBuildId: buildId,
        buildStatus: 'BUILDING',
        releaseStatus: 'BUILDING',
        updatedAt: new Date(Date.now() - minutesAgo * 60 * 1000),
      })
      .returning();
    return release!;
  }

  function depsWithBuilds(
    builds: {
      id: string;
      buildStatus: string;
      exportedEnvironmentVariables?: { name: string; value: string }[];
    }[],
  ): WorkerDeps {
    return {
      db,
      fetchFn: (async () => {
        throw new Error('not used by sweepStuckBuilds');
      }) as unknown as WorkerDeps['fetchFn'],
      s3: { async putObject() {} },
      async startBuild() {
        return null;
      },
      async batchGetBuilds() {
        return builds;
      },
      async runAnalysis() {},
      async loadBuildVariables() {
        return [];
      },
    };
  }

  it('moves a stuck BUILDING release to READY when CodeBuild reports SUCCEEDED', async () => {
    const release = await insertStuckRelease('sb-1.0.0', 35, 'deployz-build:stuck-1');
    const digest = `acme/watchdog@sha256:${'c'.repeat(64)}`;

    const swept = await sweepStuckBuilds(
      depsWithBuilds([
        {
          id: 'deployz-build:stuck-1',
          buildStatus: 'SUCCEEDED',
          exportedEnvironmentVariables: [{ name: 'IMAGE_DIGEST', value: digest }],
        },
      ]),
    );

    expect(swept).toBe(1);
    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.releaseStatus).toBe('READY');
    expect(row?.imageDigest).toBe(digest);

    const completed = await db
      .select()
      .from(schema.eventLogs)
      .where(and(eq(schema.eventLogs.eventType, 'release.build_completed'), eq(schema.eventLogs.releaseId, release.id)));
    expect(completed).toHaveLength(1);
  });

  it('fails a stuck BUILDING release when CodeBuild reports FAILED', async () => {
    const release = await insertStuckRelease('sb-1.1.0', 35, 'deployz-build:stuck-2');

    const swept = await sweepStuckBuilds(
      depsWithBuilds([{ id: 'deployz-build:stuck-2', buildStatus: 'FAILED' }]),
    );

    expect(swept).toBe(1);
    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.releaseStatus).toBe('FAILED');

    const failed = await db
      .select()
      .from(schema.eventLogs)
      .where(and(eq(schema.eventLogs.eventType, 'release.build_failed'), eq(schema.eventLogs.releaseId, release.id)));
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ failureCode: 'build_failed' });
  });

  it('leaves a release untouched when it has not yet timed out', async () => {
    const release = await insertStuckRelease('sb-1.2.0', 5, 'deployz-build:fresh');

    const swept = await sweepStuckBuilds(depsWithBuilds([]));

    expect(swept).toBe(0);
    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.releaseStatus).toBe('BUILDING');
  });

  it('fails a stuck release with a clear reason when CodeBuild no longer knows the build', async () => {
    const release = await insertStuckRelease('sb-1.3.0', 35, 'deployz-build:vanished');

    const swept = await sweepStuckBuilds(depsWithBuilds([]));

    expect(swept).toBe(1);
    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.releaseStatus).toBe('FAILED');
    expect(row?.failureReason).toMatch(/no longer has a record/i);

    const failed = await db
      .select()
      .from(schema.eventLogs)
      .where(and(eq(schema.eventLogs.eventType, 'release.build_failed'), eq(schema.eventLogs.releaseId, release.id)));
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ failureCode: 'build_timeout' });
  });

  it('leaves a release untouched while CodeBuild still reports IN_PROGRESS', async () => {
    const release = await insertStuckRelease('sb-1.4.0', 35, 'deployz-build:still-running');

    const swept = await sweepStuckBuilds(
      depsWithBuilds([{ id: 'deployz-build:still-running', buildStatus: 'IN_PROGRESS' }]),
    );

    expect(swept).toBe(0);
    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.releaseStatus).toBe('BUILDING');
  });

  });

// Jev UNKNOWN-failure shadow (PR 3): the watchdog's failStuckJob fires the
// shadow exactly once for the job it settled, with the in-scope evidence
// input — and the stub changes no job, deployment or event transitions.
describe('sweepStuckJobs — Jev UNKNOWN-failure shadow hook', () => {
  let client: PGlite | undefined;
  let db: Db;
  let organizationId: string;
  let applicationId: string;
  let customerId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);

    const [org] = await db
      .insert(schema.organization)
      .values({ id: 'org-jev-watchdog', name: 'Jev Watchdog Org', slug: 'jev-watchdog-org' })
      .returning();
    organizationId = org!.id;

    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'App',
        repoFullName: 'acme/jev-watchdog-app',
        repoUrl: 'https://github.com/acme/jev-watchdog-app',
        defaultBranch: 'main',
      })
      .returning();
    applicationId = application!.id;

    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId, name: 'Cust', email: 'jev-watchdog@example.test' })
      .returning();
    customerId = customer!.id;
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  /** An INSTALL job past every clock with exhausted re-offers → watchdog UNKNOWN. */
  async function seedExhaustedInstall(): Promise<{ jobId: string; deploymentId: string }> {
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        state: 'INSTALLING',
        relayStatus: 'CONNECTED',
        installationId: `inst-${randomUUID()}`,
        enrollmentCode: randomUUID(),
      })
      .returning();

    const [job] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: deployment!.id,
        type: 'INSTALL',
        state: 'RUNNING',
        idempotencyKey: `jev-watchdog:${randomUUID()}`,
        payload: {},
        startedAt: new Date(Date.now() - 200 * 60 * 1000),
        lastProgressAt: new Date(Date.now() - 190 * 60 * 1000),
        reconcileCount: 3,
      })
      .returning();

    return { jobId: job!.id, deploymentId: deployment!.id };
  }

  it('records the UNKNOWN evidence input once and changes no job transitions', async () => {
    const withStub = await seedExhaustedInstall();

    const captured: JevFailureShadowParams[] = [];
    const stub = {
      run: async (params: JevFailureShadowParams): Promise<void> => {
        captured.push(params);
      },
    };

    await sweepStuckJobs(db, new Date(), stub);

    const withoutStub = await seedExhaustedInstall();
    await sweepStuckJobs(db);

    // Both jobs settled identically — the stub changes nothing.
    const rows = await db
      .select()
      .from(schema.deploymentJobs)
      .where(inArray(schema.deploymentJobs.id, [withStub.jobId, withoutStub.jobId]));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const stubbedJob = byId.get(withStub.jobId)!;
    const plainJob = byId.get(withoutStub.jobId)!;
    expect(stubbedJob.state).toBe('FAILED');
    expect(stubbedJob.state).toBe(plainJob.state);
    expect(stubbedJob.failureCode).toBe('UNKNOWN');
    expect(stubbedJob.failureCode).toBe(plainJob.failureCode);
    expect(JSON.stringify(stubbedJob.result)).toBe(JSON.stringify(plainJob.result));

    const [stubbedDeployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, withStub.deploymentId));
    const [plainDeployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, withoutStub.deploymentId));
    expect(stubbedDeployment!.state).toBe('FAILED');
    expect(stubbedDeployment!.state).toBe(plainDeployment!.state);

    const stubbedEvents = await db
      .select()
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.jobId, withStub.jobId));
    const plainEvents = await db
      .select()
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.jobId, withoutStub.jobId));
    expect(stubbedEvents.map((event) => event.eventType)).toEqual(plainEvents.map((event) => event.eventType));

    // The shadow fired exactly once, with the watchdog's evidence input.
    expect(captured).toHaveLength(1);
    const params = captured[0]!;
    expect(params.deploymentId).toBe(withStub.deploymentId);
    expect(params.jobId).toBe(withStub.jobId);
    expect(params.deploymentStage).toBe('INSTALL');
    expect(params.deployzFailureCode).toBe('UNKNOWN');
    expect(params.retryCount).toBe(3);
    expect(typeof params.elapsedMs).toBe('number');
    expect(params.elapsedMs).toBeGreaterThan(0);
    expect(params.relayStatus).toBe('CONNECTED');
    expect(params.failureReason).toContain('reconcileCount=3');
  });
});
