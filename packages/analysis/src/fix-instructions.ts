/**
 * Fix-instructions generation — turns unresolved readiness findings into ONE
 * consolidated prompt the vendor pastes into their own coding agent (Claude
 * Code, Cursor, Codex, OpenCode, …).
 *
 * Deployz never edits the repository. The remediation plan is built
 * DETERMINISTICALLY from the structured analysis facts and findings: every
 * finding gets a classification (application fix, configuration fix, already
 * supported, Deployz limitation, needs input, unsupported), a confidence,
 * evidence, conditional actions, constraints and completion criteria. Related
 * findings are merged and the plan is ordered by dependency. The model only
 * adds repository-specific detail to each item; it never changes a
 * classification, an action or a constraint, and guidance that breaks the
 * safety rules is dropped. An AI failure surfaces as a retryable error at the
 * API edge — it never affects the analysis or the readiness state.
 *
 * The prompt targets the vendor's CODING AGENT, not a person: accurate
 * blocker names, evidence over explanation, only facts the included items
 * need, and no Deployz product narrative.
 */

import { z } from 'zod';

import {
  SpendLimitExceededError,
  truncateToTokens,
  type AiGateway,
} from './ai-gateway.js';
import type { ReadinessFinding } from './readiness-report.js';

// ── Tunables ────────────────────────────────────────────────────────────────

/**
 * Generator version, part of the document cache key: a change to the plan,
 * the prompt or the assembled document must bump it so stored documents
 * regenerate.
 */
export const FIX_INSTRUCTIONS_VERSION = 4;
/** Max tokens the PROMPT may occupy — structured facts only, no file contents. */
export const FIX_INSTRUCTIONS_MAX_PROMPT_TOKENS = 4000;
/**
 * Max tokens the COMPLETION may occupy. The production model (Claude Opus 5.5)
 * always thinks; at low effort its reasoning and the guidance JSON (at most
 * 70 words per item) fit well inside this cap.
 */
export const FIX_INSTRUCTIONS_MAX_OUTPUT_TOKENS = 4000;
/** Total per-request budget: prompt + completion. */
export const FIX_INSTRUCTIONS_MAX_TOTAL_TOKENS =
  FIX_INSTRUCTIONS_MAX_PROMPT_TOKENS + FIX_INSTRUCTIONS_MAX_OUTPUT_TOKENS;
/**
 * How long a generation request may run before the caller abandons it. Kept
 * under the API Lambda's 30s timeout and the HTTP API's 30s integration
 * limit: an abort at or above that mark never fires — the platform kills the
 * request first, the vendor gets an opaque gateway error instead of the
 * retryable 503, and the failure is never logged.
 */
export const FIX_INSTRUCTIONS_TIMEOUT_MS = 25_000;
/**
 * How long ONE model attempt may run. A thinking model needs most of the
 * request budget for one answer, so an attempt is not cut short to make room
 * for a second one: the retry runs only after a fast failure (a 429, a 5xx,
 * a malformed answer), inside what is left of `FIX_INSTRUCTIONS_TIMEOUT_MS`.
 */
export const FIX_INSTRUCTIONS_ATTEMPT_TIMEOUT_MS = 24_000;
/** Longest AI guidance kept for one item; a longer answer ignored the prompt and is dropped. */
export const FIX_INSTRUCTIONS_MAX_GUIDANCE_CHARS = 700;

// ── Input shapes ────────────────────────────────────────────────────────────

/** Detected environment-variable requirements, names only — never values. */
export interface FixInstructionsEnvRequirements {
  /** Required while building the image only (for example Dockerfile ARGs). */
  buildTime: string[];
  /** Required by the running application. */
  runtime: string[];
  /** Names the deployment platform itself injects (database, cache, port). */
  platformInjected: string[];
}

/** The structured deterministic facts the generator may reference. */
export interface FixInstructionsFacts {
  /** Runtime family ('node', 'python', …) when detected. */
  runtime: string | null;
  framework: string | null;
  packageManager: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  port: string | null;
  dockerfilePath: string | null;
  /** The managed database engine Deployz provisions, or 'none'. */
  database: 'postgres' | 'mysql' | 'none';
  migrationCommand: string | null;
  /** A migration command the analysis suggests but the vendor has not set. */
  suggestedMigrationCommand: string | null;
  /** The configured health check path (detected or set by the vendor). */
  healthPath: string | null;
  /** The vendor owns `healthPath`; a detected path can be stale. */
  healthPathSetByVendor: boolean;
  redisRequired: boolean;
  /** Worker commands the repository declares (Deployz runs each as its own container). */
  workerCommands: string[];
  /** Non-root app directory in a monorepo, when known. */
  workingDirectory: string | null;
  /** Split of detected env-var requirements, null when none were modelled. */
  envRequirements: FixInstructionsEnvRequirements | null;
}

/** Everything the generator needs: repo identity, facts, and unresolved findings. */
export interface FixInstructionsContext {
  repoFullName: string;
  /** The commit the analysis ran against, when known. */
  commitSha: string | null;
  facts: FixInstructionsFacts;
  /** The unresolved findings the instructions must cover (required first). */
  findings: ReadinessFinding[];
}

// ── AI output shape ─────────────────────────────────────────────────────────

/**
 * The model's structured output: repository-specific guidance per plan item.
 * `.strict()` rejects anything outside this shape. An item the model skips,
 * or answers with an empty string, gets no guidance line — the document is
 * complete either way.
 */
export const fixInstructionsAiSchema = z
  .object({
    items: z.array(z.object({ id: z.string(), guidance: z.string() }).strict()),
  })
  .strict();
export type FixInstructionsAiOutput = z.infer<typeof fixInstructionsAiSchema>;

// ── Environment-variable requirements ───────────────────────────────────────

const DECLARES_SOURCE = /^(.+?) declares /;
const READ_SOURCE = /^read in /;
const REQUIRES_SOURCE = / requires $/;
const BUILD_CONTEXT_FILE = /(?:^|\/)(?:Dockerfile|[\w.-]*\.dockerfile|docker-compose[\w.-]*|compose\.ya?ml)$/i;

/**
 * Summarise `metadata.envVarModel` into the split the coding agent needs:
 * build-time vs runtime requirements plus the names the platform injects.
 * Names only — the model never carries values, so nothing here can leak one.
 * Returns null when the model carries no requirement at all.
 */
export function summariseEnvRequirements(model: unknown): FixInstructionsEnvRequirements | null {
  if (!Array.isArray(model)) return null;
  const buildTime = new Set<string>();
  const runtime = new Set<string>();
  const platformInjected = new Set<string>();

  for (const raw of model) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry['key'] !== 'string' || entry['key'].length === 0) continue;
    const sources = Array.isArray(entry['source'])
      ? entry['source'].filter((s): s is string => typeof s === 'string')
      : [];

    if (entry['classification'] === 'deployz_managed' || entry['classification'] === 'deployz_generated') {
      platformInjected.add(entry['key']);
      continue;
    }
    if (entry['required'] !== true) continue;

    const isRead = sources.some((s) => READ_SOURCE.test(s) || REQUIRES_SOURCE.test(s));
    if (isRead) {
      runtime.add(entry['key']);
      continue;
    }
    // Declared but never read in code: a requirement only when the declaring
    // files are build-context files (a Dockerfile ARG the build consumes).
    const declaredFiles = sources
      .map((s) => DECLARES_SOURCE.exec(s)?.[1])
      .filter((file): file is string => typeof file === 'string');
    if (declaredFiles.length > 0 && declaredFiles.some((file) => BUILD_CONTEXT_FILE.test(file))) {
      buildTime.add(entry['key']);
    } else {
      runtime.add(entry['key']);
    }
  }

  if (buildTime.size === 0 && runtime.size === 0 && platformInjected.size === 0) return null;
  return {
    buildTime: [...buildTime].sort(),
    runtime: [...runtime].sort(),
    platformInjected: [...platformInjected].sort(),
  };
}

// ── The remediation plan ────────────────────────────────────────────────────

