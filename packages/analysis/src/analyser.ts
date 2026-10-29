/**
 * Repository analyser orchestrator — runs all §18 detectors and §10 rejection
 * checks against a file tree and produces a structured analysis result.
 *
 * This is a PURELY DETERMINISTIC analyser (§20): rule-based, no ML, no AI.
 * The output maps to the `detectedMetadata` JSONB column on the Application row.
 */

import type { FileTree } from './detectors.js';
import type { DetectorFinding, PostgresRequirement } from './detectors.js';
import {
  detectDockerfile,
  detectFramework,
  detectPort,
  detectHealthEndpoint,
  detectEnvVars,
  detectEnvVarModel,
  detectPostgresql,
  assessPostgres,
  detectLocalFilesystem,
  detectWorker,
  detectS3,
  detectMigrationCommand,
  detectStartupCommand,
  detectExternalServices,
  detectExternalServiceRequirements,
  detectPackageManager,
  detectBuildCommand,
  detectRuntime,
  detectBindAddress,
  detectGitCopyInDockerfile,
  detectDockerfileBuildContext,
  detectDockerfileBuildTarget,
  detectHostValidation,
  detectStartupMigrationEvidence,
  detectDeclaredWorkerCommands,
  hasPreDeployMigration,
  isRuntimeSourcePath,
  TREE_PATHS,
  detectDockerfileMissingCopySources,
  dockerfileSelectionTied,
  pathInRuntimeImage,
  START_COMMAND_WORKER,
  unusableMigrationScript,
} from './detectors.js';

import type { RejectionFinding } from './rejection.js';
import {
  DATABASE_REJECTION_TOKENS,
  checkRedisUnsupported,
  checkMysql,
  assessMysql,
  checkMongo,
  checkElasticsearch,
  checkOtherUnsupportedDatabases,
  checkSqlite,
  checkKafka,
  checkRabbitMq,
  checkKubernetes,
  checkServerless,
  checkDockerComposeMultiService,
  checkPersistentVolumes,
  checkTerraform,
  checkPulumi,
  checkCloudFormation,
  checkAzure,
  checkGcp,
  checkGpu,
  checkNoBuildableDockerfile,
  checkExplicitPersistentDataDir,
  checkRequiredConfigFileMount,
  checkMultiProcessImage,
  checkRequiredThirdPartyService,
  checkUnexplainedDeclaredServices,
  listIgnoredDeploymentFiles,
} from './rejection.js';

import { classifyEnvVariables, MANAGED_DATABASE_ENV_VARS } from './env-classification.js';
import type { RedisRequirement } from './redis.js';
import { assessRedis, resolveRedisEnvBindings } from './redis.js';
import { deriveAmbiguities } from './evidence.js';
import { deriveInfrastructureBindings, prismaDatasourceEnvNames } from './bindings.js';
import { detectAsyncWorkloads } from './async-detection.js';

/**
 * A server file that handles a health route (`HealthAction.php`, `GreenfieldHealthController.cs`, `health_check.ex`).
 * A prefixed check without a handler word (`RedisHealthCheck.cs`) checks a dependency, not a route.
 */
const HEALTH_HANDLER_FILE_REGEX =
  /(?:^|\/)(?:health[_-]?(?:check)?|\w*?health[_-]?(?:check)?[_-]?(?:action|controller|handler|endpoint|route|resource|view))\.(?:php|py|rb|exs?|go|java|kt|cs|[cm]?[jt]s)$/i;

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * The resolved database state of an analysed repository.
 *
 * - `postgres` — PostgreSQL detected; the app is provisioned a managed RDS
 *   instance and `DATABASE_*` env vars.
 * - `none` — No database detected; the app deploys without DB resources, DB
 *   env vars, or DB steps. Analysis succeeds.
 * - `unsupported` — A database Deployz does not support (MySQL/Mongo/etc.)
 *   was detected by the §10 rejection checks; verdict is NOT_COMPATIBLE.
 * - `unknown` — Reserved for future detectors that detect a database they
 *   cannot classify; not emitted by the current detectors. Non-fatal unless a
 *   later check proves deployment cannot proceed.
 */
export type DatabaseState = 'none' | 'postgres' | 'mysql' | 'unsupported' | 'unknown';

