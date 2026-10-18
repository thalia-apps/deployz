/**
 * Stage B repository-deployment audit runner.
 *
 *   pnpm benchmark:deploy --gate                       B1 (+ offline B2) over every repository, no AWS
 *   pnpm benchmark:deploy --gate --repo repo-001       one entry (repeat --repo for several)
 *   pnpm benchmark:deploy --dry-run --wave wave-1      print the plan, touch nothing
 *   pnpm benchmark:deploy --real-aws --repo repo-001   the whole funnel (needs DEPLOYZ_E2E_ALLOW_REAL_AWS=1)
 *   pnpm benchmark:deploy --real-aws --wave wave-1
 *   pnpm benchmark:deploy --real-aws --resume          finish unfinished cleanups, then continue the selection
 *   pnpm benchmark:deploy --cleanup --repo repo-001    Disconnect/Purge/leftovers/audit for the recorded ids
 *   pnpm benchmark:deploy --audit                      account scan for Stage B tags and recorded installations
 *
 * Reads the git recipes in scripts/run-and-check/recipes (id, repository and
 * pinned commit — never copied) and docs/testing/repository-deployment/deploy-config.yaml, writes
 * docs/testing/repository-deployment/runs/<id>.json and the summaries.
 * Exit code 1 when the harness itself failed; a product failure is the
 * audit's subject, not a harness failure.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { ANALYSIS_VERSION } from '@deployz/api/analysis';
import { SUPPORTED_AWS_REGIONS } from '@deployz/contracts';

import { openAnalysisSession } from '../run-and-check/src/analysis/session.js';
import { createSnapshotFetch, resolveGithubToken } from '../run-and-check/src/analysis/snapshot.js';
import {
  albDnsName,
  auditLeaks,
  callerIdentity,
  createBootstrapStack,
  describeRunningService,
  describeStack,
  ecrDigestForTag,
  lambdaFunctionNames,
  listStackResources,
  resourcesTagged,
  targetHealth,
} from '../version-canary/aws.js';
import { CANARY_TAGS, loadConfig, requireRealAwsOptIn, type CanaryConfig } from '../version-canary/config.js';
import { ControlPlane, sleep } from '../version-canary/control-plane.js';
import { Evidence } from '../version-canary/evidence.js';
import { destroyThroughProduct, leakAudit, removeCanaryLeftovers } from '../version-canary/teardown.js';
import { applyCleanupToClassification, cleanupAttempt } from './cleanup.js';
import { configFor, deploymentClassFor, loadDeployConfig, providedKeys, requireSmokeContract, type DeployConfig, type DeploymentClass, type RepositoryConfig } from './config.js';
import { runRepositoryAttempt, DEFAULT_TIMEOUTS, type DeployDeps } from './deploy.js';
import { describeDependencies, describeStoppedTasks, describeTaskDefinitionEnv, resourceStillExists, tailApplicationLogs } from './evidence.js';
import { gateSection } from './gate.js';
import { activeRunsBlock, listUnfinishedLedgers, openLedger, readSeries, stageBRun, stageBRunId, writeSeries, type StageBRunRecord } from './ledger.js';
import {
  buildStageBSummary,
  emptyResult,
  readAllResults,
  readResult,
  writeResult,
  writeSummaryFiles,
  type StageBResult,
} from './results.js';
import { loadTargets, selectTargets, type StageBTarget } from './targets.js';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..', '..');
export const RECIPES_DIR = join(REPO_ROOT, 'scripts', 'run-and-check', 'recipes');
export const STAGE_B_DIR = join(REPO_ROOT, 'docs', 'testing', 'repository-deployment');
export const DEPLOY_CONFIG_PATH = join(STAGE_B_DIR, 'deploy-config.yaml');
export const RUNS_DIR = join(STAGE_B_DIR, 'runs');
export const EVIDENCE_DIR = join(RUNS_DIR, 'evidence');
export const CACHE_DIR = join(REPO_ROOT, 'scripts', 'run-and-check', '.runs', 'snapshot-cache');

export interface RunOptions {
  ids: string[];
  wave: string | undefined;
  finding: string | undefined;
  gate: boolean;
  dryRun: boolean;
  realAws: boolean;
  resume: boolean;
  cleanup: boolean;
  audit: boolean;
  force: boolean;
  keep: boolean;
  /** Retries reuse the repository's application (and any release it already built). */
  reuseApplication: boolean;
  offline: boolean;
  concurrency: number;
  cacheDir: string;
  evidenceDir: string;
  runsDir: string;
  /** Overrides AWS_REGION for this process's install (customer) region; validated against SUPPORTED_AWS_REGIONS. */
  region: string | undefined;
  /** The global real-AWS concurrency guard across processes sharing the evidence dir. Default 2. */
  maxActive: number;
  /** A repository with no smoke contract refuses before creating anything. */
  requireSmoke: boolean;
  /** Builds and deploys a second release after the smoke contract passes, then re-runs it. */
  exerciseUpdate: boolean;
}