/**
 * What resolving an item takes:
 * - APPLICATION_FIX — an application source change with a known safe pattern.
 * - CONFIGURATION_FIX — configuration only: Deployz settings, environment
 *   variables, or build and process files (Dockerfile, Procfile, package
 *   scripts); no application logic changes.
 * - ALREADY_SUPPORTED — Deployz handles it; nothing to change.
 * - DEPLOYZ_LIMITATION — the app legitimately needs something Deployz does
 *   not provide; replacing it is the vendor's architecture decision.
 * - NEEDS_INPUT — a fact or decision only the vendor has.
 * - UNSUPPORTED — the app's deployment model is outside what Deployz hosts.
 */
export type RemediationClass =
  | 'APPLICATION_FIX'
  | 'CONFIGURATION_FIX'
  | 'ALREADY_SUPPORTED'
  | 'DEPLOYZ_LIMITATION'
  | 'NEEDS_INPUT'
  | 'UNSUPPORTED';

export type RemediationConfidence = 'high' | 'medium' | 'low';

/** One remediation item: one finding, or several related findings merged. */
export interface RemediationItem {
  /** The primary finding id; the AI guidance is keyed by it. */
  id: string;
  /** Every finding id the item covers. */
  findingIds: string[];
  name: string;
  classification: RemediationClass;
  confidence: RemediationConfidence;
  /** Whether the finding blocks deployment (required) or only recommends. */
  required: boolean;
  evidence: string[];
  /** Files and directories the agent should inspect first. */
  files: string[];
  /** Ordered, conditional steps ("If …, …. Otherwise …."). */
  actions: string[];
  /** What the agent must not do for this item. */
  constraints: string[];
  /** What "resolved" means for this item. */
  doneWhen: string[];
  /** Deployz settings that resolve the item without a repository change. */
  settings: string[];
}

const FIX_CLASSES = new Set<RemediationClass>(['APPLICATION_FIX', 'CONFIGURATION_FIX']);
const DECISION_CLASSES = new Set<RemediationClass>(['NEEDS_INPUT', 'DEPLOYZ_LIMITATION', 'UNSUPPORTED']);

const CONFIDENCE_FROM_FINDING: Record<ReadinessFinding['confidence'], RemediationConfidence> = {
  confirmed: 'high',
  likely: 'medium',
  needs_confirmation: 'low',
};

/** Lower of two confidences. */
function capConfidence(a: RemediationConfidence, b: RemediationConfidence): RemediationConfidence {
  const rank: Record<RemediationConfidence, number> = { high: 2, medium: 1, low: 0 };
  return rank[a] <= rank[b] ? a : b;
}

const NO_ACTION_OUTCOME = /^no (?:action|change) needed/i;

/** Every finding id the item builders know; the rest use the generic builder. */
const ORDER: readonly string[] = [
  'container-setup',
  'unsupported-no-dockerfile',
  'build-context-git-metadata',
  'unsupported-multi-service',
  'start-command-missing',
  'port-unresolved',
  'localhost-binding',
  'health-check',
  'local-file-storage',
  'unsupported-persistent-volume',
  'unsupported-database-sqlite',
  'unsupported-database-mariadb',
  'unsupported-database-mongo',
  'unsupported-database-elasticsearch',
  'unsupported-database-other',
  'unsupported-redis-setup',
  'migration-command-needs-input',
  'database-migrations',
  'worker-command',
  'unsupported-message-queue',
  'async-question',
  'unsupported-gpu',
  'unsupported-architecture',
];

/** A multi-service finding about one image running several supervised processes. */
const SUPERVISOR_EVIDENCE = /^Unsupported container setup/i;

function orderRank(id: string): number {
  const key = id.startsWith('async-question-') ? 'async-question' : id.split(':')[0]!;
  const rank = ORDER.indexOf(key);
  return rank === -1 ? ORDER.length : rank;
}

/** The Dockerfile reference used in actions. */
function dockerfileRef(facts: FixInstructionsFacts): string {
  return facts.dockerfilePath ? `\`${facts.dockerfilePath}\`` : 'the Dockerfile';
}

/** Package-manager clause for the container-setup step — accurate per manager. */
function packageManagerClause(packageManager: string | null): string {
  if (!packageManager) return '';
  if (packageManager === 'npm') {
    return ' (`npm` — match the Node and npm versions from `engines`/`.nvmrc`; Corepack does not apply to npm)';
  }
  return ` (\`${packageManager}\`, via Corepack when package.json declares \`packageManager\`)`;
}

