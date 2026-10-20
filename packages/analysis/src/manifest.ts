/**
 * Phase 2 boundary — canonical deployment manifest.
 *
 * Pure, deterministic translation of detector output (+ vendor overrides) into
 * the typed `DeploymentManifest` contract, plus the server-side readiness gate
 * that evaluates the FINAL manifest before AWS provisioning.
 *
 * The analyzer's flat `metadata` record is the input on both paths: a live
 * `AnalysisResult.metadata` (tests, re-analysis) and the stored
 * `applications.detected_metadata` JSONB (deployment creation) are the same
 * shape, so both feed this module unchanged.
 */

import {
  envVariableClassificationSchema,
  deploymentManifestOverridesSchema,
  deploymentManifestSchema,
  manifestQueueSchema,
  manifestScheduledJobSchema,
  manifestQuestionSchema,
  DEPLOYMENT_MANIFEST_SCHEMA_VERSION,
  type DeploymentManifest,
  type DeploymentManifestOverrides,
  type EnvironmentSetting,
  type ManifestEnvBinding,
  type ManifestEnvVariable,
  type ManifestQueue,
  type ManifestQuestion,
  type ManifestReadinessFinding,
  type ManifestReadinessResult,
  type ManifestScheduledJob,
  type ManifestWorker,
} from '@deployz/contracts';

import type { AnalysisResult } from './analyser.js';
import type { BindingSemantic, InfrastructureBinding } from './bindings.js';
import { isGeneratableSecretName } from './env-classification.js';
import { resolveRedisEnvBindings } from './redis.js';

/** Anything carrying the flat detector metadata record. */
export type ManifestSource = Pick<AnalysisResult, 'metadata'>;

/** Context a manifest-readiness caller can supply that the manifest alone cannot know. */
export interface ManifestReadinessContext {
  /**
   * Env var keys the operator ALREADY supplies values for (the application's
   * configured defaults/overrides). Absent = the caller has no config
   * knowledge, so required-env findings are not evaluated (§11.2 — the
   * deployment-creation boundary is where the keys are known).
   */
  providedEnvKeys?: readonly string[] | undefined;
}

// ── Small metadata readers ──────────────────────────────────────────────────

function firstString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The analysed migration mode from metadata, when present and valid. */
function migrationModeOf(
  meta: Record<string, unknown>,
  vendorChoseNoMigration: boolean,
): DeploymentManifest['migration']['mode'] {
  const mode = meta['migrationMode'];
  // An explicit "No separate migration" records mode none, except when the
  // image already migrates itself at boot (startup stays accurate).
  if (vendorChoseNoMigration && mode !== 'startup') return 'none';
  return mode === 'pre_deploy' || mode === 'startup' || mode === 'none' || mode === 'unknown'
    ? mode
    : undefined;
}

/**
 * The manifest health section (Stage B phase 5). A vendor-supplied path is
 * always `explicit`; otherwise the analysed health mode decides: `root` when
 * the app's own HEALTHCHECK probes `/`, `explicit` when a route/HEALTHCHECK
 * URL names the path, and `vendor_required` when there is NO health evidence —
 * no silent `/health` assumption (the deployment gate blocks that case). Only
 * metadata written before the mode existed keeps the historical default.
 */
function normalizeHealthSection(
  overridePath: string | null | undefined,
  meta: Record<string, unknown>,
): DeploymentManifest['health'] {
  if (overridePath !== undefined && overridePath !== null) {
    return { path: overridePath, mode: 'explicit' };
  }
  const mode = meta['healthMode'];
  const metaPath = typeof meta['healthPath'] === 'string' ? meta['healthPath'] : null;
  if (mode === 'root') return { path: metaPath ?? '/', mode: 'root' };
  if (mode === 'explicit') return { path: metaPath ?? '/health', mode: 'explicit' };
  if (mode === 'vendor_required') return { path: '/', mode: 'vendor_required' };
  return { path: '/health' };
}

/** A binding semantic expressible in the manifest vocabulary, or null for the read-model-only ones. */
function toManifestKind(semantic: BindingSemantic): ManifestEnvBinding['kind'] | null {
  switch (semantic) {
    case 'url':
    case 'jdbc_url':
    case 'host':
    case 'port':
    case 'bucket':
    case 'database':
    case 'username':
    case 'password':
      return semantic;
    case 'region':
    case 'endpoint':
      return null;
  }
}

/**
 * The env vars (with their semantics) each provisioned value is injected
 * under. Standard injected names always lead (compat); detected aliases follow
 * in deterministic order.
 */
