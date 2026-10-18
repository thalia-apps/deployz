/**
 * The Stage B result model — one schema-validated document per repository id
 * under `docs/testing/repository-deployment/runs/`, plus the corpus summary.
 *
 * Two fixed vocabularies (README "Result model"): the failure stage names
 * where the funnel stopped, the root cause names the first responsible
 * layer. Nothing else is accepted. A completed result is protected: a rerun
 * moves the previous document to `runs/history/` only with `--force`.
 *
 * A result records what the run observed. It holds no expected answer.
 * Documents written before 2026-10-18 also carry label fields (set, cohort,
 * realism, difficulty, expected verdict, gate outcome). The schema ignores
 * those fields, and the next write of such a document drops them.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { manifestReadinessStateSchema } from '@deployz/contracts';
import { z } from 'zod';

import { DEPLOYMENT_CLASSES } from './config.js';

export const FAILURE_STAGES = [
  'GATE_ERROR',
  'CONFIG_ERROR',
  'SOURCE_FETCH_ERROR',
  'BUILD_ERROR',
  'IMAGE_ERROR',
  'INFRA_ERROR',
  'CONTAINER_START_ERROR',
  'ENV_BINDING_ERROR',
  'DATABASE_ERROR',
  'REDIS_ERROR',
  'MIGRATION_ERROR',
  'STORAGE_ERROR',
  'PORT_ERROR',
  'HEALTH_PATH_ERROR',
  'TLS_ERROR',
  'APPLICATION_ERROR',
  'TIMEOUT',
  'DESTROY_ERROR',
  'CLEANUP_LEAK',
  'EXPECTED_UNSUPPORTED',
  'REPOSITORY_BROKEN',
  'TEST_HARNESS_ERROR',
] as const;
export type FailureStage = (typeof FAILURE_STAGES)[number];

export const ROOT_CAUSES = [
  'DEPLOYZ_BUG',
  'ANALYSIS_BUG',
  'ANALYSIS_MISSING_SIGNAL',
  'MVP_CAPABILITY_GAP',
  'CORRECTLY_UNSUPPORTED',
  'REPO_CONFIGURATION',
  'UPSTREAM_REPO_FAILURE',
  'AWS_TRANSIENT_FAILURE',
  'TEST_HARNESS_FAILURE',
] as const;
export type RootCause = (typeof ROOT_CAUSES)[number];

export const CLASSIFICATIONS = ['PASS', ...FAILURE_STAGES] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

/** One funnel stage's outcome. NOT_ATTEMPTED: an earlier stage stopped the funnel. */
export const STAGE_STATUSES = ['PASS', 'FAIL', 'SKIPPED', 'NOT_REQUIRED', 'NOT_ATTEMPTED'] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

const FINDING_ID_REGEX = /^DEPLOY-\d{3}$/;
const stageStatus = z.enum(STAGE_STATUSES);

export const gateResultSchema = z
  .object({
    status: stageStatus,
    /** The deployment gate's verdict for a fresh application with no configured values. */
    verdict: manifestReadinessStateSchema.nullable(),
    analysisVerdict: z.string().nullable(),
    gateFindings: z.array(z.string()),
    /** Every env key the manifest marks required (before Deployz-provided keys are subtracted). */
    requiredKeys: z.array(z.string()),
    /** The keys the gate actually blocks on: required, not provided by Deployz, no vendor value. */
    missingKeys: z.array(z.string()),
    unsupported: z.array(z.string()),
    /** The gate's verdict once the Stage B vendor configuration is applied (offline evaluation). */
    configuredVerdict: manifestReadinessStateSchema.nullable(),
    configuredFindings: z.array(z.string()),
    /** Where the verdict came from: the in-process production path, the deployed control plane, or both. */
    source: z.enum(['in-process', 'control-plane', 'both']).nullable(),
    analysisVersion: z.number().int().nullable(),
    /** The manifest facts the deployment would act on (before the Stage B configuration). */
    manifest: z
      .object({
        dockerfilePath: z.string().nullable(),
        buildContext: z.string().nullable(),
        appRoot: z.string().nullable(),
        port: z.number().int().nullable(),
        healthPath: z.string().nullable(),
        healthMode: z.string().nullable(),
        migrationCommand: z.string().nullable(),
        migrationMode: z.string().nullable(),
        postgres: z.boolean(),
        redis: z.boolean(),
        storage: z.boolean(),
        databaseBindings: z.array(z.string()),
        redisBindings: z.array(z.string()),
        storageBindings: z.array(z.string()),
        generatedKeys: z.array(z.string()),
      })
      .strict()
      .nullable(),
    detail: z.string().nullable(),
  });

