import { PGlite } from '@electric-sql/pglite';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  JEV_DECISION_SET_VERSION,
  JEV_EVIDENCE_SCHEMA_VERSION,
  JevError,
  createAiGateway,
  createFixtureJevClient,
  normalizeDeploymentManifest,
  type JevClient,
} from '@deployz/analysis';
import { buildInstallPlan } from '@deployz/contracts';
import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { resolveJevConfig } from './ai-config.js';
import { runApplicationAnalysis, type AnalysisRunnerDeps } from './analysis.js';
import type { FetchFn } from './github.js';
import {
  createJevShadowRunner,
  createJevShadowRunnerFromEnv,
  type JevShadowParams,
  type JevShadowRunner,
} from './jev-shadow.js';
import { applicationToManifestOverrides } from './manifest.js';

// Jev requirements/plan shadow (PR 2). The invariant under test is
// SHADOW-SAFETY: the same fixture analysed with and without a Jev client
// whose answers maximally disagree produces byte-identical production state —
// only the append-only telemetry row differs. The harness mirrors
// analysis.test.ts (PGlite + migrations + the GitHub fixture trees).

const READY_REPO = 'deployz-demo/express-api';
const SECRET_URI = 'postgres://user:pass@host/db';

async function insertOrganization(db: Db, id: string): Promise<void> {
  await db.insert(schema.organization).values({ id, name: 'Acme', slug: id });
}

async function insertApplication(
  db: Db,
  organizationId: string,
  overrides: Partial<typeof schema.applications.$inferInsert> = {},
): Promise<typeof schema.applications.$inferSelect> {
  const ownOrgId = `${organizationId}-${crypto.randomUUID().slice(0, 8)}`;
  await insertOrganization(db, ownOrgId);
  // A real-mode run mints a token only for an active binding of this
  // organization, so a named installation is bound to the fresh org.
  if (typeof overrides.githubInstallationId === 'string') {
    overrides = { ...overrides, githubInstallationId: `${overrides.githubInstallationId}-${ownOrgId}` };
    await db.insert(schema.githubInstallations).values({
      id: overrides.githubInstallationId!,
      organizationId: ownOrgId,
      accountLogin: 'acme',
      accountType: 'Organization',
    });
  }
  const [row] = await db
    .insert(schema.applications)
    .values({
      organizationId: ownOrgId,
      name: 'Test App',
      repoFullName: READY_REPO,
      repoUrl: 'https://github.com/acme/test-app',
      defaultBranch: 'main',
      analysisStatus: 'ANALYZING',
      ...overrides,
    })
    .returning();
  return row!;
}

/** A minimal real-mode FetchFn serving an arbitrary file tree (analysis.test.ts style). */
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

/** A fixture client whose answers maximally disagree with Deployz on postgres. */
function createDisagreeingClient(): ReturnType<typeof createFixtureJevClient> {
  return createFixtureJevClient({
    'requirements-shadow': {
      model: 'jev-test',
      usage: { input_tokens: 42, output_tokens: 7 },
      answers: {
        postgres: { type: 'noul', noul: 0.02 },
        redis: { type: 'noul', noul: 0.03 },
        storage: { type: 'noul', noul: 0.04 },
        publicHttp: { type: 'noul', noul: 0.95 },
        worker: { type: 'noul', noul: 0.05 },
        missingDependency: {
          type: 'choice',
          choice: 'database',
          probabilities: { database: 1 },
          confidence: 1,
        },
        evidenceConflict: { type: 'choice', choice: 'clear', probabilities: { clear: 1 }, confidence: 1 },
        internalConsistency: {
          type: 'choice',
          choice: 'consistent',
          probabilities: { consistent: 1 },
          confidence: 1,
        },
        planConsistency: {
          type: 'choice',
          choice: 'contradictory',
          probabilities: { contradictory: 1 },
          confidence: 1,
        },
        deeperReview: {
          type: 'score',
          score: 0.9,
          legend: { '0': 'not-needed', '1': 'worth-review', '2': 'needed' },
          probabilities: { '0': 0.05, '1': 0.1, '2': 0.85 },
          confidence: 0.9,
        },
      },
    },
  });
}

function fixtureDeps(db: Db, jevShadow?: JevShadowRunner): AnalysisRunnerDeps {
  return {
    db,
    fetchFn: (() => {
      throw new Error('fixture mode must never call fetchFn');
    }) as unknown as FetchFn,
    githubAppId: undefined,
    githubAppPrivateKey: undefined,
    githubFixtureMode: true,
    aiGateway: createAiGateway(undefined),
    ...(jevShadow !== undefined ? { jevShadow } : {}),
  };
}

/** The persisted production row for one application. */
async function loadApplication(db: Db, id: string): Promise<typeof schema.applications.$inferSelect> {
  const rows = await db.select().from(schema.applications).where(eq(schema.applications.id, id)).limit(1);
  return rows[0]!;
}