/** File paths named in a finding's evidence: a token with a directory, a known extension, or a Dockerfile/Procfile name. */
const EVIDENCE_PATH = /(?:^|[\s(,'"`])((?:[\w.@-]+\/)+[\w.@-]+|[\w.@-]+\.(?:ya?ml|json|toml|ini|conf|env|py|js|mjs|cjs|ts|tsx|jsx|rb|go|php|java|kt|gradle|xml|properties)|(?:[\w.-]*\.)?Dockerfile[\w.-]*|Procfile)(?=$|[\s):;,'"`])/g;

function evidenceFiles(evidence: string): string[] {
  const paths = [...evidence.matchAll(EVIDENCE_PATH)].map((match) => match[1]!.replace(/\.$/, ''));
  // A scoped package (`@elastic/elasticsearch`) or a slash between words
  // (`Elasticsearch/OpenSearch`) is not a file: keep paths whose last segment
  // has an extension or is a Dockerfile or Procfile.
  return [...new Set(paths.filter((path) => !path.startsWith('@') && /(?:\.[a-z0-9]+|Dockerfile[\w.-]*|Procfile)$/i.test(path.split('/').pop()!)))];
}

/** Execution-tested: an out-of-date lockfile led the agent to drop the frozen install. */
const FROZEN_INSTALL_ACTION =
  'Install from the lockfile in frozen mode (`npm ci`, `yarn install --frozen-lockfile`, `pnpm install --frozen-lockfile`, pinned requirements). If the lockfile is out of date, report it; do not drop the frozen flag.';

/**
 * Execution-tested: a Django app packaged without its reference nginx served
 * no CSS or JavaScript. The load balancer only forwards to the container.
 */
const PROXY_STATIC_ACTION =
  'If the reference setup serves static files through a reverse proxy (nginx, caddy), make the container serve them itself with the framework\'s production static-file support; the Deployz load balancer only forwards requests to the container.';

/**
 * Execution-tested: a new container configuration defaulted the allowed hosts
 * to `*`. Settings the image reads from the environment must fail closed.
 */
const SECURE_DEFAULT_CONSTRAINT =
  'Do not default security settings open in new configuration (no wildcard allowed hosts, no debug mode, no disabled CSRF or TLS checks); read them from environment variables and fail when a required one is missing.';

/** The common steps for a dependency Deployz does not provide. */
function limitationActions(dependency: string, provided: string): string[] {
  return [
    `Confirm that production code uses ${dependency}: imports and calls on a runtime path, not only tests, scripts, examples, or an optional integration.`,
    `If it is unused, remove only the unused dependency and its dead configuration, and report what you removed.`,
    `If it is an optional feature that configuration can switch off, report the setting and its value; do not delete the feature.`,
    `If the app needs it, stop and report the evidence. ${provided} Replacing ${dependency} is an architecture decision for the vendor; do not start it.`,
  ];
}

/** A compose service name that is a database or cache Deployz provides as a managed service. */
const MANAGED_SERVICE_NAME = /^(?:postgres(?:ql)?|pg(?:vector)?|db|database|mysql|redis|valkey|cache)(?:[-_]?\d+)?$/i;

const LIMITATION_CONSTRAINTS = [
  'Do not rewrite the data layer, replace a queue or service with in-process code, or remove working features to pass the Deployz check.',
];

type ItemDraft = Omit<RemediationItem, 'id' | 'findingIds' | 'required' | 'evidence' | 'files' | 'confidence'> & {
  confidence?: RemediationConfidence;
  files?: string[];
  evidence?: string[];
};

/** Deterministic remediation per finding id. */
const ITEM_BUILDERS: Record<string, (finding: ReadinessFinding, facts: FixInstructionsFacts) => ItemDraft> = {
  'container-setup': (_finding, facts) => {
    const dir = facts.workingDirectory && facts.workingDirectory !== '.' ? facts.workingDirectory : null;
    return {
      name: 'Container packaging missing',
      classification: 'CONFIGURATION_FIX',
      files: [dir ? `${dir}/` : '.', 'package manifests and lockfiles', 'existing CI build files'],
      actions: [
        'If a Dockerfile or container build file already packages this app under another path or name, add nothing; report its path so the vendor selects it in Deployz.',
        `Otherwise add one production Dockerfile${dir ? ` with \`${dir}\` as the build context` : ''} that installs dependencies with the repository's pinned package manager${packageManagerClause(facts.packageManager)}, runs the production build${facts.buildCommand ? ` (\`${facts.buildCommand}\`)` : ''}, and starts the app${facts.startCommand ? ` with \`${facts.startCommand}\`` : ''}${facts.framework ? ` in \`${facts.framework}\` production mode` : ''}.`,
        ...(facts.startCommand
          ? []
          : ['If the build output is static files and no server start exists, serve the built files with a production static server inside the container.']),
        `Make the server listen on 0.0.0.0 on the port it reads from \`PORT\` when the app reads it, and declare that port with EXPOSE.`,
        FROZEN_INSTALL_ACTION,
        'Include build tools only when native dependencies need them; reuse the repository\'s private-registry setup when present.',
        PROXY_STATIC_ACTION,
      ],
      constraints: [
        'Do not use a development or preview server (dev, watch, `vite preview`, `next dev`) as the container command.',
        'Do not copy `.env` files, secrets, or the `.git` directory into the image; Deployz builds from a source archive without git metadata.',
        SECURE_DEFAULT_CONSTRAINT,
      ],
      doneWhen: ['`docker build` succeeds from a clean checkout and the container answers HTTP on the declared port.'],
      settings: [],
    };
  },
  'unsupported-no-dockerfile': (_finding, facts) => ({
    name: 'No Dockerfile builds a production image',
    classification: 'CONFIGURATION_FIX',
    actions: [
      `If the selected Dockerfile copies build output that a CI step creates before \`docker build\`, add a build stage that creates that output inside the image (a multi-stage build); keep the existing runtime stage.`,
      'If the repository has only development or template Dockerfiles, add a separate production Dockerfile; leave the development files unchanged.',
      FROZEN_INSTALL_ACTION,
      PROXY_STATIC_ACTION,
      `The production image installs dependencies, builds the app, and starts the production server${facts.startCommand ? ` (\`${facts.startCommand}\`)` : ''}.`,
    ],
    constraints: [
      'Do not use a development or preview server as the container command.',
      'Do not change or delete the existing development Dockerfiles.',
      SECURE_DEFAULT_CONSTRAINT,
    ],
    doneWhen: ['`docker build` succeeds from a clean checkout with no earlier build steps, and the container starts the production server.'],
    settings: ['If the repository already has a production Dockerfile under another path, the vendor can select it in the Deployz application settings.'],
  }),
  'build-context-git-metadata': (_finding, facts) => ({
    name: 'Dockerfile copies or reads .git metadata',
    classification: 'CONFIGURATION_FIX',
    actions: [
      `Remove \`.git\` from COPY and ADD instructions in ${dockerfileRef(facts)}, and remove build steps that read git history.`,
      'If the build needs a version or commit string from git, read it from a build argument with a safe default (for example `ARG GIT_SHA=unknown`).',
    ],
    constraints: ['Do not remove the version information from the app; only change where the build reads it.'],
    doneWhen: ['`docker build` succeeds from a source archive that has no `.git` directory.'],
    settings: [],
  }),
  'unsupported-multi-service': (finding) => {
    if (SUPERVISOR_EVIDENCE.test(finding.technicalEvidence)) {
      return {
        name: 'Several long-running processes in one container',
        classification: 'CONFIGURATION_FIX',
        actions: [
          'List each long-running program the supervisor starts (evidence below) and its command.',
          'Make the image\'s default command start only the web server.',
          'Declare every other long-running program as a worker with its own command: a `Procfile` line (`<name>: <command>`) or a package.json `worker` script. Deployz runs each worker as its own container from the same image.',
          'A reverse proxy that only forwards requests to the app is not needed behind the Deployz load balancer; a proxy that also serves static files stays, as the web process.',
          'Programs that Deployz provides as managed services (PostgreSQL, MySQL, Redis) need no worker; report them.',
        ],
        constraints: [
          'Do not delete a program or merge two programs into one.',
          'Keep the supervisor setup when other installs need it (for example in a separate Dockerfile).',
        ],
        doneWhen: ['The image starts only the web server by default, and each other program has a declared worker command.'],
        settings: [],
      };
    }
    const services = /application services \(([^)]+)\)/.exec(finding.technicalEvidence)?.[1]?.split(',').map((name) => name.trim()) ?? [];
    if (services.length > 1 && services.slice(1).every((name) => MANAGED_SERVICE_NAME.test(name))) {
      return {
        name: 'Managed service counted as an application service',
        classification: 'CONFIGURATION_FIX',
        actions: [
          `Confirm that ${services.slice(1).map((name) => `\`${name}\``).join(', ')} in the compose file is only a database or cache.`,
          'If it is, the app needs no change for it: Deployz provides the managed database and cache and injects their connection variables. Report the variables the app reads for it.',
          'If it runs application code, report it as a required second service.',
        ],
        constraints: ['Do not delete services from the compose file; other installs use it.'],
        doneWhen: ['The report confirms the service is a managed database or cache, with the variables the app reads.'],
        settings: [],
      };
    }
    return {
      name: 'Several independent application services',
      classification: 'DEPLOYZ_LIMITATION',
      actions: [
        'For each extra application service in the compose file: if it runs the same code with another command (a worker, scheduler, or consumer), declare that command as a worker with a `Procfile` line or a package.json `worker` script. Deployz runs each worker as its own container from the same image.',
        'If a service is optional (an admin tool, a docs site, a development helper), report that; the Deployz deployment can run without it.',
        'If the app needs a service built from other code or another image, stop and report it. Deployz runs one application image per deployment.',
      ],
      constraints: ['Do not merge services into one process, and do not delete services from the compose file.'],
      doneWhen: ['Each extra service is declared as a worker, reported as optional, or reported as a required independent service.'],
      settings: [],
    };
  },
  'start-command-missing': (_finding, facts) => ({
    name: 'Container start command missing',
    classification: 'CONFIGURATION_FIX',
    actions: [
      `Find the production start command (existing scripts, Procfile, documentation)${facts.startCommand ? `; the analysis saw \`${facts.startCommand}\`` : ''}.`,
      `Add a CMD in exec form to ${dockerfileRef(facts)} that runs it.`,
    ],
    constraints: ['Do not use a development, watch, or preview command.'],
    doneWhen: ['The built container starts the production server with no extra arguments.'],
    settings: [],
  }),
  'port-unresolved': (_finding, facts) => ({
    name: 'Application port undeclared',
    classification: 'CONFIGURATION_FIX',
    actions: [
      'Find the port the production server listens on (server code, start command, framework default).',
      `Declare it in ${dockerfileRef(facts)} with EXPOSE; add \`ENV PORT=<port>\` only when the app reads \`PORT\`.`,
    ],
    constraints: ['Do not change the port the app listens on.'],
    doneWhen: ['The Dockerfile declares the port the server actually listens on.'],
    settings: ['Without a repository change, the vendor can enter the container port in the Deployz application settings.'],
  }),
  'localhost-binding': (finding, facts) => {
    const evidence = finding.technicalEvidence;
    const configured =
      /dockerfile|\bcmd\b|entrypoint|compose|procfile|\.env\b|--host|--bind|gunicorn|uvicorn|\.(?:ya?ml|toml|ini|conf|json)\b/i.test(evidence) ||
      /\b[A-Z_]*HOST\b/.test(evidence);
    return {
      name: 'Server binds to localhost only',
      classification: configured ? 'CONFIGURATION_FIX' : 'APPLICATION_FIX',
      actions: [
        'Find where the loopback address is set (evidence below).',
        'If a setting, flag, or environment variable controls the bind address (for example `HOST`, `--host`, `--bind`), set it to `0.0.0.0` for the container (Dockerfile ENV or CMD, or a Deployz environment variable) instead of changing code.',
        'Otherwise change the production listen address to `0.0.0.0`; keep a loopback address only behind a development-only condition.',
      ],
      constraints: ['Do not change the port.'],
      doneWhen: [`Inside the container the server listens on 0.0.0.0${facts.port ? `:${facts.port}` : ''}.`],
      settings: [],
    };
  },
  'health-check': (_finding, facts) => {
    if (facts.healthPath && facts.healthPathSetByVendor) {
      return {
        name: 'Health check path set in Deployz',
        classification: 'ALREADY_SUPPORTED',
        evidence: [`The vendor set \`${facts.healthPath}\` as the health check path; do not add another route.`],
        actions: [],
        constraints: [],
        doneWhen: [],
        settings: [],
      };
    }
    return {
      name: 'Readiness endpoint missing',
      classification: 'APPLICATION_FIX',
      actions: [
        'Search for an existing unauthenticated route that returns 2xx quickly (health, healthz, ping, status, ready, or the framework\'s built-in health endpoint). If one exists, add no code; report its path.',
        'Otherwise add the smallest unauthenticated GET route (for example `/health`) that returns 200 once the server accepts requests. Register it before authentication, redirect (HTTPS, locale, trailing slash), and host-check middleware.',
        'Keep the route free of database and external calls, so a slow dependency does not restart healthy containers.',
      ],
      constraints: [
        'Do not add a Dockerfile HEALTHCHECK for Deployz; it probes the HTTP path directly.',
        'Do not disable authentication or security middleware globally to make the probe pass.',
      ],
      doneWhen: ['`GET <path>` on the running container returns 2xx without a redirect or credentials.'],
      settings: ['The vendor sets the route as the health check path in the Deployz application settings, or re-runs the Deployz analysis after the change.'],
    };
  },
  'local-file-storage': () => ({
    name: 'Persistent data written to local disk',
    classification: 'APPLICATION_FIX',
    actions: [
      'Classify each write in the evidence: temporary or cache files may stay on local disk; data that must survive a redeploy (uploads, attachments, generated documents) must not.',
      'If the app already supports S3 or S3-compatible storage by configuration, change no code: report the settings (for example a storage driver variable set to `s3` and the bucket variable). The vendor sets them in Deployz and maps the bucket variable to the Deployz-managed bucket.',
      'Otherwise move only the persistent writes and reads to S3 with the AWS SDK for this runtime. Read the bucket name from `STORAGE_BUCKET` (or a bucket variable the app already reads) and the Region from `AWS_REGION`. The SDK default credential chain gets credentials from the container role.',
    ],
    constraints: [
      'Do not add access keys, secrets, or a public bucket URL to code or configuration.',
      'Keep local storage available for development when the app has a storage setting; do not delete it.',
    ],
    doneWhen: ['Data that must survive a redeploy is written to and read from the bucket; the container disk holds only temporary files.'],
    settings: ['Map the app\'s bucket variable to "Managed by Deployz → Bucket name" in the Deployz environment settings when it uses another name.'],
  }),
  'unsupported-persistent-volume': (finding) => {
    // A variable ending in _CONFIG_DIR names configuration the vendor edits,
    // not runtime data: it ships in the image and never moves to object storage.
    const configDir = /\b[A-Z][A-Z0-9_]*_CONFIG_DIR\b/.test(finding.technicalEvidence);
    return {
      name: 'Persistent volume not supported',
      classification: configDir ? 'CONFIGURATION_FIX' : 'APPLICATION_FIX',
      actions: [
        ...(configDir
          ? [
              'The evidence names a configuration directory (a variable ending in `_CONFIG_DIR`). Commit the configuration files to the repository and COPY them into the image; do not move them to object storage.',
            ]
          : []),
        'Find what each volume in the evidence stores.',
        'If it stores only the data of a service Deployz provides as a managed service (PostgreSQL, MySQL, Redis), report it; no change is needed for it.',
        'If it stores application files (uploads, media, generated files), move those writes to the Deployz-managed S3 bucket (`STORAGE_BUCKET`, `AWS_REGION`, credentials from the container role), or report the configuration that selects S3 when the app already supports it.',
        'If the app needs a persistent POSIX filesystem (an embedded database, git repositories, a search index on disk), stop and report it. Deployz does not attach volumes.',
      ],
      constraints: ['Do not add access keys or secrets.', 'Do not delete the volume declaration that other installs use; report it instead.'],
      doneWhen: ['Nothing that must survive a redeploy depends on a volume, or the report names the data that needs one.'],
      settings: [],
    };
  },
  'unsupported-database-sqlite': () => ({
    name: 'Unsupported database engine: SQLite',
    classification: 'DEPLOYZ_LIMITATION',
    actions: [
      'Check whether the app already supports PostgreSQL or MySQL by configuration (a `DATABASE_URL`, a database type setting, or an ORM provider switch). If it does, change no code; report the setting and its value. Deployz then provides the database.',
      'Otherwise stop and report the evidence. SQLite stores data on the container disk, which Deployz replaces on every deploy. Moving the data layer to PostgreSQL or MySQL is an architecture decision for the vendor; do not start it.',
    ],
    constraints: LIMITATION_CONSTRAINTS,
    doneWhen: ['The report names the setting that selects PostgreSQL or MySQL, or confirms the app supports SQLite only.'],
    settings: [],
  }),
  'unsupported-database-mariadb': () => ({
    name: 'Unsupported database engine: MariaDB',
    classification: 'DEPLOYZ_LIMITATION',
    actions: [
      'Deployz provides MySQL 8.0. Check whether the app works with MySQL: a MySQL driver, a `mysql` connection setting (for example Laravel `DB_CONNECTION=mysql`), or a JDBC `jdbc:mysql:` URL.',
      'If it does, report the setting and its value; the vendor decides whether to switch.',
      'If the app depends on MariaDB-only features, stop and report them; do not rewrite queries.',
    ],
    constraints: LIMITATION_CONSTRAINTS,
    doneWhen: ['The app selects MySQL, or the report names the MariaDB-only features it needs.'],
    settings: [],
  }),
  'unsupported-database-mongo': () => ({
    name: 'Unsupported database engine: MongoDB',
    classification: 'DEPLOYZ_LIMITATION',
    actions: limitationActions('MongoDB', 'Deployz provides PostgreSQL and MySQL only.'),
    constraints: LIMITATION_CONSTRAINTS,
    doneWhen: ['The report states whether MongoDB is unused, optional, or required, with evidence.'],
    settings: [],
  }),
  'unsupported-database-elasticsearch': () => ({
    name: 'Unsupported search engine: Elasticsearch/OpenSearch',
    classification: 'DEPLOYZ_LIMITATION',
    actions: limitationActions('Elasticsearch/OpenSearch', 'Deployz does not provide a search engine.'),
    constraints: LIMITATION_CONSTRAINTS,
    doneWhen: ['The report states whether the search engine is unused, optional, or required, with evidence.'],
    settings: [],
  }),
  'unsupported-database-other': () => ({
    name: 'Unsupported database engine',
    classification: 'DEPLOYZ_LIMITATION',
    actions: limitationActions('the database named in the evidence', 'Deployz provides PostgreSQL and MySQL only.'),
    constraints: LIMITATION_CONSTRAINTS,
    doneWhen: ['The report states whether the database is unused, optional, or required, with evidence.'],
    settings: [],
  }),
  'unsupported-redis-setup': () => ({
    name: 'Unsupported Redis features (modules or cluster mode)',
    classification: 'DEPLOYZ_LIMITATION',
    actions: limitationActions(
      'the Redis feature named in the evidence',
      'Deployz provides one Redis-compatible (Valkey) node without TLS, modules, or cluster mode.',
    ),
    constraints: LIMITATION_CONSTRAINTS,
    doneWhen: ['The report states whether the feature is unused, optional, or required, with evidence.'],
    settings: [],
  }),
  'unsupported-message-queue': () => ({
    name: 'External message queue not supported',
    classification: 'DEPLOYZ_LIMITATION',
    actions: limitationActions(
      'the message broker named in the evidence',
      'Deployz provides SQS Standard queues only, when the app uses the SQS SDK for both producer and consumer.',
    ),
    constraints: LIMITATION_CONSTRAINTS,
    doneWhen: ['The report states whether the broker is unused, optional, or required, with evidence.'],
    settings: [],
  }),
  'unsupported-gpu': () => ({
    name: 'GPU requirement not supported',
    classification: 'DEPLOYZ_LIMITATION',
    actions: [
      'Check whether the app has a CPU mode (a device setting, a CPU build, or a CPU image variant). If it does, report the setting and its value; change no code.',
      'Otherwise stop and report the evidence. Deployz runs containers on standard CPUs only.',
    ],
    constraints: ['Do not remove GPU features or models from the app.'],
    doneWhen: ['The report names the CPU setting, or confirms that the app needs a GPU.'],
    settings: [],
  }),
  'unsupported-architecture': () => ({
    name: 'Self-managed infrastructure not supported',
    classification: 'UNSUPPORTED',
    actions: [
      'Find out what the files in the evidence do.',
      'If they are only an alternative way to deploy this app (manifests, charts, or infrastructure code for another platform) and the app does not use them at runtime, report that. The vendor can keep them in a deployment directory (`deploy/`, `k8s/`, `helm/`, `infra/`, `terraform/`), which Deployz ignores.',
      'If the app itself manages infrastructure (a Kubernetes controller, serverless functions, or a cloud provider\'s platform services), stop and report it. Deployz cannot host it.',
    ],
    constraints: ['Do not delete or move deployment files, and do not remove infrastructure features from the app.'],
    doneWhen: ['The report states whether the files are optional deployment alternatives or a runtime requirement, with evidence.'],
    settings: [],
  }),
  'migration-command-needs-input': () => ({
    name: 'Migration command not confirmed for the production image',
    classification: 'NEEDS_INPUT',
    actions: [
      'Check whether the production image can run the migration script in the evidence: its runtime stage must contain the runner (for example the ORM CLI) and the migration files.',
      'Report one result: the exact command the image can run as it is; or that the app applies migrations itself at startup; or what the image lacks to run the script.',
    ],
    constraints: [
      'Do not change the Dockerfile or add migration tooling for this item unless the vendor asks for it.',
      'Do not run migrations against a shared or production database.',
    ],
    doneWhen: ['The report gives the vendor what to enter: a migration command, or "No separate migration".'],
    settings: ['The vendor enters the migration command, or chooses "No separate migration", in the Deployz application settings.'],
  }),
  'database-migrations': (finding, facts) => {
    if (facts.suggestedMigrationCommand) {
      return {
        name: 'Database migration command not set',
        classification: 'CONFIGURATION_FIX',
        actions: [
          `Confirm that \`${facts.suggestedMigrationCommand}\` runs non-interactively in the production image. If it does, change nothing and report it.`,
          'If the app already applies migrations when it starts, report the file that does it instead.',
        ],
        constraints: ['Do not run migrations against a shared or production database.'],
        doneWhen: ['The report confirms the migration command, or the file that migrates at startup.'],
        settings: [`The vendor sets \`${facts.suggestedMigrationCommand}\` as the migration command in the Deployz application settings, or chooses "No separate migration".`],
      };
    }
    return {
      name: 'Database migration command missing',
      classification: finding.confidence === 'needs_confirmation' ? 'NEEDS_INPUT' : 'CONFIGURATION_FIX',
      confidence: 'low',
      actions: [
        'Find how this app applies its database schema: a migration tool (for example Prisma, Knex, TypeORM, Sequelize, Drizzle, Alembic, Django, Rails, Laravel, Flyway, Liquibase, golang-migrate, goose) or a schema sync when the app starts.',
        'If the app already applies migrations when it starts, change nothing; report the file that does it.',
        'If a migration command exists, report the exact non-interactive command the production image can run. Add a package script only when that command needs one.',
        'If no migration mechanism exists, report that; do not invent a schema or add a migration framework.',
      ],
      constraints: ['Do not run migrations against a shared or production database.', 'Do not add a new ORM or migration tool.'],
      doneWhen: ['The report names one non-interactive migration command the image can run, or the file that migrates at startup.'],
      settings: ['The vendor sets the migration command, or chooses "No separate migration", in the Deployz application settings.'],
    };
  },
  'worker-command': () => ({
    name: 'Background job runner has no declared start command',
    classification: 'NEEDS_INPUT',
    confidence: 'medium',
    actions: [
      'Find the job runner in the evidence: the code that consumes jobs or runs schedules, and how it starts.',
      'If the web process already starts the job runner in the same process, change nothing; report where.',
      'If a separate entry point exists (a worker file or a CLI command), declare the command that starts it in production: a `Procfile` line (`worker: <command>`) or a package.json `worker` script. Deployz runs each declared worker as its own container from the same image.',
      'If the job code is not used at runtime, report that; do not delete it.',
    ],
    constraints: [
      'Do not move the worker into the web process, and do not remove worker, queue, or scheduler code.',
      'Do not add a process manager (pm2, supervisord) to run several processes in one container.',
    ],
    doneWhen: ['One production command starts the worker on its own, or the report shows that the web process already runs the jobs.'],
    settings: [],
  }),
};

