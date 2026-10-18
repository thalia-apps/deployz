/**
 * B2–B6 for one repository against the deployed control plane and the test
 * AWS account — the product routes a vendor uses, the Quick Create a
 * customer runs, then an independent look at AWS and the live app.
 *
 * Every external call goes through `DeployDeps`, so the funnel's control
 * flow (ordering, stop conditions, cleanup in `finally`, classification)
 * is testable with fakes. The real wiring is `realDeps()` in index.ts.
 */
import { createHash, randomBytes } from 'node:crypto';

import { applicationStackNameForInstallation, releaseImageTag } from '@deployz/contracts';

import type { BenchmarkEntry } from '../repository-compatibility/manifest.js';
import type { Evidence } from '../version-canary/evidence.js';
import { ControlPlaneError, describeDeployment, waitFor, type DeploymentDetail, type DeploymentPlanView, type InfrastructureInventory } from '../version-canary/control-plane.js';
import { parseQuickCreateUrl } from '../version-canary/steps.js';
import { classifyFailure, type FailureEvidence, type FunnelPoint } from './classify.js';
import { APP_URL_TOKEN, appUrlKeys, providedKeys, secretKey, secretValue, type RepositoryConfig, type SecretFormat, type SmokeCheck } from './config.js';
import type { DependencyPresence, StoppedTask, TaskDefinitionEnv } from './evidence.js';
import { stoppedExit } from './evidence.js';
import { stageBRun } from './ledger.js';
import type { StageBResult } from './results.js';

const MINUTE = 60_000;

export interface Timeouts {
  analysisMs: number;
  buildMs: number;
  bootstrapMs: number;
  enrollMs: number;
  installMs: number;
  /** After a stack failure: how long to let the relay settle the INSTALL job before cleanup. */
  settleMs: number;
  pointerMs: number;
  httpsMs: number;
  /** After default HTTPS is ACTIVE: how long the health path may take to answer below 500 through the edge. */
  httpsReadyMs: number;
  /** How long the persisted infrastructure inventory may take to settle (missing/unexpected both empty) before the inventory gate fails. */
  inventoryMs: number;
}

export const DEFAULT_TIMEOUTS: Timeouts = {
  analysisMs: 10 * MINUTE,
  buildMs: 30 * MINUTE,
  bootstrapMs: 15 * MINUTE,
  enrollMs: 12 * MINUTE,
  installMs: 60 * MINUTE,
  settleMs: 20 * MINUTE,
  pointerMs: 20 * MINUTE,
  httpsMs: 45 * MINUTE,
  httpsReadyMs: 5 * MINUTE,
  inventoryMs: 5 * MINUTE,
};

/** CloudFormation states in which an install stack will never become healthy. */
export const STACK_TERMINAL_FAILURE = /^(ROLLBACK_COMPLETE|ROLLBACK_FAILED|CREATE_FAILED|DELETE_COMPLETE|DELETE_FAILED)$/;

/**
 * The vendor overrides that change what CodeBuild produces. Everything else a
 * vendor can set — port, health path, the infrastructure flags — shapes the
 * deployment, not the image, so it must not make a built image unreusable.
 */
const IMAGE_INPUT_OVERRIDES = [
  'appRoot',
  'dockerfilePath',
  'buildContext',
  'buildCommand',
  'startCommand',
  'migrationCommand',
] as const;

/**
 * The release version a `--reuse-application` attempt looks for and, failing
 * that, builds: one identity per (repository, pinned commit, image inputs).
 * Change any of those and the version changes, so a retry can never redeploy
 * an image that the current configuration would not have produced.
 */
export function reusableReleaseVersion(benchmark: BenchmarkEntry, config: RepositoryConfig): string {
  const inputs = IMAGE_INPUT_OVERRIDES.map(
    (key) => `${key}=${String(config.overrides?.[key] ?? '')}`,
  ).join('|');
  const fingerprint = createHash('sha256').update(inputs).digest('hex').slice(0, 8);
  return `${benchmark.id}-${benchmark.commit.slice(0, 7)}-${fingerprint}`;
}

/** Which attempt a version names within its family: the base is 1, `-r2` is 2. */
export function releaseAttempt(base: string, version: string): number | null {
  if (version === base) return 1;
  const suffix = version.startsWith(`${base}-r`) ? version.slice(base.length + 2) : null;
  return suffix && /^\d+$/.test(suffix) ? Number(suffix) : null;
}

/**
 * The image a retry can redeploy: the newest READY release built from these
 * same inputs. A first attempt takes the base name and later ones take
 * `-r2`, `-r3`, ..., so reuse has to match the whole family — matching only
 * the base name would rebuild every time the first attempt happened to fail.
 */
export function reusableRelease<T extends { version: string; status: string }>(
  base: string,
  releases: readonly T[],
): T | undefined {
  return releases
    .filter((release) => release.status === 'READY' && releaseAttempt(base, release.version) !== null)
    .sort((a, b) => releaseAttempt(base, a.version)! - releaseAttempt(base, b.version)!)
    .at(-1);
}

/**
 * A release version is unique per application, and an attempt whose build
 * failed still owns the name it took. A retry that cannot reuse the image
 * therefore has to mint the next name, or `createRelease` answers 409 and the
 * repository is wedged for every future attempt.
 */
export function nextReleaseVersion(base: string, taken: readonly { version: string }[]): string {
  const names = new Set(taken.map((release) => release.version));
  if (!names.has(base)) return base;
  for (let attempt = 2; ; attempt += 1) {
    const candidate = `${base}-r${attempt}`;
    if (!names.has(candidate)) return candidate;
  }
}

/** The vendor-side routes the funnel drives (a subset of the canary's ControlPlane). */
export interface ControlPlaneLike {
  request<T>(method: string, path: string, body?: unknown, options?: { headers?: Record<string, string>; allowStatus?: number[] }): Promise<{ status: number; body: T; headers: Headers }>;
  bindGithubInstallation(installationId: string): Promise<string>;
  createApplication(input: Record<string, unknown>): Promise<{ id: string }>;
  patchApplication(id: string, patch: Record<string, unknown>): Promise<void>;
  triggerAnalysis(id: string): Promise<void>;
  getReadiness(id: string): Promise<{ state: string; analysisStatus: string; findings: unknown[] }>;
  getApplication(id: string): Promise<Record<string, unknown>>;
  createRelease(applicationId: string, input: { version: string; gitSha: string; migrationCommand?: string }): Promise<{ id: string; version: string }>;
  listReleases(applicationId: string): Promise<{ id: string; version: string; status: string; failureReason: string | null }[]>;
  createCustomer(input: { name: string; email: string }): Promise<{ id: string }>;
  createDeployment(input: { applicationId: string; customerId: string; region: string }): Promise<{ id: string; installLinkId: string }>;
  getDeployment(id: string): Promise<DeploymentDetail>;
  getInstallInfo(installLinkId: string): Promise<{ quickCreateUrl: string | null; bootstrapStackName: string; deploymentId: string; alreadyInstalled: boolean }>;
  markInstallLaunched(installLinkId: string): Promise<{ state: string }>;
  events(deploymentId: string): Promise<{ eventType: string; jobId?: string | null }[]>;
  diagnostics(deploymentId: string): Promise<Record<string, unknown>>;
  infrastructure(deploymentId: string): Promise<InfrastructureInventory>;
  plan(deploymentId: string, action: 'install' | 'update' | 'destroy'): Promise<DeploymentPlanView>;
  deploy(deploymentId: string, releaseId: string): Promise<{ status: number; jobId: string; state: string }>;
}

export interface StackResourceLike {
  readonly logicalId?: string;
  readonly type: string;
  readonly status: string;
  readonly physicalId: string | null;
}