/** Wait for the detached shadow run to append its telemetry row. */
async function waitForShadowRow(
  db: Db,
  applicationId: string,
): Promise<typeof schema.jevShadowVerifications.$inferSelect> {
  return vi.waitFor(async () => {
    const rows = await db
      .select()
      .from(schema.jevShadowVerifications)
      .where(eq(schema.jevShadowVerifications.applicationId, applicationId));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  });
}

async function shadowRowCount(db: Db, applicationId: string): Promise<number> {
  const rows = await db
    .select({ id: schema.jevShadowVerifications.id })
    .from(schema.jevShadowVerifications)
    .where(eq(schema.jevShadowVerifications.applicationId, applicationId));
  return rows.length;
}

/** The analysis events for one application, with the per-run noise removed. */
async function analysisEvents(db: Db, applicationId: string): Promise<string> {
  const rows = await db
    .select()
    .from(schema.eventLogs)
    .where(eq(schema.eventLogs.actorId, `analysis:${applicationId}`));
  return JSON.stringify(
    rows.map((row) => {
      const { durationMs: _durationMs, applicationId: _applicationId, ...payload } = row.payload;
      return { eventType: row.eventType, payload };
    }),
  );
}

/** The plan a deployment would get from this persisted row, built the production way. */
function installPlanOf(row: typeof schema.applications.$inferSelect): string {
  return JSON.stringify(
    buildInstallPlan({
      manifest: normalizeDeploymentManifest(
        { metadata: row.detectedMetadata ?? {} },
        applicationToManifestOverrides(row),
      ),
      region: null,
    }),
  );
}