/** Complete result from a repository analysis. */
export interface AnalysisResult {
  /** All §18 detector findings. */
  findings: DetectorFinding[];
  /** All §10 rejection check results. */
  rejections: RejectionFinding[];
  /** Flattened metadata suitable for the `detectedMetadata` JSONB column. */
  metadata: Record<string, unknown>;
}

// ── Orchestrator ────────────────────────────────────────────────────────────

/** All §18 detector functions, in order. */
const DETECTORS = [
  detectDockerfile,
  detectFramework,
  detectPort,
  detectHealthEndpoint,
  detectEnvVars,
  detectPostgresql,
  detectLocalFilesystem,
  detectWorker,
  detectS3,
  detectMigrationCommand,
  detectStartupCommand,
  detectExternalServices,
  detectPackageManager,
  detectBuildCommand,
  detectRuntime,
  detectBindAddress,
  detectGitCopyInDockerfile,
  detectDockerfileBuildContext,
  detectDockerfileBuildTarget,
  detectHostValidation,
] as const;

/** All §10 rejection check functions, in order. `mysql` is handled separately
 *  (see `analyseRepo`): its MariaDB-only rejection shares the assessed MySQL
 *  requirement, like `redis`. */
const REJECTION_CHECKS = [
  checkMongo,
  checkElasticsearch,
  checkOtherUnsupportedDatabases,
  checkSqlite,
  checkKafka,
  checkRabbitMq,
  checkKubernetes,
  checkServerless,
  checkDockerComposeMultiService,
  checkPersistentVolumes,
  checkTerraform,
  checkPulumi,
  checkCloudFormation,
  checkAzure,
  checkGcp,
  checkGpu,
  checkNoBuildableDockerfile,
  checkExplicitPersistentDataDir,
  checkRequiredConfigFileMount,
  checkMultiProcessImage,
  checkRequiredThirdPartyService,
] as const;

/**
 * Build the `redis` detector finding from a precomputed `RedisRequirement`.
 *
 * `detected` follows the §7 confidence policy nuance: true whenever real
 * Redis evidence exists (confidence 'high' or 'medium'), regardless of
 * whether that evidence is enough to *provision* Redis — the provisioning
 * decision lives in `metadata.redis.required`, not here.
 */
function buildRedisFinding(redis: RedisRequirement): DetectorFinding {
  const detected = redis.confidence !== 'low';
  return {
    detector: 'redis',
    detected,
    value: redis.purposes,
    details: detected
      ? `Redis detected (${redis.confidence} confidence): ${redis.evidence.join('; ')}`
      : 'No significant Redis usage detected',
  };
}

// Node job libraries and `worker_threads` run inside the web process by default, and so does a
// queue consumer that the image's start command runs. A repository whose only worker evidence is
// one of these needs no separate worker process; a declared worker process, a queue worker
// command or a Compose worker service still does.
const IN_PROCESS_WORKER_PATTERNS: ReadonlySet<string> = new Set([
  'bull',
  'bullmq',
  'agenda',
  'bree',
  'pg-boss',
  'graphile-worker',
  'worker_threads',
  START_COMMAND_WORKER,
]);

/**
 * Build a flat metadata record from findings.
 * Maps detector names to their detected values for easy JSONB storage and querying.
 */