/** The customer-account reads and the one write (the customer's CreateStack). */
export interface AwsLike {
  createBootstrapStack(input: { stackName: string; templateUrl: string; parameters: Record<string, string>; runId: string }): Promise<string>;
  describeStack(stackName: string): Promise<{ status: string; statusReason: string | null; outputs: Record<string, string> } | null>;
  lambdaFunctionNames(stackName: string): Promise<string[]>;
  describeRunningService(stackName: string): Promise<{ desiredCount: number; runningCount: number; runningDigests: string[]; deployments: { status: string; rolloutState: string | null }[] } | null>;
  targetHealth(stackName: string): Promise<string[]>;
  albDnsName(stackName: string): Promise<string | null>;
  ecrDigestForTag(tag: string): Promise<string | null>;
  listStackResources(stackName: string): Promise<StackResourceLike[]>;
  describeStoppedTasks(stackName: string): Promise<StoppedTask[]>;
  tailApplicationLogs(stackName: string): Promise<string[]>;
  describeDependencies(stackName: string): Promise<DependencyPresence>;
  describeTaskDefinitionEnv(stackName: string): Promise<TaskDefinitionEnv | null>;
}

export interface Probe {
  (url: string): Promise<{ status: number | null; error?: string }>;
}

export interface ProbeBody {
  (url: string): Promise<{ status: number | null; body: string; error?: string }>;
}

export interface DeployDeps {
  api: ControlPlaneLike;
  aws: AwsLike;
  probe: Probe;
  probeBody: ProbeBody;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  region: string;
  githubInstallationId: string;
  timeouts: Timeouts;
  /** Leaves the environment in place after verification (debugging only). */
  keep: boolean;
  generateSecret?: ((format: SecretFormat) => string) | undefined;
  pollIntervalMs?: number | undefined;
  /**
   * Retries reuse the repository's application instead of a fresh one, so a
   * release an earlier attempt already built can be redeployed rather than
   * rebuilt (`--reuse-application`). Off by default: a repository's first
   * attempt must exercise the create-application path like a real vendor.
   */
  reuseApplication?: boolean | undefined;
  /** `--exercise-update`: after the smoke contract passes, build and deploy a second release and re-run it. */
  exerciseUpdate?: boolean | undefined;
}

export interface RepositoryAttemptInput {
  benchmark: BenchmarkEntry;
  config: RepositoryConfig;
  repositoryUsed: string;
  repositoryForm: 'original' | 'fork';
  evidence: Evidence;
  /** The result document to fill; the caller persists it. */
  result: StageBResult;
  /**
   * The application an earlier attempt of this repository created, when
   * `--reuse-application` is on. Its releases are what make image reuse
   * possible; the funnel still re-runs analysis and re-applies overrides.
   */
  existingApplicationId?: string | undefined;
}

export class FunnelStop extends Error {
  constructor(
    readonly point: FunnelPoint,
    message: string,
    readonly extra: Partial<FailureEvidence> = {},
  ) {
    super(message);
  }
}

function assert(condition: unknown, point: FunnelPoint, message: string, extra: Partial<FailureEvidence> = {}): asserts condition {
  if (!condition) throw new FunnelStop(point, message, extra);
}

function digestSuffix(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = value.lastIndexOf('@');
  return at >= 0 ? value.slice(at + 1) : value;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && /^Timed out after/.test(error.message);
}

/** Runs one funnel step, translating a timeout into a FunnelStop at that point. */
async function step<T>(point: FunnelPoint, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof FunnelStop) throw error;
    if (isTimeout(error)) throw new FunnelStop(point, error instanceof Error ? error.message : String(error), { timedOut: true });
    if (error instanceof ControlPlaneError) throw new FunnelStop(point, error.message, {});
    throw new FunnelStop('harness', error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
}

/** The health path to probe and where it came from (README "Health-path precedence"). */
export function resolveHealthPath(config: RepositoryConfig, manifestPath: string | null, manifestMode: string | null, benchmarkNotesPath: string | undefined): { path: string; source: NonNullable<StageBResult['runtime']['healthPathSource']> } {
  const configured = config.verify?.healthPath ?? config.overrides?.healthPath;
  if (configured) return { path: configured, source: 'stage-b' };
  if (manifestPath && manifestMode !== 'vendor_required') return { path: manifestPath, source: 'manifest' };
  if (benchmarkNotesPath) return { path: benchmarkNotesPath, source: 'repository-evidence' };
  return { path: '/', source: 'fallback' };
}

/** Per-CloudFormation-type resource counts, for the result's `deployment.resourcesByType`. */
function countByType(resources: readonly StackResourceLike[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const resource of resources) out[resource.type] = (out[resource.type] ?? 0) + 1;
  return out;
}

/** The catalog kind → CloudFormation resource type(s) whose COMPLETE presence proves it exists
 * (packages/contracts/src/components.ts; cache accepts the legacy single-node type too). */
const KIND_TO_AWS_TYPES: Record<string, readonly string[]> = {
  application: ['AWS::ECS::Service'],
  endpoint: ['AWS::ElasticLoadBalancingV2::LoadBalancer'],
  database: ['AWS::RDS::DBInstance'],
  cache: ['AWS::ElastiCache::ReplicationGroup', 'AWS::ElastiCache::CacheCluster'],
  storage: ['AWS::S3::Bucket'],
  queue: ['AWS::SQS::Queue'],
  schedule: ['AWS::Scheduler::Schedule'],
};

/** Plan presentation kinds that are not inventory catalog kinds. The plan's
 * `worker` role (a background worker or a one-shot scheduled task) is ECS
 * compute the inventory classifies as `application`, and `worker` is not a
 * member of the inventory kind enum at all. */
const INVENTORY_KIND_BY_PLAN_KIND: Readonly<Record<string, string>> = {
  worker: 'application',
};

/** Evaluates one smoke check against a probe result — pure, so retries just call it again. */
export function evaluateSmokeCheck(
  check: SmokeCheck,
  probe: { status: number | null; body: string; error?: string },
): { status: number | null; ok: boolean; detail: string } {
  const statuses = Array.isArray(check.status) ? check.status : [check.status];
  if (probe.status === null) return { status: null, ok: false, detail: `no response${probe.error ? `: ${probe.error}` : ''}` };
  if (!statuses.includes(probe.status)) return { status: probe.status, ok: false, detail: `status ${probe.status}, expected ${statuses.join('/')}` };
  if (check.bodyIncludes !== undefined && !probe.body.includes(check.bodyIncludes)) {
    return { status: probe.status, ok: false, detail: `body does not include "${check.bodyIncludes}"` };
  }
  if (check.jsonPath !== undefined) {
    let json: unknown;
    try {
      json = JSON.parse(probe.body);
    } catch {
      return { status: probe.status, ok: false, detail: 'response body is not valid JSON' };
    }
    const value = jsonPathValue(json, check.jsonPath);
    if (check.jsonEquals !== undefined) {
      if (value !== check.jsonEquals) {
        return { status: probe.status, ok: false, detail: `${check.jsonPath} is ${JSON.stringify(value)}, expected ${JSON.stringify(check.jsonEquals)}` };
      }
    } else if (value === undefined || value === null) {
      return { status: probe.status, ok: false, detail: `${check.jsonPath} is missing or null` };
    }
  }
  return { status: probe.status, ok: true, detail: 'ok' };
}

function jsonPathValue(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), value);
}

/** Runs every configured smoke check against `baseUrl`, retrying a failing one before giving up on it. */
async function runSmokeChecks(deps: DeployDeps, checks: readonly SmokeCheck[], baseUrl: string): Promise<StageBResult['runtime']['smoke']> {
  const outcomes: StageBResult['runtime']['smoke'] = [];
  for (const check of checks) {
    if (check.graceSeconds > 0) await deps.sleep(check.graceSeconds * 1000);
    const url = `${baseUrl}${check.path}`;
    let evaluated: { status: number | null; ok: boolean; detail: string } = { status: null, ok: false, detail: 'not run' };
    const attempts = check.retries + 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const probe = await deps.probeBody(url);
      evaluated = evaluateSmokeCheck(check, probe);
      if (evaluated.ok || attempt === attempts) break;
      await deps.sleep(check.retryDelaySeconds * 1000);
    }
    outcomes.push({ path: check.path, status: evaluated.status, ok: evaluated.ok, detail: evaluated.detail, exercises: check.exercises ?? [] });
  }
  return outcomes;
}

