import { PGlite } from '@electric-sql/pglite';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  analyseRepo,
  collectUnresolvedQuestions,
  createAiGateway,
  evaluateManifestReadiness,
  normalizeDeploymentManifest,
  readApplicationAnalysis,
  type AiGateway,
  type ReadinessReport,
} from '@deployz/analysis';
import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import {
  ANALYSIS_VERSION,
  createAnalysisRunner,
  runApplicationAnalysis,
  type AnalysisRunnerDeps,
} from './analysis.js';
import { GITHUB_FIXTURE_FILE_TREES, type FetchFn } from './github.js';

// §18/§19/§20 analysis orchestrator. Real GitHub is BLOCKED in this
// environment, so the "real mode" cases drive a mocked FetchFn (same seam
// as github.test.ts); the fixture-mode cases exercise the full pipeline
// end-to-end (fixture tree -> analyseRepo -> evaluateCompatibility ->
// persisted checks) with zero network at all.

/**
 * A minimal real-mode FetchFn serving an arbitrary file tree: access_tokens
 * + one git/trees listing + one blob fetch per file, no head-sha lookup
 * (the commit-SHA cache has its own dedicated tests below). Lets a test
 * build an exact package.json shape without adding a new fixture repo to
 * GITHUB_FIXTURE_FILE_TREES for a one-off assertion.
 */
function buildTreeFetch(files: Record<string, string>): FetchFn {
  const paths = Object.keys(files);
  return async (url) => {
    if (url.includes('/access_tokens')) {
      return {
        status: 201,
        headers: { get: () => null },
        json: async () => ({ token: 'ghs_test', expires_at: '2099-01-01T00:00:00Z' }),
      };
    }
    if (url.includes('/commits/')) {
      return { status: 200, headers: { get: () => null }, json: async () => ({ sha: 'head-sha' }) };
    }
    if (url.includes('/git/trees/')) {
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          tree: paths.map((path, i) => ({ path, type: 'blob', sha: `sha-${i}`, size: files[path]!.length })),
        }),
      };
    }
    const sha = url.split('/').pop() ?? '';
    const path = paths[Number(sha.replace('sha-', ''))]!;
    const content = files[path]!;
    return {
      status: 200,
      headers: { get: () => null },
      json: async () => ({ content: Buffer.from(content).toString('base64'), encoding: 'base64' }),
    };
  };
}

async function insertOrganization(db: Db, id: string): Promise<void> {
  await db.insert(schema.organization).values({ id, name: 'Acme', slug: id });
}

/**
 * Seed an application in a FRESH organization.
 *
 * One application per repository per organization is a database constraint
 * now, and several of these tests analyse the same fixture repo more than
 * once — which is the point, since the fixture keys off repoFullName. Giving
 * each application its own organization keeps those tests saying what they
 * meant without weakening the constraint.
 */
async function insertApplication(
  db: Db,
  organizationId: string,
  overrides: Partial<typeof schema.applications.$inferInsert> = {},
): Promise<typeof schema.applications.$inferSelect> {
  const ownOrgId = `${organizationId}-${crypto.randomUUID().slice(0, 8)}`;
  await insertOrganization(db, ownOrgId);
  const [row] = await db
    .insert(schema.applications)
    .values({
      organizationId: ownOrgId,
      name: 'Test App',
      repoFullName: 'acme/test-app',
      repoUrl: 'https://github.com/acme/test-app',
      defaultBranch: 'main',
      analysisStatus: 'ANALYZING',
      ...overrides,
    })
    .returning();
  return row!;
}

async function loadApplication(
  db: Db,
  id: string,
): Promise<typeof schema.applications.$inferSelect> {
  const rows = await db.select().from(schema.applications).where(eq(schema.applications.id, id)).limit(1);
  return rows[0]!;
}

