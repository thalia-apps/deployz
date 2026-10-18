/**
 * Semantic readiness report — the MVP application-readiness model.
 *
 * Consumes the deterministic analyser output (post-AI-merge metadata) and
 * produces the structured report the readiness UI and the fix-instructions
 * generator consume: a semantic state (never a percentage), findings split
 * into REQUIRED vs RECOMMENDED, and the passed checks.
 *
 * Purely deterministic: same input → same report. The AI layer only ever
 * turns findings into implementation instructions (fix-instructions.ts) — it
 * can never add, remove, or resolve a finding.
 *
 * Classification policy:
 *   - REQUIRED + blocking: an architectural incompatibility (§10 rejections,
 *     persistent local filesystem). State becomes NEEDS_CHANGES.
 *   - REQUIRED + fixable: Deployz cannot deploy reliably without it
 *     (container setup, health check). State becomes ALMOST_READY.
 *   - RECOMMENDED: deployment can proceed, but reliability/configuration
 *     could improve (migrations for a detected database). Never blocks READY.
 *
 * A convention that is merely absent is NOT a finding: a repository with no
 * database gets no migration finding, and one with no worker-like code gets
 * no worker finding.
 *
 * Phase 4A — background workers are first-class workloads. An app with
 * worker-like code AND a resolved worker start command is RECOMMENDED
 * (Deployz runs the worker as its own container). Worker-like code WITHOUT
 * a resolved start command stays RECOMMENDED too (background jobs must run
 * inside the web process until a worker command is configured).
 */

import type { AnalysisResult } from './analyser.js';
import type { RejectionFinding } from './rejection.js';

// ── Types ───────────────────────────────────────────────────────────────────

/** Semantic readiness vocabulary. ANALYSIS_INCOMPLETE is derived at the API
 *  edge from `analysisStatus` — a stored report only ever holds the other
 *  three. */
export type ReadinessState = 'READY' | 'ALMOST_READY' | 'NEEDS_CHANGES' | 'ANALYSIS_INCOMPLETE';

export type FindingSeverity = 'required' | 'recommended';

/**
 * How sure the deterministic analyser is about a finding. `confirmed` —
 * definitive evidence; `likely` — strong signal but static analysis can miss
 * a real solution; `needs_confirmation` — the underlying requirement itself
 * is uncertain. The fix-instructions prompt tells the coding agent to verify
 * non-confirmed findings before changing anything.
 */
export type FindingConfidence = 'confirmed' | 'likely' | 'needs_confirmation';

/** One unresolved readiness finding, in UI-ready plain English. */
export interface ReadinessFinding {
  /** Stable machine id (e.g. 'container-setup'). */
  id: string;
  /** Coarse grouping (e.g. 'container', 'health', 'database'). */
  category: string;
  /** Short user-facing title, jargon-free. */
  title: string;
  severity: FindingSeverity;
  /**
   * True for architectural incompatibilities (unsupported database, local
   * filesystem persistence) that force NEEDS_CHANGES; false for fixable
   * required findings (ALMOST_READY).
   */
  blocking: boolean;
  /** One-sentence plain-English statement of the problem. */
  plainEnglishExplanation: string;
  /** Why Deployz needs this, in plain English. */
  whyItMatters: string;
  /** The technical evidence, for the collapsed details section. */
  technicalEvidence: string;
  /** What "fixed" looks like, phrased as a deployment outcome. */
  suggestedOutcome: string;
  confidence: FindingConfidence;
}

/** One passed check, for the collapsed "Passed checks" section. */
export interface PassedCheck {
  id: string;
  label: string;
}

/** The complete semantic readiness report persisted with each analysis. */
export interface ReadinessReport {
  state: Exclude<ReadinessState, 'ANALYSIS_INCOMPLETE'>;
  requiredCount: number;
  recommendedCount: number;
  /** One short, jargon-free explanation of the state. */
  summary: string;
  /** Unresolved findings only — required first, then recommended. */
  findings: ReadinessFinding[];
  passed: PassedCheck[];
}

/** Extra context the caller can resolve that the analyser output alone cannot. */
export interface ReadinessReportContext {
  /**
   * Whether a runnable worker start command resolved (the API resolves this
   * from package.json script keys). A resolved worker start command declares
   * a second process Deployz runs as its own container (Phase 4A), so
   * worker-like code with one is a recommended informational finding;
   * worker-like code without one is a recommended configuration gap.
   */
  workerCommandResolved?: boolean | undefined;
  /**
   * A migration script the API found but could not confirm the runtime image
   * can run (the selected Dockerfile's runtime stage does not provide its
   * runner). The vendor must enter a command or choose no separate migration.
   */
  migrationNeedsInput?: { candidate: string; reason: string } | null | undefined;
}