export function parseRunArgs(argv: readonly string[]): RunOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      repo: { type: 'string', multiple: true },
      wave: { type: 'string' },
      finding: { type: 'string' },
      gate: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'real-aws': { type: 'boolean', default: false },
      resume: { type: 'boolean', default: false },
      cleanup: { type: 'boolean', default: false },
      audit: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      keep: { type: 'boolean', default: false },
      'reuse-application': { type: 'boolean', default: false },
      online: { type: 'boolean', default: false },
      concurrency: { type: 'string' },
      cache: { type: 'string' },
      'evidence-dir': { type: 'string' },
      'runs-dir': { type: 'string' },
      region: { type: 'string' },
      'max-active': { type: 'string' },
      'require-smoke': { type: 'boolean', default: false },
      'exercise-update': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const concurrency = values.concurrency ? Number(values.concurrency) : 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) throw new Error('--concurrency must be 1 or 2');
  if (values.region !== undefined && !(SUPPORTED_AWS_REGIONS as readonly string[]).includes(values.region)) {
    throw new Error(`--region must be one of ${SUPPORTED_AWS_REGIONS.join(', ')}`);
  }
  const maxActive = values['max-active'] ? Number(values['max-active']) : 2;
  if (!Number.isInteger(maxActive) || maxActive < 1) throw new Error('--max-active must be a positive integer');
  const modes = [values.gate, values['dry-run'], values['real-aws'], values.cleanup, values.audit].filter(Boolean).length;
  if (modes === 0 && !values.resume) throw new Error('choose a mode: --gate, --dry-run, --real-aws, --cleanup or --audit');
  if (values['real-aws'] && values.gate) throw new Error('--gate and --real-aws are exclusive (the funnel runs the gate itself)');
  return {
    ids: values.repo ?? [],
    wave: values.wave,
    finding: values.finding,
    gate: values.gate ?? false,
    dryRun: values['dry-run'] ?? false,
    realAws: values['real-aws'] ?? false,
    resume: values.resume ?? false,
    cleanup: values.cleanup ?? false,
    audit: values.audit ?? false,
    force: values.force ?? false,
    keep: values.keep ?? false,
    reuseApplication: values['reuse-application'] ?? false,
    offline: !(values.online ?? false),
    concurrency,
    cacheDir: values.cache ? resolve(values.cache) : CACHE_DIR,
    evidenceDir: values['evidence-dir'] ? resolve(values['evidence-dir']) : EVIDENCE_DIR,
    runsDir: values['runs-dir'] ? resolve(values['runs-dir']) : RUNS_DIR,
    region: values.region,
    maxActive,
    requireSmoke: values['require-smoke'] ?? false,
    exerciseUpdate: values['exercise-update'] ?? false,
  };
}

/**
 * Real AWS needs both the environment opt-in every live suite shares and
 * the explicit flag; a dry run never needs either, and never reads AWS.
 */
export function requireRealAws(options: RunOptions, env: NodeJS.ProcessEnv): void {
  if (!(options.realAws || options.cleanup || options.audit || options.resume)) return;
  requireRealAwsOptIn(env);
}