function toEnvBindings(
  bindings: readonly InfrastructureBinding[],
  standard: readonly { name: string; kind: ManifestEnvBinding['kind'] }[],
): ManifestEnvBinding[] {
  const seen = new Set<string>(standard.map((entry) => entry.name));
  const entries: ManifestEnvBinding[] = [...standard];
  const sorted = [...bindings].sort((a, b) => a.applicationVariable.localeCompare(b.applicationVariable));
  for (const binding of sorted) {
    if (seen.has(binding.applicationVariable)) continue;
    const kind = toManifestKind(binding.semantic);
    if (kind === null) continue;
    seen.add(binding.applicationVariable);
    entries.push({ name: binding.applicationVariable, kind });
  }
  return entries;
}

/** Stage B phase 2 postgres bindings — standard injected names first, then detected aliases. */
const STANDARD_DATABASE_BINDINGS: readonly { name: string; kind: ManifestEnvBinding['kind'] }[] = [
  { name: 'DATABASE_URL', kind: 'url' },
  { name: 'DATABASE_HOST', kind: 'host' },
  { name: 'DATABASE_PORT', kind: 'port' },
  { name: 'DATABASE_NAME', kind: 'database' },
  { name: 'DATABASE_USER', kind: 'username' },
  { name: 'DATABASE_PASSWORD', kind: 'password' },
  // The `DB_*` family is the most common set of connection parts after the
  // DATABASE_* names (Laravel, Knex, TypeORM, wiki.js, homarr); an app whose
  // reads analysis cannot see still gets it.
  { name: 'DB_HOST', kind: 'host' },
  { name: 'DB_PORT', kind: 'port' },
  { name: 'DB_NAME', kind: 'database' },
  { name: 'DB_USER', kind: 'username' },
  { name: 'DB_PASSWORD', kind: 'password' },
];

/**
 * Whether the managed database's connection variable is unverified: neither a
 * standard name nor a detected alias is evidenced as read or declared by the
 * application. A detected alias is evidenced by construction (code read, env
 * file, Prisma datasource). Rows analysed before the env model and the
 * bindings existed carry no evidence, so they never fire.
 */
function isDatabaseConnectionUnverified(
  meta: Record<string, unknown>,
  bindings: readonly ManifestEnvBinding[],
  variables: readonly ManifestEnvVariable[],
): boolean {
  if (!Array.isArray(meta['infrastructureBindings']) || !Array.isArray(meta['envVarModel'])) return false;
  const standard = new Set(STANDARD_DATABASE_BINDINGS.map((binding) => binding.name));
  const evidenced = new Set([
    ...variables
      .filter((variable) => variable.source.some((text) => text.startsWith('read in ') || text.includes(' declares ')))
      .map((variable) => variable.key),
    ...stringArray(meta['databaseNamesMentioned']),
  ]);
  return !bindings.some((binding) => !standard.has(binding.name) || evidenced.has(binding.name));
}

/** The canonical storage binding plus detected alias bucket names. */
const STANDARD_STORAGE_BINDINGS: readonly { name: string; kind: ManifestEnvBinding['kind'] }[] = [
  { name: 'AWS_S3_BUCKET', kind: 'bucket' },
];
/** Bucket names the stack already injects — never repeated as detected aliases. */
const INJECTED_BUCKET_NAMES = new Set(['STORAGE_BUCKET', 'S3_BUCKET', 'AWS_S3_BUCKET']);

/**
 * Env var names (with semantics) that each provisioned value is injected
 * under — read off `metadata.infrastructureBindings` (Stage B phase 2). A
 * row analysed before the field existed carries none, so the caller falls
 * back to the standard injected names only.
 */
function readInfrastructureBindings(meta: Record<string, unknown>): InfrastructureBinding[] {
  const raw = meta['infrastructureBindings'];
  if (!Array.isArray(raw)) return [];
  const bindings: InfrastructureBinding[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Partial<InfrastructureBinding>;
    if (
      (record.resource === 'postgres' || record.resource === 'redis' || record.resource === 's3') &&
      typeof record.applicationVariable === 'string' &&
      typeof record.semantic === 'string'
    ) {
      bindings.push(record as InfrastructureBinding);
    }
  }
  return bindings;
}

// Directories that hold container/packaging tooling, not application code:
// a Dockerfile under `docker/` or `packaging/…` is written to build the app
// from the repository root (Stage A COMP-020).
const TOOLING_DIR_REGEX =
  /(?:^|\/)(?:[\w.-]*docker[\w.-]*|dockerfiles|\.devcontainer|packaging|deploy|deployment|build|ci|infra|scripts|container)(?:\/|$)/i;