/**
 * Configuration the vendor supplied after analysis that resolves a finding
 * without a repository change: the container port and the start command
 * from the application details. Applied by `reconcileReadiness` wherever the
 * report is read or its verdict persisted, never baked into the stored
 * report — clearing the value brings the finding back.
 */
export interface ReadinessResolution {
  containerPort: number | null;
  startCommand: string | null;
  /** The vendor entered a migration command or chose no separate migration. */
  migrationCommandDecided?: boolean | undefined;
  /** The vendor set the health check path. */
  healthPathDecided?: boolean | undefined;
  /** The vendor set the Dockerfile path. */
  dockerfilePathDecided?: boolean | undefined;
}

// ── Passed-check labels ─────────────────────────────────────────────────────

// Friendly, jargon-reduced labels for detectors whose positive detection is a
// passed check. Falls back to the detector's own `details` string for any
// future detector, so nothing silently drops out of the passed list.
const PASSED_LABELS: Partial<Record<string, string>> = {
  dockerfile: 'Container setup found',
  framework: 'Framework detected',
  port: 'Application port detected',
  'health-endpoint': 'Health check found',
  'env-vars': 'Environment variables detected',
  postgresql: 'PostgreSQL database detected — Deployz provides a managed database',
  redis: 'Redis detected — provisioned automatically on install',
  s3: 'Object storage usage detected',
  'migration-command': 'Database migration command found',
  'startup-command': 'Start command found',
  'external-services': 'External service integrations detected',
  'package-manager': 'Package manager detected',
  'build-command': 'Build command found',
  runtime: 'Runtime detected',
};

// Detectors whose `detected: true` is a NEGATIVE signal and must never appear
// as a passed check (they surface as findings instead).
// `bind-address` is detected when the server binds only to localhost — a
// problem, never a passed check.
const NEGATIVE_SIGNAL_DETECTORS = new Set<string>(['local-filesystem', 'bind-address', 'dockerfile-git-copy']);

// `worker` is handled as a finding (blocking or recommended) — see the worker
// branch in the report builder. It is never a passed check.
const SEPARATELY_HANDLED_DETECTORS = new Set<string>(['worker']);

// ── Rejection findings (blocking) ───────────────────────────────────────────

interface RejectionCopy {
  id: string;
  category: string;
  title: string;
  plainEnglishExplanation: string;
  whyItMatters: string;
  suggestedOutcome: string;
}

const MARIA_DB_COPY: RejectionCopy = {
  id: 'unsupported-database-mariadb',
  category: 'database',
  title: 'Your database needs a supported engine',
  plainEnglishExplanation:
    'This app uses MariaDB, which Deployz cannot host. Deployz provides managed PostgreSQL or MySQL databases.',
  whyItMatters:
    'Deployz provisions, connects, and backs up the database for every customer deployment. It can only do that for PostgreSQL or MySQL.',
  suggestedOutcome:
    'Move the data layer to PostgreSQL or MySQL, or remove the MariaDB dependency if it is not actually used.',
};

const MONGO_COPY: RejectionCopy = {
  ...MARIA_DB_COPY,
  id: 'unsupported-database-mongo',
  plainEnglishExplanation:
    'This app uses MongoDB, which Deployz cannot host. Deployz provides managed PostgreSQL or MySQL databases.',
  suggestedOutcome:
    'Move the data layer to PostgreSQL or MySQL, or remove the MongoDB dependency if it is not actually used.',
};

const ELASTICSEARCH_COPY: RejectionCopy = {
  ...MARIA_DB_COPY,
  id: 'unsupported-database-elasticsearch',
  title: 'Your search engine needs a supported alternative',
  plainEnglishExplanation:
    'This app uses Elasticsearch or OpenSearch, which Deployz cannot host.',
  suggestedOutcome:
    'Replace the search engine with PostgreSQL full-text search, or remove the dependency if it is not actually used.',
};

const OTHER_DB_COPY: RejectionCopy = {
  ...MARIA_DB_COPY,
  id: 'unsupported-database-other',
  plainEnglishExplanation:
    'This app uses a database Deployz cannot host. Deployz provides managed PostgreSQL or MySQL databases.',
  suggestedOutcome:
    'Move the data layer to PostgreSQL or MySQL, or remove the unsupported dependency if it is not actually used.',
};