/** Builder for an `async-question-*` finding. */
function asyncQuestionItem(finding: ReadinessFinding): ItemDraft {
  return {
    name: 'Unconfirmed queue or schedule',
    classification: 'NEEDS_INPUT',
    actions: [
      `Answer the question: ${finding.plainEnglishExplanation}`,
      'Report whether production uses this queue or schedule, the code that produces and consumes it, and the command and schedule that run it.',
    ],
    constraints: ['Do not remove or rewrite the queue or schedule code.'],
    doneWhen: ['The report answers the question with file references.'],
    settings: [],
  };
}

/** Builder for a finding id the catalogue does not know: verify and report only. */
function genericItem(finding: ReadinessFinding): ItemDraft {
  return {
    name: finding.title,
    classification: 'NEEDS_INPUT',
    actions: [`Verify the evidence. Required outcome: ${finding.suggestedOutcome}`, 'Report what you found before changing code.'],
    constraints: [],
    doneWhen: ['The report confirms or rejects the finding with file references.'],
    settings: [],
  };
}

function isAlreadySupported(finding: ReadinessFinding): boolean {
  return (
    NO_ACTION_OUTCOME.test(finding.suggestedOutcome.trim()) ||
    finding.id === 'worker-process' ||
    finding.id === 'async-workloads'
  );
}

