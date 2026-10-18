/**
 * Failure classification — from the evidence a run collected to the fixed
 * failure-stage vocabulary, with a provisional root cause and the evidence
 * that chose it. The rules are deliberately conservative: when the
 * evidence does not decide the layer, the root cause stays null and the
 * result says what still has to be investigated. Nothing here names a
 * repository.
 */
import type { FailureStage, RootCause } from './results.js';

/** Where the funnel was when it stopped. */
export type FunnelPoint =
  | 'gate'
  | 'configuration'
  | 'secrets-delivery'
  | 'build'
  | 'install'
  | 'auto-deploy'
  | 'inventory'
  | 'runtime'
  | 'https'
  | 'smoke'
  | 'update'
  | 'dependencies'
  | 'cleanup'
  | 'harness';

export interface FailureEvidence {
  readonly point: FunnelPoint;
  /** What the harness observed as the immediate error text. */
  readonly message: string;
  readonly timedOut?: boolean;
  /** The deployment gate's verdict when the failure is at the gate. */
  readonly gateVerdict?: 'READY' | 'NEEDS_CONFIGURATION' | 'NOT_COMPATIBLE' | null | undefined;
  /** The release's failureReason when the build failed. */
  readonly releaseFailure?: string | null;
  /** The deployment's failure code (`deploymentStatus.failure.code`). */
  readonly failureCode?: string | null;
  readonly stackStatus?: string | null;
  /** CloudFormation resource failures (`<type>: <reason>`). */
  readonly stackReasons?: readonly string[];
  readonly stoppedTasks?: readonly { exitCode: number | null; reason: string | null; stoppedReason: string | null }[];
  readonly logTail?: readonly string[];
  readonly targetHealth?: readonly string[];
  /** Probe status codes seen on the health path over HTTP / HTTPS, null when unreachable. */
  readonly healthStatuses?: readonly (number | null)[];
  readonly appStatuses?: readonly (number | null)[];
  readonly httpsStatus?: string | null;
  readonly migrationFailed?: boolean;
  readonly healthPathSource?: 'stage-b' | 'manifest' | 'repository-evidence' | 'fallback' | null;
  readonly manifestHealthPath?: string | null;
  readonly probedHealthPath?: string | null;
}

export interface ClassifiedFailure {
  readonly failureStage: FailureStage;
  readonly rootCause: RootCause | null;
  readonly rootCauseEvidence: string;
}

/** Lines that name the database connection itself as the problem. */
const DB_CONNECTION_PATTERNS = [
  /ECONNREFUSED.*:5432/i,
  /password authentication failed/i,
  /no pg_hba\.conf entry/i,
  /SSL (?:connection )?(?:is )?required|sslmode|no encryption/i,
  // TLS verification against the RDS chain (DEPLOY-007): node-postgres, libpq, OpenSSL wordings.
  /self[- ]signed certificate|certificate (?:chain|verify failed)|unable to (?:get|verify) (?:local )?issuer certificate|SSL error|SSL SYSCALL error|ssl handshake/i,
  /database ".*" does not exist/i,
  /could not connect to (?:server|database)|connection to (?:server|database).*(?:refused|failed)/i,
  /getaddrinfo ENOTFOUND.*(?:postgres|db|database)/i,
];
/** Lines that name a database driver failing for any reason (a schema, a query, a connection). */
const DB_PATTERNS = [
  ...DB_CONNECTION_PATTERNS,
  /relation ".*" does not exist/i,
  /(?:postgres|postgresql|pg|prisma|sequelize|typeorm|knex|sqlalchemy|psycopg|diesel|gorm)[^\n]{0,80}(?:refused|timed? ?out|failed|error)/i,
];
const REDIS_PATTERNS = [/ECONNREFUSED.*:6379/i, /redis[^\n]{0,80}(?:refused|timed? ?out|failed|error|unavailable)/i, /NOAUTH|WRONGPASS/i];
const ENV_PATTERNS = [
  /(?:missing|required|must be set|not set|undefined|is not defined)[^\n]{0,60}(?:env|environment|variable|config)/i,
  /(?:env|environment|variable|config)[^\n]{0,60}(?:missing|required|must be set|not set|undefined|is not defined)/i,
  /invalid environment variables/i,
  /Error: (?:DATABASE_URL|[A-Z][A-Z0-9_]{3,}) (?:is|was) (?:not|missing|required)/,
];
const MIGRATION_PATTERNS = [/migrat(?:e|ion)[^\n]{0,80}(?:failed|error)/i, /prisma migrate/i, /alembic|flyway|liquibase|knex migrate|rails db:migrate/i];
const STORAGE_PATTERNS = [/(?:S3|bucket)[^\n]{0,80}(?:AccessDenied|NoSuchBucket|failed|error)/i, /EACCES|EROFS|read-only file system/i];
const PORT_PATTERNS = [/EADDRINUSE|address already in use/i, /listen(?:ing)? on [^\n]*:(\d{2,5})/i];