const SQLITE_COPY: RejectionCopy = {
  ...MARIA_DB_COPY,
  id: 'unsupported-database-sqlite',
  plainEnglishExplanation:
    'This app uses SQLite, a database stored in a file on the app server. Deployz cannot host it because app disks are wiped on every deploy.',
  whyItMatters:
    'Deployz provisions, connects, and backs up the database for every customer deployment, and it can only do that for PostgreSQL or MySQL.',
  suggestedOutcome:
    'Move the data layer to PostgreSQL or MySQL, or set the app to use one of them if it supports both.',
};

const REDIS_COPY: RejectionCopy = {
  id: 'unsupported-redis-setup',
  category: 'cache',
  title: "Your app uses Redis features Deployz can't provide",
  plainEnglishExplanation:
    'This app uses Redis features Deployz cannot provide (such as Redis Stack modules or cluster mode).',
  whyItMatters:
    'Deployz provisions a standard single-node Redis for each deployment. Features beyond that would fail at runtime.',
  suggestedOutcome:
    'Use a standard single-node Redis setup without Stack modules or cluster mode.',
};

/**
 * §11.4 architecture/cloud/queue families. Each stays deliberately generic in
 * the copy fields (jargon-free, §65) — the SPECIFIC reason with its file
 * evidence lives in the rejection's own `reason`, surfaced as the finding's
 * technical evidence.
 */
const ARCHITECTURE_COPY: RejectionCopy = {
  id: 'unsupported-architecture',
  category: 'architecture',
  title: 'Runs its own infrastructure',
  plainEnglishExplanation:
    'This app depends on infrastructure that Deployz does not host or manage (its own deployment tooling, cloud platform files, or cluster setup).',
  whyItMatters:
    'Deployz provisions one container per application with managed database, cache, and storage. Extra infrastructure the app expects would not exist at runtime.',
  suggestedOutcome:
    'Keep these files. Deployz ignores deployment samples; if the app needs this infrastructure at run time, it needs hosting that Deployz does not provide.',
};

const MESSAGE_QUEUE_COPY: RejectionCopy = {
  ...ARCHITECTURE_COPY,
  id: 'unsupported-message-queue',
  title: 'Relies on its own message queue',
  plainEnglishExplanation:
    'This app depends on a message queue or event bus that Deployz does not host (for example Kafka, RabbitMQ, or an AWS queue).',
  suggestedOutcome:
    'Keep the queue code. Deploy on Deployz only if the app can use a queue Deployz provides (Redis or Amazon SQS), or if the queue dependency is not actually used.',
};

const MULTI_SERVICE_COPY: RejectionCopy = {
  ...ARCHITECTURE_COPY,
  id: 'unsupported-multi-service',
  title: 'Runs as several services',
  plainEnglishExplanation:
    "This app's Docker Compose file starts more than one application container, but Deployz runs one container per deployment.",
  suggestedOutcome:
    'Run the app as a single container, or move the extra services out of the deployment.',
};

const STORAGE_COPY: RejectionCopy = {
  ...ARCHITECTURE_COPY,
  id: 'unsupported-persistent-volume',
  category: 'storage',
  title: 'Needs a persistent disk volume',
  plainEnglishExplanation:
    'This app expects a persistent disk volume that stays attached between restarts. Deployz runs apps on disks that are wiped on every deploy.',
  suggestedOutcome: 'Store persistent data in object storage instead of an attached disk.',
};

const GPU_COPY: RejectionCopy = {
  ...ARCHITECTURE_COPY,
  id: 'unsupported-gpu',
  title: 'Needs a graphics processor (GPU)',
  plainEnglishExplanation:
    'This app requires a graphics processor to run. Deployz runs apps on standard processors only.',
  suggestedOutcome:
    'Use a processor-only configuration, or move the graphics processing to a service that provides it.',
};

const NO_DOCKERFILE_COPY: RejectionCopy = {
  ...ARCHITECTURE_COPY,
  id: 'unsupported-no-dockerfile',
  category: 'container',
  title: 'Has no Dockerfile that builds the app',
  plainEnglishExplanation:
    'This repository has no Dockerfile that builds a production image from the source code.',
  whyItMatters:
    'Deployz builds the image from the repository for every deployment. It cannot build a Dockerfile that is only for development, is a template, or copies files the repository does not contain.',
  suggestedOutcome:
    'Add a production Dockerfile to the repository that builds and starts the app from source.',
};