/** An already-supported finding, rendered as a "keep as is" line. */
function alreadySupportedItem(finding: ReadinessFinding): RemediationItem {
  return {
    id: finding.id,
    findingIds: [finding.id],
    name: finding.title,
    classification: 'ALREADY_SUPPORTED',
    confidence: CONFIDENCE_FROM_FINDING[finding.confidence],
    required: false,
    evidence: [finding.technicalEvidence],
    files: [],
    actions: [],
    constraints: [],
    doneWhen: [],
    settings: [],
  };
}

/**
 * The deterministic remediation plan: one item per finding, related findings
 * merged, ordered by dependency (packaging, start, port, binding, health,
 * storage, data, workers, limitations). Pure.
 */
export function planRemediation(context: FixInstructionsContext): RemediationItem[] {
  const findings = [...context.findings];
  // The migration question supersedes the generic migration finding: both
  // describe one migration decision, and "add a script" would contradict the
  // script the question already found.
  const migrationQuestion = findings.find((f) => f.id === 'migration-command-needs-input');
  const merged = new Map<string, ReadinessFinding[]>();
  for (const finding of findings) {
    const key = migrationQuestion && finding.id === 'database-migrations' && !isAlreadySupported(finding)
      ? 'migration-command-needs-input'
      : finding.id === 'unsupported-multi-service' && SUPERVISOR_EVIDENCE.test(finding.technicalEvidence)
        ? 'unsupported-multi-service:process'
        : finding.id;
    const group = merged.get(key) ?? [];
    if (!group.some((f) => f.id === finding.id && f.technicalEvidence === finding.technicalEvidence)) group.push(finding);
    merged.set(key, group);
  }

  const items: RemediationItem[] = [];
  for (const [key, group] of merged) {
    const primary = group.find((f) => f.id === key.split(':')[0]) ?? group[0]!;
    if (isAlreadySupported(primary)) {
      items.push(alreadySupportedItem(primary));
      continue;
    }
    const builder = ITEM_BUILDERS[primary.id];
    const draft = builder
      ? builder(primary, context.facts)
      : primary.id.startsWith('async-question-')
        ? asyncQuestionItem(primary)
        : genericItem(primary);
    const evidence = draft.evidence ?? [...new Set(group.map((f) => f.technicalEvidence))];
    const findingConfidence = group
      .map((f) => CONFIDENCE_FROM_FINDING[f.confidence])
      .reduce((a, b) => capConfidence(a, b));
    const files = [...new Set([...(draft.files ?? []), ...evidence.flatMap(evidenceFiles)])];
    items.push({
      ...draft,
      id: key,
      findingIds: [...new Set(group.map((f) => f.id))],
      required: group.some((f) => f.severity === 'required'),
      evidence,
      files,
      confidence: draft.confidence ? capConfidence(draft.confidence, findingConfidence) : findingConfidence,
    });
  }

  return items.sort((a, b) => orderRank(a.id) - orderRank(b.id));
}