export const configurationResultSchema = z
  .object({
    status: stageStatus,
    overrides: z.record(z.string(), z.unknown()),
    /** Configuration keys provided (values never recorded). */
    keys: z.array(z.string()),
    generatedKeys: z.array(z.string()),
    /** Generated secret keys re-delivered at the customer scope once the connector enrolled (values never recorded; BUG-004 / DEPLOY-027). */
    deliveredAfterEnrollment: z.array(z.string()).default([]),
    detail: z.string().nullable(),
  })
  .strict();

export const buildResultSchema = z
  .object({
    status: stageStatus,
    releaseId: z.string().nullable(),
    version: z.string().nullable(),
    gitSha: z.string().nullable(),
    dockerfilePath: z.string().nullable(),
    buildContext: z.string().nullable(),
    imageDigest: z.string().nullable(),
    buildId: z.string().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    /**
     * True when the attempt deployed a release an earlier attempt had already
     * built, instead of running CodeBuild again (`--reuse-application`).
     * Absent in results recorded before the flag existed.
     */
    imageReused: z.boolean().default(false),
    detail: z.string().nullable(),
  })
  .strict();

export const deploymentResultSchema = z
  .object({
    status: stageStatus,
    deploymentId: z.string().nullable(),
    installationId: z.string().nullable(),
    bootstrapStack: z.string().nullable(),
    applicationStack: z.string().nullable(),
    stackStatus: z.string().nullable(),
    templateSource: z.enum(['production-default', 'stage-b-generic', 'stage-b-pinned']).nullable(),
    templateUrl: z.string().nullable(),
    installJobState: z.string().nullable(),
    failureCode: z.string().nullable(),
    resourceCount: z.number().int().nonnegative().nullable(),
    /** Per-CloudFormation-type counts of the application stack's resources. */
    resourcesByType: z.record(z.string(), z.number().int().nonnegative()).nullable().default(null),
    /** The install (customer) region — distinct from the control-plane region ECR/the template bucket use. */
    region: z.string().nullable().default(null),
    durationMs: z.number().int().nonnegative().nullable(),
    detail: z.string().nullable(),
  })
  .strict();

/** One plan-versus-actual inventory check ("Plan-versus-actual inventory gate"). */
export const inventoryResultSchema = z
  .object({
    status: stageStatus,
    /** The install plan's CREATE component kinds. */
    planCreateKinds: z.array(z.string()),
    /** The kinds the persisted infrastructure inventory expects. */
    expectedKinds: z.array(z.string()),
    /** The CloudFormation resource types found in the application stack snapshot. */
    presentTypes: z.array(z.string()),
    /** A planned CREATE kind whose AWS resource type is absent from the stack. */
    missing: z.array(z.string()),
    /** A kind present in the stack that the plan did not create. */
    unexpected: z.array(z.string()),
    detail: z.string().nullable(),
  })
  .strict();

const smokeCheckOutcomeSchema = z
  .object({
    path: z.string(),
    status: z.number().int().nullable(),
    ok: z.boolean(),
    detail: z.string(),
    exercises: z.array(z.enum(['postgres', 'redis'])),
  })
  .strict();