const MULTI_PROCESS_COPY: RejectionCopy = {
  ...MULTI_SERVICE_COPY,
  plainEnglishExplanation:
    "This app's image starts several long-running processes (web, API, worker) under a supervisor, but Deployz runs one process per container.",
  suggestedOutcome:
    'Build an image that runs only the web process, and declare each other process as a worker.',
};

/** Maps a §10/§11 rejection `dependency` to its blocking-finding copy. */
function rejectionCopy(dependency: string): RejectionCopy {
  if (dependency === 'redis-unsupported') return REDIS_COPY;
  if (dependency === 'mariadb') {
    return MARIA_DB_COPY;
  }
  if (dependency === 'sqlite') return SQLITE_COPY;
  if (dependency === 'mongoose' || dependency === 'mongodb' || dependency === 'mongodb-client') {
    return MONGO_COPY;
  }
  if (dependency === '@elastic/elasticsearch' || dependency === '@opensearch-project/opensearch') {
    return ELASTICSEARCH_COPY;
  }
  if (dependency === 'kafka' || dependency === 'rabbitmq' || dependency === 'temporal') {
    return MESSAGE_QUEUE_COPY;
  }
  if (dependency === 'docker-compose-multi-service') return MULTI_SERVICE_COPY;
  if (dependency === 'multi-process-image') return MULTI_PROCESS_COPY;
  if (dependency === 'persistent-volume' || dependency === 'local-filesystem') return STORAGE_COPY;
  if (dependency === 'gpu') return GPU_COPY;
  if (dependency === 'no-buildable-dockerfile') return NO_DOCKERFILE_COPY;
  if (
    dependency === 'kubernetes' ||
    dependency === 'serverless' ||
    dependency === 'terraform' ||
    dependency === 'pulumi' ||
    dependency === 'cloudformation' ||
    dependency === 'azure' ||
    dependency === 'gcp'
  ) {
    return ARCHITECTURE_COPY;
  }
  return OTHER_DB_COPY;
}

function rejectionFinding(rejection: RejectionFinding): ReadinessFinding {
  const copy = rejectionCopy(rejection.dependency);
  return {
    id: copy.id,
    category: copy.category,
    title: copy.title,
    severity: 'required',
    blocking: true,
    plainEnglishExplanation: copy.plainEnglishExplanation,
    whyItMatters: copy.whyItMatters,
    technicalEvidence: rejection.reason,
    suggestedOutcome: copy.suggestedOutcome,
    confidence: 'confirmed',
  };
}

// ── Report builder ──────────────────────────────────────────────────────────

const STATE_SUMMARY: Record<ReadinessReport['state'], string> = {
  READY: 'This app can be deployed through Deployz.',
  ALMOST_READY:
    'Deployz found a few things to address before this app can be deployed reliably.',
  NEEDS_CHANGES: 'This app needs changes before Deployz can deploy it.',
};

/**
 * Build the semantic readiness report from an analysis result. `result`
 * should carry the MERGED (post-AI-fallback) metadata, so a start command or
 * migration command the AI resolved counts as resolved here too.
 */
