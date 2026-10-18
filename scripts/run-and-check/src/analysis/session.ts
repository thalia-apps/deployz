/**
 * Runs one repository through the production analysis path, exactly as
 * a vendor's application goes through it:
 *
 *   applications row → `runApplicationAnalysis` (tree fetch, `analyseRepo`,
 *   AI fallback, contract-field backfill, readiness report, persistence) →
 *   the deployment-creation gate (`normalizeDeploymentManifest` +
 *   `evaluateManifestReadiness`) the way `POST /api/deployments` runs it.
 *
 * The database is an in-process PGlite with the real migrations (the same
 * seam apps/api's own tests use); GitHub is the snapshot fetch. The AI
 * gateway is unconfigured, so the §15 fallback degrades deterministically
 * and the questions it would have asked are recorded, not answered.
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';

import {
  analyseRepo,
  createAiGateway,
  evaluateManifestReadiness,
  normalizeDeploymentManifest,
  type AnalysisResult,
} from '@deployz/analysis';
import { runApplicationAnalysis, type AnalysisRunnerDeps } from '@deployz/api/analysis';
import { buildFileTreeForAnalysis, parseRepoFullName, type FetchFn } from '@deployz/api/github';
import { applicationToManifestOverrides } from '@deployz/api/manifest';
import type { DeploymentManifest, ManifestReadinessResult } from '@deployz/contracts';
import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { BENCHMARK_INSTALLATION_TOKEN } from './snapshot.js';

export type ApplicationRow = typeof schema.applications.$inferSelect;

export interface RawAnalysis {
  status: 'analysed' | 'failed';
  /** The persisted failure reason when analysis did not complete. */
  failure: string | null;
  row: ApplicationRow;
  analysis: AnalysisResult | null;
  manifest: DeploymentManifest | null;
  /** The deployment gate evaluated for a fresh application with no configured values. */
  gate: ManifestReadinessResult | null;
  /** Files the production tree fetch handed the detectors. */
  treeFiles: number;
}

/** What the session reads of a repository: its id, its GitHub name and the pinned commit. */
export interface AnalysisTarget {
  id: string;
  repository: string;
  commit: string;
}

export interface AnalysisSession {
  analyse(entry: AnalysisTarget): Promise<RawAnalysis>;
  close(): Promise<void>;
}

/** A throwaway RS256 key: the token exchange is answered locally, but the JWT is still signed. */
function ephemeralAppKey(): string {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
}

export async function openAnalysisSession(fetchFn: FetchFn): Promise<AnalysisSession> {
  const client = new PGlite();
  await applyMigrations(client);
  const db: Db = createDb(client);
  const deps: AnalysisRunnerDeps = {
    db,
    fetchFn,
    githubAppId: 'benchmark',
    githubAppPrivateKey: ephemeralAppKey(),
    githubFixtureMode: false,
    aiGateway: createAiGateway(undefined),
  };

  return {
    async analyse(entry) {
      // One application per repository per organization is a constraint, so
      // every entry (and every rerun of one) gets its own organization.
      const organizationId = `${entry.id}-${randomUUID().slice(0, 8)}`;
      await db.insert(schema.organization).values({ id: organizationId, name: entry.repository, slug: organizationId });
      const [inserted] = await db
        .insert(schema.applications)
        .values({
          organizationId,
          name: entry.repository,
          githubInstallationId: 'benchmark',
          repoFullName: entry.repository,
          repoUrl: `https://github.com/${entry.repository}`,
          defaultBranch: entry.commit,
          analysisStatus: 'ANALYZING',
        })
        .returning();
      const applicationId = inserted!.id;

      await runApplicationAnalysis(deps, applicationId);

      const [row] = await db.select().from(schema.applications).where(eq(schema.applications.id, applicationId)).limit(1);
      if (!row) throw new Error(`application ${applicationId} vanished during analysis`);
      if (row.analysisStatus !== 'COMPLETE') {
        return { status: 'failed', failure: row.compatibilityReason, row, analysis: null, manifest: null, gate: null, treeFiles: 0 };
      }

      // The persisted row carries the merged metadata but not the rejection
      // ids; the same pure analyser over the same (cached) tree supplies them.
      const tree = await buildFileTreeForAnalysis(
        { ...parseRepoFullName(entry.repository), branch: entry.commit },
        BENCHMARK_INSTALLATION_TOKEN,
        fetchFn,
      );
      const analysis = analyseRepo(tree);
      const manifest = normalizeDeploymentManifest(
        { metadata: row.detectedMetadata ?? {} },
        applicationToManifestOverrides(row),
      );
      const gate = evaluateManifestReadiness(manifest, { providedEnvKeys: [] });

      return { status: 'analysed', failure: null, row, analysis, manifest, gate, treeFiles: Object.keys(tree).length };
    },
    async close() {
      await client.close();
    },
  };
}