/** The directory a Dockerfile lives in — the app root when nothing overrides it. */
function appRootFromDockerfile(dockerfilePath: string | null): string {
  if (!dockerfilePath) return '.';
  const index = dockerfilePath.lastIndexOf('/');
  if (index <= 0) return '.';
  const dir = dockerfilePath.slice(0, index);
  return TOOLING_DIR_REGEX.test(dir) ? '.' : dir;
}

/**
 * Env-var model → manifest entries. Structured `metadata.envVarModel` (the
 * §11.2 Phase 7 shape) is authoritative; a legacy row analysed before the
 * model existed carries only a name list, so it degrades to name entries with
 * no required/secret claim (fail-open — an unknown requirement never blocks).
 */
function toEnvVariables(model: unknown, names: unknown): ManifestEnvVariable[] {
  if (Array.isArray(model)) {
    const entries: ManifestEnvVariable[] = [];
    for (const raw of model) {
      if (typeof raw !== 'object' || raw === null) continue;
      const record = raw as Record<string, unknown>;
      if (typeof record['key'] !== 'string' || record['key'].length === 0) continue;
      const purpose =
        record['purpose'] === 'internal_secret' ||
        record['purpose'] === 'external_credential' ||
        record['purpose'] === 'infrastructure_binding' ||
        record['purpose'] === 'optional_configuration' ||
        record['purpose'] === 'unknown'
          ? record['purpose']
          : undefined;
      const confidence =
        record['confidence'] === 'high' || record['confidence'] === 'medium' || record['confidence'] === 'low'
          ? record['confidence']
          : undefined;
      const classification = envVariableClassificationSchema.safeParse(record['classification']);
      entries.push({
        key: record['key'],
        required: record['required'] === true,
        secret: record['secret'] === true,
        source: Array.isArray(record['source'])
          ? record['source'].filter((s): s is string => typeof s === 'string' && s.length > 0)
          : [],
        ...(purpose !== undefined ? { purpose } : {}),
        ...(confidence !== undefined ? { confidence } : {}),
        ...(record['generatable'] === true ? { generatable: true } : {}),
        ...(classification.success ? { classification: classification.data } : {}),
      });
    }
    return entries;
  }
  return stringArray(names).map((key) => ({ key, required: false, secret: false, source: [] }));
}

// ── Normalization ───────────────────────────────────────────────────────────

/**
 * Every declared worker process (Phase 4A): the analyser's
 * `resolvedWorkerCommands` list (Procfile non-web processes, compose worker
 * services) leads; rows analysed before it (or with only the API-resolved
 * npm-script command) normalize into a single `worker` entry so the legacy
 * single slot never becomes a numbered-field list. The workerCommand
 * override fills the gap only when detection found no declared process.
 */
function toDeclaredWorkers(
  meta: Record<string, unknown>,
  overrides: DeploymentManifestOverrides,
): ManifestWorker[] {
  const raw = meta['resolvedWorkerCommands'];
  if (Array.isArray(raw)) {
    const workers: ManifestWorker[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = asRecord(entry);
      const id = firstString(record['id']);
      const command = firstString(record['command']);
      if (id === null || command === null) continue;
      workers.push({ id, command, source: firstString(record['source']) ?? 'analysis' });
    }
    if (workers.length > 0) return workers;
  }
  const legacy =
    firstString(meta['resolvedWorkerCommand']) ?? firstString(overrides.workerCommand) ?? null;
  return legacy !== null ? [{ id: 'worker', command: legacy, source: 'package.json' }] : [];
}

/**
 * Phase 5 — queues/scheduledJobs/questions. `async-detection.ts` already
 * shapes its output as `ManifestQueue[]`/`ManifestScheduledJob[]`/
 * `ManifestQuestion[]`, so this only validates and drops any entry that
 * fails the contract (fail-closed per-entry, never the whole manifest).
 */
function toDeclaredQueues(meta: Record<string, unknown>): ManifestQueue[] {
  const raw = meta['asyncQueues'];
  if (!Array.isArray(raw)) return [];
  const queues: ManifestQueue[] = [];
  for (const entry of raw) {
    const parsed = manifestQueueSchema.safeParse(entry);
    if (parsed.success) queues.push(parsed.data);
  }
  return queues;
}