function matches(lines: readonly string[] | undefined, patterns: readonly RegExp[]): string | null {
  for (const line of lines ?? []) {
    for (const pattern of patterns) {
      if (pattern.test(line)) return line;
    }
  }
  return null;
}

function nonZeroExit(evidence: FailureEvidence): { exitCode: number; reason: string | null } | null {
  for (const task of evidence.stoppedTasks ?? []) {
    if (task.exitCode !== null && task.exitCode !== 0) return { exitCode: task.exitCode, reason: task.reason ?? task.stoppedReason };
  }
  return null;
}

function healthCheckStop(evidence: FailureEvidence): string | null {
  for (const task of evidence.stoppedTasks ?? []) {
    const text = `${task.stoppedReason ?? ''} ${task.reason ?? ''}`;
    if (/health ?check/i.test(text)) return text.trim();
  }
  return null;
}

function trim(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

/**
 * Classify one failure. Order matters: the earliest deciding evidence wins,
 * and container-level evidence outranks the coarse CloudFormation status.
 */
export function classifyFailure(evidence: FailureEvidence): ClassifiedFailure {
  const { point } = evidence;

  if (point === 'harness') {
    return { failureStage: 'TEST_HARNESS_ERROR', rootCause: 'TEST_HARNESS_FAILURE', rootCauseEvidence: trim(evidence.message) };
  }

  if (point === 'gate') {
    if (evidence.gateVerdict === 'NOT_COMPATIBLE') {
      return { failureStage: 'GATE_ERROR', rootCause: null, rootCauseEvidence: `the gate rejected the repository: ${trim(evidence.message)} — decide ANALYSIS_BUG vs ANALYSIS_MISSING_SIGNAL vs MVP_CAPABILITY_GAP vs CORRECTLY_UNSUPPORTED from the rejection evidence` };
    }
    return { failureStage: 'GATE_ERROR', rootCause: null, rootCauseEvidence: trim(evidence.message) };
  }

  if (point === 'configuration') {
    return { failureStage: 'CONFIG_ERROR', rootCause: null, rootCauseEvidence: `the gate still refuses with the Stage B configuration: ${trim(evidence.message)} — decide REPO_CONFIGURATION (fix the config) vs ANALYSIS_BUG (a required key the app does not need)` };
  }

  if (point === 'secrets-delivery') {
    return { failureStage: 'ENV_BINDING_ERROR', rootCause: null, rootCauseEvidence: `the customer-scope secret delivery failed: ${trim(evidence.message)} — decide DEPLOYZ_BUG vs TEST_HARNESS_FAILURE` };
  }

  if (point === 'build') {
    const reason = evidence.releaseFailure ?? evidence.message;
    if (evidence.timedOut) return { failureStage: 'TIMEOUT', rootCause: null, rootCauseEvidence: `build did not settle: ${trim(reason)}` };
    // A metered base-image pull is a time window on a shared address, not a
    // statement about the repository. Left to the generic branch below it
    // records the application as unbuildable, which the corpus then carries
    // as a false verdict.
    if (/rate limit \(HTTP 429\)/i.test(reason)) {
      return { failureStage: 'BUILD_ERROR', rootCause: 'AWS_TRANSIENT_FAILURE', rootCauseEvidence: `${trim(reason)} — the container registry metered the base image pull; rerun the repository` };
    }
    if (/tarball|fetch repo|No GitHub installation|HTTP 404|HTTP 403/i.test(reason)) {
      return { failureStage: 'SOURCE_FETCH_ERROR', rootCause: null, rootCauseEvidence: `${trim(reason)} — decide TEST_HARNESS_FAILURE (repository access) vs DEPLOYZ_BUG` };
    }
    if (/docker push|ECR|denied: |manifest unknown|IMAGE_DIGEST/i.test(reason) && !/docker build/i.test(reason)) {
      return { failureStage: 'IMAGE_ERROR', rootCause: 'DEPLOYZ_BUG', rootCauseEvidence: trim(reason) };
    }
    if (/Dockerfile.*(?:not found|no such file)|failed to read dockerfile|BUILD_CONTEXT|COPY failed|file not found in build context/i.test(reason)) {
      return { failureStage: 'BUILD_ERROR', rootCause: null, rootCauseEvidence: `${trim(reason)} — decide ANALYSIS_BUG (Dockerfile/context selection) vs REPO_CONFIGURATION vs UPSTREAM_REPO_FAILURE` };
    }
    return { failureStage: 'BUILD_ERROR', rootCause: null, rootCauseEvidence: `${trim(reason)} — decide UPSTREAM_REPO_FAILURE (the Dockerfile does not build at the pinned commit) vs DEPLOYZ_BUG (build environment) vs AWS_TRANSIENT_FAILURE` };
  }

  if (point === 'cleanup') {
    if (/leak|left after teardown/i.test(evidence.message)) {
      return { failureStage: 'CLEANUP_LEAK', rootCause: null, rootCauseEvidence: `${trim(evidence.message)} — decide DEPLOYZ_BUG (purge/destroy sweep) vs AWS_TRANSIENT_FAILURE` };
    }
    return { failureStage: 'DESTROY_ERROR', rootCause: null, rootCauseEvidence: `${trim(evidence.message)} — decide DEPLOYZ_BUG vs AWS_TRANSIENT_FAILURE` };
  }

  // install / auto-deploy / runtime / https / dependencies — container and
  // log evidence first, then the product's failure code, then the stack.
  const exit = nonZeroExit(evidence);
  const dbLine = matches(evidence.logTail, DB_PATTERNS);
  const redisLine = matches(evidence.logTail, REDIS_PATTERNS);
  const envLine = matches(evidence.logTail, ENV_PATTERNS);
  const migrationLine = matches(evidence.logTail, MIGRATION_PATTERNS);
  const storageLine = matches(evidence.logTail, STORAGE_PATTERNS);
  const portLine = matches(evidence.logTail, PORT_PATTERNS);

  if (evidence.failureCode === 'IMAGE_PULL_FAILED') {
    return { failureStage: 'IMAGE_ERROR', rootCause: 'DEPLOYZ_BUG', rootCauseEvidence: `the customer account could not pull the release image: ${trim(evidence.message)}` };
  }
  if (evidence.failureCode === 'MIGRATION_FAILED' || evidence.migrationFailed) {
    const connectionLine = matches(evidence.logTail, DB_CONNECTION_PATTERNS);
    if (connectionLine) return { failureStage: 'DATABASE_ERROR', rootCause: null, rootCauseEvidence: `migration task could not use the database: ${trim(connectionLine)} — decide ENV_BINDING (DEPLOYZ_BUG) vs REPO_CONFIGURATION` };
    return { failureStage: 'MIGRATION_ERROR', rootCause: null, rootCauseEvidence: `migration task failed: ${trim(migrationLine ?? evidence.message)} — decide ANALYSIS_BUG (wrong command) vs REPO_CONFIGURATION vs UPSTREAM_REPO_FAILURE` };
  }
  if (evidence.failureCode === 'QUOTA_EXCEEDED' || evidence.failureCode === 'AWS_PERMISSION_DENIED' || evidence.failureCode === 'AWS_SCP_BLOCKED') {
    return { failureStage: 'INFRA_ERROR', rootCause: evidence.failureCode === 'QUOTA_EXCEEDED' ? 'TEST_HARNESS_FAILURE' : 'DEPLOYZ_BUG', rootCauseEvidence: `${evidence.failureCode}: ${trim(evidence.message)}` };
  }
  if (evidence.failureCode === 'RELAY_STATE_WRITE_FAILED' || evidence.failureCode === 'RELAY_DISCONNECTED') {
    return { failureStage: 'INFRA_ERROR', rootCause: 'DEPLOYZ_BUG', rootCauseEvidence: `${evidence.failureCode}: ${trim(evidence.message)}` };
  }

  if (exit !== null || envLine || dbLine || redisLine || storageLine) {
    if (envLine) return { failureStage: 'ENV_BINDING_ERROR', rootCause: null, rootCauseEvidence: `container reports a missing/invalid variable: ${trim(envLine)} — decide DEPLOYZ_BUG (binding not injected) vs ANALYSIS_MISSING_SIGNAL (required key not detected) vs REPO_CONFIGURATION` };
    if (dbLine) return { failureStage: 'DATABASE_ERROR', rootCause: null, rootCauseEvidence: `container cannot use the database: ${trim(dbLine)} — decide DEPLOYZ_BUG (binding/TLS/network) vs REPO_CONFIGURATION` };
    if (redisLine) return { failureStage: 'REDIS_ERROR', rootCause: null, rootCauseEvidence: `container cannot use Redis: ${trim(redisLine)} — decide DEPLOYZ_BUG (binding/provisioning) vs ANALYSIS_BUG (optional Redis treated as required, or the reverse)` };
    if (storageLine) return { failureStage: 'STORAGE_ERROR', rootCause: null, rootCauseEvidence: `container cannot use storage: ${trim(storageLine)} — decide DEPLOYZ_BUG (bucket binding) vs MVP_CAPABILITY_GAP (durable local disk)` };
    if (migrationLine) return { failureStage: 'MIGRATION_ERROR', rootCause: null, rootCauseEvidence: `container failed around migrations: ${trim(migrationLine)}` };
    return { failureStage: 'CONTAINER_START_ERROR', rootCause: null, rootCauseEvidence: `container exited ${exit?.exitCode ?? 'non-zero'}${exit?.reason ? ` (${trim(exit.reason)})` : ''} — read the log tail; decide ANALYSIS_BUG (start command) vs REPO_CONFIGURATION vs UPSTREAM_REPO_FAILURE` };
  }

  const healthStop = healthCheckStop(evidence);
  const tasksRunning = (evidence.stoppedTasks ?? []).every((t) => t.exitCode === null || t.exitCode === 0);
  const targetsUnhealthy = (evidence.targetHealth ?? []).length > 0 && (evidence.targetHealth ?? []).every((t) => t !== 'healthy');
  if (healthStop && /container health check/i.test(healthStop) && tasksRunning && (evidence.targetHealth ?? []).length === 0) {
    // ECS killed a running container on the task definition's own health
    // command before any load-balancer target existed: the in-container probe
    // (a shell + curl the image may not ship), not the application's path.
    return { failureStage: 'HEALTH_PATH_ERROR', rootCause: 'DEPLOYZ_BUG', rootCauseEvidence: `the container ran (exit 0) and was stopped on the task definition's in-container health command before any ALB target registered: ${trim(healthStop)} (DEPLOY-006)` };
  }
  if (healthStop || evidence.failureCode === 'IMAGE_HEALTH_CHECK_FAILED' || evidence.failureCode === 'PORT_MISMATCH' || (evidence.failureCode === 'ECS_DEPLOYMENT_FAILED' && tasksRunning) || targetsUnhealthy) {
    if (portLine && evidence.failureCode !== 'IMAGE_HEALTH_CHECK_FAILED') {
      return { failureStage: 'PORT_ERROR', rootCause: null, rootCauseEvidence: `the app listens somewhere else than the configured port: ${trim(portLine)} — decide ANALYSIS_BUG vs REPO_CONFIGURATION` };
    }
    const healthStatuses = (evidence.healthStatuses ?? []).filter((s): s is number => s !== null);
    if (healthStatuses.some((s) => s === 404) || (evidence.healthPathSource === 'manifest' && evidence.manifestHealthPath && evidence.probedHealthPath !== evidence.manifestHealthPath)) {
      return { failureStage: 'HEALTH_PATH_ERROR', rootCause: 'ANALYSIS_BUG', rootCauseEvidence: `the configured health path answers 404 (${evidence.probedHealthPath ?? 'unknown path'}); the analyser chose it (${evidence.manifestHealthPath ?? 'no manifest path'})` };
    }
    if (healthStatuses.some((s) => s >= 500)) {
      return { failureStage: 'APPLICATION_ERROR', rootCause: null, rootCauseEvidence: `the health path answers ${healthStatuses.join('/')} — decide REPO_CONFIGURATION (a value the app needs) vs DEPLOYZ_BUG vs UPSTREAM_REPO_FAILURE` };
    }
    return { failureStage: 'HEALTH_PATH_ERROR', rootCause: null, rootCauseEvidence: `${trim(healthStop ?? evidence.message)} — the container runs but its health check never passed; decide HEALTH_PATH (ANALYSIS_*) vs PORT vs container health command (DEPLOYZ_BUG: curl/shell missing in the image)` };
  }

  if (point === 'https') {
    return { failureStage: 'TLS_ERROR', rootCause: null, rootCauseEvidence: `default HTTPS ended ${evidence.httpsStatus ?? 'unknown'}: ${trim(evidence.message)} — decide DEPLOYZ_BUG vs AWS_TRANSIENT_FAILURE` };
  }
  if (point === 'inventory') {
    return { failureStage: 'INFRA_ERROR', rootCause: 'DEPLOYZ_BUG', rootCauseEvidence: `plan-versus-actual inventory disagrees: ${trim(evidence.message)}` };
  }
  if (point === 'smoke') {
    return { failureStage: 'APPLICATION_ERROR', rootCause: null, rootCauseEvidence: `${trim(evidence.message)} — decide DEPLOYZ_BUG vs REPO_CONFIGURATION` };
  }
  if (point === 'update') {
    return { failureStage: 'INFRA_ERROR', rootCause: null, rootCauseEvidence: `the update/redeploy exercise failed: ${trim(evidence.message)} — decide DEPLOYZ_BUG vs AWS_TRANSIENT_FAILURE` };
  }
  if (point === 'runtime' || point === 'dependencies') {
    const appStatuses = (evidence.appStatuses ?? []).filter((s): s is number => s !== null);
    if (appStatuses.length > 0 && appStatuses.every((s) => s >= 500)) {
      return { failureStage: 'APPLICATION_ERROR', rootCause: null, rootCauseEvidence: `the application answers ${[...new Set(appStatuses)].join('/')} persistently — decide REPO_CONFIGURATION vs DEPLOYZ_BUG vs UPSTREAM_REPO_FAILURE` };
    }
    if (evidence.timedOut) return { failureStage: 'TIMEOUT', rootCause: null, rootCauseEvidence: trim(evidence.message) };
    return { failureStage: 'APPLICATION_ERROR', rootCause: null, rootCauseEvidence: trim(evidence.message) };
  }

  if (evidence.timedOut) {
    return { failureStage: 'TIMEOUT', rootCause: null, rootCauseEvidence: `${trim(evidence.message)} (stack ${evidence.stackStatus ?? 'unknown'}) — decide AWS_TRANSIENT_FAILURE vs DEPLOYZ_BUG` };
  }
  const reasons = (evidence.stackReasons ?? []).filter((r) => !/Resource creation cancelled|cancelled/i.test(r));
  return {
    failureStage: 'INFRA_ERROR',
    rootCause: null,
    rootCauseEvidence: `${trim(evidence.message)}${reasons.length > 0 ? ` — ${trim(reasons[0])}` : ''} — decide DEPLOYZ_BUG vs AWS_TRANSIENT_FAILURE`,
  };
}