/**
 * A smoke check that exercises a dependency and fails marks that dependency
 * FAIL in the result — a passing check leaves the binding check's own verdict
 * alone (README item 6: "do not weaken the existing binding check"). Returns
 * the failing outcomes, for the caller's assert.
 */
function applySmokeFailuresToDependencies(result: StageBResult, outcomes: StageBResult['runtime']['smoke']): StageBResult['runtime']['smoke'] {
  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length > 0) {
    for (const outcome of failed) {
      for (const dep of outcome.exercises) result.dependencies[dep] = 'FAIL';
    }
    result.dependencies.detail = failed.map((f) => `${f.path}: ${f.detail}`).join('; ');
  }
  return failed;
}

/**
 * The whole funnel for one repository. Never throws for a product outcome:
 * the result carries the classification. Throws only when the harness
 * itself cannot continue (after recording TEST_HARNESS_ERROR).
 */
export async function runRepositoryAttempt(deps: DeployDeps, input: RepositoryAttemptInput): Promise<StageBResult> {
  const { benchmark, config, evidence, result } = input;
  const run = stageBRun(evidence);
  const started = deps.now();
  result.timing.startedAt = new Date(started).toISOString();
  result.repositoryUsed = input.repositoryUsed;
  result.repositoryForm = input.repositoryForm;
  evidence.save();

  const interval = deps.pollIntervalMs ?? 20_000;
  let point: FunnelPoint = 'gate';

  try {
    // ── Application + analysis ──────────────────────────────────────────
    const applicationId = await step('gate', () =>
      evidence.step('Application and analysis', async (details) => {
        await deps.api.bindGithubInstallation(deps.githubInstallationId);
        const created = input.existingApplicationId
          ? { id: input.existingApplicationId }
          : await deps.api.createApplication({
              name: `stage-b-${benchmark.id}`,
              githubInstallationId: deps.githubInstallationId,
              repoFullName: input.repositoryUsed,
              repoUrl: `https://github.com/${input.repositoryUsed}`,
              defaultBranch: benchmark.commit,
            });
        details['applicationReused'] = Boolean(input.existingApplicationId);
        run.applicationId = created.id;
        evidence.save();
        details['applicationId'] = created.id;
        if (config.overrides && Object.keys(config.overrides).length > 0) {
          await deps.api.patchApplication(created.id, config.overrides);
          details['overrides'] = config.overrides;
        }
        await deps.api.triggerAnalysis(created.id);
        const readiness = await waitFor(
          'analysis',
          () => deps.api.getReadiness(created.id),
          (r) => (r.analysisStatus === 'COMPLETE' || r.analysisStatus === 'FAILED' ? r : null),
          { timeoutMs: deps.timeouts.analysisMs, intervalMs: Math.min(interval, 15_000), describe: (r) => `${r.analysisStatus}/${r.state}` },
        );
        details['readiness'] = { state: readiness.state, analysisStatus: readiness.analysisStatus, findings: readiness.findings.length };
        assert(readiness.analysisStatus === 'COMPLETE', 'gate', `analysis ended ${readiness.analysisStatus}`);
        result.gate.source = result.gate.source === 'in-process' ? 'both' : 'control-plane';
        return created.id;
      }),
    );

    // ── Configuration ───────────────────────────────────────────────────
    point = 'configuration';
    const keys = providedKeys(config);
    const generated = (config.secrets ?? []).map(secretKey);
    result.configuration.overrides = { ...(config.overrides ?? {}) };
    result.configuration.keys = keys;
    result.configuration.generatedKeys = generated;
    run.stageB.keys = keys;
    run.stageB.generatedKeys = generated;
    evidence.save();
    // Kept only for this attempt, in memory: a value typed at the vendor
    // scope before any deployment exists is dropped by the control plane
    // (BUG-004 / DEPLOY-027), so it is re-delivered at the customer scope
    // once the connector enrolls. Never written to the ledger, result or logs.
    const secretEntries = (config.secrets ?? []).map((spec) => ({ key: secretKey(spec), value: secretValue(spec, deps.generateSecret ?? generateSecret), isSecret: true as const }));
    const preflight = await step('configuration', () =>
      evidence.step('Vendor configuration and preflight', async (details) => {
        const entries = [
          ...(config.config ?? []).map((value) => ({ key: value.key, value: value.value.replaceAll(APP_URL_TOKEN, APP_URL_PLACEHOLDER), isSecret: false })),
          ...secretEntries,
        ];
        if (entries.length > 0) {
          await deps.api.request('PUT', `/api/applications/${applicationId}/config`, { entries });
          details['keys'] = keys;
        }
        const { body } = await deps.api.request<{ state: string; ready: boolean; blockers: { id: string; message: string }[]; warnings: { id: string; message: string }[] }>(
          'GET',
          `/api/applications/${applicationId}/preflight`,
        );
        details['preflight'] = { state: body.state, ready: body.ready, blockers: body.blockers.map((b) => b.id), warnings: body.warnings.map((w) => w.id), blockerMessages: body.blockers.map((b) => ({ id: b.id, message: b.message })), warningMessages: body.warnings.map((w) => ({ id: w.id, message: w.message })) };
        return body;
      }),
    );
    const expectedDeployable = result.expectedDeployable;
    if (!preflight.ready) {
      const verdict = (preflight.state as 'READY' | 'NEEDS_CONFIGURATION' | 'NOT_COMPATIBLE' | null) ?? null;
      const blockers = preflight.blockers.map((b) => `${b.id}: ${b.message}`).join('; ');
      if (verdict === 'NOT_COMPATIBLE' || !expectedDeployable) {
        throw new FunnelStop('gate', `the control plane's gate refuses: ${blockers}`, { gateVerdict: verdict });
      }
      throw new FunnelStop('configuration', `the control plane's gate still needs configuration: ${blockers}`, { gateVerdict: verdict });
    }
    result.configuration.status = 'PASS';
    result.gate.status = result.gate.status === 'NOT_ATTEMPTED' ? 'PASS' : result.gate.status;
    if (!expectedDeployable) {
      // A false acceptance: the funnel stops here — no AWS resources for an expected-unsupported repository.
      throw new FunnelStop('gate', 'the control plane accepted an expected-unsupported repository', { gateVerdict: (preflight.state as 'READY' | 'NEEDS_CONFIGURATION' | 'NOT_COMPATIBLE' | null) ?? null });
    }

    // ── Build ───────────────────────────────────────────────────────────
    point = 'build';
    const buildStarted = deps.now();
    const release = await step('build', () =>
      evidence.step('Release build through CodeBuild', async (details) => {
        // Without reuse, one release per attempt. With it, the version is
        // derived from the pinned commit and the build-affecting overrides, so
        // a retry of the same inputs finds the release an earlier attempt
        // built — and any change to those inputs mints a different version
        // rather than silently redeploying a stale image.
        const releases = deps.reuseApplication ? await deps.api.listReleases(applicationId) : [];
        const base = deps.reuseApplication
          ? reusableReleaseVersion(benchmark, config)
          : `${benchmark.id}-${run.runId.slice('stage-b-'.length + benchmark.id.length + 1)}`;
        const existing = deps.reuseApplication ? reusableRelease(base, releases) : undefined;
        // Reuse keeps the name it found; a rebuild takes the next one,
        // because the attempt that failed still owns the name it took.
        const version = existing ? existing.version : nextReleaseVersion(base, releases);
        if (existing) console.log(`  reusing release ${version} (${existing.id}) — no CodeBuild run`);
        const created = existing
          ? { id: existing.id, version }
          : await deps.api.createRelease(applicationId, {
              version,
              gitSha: benchmark.commit,
              ...(config.overrides?.migrationCommand ? { migrationCommand: config.overrides.migrationCommand } : {}),
            });
        result.build.imageReused = Boolean(existing);
        details['imageReused'] = Boolean(existing);
        run.releases['release'] = { id: created.id, version, gitSha: benchmark.commit };
        evidence.save();
        result.build.releaseId = created.id;
        result.build.version = version;
        result.build.gitSha = benchmark.commit;
        const application = await deps.api.getApplication(applicationId);
        const metadata = (application['detectedMetadata'] ?? {}) as Record<string, unknown>;
        const overrides = (metadata['manifestOverrides'] ?? {}) as Record<string, unknown>;
        result.build.dockerfilePath = (overrides['dockerfilePath'] as string | undefined) ?? (metadata['dockerfilePath'] as string | undefined) ?? 'Dockerfile';
        result.build.buildContext = (overrides['buildContext'] as string | undefined) ?? null;
        details['release'] = { id: created.id, version, dockerfilePath: result.build.dockerfilePath, buildContext: result.build.buildContext };
        const settled = await waitFor(
          `release ${version} build`,
          async () => (await deps.api.listReleases(applicationId)).find((r) => r.id === created.id),
          (r) => (r && r.status !== 'BUILDING' ? r : null),
          { timeoutMs: deps.timeouts.buildMs, intervalMs: interval, describe: (r) => r?.status ?? 'missing' },
        );
        details['buildStatus'] = settled.status;
        details['failureReason'] = settled.failureReason;
        result.build.durationMs = deps.now() - buildStarted;
        assert(settled.status === 'READY', 'build', `release build ${settled.status}: ${settled.failureReason ?? ''}`, { releaseFailure: settled.failureReason });
        // The pipeline namespaces the tag by application, so the lookup and
        // the cleanup that follows must compose it the same way.
        const imageTag = releaseImageTag(applicationId, version);
        run.releases['release']!.imageTag = imageTag;
        const digest = await deps.aws.ecrDigestForTag(imageTag);
        assert(digest, 'build', `ECR has no image tagged ${imageTag}`, { releaseFailure: 'image missing after a READY build' });
        run.releases['release']!.imageDigest = digest;
        evidence.save();
        result.build.imageDigest = digest;
        details['imageDigest'] = digest;
        return { id: created.id, version, digest };
      }),
    );
    result.build.status = 'PASS';

    // ── Deployment + install ────────────────────────────────────────────
    point = 'install';
    const installStarted = deps.now();
    const deploymentId = await step('install', () =>
      evidence.step('Customer deployment, install link and the customer Quick Create', async (details) => {
        const customer = await deps.api.createCustomer({
          name: `Stage B ${benchmark.id}`,
          email: `customer-${run.runId.toLowerCase()}@deployz-stage-b.example.com`,
        });
        run.customerId = customer.id;
        evidence.save();
        let deployment: { id: string; installLinkId: string };
        try {
          deployment = await deps.api.createDeployment({ applicationId, customerId: customer.id, region: deps.region });
        } catch (error) {
          if (error instanceof ControlPlaneError && error.status === 422) {
            const code = error.code ?? '';
            throw new FunnelStop(code === 'MANIFEST_NOT_COMPATIBLE' ? 'gate' : 'configuration', error.message, {
              gateVerdict: code === 'MANIFEST_NOT_COMPATIBLE' ? 'NOT_COMPATIBLE' : 'NEEDS_CONFIGURATION',
            });
          }
          throw error;
        }
        run.deploymentId = deployment.id;
        run.installLinkId = deployment.installLinkId;
        run.stageB.cleanupNeeded = true;
        evidence.save();
        result.deployment.deploymentId = deployment.id;
        details['deploymentId'] = deployment.id;

        // Values that carry the deployment's own address are written at the
        // customer scope now that the permanent hostname is known — what a
        // vendor does after creating the deployment and reading its URL.
        const urlKeys = appUrlKeys(config);
        if (urlKeys.length > 0) {
          const appUrl = defaultDeploymentUrl(deployment.id);
          await deps.api.request('PUT', `/api/applications/${applicationId}/config`, {
            customerId: customer.id,
            entries: (config.config ?? [])
              .filter((value) => urlKeys.includes(value.key))
              .map((value) => ({ key: value.key, value: value.value.replaceAll(APP_URL_TOKEN, appUrl), isSecret: false })),
          });
          details['appUrlKeys'] = urlKeys;
        }

        const info = await deps.api.getInstallInfo(deployment.installLinkId);
        assert(info.quickCreateUrl, 'harness', 'install link carries no Quick Create URL (bootstrap template unpublished?)');
        const quick = parseQuickCreateUrl(info.quickCreateUrl);
        details['quickCreate'] = { templateUrl: quick.templateUrl, stackName: quick.stackName, parameters: Object.keys(quick.parameters) };
        const launched = await deps.api.markInstallLaunched(deployment.installLinkId);
        assert(launched.state === 'WAITING_FOR_RELAY', 'harness', `launched -> ${launched.state}`);
        const stackId = await deps.aws.createBootstrapStack({
          stackName: quick.stackName,
          templateUrl: quick.templateUrl,
          parameters: quick.parameters,
          runId: run.runId,
        });
        run.bootstrapStackName = quick.stackName;
        evidence.save();
        result.deployment.bootstrapStack = quick.stackName;
        details['bootstrapStackId'] = stackId;
        return deployment.id;
      }),
    );

    await step('install', () =>
      evidence.step('Bootstrap stack creates and the connector enrolls', async (details) => {
        const stackName = run.bootstrapStackName!;
        const stack = await waitFor(
          `bootstrap stack ${stackName}`,
          () => deps.aws.describeStack(stackName),
          (s) => (s && !s.status.endsWith('IN_PROGRESS') ? s : null),
          { timeoutMs: deps.timeouts.bootstrapMs, intervalMs: interval, describe: (s) => s?.status ?? 'absent' },
        );
        details['bootstrapStackStatus'] = stack.status;
        assert(stack.status === 'CREATE_COMPLETE', 'install', `bootstrap stack ${stack.status}: ${stack.statusReason ?? ''}`, { stackStatus: stack.status });
        const installationId = stack.outputs['InstallationId'];
        assert(installationId, 'harness', 'bootstrap stack has no InstallationId output');
        run.installationId = installationId;
        run.applicationStackName = applicationStackNameForInstallation(installationId);
        run.bootstrapLambdaNames = await deps.aws.lambdaFunctionNames(stackName);
        evidence.save();
        result.deployment.installationId = installationId;
        result.deployment.applicationStack = run.applicationStackName;
        details['installationId'] = installationId;
        const enrolled = await waitFor(
          'relay enrollment',
          () => deps.api.getDeployment(deploymentId),
          (d) => (d.installationId ? d : null),
          { timeoutMs: deps.timeouts.enrollMs, intervalMs: interval, describe: describeDeployment },
        );
        assert(enrolled.installationId === installationId, 'harness', `control plane bound installation ${enrolled.installationId}`);
      }),
    );

    if (secretEntries.length > 0) {
      point = 'secrets-delivery';
      await step('secrets-delivery', () =>
        evidence.step('Deliver vendor secrets to the connected customer', async (details) => {
          // The vendor-scope PUT above only satisfies the gate; the connected
          // relay is the only recipient the CONFIG_UPDATE fan-out has, and a
          // delivered value wins over a minted one (BUG-004 / DEPLOY-027).
          await deps.api.request('PUT', `/api/applications/${applicationId}/config`, {
            customerId: run.customerId,
            entries: secretEntries,
          });
          const deliveredKeys = secretEntries.map((entry) => entry.key);
          details['keys'] = deliveredKeys;
          result.configuration.deliveredAfterEnrollment = deliveredKeys;
        }),
      );
      point = 'install';
    }

    const installed = await step('install', () =>
      evidence.step('INSTALL provisions the application stack', async (details) => {
        // The deployment settles when the product says so, or when the
        // application stack has reached a terminal failure state: a rolled-back
        // stack is a settled outcome even while the relay's INSTALL job is
        // still reporting it, and a later Disconnect must not race that job.
        // The rollback of a failed install deletes the cluster and the log
        // group with it, so the only record of why a container died is what a
        // poll sees while the stack is still in progress. Keep the last
        // non-empty snapshot for the classification.
        const seen: { snapshot: { stoppedTasks: StoppedTask[]; logTail: string[] } | null } = { snapshot: null };
        const { detail, stackStatus } = await waitFor(
          'install',
          async () => {
            const current = await deps.api.getDeployment(deploymentId);
            const status = (await deps.aws.describeStack(run.applicationStackName!))?.status ?? null;
            if (status?.endsWith('IN_PROGRESS')) {
              const stopped = await deps.aws.describeStoppedTasks(run.applicationStackName!).catch(() => []);
              if (stopped.length > 0) {
                const logTail = await deps.aws.tailApplicationLogs(run.applicationStackName!).catch(() => []);
                seen.snapshot = { stoppedTasks: stopped, logTail: logTail.length > 0 ? logTail : (seen.snapshot?.logTail ?? []) };
              }
            }
            return { detail: current, stackStatus: status };
          },
          (o) =>
            o.detail.state === 'HEALTHY' || o.detail.state === 'UPDATE_AVAILABLE' || o.detail.state === 'FAILED' || (o.stackStatus !== null && STACK_TERMINAL_FAILURE.test(o.stackStatus))
              ? o
              : null,
          { timeoutMs: deps.timeouts.installMs, intervalMs: interval, describe: (o) => `${o.stackStatus ?? 'no stack'} ${describeDeployment(o.detail)}` },
        );
        if (detail.state !== 'HEALTHY' && detail.state !== 'UPDATE_AVAILABLE' && detail.state !== 'FAILED') {
          // The stack failed before the product reported it: give the relay's
          // next polls a bounded chance to settle the job so cleanup finds an
          // idle deployment.
          await waitFor(
            'install job to settle after the stack failure',
            () => deps.api.getDeployment(deploymentId),
            (d) => (d.state === 'FAILED' || d.jobs.every((j) => j.state !== 'RUNNING' && j.state !== 'QUEUED' && j.state !== 'REQUESTED' && j.state !== 'WAITING') ? d : null),
            { timeoutMs: deps.timeouts.settleMs, intervalMs: interval, describe: describeDeployment },
          ).catch(() => undefined);
        }
        const installJob = detail.jobs.find((j) => j.type === 'INSTALL');
        result.deployment.installJobState = installJob?.state ?? null;
        result.deployment.failureCode = detail.deploymentStatus.failure?.code ?? null;
        details['deployment'] = summarize(detail);
        const appStack = await deps.aws.describeStack(run.applicationStackName!);
        result.deployment.stackStatus = appStack?.status ?? stackStatus;
        details['applicationStackStatus'] = appStack?.status ?? 'absent';
        const observed = seen.snapshot;
        details['stoppedTasksDuringInstall'] = observed?.stoppedTasks.length ?? 0;
        if (observed) {
          details['observedStoppedTasks'] = observed.stoppedTasks;
          details['observedLogTail'] = observed.logTail;
        }
        assert(detail.state !== 'FAILED' && !(appStack?.status && STACK_TERMINAL_FAILURE.test(appStack.status)), 'install', `install ${detail.state === 'FAILED' ? 'FAILED' : `stack ${appStack?.status}`}: ${detail.deploymentStatus.failure?.message ?? detail.deploymentStatus.failure?.code ?? 'no reason'}`, {
          failureCode: detail.deploymentStatus.failure?.code ?? null,
          stackStatus: appStack?.status ?? null,
          ...(observed
            ? {
                stoppedTasks: observed.stoppedTasks.map((t) => ({ ...stoppedExit(t.containers), stoppedReason: t.stoppedReason })),
                logTail: observed.logTail,
              }
            : {}),
        });
        assert(appStack?.status === 'CREATE_COMPLETE' || appStack?.status === 'UPDATE_COMPLETE', 'install', `application stack ${appStack?.status ?? 'absent'}`, { stackStatus: appStack?.status ?? null });
        // Once the application stack is CREATE_COMPLETE, snapshot both stacks'
        // resources into the ledger — the machine-readable manifest the
        // inventory gate cross-checks the plan against, without another AWS call.
        const resources = await deps.aws.listStackResources(run.applicationStackName!);
        const bootstrapResources = run.bootstrapStackName ? await deps.aws.listStackResources(run.bootstrapStackName) : [];
        run.stageB.resources = { applicationStack: resources, bootstrapStack: bootstrapResources };
        evidence.save();
        result.deployment.resourceCount = resources.length;
        result.deployment.resourcesByType = countByType(resources);
        result.deployment.region = deps.region;
        result.deployment.durationMs = deps.now() - installStarted;
        return detail;
      }),
    );
    result.deployment.status = 'PASS';

    // ── The release becomes the serving image ──────────────────────────
    point = 'auto-deploy';
    await step('auto-deploy', () =>
      evidence.step('The built release is the serving image', async (details) => {
        const detail = await waitFor(
          'release pointer',
          () => deps.api.getDeployment(deploymentId),
          (d) => (d.currentReleaseId === release.id || d.state === 'FAILED' ? d : null),
          { timeoutMs: deps.timeouts.pointerMs, intervalMs: interval, describe: describeDeployment },
        );
        details['deployment'] = summarize(detail);
        const deployJob = [...detail.jobs].reverse().find((j) => j.type === 'DEPLOY_RELEASE');
        if (deployJob) details['deployJob'] = { id: deployJob.id, state: deployJob.state, failureCode: deployJob.failureCode };
        const failedJob = deployJob && deployJob.state === 'FAILED';
        assert(!failedJob && detail.state !== 'FAILED', 'auto-deploy', `deploy of the release ${deployJob?.state ?? detail.state}: ${detail.deploymentStatus.failure?.message ?? ''}`, {
          failureCode: deployJob?.failureCode ?? detail.deploymentStatus.failure?.code ?? null,
          migrationFailed: deployJob?.failureCode === 'MIGRATION_FAILED',
        });
        assert(detail.currentReleaseId === release.id, 'auto-deploy', `currentReleaseId is ${detail.currentReleaseId}, expected ${release.id}`);
        result.runtime.runningImageDigest = detail.runningImageDigest;
        result.runtime.releaseServing = digestSuffix(detail.runningImageDigest) === digestSuffix(release.digest);
        assert(result.runtime.releaseServing, 'auto-deploy', `control plane observed digest ${detail.runningImageDigest}, expected ${release.digest}`);
        const service = await deps.aws.describeRunningService(run.applicationStackName!);
        details['ecs'] = service;
        assert(service && service.runningDigests.length === 1 && service.runningDigests[0] === digestSuffix(release.digest), 'auto-deploy', `ECS runs ${service?.runningDigests.join(', ') ?? 'nothing'}, expected the release digest`);
        if (deployJob) result.dependencies.migration = deployJob.failureCode === 'MIGRATION_FAILED' ? 'FAIL' : result.dependencies.migration;
      }),
    );
    void installed;

    // ── Plan-versus-actual inventory ────────────────────────────────────
    point = 'inventory';
    await step('inventory', () =>
      evidence.step('Plan-versus-actual inventory', async (details) => {
        const inventory = await waitFor(
          'infrastructure expectations',
          () => deps.api.infrastructure(deploymentId),
          (i) => (i.expectations && i.expectations.missing.length === 0 && i.expectations.unexpected.length === 0 ? i : null),
          {
            timeoutMs: deps.timeouts.inventoryMs,
            intervalMs: interval,
            describe: (i) => (i.expectations ? `missing=[${i.expectations.missing.join(',')}] unexpected=[${i.expectations.unexpected.join(',')}]` : 'no expectations yet'),
          },
        );
        details['infrastructure'] = { snapshotState: inventory.snapshotState, expectations: inventory.expectations };
        const expectedKinds = (inventory.expectations?.components ?? []).filter((c) => c.expected).map((c) => c.kind).sort();
        const plan = await deps.api.plan(deploymentId, 'install');
        // The plan and the inventory are two taxonomies: a separate worker is a
        // second `application` component, and the plan's `worker` role (a
        // background worker or a one-shot scheduled task) is ECS compute the
        // inventory classifies as `application`. Fold it, then compare sets,
        // not lists.
        const planCreateKinds = [...new Set(plan.components.filter((c) => c.action === 'CREATE').map((c) => INVENTORY_KIND_BY_PLAN_KIND[c.kind] ?? c.kind))].sort();
        details['planCreateKinds'] = planCreateKinds;
        details['expectedKinds'] = expectedKinds;
        result.inventory.planCreateKinds = planCreateKinds;
        result.inventory.expectedKinds = expectedKinds;
        assert(
          planCreateKinds.length === expectedKinds.length && planCreateKinds.every((k) => expectedKinds.includes(k)),
          'inventory',
          `plan CREATE kinds [${planCreateKinds.join(',')}] do not match the expected kinds [${expectedKinds.join(',')}]`,
        );

        // Cross-check against the resource snapshot taken during install — no new AWS call.
        const presentTypes = [...new Set((run.stageB.resources?.applicationStack ?? []).map((r) => r.type))];
        details['presentTypes'] = presentTypes;
        result.inventory.presentTypes = presentTypes;
        const missing: string[] = [];
        const unexpected: string[] = [];
        for (const [kind, types] of Object.entries(KIND_TO_AWS_TYPES)) {
          const shouldExist = planCreateKinds.includes(kind);
          const exists = types.some((type) => presentTypes.includes(type));
          if (shouldExist && !exists) missing.push(kind);
          if (!shouldExist && exists) unexpected.push(kind);
        }
        result.inventory.missing = missing;
        result.inventory.unexpected = unexpected;
        details['missing'] = missing;
        details['unexpected'] = unexpected;
        assert(missing.length === 0 && unexpected.length === 0, 'inventory', `application stack resources do not match the plan: missing [${missing.join(',')}] unexpected [${unexpected.join(',')}]`);
        result.inventory.status = 'PASS';
      }),
    );

    // ── Runtime health + HTTPS + observation ───────────────────────────
    point = 'runtime';
    const application = await deps.api.getApplication(applicationId);
    const manifestHealthPath = (application['healthPath'] as string | null | undefined) ?? null;
    const metadata = (application['detectedMetadata'] ?? {}) as Record<string, unknown>;
    const healthMode = typeof metadata['healthMode'] === 'string' ? metadata['healthMode'] : null;
    const health = resolveHealthPath(config, manifestHealthPath, healthMode, undefined);
    result.runtime.healthPath = health.path;
    result.runtime.healthPathSource = health.source;
    const alb = await deps.aws.albDnsName(run.applicationStackName!);
    assert(alb, 'harness', 'application stack has no load balancer');
    run.albEndpoint = `http://${alb}`;
    evidence.save();

    await step('runtime', () =>
      evidence.step('ECS and ALB report healthy, the health path answers over HTTP', async (details) => {
        const service = await deps.aws.describeRunningService(run.applicationStackName!);
        result.runtime.ecs = service && service.runningCount >= service.desiredCount && service.desiredCount > 0 && service.deployments.every((d) => d.rolloutState !== 'FAILED') ? 'HEALTHY' : 'UNHEALTHY';
        const targets = await deps.aws.targetHealth(run.applicationStackName!);
        result.runtime.alb = targets.length > 0 && targets.every((t) => t === 'healthy') ? 'HEALTHY' : 'UNHEALTHY';
        details['ecs'] = service;
        details['targets'] = targets;
        const probe = await deps.probe(`${run.albEndpoint}${health.path}`);
        details['httpHealth'] = probe;
        assert(result.runtime.ecs === 'HEALTHY', 'runtime', `ECS not healthy: ${JSON.stringify(service)}`, { targetHealth: targets, healthStatuses: [probe.status] });
        assert(result.runtime.alb === 'HEALTHY', 'runtime', `ALB targets: ${targets.join(', ')}`, { targetHealth: targets, healthStatuses: [probe.status] });
        assert(probe.status !== null && probe.status < 500, 'runtime', `health path ${health.path} answered ${probe.status ?? probe.error} over HTTP`, { healthStatuses: [probe.status] });
      }),
    );

    point = 'https';
    const appUrl = await step('https', () =>
      evidence.step('Default HTTPS becomes ACTIVE', async (details) => {
        const detail = await waitFor(
          'default HTTPS',
          () => deps.api.getDeployment(deploymentId),
          (d) => {
            const https = (d as unknown as { defaultHttps?: { status?: string; hostname?: string } | null }).defaultHttps;
            return https?.status === 'ACTIVE' || https?.status === 'ERROR' ? d : null;
          },
          { timeoutMs: deps.timeouts.httpsMs, intervalMs: interval, describe: (d) => `${(d as unknown as { defaultHttps?: { status?: string } | null }).defaultHttps?.status ?? 'none'} ${describeDeployment(d)}` },
        );
        const https = (detail as unknown as { defaultHttps?: { status?: string; hostname?: string; lastError?: string | null } | null }).defaultHttps;
        details['defaultHttps'] = https;
        assert(https?.status === 'ACTIVE', 'https', `default HTTPS ${https?.status ?? 'none'}: ${https?.lastError ?? ''}`, { httpsStatus: https?.status ?? null });
        const url = `https://${https.hostname}`;
        assert(appUrlKeys(config).length === 0 || url === defaultDeploymentUrl(deploymentId), 'harness', `the configured app URL ${defaultDeploymentUrl(deploymentId)} differs from the issued hostname ${url}`);
        result.runtime.appUrl = url;
        details['appUrl'] = url;
        // ACTIVE is the product's word; the edge in front of the ALB can lag
        // it by a sample (docuseal: a 521, then 200s). Wait a bounded time for
        // the health path to answer below 500 and record the lag as evidence,
        // so the observation window measures stability, not propagation.
        const activeAt = deps.now();
        const healthUrl = `${url}${health.path}`;
        const probe = await waitFor(
          'HTTPS health path',
          () => deps.probe(healthUrl),
          (p) => (p.status !== null && p.status < 500 ? p : null),
          { timeoutMs: deps.timeouts.httpsReadyMs, intervalMs: interval, describe: (p) => String(p.status ?? p.error ?? 'no response') },
        ).catch(() => deps.probe(healthUrl));
        details['httpsHealth'] = probe;
        details['httpsReadyAfterMs'] = deps.now() - activeAt;
        assert(probe.status !== null && probe.status < 500, 'https', `HTTPS health path answered ${probe.status ?? probe.error ?? 'no response'} after ACTIVE`, { httpsStatus: https.status, healthStatuses: [probe.status] });
        return url;
      }),
    );
    result.runtime.https = 'PASS';

    // ── Repository-specific smoke contract ──────────────────────────────
    point = 'smoke';
    await step('smoke', () =>
      evidence.step('Application smoke contract', async (details) => {
        const outcomes = await runSmokeChecks(deps, config.smoke ?? [], appUrl);
        result.runtime.smoke = outcomes;
        details['smoke'] = outcomes;
        const failed = applySmokeFailuresToDependencies(result, outcomes);
        assert(failed.length === 0, 'smoke', `smoke contract failed: ${failed.map((f) => `${f.path}: ${f.detail}`).join('; ')}`);
      }),
    );

    // ── Optional update/redeploy exercise ───────────────────────────────
    if (deps.exerciseUpdate) {
      point = 'update';
      await step('update', () =>
        evidence.step('Exercise an update/redeploy', async (details) => {
          const updateStarted = deps.now();
          const version = `${release.version}-u2`;
          const created = await deps.api.createRelease(applicationId, {
            version,
            gitSha: benchmark.commit,
            ...(config.overrides?.migrationCommand ? { migrationCommand: config.overrides.migrationCommand } : {}),
          });
          run.releases['update'] = { id: created.id, version, gitSha: benchmark.commit };
          evidence.save();
          result.update.releaseId = created.id;
          result.update.version = version;
          const settled = await waitFor(
            `update release ${version} build`,
            async () => (await deps.api.listReleases(applicationId)).find((r) => r.id === created.id),
            (r) => (r && r.status !== 'BUILDING' ? r : null),
            { timeoutMs: deps.timeouts.buildMs, intervalMs: interval, describe: (r) => r?.status ?? 'missing' },
          );
          assert(settled.status === 'READY', 'update', `update release build ${settled.status}: ${settled.failureReason ?? ''}`);
          const imageTag = releaseImageTag(applicationId, version);
          run.releases['update']!.imageTag = imageTag;
          const digest = await deps.aws.ecrDigestForTag(imageTag);
          assert(digest, 'update', `ECR has no image tagged ${imageTag}`);
          run.releases['update']!.imageDigest = digest;
          evidence.save();
          result.update.imageDigest = digest;
          details['release'] = { id: created.id, version, digest };

          const requested = await deps.api.deploy(deploymentId, created.id);
          details['deployRequest'] = requested;
          assert(requested.status === 202, 'update', `deploy of the update release -> ${requested.status}`);

          const detail = await waitFor(
            'update release pointer',
            () => deps.api.getDeployment(deploymentId),
            (d) => (d.currentReleaseId === created.id || d.state === 'FAILED' ? d : null),
            { timeoutMs: deps.timeouts.pointerMs, intervalMs: interval, describe: describeDeployment },
          );
          details['deployment'] = summarize(detail);
          assert(detail.state !== 'FAILED' && detail.currentReleaseId === created.id, 'update', `update deploy did not settle: state ${detail.state}, currentReleaseId ${detail.currentReleaseId}`);
          assert(digestSuffix(detail.runningImageDigest) === digestSuffix(digest), 'update', `running digest ${detail.runningImageDigest} != expected ${digest}`);
          result.update.durationMs = deps.now() - updateStarted;
          result.update.status = 'PASS';

          const rerun = await runSmokeChecks(deps, config.smoke ?? [], appUrl);
          result.runtime.smoke = rerun;
          details['smokeRerun'] = rerun;
          const rerunFailed = applySmokeFailuresToDependencies(result, rerun);
          assert(rerunFailed.length === 0, 'smoke', `post-update smoke contract failed: ${rerunFailed.map((f) => `${f.path}: ${f.detail}`).join('; ')}`);
        }),
      );
    }

    point = 'runtime';
    await step('runtime', () =>
      evidence.step('The application stays healthy through the observation window', async (details) => {
        const seconds = config.verify?.observationSeconds ?? 180;
        const appPath = config.verify?.appPath ?? '/';
        const accept = config.verify?.appStatus ?? null;
        const samples = Math.max(3, Math.floor(seconds / 30));
        const healthStatuses: (number | null)[] = [];
        const appStatuses: (number | null)[] = [];
        const httpsHealthStatuses: (number | null)[] = [];
        for (let i = 0; i < samples; i++) {
          if (i > 0) await deps.sleep((seconds * 1000) / samples);
          healthStatuses.push((await deps.probe(`${run.albEndpoint}${health.path}`)).status);
          httpsHealthStatuses.push((await deps.probe(`${appUrl}${health.path}`)).status);
          appStatuses.push((await deps.probe(`${appUrl}${appPath}`)).status);
        }
        result.runtime.observation = { seconds, samples, healthStatuses, appStatuses, httpsHealthStatuses };
        details['observation'] = result.runtime.observation;
        const detail = await deps.api.getDeployment(deploymentId);
        details['deployment'] = summarize(detail);
        const service = await deps.aws.describeRunningService(run.applicationStackName!);
        const targets = await deps.aws.targetHealth(run.applicationStackName!);
        details['ecs'] = service;
        details['targets'] = targets;
        const stopped = await deps.aws.describeStoppedTasks(run.applicationStackName!);
        details['stoppedTasks'] = stopped.length;
        const okHealth = (s: number | null) => s !== null && s < 500;
        const okApp = (s: number | null) => s !== null && (accept ? accept.includes(s) : s < 500);
        assert(healthStatuses.every(okHealth) && httpsHealthStatuses.every(okHealth), 'runtime', `health path unstable: http ${healthStatuses.join('/')} https ${httpsHealthStatuses.join('/')}`, { healthStatuses: [...healthStatuses, ...httpsHealthStatuses], targetHealth: targets });
        assert(appStatuses.every(okApp), 'runtime', `application path ${appPath} answered ${appStatuses.join('/')}`, { appStatuses, targetHealth: targets });
        assert(detail.state === 'HEALTHY' || detail.state === 'UPDATE_AVAILABLE', 'runtime', `deployment state ${detail.state} after the window`, { failureCode: detail.deploymentStatus.failure?.code ?? null });
        assert(targets.length > 0 && targets.every((t) => t === 'healthy'), 'runtime', `ALB targets after the window: ${targets.join(', ')}`, { targetHealth: targets });
        const crashLoop = stopped.filter((t) => t.containers.some((c) => c.exitCode !== null && c.exitCode !== 0)).length;
        assert(crashLoop < 3, 'runtime', `${crashLoop} tasks exited non-zero during the run`, { stoppedTasks: stopped.map((t) => ({ ...stoppedExit(t.containers), stoppedReason: t.stoppedReason })) });
      }),
    );

    // ── Dependencies ────────────────────────────────────────────────────
    point = 'dependencies';
    await step('dependencies', () =>
      evidence.step('Provisioned dependencies are bound and used', async (details) => {
        const manifest = ((application['detectedMetadata'] as Record<string, unknown> | null)?.['manifest'] ?? null) as Record<string, unknown> | null;
        const needs = {
          postgres: application['databaseRequired'] === true,
          redis: application['redisRequired'] === true,
          storage: application['storageRequired'] === true,
        };
        const presence = await deps.aws.describeDependencies(run.applicationStackName!);
        const env = await deps.aws.describeTaskDefinitionEnv(run.applicationStackName!);
        details['presence'] = presence;
        details['taskEnv'] = env;
        details['needs'] = needs;
        const bound = new Set([...(env?.environment ?? []), ...(env?.secrets ?? [])]);
        const check = (kind: 'postgres' | 'redis' | 'storage', present: boolean, names: string[]): StageBResult['dependencies']['postgres'] => {
          if (!needs[kind]) return 'NOT_REQUIRED';
          if (config.dependencies?.[kind] === 'skip') return 'NOT_VERIFIED';
          if (!present) return 'FAIL';
          return names.some((name) => bound.has(name)) ? 'PASS' : 'FAIL';
        };
        result.dependencies.postgres = check('postgres', presence.rds !== null, ['DATABASE_URL', 'DATABASE_HOST']);
        result.dependencies.redis = check('redis', presence.cache !== null, ['REDIS_URL', 'REDIS_HOST']);
        result.dependencies.storage = check('storage', presence.bucket !== null, ['AWS_S3_BUCKET', 'S3_BUCKET', 'STORAGE_BUCKET']);
        if (result.dependencies.migration === 'NOT_ATTEMPTED') {
          const migrationCommand = config.overrides?.migrationCommand ?? (application['migrationCommand'] as string | null | undefined) ?? null;
          result.dependencies.migration = migrationCommand ? 'PASS' : 'NOT_REQUIRED';
        }
        void manifest;
        const failed = (['postgres', 'redis', 'storage'] as const).filter((k) => result.dependencies[k] === 'FAIL');
        assert(failed.length === 0, 'dependencies', `dependency binding failed: ${failed.join(', ')} (bound: ${[...bound].join(', ')})`);
      }),
    );

    result.classification = 'PASS';
    result.failureStage = null;
    result.rootCause = null;
    result.rootCauseEvidence = null;
  } catch (error) {
    const stop = error instanceof FunnelStop ? error : new FunnelStop('harness', error instanceof Error ? (error.stack ?? error.message) : String(error));
    await recordFailure(deps, input, stop, point);
  } finally {
    result.timing.finishedAt = new Date(deps.now()).toISOString();
    result.timing.totalMs = deps.now() - started;
    evidence.save();
  }
  return result;
}