function buildMetadata(
  findings: DetectorFinding[],
  redis: RedisRequirement,
  postgres: PostgresRequirement,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {};

  for (const f of findings) {
    const key = f.detector.replace(/-/g, '');

    // Map common detectors to friendly metadata keys
    switch (f.detector) {
      case 'dockerfile':
        meta['hasDockerfile'] = f.detected;
        if (f.detected && f.value) meta['dockerfilePath'] = f.value;
        break;
      case 'framework':
        meta['framework'] = f.detected ? f.value : null;
        break;
      case 'port':
        meta['port'] = f.detected ? f.value : null;
        break;
      case 'health-endpoint':
        meta['hasHealthEndpoint'] = f.detected;
        if (f.detected && f.value) meta['healthEndpointSources'] = f.value;
        break;
      case 'env-vars':
        meta['hasEnvVars'] = f.detected;
        if (f.detected && f.value) meta['envVars'] = f.value;
        break;
      case 'postgresql':
        meta['usesPostgresql'] = f.detected;
        if (f.detected && f.value) meta['postgresqlDrivers'] = f.value;
        meta['postgres'] = postgres;
        break;
      case 'redis':
        meta['usesRedis'] = f.detected;
        meta['redis'] = redis;
        break;
      case 'local-filesystem':
        meta['usesLocalFilesystem'] = f.detected;
        if (f.detected && f.value) meta['localFilesystemOps'] = f.value;
        break;
      case 'worker':
        meta['hasWorkerProcesses'] = f.detected;
        if (f.detected && f.value) meta['workerPatterns'] = f.value;
        meta['workerNeedsProcess'] = Array.isArray(f.value) && f.value.some((pattern) => !IN_PROCESS_WORKER_PATTERNS.has(pattern));
        break;
      case 's3':
        meta['usesS3'] = f.detected;
        if (f.detected && f.value) meta['s3Indicators'] = f.value;
        break;
      case 'migration-command':
        meta['hasMigrationCommand'] = f.detected;
        if (f.detected && f.value) meta['migrationCommands'] = f.value;
        break;
      case 'startup-command':
        meta['hasStartupCommand'] = f.detected;
        if (f.detected && f.value) meta['startupCommands'] = f.value;
        break;
      case 'external-services':
        meta['hasExternalServices'] = f.detected;
        if (f.detected && f.value) meta['externalServices'] = f.value;
        break;
      case 'package-manager':
        meta['packageManager'] = f.detected ? f.value : null;
        break;
      case 'build-command':
        meta['hasBuildCommand'] = f.detected;
        if (f.detected && f.value) meta['buildCommands'] = f.value;
        break;
      case 'runtime':
        meta['runtime'] = f.detected ? f.value : null;
        break;
      case 'bind-address':
        meta['bindsLocalhost'] = f.detected;
        meta['bindAddress'] = f.value ?? null;
        break;
      case 'dockerfile-build-context':
        if (f.detected && f.value) meta['dockerfileBuildContext'] = f.value;
        break;
      case 'host-validation':
        meta['hostChecked'] = f.detected;
        break;
      case 'dockerfile-build-target':
        if (f.detected && f.value) meta['dockerfileBuildTarget'] = f.value;
        break;
      case 'dockerfile-git-copy':
        meta['copiesGitDirectory'] = f.detected;
        if (f.detected && f.value) meta['gitCopyInstructions'] = f.value;
        break;
      default:
        meta[key] = f.detected ? f.value ?? true : false;
    }
  }

  return meta;
}

/**
 * Resource facts that the AI Analysis verified (`ai-analysis/merge.ts`). The
 * analysis re-runs with them so every value derived from a resource (the
 * env-var model, the bindings, the database state, the migration mode) comes
 * from the same rules. A rejection changes only when a checked AI answer
 * dismisses it (the item is not used, or a setting replaces it).
 */
export interface ResourceOverrides {
  readonly database?: 'postgres' | 'mysql' | 'none' | undefined;
  readonly redis?: boolean | undefined;
  readonly storage?: boolean | undefined;
  /** False: the declared local-filesystem state is not durable app data. */
  readonly localFilesystem?: false | undefined;
  /** Rejection reasons that a checked AI answer dismissed. */
  readonly dismissedRejections?: readonly string[] | undefined;
}

/**
 * Run the full deterministic analysis: all §18 detectors + all §10 rejection checks.
 *
 * Returns an `AnalysisResult` whose `metadata` field maps to the
 * `applications.detected_metadata` JSONB column.
 *
 * This function is PURE: same input → same output every time. No randomness, no
 * AI, no external calls. The §19 verdict engine (todo 23) consumes this output.
 */