describe('analysis — runApplicationAnalysis (fixture mode, end-to-end)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let orgId: string;
  let deps: AnalysisRunnerDeps;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    orgId = 'org-analysis-fixture';
    await insertOrganization(db, orgId);
    deps = {
      db,
      fetchFn: (() => {
        throw new Error('fixture mode must never call fetchFn');
      }) as unknown as FetchFn,
      githubAppId: undefined,
      githubAppPrivateKey: undefined,
      githubFixtureMode: true,
      aiGateway: createAiGateway(undefined),
    };
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('analyses the ready fixture repo to COMPLETE/READY and backfills §35 contract fields', async () => {
    const application = await insertApplication(db, orgId, {
      repoFullName: 'deployz-demo/express-api',
    });

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    expect(row.compatibilityStatus).toBe('READY');
    expect(row.compatibilityReason).toBe('This app can be deployed through Deployz.');

    const readiness = (row.detectedMetadata as { readiness: ReadinessReport }).readiness;
    expect(readiness.state).toBe('READY');
    expect(readiness.findings).toEqual([]);
    expect(readiness.passed.length).toBeGreaterThan(0);
    expect(readiness.passed).toContainEqual({ id: 'dockerfile', label: 'Container setup found' });

    // §35 contract fields backfilled from the analysis (were null/false).
    expect(row.containerPort).toBe(3000);
    expect(row.healthPath).toBe('/health');
    expect(row.migrationCommand).toBe('npx drizzle-kit migrate');
    expect(row.databaseRequired).toBe(true);

    // The canonical projection is persisted beside the flat metadata,
    // versioned, and readable back through the contract schema.
    const detected = readApplicationAnalysis(row.detectedMetadata);
    expect(detected).not.toBeNull();
    expect(detected).toMatchObject({
      analysisVersion: ANALYSIS_VERSION,
      runtime: { value: 'node', source: 'dockerfile', confidence: 'confirmed' },
      framework: { value: 'express' },
      network: { port: { value: 3000, source: 'dockerfile' } },
      database: { required: true, type: 'postgres' },
      healthCheck: { detected: true, path: '/health' },
      migrations: { command: 'npx drizzle-kit migrate', tools: ['drizzle-kit'] },
    });
    expect(detected?.environmentVariables.map((v) => v.key)).toContain('DATABASE_URL');
  });

  it('analyses the legacy-redis fixture repo to COMPLETE/NOT_COMPATIBLE with a blocking finding', async () => {
    const application = await insertApplication(db, orgId, {
      repoFullName: 'deployz-demo/legacy-redis',
    });

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    expect(row.compatibilityStatus).toBe('NOT_COMPATIBLE');

    const readiness = (row.detectedMetadata as { readiness: ReadinessReport }).readiness;
    expect(readiness.state).toBe('NEEDS_CHANGES');
    // No Dockerfile, plus the blocking Redis rejection. No health route: the default `/` is the health check.
    expect(readiness.requiredCount).toBe(2);
    expect(readiness.findings.some((f) => f.id === 'unsupported-redis-setup' && f.blocking)).toBe(true);
    expect(readiness.findings.some((f) => f.id === 'container-setup')).toBe(true);
    expect(readiness.findings.some((f) => f.id === 'health-check')).toBe(false);
  });

  it('analyses the static-api fixture (no database) to COMPLETE/READY with databaseRequired false', async () => {
    const application = await insertApplication(db, orgId, {
      repoFullName: 'deployz-demo/static-api',
    });

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    expect(row.compatibilityStatus).toBe('READY');
    expect(row.compatibilityReason).toBe('This app can be deployed through Deployz.');
    // No database → databaseRequired stays false, databaseState 'none'.
    expect(row.databaseRequired).toBe(false);

    const metadata = row.detectedMetadata as { databaseState?: string; readiness: ReadinessReport };
    expect(metadata.databaseState).toBe('none');
    // No database at all → no migration finding, regardless of the missing driver.
    expect(metadata.readiness.findings.some((f) => f.id === 'database-migrations')).toBe(false);
    expect(metadata.readiness.state).toBe('READY');
  });

  it('analyses the bullmq-worker fixture repo to a supported, high-confidence Redis requirement', async () => {
    const application = await insertApplication(db, orgId, {
      repoFullName: 'deployz-demo/bullmq-worker',
    });

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    expect(row.compatibilityStatus).toBe('READY');
    expect(row.databaseRequired).toBe(true);
    expect(row.redisRequired).toBe(true);

    const readiness = (row.detectedMetadata as { readiness: ReadinessReport }).readiness;
    expect(readiness.passed).toContainEqual({
      id: 'redis',
      label: 'Redis detected — provisioned automatically on install',
    });

    // This fixture has a `bullmq` dependency (worker-like code) but no
    // "worker"/"worker:start" script — no worker command resolves, so
    // application-stack provisions no worker service. "Background worker
    // detected" must NOT appear as a passed check for that. BullMQ jobs run
    // in the web process by default, so no worker question is raised (REM-103).
    expect(readiness.passed).not.toContainEqual({ id: 'worker', label: 'Background worker detected' });
    expect(readiness.state).toBe('READY');
    expect(readiness.findings).toEqual([]);
    expect(row.workerCommand).toBeNull();
  });

  it('analyses the nextjs-prisma fixture repo to COMPLETE/READY with a required Postgres database', async () => {
    const application = await insertApplication(db, orgId, {
      repoFullName: 'deployz-demo/nextjs-prisma',
    });

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    expect(row.compatibilityStatus).toBe('READY');
    expect(row.compatibilityReason).toBe('This app can be deployed through Deployz.');
    expect(row.databaseRequired).toBe(true);
    // The script value is the bare `prisma migrate deploy` (not runnable
    // where the relay executes it — no node_modules/.bin on PATH), so it
    // gets an `npx` prefix. No `--schema` flag: this fixture's Dockerfile
    // has a single `WORKDIR /app`, so the runtime cwd equals the image root,
    // and `prisma/schema.prisma` (this fixture's schema location) is
    // already Prisma's default lookup path relative to that cwd.
    expect(row.migrationCommand).toBe('npx prisma migrate deploy');
    // The Dockerfile's HEALTHCHECK curls the app-router route file
    // app/api/health/route.ts: its probed path is the health path.
    expect(row.healthPath).toBe('/api/health');

    const metadata = row.detectedMetadata as {
      framework?: string | null;
      packageManager?: string | null;
      buildCommands?: string[];
      envVars?: string[];
      postgres?: { required: boolean };
    };
    expect(metadata.framework).toBe('next');
    expect(metadata.packageManager).toBe('pnpm');
    expect(metadata.buildCommands).toContain('next build');
    expect(metadata.envVars).toContain('DATABASE_URL');
    expect(metadata.postgres?.required).toBe(true);
  });

  it('analyses the monorepo fixture repo, picking the nested apps/api/Dockerfile and flagging monorepo-target as unresolved', async () => {
    const tree = GITHUB_FIXTURE_FILE_TREES['deployz-demo/monorepo']!;
    const analysis = analyseRepo(tree);
    expect(collectUnresolvedQuestions(tree, analysis)).toContain('monorepo-target');

    const application = await insertApplication(db, orgId, {
      repoFullName: 'deployz-demo/monorepo',
    });

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    // The nested Dockerfile satisfies container setup. There is no health
    // endpoint or HEALTHCHECK anywhere in this fixture: the default `/` checks it.
    expect(row.compatibilityStatus).toBe('READY');

    const metadata = row.detectedMetadata as {
      dockerfilePath?: string;
      aiAnalysis?: { unresolved: string[]; warnings: string[] };
      readiness: ReadinessReport;
    };
    expect(metadata.dockerfilePath).toBe('apps/api/Dockerfile');
    expect(metadata.aiAnalysis?.unresolved).toContain('monorepo-target');
    expect(metadata.aiAnalysis?.warnings).toContain('AI analysis unavailable');
    expect(metadata.readiness.findings.map((f) => f.id)).not.toContain('health-check');

    // §11.1 end-to-end: analysis → manifest → manifest readiness. The MVP is
    // ONE selected app; the manifest gate must point at the nested app with a
    // repo-root build context. This fixture has NO health evidence at all, so
    // the health check probes `/` and also accepts a redirect.
    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.application.root).toBe('apps/api');
    expect(manifest.application.dockerfilePath).toBe('apps/api/Dockerfile');
    expect(manifest.build.context).toBe('.');
    expect(manifest.web.command).toContain('src/index.js');
    expect(manifest.web.port).toBe(3000);
    expect(manifest.unsupported).toEqual([]);
    expect(manifest.health).toEqual({ path: '/', mode: 'root', redirectsAccepted: true });
    const gate = evaluateManifestReadiness(manifest);
    expect(gate.findings.some((f) => f.id === 'health-path-required')).toBe(false);
    // The same flow accepts the vendor-corrected overrides verbatim — the
    // PATCH surface feeds this exact normalizer at deployment creation.
    const overridden = normalizeDeploymentManifest(analysis, {
      appRoot: 'apps/api',
      dockerfilePath: 'apps/api/Dockerfile',
      buildContext: '.',
      startCommand: 'pnpm --filter api start',
    });
    expect(overridden.application.root).toBe('apps/api');
    expect(overridden.build.context).toBe('.');
    expect(overridden.web.command).toBe('pnpm --filter api start');
  });

  it('refreshes a previously auto-detected contract field when the repo has changed', async () => {
    // The values a PREVIOUS analysis wrote, before the repo changed. Nothing
    // marks them as vendor-owned, so re-analysis must replace them.
    const application = await insertApplication(db, orgId, {
      repoFullName: 'deployz-demo/express-api',
      containerPort: 9999,
      migrationCommand: 'npm run old:migrate',
      detectedMetadata: { vendorOverrides: [] },
    });

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.containerPort).toBe(3000);
    expect(row.migrationCommand).toBe('npx drizzle-kit migrate');
  });

  it('never overrides a contract field the vendor edited', async () => {
    const application = await insertApplication(db, orgId, {
      repoFullName: 'deployz-demo/express-api',
      containerPort: 8080,
      detectedMetadata: { vendorOverrides: ['containerPort'] },
    });

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    // Vendor-owned -> untouched, even though the detector found 3000.
    expect(row.containerPort).toBe(8080);
    // Fields the vendor never touched still refresh.
    expect(row.healthPath).toBe('/health');
  });

  it('carries the vendor-override list across the analysis write', async () => {
    const application = await insertApplication(db, orgId, {
      repoFullName: 'deployz-demo/express-api',
      containerPort: 8080,
      detectedMetadata: { vendorOverrides: ['containerPort'] },
    });

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    const metadata = row.detectedMetadata as { vendorOverrides?: string[] };
    expect(metadata.vendorOverrides).toEqual(['containerPort']);
  });

  it('carries the manifest-only overrides across the analysis write', async () => {
    const application = await insertApplication(db, orgId, {
      repoFullName: 'deployz-demo/express-api',
      detectedMetadata: { manifestOverrides: { dockerfilePath: 'packaging/docker/alpine/Dockerfile', buildContext: '.' } },
    });

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    const metadata = row.detectedMetadata as { manifestOverrides?: Record<string, string> };
    expect(metadata.manifestOverrides).toEqual({ dockerfilePath: 'packaging/docker/alpine/Dockerfile', buildContext: '.' });
  });

  it('is a no-op (never throws) when the application row no longer exists', async () => {
    await expect(
      runApplicationAnalysis(deps, '00000000-0000-0000-0000-000000000000'),
    ).resolves.toBeUndefined();
  });

  it('404s for an unrecognized fixture repoFullName by persisting FAILED, never throwing', async () => {
    const application = await insertApplication(db, orgId, { repoFullName: 'someone/unknown-repo' });

    await expect(runApplicationAnalysis(deps, application.id)).resolves.toBeUndefined();

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('FAILED');
    expect(row.compatibilityReason).toBe('Repository not found');
  });

  // The analysis runs detached on the worker Lambda and catches EVERY error,
  // so without this line a failed run leaves no trace anywhere: the row says
  // FAILED, CloudWatch says nothing, and production is undiagnosable.
  it('logs the failure so a failed run is visible in the worker log', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const application = await insertApplication(db, orgId, { repoFullName: 'someone/unknown-repo' });

    await runApplicationAnalysis(deps, application.id);

    expect(logged).toHaveBeenCalledOnce();
    const [message] = logged.mock.calls[0] as [string];
    expect(message).toContain(application.id);
    expect(message).toContain('Repository not found');
    logged.mockRestore();
  });
});