/** A fresh secret in the shape the application validates; never logged, never recorded. */
export function generateSecret(format: SecretFormat): string {
  switch (format) {
    case 'hex32':
      return randomBytes(16).toString('hex');
    case 'hex64':
      return randomBytes(32).toString('hex');
    case 'password':
      return `Sb-${randomBytes(12).toString('base64url')}-1`;
    default:
      return randomBytes(32).toString('base64url');
  }
}

const APP_URL_PLACEHOLDER = 'https://pending.deployz.dev';

/** The deployment's permanent default-HTTPS address (`<prefix><id>.deployz.dev`, prefix `d-` unless the target control plane sets another), checked against the API once HTTPS is ACTIVE. */
export function defaultDeploymentUrl(deploymentId: string, env: NodeJS.ProcessEnv = process.env): string {
  return `https://${env['DEPLOYZ_DEFAULT_HOSTNAME_PREFIX'] ?? 'd-'}${deploymentId.toLowerCase()}.deployz.dev`;
}

function summarize(detail: DeploymentDetail): Record<string, unknown> {
  return {
    state: detail.state,
    stage: detail.deploymentStatus.stage,
    currentReleaseId: detail.currentReleaseId,
    healthStatus: detail.healthStatus,
    relayStatus: detail.relayStatus,
    runningImageDigest: detail.runningImageDigest,
    appUrl: detail.appUrl,
    failure: detail.deploymentStatus.failure,
    lastJob: detail.jobs.at(-1) ? { type: detail.jobs.at(-1)!.type, state: detail.jobs.at(-1)!.state, failureCode: detail.jobs.at(-1)!.failureCode } : null,
  };
}