export function buildReadinessReport(
  result: AnalysisResult,
  context: ReadinessReportContext = {},
): ReadinessReport {
  const metadata = result.metadata;
  const finding = (name: string) => result.findings.find((f) => f.detector === name);
  const findings: ReadinessFinding[] = [];

  // ── Blocking (reject-class) findings ──────────────────────────────────────
  for (const rejection of result.rejections) {
    if (rejection.detected) findings.push(rejectionFinding(rejection));
  }

  const localFs = finding('local-filesystem');
  if (localFs?.detected) {
    findings.push({
      id: 'local-file-storage',
      category: 'storage',
      title: 'Files stored on local disk',
      severity: 'required',
      blocking: true,
      plainEnglishExplanation:
        'This app writes files to its own disk, but Deployz runs apps on disks that are wiped on every deploy.',
      whyItMatters:
        'Anything written to local disk disappears when the app restarts or updates, so uploads and generated files would be lost.',
      technicalEvidence:
        localFs.details ??
        `Persistent local filesystem operations detected: ${String(localFs.value ?? '')}`,
      suggestedOutcome:
        'Store uploaded and persistent files in object storage instead of the local disk.',
      confidence: 'confirmed',
    });
  }

  const gitCopy = finding('dockerfile-git-copy');
  if (gitCopy?.detected) {
    findings.push({
      id: 'build-context-git-metadata',
      category: 'container',
      title: 'Dockerfile copies or reads the .git directory',
      severity: 'required',
      blocking: true,
      plainEnglishExplanation:
        'Deployz builds the image from a source archive that has no git metadata, so a build step that copies or reads .git cannot succeed.',
      whyItMatters:
        'Deployz fetches the repository as a GitHub tarball, which never contains a .git directory. A build step that copies or reads it fails every deployment.',
      technicalEvidence:
        gitCopy.details ?? `Dockerfile copies .git from the build context: ${String(gitCopy.value ?? '')}`,
      suggestedOutcome:
        'Remove the copy or read of .git from the Dockerfile, or make the version build argument optional.',
      confidence: 'confirmed',
    });
  }

  // ── Required (fixable) findings ───────────────────────────────────────────
  if (
    metadata['hasDockerfile'] !== true &&
    !result.rejections.some((r) => r.detected && r.dependency === 'no-buildable-dockerfile')
  ) {
    findings.push({
      id: 'container-setup',
      category: 'container',
      title: "Deployz doesn't know how to start your app",
      severity: 'required',
      blocking: false,
      plainEnglishExplanation:
        'Deployz could not determine how to package and start this application.',
      whyItMatters:
        'Deployz builds and runs your app in its own container for every customer. Without container instructions, deployments cannot be built.',
      technicalEvidence: 'No Dockerfile was found in the repository.',
      suggestedOutcome:
        'Add container build instructions (a Dockerfile) that install dependencies, build the app, and start it.',
      confidence: 'confirmed',
    });
  }

  if (
    metadata['hasDockerfile'] === true &&
    (metadata['port'] == null || metadata['portSource'] === 'framework-default')
  ) {
    findings.push({
      id: 'port-unresolved',
      category: 'network',
      title: 'Tell Deployz which port your app listens on',
      severity: 'required',
      blocking: false,
      plainEnglishExplanation:
        'Deployz could not find the network port this app listens on.',
      whyItMatters:
        'Deployz routes customer traffic and health checks to one port. Without it, the app would run but never receive requests.',
      technicalEvidence:
        'No port was found in the Dockerfile (EXPOSE or ENV PORT), an env file, a compose file, or a process.env.PORT default in source.',
      suggestedOutcome:
        'Declare the port the app listens on (for example an EXPOSE instruction in the Dockerfile), or set it in the application details.',
      confidence: 'confirmed',
    });
  }

  if (metadata['hasDockerfile'] === true && metadata['hasStartupCommand'] !== true) {
    findings.push({
      id: 'start-command-missing',
      category: 'container',
      title: 'Tell Deployz how to start your app',
      severity: 'required',
      blocking: false,
      plainEnglishExplanation:
        'Deployz found container instructions but no command that starts the app.',
      whyItMatters:
        'Every deployment starts the app inside its container. Without a start command, the container exits immediately and the deployment never becomes healthy.',
      technicalEvidence:
        'The Dockerfile has no CMD or ENTRYPOINT instruction and no "start" script was found in any package.json.',
      suggestedOutcome:
        'Add a CMD or ENTRYPOINT instruction to the Dockerfile (or a "start" script), or set the start command in the application details.',
      confidence: 'confirmed',
    });
  }

  const tiedDockerfiles = Array.isArray(metadata['dockerfileSelectionTied'])
    ? metadata['dockerfileSelectionTied'].filter((path): path is string => typeof path === 'string')
    : [];
  if (tiedDockerfiles.length > 1) {
    const selected = typeof metadata['dockerfilePath'] === 'string' ? metadata['dockerfilePath'] : null;
    findings.push({
      id: 'dockerfile-target-unresolved',
      category: 'container',
      title: 'Confirm which Dockerfile Deployz builds',
      severity: 'recommended',
      blocking: false,
      plainEnglishExplanation: `Deployz found several Dockerfiles that could be the application image and picked ${
        selected !== null ? `"${selected}"` : 'one of them'
      }.`,
      whyItMatters:
        'Deployz builds one Dockerfile for every release. If it builds the wrong one, the app starts the wrong program or never becomes healthy.',
      technicalEvidence: `These Dockerfiles match equally well: ${tiedDockerfiles.join(', ')}.`,
      suggestedOutcome:
        'Check that this Dockerfile builds the application. If it does not, name the application Dockerfile Dockerfile.production, which Deployz prefers, and analyse again.',
      confidence: 'needs_confirmation',
    });
  }

  if (metadata['hasHealthEndpoint'] !== true) {
    findings.push({
      id: 'health-check',
      category: 'health',
      title: 'Give Deployz a way to check your app',
      severity: 'required',
      blocking: false,
      plainEnglishExplanation:
        'Deployz needs a reliable way to know when your app is running and ready.',
      whyItMatters:
        'During every deployment, Deployz waits for your app to report healthy before sending traffic to it. Without a health signal, a broken deploy cannot be detected or rolled back.',
      technicalEvidence:
        'No health endpoint or container health check was found (no /health-style route, no HEALTHCHECK instruction).',
      suggestedOutcome:
        'Expose a lightweight route (for example /health) that returns success once the app is ready, and reference it from the container health check.',
      // Static analysis can miss a real health route (custom path, indirect
      // registration) — the coding agent is told to verify before adding one.
      confidence: 'likely',
    });
  }

  const bind = finding('bind-address');
  if (bind?.detected) {
    findings.push({
      id: 'localhost-binding',
      category: 'network',
      title: 'Your app only listens on localhost',
      severity: 'required',
      blocking: false,
      plainEnglishExplanation:
        'This app accepts connections only from inside its own container, so Deployz cannot reach it.',
      whyItMatters:
        'Deployz sends customer traffic and health checks to the container over the network. A server bound to 127.0.0.1 or localhost never answers them, so every deployment would fail its health check.',
      technicalEvidence: bind.details ?? 'The server binds to a loopback address.',
      suggestedOutcome:
        'Bind the server to all network interfaces (0.0.0.0) instead of 127.0.0.1 or localhost.',
      // A loopback binding can sit behind a dev-only branch the static scan
      // cannot see — the coding agent is told to verify first.
      confidence: 'likely',
    });
  }

  // ── Recommended findings ──────────────────────────────────────────────────
  // Only when a database is actually in play — a repository with no database
  // needs no migration command, and its absence is not a finding at all.
  // Stage B phase 6 (COMP-014): mode 'startup' is INFORMATIONAL (migrations
  // run when the app starts — nothing missing); mode 'unknown' keeps the
  // gentle recommendation; mode 'none'/'pre_deploy' produce no finding.
  const postgres = metadata['postgres'] as { required?: unknown } | undefined;
  const mysql = metadata['mysql'] as { required?: unknown } | undefined;
  const databaseRequired = postgres?.required === true || mysql?.required === true;
  const migrationMode = metadata['migrationMode'];
  const usesMysqlOnly =
    postgres?.required === true
      ? false
      : mysql?.required === true || (metadata['usesPostgresql'] !== true && metadata['usesMysql'] === true);
  const drivers = metadata['postgresqlDrivers'];
  if (migrationMode === 'startup') {
    const evidence = metadata['migrationStartupEvidence'] as
      | { source: string; pattern: string }[]
      | undefined;
    findings.push({
      id: 'database-migrations',
      category: 'database',
      title: 'Database migrations run when the application starts',
      severity: 'recommended',
      blocking: false,
      plainEnglishExplanation:
        'This app applies its database migrations when the application itself starts, not as a separate deploy step.',
      whyItMatters:
        'Deployz does not run a migration step of its own for this app — the running application updates its own database schema on boot.',
      technicalEvidence: `Migrations run at startup: ${
        Array.isArray(evidence)
          ? evidence.map((entry) => `${entry.pattern} (${entry.source})`).join('; ')
          : 'detected in the application start path'
      }.`,
      suggestedOutcome:
        'No action needed — migrations run on application startup and Deployz monitors the app until it reports healthy.',
      confidence: databaseRequired ? 'likely' : 'needs_confirmation',
    });
  } else if (migrationMode === 'unknown' || migrationMode === undefined) {
    const suggestedMigration =
      typeof metadata['suggestedMigrationCommand'] === 'string' ? metadata['suggestedMigrationCommand'] : null;
    if ((metadata['usesPostgresql'] === true || metadata['usesMysql'] === true) && metadata['hasMigrationCommand'] !== true) {
      findings.push({
        id: 'database-migrations',
        category: 'database',
        title: 'Give Deployz a way to update your database',
        severity: 'recommended',
        blocking: false,
        plainEnglishExplanation:
          'This app uses a database, but Deployz could not find a command that updates the database structure during deploys.',
        whyItMatters:
          'Deployz runs your migration command automatically on every deploy, so each customer database always matches the code that talks to it.',
        technicalEvidence: usesMysqlOnly
          ? 'A MySQL library is present but no migration command was found in the image start path or any package.json.'
          : `A PostgreSQL library is present (${
              Array.isArray(drivers) ? drivers.join(', ') : 'detected'
            }) but no migration command was found in the image start path or any package.json.`,
        suggestedOutcome: suggestedMigration
          ? `Set the migration command to "${suggestedMigration}" in the application's settings, or make the image run it when it starts.`
          : 'If the app already updates its database when it starts, change nothing. Otherwise set a command that applies the migrations non-interactively in the application settings.',
        // When the database requirement itself is unconfirmed (driver present
        // but no corroborating signal), the whole finding is uncertain.
        confidence: databaseRequired ? 'likely' : 'needs_confirmation',
      });
    }
  }

  if (context.migrationNeedsInput) {
    const { candidate, reason } = context.migrationNeedsInput;
    findings.push({
      id: 'migration-command-needs-input',
      category: 'database',
      title: 'Choose how Deployz runs database migrations',
      severity: 'required',
      blocking: false,
      plainEnglishExplanation: `Deployz found the migration script "${candidate}", but cannot confirm that the built image can run it.`,
      whyItMatters:
        'Deployz runs the migration command inside the built image before each release. A command the image cannot run fails every deploy.',
      technicalEvidence: `Migration script: ${candidate}. Not confirmed because ${reason}.`,
      suggestedOutcome:
        'Enter a migration command that the built image can run, or choose "No separate migration" in the application settings.',
      confidence: 'needs_confirmation',
    });
  }

  const worker = finding('worker');
  if (worker?.detected && context.workerCommandResolved === true) {
    // Phase 4A: a resolved worker start command is a second process Deployz
    // now RUNS (one ECS service per workload) — informational, not blocking.
    findings.push({
      id: 'worker-process',
      category: 'workers',
      title: 'Background worker process',
      severity: 'recommended',
      blocking: false,
      plainEnglishExplanation:
        'This app declares a background worker process. Deployz runs it as a second container next to the web process.',
      whyItMatters:
        'The worker starts with its own command, so background jobs keep running even when no web request comes in.',
      technicalEvidence:
        worker.details ?? 'Worker-like code detected and a worker start command resolved.',
      suggestedOutcome: 'No change needed — Deployz will start the worker process alongside your app.',
      confidence: 'confirmed',
    });
  } else if (worker?.detected && metadata['workerNeedsProcess'] !== false) {
    // `workerNeedsProcess` is false when the only evidence is an in-process job
    // library or worker_threads; rows analysed before it existed lack the key.
    findings.push({
      id: 'worker-command',
      category: 'workers',
      title: 'Background job runner',
      severity: 'recommended',
      blocking: false,
      plainEnglishExplanation:
        'This app appears to run background jobs, but no command exists that starts a job runner as a separate process.',
      whyItMatters:
        'Deployz runs each declared worker as its own process. Jobs that need a separate runner do not run until one is declared.',
      technicalEvidence:
        worker.details ??
        `Worker-like code detected (${String(worker.value ?? '')}) but no worker start script was found.`,
      suggestedOutcome:
        'If the web process already runs the jobs, change nothing. Otherwise declare the job runner with its own start command (for example a Procfile worker line).',
      confidence: 'likely',
    });
  }

  // Phase 5 — background queues and scheduled jobs are first-class workloads,
  // provisioned automatically once detected. A `questions` entry is weak or
  // ambiguous evidence Deployz will not provision from — surfaced as a
  // non-blocking recommendation to ask the vendor, never a rejection.
  const asyncQueues = Array.isArray(metadata['asyncQueues']) ? metadata['asyncQueues'] : [];
  const asyncScheduledJobs = Array.isArray(metadata['asyncScheduledJobs']) ? metadata['asyncScheduledJobs'] : [];
  const asyncQuestions = Array.isArray(metadata['asyncQuestions'])
    ? (metadata['asyncQuestions'] as { id: string; question: string; source: string }[])
    : [];

  if (asyncQueues.length > 0 || asyncScheduledJobs.length > 0) {
    findings.push({
      id: 'async-workloads',
      category: 'workers',
      title: 'Queues and scheduled jobs',
      severity: 'recommended',
      blocking: false,
      plainEnglishExplanation:
        'This app uses message queues or scheduled jobs. Deployz sets up and runs them as part of the deployment.',
      whyItMatters:
        'Queues and scheduled jobs run outside the main web process, so Deployz provisions the matching infrastructure and access automatically.',
      technicalEvidence: `Detected ${asyncQueues.length} queue(s) and ${asyncScheduledJobs.length} scheduled job(s).`,
      suggestedOutcome: 'No action needed — Deployz provisions the queues and schedules alongside your app.',
      confidence: 'confirmed',
    });
  }

  for (const question of asyncQuestions) {
    findings.push({
      id: `async-question-${question.id}`,
      category: 'workers',
      title: 'Confirm a queue or schedule',
      severity: 'recommended',
      blocking: false,
      plainEnglishExplanation: question.question,
      whyItMatters:
        'Deployz only provisions infrastructure it can confirm from the code. Anything unclear stays unprovisioned until it is clarified.',
      technicalEvidence: `Evidence: ${question.source}`,
      suggestedOutcome: 'Clarify the queue or schedule, or remove the code if it is not used.',
      confidence: 'needs_confirmation',
    });
  }

  // ── Passed checks ─────────────────────────────────────────────────────────
  const passed: PassedCheck[] = result.findings
    .filter(
      (f) =>
        f.detected &&
        !NEGATIVE_SIGNAL_DETECTORS.has(f.detector) &&
        !SEPARATELY_HANDLED_DETECTORS.has(f.detector) &&
        // A framework-default port (Stage B phase 7) is a prefill only — it is
        // never a passed check until the vendor confirms it.
        !(f.detector === 'port' && metadata['portSource'] === 'framework-default'),
    )
    .map((f) => ({ id: f.detector, label: PASSED_LABELS[f.detector] ?? f.details ?? f.detector }));

  return assembleReport(findings, passed);
}