export const updateResultSchema = z
  .object({
    status: stageStatus,
    releaseId: z.string().nullable(),
    version: z.string().nullable(),
    imageDigest: z.string().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    detail: z.string().nullable(),
  })
  .strict();

const componentState = z.enum(['HEALTHY', 'UNHEALTHY', 'UNKNOWN', 'NOT_ATTEMPTED']);

export const runtimeResultSchema = z
  .object({
    ecs: componentState,
    alb: componentState,
    https: stageStatus,
    /** The path actually probed and where it came from. */
    healthPath: z.string().nullable(),
    healthPathSource: z.enum(['stage-b', 'manifest', 'repository-evidence', 'fallback']).nullable(),
    appUrl: z.string().nullable(),
    runningImageDigest: z.string().nullable(),
    releaseServing: z.boolean().nullable(),
    /** Repository-specific smoke checks run against the live application (README item 6). */
    smoke: z.array(smokeCheckOutcomeSchema).default([]),
    observation: z
      .object({
        seconds: z.number().int().nonnegative(),
        samples: z.number().int().nonnegative(),
        healthStatuses: z.array(z.number().int().nullable()),
        appStatuses: z.array(z.number().int().nullable()),
        httpsHealthStatuses: z.array(z.number().int().nullable()),
      })
      .strict()
      .nullable(),
    detail: z.string().nullable(),
  })
  .strict();

const dependencyState = z.enum(['PASS', 'FAIL', 'NOT_REQUIRED', 'NOT_VERIFIED', 'NOT_ATTEMPTED']);

export const dependenciesResultSchema = z
  .object({
    postgres: dependencyState,
    redis: dependencyState,
    storage: dependencyState,
    migration: dependencyState,
    detail: z.string().nullable(),
  })
  .strict();

const cleanupStepOutcome = z.enum(['PASS', 'FAIL', 'SKIPPED', 'NOT_ATTEMPTED']);

export const cleanupResultSchema = z
  .object({
    status: stageStatus,
    destroyJobState: z.string().nullable(),
    purgeJobState: z.string().nullable(),
    cleanupState: z.string().nullable(),
    bootstrapStackFinal: z.string().nullable(),
    leaks: z.array(z.string()),
    /** Outcome of "Verify retained state between Disconnect and Purge". */
    retainedState: cleanupStepOutcome.default('NOT_ATTEMPTED'),
    /** Outcome of "Verify the retained set is gone after Purge". */
    purgedState: cleanupStepOutcome.default('NOT_ATTEMPTED'),
    durationMs: z.number().int().nonnegative().nullable(),
    detail: z.string().nullable(),
  })
  .strict();

export const stageBResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^repo-\d{3}$/),
    repository: z.string(),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    /** The repository form Deployz was pointed at (`owner/repo`); the same as `repository` unless a fork was needed. */
    repositoryForm: z.enum(['original', 'fork']).nullable(),
    repositoryUsed: z.string().nullable(),
    deployzCommit: z.string().regex(/^[0-9a-f]{7,40}$/),
    runId: z.string().nullable(),
    /** How far the harness was asked to go: the gate only, or the whole funnel. */
    mode: z.enum(['gate', 'deploy']),
    /** Which deployment class this repository was assigned to (B1/B2/B3). Default runtime-reuse for backward compatibility. */
    deploymentClass: z.enum(DEPLOYMENT_CLASSES).default('runtime-reuse'),
    gate: gateResultSchema,
    configuration: configurationResultSchema,
    build: buildResultSchema,
    deployment: deploymentResultSchema,
    /** Absent in results recorded before the inventory gate existed — defaults to NOT_ATTEMPTED. */
    inventory: inventoryResultSchema.default({
      status: 'NOT_ATTEMPTED',
      planCreateKinds: [],
      expectedKinds: [],
      presentTypes: [],
      missing: [],
      unexpected: [],
      detail: null,
    }),
    runtime: runtimeResultSchema,
    dependencies: dependenciesResultSchema,
    /** Absent in results recorded before `--exercise-update` existed — defaults to NOT_ATTEMPTED. */
    update: updateResultSchema.default({ status: 'NOT_ATTEMPTED', releaseId: null, version: null, imageDigest: null, durationMs: null, detail: null }),
    cleanup: cleanupResultSchema,
    classification: z.enum(CLASSIFICATIONS),
    failureStage: z.enum(FAILURE_STAGES).nullable(),
    rootCause: z.enum(ROOT_CAUSES).nullable(),
    /** Why the root cause was chosen — or what is still to be investigated. */
    rootCauseEvidence: z.string().nullable(),
    findingIds: z.array(z.string().regex(FINDING_ID_REGEX)),
    timing: z
      .object({
        startedAt: z.string().nullable(),
        finishedAt: z.string().nullable(),
        totalMs: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    /** Summarized, sanitized evidence — never raw AWS logs, never secrets. */
    evidence: z.record(z.string(), z.unknown()),
  });