// ── Facts and capabilities ──────────────────────────────────────────────────

const WORKER_IDS = new Set(['worker-command', 'unsupported-multi-service', 'unsupported-message-queue']);
const DATABASE_IDS = new Set([
  'database-migrations', 'migration-command-needs-input', 'unsupported-database-sqlite', 'unsupported-database-mariadb',
  'unsupported-database-mongo', 'unsupported-database-other', 'unsupported-persistent-volume',
]);
const STORAGE_IDS = new Set(['local-file-storage', 'unsupported-persistent-volume', 'unsupported-database-sqlite']);
const PACKAGING_IDS = new Set(['container-setup', 'unsupported-no-dockerfile', 'start-command-missing']);

/** What Deployz provides, limited to what the plan's items touch. */
function capabilityLines(items: RemediationItem[], facts: FixInstructionsFacts): string[] {
  const ids = new Set(items.flatMap((item) => item.findingIds));
  const has = (set: Set<string>) => [...ids].some((id) => set.has(id));
  const lines = [
    '- Deployz builds one image from the repository Dockerfile and runs it as a load-balanced web container (AWS ECS Fargate). The load balancer probes an HTTP health check path.',
    '- Environment variables and secrets are set per deployment in Deployz, never in the image.',
  ];
  if (has(WORKER_IDS) || [...ids].some((id) => id.startsWith('async-question-'))) {
    lines.push('- Each declared worker (a `Procfile` line, a package.json `worker` script, or a compose worker service) runs as its own container from the same image, with its own command and no URL.');
  }
  if (has(DATABASE_IDS) || facts.database !== 'none') {
    lines.push(
      `- Managed PostgreSQL 16 or MySQL 8.0${facts.database !== 'none' ? ` (this app: ${facts.database === 'postgres' ? 'PostgreSQL' : 'MySQL'})` : ''}, injected as \`DATABASE_URL\` and \`DATABASE_*\` plus the names the app reads. A migration command runs once per release, before the new version starts.`,
    );
  }
  if (facts.redisRequired || ids.has('unsupported-redis-setup')) {
    lines.push('- Redis-compatible Valkey: one node, no TLS, no modules, no cluster mode, injected as `REDIS_URL` and the names the app reads.');
  }
  if (has(STORAGE_IDS)) {
    lines.push(
      '- One S3 bucket per deployment: `STORAGE_BUCKET`, `S3_BUCKET`, `AWS_S3_BUCKET`, and `AWS_REGION` are set. Credentials come from the container role; access keys are never needed.',
      '- Container disks are not persistent: Deployz replaces them on every deploy and restart.',
    );
  }
  return lines;
}

function factLines(label: string, names: string[]): string[] {
  return names.length > 0 ? [`- ${label} (names only): ${names.join(', ')}`] : [];
}