/** Collects what the failure needs for diagnosis, classifies it, and marks the stages. */
async function recordFailure(deps: DeployDeps, input: RepositoryAttemptInput, stop: FunnelStop, point: FunnelPoint): Promise<void> {
  const { evidence, result } = input;
  const run = stageBRun(evidence);
  const failurePoint = stop.point === 'harness' ? 'harness' : stop.point;
  const evidenceIn: FailureEvidence = {
    point: failurePoint,
    expectedDeployable: result.expectedDeployable,
    message: stop.message,
    healthPathSource: result.runtime.healthPathSource,
    manifestHealthPath: null,
    probedHealthPath: result.runtime.healthPath,
    ...stop.extra,
  };
  const collected: Record<string, unknown> = { point, message: stop.message.slice(0, 2000) };
  let extra: Partial<FailureEvidence> = {};
  if (
    run.applicationStackName &&
    (failurePoint === 'install' ||
      failurePoint === 'secrets-delivery' ||
      failurePoint === 'auto-deploy' ||
      failurePoint === 'inventory' ||
      failurePoint === 'runtime' ||
      failurePoint === 'https' ||
      failurePoint === 'smoke' ||
      failurePoint === 'update' ||
      failurePoint === 'dependencies')
  ) {
    try {
      const stopped = await deps.aws.describeStoppedTasks(run.applicationStackName);
      const logs = await deps.aws.tailApplicationLogs(run.applicationStackName);
      const resources = await deps.aws.listStackResources(run.applicationStackName).catch(() => []);
      const stackReasons = resources.filter((r) => /FAILED/.test(r.status)).map((r) => `${r.type} ${r.status}`);
      const targets = await deps.aws.targetHealth(run.applicationStackName).catch(() => []);
      // What is still there wins; when the rollback already removed the
      // cluster and the log group, the snapshot the install wait took stands.
      collected['stoppedTasks'] = stopped.length > 0 ? stopped : (stop.extra.stoppedTasks ?? []);
      collected['logTail'] = logs.length > 0 ? logs : (stop.extra.logTail ?? []);
      collected['stackFailures'] = stackReasons;
      collected['targetHealth'] = targets;
      extra = {
        ...(stopped.length > 0 ? { stoppedTasks: stopped.map((t) => ({ ...stoppedExit(t.containers), stoppedReason: t.stoppedReason })) } : {}),
        ...(logs.length > 0 ? { logTail: logs } : {}),
        stackReasons,
        targetHealth: targets,
      };
    } catch (error) {
      collected['evidenceError'] = error instanceof Error ? error.message : String(error);
    }
    if (run.deploymentId) {
      try {
        collected['diagnostics'] = await deps.api.diagnostics(run.deploymentId);
      } catch {
        // Diagnostics exist only for failed deployments; absence is fine.
      }
    }
  }
  const classified = classifyFailure({ ...evidenceIn, ...stop.extra, ...extra });
  result.classification = classified.failureStage;
  result.failureStage = classified.failureStage;
  result.rootCause = classified.rootCause;
  result.rootCauseEvidence = classified.rootCauseEvidence;
  result.evidence = { ...result.evidence, failure: collected };

  const markFail = (section: { status: StageBResult['gate']['status']; detail: string | null }) => {
    if (section.status === 'NOT_ATTEMPTED') {
      section.status = 'FAIL';
      section.detail = stop.message.slice(0, 500);
    }
  };
  switch (failurePoint) {
    case 'gate':
      if (result.expectedDeployable || classified.failureStage !== 'EXPECTED_UNSUPPORTED') markFail(result.gate);
      else {
        result.gate.status = 'PASS';
        result.gate.detail = stop.message.slice(0, 500);
      }
      break;
    case 'configuration':
      markFail(result.configuration);
      break;
    case 'secrets-delivery':
      // Configuration already reached PASS (the vendor-scope PUT and preflight
      // both succeeded) before this later, post-enrollment delivery ran, so
      // markFail's NOT_ATTEMPTED guard would no-op here — record the failure
      // on the section explicitly instead.
      result.configuration.status = 'FAIL';
      result.configuration.detail = stop.message.slice(0, 500);
      break;
    case 'build':
      markFail(result.build);
      break;
    case 'install':
      markFail(result.deployment);
      break;
    case 'auto-deploy':
    case 'runtime':
      if (result.runtime.ecs === 'NOT_ATTEMPTED') result.runtime.ecs = 'UNKNOWN';
      if (result.runtime.alb === 'NOT_ATTEMPTED') result.runtime.alb = 'UNKNOWN';
      if (result.runtime.https === 'NOT_ATTEMPTED') result.runtime.https = 'NOT_ATTEMPTED';
      result.runtime.detail = stop.message.slice(0, 500);
      break;
    case 'https':
      result.runtime.https = 'FAIL';
      result.runtime.detail = stop.message.slice(0, 500);
      break;
    case 'inventory':
      markFail(result.inventory);
      break;
    case 'smoke':
      result.runtime.detail = stop.message.slice(0, 500);
      break;
    case 'update':
      markFail(result.update);
      break;
    case 'dependencies':
      result.dependencies.detail = stop.message.slice(0, 500);
      break;
    default:
      break;
  }
}