function toDeclaredScheduledJobs(meta: Record<string, unknown>): ManifestScheduledJob[] {
  const raw = meta['asyncScheduledJobs'];
  if (!Array.isArray(raw)) return [];
  const jobs: ManifestScheduledJob[] = [];
  for (const entry of raw) {
    const parsed = manifestScheduledJobSchema.safeParse(entry);
    if (parsed.success) jobs.push(parsed.data);
  }
  return jobs;
}

function toDeclaredQuestions(meta: Record<string, unknown>): ManifestQuestion[] {
  const raw = meta['asyncQuestions'];
  if (!Array.isArray(raw)) return [];
  const questions: ManifestQuestion[] = [];
  for (const entry of raw) {
    const parsed = manifestQuestionSchema.safeParse(entry);
    if (parsed.success) questions.push(parsed.data);
  }
  return questions;
}

/** The fixed component ids the graph always reserves (resources + the endpoint). */
const RESERVED_COMPONENT_IDS = ['web', 'migration', 'primary-db', 'cache', 'storage', 'endpoint'] as const;

/**
 * Keep only the queues and scheduled jobs the final manifest can compose: a
 * queue whose producers/consumers name a workload this manifest does not
 * declare (e.g. a vendor override replaced the workers), or any component id
 * that collides with another, becomes a Needs-input question instead — the
 * planner must never be handed a relationship it would reject.
 */
function reconcileAsyncDeclarations(
  workerIds: readonly string[],
  queues: ManifestQueue[],
  jobs: ManifestScheduledJob[],
  questions: ManifestQuestion[],
): { queues: ManifestQueue[]; jobs: ManifestScheduledJob[]; questions: ManifestQuestion[] } {
  const taken = new Set<string>([...RESERVED_COMPONENT_IDS, ...workerIds]);
  const claim = (ids: readonly string[]): boolean => {
    if (ids.some((id) => taken.has(id))) return false;
    for (const id of ids) taken.add(id);
    return true;
  };
  const extra: ManifestQuestion[] = [];

  const keptJobs = jobs.filter((job) => {
    const ids = [job.id, `${job.id}-schedule`, ...(job.deadLetter === true ? [`${job.id}-schedule-dlq`] : [])];
    if (claim(ids)) return true;
    extra.push({
      id: `schedule-${job.id}-conflict`,
      field: 'schedule',
      question: `The scheduled job ${job.id} (${job.source}) has a name that conflicts with another component. Confirm a distinct name for it.`,
      source: job.source,
    });
    return false;
  });

  const workloadIds = new Set<string>(['web', ...workerIds, ...keptJobs.map((job) => job.id)]);
  const keptQueues = queues.filter((queue) => {
    const members = [
      ...queue.producers,
      ...queue.consumers,
      ...(queue.deadLetter?.producers ?? []),
      ...(queue.deadLetter?.consumers ?? []),
    ];
    const ids = [queue.id, ...(queue.deadLetter !== undefined ? [`${queue.id}-dlq`] : [])];
    if (members.every((id) => workloadIds.has(id)) && claim(ids)) return true;
    extra.push({
      id: `queue-${queue.id}-unresolved`,
      field: 'queue_relationship',
      question: `The queue ${queue.id} (${queue.source}) connects processes Deployz cannot match to this application's declared workloads. Confirm its producer and consumer.`,
      source: queue.source,
    });
    return false;
  });

  return { queues: keptQueues, jobs: keptJobs, questions: [...questions, ...extra] };
}

/**
 * Build the validated, authoritative `DeploymentManifest` from detector output
 * and vendor overrides. Overrides always win over detection; detection is the
 * fallback for anything the vendor has not corrected.
 *
 * OUTPUT IS VALIDATED (deploymentManifestSchema.parse) — this is a trust
 * boundary: detector metadata comes from arbitrary repositories, and the
 * result is persisted to `deployments.desired_state` and consumed by the
 * relay, so an invalid manifest must never be written.
 */