export type StageBResult = z.infer<typeof stageBResultSchema>;

// ── Construction ─────────────────────────────────────────────────────────

export interface ResultIdentity {
  id: string;
  repository: string;
  commit: string;
  deployzCommit: string;
  runId: string | null;
  mode: StageBResult['mode'];
  deploymentClass: StageBResult['deploymentClass'];
}

/** A result with every stage NOT_ATTEMPTED — the starting point every run fills in. */
export function emptyResult(identity: ResultIdentity): StageBResult {
  return {
    schemaVersion: 1,
    ...identity,
    deploymentClass: identity.deploymentClass,
    repositoryForm: null,
    repositoryUsed: null,
    gate: {
      status: 'NOT_ATTEMPTED',
      verdict: null,
      analysisVerdict: null,
      gateFindings: [],
      requiredKeys: [],
      missingKeys: [],
      unsupported: [],
      configuredVerdict: null,
      configuredFindings: [],
      source: null,
      analysisVersion: null,
      manifest: null,
      detail: null,
    },
    configuration: { status: 'NOT_ATTEMPTED', overrides: {}, keys: [], generatedKeys: [], deliveredAfterEnrollment: [], detail: null },
    build: {
      status: 'NOT_ATTEMPTED',
      releaseId: null,
      version: null,
      gitSha: null,
      dockerfilePath: null,
      buildContext: null,
      imageDigest: null,
      buildId: null,
      durationMs: null,
      imageReused: false,
      detail: null,
    },
    deployment: {
      status: 'NOT_ATTEMPTED',
      deploymentId: null,
      installationId: null,
      bootstrapStack: null,
      applicationStack: null,
      stackStatus: null,
      templateSource: null,
      templateUrl: null,
      installJobState: null,
      failureCode: null,
      resourceCount: null,
      resourcesByType: null,
      region: null,
      durationMs: null,
      detail: null,
    },
    inventory: {
      status: 'NOT_ATTEMPTED',
      planCreateKinds: [],
      expectedKinds: [],
      presentTypes: [],
      missing: [],
      unexpected: [],
      detail: null,
    },
    runtime: {
      ecs: 'NOT_ATTEMPTED',
      alb: 'NOT_ATTEMPTED',
      https: 'NOT_ATTEMPTED',
      healthPath: null,
      healthPathSource: null,
      appUrl: null,
      runningImageDigest: null,
      releaseServing: null,
      smoke: [],
      observation: null,
      detail: null,
    },
    dependencies: {
      postgres: 'NOT_ATTEMPTED',
      redis: 'NOT_ATTEMPTED',
      storage: 'NOT_ATTEMPTED',
      migration: 'NOT_ATTEMPTED',
      detail: null,
    },
    update: {
      status: 'NOT_ATTEMPTED',
      releaseId: null,
      version: null,
      imageDigest: null,
      durationMs: null,
      detail: null,
    },
    cleanup: {
      status: 'NOT_ATTEMPTED',
      destroyJobState: null,
      purgeJobState: null,
      cleanupState: null,
      bootstrapStackFinal: null,
      leaks: [],
      retainedState: 'NOT_ATTEMPTED',
      purgedState: 'NOT_ATTEMPTED',
      durationMs: null,
      detail: null,
    },
    classification: 'TEST_HARNESS_ERROR',
    failureStage: 'TEST_HARNESS_ERROR',
    rootCause: 'TEST_HARNESS_FAILURE',
    rootCauseEvidence: 'the run did not reach a classification',
    findingIds: [],
    timing: { startedAt: null, finishedAt: null, totalMs: null },
    evidence: {},
  };
}