describe('jev shadow verifier (shadow-safety)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let orgId: string;
  let privateKey: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    orgId = 'org-jev-shadow';
    const { generateKeyPairSync } = await import('node:crypto');
    privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey as unknown as string;
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it(
    'a maximally disagreeing Jev leaves the persisted production state byte-identical',
    async () => {
      const disabledApp = await insertApplication(db, orgId);
      await runApplicationAnalysis(fixtureDeps(db), disabledApp.id);
      const disabledRow = await loadApplication(db, disabledApp.id);

      const shadowApp = await insertApplication(db, orgId);
      await runApplicationAnalysis(
        fixtureDeps(db, createJevShadowRunner({ db, client: createDisagreeingClient() })),
        shadowApp.id,
      );
      const shadowRow = await loadApplication(db, shadowApp.id);

      expect(shadowRow.analysisStatus).toBe('COMPLETE');
      expect(shadowRow.analysisStatus).toBe(disabledRow.analysisStatus);
      expect(shadowRow.compatibilityStatus).toBe(disabledRow.compatibilityStatus);
      expect(shadowRow.compatibilityReason).toBe(disabledRow.compatibilityReason);
      expect(JSON.stringify(shadowRow.detectedMetadata)).toBe(JSON.stringify(disabledRow.detectedMetadata));
      expect(await analysisEvents(db, shadowApp.id)).toBe(await analysisEvents(db, disabledApp.id));
      expect(installPlanOf(shadowRow)).toBe(installPlanOf(disabledRow));

      const telemetry = await waitForShadowRow(db, shadowApp.id);
      expect(telemetry.ok).toBe(true);
      expect(telemetry.errorKind).toBeNull();
      expect(telemetry.model).toBe('jev-test');
      expect(telemetry.inputTokens).toBe(42);
      expect(telemetry.outputTokens).toBe(7);
      expect(telemetry.evidenceSchemaVersion).toBe(JEV_EVIDENCE_SCHEMA_VERSION);
      expect(telemetry.decisionSetVersion).toBe(JEV_DECISION_SET_VERSION);

      const result = telemetry.jevResult as {
        decisions: { postgres: { deployz: boolean; agreement: string } };
        evidenceConflict: string;
        planConsistency: string;
        possibleMissingRequirements: string[];
        reviewSignal: { level: string };
      };
      // Deployz provisions Postgres for this fixture; Jev says p=0.02.
      expect(result.decisions.postgres.deployz).toBe(true);
      expect(result.decisions.postgres.agreement).toBe('disagree');
      expect(result.evidenceConflict).toBe('clear');
      expect(result.planConsistency).toBe('contradictory');
      expect(result.possibleMissingRequirements).toEqual(['database']);
      expect(result.reviewSignal.level).toBe('needed');

      expect(await shadowRowCount(db, disabledApp.id)).toBe(0);
    },
    60_000,
  );

  it(
    'a Jev timeout fails open: analysis completes identically, row records the error kind',
    async () => {
      const timeoutClient: JevClient = {
        async evaluate() {
          throw new JevError('timeout', { attempts: 2 });
        },
      };

      const baselineApp = await insertApplication(db, orgId);
      await runApplicationAnalysis(fixtureDeps(db), baselineApp.id);
      const baselineRow = await loadApplication(db, baselineApp.id);

      const timeoutApp = await insertApplication(db, orgId);
      await runApplicationAnalysis(
        fixtureDeps(db, createJevShadowRunner({ db, client: timeoutClient })),
        timeoutApp.id,
      );
      const timeoutRow = await loadApplication(db, timeoutApp.id);

      expect(timeoutRow.analysisStatus).toBe('COMPLETE');
      expect(timeoutRow.compatibilityStatus).toBe(baselineRow.compatibilityStatus);
      expect(JSON.stringify(timeoutRow.detectedMetadata)).toBe(JSON.stringify(baselineRow.detectedMetadata));
      expect(installPlanOf(timeoutRow)).toBe(installPlanOf(baselineRow));

      const telemetry = await waitForShadowRow(db, timeoutApp.id);
      expect(telemetry.ok).toBe(false);
      expect(telemetry.errorKind).toBe('timeout');
      expect(telemetry.jevResult).toBeNull();
    },
    60_000,
  );

  it(
    'a disabled configuration yields the noop runner and writes no row',
    async () => {
      const application = await insertApplication(db, orgId);
      const params: JevShadowParams = {
        applicationId: application.id,
        commitSha: 'sha',
        application: {
          containerPort: null,
          healthPath: null,
          migrationCommand: null,
          workerCommand: null,
          databaseRequired: false,
          storageRequired: false,
          redisRequired: false,
          detectedMetadata: null,
        },
        contractFieldUpdates: {},
        detectedMetadata: {},
        analysis: { findings: [], rejections: [], metadata: {} },
        tree: {},
      };

      await createJevShadowRunner({ db }).run(params);
      await createJevShadowRunnerFromEnv({ db }, resolveJevConfig({})).run(params);

      expect(await shadowRowCount(db, application.id)).toBe(0);
    },
    60_000,
  );

  it(
    'telemetry and the Jev state carry env var names only, never values',
    async () => {
      const files: Record<string, string> = {
        Dockerfile: [
          'FROM node:20-alpine',
          'WORKDIR /app',
          `ENV DATABASE_URL=${SECRET_URI}`,
          'COPY . .',
          'EXPOSE 3000',
          'HEALTHCHECK CMD curl -f http://localhost:3000/health || exit 1',
          'CMD ["node", "server.js"]',
        ].join('\n'),
        'package.json': JSON.stringify({
          name: 'jev-secret-fixture',
          scripts: { start: 'node server.js', build: 'node build.js' },
          dependencies: { express: '^4.18.0', pg: '^8.12.0' },
        }),
        'pnpm-lock.yaml': 'lockfileVersion: 6.0\n',
        '.env.example': 'DATABASE_URL=postgresql://localhost:5432/app\n',
        'server.js': [
          "const { Pool } = require('pg');",
          'const pool = new Pool({ connectionString: process.env.DATABASE_URL });',
          "const app = require('express')();",
          "app.get('/health', (_req, res) => res.send('ok'));",
          'app.listen(process.env.PORT || 3000);',
          'module.exports = app;',
          '',
        ].join('\n'),
      };
      const disagreeingClient = createDisagreeingClient();
      const deps: AnalysisRunnerDeps = {
        db,
        fetchFn: buildTreeFetch(files),
        githubAppId: 'app-id',
        githubAppPrivateKey: privateKey,
        githubFixtureMode: false,
        aiGateway: createAiGateway(undefined),
        jevShadow: createJevShadowRunner({ db, client: disagreeingClient }),
      };

      const application = await insertApplication(db, orgId, {
        repoFullName: 'acme/jev-secret',
        githubInstallationId: 'install-1',
      });
      await runApplicationAnalysis(deps, application.id);
      expect((await loadApplication(db, application.id)).analysisStatus).toBe('COMPLETE');

      const telemetry = await waitForShadowRow(db, application.id);
      expect(telemetry.analysisCommitSha).toBe('head-sha');
      expect(JSON.stringify(telemetry.jevResult)).not.toContain('user:pass');
      expect(JSON.stringify(telemetry.jevResult)).not.toContain(SECRET_URI);
      expect(JSON.stringify(telemetry.deployzRequirements)).not.toContain('user:pass');

      const state = disagreeingClient.lastRequest()?.state as unknown as {
        evidence: { envVariables: { name: string }[] };
      };
      const stateJson = JSON.stringify(state);
      expect(stateJson).toContain('DATABASE_URL');
      expect(stateJson).not.toContain('user:pass');
      expect(stateJson).not.toContain(SECRET_URI);
      expect(state.evidence.envVariables.some((variable) => variable.name === 'DATABASE_URL')).toBe(true);
    },
    60_000,
  );
});