export function normalizeDeploymentManifest(
  analysisResult: ManifestSource,
  vendorOverrides: DeploymentManifestOverrides,
): DeploymentManifest {
  const overrides = deploymentManifestOverridesSchema.parse(vendorOverrides);
  const meta = analysisResult.metadata ?? {};

  const dockerfilePath = overrides.dockerfilePath ?? firstString(meta['dockerfilePath']);
  const appRoot = overrides.appRoot ?? appRootFromDockerfile(dockerfilePath);
  const framework = firstString(meta['framework']);
  const packageManager = firstString(meta['packageManager']);
  const redisMeta = asRecord(meta['redis']);
  const postgresMeta = asRecord(meta['postgres']);
  const redisCompatibility = asRecord(redisMeta['compatibility']);
  const redisRequired = overrides.redisRequired ?? redisMeta['required'] === true;
  const storageRequired = overrides.storageRequired ?? meta['usesS3'] === true;
  // Phase 4B — which engine the managed relational database runs. MySQL is
  // a supported engine (assessed alongside PostgreSQL); a PostgreSQL
  // requirement always wins when both engines show evidence
  // (`assessMysql` already stands down for engine-configurable repos).
  const mysqlMeta = asRecord(meta['mysql']);
  const detectedEngine: 'postgres' | 'mysql' = postgresMeta['required'] !== true && mysqlMeta['required'] === true
    ? 'mysql'
    : 'postgres';
  const postgresRequired = overrides.databaseRequired ?? (postgresMeta['required'] === true || mysqlMeta['required'] === true);

  // Unsupported reasons — the blocking set. Everything here is a hard
  // incompatibility no override can fix. New analyses carry the full §11.4
  // reason list (`unsupportedReasons`); rows analysed before it fall back to
  // the legacy three sources so nothing silently unblocks.
  const unsupported: string[] = [];
  const detectedUnsupported = stringArray(meta['unsupportedReasons']);
  if (detectedUnsupported.length > 0) {
    unsupported.push(...detectedUnsupported);
  } else {
    if (redisCompatibility['supported'] === false) {
      unsupported.push(
        firstString(redisCompatibility['reason']) ?? 'Redis setup is not supported by Deployz',
      );
    }
    if (meta['databaseState'] === 'unsupported') {
      unsupported.push('An unsupported database was detected — Deployz hosts PostgreSQL and MySQL');
    }
  }
  if (meta['usesLocalFilesystem'] === true) {
    unsupported.push('Persistent local filesystem storage is not supported');
  }
  // DEPLOY-031: the source archive Deployz builds from has no git metadata,
  // so a Dockerfile that copies or reads .git fails every build.
  if (meta['copiesGitDirectory'] === true) {
    unsupported.push('The Dockerfile copies or reads the .git directory, which the source archive Deployz builds from does not contain');
  }
  // Phase 4A — background workers are first-class workloads. Each DECLARED
  // run process becomes a `workers[]` entry the graph compiles into its own
  // ECS service (one build artifact, one command per workload). Worker-like
  // code WITHOUT a declared process stays deployable: `worker.needsCommand`
  // records the open question (surfaced as an unresolved requirement), and
  // nothing is auto-provisioned from weak evidence such as a queue-library
  // dependency alone.
  const declaredWorkers = toDeclaredWorkers(meta, overrides);
  const workerNeedsCommand =
    meta['hasWorkerProcesses'] === true && meta['workerNeedsProcess'] !== false && declaredWorkers.length === 0;
  const ignoredDeploymentFiles = stringArray(meta['ignoredDeploymentFiles']);
  // Phase 5 — SQS queues and scheduled jobs, resolved by async-detection.ts.
  const {
    queues: declaredQueues,
    jobs: declaredScheduledJobs,
    questions: declaredQuestions,
  } = reconcileAsyncDeclarations(
    declaredWorkers.map((worker) => worker.id),
    toDeclaredQueues(meta),
    toDeclaredScheduledJobs(meta),
    toDeclaredQuestions(meta),
  );

  const envVariables = toEnvVariables(meta['envVarModel'], meta['envVars']);
  const databaseBindings = toEnvBindings(
    readInfrastructureBindings(meta).filter((b) => b.resource === 'postgres'),
    STANDARD_DATABASE_BINDINGS,
  );

  const migrationMode = migrationModeOf(
    meta,
    stringArray(meta['vendorOverrides']).includes('migrationCommand') && !overrides.migrationCommand,
  );
  const manifest: DeploymentManifest = {
    schemaVersion: DEPLOYMENT_MANIFEST_SCHEMA_VERSION,
    application: {
      root: appRoot,
      // Rows analysed before the runtime detector existed carry no
      // `runtime` key and keep the legacy Node-or-unknown inference.
      runtime: firstString(meta['runtime']) ?? (packageManager || framework ? 'node' : 'unknown'),
      framework,
      dockerfilePath,
    },
    build: {
      command: overrides.buildCommand ?? stringArray(meta['buildCommands'])[0] ?? null,
      // §11.1: the build context defaults to the repository ROOT. A Dockerfile
      // is addressed by its own path (`docker build -f path`), and a nested
      // Dockerfile that does `COPY apps/api/package.json` needs the root.
      context: overrides.buildContext ?? '.',
      // A vendor-chosen Dockerfile is the vendor's call; the detected one is checked.
      ...(overrides.dockerfilePath === undefined && stringArray(meta['dockerfileMissingSources']).length > 0
        ? { missingSources: stringArray(meta['dockerfileMissingSources']) }
        : {}),
    },
    web: {
      command: overrides.startCommand ?? stringArray(meta['startupCommands'])[0] ?? null,
      port:
        overrides.port ??
        (typeof meta['port'] === 'string' && meta['port'].length > 0
          ? Number.parseInt(meta['port'], 10) || null
          : null),
      // Stage B phase 7: a framework-default port is a prefill only — the
      // gate still requires the vendor to confirm it (portIsDefault).
      ...(overrides.port === undefined && meta['portSource'] === 'framework-default'
        ? { portIsDefault: true }
        : {}),
    },
    health: { ...normalizeHealthSection(overrides.healthPath, meta), ...(meta['hostChecked'] === true ? { hostChecked: true } : {}) },
    database: {
      // Legacy name for "Deployz provisions a managed relational database";
      // `engine` (Phase 4B) carries which engine it runs.
      postgres: postgresRequired,
      // Written ONLY for MySQL so every PostgreSQL manifest stays
      // byte-identical with pre-4B output (absent = postgres).
      ...(postgresRequired && detectedEngine === 'mysql' ? { engine: 'mysql' as const } : {}),
      ...(postgresRequired && detectedEngine === 'mysql' && mysqlMeta['urlScheme'] === 'mysql+pymysql'
        ? { urlScheme: 'mysql+pymysql' as const }
        : {}),
      // Stage B phase 2: the names the RDS URL/parts are injected under —
      // the standard DATABASE_* names always, plus the aliases the app reads
      // (MEMOS_DSN, PAPERLESS_DBHOST, …). Absent when no DB is provisioned.
      ...(postgresRequired
        ? {
            envBindings: databaseBindings,
            ...(isDatabaseConnectionUnverified(meta, databaseBindings, envVariables)
              ? { connectionUnverified: true }
              : {}),
          }
        : {}),
    },
    redis: {
      required: redisRequired,
      // Deployz always injects the standard bindings for a required cache;
      // the detected connection env vars (if any) refine which names carry
      // a full URL vs host/port.
      envBindings: redisRequired
        ? resolveRedisEnvBindings(stringArray(redisMeta['connectionEnvVars']))
        : [],
    },
    storage: {
      required: storageRequired,
      // The canonical AWS_S3_BUCKET always first (compat), then the alias
      // bucket names the app reads (S3_ATTACHMENTS_BUCKET, …) — names the
      // stack already injects are never repeated.
      envBindings: storageRequired
        ? toEnvBindings(
            readInfrastructureBindings(meta).filter(
              (b) =>
                b.resource === 's3' &&
                b.semantic === 'bucket' &&
                !INJECTED_BUCKET_NAMES.has(b.applicationVariable),
            ),
            STANDARD_STORAGE_BINDINGS,
          )
        : [],
    },
    migration: {
      // `metadata.migrationCommands` holds the detector's PATTERN LABELS
      // ("prisma migrate", "drizzle-kit"), never a runnable command — the
      // deploy-safe command is resolved per analysis into the application
      // column that arrives as the override (Stage A COMP-006). Stage B
      // phase 6: the analysed migration MODE rides along (pre_deploy /
      // startup / none / unknown).
      command: overrides.migrationCommand ?? null,
      ...(migrationMode !== undefined ? { mode: migrationMode } : {}),
      ...(meta['migrationNeedsInput'] !== undefined &&
      meta['migrationNeedsInput'] !== null &&
      !stringArray(meta['vendorOverrides']).includes('migrationCommand')
        ? { needsCommand: true }
        : {}),
    },
    worker: {
      // Legacy single slot: the FIRST worker's command, so consumers written
      // before `workers[]` existed keep working unchanged.
      command: declaredWorkers[0]?.command ?? null,
      ...(workerNeedsCommand ? { needsCommand: true } : {}),
    },
    ...(declaredWorkers.length > 0 ? { workers: declaredWorkers } : {}),
    ...(declaredQueues.length > 0 ? { queues: declaredQueues } : {}),
    ...(declaredScheduledJobs.length > 0 ? { scheduledJobs: declaredScheduledJobs } : {}),
    ...(declaredQuestions.length > 0 ? { questions: declaredQuestions } : {}),
    environment: {
      variables: envVariables,
    },
    ...(ignoredDeploymentFiles.length > 0 ? { ignoredDeploymentFiles } : {}),
    externalServices: stringArray(meta['externalServices']),
    unsupported,
  };

  return deploymentManifestSchema.parse(manifest);
}