export function analyseRepo(tree: FileTree, overrides: ResourceOverrides = {}): AnalysisResult {
  const findings: DetectorFinding[] = [];
  const rejections: RejectionFinding[] = [];

  for (const detector of DETECTORS) {
    const finding = detector(tree);
    if (finding.detector === 's3' && overrides.storage !== undefined) findings.push({ ...finding, detected: overrides.storage });
    else if (finding.detector === 'local-filesystem' && overrides.localFilesystem === false) findings.push({ ...finding, detected: false });
    else findings.push(finding);
  }

  // Redis is computed once here (not folded into DETECTORS/REJECTION_CHECKS,
  // which are uniform `(tree) => Finding` arrays) so the single `assessRedis`
  // call can be shared between the `redis` finding, the unsupported-Redis
  // rejection check, and `buildMetadata`'s full `metadata.redis` object.
  const assessedRedis = assessRedis(tree);
  const redis = overrides.redis === undefined ? assessedRedis : { ...assessedRedis, required: overrides.redis };
  findings.push(buildRedisFinding(redis));

  // Postgres is computed once here for the same reason as `redis` above —
  // `metadata.postgres` needs the full required-vs-present assessment, not
  // just the `postgresql` finding's `detected` (library presence) flag.
  const assessedPostgres = assessPostgres(tree);
  const postgres =
    overrides.database === undefined ? assessedPostgres : { ...assessedPostgres, required: overrides.database === 'postgres' };

  // MySQL is a SUPPORTED managed database (Phase 4B) — assessed once for
  // the `metadata.mysql` requirement object the manifest's engine reads.
  const assessedMysql = assessMysql(tree);
  const mysql = overrides.database === undefined ? assessedMysql : { ...assessedMysql, required: overrides.database === 'mysql' };

  // The rejections always read the rules' own assessment: a resource override never adds or removes one.
  const dismissed = new Set(overrides.dismissedRejections ?? []);
  const checked: RejectionFinding[] = [];
  const reject = (finding: RejectionFinding): void => {
    checked.push(finding);
    if (!dismissed.has(finding.reason)) rejections.push(finding);
  };
  reject(checkRedisUnsupported(tree, assessedRedis));
  reject(checkMysql(tree));
  for (const check of REJECTION_CHECKS) {
    reject(check(tree));
  }
  reject(
    checkUnexplainedDeclaredServices(tree, {
      postgres: assessedPostgres.evidence.length > 0,
      mysql: assessedMysql.detected,
      redis: assessedRedis.required,
      storage: findings.some((finding) => finding.detector === 's3' && finding.detected),
      rejectionReasons: checked.filter((finding) => finding.detected).map((finding) => finding.reason),
    }),
  );

  const metadata = buildMetadata(findings, redis, postgres);

  // Stage B phase 5: surface the health endpoint's resolved path and MODE so
  // manifest normalization never silently assumes `/health`. Without health
  // evidence the check probes `/` and also accepts a redirect (a login or setup
  // page proves the server is up). `vendor_required` is kept for an app with a
  // health handler whose route was not resolved: it has a route that `/` may not be.
  const healthFinding = findings.find((f) => f.detector === 'health-endpoint');
  if (healthFinding?.detected) {
    metadata['healthPath'] = healthFinding.path ?? null;
    metadata['healthMode'] = healthFinding.mode ?? 'explicit';
    // The image's own check of `/` (`wget --spider`, `curl -f`) passes on a redirect too.
    if (healthFinding.mode === 'root') metadata['healthRedirectsAccepted'] = true;
  } else if (
    ((tree as FileTree & { [TREE_PATHS]?: readonly string[] })[TREE_PATHS] ?? Object.keys(tree)).some(
      (path) => HEALTH_HANDLER_FILE_REGEX.test(path) && isRuntimeSourcePath(path),
    )
  ) {
    metadata['healthPath'] = null;
    metadata['healthMode'] = 'vendor_required';
  } else {
    metadata['healthPath'] = '/';
    metadata['healthMode'] = 'root';
    metadata['healthRedirectsAccepted'] = true;
  }

  // Stage B phase 7 (COMP-030): the port's provenance, so the deployment gate
  // can prefill a framework default without ever auto-deploying on a guess.
  const portFinding = findings.find((f) => f.detector === 'port');
  if (portFinding?.detected && typeof portFinding.value === 'string') {
    metadata['portSource'] = portFinding.portSource;
    metadata['portConfidence'] = portFinding.portConfidence;
  }

  // Stage B phase 6 (COMP-014): migration MODE — how the database schema is
  // updated. `pre_deploy` (a deploy-safe migration script), `startup` (the
  // app runs migrations when it starts — evidence recorded, command never
  // invented), `unknown` (required database, no migration evidence anywhere),
  // or `none` (no database, so no migrations to run). A required MySQL
  // database is the same managed relational database as PostgreSQL here;
  // an unconfirmed MySQL driver only raises the binding question.
  const postgresMeta = metadata['postgres'] as { required?: unknown } | undefined;
  metadata['mysql'] = mysql;
  metadata['usesMysql'] = mysql.detected;
  if (metadata['usesPostgresql'] !== true && !mysql.required && !(overrides.database === 'postgres')) {
    metadata['migrationMode'] = 'none';
  } else if (postgresMeta?.required !== true && !mysql.required) {
    // A detected-but-unconfirmed database: keep the gentle recommendation.
    metadata['migrationMode'] = 'unknown';
  } else {
    // DEPLOY-029: the selected Dockerfile's own CMD/ENTRYPOINT chain wins
    // over a package.json deploy-shaped script. When the built image
    // migrates itself at boot (umami: CMD -> scripts/start-docker.sh ->
    // scripts/check-db.js -> `prisma migrate deploy`), that is the command
    // that actually runs — re-running a package.json script as a pre-deploy
    // step invents a command the image was never built to run standalone
    // (the runner stage can even remove npx on purpose).
    const startupEvidence = detectStartupMigrationEvidence(tree);
    if (startupEvidence.some((entry) => entry.fromDockerCommand)) {
      metadata['migrationMode'] = 'startup';
      metadata['migrationStartupEvidence'] = startupEvidence;
    } else if (hasPreDeployMigration(tree)) {
      metadata['migrationMode'] = 'pre_deploy';
    } else {
      metadata['migrationMode'] = startupEvidence.length > 0 ? 'startup' : 'unknown';
      if (startupEvidence.length > 0) {
        metadata['migrationStartupEvidence'] = startupEvidence;
      }
    }
  }

  // A Django project whose image never migrates: suggest the standard
  // command. It is shown in the readiness finding for the vendor to accept
  // as the migration command, never written into the manifest.
  if (metadata['migrationMode'] === 'unknown') {
    // The path is the one in the runtime image (`COPY ./src ./` puts `src/manage.py` at `manage.py`);
    // a manage.py the image never copies gives no suggestion.
    const manage = Object.entries(tree)
      .filter(([path, content]) => /(?:^|\/)manage\.py$/.test(path) && /DJANGO_SETTINGS_MODULE/.test(content ?? ''))
      .map(([path]) => pathInRuntimeImage(tree, path))
      .find((path) => path !== null);
    if (manage) metadata['suggestedMigrationCommand'] = `python ${manage} migrate --noinput`;
    // A required database whose migration step is a script Deployz cannot run is a vendor question,
    // never READY: the app can refuse to start until the step runs (Logto: undeployed alterations).
    const step = postgresMeta?.required === true || mysql.required ? unusableMigrationScript(tree) : undefined;
    if (step) {
      metadata['migrationQuestion'] = {
        candidate: '',
        reason: `The package script "${step[0]}" (${step[1]}) changes the database, but nothing runs it when the application starts and it is no deploy-safe migration command.`,
      };
    }
  }

  // §11.4 — the full unsupported-reason list the manifest gate turns into
  // NOT_COMPATIBLE. Kept as plain strings on the metadata so a deployment
  // created from STORED detected_metadata blocks exactly like one created
  // straight after analysis.
  const detectedRejections = rejections.filter((r) => r.detected);
  metadata['unsupportedReasons'] = detectedRejections.map((r) => r.reason);
  metadata['ignoredDeploymentFiles'] = listIgnoredDeploymentFiles(tree).slice(0, 5);

  // Phase 4A — every declared worker process (Procfile non-web process,
  // compose worker service) rides the metadata so the deployment manifest's
  // `workers[]` list reads CURRENT analysis output. Empty when no process
  // declares a worker; the API-resolved single command arrives separately as
  // `resolvedWorkerCommand` / the workerCommand override (legacy slot).
  metadata['resolvedWorkerCommands'] = detectDeclaredWorkerCommands(tree);

  // Phase 5 — SQS (Standard) queues and scheduled jobs, already shaped as
  // ManifestQueue[]/ManifestScheduledJob[]/ManifestQuestion[] so the
  // manifest layer only validates and passes them through.
  const asyncWorkloads = detectAsyncWorkloads(tree);
  metadata['asyncQueues'] = asyncWorkloads.queues;
  metadata['asyncScheduledJobs'] = asyncWorkloads.scheduledJobs;
  metadata['asyncQuestions'] = asyncWorkloads.questions;
  // Every env var a PROVISIONED queue (or its dead-letter queue) is bound
  // to is Deployz-managed infrastructure — mirrors REDIS_URL/DATABASE_URL
  // (env-classification.ts) so the vendor is never asked to supply it.
  const queueBindingNames = asyncWorkloads.queues.flatMap((queue) => [
    ...queue.envBindings.map((b) => b.name),
    ...(queue.deadLetter?.envBindings.map((b) => b.name) ?? []),
  ]);

  // §11.3 / §11.2 — structured service requirements and the env-var model.
  const serviceRequirements = detectExternalServiceRequirements(tree);
  metadata['externalServiceRequirements'] = serviceRequirements;
  // Phase 4 — who supplies each value, decided from the requirements above.
  // A required MySQL database manages the same generic DATABASE_* names as
  // PostgreSQL, so both engines mark the managed-database env vars.
  const databaseRequired = postgresMeta?.required === true || mysql.required;
  const storageRequired = findings.find((f) => f.detector === 's3')?.detected === true;
  metadata['envVarModel'] = classifyEnvVariables(
    detectEnvVarModel(
      tree,
      serviceRequirements.map((r) => r.service),
      { database: mysql.required ? 'mysql' : databaseRequired ? 'postgres' : null, storage: storageRequired },
    ),
    {
      postgresRequired: databaseRequired,
      databaseBindingNames: prismaDatasourceEnvNames(tree),
      redisRequired: redis.required,
      redisBindingNames: resolveRedisEnvBindings(redis.connectionEnvVars).map((binding) => binding.name),
      storageRequired,
      externalServices: serviceRequirements.map((r) => r.service),
      queueBindingNames,
    },
  );

  metadata['databaseState'] = deriveDatabaseState(findings, rejections, postgres.required, mysql.required);

  const result: AnalysisResult = { findings, rejections, metadata };
  // §15 typed evidence surface: the facts the deterministic pipeline left
  // unresolved (build target, start/build/port, DB/cache/storage bindings,
  // health path, migration strategy, worker gate). Purely derived — it never
  // feeds back into a finding, rejection, or verdict.
  metadata['ambiguities'] = deriveAmbiguities(tree, result);
  // Stage B phase 2: the env var names each provisioned value must be injected
  // under (MEMOS_DSN, PAPERLESS_DBHOST, CELERY_BROKER_URL, …). Purely derived
  // read-model over the env-var model — never feeds back into a verdict.
  metadata['infrastructureBindings'] = deriveInfrastructureBindings(tree, result);
  metadata['dockerfileMissingSources'] = detectDockerfileMissingCopySources(tree);
  // The Dockerfiles that no ranking signal tells apart from the selected one: the pick is a guess.
  const tiedDockerfiles = dockerfileSelectionTied(tree);
  if (tiedDockerfiles) metadata['dockerfileSelectionTied'] = tiedDockerfiles;
  // A standard database name written in a runtime file (a Go `case "DATABASE_URL":`,
  // a compose `environment:` entry) is evidence that the app reads it, even
  // when the read shape is not one the env-var model parses. The DB_* names are the ones the
  // manifest also injects (an enum `case DB_HOST = 'DB_HOST'` read through `env($this->value)`).
  metadata['databaseNamesMentioned'] = [...MANAGED_DATABASE_ENV_VARS, 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'].filter((name) =>
    Object.entries(tree).some(
      ([path, content]) => Boolean(content) && isRuntimeSourcePath(path) && new RegExp(`\\b${name}\\b`).test(content!),
    ),
  );
  return result;
}

/**
 * Derive the `databaseState` metadata value from the detector findings and
 * §10 rejections. The required engine comes first, in the manifest's order (PostgreSQL,
 * then MySQL); an unsupported database outranks a PostgreSQL driver that nothing
 * requires (a SQLite app with `drizzle-orm`). Only a rejection
 * whose dependency is an actual DATABASE
 * token (§10) counts here — an architecture/cloud/cache rejection (§11.4)
 * means the app is unsupported but is not a "database" verdict, and
 * Redis-only rejections are about the cache, not the database.
 */
function deriveDatabaseState(
  findings: DetectorFinding[],
  rejections: RejectionFinding[],
  postgresRequired: boolean,
  mysqlRequired: boolean,
): DatabaseState {
  if (postgresRequired) return 'postgres';
  if (mysqlRequired) return 'mysql';

  const unsupportedDb = rejections.some(
    (r) => r.detected && r.dependency !== 'redis-unsupported' && DATABASE_REJECTION_TOKENS.has(r.dependency),
  );
  if (unsupportedDb) return 'unsupported';

  const postgres = findings.find((f) => f.detector === 'postgresql')?.detected === true;
  return postgres ? 'postgres' : 'none';
}