// §35 audit fix (N7): migration/worker command resolution reuses the
// workspace-aware script collection from @deployz/analysis (not just the
// root package.json) and prefers a deploy-shaped migration command over a
// dev-shaped one — a dev-mode command must NEVER reach `migrationCommand`,
// since deploy-release-workflow.ts runs it unattended against production.
describe('analysis — migration/worker command resolution (deploy-safe, workspace-aware)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let orgId: string;
  let privateKey: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    orgId = 'org-analysis-migration';
    await insertOrganization(db, orgId);
    const { generateKeyPairSync } = await import('node:crypto');
    privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey as unknown as string;
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  function makeDeps(fetchFn: FetchFn): AnalysisRunnerDeps {
    return {
      db,
      fetchFn,
      githubAppId: 'app-id',
      githubAppPrivateKey: privateKey,
      githubFixtureMode: false,
      aiGateway: createAiGateway(undefined),
    };
  }

  /** A Node runtime image that installs every dependency — proof the CLI is in node_modules. */
  const NODE_FULL_INSTALL_DOCKERFILE = ['FROM node:20-alpine', 'WORKDIR /app', 'COPY . .', 'RUN npm ci', 'CMD ["node", "index.js"]'].join('\n');

  // DEPLOY-029: an umami-shaped tree — the selected Dockerfile's CMD chain
  // (CMD -> scripts/start-docker.sh -> scripts/check-db.js) migrates the
  // database at startup, while package.json ALSO carries a deploy-shaped
  // script (`update-db`) that must not win.
  function umamiShapedFiles(): Record<string, string> {
    return {
      'Dockerfile': ['FROM node:20-alpine', 'WORKDIR /app', 'CMD ["sh", "scripts/start-docker.sh"]'].join('\n'),
      'scripts/start-docker.sh': ['#!/bin/sh', 'node scripts/check-db.js', 'exec node index.js', ''].join('\n'),
      'scripts/check-db.js': "const { execSync } = require('child_process');\nexecSync('prisma migrate deploy');\n",
      'package.json': JSON.stringify({
        name: 'umami',
        scripts: { start: 'node index.js', 'update-db': 'prisma migrate deploy' },
        dependencies: { '@prisma/client': '^5.0.0' },
      }),
      'prisma/schema.prisma': 'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n',
    };
  }

  it('prefers a deploy-shaped migration script over a dev-shaped one when both exist', async () => {
    const application = await insertApplication(db, orgId, {
      githubInstallationId: 'install-1',
      repoFullName: 'acme/migrate-deploy-wins',
      defaultBranch: 'main',
    });
    const files = {
      Dockerfile: NODE_FULL_INSTALL_DOCKERFILE,
      'package.json': JSON.stringify({
        name: 'migrate-deploy-wins',
        scripts: {
          start: 'node index.js',
          'db:migrate:dev': 'prisma migrate dev',
          'db:migrate': 'prisma migrate deploy',
        },
        dependencies: { express: '^4.18.0', prisma: '^5.0.0' },
      }),
    };

    await runApplicationAnalysis(makeDeps(buildTreeFetch(files)), application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    // Bare `prisma migrate deploy` -> npx-prefixed: the image runs `npm ci`,
    // so npx finds the CLI. No schema.prisma anywhere in the tree, so no
    // --schema flag can be computed.
    expect(row.migrationCommand).toBe('npx prisma migrate deploy');
  });

  it('leaves migrationCommand unset (never a dev-mode command) when only a dev-shaped migration script exists', async () => {
    const application = await insertApplication(db, orgId, {
      githubInstallationId: 'install-1',
      repoFullName: 'acme/migrate-dev-only',
      defaultBranch: 'main',
    });
    const files = {
      'package.json': JSON.stringify({
        name: 'migrate-dev-only',
        scripts: { start: 'node index.js', 'db:migrate': 'prisma migrate dev' },
        dependencies: { express: '^4.18.0' },
      }),
    };

    await runApplicationAnalysis(makeDeps(buildTreeFetch(files)), application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    expect(row.migrationCommand).toBeNull();
  });

  it('keeps a vendor override saved while the analysis was still fetching the repository', async () => {
    const application = await insertApplication(db, orgId, {
      githubInstallationId: 'install-1',
      repoFullName: 'acme/patched-mid-run',
      defaultBranch: 'main',
      containerPort: 3000,
      detectedMetadata: { vendorOverrides: [] },
    });
    const files = {
      'package.json': JSON.stringify({
        name: 'patched-mid-run',
        scripts: { start: 'node index.js', migrate: 'prisma migrate deploy' },
        dependencies: { express: '^4.18.0' },
      }),
      Dockerfile: 'FROM node:20\nEXPOSE 4000\n',
    };
    const inner = buildTreeFetch(files);
    let patched = false;
    const patchingFetch: FetchFn = async (url, init) => {
      if (url.includes('/trees/') && !patched) {
        patched = true;
        await db
          .update(schema.applications)
          .set({
            containerPort: 8080,
            migrationCommand: null,
            detectedMetadata: { vendorOverrides: ['containerPort', 'migrationCommand'] },
          })
          .where(eq(schema.applications.id, application.id));
      }
      return inner(url, init);
    };

    await runApplicationAnalysis(makeDeps(patchingFetch), application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    expect(row.containerPort).toBe(8080);
    expect(row.migrationCommand).toBeNull();
    const metadata = row.detectedMetadata as { vendorOverrides?: string[] };
    expect(metadata.vendorOverrides).toEqual(['containerPort', 'migrationCommand']);
  });

  it('keeps saved values on a legacy row that has no override list', async () => {
    const application = await insertApplication(db, orgId, {
      githubInstallationId: 'install-1',
      repoFullName: 'acme/legacy-row',
      defaultBranch: 'main',
      containerPort: 9999,
    });
    const files = {
      'package.json': JSON.stringify({
        name: 'legacy-row',
        scripts: { start: 'node index.js' },
        dependencies: { express: '^4.18.0' },
      }),
      Dockerfile: 'FROM node:20\nEXPOSE 4000\n',
    };

    await runApplicationAnalysis(makeDeps(buildTreeFetch(files)), application.id);

    const row = await loadApplication(db, application.id);
    expect(row.containerPort).toBe(9999);
    expect('vendorOverrides' in (row.detectedMetadata as Record<string, unknown>)).toBe(false);
  });

  it('resolves a deploy-shaped migration script whose key does not mention migrations (COMP-006)', async () => {
    const application = await insertApplication(db, orgId, {
      githubInstallationId: 'install-1',
      repoFullName: 'acme/migrate-by-value',
      defaultBranch: 'main',
    });
    const files = {
      Dockerfile: NODE_FULL_INSTALL_DOCKERFILE,
      'package.json': JSON.stringify({
        name: 'migrate-by-value',
        scripts: { start: 'node index.js', 'update-db': 'prisma migrate deploy', 'build-db-schema': 'prisma db pull' },
        dependencies: { express: '^4.18.0', prisma: '^5.0.0' },
      }),
    };

    await runApplicationAnalysis(makeDeps(buildTreeFetch(files)), application.id);

    const row = await loadApplication(db, application.id);
    expect(row.migrationCommand).toBe('npx prisma migrate deploy');
  });

  it('resolves a migration command from the deployed workspace package script, not just the root manifest', async () => {
    const application = await insertApplication(db, orgId, {
      githubInstallationId: 'install-1',
      repoFullName: 'acme/migrate-workspace-package',
      defaultBranch: 'main',
    });
    const files = {
      'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['apps/*'] }),
      'apps/api/Dockerfile': ['FROM node:20-alpine', 'WORKDIR /app', 'COPY . .', 'RUN npm ci', 'CMD ["node", "index.js"]'].join('\n'),
      'apps/api/package.json': JSON.stringify({
        name: 'api',
        scripts: { start: 'node index.js', 'db:migrate': 'drizzle-kit migrate' },
        dependencies: { express: '^4.18.0', 'drizzle-kit': '^0.31.0' },
      }),
    };

    await runApplicationAnalysis(makeDeps(buildTreeFetch(files)), application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    expect(row.migrationCommand).toBe('npx drizzle-kit migrate');
  });

  // Production-verified defect: `resolveMigrationCommand` used to copy the
  // matched package.json script value verbatim. The relay runs it as
  // `sh -c <command>` inside the built image, at the image's runtime
  // WORKDIR, with no node_modules/.bin on PATH — Documenso's own
  // `packages/prisma/package.json` script (`prisma migrate deploy`) exited
  // 127 there on every deploy. The command that actually runs there is
  // Documenso's own `docker/start.sh` line: `npx prisma migrate deploy
  // --schema ../../packages/prisma/schema.prisma`.
  describe('deriving a runnable command (npx prefix, Prisma --schema)', () => {
    it('rewrites a Documenso-shaped tree (nested prisma package, multi-WORKDIR Dockerfile) to the exact working command', async () => {
      const application = await insertApplication(db, orgId, {
        githubInstallationId: 'install-1',
        repoFullName: 'acme/documenso-shaped',
        defaultBranch: 'main',
      });
      const files = {
        'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['apps/*', 'packages/*'] }),
        'docker/Dockerfile': [
          'FROM node:20-alpine AS installer',
          'WORKDIR /app',
          'RUN npm ci',
          'FROM node:20-alpine AS runner',
          'WORKDIR /app',
          'COPY --from=installer /app .',
          'WORKDIR /app/apps/remix',
          'CMD ["sh", "start.sh"]',
        ].join('\n'),
        'apps/remix/package.json': JSON.stringify({
          name: 'remix',
          scripts: { start: 'node build/server/main.js', 'prisma:migrate-deploy': 'prisma migrate deploy' },
          dependencies: { express: '^4.18.0', prisma: '^6.19.0' },
        }),
        'packages/prisma/schema.prisma': [
          'datasource db {',
          '  provider = "postgresql"',
          '  url      = env("DATABASE_URL")',
          '}',
          '',
        ].join('\n'),
      };

      await runApplicationAnalysis(makeDeps(buildTreeFetch(files)), application.id);

      const row = await loadApplication(db, application.id);
      expect(row.analysisStatus).toBe('COMPLETE');
      expect(row.migrationCommand).toBe('npx prisma migrate deploy --schema ../../packages/prisma/schema.prisma');
    });

    it('uses a repo-relative schema path (no ../..) when the Dockerfile has only one WORKDIR', async () => {
      const application = await insertApplication(db, orgId, {
        githubInstallationId: 'install-1',
        repoFullName: 'acme/documenso-shaped-single-workdir',
        defaultBranch: 'main',
      });
      const files = {
        'package.json': JSON.stringify({
          name: 'root',
          private: true,
          workspaces: ['apps/*', 'packages/*'],
          scripts: { 'prisma:migrate-deploy': 'prisma migrate deploy' },
          dependencies: { prisma: '^6.19.0' },
        }),
        'docker/Dockerfile': [
          'FROM node:20-alpine',
          'WORKDIR /app',
          'COPY . .',
          'RUN npm ci',
          'CMD ["node", "apps/remix/build/server/main.js"]',
        ].join('\n'),
        'apps/remix/package.json': JSON.stringify({
          name: 'remix',
          scripts: { start: 'node build/server/main.js' },
          dependencies: { express: '^4.18.0' },
        }),
        'packages/prisma/schema.prisma': 'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n',
      };

      await runApplicationAnalysis(makeDeps(buildTreeFetch(files)), application.id);

      const row = await loadApplication(db, application.id);
      expect(row.migrationCommand).toBe('npx prisma migrate deploy --schema packages/prisma/schema.prisma');
    });

    it('omits --schema when the schema already sits at Prisma\'s default lookup location relative to the runtime WORKDIR', async () => {
      const application = await insertApplication(db, orgId, {
        githubInstallationId: 'install-1',
        repoFullName: 'acme/prisma-default-schema-location',
        defaultBranch: 'main',
      });
      const files = {
        'Dockerfile': NODE_FULL_INSTALL_DOCKERFILE,
        'package.json': JSON.stringify({
          name: 'app',
          scripts: { start: 'node dist/index.js', 'db:migrate': 'prisma migrate deploy' },
          dependencies: { express: '^4.18.0', prisma: '^5.0.0' },
        }),
        'prisma/schema.prisma': 'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n',
      };

      await runApplicationAnalysis(makeDeps(buildTreeFetch(files)), application.id);

      const row = await loadApplication(db, application.id);
      expect(row.migrationCommand).toBe('npx prisma migrate deploy');
    });

    it('never touches a command already qualified with npx and --schema', async () => {
      const application = await insertApplication(db, orgId, {
        githubInstallationId: 'install-1',
        repoFullName: 'acme/already-qualified-prisma',
        defaultBranch: 'main',
      });
      const files = {
        'Dockerfile': [
          'FROM node:20-alpine',
          'WORKDIR /app',
          'COPY . .',
          'RUN npm ci',
          'WORKDIR /app/apps/remix',
          'CMD ["node", "main.js"]',
        ].join('\n'),
        'package.json': JSON.stringify({
          name: 'app',
          scripts: {
            start: 'node main.js',
            'db:migrate': 'npx prisma migrate deploy --schema prisma/schema.prisma',
          },
          dependencies: { express: '^4.18.0', prisma: '^5.0.0' },
        }),
        'prisma/schema.prisma': 'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n',
      };

      await runApplicationAnalysis(makeDeps(buildTreeFetch(files)), application.id);

      const row = await loadApplication(db, application.id);
      expect(row.migrationCommand).toBe('npx prisma migrate deploy --schema prisma/schema.prisma');
    });

    it('npx-prefixes a bare knex invocation', async () => {
      const application = await insertApplication(db, orgId, {
        githubInstallationId: 'install-1',
        repoFullName: 'acme/bare-knex',
        defaultBranch: 'main',
      });
      const files = {
        Dockerfile: NODE_FULL_INSTALL_DOCKERFILE,
        'package.json': JSON.stringify({
          name: 'app',
          scripts: { start: 'node index.js', 'db:migrate': 'knex migrate:latest' },
          dependencies: { express: '^4.18.0', knex: '^3.1.0' },
        }),
      };

      await runApplicationAnalysis(makeDeps(buildTreeFetch(files)), application.id);

      const row = await loadApplication(db, application.id);
      expect(row.migrationCommand).toBe('npx knex migrate:latest');
    });

    it('never adds an npx prefix to a command already qualified via pnpm', async () => {
      const application = await insertApplication(db, orgId, {
        githubInstallationId: 'install-1',
        repoFullName: 'acme/pnpm-qualified-prisma',
        defaultBranch: 'main',
      });
      const files = {
        Dockerfile: [
          'FROM node:20-alpine',
          'WORKDIR /app',
          'COPY . .',
          'RUN corepack enable && pnpm install --frozen-lockfile',
          'CMD ["node", "index.js"]',
        ].join('\n'),
        'package.json': JSON.stringify({
          name: 'app',
          scripts: { start: 'node index.js', 'db:migrate': 'pnpm prisma migrate deploy' },
          dependencies: { express: '^4.18.0', prisma: '^5.0.0' },
        }),
      };

      await runApplicationAnalysis(makeDeps(buildTreeFetch(files)), application.id);

      const row = await loadApplication(db, application.id);
      expect(row.migrationCommand).toBe('pnpm prisma migrate deploy');
    });
  });

  // A runner the runtime image is not shown to provide is never added,
  // substituted or installed: the script becomes a blocking vendor question.
  describe('a migration runner the runtime image may not provide needs vendor input', () => {
    async function analyse(name: string, files: Record<string, string>, extra: Partial<Parameters<typeof insertApplication>[2]> = {}) {
      const application = await insertApplication(db, orgId, {
        githubInstallationId: 'install-1',
        repoFullName: `acme/${name}`,
        defaultBranch: 'main',
        ...extra,
      });
      await runApplicationAnalysis(makeDeps(buildTreeFetch(files)), application.id);
      return loadApplication(db, application.id);
    }

    function prismaApp(dockerfile: string[], prisma: 'dependencies' | 'devDependencies' = 'dependencies'): Record<string, string> {
      return {
        Dockerfile: dockerfile.join('\n'),
        'package.json': JSON.stringify({
          name: 'app',
          scripts: { start: 'node index.js', 'db:migrate': 'prisma migrate deploy' },
          dependencies: { express: '^4.18.0', pg: '^8.12.0' },
          [prisma]: { prisma: '^5.14.0' },
        }),
        '.env.example': 'DATABASE_URL=\n',
      };
    }

    it.each([
      ['a Bun runtime image (never substituted with bunx)', ['FROM oven/bun:1', 'WORKDIR /app', 'COPY . .', 'RUN bun install', 'CMD ["bun", "index.js"]'], 'dependencies'],
      ['a runner stage that removes npm', ['FROM node:20-alpine AS build', 'WORKDIR /app', 'COPY . .', 'RUN npm ci', 'FROM build AS runner', 'RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npx', 'CMD ["node", "index.js"]'], 'dependencies'],
      ['a distroless runtime with no shell', ['FROM node:20-alpine AS build', 'WORKDIR /app', 'COPY . .', 'RUN npm ci', 'FROM gcr.io/distroless/nodejs20-debian12', 'COPY --from=build /app /app', 'CMD ["index.js"]'], 'dependencies'],
      ['a base image set by a build argument', ['ARG BASE=node:20-alpine', 'FROM ${BASE}', 'WORKDIR /app', 'COPY . .', 'RUN npm ci', 'CMD ["node", "index.js"]'], 'dependencies'],
    ] as const)('%s', async (name, dockerfile, prisma) => {
      const row = await analyse(`runner-${name.replace(/[^a-z]+/gi, '-')}`, prismaApp([...dockerfile], prisma));
      expect(row.migrationCommand).toBeNull();
      const metadata = row.detectedMetadata as {
        migrationNeedsInput?: { candidate: string; reason: string };
        readiness?: { findings: { id: string; severity: string }[] };
      };
      expect(metadata.migrationNeedsInput?.candidate).toBe('prisma migrate deploy');
      expect(metadata.readiness?.findings).toContainEqual(
        expect.objectContaining({ id: 'migration-command-needs-input', severity: 'required' }),
      );
      expect(row.compatibilityStatus).toBe('NEEDS_ATTENTION');
    });

    it('follows the runtime stage ancestry to the Node base image', async () => {
      const row = await analyse(
        'runner-ancestry',
        prismaApp(['FROM node:20-alpine AS base', 'WORKDIR /app', 'COPY . .', 'RUN npm ci', 'FROM base AS runner', 'CMD ["node", "index.js"]']),
      );
      expect(row.migrationCommand).toBe('npx prisma migrate deploy');
      expect((row.detectedMetadata as { migrationNeedsInput?: unknown }).migrationNeedsInput).toBeUndefined();
    });

    it('clears an earlier invented npx command the image cannot run', async () => {
      const row = await analyse(
        'runner-stale-npx',
        prismaApp(['FROM oven/bun:1', 'WORKDIR /app', 'COPY . .', 'RUN bun install', 'CMD ["bun", "index.js"]']),
        { migrationCommand: 'npx prisma migrate deploy', detectedMetadata: { vendorOverrides: [] } },
      );
      expect(row.migrationCommand).toBeNull();
    });

    it('keeps the vendor decision through re-analysis and asks nothing', async () => {
      const row = await analyse(
        'runner-vendor-none',
        prismaApp(['FROM oven/bun:1', 'WORKDIR /app', 'COPY . .', 'RUN bun install', 'CMD ["bun", "index.js"]']),
        { migrationCommand: null, detectedMetadata: { vendorOverrides: ['migrationCommand'] } },
      );
      expect(row.migrationCommand).toBeNull();
      const metadata = row.detectedMetadata as { migrationNeedsInput?: unknown; vendorOverrides?: string[] };
      expect(metadata.migrationNeedsInput).toBeUndefined();
      expect(metadata.vendorOverrides).toContain('migrationCommand');
    });
  });

  // DEPLOY-029 (production-verified: umami): the selected Dockerfile's own
  // CMD/ENTRYPOINT chain (CMD -> scripts/start-docker.sh -> scripts/
  // check-db.js -> `prisma migrate deploy`) proves the built image migrates
  // itself when it starts. A package.json script that is ALSO deploy-shaped
  // (`update-db: prisma migrate deploy`) must never turn into a persisted
  // `migrationCommand` here — re-running it as a one-off pre-deploy step
  // against umami's runtime image exits 127 (`sh: npx: not found`, the
  // runner stage removes npm/npx on purpose).
  it('never persists migrationCommand when the CMD/ENTRYPOINT chain proves the image migrates at startup', async () => {
    const application = await insertApplication(db, orgId, {
      githubInstallationId: 'install-1',
      repoFullName: 'acme/umami-shaped',
      defaultBranch: 'main',
    });

    await runApplicationAnalysis(makeDeps(buildTreeFetch(umamiShapedFiles())), application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    expect((row.detectedMetadata as { migrationMode?: string } | null)?.migrationMode).toBe('startup');
    expect(row.migrationCommand).toBeNull();
  });

  // A pre-fix (v19) analysis invented `migrationCommand` for exactly this
  // shape (DEPLOY-029's production incident). Re-analysis under the fix
  // must not just skip WRITING a new value — it must CLEAR the stale one,
  // or the relay keeps running the invented command every deploy.
  it('clears a stale migrationCommand on re-analysis when the CMD/ENTRYPOINT chain proves startup mode', async () => {
    const application = await insertApplication(db, orgId, {
      githubInstallationId: 'install-1',
      repoFullName: 'acme/umami-shaped-stale-command',
      defaultBranch: 'main',
      migrationCommand: 'npx prisma migrate deploy',
      detectedMetadata: { vendorOverrides: [] },
    });

    await runApplicationAnalysis(makeDeps(buildTreeFetch(umamiShapedFiles())), application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    expect((row.detectedMetadata as { migrationMode?: string } | null)?.migrationMode).toBe('startup');
    expect(row.migrationCommand).toBeNull();
  });

  it('leaves a vendor-owned migrationCommand untouched even when the CMD/ENTRYPOINT chain proves startup mode', async () => {
    const application = await insertApplication(db, orgId, {
      githubInstallationId: 'install-1',
      repoFullName: 'acme/umami-shaped-vendor-owned',
      defaultBranch: 'main',
      migrationCommand: 'npx prisma migrate deploy --schema custom/schema.prisma',
      detectedMetadata: { vendorOverrides: ['migrationCommand'] },
    });

    await runApplicationAnalysis(makeDeps(buildTreeFetch(umamiShapedFiles())), application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    expect((row.detectedMetadata as { migrationMode?: string } | null)?.migrationMode).toBe('startup');
    expect(row.migrationCommand).toBe('npx prisma migrate deploy --schema custom/schema.prisma');
  });

  it('no longer blocks readiness on a resolved worker start command — it provisions its own workload (Phase 4A)', async () => {
    const application = await insertApplication(db, orgId, {
      githubInstallationId: 'install-1',
      repoFullName: 'acme/worker-with-command',
      defaultBranch: 'main',
    });
    const files = {
      'package.json': JSON.stringify({
        name: 'worker-with-command',
        scripts: { start: 'node index.js', 'worker:start': 'node worker.js' },
        dependencies: { express: '^4.18.0', bullmq: '^5.7.0' },
      }),
      'Dockerfile': ['FROM node:20', 'COPY . .', 'CMD ["node", "index.js"]', ''].join('\n'),
    };

    await runApplicationAnalysis(makeDeps(buildTreeFetch(files)), application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    // The resolved command is recorded AND a worker workload is provisioned:
    // a declared worker process is a supported, non-blocking second process
    // (Phase 4A — one ECS service per workload), never a readiness blocker.
    // The verdict stays NEEDS_ATTENTION only because this minimal fixture has
    // no port or health evidence — the worker itself adds nothing
    // blocking.
    expect(row.workerCommand).toBe('node worker.js');
    expect(row.compatibilityStatus).toBe('NEEDS_ATTENTION');
    const metadata = row.detectedMetadata as {
      readiness: ReadinessReport;
      resolvedWorkerCommands: { id: string; command: string; source: string }[] | null;
    };
    expect(metadata.readiness.state).toBe('ALMOST_READY');
    expect(metadata.readiness.findings).toContainEqual(
      expect.objectContaining({
        id: 'worker-process',
        severity: 'recommended',
        blocking: false,
      }),
    );
    expect(metadata.readiness.findings.some((f) => f.blocking === true)).toBe(false);
    // The full workers[] list rides the metadata for the manifest normalizer.
    expect(metadata.resolvedWorkerCommands).toEqual([
      { id: 'worker', command: 'node worker.js', source: 'package.json' },
    ]);
    expect(metadata.readiness.passed).not.toContainEqual({ id: 'worker', label: 'Background worker detected' });
  });
});

describe('analysis — runApplicationAnalysis (real mode failure paths)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let orgId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    orgId = 'org-analysis-real';
    await insertOrganization(db, orgId);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('fails cleanly with GITHUB_INSTALLATION_MISSING reason when no installation is linked', async () => {
    const application = await insertApplication(db, orgId, { githubInstallationId: null });
    const deps: AnalysisRunnerDeps = {
      db,
      fetchFn: (() => {
        throw new Error('should never be called');
      }) as unknown as FetchFn,
      githubAppId: 'app-id',
      githubAppPrivateKey: 'private-key',
      githubFixtureMode: false,
      aiGateway: createAiGateway(undefined),
    };

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('FAILED');
    expect(row.compatibilityReason).toBe('No GitHub installation is linked to this application');
  });

  it('fails cleanly with GitHub-disabled reason when the App is not configured', async () => {
    const application = await insertApplication(db, orgId, { githubInstallationId: 'install-1' });
    const deps: AnalysisRunnerDeps = {
      db,
      fetchFn: (() => {
        throw new Error('should never be called');
      }) as unknown as FetchFn,
      githubAppId: undefined,
      githubAppPrivateKey: undefined,
      githubFixtureMode: false,
      aiGateway: createAiGateway(undefined),
    };

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('FAILED');
    expect(row.compatibilityReason).toBe('GitHub App is not configured');
  });

  it('fails cleanly (never throws/rejects) when the token mint itself throws', async () => {
    const application = await insertApplication(db, orgId, { githubInstallationId: 'install-1' });
    const fetchFn: FetchFn = async () => ({
      status: 500,
      headers: { get: () => null },
      json: async () => ({ message: 'boom' }),
    });
    const deps: AnalysisRunnerDeps = {
      db,
      fetchFn,
      githubAppId: 'app-id',
      githubAppPrivateKey:
        '-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----',
      githubFixtureMode: false,
      aiGateway: createAiGateway(undefined),
    };

    await expect(runApplicationAnalysis(deps, application.id)).resolves.toBeUndefined();

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('FAILED');
  });

  it('runs end-to-end over a fully mocked GitHub API (tree + blobs)', async () => {
    const application = await insertApplication(db, orgId, {
      githubInstallationId: 'install-1',
      repoFullName: 'acme/widgets',
      defaultBranch: 'main',
    });

    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/access_tokens')) {
        return {
          status: 201,
          headers: { get: () => null },
          json: async () => ({ token: 'ghs_test', expires_at: '2099-01-01T00:00:00Z' }),
        };
      }
      if (url.includes('/git/trees/')) {
        return {
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            tree: [
              { path: 'package.json', type: 'blob', sha: 'sha-pkg', size: 200 },
              { path: 'Dockerfile', type: 'blob', sha: 'sha-docker', size: 100 },
            ],
          }),
        };
      }
      // git blobs endpoint
      const sha = url.split('/').pop();
      const content =
        sha === 'sha-pkg'
          ? JSON.stringify({
              name: 'widgets',
              scripts: { start: 'node index.js', 'db:migrate': 'npx drizzle-kit migrate' },
              dependencies: { express: '^4.18.0', pg: '^8.12.0', 'drizzle-kit': '^0.31.0' },
            })
          : 'FROM node:20-alpine\nCOPY . .\nHEALTHCHECK CMD curl -f http://localhost:3000/health\nCMD ["node", "index.js"]\n';
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => ({ content: Buffer.from(content).toString('base64'), encoding: 'base64' }),
      };
    };

    const deps: AnalysisRunnerDeps = {
      db,
      fetchFn,
      githubAppId: 'app-id',
      githubAppPrivateKey: privateKey,
      githubFixtureMode: false,
      aiGateway: createAiGateway(undefined),
    };

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    // Dockerfile + HEALTHCHECK + Postgres + migration script present, but no
    // literal "/health" route match -> NEEDS_ATTENTION (missing health
    // endpoint), not READY. This exercises the real-mode fetch path, not a
    // specific verdict.
    expect(['READY', 'NEEDS_ATTENTION']).toContain(row.compatibilityStatus);
    // A bare `pg` dependency with no connection-string evidence (env var,
    // Prisma provider, compose image) is not enough to provision RDS — see
    // the dedicated evidence-gating tests below.
    expect(row.databaseRequired).toBe(false);
  });

  it('does NOT set databaseRequired from a bare pg dependency with no other evidence', async () => {
    const application = await insertApplication(db, orgId, {
      githubInstallationId: 'install-1',
      repoFullName: 'acme/pg-only',
      defaultBranch: 'main',
    });

    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/access_tokens')) {
        return {
          status: 201,
          headers: { get: () => null },
          json: async () => ({ token: 'ghs_test', expires_at: '2099-01-01T00:00:00Z' }),
        };
      }
      if (url.includes('/git/trees/')) {
        return {
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            tree: [{ path: 'package.json', type: 'blob', sha: 'sha-pkg', size: 100 }],
          }),
        };
      }
      // git blobs endpoint — the only file is package.json.
      const content = JSON.stringify({ name: 'pg-only', dependencies: { pg: '^8.12.0' } });
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => ({ content: Buffer.from(content).toString('base64'), encoding: 'base64' }),
      };
    };

    const deps: AnalysisRunnerDeps = {
      db,
      fetchFn,
      githubAppId: 'app-id',
      githubAppPrivateKey: privateKey,
      githubFixtureMode: false,
      aiGateway: createAiGateway(undefined),
    };

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    expect(row.databaseRequired).toBe(false);
  });

  it('sets databaseRequired when a pg dependency AND a DATABASE_URL reference are both present', async () => {
    const application = await insertApplication(db, orgId, {
      githubInstallationId: 'install-1',
      repoFullName: 'acme/pg-with-url',
      defaultBranch: 'main',
    });

    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/access_tokens')) {
        return {
          status: 201,
          headers: { get: () => null },
          json: async () => ({ token: 'ghs_test', expires_at: '2099-01-01T00:00:00Z' }),
        };
      }
      if (url.includes('/git/trees/')) {
        return {
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            tree: [
              { path: 'package.json', type: 'blob', sha: 'sha-pkg', size: 100 },
              { path: '.env.example', type: 'blob', sha: 'sha-env', size: 20 },
            ],
          }),
        };
      }
      // git blobs endpoint
      const sha = url.split('/').pop();
      const content =
        sha === 'sha-pkg'
          ? JSON.stringify({ name: 'pg-with-url', dependencies: { pg: '^8.12.0' } })
          : 'DATABASE_URL=\n';
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => ({ content: Buffer.from(content).toString('base64'), encoding: 'base64' }),
      };
    };

    const deps: AnalysisRunnerDeps = {
      db,
      fetchFn,
      githubAppId: 'app-id',
      githubAppPrivateKey: privateKey,
      githubFixtureMode: false,
      aiGateway: createAiGateway(undefined),
    };

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    expect(row.databaseRequired).toBe(true);
  });
});

// §15 AI repository-analysis fallback: only called when the deterministic
// analyser leaves a real question unresolved, merged so it can fill a gap but
// never overwrite a deterministic value, and failing soft (analysis still
// persists COMPLETE) on any AI error.
describe('analysis — runApplicationAnalysis (AI fallback)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let orgId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    orgId = 'org-analysis-ai';
    await insertOrganization(db, orgId);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  // A Dockerfile with no CMD/ENTRYPOINT and a package.json with no "start"
  // script — hasStartupCommand stays false and nothing else is ambiguous, so
  // the only unresolved question is 'start-command-unknown'.
  async function buildDepsForAmbiguousStartCommand(
    aiGateway: AiGateway,
  ): Promise<{ deps: AnalysisRunnerDeps; repoFullName: string }> {
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const repoFullName = `acme/no-start-${crypto.randomUUID().slice(0, 8)}`;

    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/access_tokens')) {
        return {
          status: 201,
          headers: { get: () => null },
          json: async () => ({ token: 'ghs_test', expires_at: '2099-01-01T00:00:00Z' }),
        };
      }
      if (url.includes('/git/trees/')) {
        return {
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            tree: [
              { path: 'package.json', type: 'blob', sha: 'sha-pkg', size: 100 },
              { path: 'Dockerfile', type: 'blob', sha: 'sha-docker', size: 60 },
            ],
          }),
        };
      }
      const sha = url.split('/').pop();
      const content =
        sha === 'sha-pkg'
          ? JSON.stringify({ name: 'no-start', dependencies: { express: '^4.18.0' } })
          : 'FROM node:20-alpine\nEXPOSE 3000\n';
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => ({ content: Buffer.from(content).toString('base64'), encoding: 'base64' }),
      };
    };

    return {
      repoFullName,
      deps: {
        db,
        fetchFn,
        githubAppId: 'app-id',
        githubAppPrivateKey: privateKey,
        githubFixtureMode: false,
        aiGateway,
      },
    };
  }

  it('fills a missing start command from a valid AI answer and records aiResolved', async () => {
    const field = (value: string | boolean | number | null, confidence = 0.95) => ({
      value,
      confidence,
      evidencePaths: ['Dockerfile'],
      explanation: 'fixture answer',
    });
    const aiGateway: AiGateway = {
      async generate() {
        return {
          object: {
            dockerfile: field(null),
            workingDirectory: field('.'),
            buildCommand: field(null),
            startCommand: field('node index.js'),
            port: field(null),
            postgresRequired: field(false),
            redisRequired: field(false),
            healthPath: field(null),
            migrationMode: field(null),
            storageRequired: field(null),
            warnings: [],
          },
          usage: { promptTokens: 500, completionTokens: 50 },
        };
      },
    };
    const { deps, repoFullName } = await buildDepsForAmbiguousStartCommand(aiGateway);
    const application = await insertApplication(db, orgId, { githubInstallationId: 'install-1', repoFullName });

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    const metadata = row.detectedMetadata as {
      startupCommands?: string[];
      hasStartupCommand?: boolean;
      aiAnalysis?: { unresolved: string[]; aiResolved: string[]; warnings: string[] };
    };
    expect(metadata.hasStartupCommand).toBe(true);
    expect(metadata.startupCommands).toEqual(['node index.js']);
    expect(metadata.aiAnalysis?.unresolved).toContain('start-command-unknown');
    expect(metadata.aiAnalysis?.aiResolved.length).toBeGreaterThan(0);
    expect(metadata.aiAnalysis?.aiResolved).toContain('startupCommands');
  });

  it('degrades to deterministic metadata and stays COMPLETE when the gateway throws', async () => {
    const aiGateway: AiGateway = {
      async generate() {
        throw new Error('gateway unreachable');
      },
    };
    const { deps, repoFullName } = await buildDepsForAmbiguousStartCommand(aiGateway);
    const application = await insertApplication(db, orgId, { githubInstallationId: 'install-1', repoFullName });

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    const metadata = row.detectedMetadata as {
      hasStartupCommand?: boolean;
      aiAnalysis?: { unresolved: string[]; warnings: string[] };
    };
    // Deterministic metadata is untouched — still unresolved.
    expect(metadata.hasStartupCommand).toBe(false);
    expect(metadata.aiAnalysis?.warnings).toContain('AI analysis unavailable');
  });

  it('never invokes the gateway for a fully-resolved fixture repo', async () => {
    let callCount = 0;
    const aiGateway: AiGateway = {
      async generate() {
        callCount += 1;
        throw new Error('should never be called for a fully-resolved analysis');
      },
    };
    const deps: AnalysisRunnerDeps = {
      db,
      fetchFn: (() => {
        throw new Error('fixture mode must never call fetchFn');
      }) as unknown as FetchFn,
      githubAppId: undefined,
      githubAppPrivateKey: undefined,
      githubFixtureMode: true,
      aiGateway,
    };
    const application = await insertApplication(db, orgId, { repoFullName: 'deployz-demo/express-api' });

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    expect(callCount).toBe(0);
    const metadata = row.detectedMetadata as { aiAnalysis?: unknown };
    expect(metadata.aiAnalysis).toBeUndefined();
  });
});

describe('analysis — createAnalysisRunner', () => {
  it(
    'wraps runApplicationAnalysis into a single-argument (applicationId) => Promise<void>',
    async () => {
      const client = new PGlite();
      await applyMigrations(client);
      const db = createDb(client);
      await insertOrganization(db, 'org-runner');
      const application = await insertApplication(db, 'org-runner', {
        repoFullName: 'deployz-demo/express-api',
      });

      const runner = createAnalysisRunner({
        db,
        fetchFn: (() => {
          throw new Error('fixture mode must never call fetchFn');
        }) as unknown as FetchFn,
        githubAppId: undefined,
        githubAppPrivateKey: undefined,
        githubFixtureMode: true,
        aiGateway: createAiGateway(undefined),
      });

      await runner(application.id);

      const rows = await db
        .select()
        .from(schema.applications)
        .where(eq(schema.applications.id, application.id));
      expect(rows[0]?.analysisStatus).toBe('COMPLETE');
      await client.close();
    },
    60_000,
  );
});

// Task 6: commit-SHA analysis cache — a re-analysis whose repository head
// commit hasn't moved (and whose stored ANALYSIS_VERSION still matches)
// short-circuits to COMPLETE without re-fetching the tree, re-running the
// detectors, or invoking AI. Real-GitHub mode only; fixture mode has no head
// sha to compare and always runs fully.
describe('analysis — commit-SHA cache (Task 6)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let orgId: string;
  let privateKey: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    orgId = 'org-analysis-cache';
    await insertOrganization(db, orgId);
    const { generateKeyPairSync } = await import('node:crypto');
    privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey as unknown as string;
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  /** A minimal real-GitHub fetchFn: access_tokens + commits/{branch} (head sha) + tree + one blob. */
  function buildFetch(headSha: string, calls: string[]): FetchFn {
    return async (url) => {
      calls.push(url);
      if (url.includes('/access_tokens')) {
        return {
          status: 201,
          headers: { get: () => null },
          json: async () => ({ token: 'ghs_test', expires_at: '2099-01-01T00:00:00Z' }),
        };
      }
      if (url.includes('/commits/')) {
        return { status: 200, headers: { get: () => null }, json: async () => ({ sha: headSha }) };
      }
      if (url.includes('/git/trees/')) {
        return {
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            tree: [{ path: 'package.json', type: 'blob', sha: 'sha-pkg', size: 100 }],
          }),
        };
      }
      const content = JSON.stringify({
        name: 'widgets',
        scripts: { start: 'node index.js' },
        dependencies: { express: '^4.18.0' },
      });
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => ({ content: Buffer.from(content).toString('base64'), encoding: 'base64' }),
      };
    };
  }

  function makeDeps(fetchFn: FetchFn): AnalysisRunnerDeps {
    return {
      db,
      fetchFn,
      githubAppId: 'app-id',
      githubAppPrivateKey: privateKey,
      githubFixtureMode: false,
      aiGateway: createAiGateway(undefined),
    };
  }

  it('(a) a second run against the same head sha short-circuits: no tree fetch, ends COMPLETE, other columns untouched', async () => {
    const application = await insertApplication(db, orgId, {
      githubInstallationId: 'install-1',
      repoFullName: 'acme/cache-a',
      defaultBranch: 'main',
    });
    const calls: string[] = [];
    const deps = makeDeps(buildFetch('sha-same', calls));

    await runApplicationAnalysis(deps, application.id);
    expect(calls.filter((u) => u.includes('/git/trees/'))).toHaveLength(1);
    const afterFirst = await loadApplication(db, application.id);
    expect(afterFirst.analysisStatus).toBe('COMPLETE');
    const metadata = afterFirst.detectedMetadata as { analysisCommitSha?: string; analysisVersion?: number };
    expect(metadata.analysisCommitSha).toBe('sha-same');
    expect(metadata.analysisVersion).toBe(ANALYSIS_VERSION);

    // Corrupt a column a cache-hit must never touch, to prove it truly no-ops.
    await db
      .update(schema.applications)
      .set({ compatibilityReason: 'stale-sentinel', analysisStatus: 'ANALYZING' })
      .where(eq(schema.applications.id, application.id));

    await runApplicationAnalysis(deps, application.id);

    expect(calls.filter((u) => u.includes('/git/trees/'))).toHaveLength(1); // still 1 — no second tree fetch
    const afterSecond = await loadApplication(db, application.id);
    expect(afterSecond.analysisStatus).toBe('COMPLETE');
    expect(afterSecond.compatibilityReason).toBe('stale-sentinel'); // untouched
  });

  it('(b) force: true re-runs even when the head sha is unchanged', async () => {
    const application = await insertApplication(db, orgId, {
      githubInstallationId: 'install-1',
      repoFullName: 'acme/cache-b',
      defaultBranch: 'main',
    });
    const calls: string[] = [];
    const deps = makeDeps(buildFetch('sha-same', calls));

    await runApplicationAnalysis(deps, application.id);
    await runApplicationAnalysis(deps, application.id, { force: true });

    expect(calls.filter((u) => u.includes('/git/trees/'))).toHaveLength(2);
    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
  });

  it('(c) a changed head sha re-runs', async () => {
    const application = await insertApplication(db, orgId, {
      githubInstallationId: 'install-1',
      repoFullName: 'acme/cache-c',
      defaultBranch: 'main',
    });
    const calls: string[] = [];
    let headSha = 'sha-1';
    const deps = makeDeps(((url, init) => buildFetch(headSha, calls)(url, init)) as FetchFn);

    await runApplicationAnalysis(deps, application.id);
    headSha = 'sha-2';
    await runApplicationAnalysis(deps, application.id);

    expect(calls.filter((u) => u.includes('/git/trees/'))).toHaveLength(2);
    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    const metadata = row.detectedMetadata as { analysisCommitSha?: string };
    expect(metadata.analysisCommitSha).toBe('sha-2');
  });

  it('(d) a FAILED run does not persist analysisCommitSha', async () => {
    const application = await insertApplication(db, orgId, {
      githubInstallationId: 'install-1',
      repoFullName: 'acme/cache-d',
      defaultBranch: 'main',
    });
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/access_tokens')) {
        return {
          status: 201,
          headers: { get: () => null },
          json: async () => ({ token: 'ghs_test', expires_at: '2099-01-01T00:00:00Z' }),
        };
      }
      if (url.includes('/commits/')) {
        return { status: 200, headers: { get: () => null }, json: async () => ({ sha: 'sha-x' }) };
      }
      // Tree fetch fails -> the run fails.
      return { status: 404, headers: { get: () => null }, json: async () => ({ message: 'Not Found' }) };
    };
    const deps = makeDeps(fetchFn);

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('FAILED');
    const metadata = row.detectedMetadata as { analysisCommitSha?: string } | null;
    expect(metadata?.analysisCommitSha).toBeUndefined();
  });

  it('(e) fixture mode never short-circuits, even once analysisCommitSha/analysisVersion are already stored', async () => {
    const application = await insertApplication(db, orgId, {
      repoFullName: 'deployz-demo/express-api',
    });
    const fixtureDeps: AnalysisRunnerDeps = {
      db,
      fetchFn: (() => {
        throw new Error('fixture mode must never call fetchFn');
      }) as unknown as FetchFn,
      githubAppId: undefined,
      githubAppPrivateKey: undefined,
      githubFixtureMode: true,
      aiGateway: createAiGateway(undefined),
    };

    await runApplicationAnalysis(fixtureDeps, application.id);
    const first = await loadApplication(db, application.id);
    expect(first.analysisStatus).toBe('COMPLETE');

    // Stamp a matching cache entry plus a stale-sentinel column a cache-hit
    // would leave untouched — a full re-run must overwrite it regardless.
    await db
      .update(schema.applications)
      .set({
        compatibilityStatus: 'NOT_COMPATIBLE',
        compatibilityReason: 'stale-sentinel',
        detectedMetadata: {
          ...(first.detectedMetadata ?? {}),
          analysisCommitSha: 'whatever',
          analysisVersion: ANALYSIS_VERSION,
        },
        analysisStatus: 'ANALYZING',
      })
      .where(eq(schema.applications.id, application.id));

    await runApplicationAnalysis(fixtureDeps, application.id);

    const second = await loadApplication(db, application.id);
    expect(second.analysisStatus).toBe('COMPLETE');
    expect(second.compatibilityStatus).toBe('READY');
    expect(second.compatibilityReason).toBe('This app can be deployed through Deployz.');
  });

  // The head-sha lookup and the tree/blob fetch used to mint their OWN
  // installation token each, so every full real-mode run — including a
  // brand-new application's very first analysis, the most common path —
  // minted two. `mintRealModeToken` is now the single mint site, reused by
  // both, so this must never regress back to two.
  it('(f) a full real-mode run mints exactly one installation token', async () => {
    const application = await insertApplication(db, orgId, {
      githubInstallationId: 'install-1',
      repoFullName: 'acme/cache-f',
      defaultBranch: 'main',
    });
    const calls: string[] = [];
    const deps = makeDeps(buildFetch('sha-f', calls));

    await runApplicationAnalysis(deps, application.id);

    expect(calls.filter((u) => u.includes('/access_tokens'))).toHaveLength(1);
    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
  });

  it('(g) a cache-hit run also mints exactly one installation token', async () => {
    const application = await insertApplication(db, orgId, {
      githubInstallationId: 'install-1',
      repoFullName: 'acme/cache-g',
      defaultBranch: 'main',
    });
    const calls: string[] = [];
    const deps = makeDeps(buildFetch('sha-g', calls));

    await runApplicationAnalysis(deps, application.id); // full run: primes the cache
    expect(calls.filter((u) => u.includes('/access_tokens'))).toHaveLength(1);

    await runApplicationAnalysis(deps, application.id); // cache hit

    expect(calls.filter((u) => u.includes('/access_tokens'))).toHaveLength(2); // +1 for the cache-hit run's own lookup, not +2
    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
  });
});