// ── Readiness gate ──────────────────────────────────────────────────────────

const PROVISIONED_DATABASE_ENV_VARS = [
  'DATABASE_URL',
  'DATABASE_HOST',
  'DATABASE_PORT',
  'DATABASE_NAME',
  'DATABASE_USER',
  'DATABASE_PASSWORD',
] as const;

/** The variables Deployz generates for this deployment (Phase 4). */
export function generatedEnvKeys(manifest: DeploymentManifest): string[] {
  return manifest.environment.variables
    .filter((variable) => variable.classification === 'deployz_generated')
    .map((variable) => variable.key);
}

/**
 * Secrets the relay mints inside the customer's account when no value has
 * reached it. A saved decision rules: only "Managed by Deployz" on an
 * app-internal secret is minted. Without a decision: the `deployz_generated`
 * classification, plus an internal secret with a generatable name that the
 * analyser read as optional (kutt's envalid `devDefault`, DEPLOY-013). An
 * optional secret such as an ACME HMAC key or an analytics project key is
 * never minted: a random value turns on a feature the app then rejects.
 */
export function mintedEnvKeys(
  manifest: DeploymentManifest,
  settings: readonly EnvironmentSetting[] | null,
): string[] {
  const settingsByKey = new Map((settings ?? []).map((setting) => [setting.key, setting]));
  return manifest.environment.variables
    .filter((variable) => {
      const internalSecret = variable.secret && variable.purpose === 'internal_secret';
      const setting = settingsByKey.get(variable.key);
      if (setting) {
        return setting.provider === 'deployz' && !setting.binding && (internalSecret || variable.classification === 'deployz_generated');
      }
      return (
        variable.classification === 'deployz_generated' || (internalSecret && isGeneratableSecretName(variable.key))
      );
    })
    .map((variable) => variable.key);
}