/** Order the findings (required first), derive the state and its summary. */
function assembleReport(findings: ReadinessFinding[], passed: PassedCheck[]): ReadinessReport {
  const required = findings.filter((f) => f.severity === 'required');
  const recommended = findings.filter((f) => f.severity === 'recommended');
  const state: ReadinessReport['state'] =
    required.some((f) => f.blocking) ? 'NEEDS_CHANGES' : required.length > 0 ? 'ALMOST_READY' : 'READY';

  return {
    state,
    requiredCount: required.length,
    recommendedCount: recommended.length,
    summary: STATE_SUMMARY[state],
    findings: [...required, ...recommended],
    passed,
  };
}

/** Finding id → the vendor configuration that resolves it. */
const RESOLVABLE_FINDINGS: Record<string, (resolution: ReadinessResolution) => boolean> = {
  'port-unresolved': (resolution) => resolution.containerPort !== null,
  'start-command-missing': (resolution) => resolution.startCommand !== null,
  'migration-command-needs-input': (resolution) => resolution.migrationCommandDecided === true,
  'health-check': (resolution) => resolution.healthPathDecided === true,
  'dockerfile-target-unresolved': (resolution) => resolution.dockerfilePathDecided === true,
};

const RESOLVED_LABELS: Partial<Record<string, string>> = {
  'port-unresolved': 'Application port set in the application details',
  'start-command-missing': 'Start command set in the application details',
  'migration-command-needs-input': 'Migration choice set in the application details',
  'health-check': 'Health check path set in the application details',
  'dockerfile-target-unresolved': 'Dockerfile set in the application details',
};

