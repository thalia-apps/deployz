import { PGlite } from '@electric-sql/pglite';
import { generateKeyPairSync } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';
import { createConfigDeps, setConfig } from '@deployz/api/config';
import { createCipherStub, createDrizzlePendingSecretStore } from '@deployz/api/pending-secrets';
import { environmentSettingsSchema } from '@deployz/contracts';

import { handleMessage, loadBuildVariablesFromDb, type WorkerDeps } from '../src/lambda/worker.js';

describe('release build inputs', () => {
  let client: PGlite | undefined;
  let db: Db;
  let organizationId: string;

  const started: { projectName: string; environmentVariables: { name: string; value: string }[] }[] = [];
  const fetched: string[] = [];
  const uploaded: { bucket: string; key: string }[] = [];

  function deps(): WorkerDeps {
    return {
      db,
      fetchFn: (async (url: string) => {
        fetched.push(url);
        return {
          status: 200,
          headers: { get: () => null },
          json: async () => ({ token: 'ghs_test', expires_at: '2099-01-01T00:00:00Z' }),
          arrayBuffer: async () => new TextEncoder().encode('tarball').buffer,
          text: async () => '',
        };
      }) as unknown as WorkerDeps['fetchFn'],
      s3: {
        async putObject(params) {
          uploaded.push({ bucket: params.bucket, key: params.key });
        },
      },
      async startBuild(input) {
        started.push(input);
        return `deployz-build:started-${started.length}`;
      },
      async batchGetBuilds() {
        return [];
      },
      async runAnalysis() {},
      loadBuildVariables: (buildDb, applicationId) => loadBuildVariablesFromDb(buildDb, applicationId, createCipherStub()),
    };
  }

  beforeAll(async () => {
    process.env.GITHUB_APP_ID = 'test-app';
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
      .values({ id: 'org-audit', name: 'Audit Org', slug: 'audit-org-1234' })
      .returning();
    organizationId = org!.id;
    // The build mints a token only for an active binding of the organization.
    await db.insert(schema.githubInstallations).values({
      id: '4242',
      organizationId,
      accountLogin: 'acme',
      accountType: 'Organization',
    });
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  async function insertRelease(
    repo: string,
    release: { version: string; gitSha: string },
    detectedMetadata: Record<string, unknown> = { dockerfilePath: 'Dockerfile' },
  ) {
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: `App ${repo}`,
        githubInstallationId: '4242',
        repoFullName: `acme/${repo}`,
        repoUrl: `https://github.com/acme/${repo}`,
        defaultBranch: 'main',
        detectedMetadata,
      })
      .returning();
    const [row] = await db
      .insert(schema.releases)
      .values({ applicationId: application!.id, ...release })
      .returning();
    return { application: application!, release: row! };
  }

  async function failureOf(releaseId: string) {
    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, releaseId));
    return row!;
  }

  it('fails a release whose version could split into Docker arguments', async () => {
    const buildsBefore = started.length;
    const { release } = await insertRelease('version', {
      version: '1.0 --build-arg AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
      gitSha: 'a'.repeat(40),
    });

    await expect(handleMessage(deps(), { type: 'BUILD_RELEASE', releaseId: release.id }, 'v-1')).rejects.toThrow(
      /version is not valid/,
    );

    expect(started).toHaveLength(buildsBefore);
    expect((await failureOf(release.id)).releaseStatus).toBe('FAILED');
  });

  it('fails a release whose gitSha is a branch name, not a commit', async () => {
    const fetchedBefore = fetched.length;
    const { release } = await insertRelease('branch', { version: '1.0.0', gitSha: 'main' });

    await expect(handleMessage(deps(), { type: 'BUILD_RELEASE', releaseId: release.id }, 'v-2')).rejects.toThrow(
      /commit sha/,
    );

    expect(fetched).toHaveLength(fetchedBefore);
    expect((await failureOf(release.id)).releaseStatus).toBe('FAILED');
  });

  it.each([
    ['an absolute Dockerfile path', { dockerfilePath: '/tmp/src/Dockerfile' }],
    ['an absolute build context', { dockerfilePath: 'Dockerfile', buildContext: '/' }],
    ['a build context that leaves the repository', { dockerfilePath: 'Dockerfile', buildContext: '../..' }],
    ['a backslash path', { dockerfilePath: 'a\\..\\Dockerfile' }],
  ])('fails a release with %s in the manifest overrides', async (_name, manifestOverrides) => {
    const buildsBefore = started.length;
    const { release } = await insertRelease(`paths-${_name.length}`, { version: '1.0.0', gitSha: 'abc1234' }, {
      dockerfilePath: 'Dockerfile',
      manifestOverrides,
    });

    await expect(handleMessage(deps(), { type: 'BUILD_RELEASE', releaseId: release.id }, 'v-3')).rejects.toThrow(
      /paths inside the repository/,
    );

    expect(started).toHaveLength(buildsBefore);
  });

  it('starts a build for a valid version and commit', async () => {
    const { application, release } = await insertRelease('valid', { version: '1.0.0', gitSha: 'abc1234' });

    await handleMessage(deps(), { type: 'BUILD_RELEASE', releaseId: release.id }, 'v-4');

    const build = started[started.length - 1]!;
    expect(build.environmentVariables).toContainEqual({ name: 'GIT_SHA', value: 'abc1234' });
    expect(build.environmentVariables).toContainEqual({ name: 'RELEASE_VERSION', value: `${application.id}-1.0.0` });
  });

  it('drops build variable names that steer the build shell or reuse the pipeline names', async () => {
    const names = ['DOCKERHUB_ACCESS_TOKEN', 'LD_PRELOAD', 'ECR_REPOSITORY_URI', 'PATH', 'BASH_ENV', 'DOCKER_CONFIG', 'HOME'];
    const settings = [...names, 'SAFE_NAME'].map((key) => ({
      key,
      stage: 'build',
      provider: 'vendor',
      required: false,
      secret: false,
    }));
    expect(environmentSettingsSchema.safeParse(settings).success).toBe(true);

    const { application } = await insertRelease('names', { version: '1.0.0', gitSha: 'abc1234' });
    await db
      .update(schema.applications)
      .set({ environmentSettings: settings })
      .where(eq(schema.applications.id, application.id));
    const cipher = createCipherStub();
    await setConfig(
      application.id,
      null,
      [...names, 'SAFE_NAME'].map((key) => ({ key, value: 'value', isSecret: false })),
      createConfigDeps(db, createDrizzlePendingSecretStore(db, cipher), cipher),
    );

    const variables = await loadBuildVariablesFromDb(db, application.id, createCipherStub());
    expect(variables.map((v) => v.name)).toEqual(['SAFE_NAME']);
  });
});