/** Selection by id, wave and finding — every filter narrows. */
export function selectForRun(
  targets: readonly StageBTarget[],
  config: DeployConfig,
  options: Pick<RunOptions, 'ids' | 'wave' | 'finding'>,
  existing: readonly StageBResult[] = [],
): StageBTarget[] {
  let entries = selectTargets(targets, options.ids);
  if (options.wave !== undefined) {
    const members = config.waves[options.wave];
    if (!members) throw new Error(`unknown wave ${options.wave}`);
    const order = new Map(members.map((id, index) => [id, index]));
    for (const id of members) {
      if (!targets.some((target) => target.id === id)) throw new Error(`wave ${options.wave} names unknown repository ${id}`);
    }
    entries = entries.filter((entry) => order.has(entry.id)).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  }
  if (options.finding !== undefined) {
    const affected = new Set(existing.filter((result) => result.findingIds.includes(options.finding!)).map((result) => result.id));
    entries = entries.filter((entry) => affected.has(entry.id));
  }
  return entries;
}

export function deployzSha(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

export function identityFor(entry: StageBTarget, sha: string, mode: StageBResult['mode'], runId: string | null, deploymentClass: StageBResult['deploymentClass'] = 'capability-cohort'): Parameters<typeof emptyResult>[0] {
  return {
    id: entry.id,
    repository: entry.repository,
    commit: entry.commit,
    deployzCommit: sha,
    runId,
    mode,
    deploymentClass,
  };
}

/** The fork Deployz is pointed at for a repository (README "Repository access"). */
export function repositoryUsedFor(entry: StageBTarget, config: RepositoryConfig): { repositoryUsed: string; repositoryForm: 'original' | 'fork' } {
  if (config.fork) return { repositoryUsed: config.fork, repositoryForm: 'fork' };
  const repo = entry.repository.split('/')[1]!;
  return { repositoryUsed: `instashop-dev/${repo}`, repositoryForm: 'fork' };
}

// ── The plan (dry run) ──────────────────────────────────────────────────────

export interface PlanLine {
  id: string;
  repository: string;
  action: 'gate-only' | 'full-funnel' | 'skip-has-result';
  repositoryUsed: string;
  configuredKeys: string[];
  overrides: string[];
  deploymentClass: DeploymentClass;
}

export function buildPlan(entries: readonly StageBTarget[], config: DeployConfig, existing: readonly StageBResult[], options: Pick<RunOptions, 'gate' | 'force'>): PlanLine[] {
  return entries.map((entry) => {
    const repoConfig = configFor(config, entry.id);
    const has = existing.find((result) => result.id === entry.id);
    let action: PlanLine['action'] = options.gate ? 'gate-only' : 'full-funnel';
    if (!options.gate && has && has.mode === 'deploy' && !options.force) action = 'skip-has-result';
    return {
      id: entry.id,
      repository: entry.repository,
      action,
      repositoryUsed: repositoryUsedFor(entry, repoConfig).repositoryUsed,
      configuredKeys: providedKeys(repoConfig),
      overrides: Object.keys(repoConfig.overrides ?? {}),
      deploymentClass: deploymentClassFor(config, entry.id),
    };
  });
}

export function renderPlan(plan: readonly PlanLine[], options: Pick<RunOptions, 'concurrency'>): string {
  const b1 = plan.filter((l) => l.deploymentClass === 'runtime-reuse' && l.action !== 'skip-has-result').length;
  const b2 = plan.filter((l) => l.deploymentClass === 'capability-cohort' && l.action !== 'skip-has-result').length;
  const b3 = plan.filter((l) => l.deploymentClass === 'fresh-full' && l.action !== 'skip-has-result').length;
  const skipped = plan.filter((l) => l.action === 'skip-has-result').length;
  const lines = [
    `Stage B plan — ${plan.length} repositories, concurrency ${options.concurrency}`,
    `  B1 runtime-reuse: ${b1} | B2 capability cohorts: ${b2} | B3 full-fresh: ${b3} | skipped: ${skipped}`,
    ...plan.map((line) => `${line.id} ${line.repository} [${line.deploymentClass}] → ${line.action}${line.overrides.length ? ` overrides[${line.overrides.join(',')}]` : ''}${line.configuredKeys.length ? ` keys[${line.configuredKeys.join(',')}]` : ''}`),
    `full funnel: ${plan.filter((l) => l.action === 'full-funnel').length}, gate only: ${plan.filter((l) => l.action === 'gate-only').length}, skipped: ${skipped}`,
  ];
  return lines.join('\n');
}

// ── Gate audit (B1 + offline B2) ───────────────────────────────────────────

export async function runGateAudit(
  entries: readonly StageBTarget[],
  config: DeployConfig,
  options: Pick<RunOptions, 'offline' | 'cacheDir' | 'runsDir'>,
  sha: string,
): Promise<StageBResult[]> {
  const token = options.offline ? null : resolveGithubToken();
  const fetchFn = createSnapshotFetch({ cacheDir: options.cacheDir, token, offline: options.offline });
  const session = await openAnalysisSession(fetchFn);
  const results: StageBResult[] = [];
  try {
    for (const entry of entries) {
      process.stdout.write(`${entry.id} ${entry.repository}@${entry.commit.slice(0, 7)} … `);
      const repoConfig = configFor(config, entry.id);
      const existing = readResult(options.runsDir, entry.id);
      const result = existing ?? emptyResult(identityFor(entry, sha, 'gate', null, deploymentClassFor(config, entry.id)));
      const raw = await session.analyse(entry);
      const { gate } = gateSection(raw, repoConfig, ANALYSIS_VERSION);
      result.gate = gate;
      result.findingIds = [...repoConfig.findings];
      if (!existing || existing.mode === 'gate') {
        result.deployzCommit = sha;
        result.mode = 'gate';
        result.classification = gate.status === 'PASS' ? 'PASS' : 'GATE_ERROR';
        result.failureStage = gate.status === 'PASS' ? null : 'GATE_ERROR';
        result.rootCause = null;
        result.rootCauseEvidence = gate.status === 'PASS' ? null : `${gate.verdict ?? 'no verdict'}: ${gate.detail ?? gate.gateFindings.join(', ')}`;
      }
      writeResult(options.runsDir, result, { force: true });
      results.push(result);
      console.log(`${gate.verdict ?? `FAILED (${gate.detail ?? '—'})`} configured→${gate.configuredVerdict ?? '—'}`);
    }
  } finally {
    await session.close();
  }
  return results;
}

// ── Real AWS ───────────────────────────────────────────────────────────────

interface Series {
  config: CanaryConfig;
  api: ControlPlane;
  sha: string;
}

async function ensureVendor(evidenceDir: string, config: CanaryConfig): Promise<ControlPlane> {
  const api = new ControlPlane(config.apiUrl, config.webUrl);
  const series = readSeries(evidenceDir);
  const existing = config.vendor ?? series.vendor;
  if (existing) {
    await api.signIn(existing);
    return api;
  }
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const vendor = { email: `stage-b-${stamp}@deployz-stage-b.example.com`, password: `StageB-${stamp}-${Math.random().toString(36).slice(2, 12)}` };
  await api.signUp({ name: `Stage B ${stamp}`, ...vendor });
  writeSeries(evidenceDir, { ...series, vendor });
  return api;
}

/** Re-enters an organization an earlier attempt created (`--reuse-application`). */
async function activateOrganization(api: ControlPlane, organizationId: string): Promise<string> {
  await api.request('POST', `/api/organizations/${organizationId}/activate`, {});
  return organizationId;
}

/**
 * One organization per series: the control plane refuses to bind a GitHub installation that another
 * organization holds, so every attempt runs in the series organization (the product still allows one
 * application per repository per organization; use --reuse-application to retry a repository).
 */
async function createAttemptOrganization(api: ControlPlane, name: string, evidenceDir: string, persistentVendor: boolean): Promise<string> {
  const series = readSeries(evidenceDir);
  if (series.organizationId) return activateOrganization(api, series.organizationId);
  // A persistent vendor (DEPLOYZ_CANARY_VENDOR_EMAIL) runs in the organization that already holds the binding.
  const id = persistentVendor
    ? (await api.request<{ organization: { id: string } | null }>('GET', '/api/me')).body.organization?.id
    : (await api.request<{ id: string }>('POST', '/api/organizations', { name })).body.id;
  if (!id) throw new Error('the persistent canary vendor has no organization');
  await api.request('POST', `/api/organizations/${id}/activate`, {});
  writeSeries(evidenceDir, { ...readSeries(evidenceDir), organizationId: id });
  return id;
}

async function probe(url: string): Promise<{ status: number | null; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    return { status: response.status };
  } catch (error) {
    return { status: null, error: String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function probeBody(url: string): Promise<{ status: number | null; body: string; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    const text = await response.text();
    return { status: response.status, body: text.slice(0, 4096) };
  } catch (error) {
    return { status: null, body: '', error: String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** The install region and the control-plane region a run's AWS calls must route through — split out so the
 * override precedence (`--region` > `AWS_REGION` > default) and the ECR/template-bucket routing stay testable. */
export function regionsFor(config: CanaryConfig): { region: string; controlPlaneRegion: string } {
  return { region: config.region, controlPlaneRegion: config.controlPlaneRegion };
}

/** Binds an ECR lookup function to the control-plane region — a pure wrapper so the routing is testable without AWS. */
export function ecrDigestLookup(fn: typeof ecrDigestForTag, controlPlaneRegion: string): (tag: string) => Promise<string | null> {
  return (tag) => fn(controlPlaneRegion, 'deployz-images', tag);
}

function realDeps(series: Series, options: RunOptions): DeployDeps {
  const { region, controlPlaneRegion } = regionsFor(series.config);
  return {
    api: series.api,
    aws: {
      createBootstrapStack: (input) => createBootstrapStack(region, input),
      describeStack: (name) => describeStack(region, name),
      lambdaFunctionNames: (name) => lambdaFunctionNames(region, name),
      describeRunningService: (name) => describeRunningService(region, name),
      targetHealth: (name) => targetHealth(region, name),
      albDnsName: (name) => albDnsName(region, name),
      ecrDigestForTag: ecrDigestLookup(ecrDigestForTag, controlPlaneRegion),
      listStackResources: (name) => listStackResources(region, name),
      describeStoppedTasks: (name) => describeStoppedTasks(region, name),
      tailApplicationLogs: (name) => tailApplicationLogs(region, name),
      describeDependencies: (name) => describeDependencies(region, name),
      describeTaskDefinitionEnv: (name) => describeTaskDefinitionEnv(region, name),
    },
    probe,
    probeBody,
    sleep,
    now: Date.now,
    region,
    githubInstallationId: series.config.githubInstallationId,
    reuseApplication: options.reuseApplication,
    exerciseUpdate: options.exerciseUpdate,
    timeouts: DEFAULT_TIMEOUTS,
    keep: options.keep,
  };
}

async function runAttempt(series: Series, options: RunOptions, config: DeployConfig, entry: StageBTarget): Promise<StageBResult> {
  const repoConfig = configFor(config, entry.id);
  requireSmokeContract(repoConfig, options.requireSmoke);
  const runId = stageBRunId(entry.id);
  const result = emptyResult(identityFor(entry, series.sha, 'deploy', runId, deploymentClassFor(config, entry.id)));
  result.findingIds = [...repoConfig.findings];
  const evidence = openLedger(
    options.evidenceDir,
    series.config,
    { repoId: entry.id, repository: entry.repository, commit: entry.commit, deployzCommit: series.sha, controlPlaneRegion: series.config.controlPlaneRegion, cleanupNeeded: false },
    runId,
  );
  console.log(`\n=== ${entry.id} ${entry.repository}@${entry.commit.slice(0, 7)} — run ${runId} (evidence ${evidence.dir})`);
  // The global real-AWS concurrency guard: two processes share the evidence
  // dir, and --concurrency only bounds one of them. Checked right after this
  // attempt's own ledger is opened (so it never counts itself) and before
  // anything is created in the vendor account.
  const blocked = activeRunsBlock(listUnfinishedLedgers(options.evidenceDir), options.maxActive);
  if (blocked) throw new Error(blocked);
  // --reuse-application: a retry re-enters the organization and application
  // the repository's first attempt created, so the release it already built
  // can be redeployed. Everything downstream of the application — customer,
  // deployment, bootstrap stack, application stack — is still fresh.
  const reused = options.reuseApplication ? readSeries(options.evidenceDir).applications?.[entry.id] : undefined;
  const organizationId = reused
    ? await activateOrganization(series.api, reused.organizationId)
    : await createAttemptOrganization(series.api, `Stage B ${entry.id} ${runId.slice(-9)}`, options.evidenceDir, series.config.vendor !== null);
  if (reused) console.log(`  reusing organization ${organizationId} and application ${reused.applicationId}`);
  stageBRun(evidence).stageB.organizationId = organizationId;
  evidence.save();
  const { repositoryUsed, repositoryForm } = repositoryUsedFor(entry, repoConfig);
  const deps = realDeps(series, options);
  try {
    await runRepositoryAttempt(deps, {
      target: entry,
      config: repoConfig,
      repositoryUsed,
      repositoryForm,
      evidence,
      result,
      ...(reused ? { existingApplicationId: reused.applicationId } : {}),
    });
  } finally {
    // Recorded even on a failed attempt: the application exists either way,
    // and its release is what the next retry reuses.
    const attemptApplicationId = stageBRun(evidence).applicationId;
    if (options.reuseApplication && attemptApplicationId) {
      const state = readSeries(options.evidenceDir);
      writeSeries(options.evidenceDir, {
        ...state,
        applications: {
          ...state.applications,
          [entry.id]: { organizationId, applicationId: attemptApplicationId },
        },
      });
    }
    if (options.keep) {
      console.log('--keep set: leaving the environment in place. Run --cleanup --repo later.');
      stageBRun(evidence).stageB.cleanupNeeded = true;
      evidence.save();
    } else {
      await cleanupAttempt({ config: series.config, api: series.api, evidence, teardown: { destroyThroughProduct, removeCanaryLeftovers, leakAudit }, now: Date.now, resourceStillExists: (arn) => resourceStillExists(series.config.region, arn) }, result);
      applyCleanupToClassification(result);
    }
    evidence.finish(result.classification === 'PASS' || result.classification === 'EXPECTED_UNSUPPORTED' ? 'PASS' : 'FAIL');
  }
  return result;
}

/**
 * The region-scoped config for one ledger: `--cleanup`/`--resume`/`--audit`
 * must delete a run's resources where it actually created them, not wherever
 * this process happens to be pointed — two processes can run different
 * `--region`s at once against the same evidence dir.
 */
export function regionalConfig(config: CanaryConfig, run: { region: string; stageB: { controlPlaneRegion?: string } }): CanaryConfig {
  return { ...config, region: run.region, controlPlaneRegion: run.stageB.controlPlaneRegion ?? config.controlPlaneRegion };
}

/**
 * Real-AWS Stage B requires a real GitHub repository identity — the
 * production Deployz analysis path resolves the application repo through
 * the GitHub App and refuses a virtual fixture key (`deployz-demo/*`,
 * the local fixture namespace). Block virtual-only identities here so a
 * forgotten fixture-mode entry fails fast instead of after an install
 * funnel that bills real AWS resources. The rule is generic: any
 * `owner/name` that does not match the `^[\w.-]+/[\w.-]+$` shape is
 * refused, and `deployz-demo/*` is refused outright.
 */
export function assertRealAwsRepos(config: DeployConfig, targets: readonly StageBTarget[]): void {
  const seen = new Set<string>();
  for (const entry of config.repositories) {
    const match = targets.find((target) => target.id === entry.id);
    if (!match) continue;
    const [owner, ...rest] = match.repository.split('/');
    const name = rest.join('/');
    const repo = entry.fork ?? `${owner}/${name}`;
    const key = repo.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (repo.toLowerCase().startsWith('deployz-demo/')) {
      throw new Error(
        `deploy-config entry ${entry.id} resolves to virtual fixture "${repo}". ` +
          `Real-AWS Stage B requires a real GitHub repository reachable by the Deployz GitHub App ` +
          `installation — a deployz-demo/* fixture has no GitHub counterpart. ` +
          `Move the fixture contents into a real GitHub repository and update deploy-config.yaml's ` +
          `'fork' (or remove it) so ${match.repository} resolves to the real repo.`,
      );
    }
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      throw new Error(`deploy-config entry ${entry.id} resolves to an invalid repository "${repo}" — expected owner/name.`);
    }
  }
}

async function cleanupLedger(series: Series, options: RunOptions, runId: string): Promise<void> {
  const evidence = Evidence.open(options.evidenceDir, runId);
  const run = stageBRun(evidence);
  console.log(`\n=== cleanup ${run.stageB.repoId} — run ${runId} (region ${run.region})`);
  const result = readResult(options.runsDir, run.stageB.repoId) ?? emptyResult({
    id: run.stageB.repoId,
    repository: run.stageB.repository,
    commit: run.stageB.commit,
    deployzCommit: run.stageB.deployzCommit,
    runId,
    mode: 'deploy',
    deploymentClass: 'runtime-reuse',
  });
  const config = regionalConfig(series.config, run);
  if (run.stageB.organizationId) await series.api.request('POST', `/api/organizations/${run.stageB.organizationId}/activate`, {});
  await cleanupAttempt({ config, api: series.api, evidence, teardown: { destroyThroughProduct, removeCanaryLeftovers, leakAudit }, now: Date.now, resourceStillExists: (arn) => resourceStillExists(config.region, arn) }, result);
  applyCleanupToClassification(result);
  if (readResult(options.runsDir, run.stageB.repoId)) writeResult(options.runsDir, result, { force: true });
  evidence.save();
}

export async function auditAccount(config: CanaryConfig, evidenceDir: string): Promise<Record<string, { runTagged: string[]; installations: Record<string, string[]> }>> {
  const ledgers = listUnfinishedLedgers(evidenceDir);
  const { readFileSync } = await import('node:fs');
  const ledgerRuns = ledgers.map((ledger) => JSON.parse(readFileSync(ledger.path, 'utf8')) as StageBRunRecord);
  const regions = new Set<string>([config.region, ...ledgerRuns.map((run) => run.region)]);
  const out: Record<string, { runTagged: string[]; installations: Record<string, string[]> }> = {};
  for (const region of regions) {
    const tagged = await resourcesTagged(region, CANARY_TAGS.testMode, 'canary');
    const runTagged = tagged.filter((arn) => !arn.includes(':cluster/') && !arn.includes(':task-definition/') && !arn.includes(':service/'));
    const installations: Record<string, string[]> = {};
    for (const run of ledgerRuns.filter((r) => r.region === region)) {
      if (!run.installationId) continue;
      const audit = await auditLeaks(region, {
        installationId: run.installationId,
        runId: run.runId,
        bootstrapStackName: run.bootstrapStackName ?? null,
        applicationStackName: run.applicationStackName ?? null,
        bootstrapLambdaNames: run.bootstrapLambdaNames ?? [],
        deploymentId: run.deploymentId ?? null,
        ecrRepository: 'deployz-images',
        ecrTags: Object.values(run.releases).map((r) => r.version),
        ecrRegion: run.stageB.controlPlaneRegion ?? config.controlPlaneRegion,
      });
      installations[run.runId] = [
        ...audit.stacks.map((s) => `stack ${s.name} ${s.status}`),
        ...audit.rdsInstances.map((r) => `rds ${r}`),
        ...audit.loadBalancers.map((l) => `alb ${l}`),
        ...audit.buckets.map((b) => `bucket ${b}`),
        ...audit.secrets.map((s) => `secret ${s}`),
        ...audit.logGroups.map((l) => `log-group ${l}`),
        ...audit.ssmParameters.map((p) => `ssm ${p}`),
        ...audit.certificates.map((c) => `acm ${c}`),
        ...audit.ecrTags.map((t) => `ecr ${t}`),
      ];
    }
    out[region] = { runTagged, installations };
  }
  return out;
}

/** Runs items with bounded concurrency; `fn` returns false to stop handing out new items. */
async function pool<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<boolean>): Promise<void> {
  const queue = [...items];
  let stopped = false;
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined || stopped) return;
      if (!(await fn(item))) stopped = true;
    }
  });
  await Promise.all(workers);
}