/** Detected facts the plan's items justify — an absent fact adds noise. */
function renderFacts(context: FixInstructionsContext, items: RemediationItem[]): string[] {
  const { facts } = context;
  const ids = new Set(items.flatMap((item) => item.findingIds));
  const any = (...wanted: string[]) => wanted.some((id) => ids.has(id));
  const lines: string[] = [
    `- Repository: ${context.repoFullName}`,
    ...(context.commitSha ? [`- Analysed commit: ${context.commitSha}`] : []),
  ];
  const push = (when: boolean, line: string | null) => {
    if (when && line !== null) lines.push(line);
  };
  push(true, facts.runtime ? `- Runtime: ${facts.runtime}` : null);
  push(true, facts.framework ? `- Framework: ${facts.framework}` : null);
  push(any(...PACKAGING_IDS), facts.packageManager ? `- Package manager: ${facts.packageManager}` : null);
  push(any(...PACKAGING_IDS), facts.buildCommand ? `- Build command: \`${facts.buildCommand}\`` : null);
  push(any(...PACKAGING_IDS, 'worker-command'), facts.startCommand ? `- Detected start command: \`${facts.startCommand}\`` : null);
  push(any('container-setup', 'port-unresolved', 'health-check', 'localhost-binding'), facts.port ? `- Application port: ${facts.port}` : null);
  push(true, facts.dockerfilePath ? `- Container build file: ${facts.dockerfilePath}` : null);
  push(any('database-migrations', 'migration-command-needs-input'), facts.migrationCommand ? `- Migration command: \`${facts.migrationCommand}\`` : null);
  push(any('health-check'), facts.healthPath ? `- Configured health check path: ${facts.healthPath}` : null);
  push(
    facts.workerCommands.length > 0,
    `- Declared workers: ${facts.workerCommands.map((command) => `\`${command}\``).join(', ')}`,
  );
  push(
    Boolean(facts.workingDirectory && facts.workingDirectory !== '.'),
    `- Application directory (workspace): ${facts.workingDirectory}`,
  );
  if (any(...PACKAGING_IDS) && facts.envRequirements) {
    lines.push(
      ...factLines('Required at build time', facts.envRequirements.buildTime),
      ...factLines('Required at runtime', facts.envRequirements.runtime),
      ...factLines('Provided by Deployz at runtime', facts.envRequirements.platformInjected),
    );
  }
  return lines;
}

// ── AI prompt ───────────────────────────────────────────────────────────────

/** One plan item, rendered for the model. */
function renderItemForModel(item: RemediationItem): string[] {
  return [
    `- id: ${item.id}`,
    `  name: ${item.name}`,
    `  class: ${item.classification}`,
    `  evidence: ${item.evidence.join(' | ')}`,
    '  actions already given:',
    ...item.actions.map((step) => `    - ${step}`),
    ...(item.constraints.length > 0 ? ['  constraints:', ...item.constraints.map((rule) => `    - ${rule}`)] : []),
  ];
}

/**
 * Build the prompt that asks the model for repository-specific guidance per
 * plan item. Built exclusively from structured deterministic facts, finding
 * evidence and the deterministic plan — never repository file contents.
 */
export function buildFixInstructionsAiPrompt(
  context: FixInstructionsContext,
  plan: RemediationItem[] = planRemediation(context),
): string {
  const items = plan.filter((item) => item.classification !== 'ALREADY_SUPPORTED');
  const lines: string[] = [
    'You add repository-specific detail to a remediation plan that a coding agent will execute.',
    'The plan is final: its classes, actions, and constraints are fixed. For each item, write',
    'guidance that makes the given actions concrete for this runtime and framework.',
    '',
    'Rules:',
    '- Use only the facts and evidence below. Do not state a file, version, script, route, or',
    '  setting as fact unless it appears below; name candidates conditionally ("if the app uses X, …").',
    '- Never contradict an action or a constraint, and never restate them.',
    '- Never suggest deleting working code, moving a worker into the web process, disabling',
    '  security or authentication, adding credentials or secret values, skipping tests, or',
    '  suppressing errors.',
    '- Prefer a configuration change over a code change.',
    '- For NEEDS_INPUT, DEPLOYZ_LIMITATION, and UNSUPPORTED items, say only what to check and',
    '  report. Do not suggest code changes for them.',
    '- Never recommend a development or preview server as the production start.',
    '- When the facts give nothing useful to add, return an empty guidance string.',
    '',
    'Repository facts:',
    ...renderFacts(context, items),
    '',
    'What Deployz provides:',
    ...capabilityLines(items, context.facts),
    '',
    'Plan items:',
    ...items.flatMap(renderItemForModel),
    '',
    'Respond with JSON matching {"items": [{"id": string, "guidance": string}]}, one entry per',
    'item id above. Each guidance: at most three sentences and 70 words, plain text, no code',
    'blocks, no headings. Respond with only the JSON.',
  ];
  return lines.join('\n');
}

// ── AI guidance safety ──────────────────────────────────────────────────────

/**
 * Guidance the model must never give. A match drops that item's guidance —
 * the deterministic actions stay — so one bad sentence cannot reach the
 * coding agent. Each rule has a name so a drop can be logged without the text.
 * A clause that starts with "do not", "never" or "avoid", and a match right
 * after "do not", "never" or "not", forbid the change and do not count.
 */
const UNSAFE_GUIDANCE: readonly { name: string; pattern: RegExp }[] = [
  {
    name: 'remove-job-code',
    pattern: /\b(?:delete|remove|drop|strip out)\b[^.]{0,60}\b(?:worker|queue|scheduler|job|tests?|auth\w*|middleware|security|csrf|validation|migrations?)\b/i,
  },
  {
    name: 'merge-worker-into-web',
    pattern:
      /\b(?:move|merge|fold|inline|run|process|replace)\b[^.]{0,40}\b(?:worker|jobs?|queue|consumer)\b[^.]{0,40}(?<!\bnot |\binstead of )\b(?:into|inside)\b[^.]{0,20}\b(?:web|main|server|same)\b/i,
  },
  {
    name: 'delete-infrastructure',
    pattern: /\b(?:delete|remove|drop|strip out)\b[^.]{0,40}\binfrastructure\b/i,
  },
  {
    name: 'rewrite-data-layer',
    pattern: /\b(?:move|migrate|switch|port|rewrite)\b[^.]{0,30}\b(?:data layer|database)\b[^.]{0,20}\bto (?:postgres\w*|mysql)\b/i,
  },
  {
    name: 'disable-security',
    pattern: /\b(?:disable|bypass|turn off|skip)\b[^.]{0,40}\b(?:auth\w*|csrf|tls|ssl|https|security|verification|tests?|lint|type ?check|health ?checks?)\b/i,
  },
  { name: 'unsafe-flag', pattern: /--no-verify|chmod\s+777|--privileged|\bprivileged:\s*true/i },
  {
    name: 'embed-secret',
    pattern: /\b(?:hard-?code|embed|commit)\b[^.]{0,40}\b(?:secret|password|api[ _-]?key|token|credential|access key)/i,
  },
  { name: 'secret-token', pattern: /\b(?:AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,})\b/ },
  { name: 'swallow-errors', pattern: /\b(?:catch|swallow|ignore|suppress)\b[^.]{0,30}\b(?:all )?(?:errors?|exceptions?)\b/i },
  {
    name: 'dev-server',
    pattern: /\b(?:npm run dev|next dev|vite preview|npm run preview|yarn dev|pnpm dev|flask run|manage\.py runserver|rails s(?:erver)?\b[^.]*development)/i,
  },
];

const FORBIDDING_CLAUSE = /^(?:do not|don't|never|avoid)\b/i;
const FORBIDS = /\b(?:do not|don't|never|not)\s+$/i;

/** The clauses of the guidance that do not forbid a change. A period splits only before a space, not in `config.ts`. */
function clauses(text: string): string[] {
  return text
    .split(/[;!?]|\.(?=\s|$)/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0 && !FORBIDDING_CLAUSE.test(clause));
}

function hasUnforbiddenMatch(pattern: RegExp, clause: string): boolean {
  const global = new RegExp(pattern.source, `${pattern.flags}g`);
  for (let match = global.exec(clause); match !== null; match = global.exec(clause)) {
    if (!FORBIDS.test(clause.slice(0, match.index))) return true;
    global.lastIndex = match.index + 1;
  }
  return false;
}

/** Why a guidance string was dropped. It never carries the text. */
export type GuidanceVerdict =
  | { ok: true }
  | { ok: false; reason: 'empty' | 'too_long' | 'unsafe'; rule?: string; length: number };

/** Whether one AI guidance string may reach the document, and why not. */
export function guidanceVerdict(guidance: string): GuidanceVerdict {
  const text = guidance.trim();
  const length = text.length;
  if (length === 0) return { ok: false, reason: 'empty', length };
  if (length > FIX_INSTRUCTIONS_MAX_GUIDANCE_CHARS) return { ok: false, reason: 'too_long', length };
  const unsafe = UNSAFE_GUIDANCE.find((rule) => clauses(text).some((clause) => hasUnforbiddenMatch(rule.pattern, clause)));
  return unsafe ? { ok: false, reason: 'unsafe', rule: unsafe.name, length } : { ok: true };
}

/** Whether one AI guidance string may reach the document. */
export function isSafeGuidance(guidance: string): boolean {
  return guidanceVerdict(guidance).ok;
}

/** One dropped guidance entry. It holds no guidance text, so a caller may log it. */
export interface DroppedGuidance {
  itemId: string;
  reason: 'empty' | 'too_long' | 'unsafe' | 'unknown_item';
  rule?: string;
  length: number;
}

// ── Deterministic assembly ──────────────────────────────────────────────────

/**
 * The verbatim guardrail every generated document must carry. Exported so
 * tests can assert its presence without duplicating the wording.
 */
export const FIX_INSTRUCTIONS_GUARDRAIL =
  'Do not assume Deployz findings are correct. Inspect the repository first. If an indicated ' +
  'problem is already handled differently, preserve the existing architecture and explain why no ' +
  'change is required.';

const CLASS_LABEL: Record<RemediationClass, string> = {
  APPLICATION_FIX: 'APPLICATION_FIX — application code change',
  CONFIGURATION_FIX: 'CONFIGURATION_FIX — configuration only',
  ALREADY_SUPPORTED: 'ALREADY_SUPPORTED',
  DEPLOYZ_LIMITATION: 'DEPLOYZ_LIMITATION — vendor decision',
  NEEDS_INPUT: 'NEEDS_INPUT — vendor decision',
  UNSUPPORTED: 'UNSUPPORTED — vendor decision',
};

const CONFIDENCE_NOTE: Record<RemediationConfidence, string> = {
  high: 'high',
  medium: 'medium — verify first: static analysis can miss an existing solution',
  low: 'low — confirm this applies before changing anything',
};

function renderItem(item: RemediationItem, index: number, guidance: string | undefined): string[] {
  const lines = [
    `### ${index}. ${item.name}${item.required ? '' : ' (recommended)'}`,
    '',
    `- Class: ${CLASS_LABEL[item.classification]}`,
    `- Confidence: ${CONFIDENCE_NOTE[item.confidence]}`,
    `- Evidence: ${item.evidence.join(' | ')}`,
    ...(item.files.length > 0 ? [`- Check first: ${item.files.join(', ')}`] : []),
    '- Actions:',
    ...item.actions.map((step) => `  - ${step}`),
    ...(guidance ? [`  - Repository detail: ${guidance.trim()}`] : []),
    ...(item.settings.length > 0 ? ['- Deployz settings (vendor, no repository change):', ...item.settings.map((s) => `  - ${s}`)] : []),
    ...(item.constraints.length > 0 ? ['- Do not:', ...item.constraints.map((rule) => `  - ${rule}`)] : []),
    ...(item.doneWhen.length > 0 ? ['- Done when:', ...item.doneWhen.map((rule) => `  - ${rule}`)] : []),
    '',
  ];
  return lines;
}