/** True when a result's funnel ended in TRUE_DEPLOYMENT_SUCCESS terms (README "Metrics"). */
export function isTrueDeploymentSuccess(result: StageBResult): boolean {
  return (
    result.mode === 'deploy' &&
    result.build.status === 'PASS' &&
    result.deployment.status === 'PASS' &&
    result.runtime.ecs === 'HEALTHY' &&
    result.runtime.alb === 'HEALTHY' &&
    result.runtime.https === 'PASS' &&
    result.dependencies.postgres !== 'FAIL' &&
    result.dependencies.redis !== 'FAIL' &&
    result.dependencies.storage !== 'FAIL' &&
    result.dependencies.migration !== 'FAIL' &&
    result.classification === 'PASS'
  );
}

// ── Files ────────────────────────────────────────────────────────────────

export function resultPath(runsDir: string, id: string): string {
  return join(runsDir, `${id}.json`);
}

export function readResult(runsDir: string, id: string): StageBResult | null {
  const path = resultPath(runsDir, id);
  if (!existsSync(path)) return null;
  return stageBResultSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function readAllResults(runsDir: string): StageBResult[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .filter((name) => /^repo-\d{3}\.json$/.test(name))
    .sort()
    .map((name) => stageBResultSchema.parse(JSON.parse(readFileSync(join(runsDir, name), 'utf8'))));
}

export interface WriteOptions {
  /** Overwrite a completed result, moving the previous one to history/. */
  force?: boolean | undefined;
}

/**
 * A gate-only result may always replace a gate-only result (the gate audit
 * is cheap and reruns on every analyser change). A `deploy` result is
 * protected: replacing it needs `force`, and the previous document is kept
 * under `history/<id>.<deployzCommit>.<n>.json`.
 */
export function writeResult(runsDir: string, result: StageBResult, options: WriteOptions = {}): { replaced: string | null } {
  mkdirSync(runsDir, { recursive: true });
  const path = resultPath(runsDir, result.id);
  const existing = readResult(runsDir, result.id);
  let replaced: string | null = null;
  if (existing && existing.mode === 'deploy') {
    if (!options.force) {
      throw new Error(`${result.id} already has a deployment result (${existing.classification}); rerun with --force to replace it`);
    }
    const historyDir = join(runsDir, 'history');
    mkdirSync(historyDir, { recursive: true });
    let n = 1;
    while (existsSync(join(historyDir, `${result.id}.${existing.deployzCommit.slice(0, 7)}.${n}.json`))) n += 1;
    replaced = join(historyDir, `${result.id}.${existing.deployzCommit.slice(0, 7)}.${n}.json`);
    renameSync(path, replaced);
  }
  writeFileSync(path, `${JSON.stringify(stageBResultSchema.parse(result), null, 2)}\n`);
  return { replaced };
}

// ── Summary ──────────────────────────────────────────────────────────────

export interface StageBSummary {
  deployzCommit: string;
  total: number;
  gate: { attempted: number; ready: number; needsConfiguration: number; notCompatible: number; configuredReady: number };
  build: { attempted: number; succeeded: number; failed: number; successRate: number };
  infrastructure: { attempted: number; succeeded: number; failed: number };
  runtime: { ecsRunning: number; albHealthy: number; httpsReachable: number; applicationResponseValid: number };
  dependencies: { postgres: number; redis: number; storage: number; migration: number };
  trueDeploymentSuccess: number;
  trueDeploymentSuccessRate: number;
  cleanup: { destroys: number; destroyFailures: number; leaks: number; successRate: number };
  byClassification: Record<string, number>;
  byFailureStage: Record<string, number>;
  byRootCause: Record<string, number>;
  byFinding: Record<string, string[]>;
  byClass: Record<string, { total: number; pass: number; fail: number }>;
}

function percent(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 1000) / 10;
}