/**
 * README "Stop conditions": a wave never continues past a repository whose
 * resources are not proven gone — the next attempt would build on an
 * account whose state is unknown, and leaks would accumulate.
 */
export function shouldStopWave(result: StageBResult): boolean {
  return result.cleanup.status === 'FAIL';
}

function writeSummaries(runsDir: string, sha: string): void {
  const all = readAllResults(runsDir);
  writeSummaryFiles(runsDir, all, buildStageBSummary(all, sha));
}

async function main(): Promise<number> {
  const options = parseRunArgs(process.argv.slice(2));
  const targets = loadTargets(RECIPES_DIR);
  const config = loadDeployConfig(DEPLOY_CONFIG_PATH);
  if (options.realAws) assertRealAwsRepos(config, targets);
  const sha = deployzSha();
  const existing = readAllResults(options.runsDir);
  const entries = selectForRun(targets, config, options, existing);

  if (options.dryRun) {
    console.log(renderPlan(buildPlan(entries, config, existing, options), options));
    return 0;
  }

  if (options.gate) {
    if (entries.length === 0) {
      console.error('No repositories selected.');
      return 1;
    }
    await runGateAudit(entries, config, options, sha);
    writeSummaries(options.runsDir, sha);
    console.log(`Wrote ${entries.length} result file(s) to ${options.runsDir}`);
    return 0;
  }

  requireRealAws(options, process.env);
  const canaryConfig: CanaryConfig = { ...loadConfig(process.env), ...(options.region ? { region: options.region } : {}) };
  const identity = await callerIdentity();
  if (identity.account !== canaryConfig.expectedAccountId) {
    throw new Error(`AWS account ${identity.account} is not the expected test account ${canaryConfig.expectedAccountId} — refusing to run`);
  }

  if (options.audit) {
    const audit = await auditAccount(canaryConfig, options.evidenceDir);
    console.log(JSON.stringify(audit, null, 2));
    const leaks = Object.values(audit).reduce((n, region) => n + region.runTagged.length + Object.values(region.installations).reduce((m, list) => m + list.length, 0), 0);
    console.log(leaks === 0 ? 'No Stage B resources left.' : `${leaks} resource(s) still attributable to Stage B.`);
    return leaks === 0 ? 0 : 1;
  }

  const api = await ensureVendor(options.evidenceDir, canaryConfig);
  const series: Series = { config: canaryConfig, api, sha };

  if (options.cleanup) {
    const ledgers = listUnfinishedLedgers(options.evidenceDir).filter((l) => options.ids.length === 0 || options.ids.includes(l.repoId));
    if (ledgers.length === 0) {
      console.log('Nothing to clean up.');
      return 0;
    }
    for (const ledger of ledgers) await cleanupLedger(series, options, ledger.runId);
    writeSummaries(options.runsDir, sha);
    return 0;
  }

  if (options.resume) {
    for (const ledger of listUnfinishedLedgers(options.evidenceDir)) await cleanupLedger(series, options, ledger.runId);
  }

  const health = await fetch(`${canaryConfig.apiUrl}/health`);
  if (health.status !== 200) throw new Error(`control plane ${canaryConfig.apiUrl}/health answered ${health.status}`);

  const plan = buildPlan(entries, config, existing, options);
  console.log(renderPlan(plan, options));
  const todo = plan.filter((line) => line.action !== 'skip-has-result');
  const failures: string[] = [];
  await pool(todo, options.concurrency, async (line) => {
    const entry = entries.find((e) => e.id === line.id)!;
    let keepGoing = true;
    try {
      const result = await runAttempt(series, options, config, entry);
      writeResult(options.runsDir, result, { force: options.force });
      if (shouldStopWave(result)) {
        keepGoing = false;
        failures.push(`${entry.id}: cleanup ${result.cleanup.status} — wave stopped (${result.cleanup.detail ?? 'see the result'}); run --cleanup --repo ${entry.id}, then --resume`);
      }
      console.log(`${entry.id}: ${result.classification}${result.rootCause ? ` (${result.rootCause})` : ''}`);
    } catch (error) {
      keepGoing = false;
      failures.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`${entry.id}: harness failure — ${error instanceof Error ? error.message : String(error)}`);
    }
    writeSummaries(options.runsDir, sha);
    return keepGoing;
  });
  if (failures.length > 0) {
    console.error(`\n${failures.length} harness failure(s):\n${failures.join('\n')}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