/** Validation steps that apply to the plan's items and facts. */
function validationLines(facts: FixInstructionsFacts, items: RemediationItem[]): string[] {
  const ids = new Set(items.flatMap((item) => item.findingIds));
  const has = (...wanted: string[]) => wanted.some((id) => ids.has(id));
  const lines = ['- Run the repository\'s existing tests, lint, and typecheck when they exist, before and after your changes.'];
  if (facts.buildCommand !== null || has('container-setup', 'unsupported-no-dockerfile')) {
    lines.push(`- Build for production${facts.buildCommand ? ` (\`${facts.buildCommand}\`)` : ''}.`);
  }
  if (has('container-setup', 'unsupported-no-dockerfile', 'start-command-missing', 'port-unresolved', 'build-context-git-metadata', 'unsupported-multi-service', 'localhost-binding') || facts.dockerfilePath !== null) {
    lines.push('- Build the container image when Docker is available.');
  }
  if (has('container-setup', 'unsupported-no-dockerfile', 'start-command-missing', 'port-unresolved', 'localhost-binding', 'health-check')) {
    lines.push(
      `- Start the built container and confirm it listens on ${facts.port ? `port ${facts.port}` : 'the declared port'} on all interfaces.`,
    );
  }
  if (has('health-check', 'localhost-binding')) {
    lines.push(
      `- Request the health check path${facts.healthPath ? ` (\`${facts.healthPath}\`)` : ''} and confirm a direct HTTP 2xx with no redirect and no credentials.`,
    );
  }
  if (facts.database !== 'none' && has('database-migrations', 'migration-command-needs-input')) {
    lines.push('- Run a migration command only against a disposable local database — never shared or production data.');
  }
  if (has('local-file-storage', 'unsupported-persistent-volume')) {
    lines.push('- Exercise one upload or persistent write and read against a test bucket or a local S3-compatible server when available.');
  }
  lines.push('- A successful build alone does not prove a fix: check the behavior each item\'s "Done when" names.');
  return lines;
}

/**
 * Assemble the final coding-agent document from the deterministic plan and
 * the model's guidance. Sections: context, fixes in order, vendor decisions,
 * already supported, rules, validation, completion report. Guidance that is
 * not for a plan item, or that breaks the safety rules, is not rendered.
 */
export function assembleFixInstructions(
  context: FixInstructionsContext,
  ai: FixInstructionsAiOutput,
  items: RemediationItem[] = planRemediation(context),
  options: { onDropped?: ((dropped: DroppedGuidance) => void) | undefined } = {},
): string {
  const itemIds = new Set(items.map((item) => item.id));
  const guidanceById = new Map<string, string>();
  for (const entry of ai.items) {
    const verdict = guidanceVerdict(entry.guidance);
    if (!verdict.ok) {
      options.onDropped?.({
        itemId: entry.id,
        reason: verdict.reason,
        ...(verdict.rule ? { rule: verdict.rule } : {}),
        length: verdict.length,
      });
    } else if (!itemIds.has(entry.id)) {
      options.onDropped?.({ itemId: entry.id, reason: 'unknown_item', length: entry.guidance.trim().length });
    } else {
      guidanceById.set(entry.id, entry.guidance);
    }
  }
  const fixes = items.filter((item) => FIX_CLASSES.has(item.classification));
  const decisions = items.filter((item) => DECISION_CLASSES.has(item.classification));
  const supported = items.filter((item) => item.classification === 'ALREADY_SUPPORTED');
  const actionable = items.filter((item) => item.classification !== 'ALREADY_SUPPORTED');
  const blockingDecision = decisions.some((item) => item.required && item.classification !== 'NEEDS_INPUT');
  const shortSha = context.commitSha ? context.commitSha.slice(0, 7) : null;

  const lines: string[] = [
    `# Fix deployment blockers — ${context.repoFullName}${shortSha ? ` (@${shortSha})` : ''}`,
    '',
    'Prompt for an AI coding agent working in this repository. Resolve the items below in order.',
    FIX_INSTRUCTIONS_GUARDRAIL,
    '',
    '## Context',
    '',
    ...renderFacts(context, actionable),
    '',
    'What Deployz provides:',
    '',
    ...capabilityLines(actionable, context.facts),
    '',
  ];

  let index = 0;
  if (fixes.length > 0) {
    lines.push('## Fixes, in order', '');
    if (blockingDecision) {
      lines.push(
        'A blocking vendor decision is listed under "Vendor decisions". These fixes alone do not make the app deployable; report the decision first.',
        '',
      );
    }
    for (const item of fixes) lines.push(...renderItem(item, ++index, guidanceById.get(item.id)));
  }
  if (decisions.length > 0) {
    lines.push(
      '## Vendor decisions',
      '',
      'Verify each item and report your findings. Change code for an item only where its actions say so.',
      '',
    );
    for (const item of decisions) lines.push(...renderItem(item, ++index, guidanceById.get(item.id)));
  }
  if (supported.length > 0) {
    lines.push(
      '## Already supported — keep as is',
      '',
      ...supported.map((item) => `- ${item.name}: ${item.evidence.join(' | ')}`),
      ...(context.facts.workerCommands.length > 0 ? ['- Keep every declared worker as its own process; do not merge it into the web process.'] : []),
      '',
    );
  }

  lines.push(
    '## Rules for every change',
    '',
    '- Preserve the existing architecture: separate workers, migrations, databases, and background services stay as they are.',
    '- Make the smallest change that resolves each item; do not refactor, rename, or reformat unrelated code.',
    '- Use the package manager and versions the repository already declares.',
    '- Never invent, commit, or print secret values; reference environment variables by name.',
    '- Never delete working code, disable security, skip tests, or suppress errors to pass a Deployz check.',
    '- Do not add AWS, DNS, TLS, load balancer, Terraform, or Kubernetes configuration; Deployz provides the infrastructure.',
    '- When the evidence cannot settle an item, stop and report the ambiguity instead of guessing.',
    '',
    '## Validation',
    '',
    'Run only the checks that apply, and report the results:',
    '',
    ...validationLines(context.facts, actionable),
    '',
    '## Completion report',
    '',
    'When finished, report for each numbered item:',
    '',
    '- The result: fixed, no change needed (with the evidence), or needs a vendor decision (with the evidence).',
    '- Every file changed, with a one-line summary per file.',
    '- Every Deployz setting the vendor must change, with its value.',
    '- The validation steps actually run and their results; do not claim success for steps not run.',
    '- Assumptions made and unresolved risks.',
  );

  return lines.join('\n');
}

// ── The AI call ─────────────────────────────────────────────────────────────

/**
 * Generate the consolidated fix-instructions document: build the plan,
 * skip the model when every item is already supported, truncate the prompt
 * to budget, call the injectable gateway, enforce the
 * total-usage budget, validate against the strict schema, then assemble the
 * deterministic document around the guidance.
 *
 * Throws on any AI failure (unconfigured gateway, network error, timeout,
 * schema violation, spend limit) — the API edge maps that to a retryable
 * generation error. Analysis and readiness state are unaffected either way.
 */
export async function generateFixInstructions(
  context: FixInstructionsContext,
  gateway: AiGateway,
  options: { abortSignal?: AbortSignal; onDropped?: ((dropped: DroppedGuidance) => void) | undefined } = {},
): Promise<string> {
  // Nothing to make concrete: every finding is already supported, so the
  // document is complete without a (paid, slow) model call.
  const plan = planRemediation(context);
  if (plan.every((item) => item.classification === 'ALREADY_SUPPORTED')) {
    return assembleFixInstructions(context, { items: [] }, plan);
  }

  const prompt = truncateToTokens(
    buildFixInstructionsAiPrompt(context, plan),
    FIX_INSTRUCTIONS_MAX_PROMPT_TOKENS,
  );

  const response = await gateway.generate(prompt, fixInstructionsAiSchema, {
    abortSignal: options.abortSignal,
    attemptTimeoutMs: FIX_INSTRUCTIONS_ATTEMPT_TIMEOUT_MS,
    label: 'fix-instructions',
    maxOutputTokens: FIX_INSTRUCTIONS_MAX_OUTPUT_TOKENS,
    reasoning: false,
  });

  const usedTokens = response.usage.promptTokens + response.usage.completionTokens;
  if (usedTokens > FIX_INSTRUCTIONS_MAX_TOTAL_TOKENS) {
    throw new SpendLimitExceededError(usedTokens, FIX_INSTRUCTIONS_MAX_TOTAL_TOKENS);
  }

  return assembleFixInstructions(context, fixInstructionsAiSchema.parse(response.object), plan, {
    onDropped: options.onDropped,
  });
}