/**
 * Apply the vendor's post-analysis configuration to a stored report. A
 * finding the configuration resolves becomes a passed check; the state and
 * counts are re-derived. Pure — the stored report is never mutated.
 */
export function reconcileReadiness(report: ReadinessReport, resolution: ReadinessResolution): ReadinessReport {
  const resolved = report.findings.filter((f) => RESOLVABLE_FINDINGS[f.id]?.(resolution) === true);
  if (resolved.length === 0) return report;
  const resolvedIds = new Set(resolved.map((f) => f.id));
  return assembleReport(
    report.findings.filter((f) => !resolvedIds.has(f.id)),
    [...report.passed, ...resolved.map((f) => ({ id: f.id, label: RESOLVED_LABELS[f.id] ?? f.title }))],
  );
}

// ── Verdict bridge ──────────────────────────────────────────────────────────

/**
 * Map a semantic readiness state onto the persisted `compatibility_status`
 * enum (READY / NEEDS_ATTENTION / NOT_COMPATIBLE — unchanged in the DB).
 */
export function verdictFromReadiness(
  state: ReadinessReport['state'],
): 'READY' | 'NEEDS_ATTENTION' | 'NOT_COMPATIBLE' {
  if (state === 'NEEDS_CHANGES') return 'NOT_COMPATIBLE';
  if (state === 'ALMOST_READY') return 'NEEDS_ATTENTION';
  return 'READY';
}
