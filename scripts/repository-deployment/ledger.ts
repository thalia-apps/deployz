/**
 * The in-flight ledger of a real-AWS attempt — the version canary's
 * `Evidence` (run.json + per-step files) under `runs/evidence/<run id>/`,
 * gitignored, extended with the Stage B fields. Everything cleanup and
 * resume key on is written the moment it is known. The committed result
 * (`results.ts`) is derived from it at the end.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { mintRunId, type CanaryConfig } from '../version-canary/config.js';
import { Evidence, type RunRecord } from '../version-canary/evidence.js';

/** One CloudFormation resource of a stack snapshot — whatever `list-stack-resources` returns. */
export interface LedgerStackResource {
  readonly logicalId?: string;
  readonly type: string;
  readonly status: string;
  readonly physicalId: string | null;
}

export interface StageBRunRecord extends RunRecord {
  stageB: {
    repoId: string;
    repository: string;
    commit: string;
    deployzCommit: string;
    /** The organization created for this attempt (one application per repo per org). */
    organizationId?: string;
    /**
     * Where the control-plane-side resources (`deployz-images` ECR, the
     * template bucket) live for this attempt, next to `region` on the run
     * record (the install/customer region). `--cleanup`/`--resume`/`--audit`
     * rebuild a region-scoped config from these two fields, never the
     * process's own.
     */
    controlPlaneRegion?: string;
    /** Snapshot of both stacks' resources, taken once the application stack is CREATE_COMPLETE. */
    resources?: {
      applicationStack: LedgerStackResource[];
      bootstrapStack: LedgerStackResource[];
    };
    /** Set once cleanup has fully completed (destroy, purge, leftovers, audit). */
    cleanupCompletedAt?: string;
    /** Set when the attempt is abandoned to cleanup (a failure or an interrupt). */
    cleanupNeeded: boolean;
    keys?: string[];
    generatedKeys?: string[];
  };
}

export function stageBRunId(repoId: string, now = new Date()): string {
  return `stage-b-${repoId}-${mintRunId(now)}`;
}

export function openLedger(evidenceDir: string, config: CanaryConfig, input: StageBRunRecord['stageB'], runId: string): Evidence {
  const run: StageBRunRecord = {
    runId,
    startedAt: new Date().toISOString(),
    apiUrl: config.apiUrl,
    region: config.region,
    accountId: config.expectedAccountId,
    scenario: 'stage-b',
    releases: {},
    markers: [],
    jobs: [],
    steps: [],
    stageB: input,
  };
  return new Evidence(evidenceDir, run);
}

export function stageBRun(evidence: Evidence): StageBRunRecord {
  return evidence.run as StageBRunRecord;
}

/** Ledgers whose cleanup has not completed — what `--resume` must finish first. */
export function listUnfinishedLedgers(evidenceDir: string): { runId: string; repoId: string; path: string }[] {
  if (!existsSync(evidenceDir)) return [];
  const out: { runId: string; repoId: string; path: string }[] = [];
  for (const name of readdirSync(evidenceDir).sort()) {
    const path = join(evidenceDir, name, 'run.json');
    if (!existsSync(path)) continue;
    const run = JSON.parse(readFileSync(path, 'utf8')) as Partial<StageBRunRecord>;
    if (!run.stageB || run.stageB.cleanupCompletedAt) continue;
    // An attempt that was interrupted (no result) still owns whatever it had
    // created by then — a release is an ECR image, a deployment is a stack.
    const created = run.stageB.cleanupNeeded || run.result !== undefined || Boolean(run.deploymentId) || Boolean(run.bootstrapStackName) || Object.keys(run.releases ?? {}).length > 0;
    if (!created) continue;
    out.push({ runId: run.runId ?? name, repoId: run.stageB.repoId, path });
  }
  return out;
}

/**
 * The global real-AWS concurrency guard: two processes share the evidence
 * dir, and `--concurrency` only bounds one of them. Called right after an
 * attempt's own ledger is opened (so it never counts itself — a freshly
 * opened ledger has created nothing yet) and before it creates anything in
 * the vendor account. Returns the refusal message, or null when the attempt
 * may proceed.
 */
export function activeRunsBlock(ledgers: readonly { runId: string }[], maxActive: number): string | null {
  if (ledgers.length < maxActive) return null;
  return `${ledgers.length} active real-AWS runs (${ledgers.map((l) => l.runId).join(', ')}) — wait for their cleanup or run --cleanup`;
}

/** Series-level state shared by every attempt: the vendor session and, for `--reuse-application` retries, the applications earlier attempts created. */
export interface SeriesState {
  vendor?: { email: string; password: string };
  /**
   * The one organization every attempt runs in. The control plane refuses to bind a
   * GitHub installation that another organization already holds, so a new
   * organization per attempt can no longer bind the vendor's installation.
   */
  organizationId?: string;
  /**
   * The organization and application a repository's first attempt created,
   * keyed by recipe id. Only `--reuse-application` reads it: a retry then
   * adds a release to the same application instead of minting a new
   * organization, which is what lets it redeploy an image already built.
   */
  applications?: Record<string, { organizationId: string; applicationId: string }>;
}

export function readSeries(evidenceDir: string): SeriesState {
  const path = join(evidenceDir, 'series.json');
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as SeriesState;
}

export function writeSeries(evidenceDir: string, state: SeriesState): void {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, 'series.json'), `${JSON.stringify(state, null, 2)}\n`);
}