/**
 * Evaluate the FINAL manifest before AWS provisioning.
 *
 *   - NOT_COMPATIBLE  — `unsupported` is non-empty: the app needs code changes
 *     Deployz cannot provision around (unsupported DB, local disk, Redis
 *     features beyond the managed profile).
 *   - NEEDS_CONFIGURATION — not incompatible, but missing required config
 *     (no Dockerfile / port / start command), so provisioning would fail or
 *     boot a container that cannot start.
 *   - READY — deployable as-is; findings may still carry warnings (e.g. a
 *     PostgreSQL app without a migration command).
 */
export function evaluateManifestReadiness(
  manifest: DeploymentManifest,
  context: ManifestReadinessContext = {},
): ManifestReadinessResult {
  const errors: ManifestReadinessFinding[] = [];
  const warnings: ManifestReadinessFinding[] = [];

  for (const reason of manifest.unsupported) {
    errors.push({
      id: 'unsupported',
      category: 'compatibility',
      severity: 'error',
      message: reason,
    });
  }
  if (!manifest.application.dockerfilePath) {
    errors.push({
      id: 'dockerfile-missing',
      category: 'container',
      severity: 'error',
      message: 'No Dockerfile was found; Deployz cannot build an image without container instructions.',
    });
  }
  if (manifest.application.dockerfilePath && (manifest.build.missingSources?.length ?? 0) > 0) {
    errors.push({
      id: 'dockerfile-missing-sources',
      category: 'container',
      severity: 'error',
      message: `The Dockerfile copies ${manifest.build.missingSources!.join(', ')}, which the repository does not contain (a build step makes it before docker build). Deployz builds from the repository only. Add a Dockerfile that builds the app from source, or select another Dockerfile.`,
    });
  }
  if (!manifest.web.port || manifest.web.portIsDefault === true) {
    errors.push({
      id: 'port-missing',
      category: 'application',
      severity: 'error',
      message:
        'The application port is unknown; Deployz cannot route traffic to a container without it.',
    });
  }
  if (!manifest.web.command) {
    errors.push({
      id: 'start-command-missing',
      category: 'application',
      severity: 'error',
      message: 'No start command was found; the container would boot with nothing to run.',
    });
  }
  if (manifest.health.mode === 'vendor_required') {
    errors.push({
      id: 'health-path-required',
      category: 'health',
      severity: 'error',
      message:
        'No health check route or container health check was found, so Deployz does not know when the app is ready. ' +
        'Expose a health route (for example /health) or add a container health check before deploying.',
    });
  }

  // §11.2 required env vars — a required value Deployz does not inject and
  // the operator has not supplied is a configuration gap. Evaluated only
  // when the caller knows the provided keys (deployment creation); without
  // that knowledge the finding cannot be answered honestly.
  if (context.providedEnvKeys !== undefined) {
    const autoProvided = new Set<string>();
    // The application stack injects the URL and the discrete connection
    // parts alike (packages/cdk application-stack: DATABASE_HOST/PORT/NAME/
    // USER plus the password secret). Stage B phase 2: the manifest's own
    // binding names (an app that reads only MEMOS_DSN or PAPERLESS_DBHOST
    // must not be blocked as missing required env) are auto-provided too.
    if (manifest.database.postgres) {
      for (const name of PROVISIONED_DATABASE_ENV_VARS) autoProvided.add(name);
      for (const binding of manifest.database.envBindings ?? []) autoProvided.add(binding.name);
    }
    if (manifest.redis.required) {
      for (const binding of manifest.redis.envBindings) autoProvided.add(binding.name);
    }
    if (manifest.storage.required) {
      for (const binding of manifest.storage.envBindings) autoProvided.add(binding.name);
    }
    for (const key of context.providedEnvKeys) autoProvided.add(key);
    // Phase 4: Deployz mints app-internal secrets inside the customer's
    // account on the first configuration pass after install.
    for (const key of generatedEnvKeys(manifest)) autoProvided.add(key);

    const missing = manifest.environment.variables
      .filter((variable) => variable.required && !autoProvided.has(variable.key))
      .map((variable) => variable.key);
    if (missing.length > 0) {
      const shown = missing.slice(0, 5);
      const more = missing.length - shown.length;
      const list = more > 0 ? `${shown.join(', ')}, and ${more} more` : shown.join(', ');
      errors.push({
        id: 'required-env-vars-missing',
        category: 'configuration',
        severity: 'error',
        message: `This app requires environment variables that have no value yet: ${list}. Set them in the application's Configuration screen before deploying.`,
      });
    }
  }

  if (manifest.database.connectionUnverified === true) {
    errors.push({
      id: 'database-connection-unverified',
      category: 'database',
      severity: 'error',
      message:
        'Deployz did not find which environment variable the app reads for its database connection. ' +
        'In Configuration, set that variable to "Managed by Deployz" and choose the database value.',
    });
  }

  // Inconsistency guard: a migration command without a database. A setting
  // resolves it (a database, or no separate migration) — never silently
  // provision a database to resolve the mismatch.
  if (manifest.migration.command && !manifest.database.postgres) {
    errors.push({
      id: 'migration-database-missing',
      category: 'database',
      severity: 'error',
      message:
        'This app is configured to run a database migration on deploy but the manifest does not require a database. Turn on the managed database, or choose "No separate migration" in the application settings.',
    });
  }

  if (manifest.migration.needsCommand === true) {
    errors.push({
      id: 'migration-command-needs-input',
      category: 'database',
      severity: 'error',
      message:
        'Deployz cannot confirm that the built image can run the detected migration script. Enter a migration command or choose "No separate migration" in the application settings before deploying.',
    });
  } else if (manifest.database.postgres && !manifest.migration.command) {
    warnings.push({
      id: 'migration-command-missing',
      category: 'database',
      severity: 'warning',
      message: `This app uses ${manifest.database.engine === 'mysql' ? 'MySQL' : 'PostgreSQL'} but has no migration command; schema updates will not run on deploy.`,
    });
  }

  if (manifest.ignoredDeploymentFiles && manifest.ignoredDeploymentFiles.length > 0) {
    warnings.push({
      id: 'deployment-files-ignored',
      category: 'compatibility',
      severity: 'warning',
      message: `Deployz ignores the deployment files in this repository (${manifest.ignoredDeploymentFiles.slice(0, 3).join(', ')}). It builds the Dockerfile and provisions the infrastructure itself.`,
    });
  }

  const state =
    manifest.unsupported.length > 0
      ? 'NOT_COMPATIBLE'
      : errors.length > 0
        ? 'NEEDS_CONFIGURATION'
        : 'READY';
  return { state, findings: [...errors, ...warnings] };
}