function count<T>(items: readonly T[], key: (item: T) => string | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    if (k === null) continue;
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export function buildStageBSummary(results: readonly StageBResult[], deployzCommit: string): StageBSummary {
  const gated = results.filter((r) => r.gate.status !== 'NOT_ATTEMPTED');
  const built = results.filter((r) => r.build.status === 'PASS' || r.build.status === 'FAIL');
  const buildOk = results.filter((r) => r.build.status === 'PASS');
  const infra = results.filter((r) => r.deployment.status === 'PASS' || r.deployment.status === 'FAIL');
  const infraOk = results.filter((r) => r.deployment.status === 'PASS');
  const destroys = results.filter((r) => r.cleanup.status === 'PASS' || r.cleanup.status === 'FAIL');
  const trueSuccess = results.filter(isTrueDeploymentSuccess);

  const byFinding: Record<string, string[]> = {};
  for (const r of results) {
    for (const id of r.findingIds) (byFinding[id] ??= []).push(r.id);
  }

  const byClass: Record<string, { total: number; pass: number; fail: number }> = {};
  for (const r of results) {
    const cls = r.deploymentClass;
    if (!byClass[cls]) byClass[cls] = { total: 0, pass: 0, fail: 0 };
    byClass[cls].total += 1;
    if (r.classification === 'PASS' || r.classification === 'EXPECTED_UNSUPPORTED') byClass[cls].pass += 1;
    else byClass[cls].fail += 1;
  }

  return {
    deployzCommit,
    total: results.length,
    byClass,
    gate: {
      attempted: gated.length,
      ready: gated.filter((r) => r.gate.verdict === 'READY').length,
      needsConfiguration: gated.filter((r) => r.gate.verdict === 'NEEDS_CONFIGURATION').length,
      notCompatible: gated.filter((r) => r.gate.verdict === 'NOT_COMPATIBLE').length,
      configuredReady: gated.filter((r) => r.gate.configuredVerdict === 'READY').length,
    },
    build: {
      attempted: built.length,
      succeeded: buildOk.length,
      failed: built.length - buildOk.length,
      successRate: percent(buildOk.length, results.length),
    },
    infrastructure: { attempted: infra.length, succeeded: infraOk.length, failed: infra.length - infraOk.length },
    runtime: {
      ecsRunning: results.filter((r) => r.runtime.ecs === 'HEALTHY').length,
      albHealthy: results.filter((r) => r.runtime.alb === 'HEALTHY').length,
      httpsReachable: results.filter((r) => r.runtime.https === 'PASS').length,
      applicationResponseValid: results.filter((r) => r.runtime.https === 'PASS' && r.classification === 'PASS').length,
    },
    dependencies: {
      postgres: results.filter((r) => r.dependencies.postgres === 'PASS').length,
      redis: results.filter((r) => r.dependencies.redis === 'PASS').length,
      storage: results.filter((r) => r.dependencies.storage === 'PASS').length,
      migration: results.filter((r) => r.dependencies.migration === 'PASS').length,
    },
    trueDeploymentSuccess: trueSuccess.length,
    trueDeploymentSuccessRate: percent(trueSuccess.length, results.length),
    cleanup: {
      destroys: destroys.length,
      destroyFailures: destroys.filter((r) => r.cleanup.status === 'FAIL').length,
      leaks: results.filter((r) => r.cleanup.leaks.length > 0).length,
      successRate: percent(destroys.filter((r) => r.cleanup.status === 'PASS').length, destroys.length),
    },
    byClassification: count(results, (r) => r.classification),
    byFailureStage: count(results, (r) => r.failureStage),
    byRootCause: count(results, (r) => r.rootCause),
    byFinding: Object.fromEntries(Object.entries(byFinding).sort(([a], [b]) => a.localeCompare(b))),
  };
}

export function renderStageBSummary(results: readonly StageBResult[], summary: StageBSummary): string {
  const lines: string[] = [
    '# Repository deployment audit — run summary',
    '',
    `Deployz commit: \`${summary.deployzCommit}\``,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Repositories | ${summary.total} |`,
    `| Gate: READY / NEEDS_CONFIGURATION / NOT_COMPATIBLE | ${summary.gate.ready} / ${summary.gate.needsConfiguration} / ${summary.gate.notCompatible} |`,
    `| Gate: READY with the Stage B configuration | ${summary.gate.configuredReady} |`,
    `| Build attempted / succeeded / failed | ${summary.build.attempted} / ${summary.build.succeeded} / ${summary.build.failed} |`,
    `| Build success rate | ${summary.build.successRate}% |`,
    `| Infrastructure attempted / succeeded / failed | ${summary.infrastructure.attempted} / ${summary.infrastructure.succeeded} / ${summary.infrastructure.failed} |`,
    `| Runtime: ECS running / ALB healthy / HTTPS reachable / application response valid | ${summary.runtime.ecsRunning} / ${summary.runtime.albHealthy} / ${summary.runtime.httpsReachable} / ${summary.runtime.applicationResponseValid} |`,
    `| Dependencies: PostgreSQL / Redis / storage / migration verified | ${summary.dependencies.postgres} / ${summary.dependencies.redis} / ${summary.dependencies.storage} / ${summary.dependencies.migration} |`,
    `| **True deployment success / repositories** | **${summary.trueDeploymentSuccess} / ${summary.total} (${summary.trueDeploymentSuccessRate}%)** |`,
    `| Cleanup: destroys / failures / leaks / success rate | ${summary.cleanup.destroys} / ${summary.cleanup.destroyFailures} / ${summary.cleanup.leaks} / ${summary.cleanup.successRate}% |`,
    '',
    '## By classification',
    '',
    '| Classification | Repositories |',
    '| --- | --- |',
    ...Object.entries(summary.byClassification).map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '## By root cause',
    '',
    '| Root cause | Repositories |',
    '| --- | --- |',
    ...Object.entries(summary.byRootCause).map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '## By finding',
    '',
    '| Finding | Repositories |',
    '| --- | --- |',
    ...Object.entries(summary.byFinding).map(([k, v]) => `| ${k} | ${v.length}: ${v.join(', ')} |`),
    '',
    '## By deployment class',
    '',
    '| Class | Repositories | Pass | Fail |',
    '| --- | --- | --- | --- |',
    ...Object.entries(summary.byClass).map(([k, v]) => `| ${k} | ${v.total} | ${v.pass} | ${v.fail} |`),
    '',
    '## Repositories',
    '',
    '| Id | Repository | Gate | Build | Deploy | Runtime | Cleanup | Result | Findings |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of results) {
    const runtime = r.runtime.ecs === 'NOT_ATTEMPTED' ? '—' : `${r.runtime.ecs}/${r.runtime.alb}/https ${r.runtime.https}`;
    lines.push(
      `| ${r.id} | ${r.repository}@${r.commit.slice(0, 7)} | ${r.gate.verdict ?? '—'} | ${r.build.status} | ${r.deployment.status} | ${runtime} | ${r.cleanup.status} | ${r.classification}${r.rootCause ? ` / ${r.rootCause}` : ''} | ${r.findingIds.join(', ')} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

export function writeSummaryFiles(runsDir: string, results: readonly StageBResult[], summary: StageBSummary): void {
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(join(runsDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(runsDir, 'summary.md'), renderStageBSummary(results, summary));
}
