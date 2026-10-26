/**
 * §6-10 Redis assessment — provider-neutral, deterministic detection of
 * Redis usage in a repository, plus a compatibility verdict against
 * Deployz's managed Redis profile (single-node, standalone, non-TLS).
 *
 * Pure function over a `FileTree`: no AI, no network, no side effects.
 * Deliberately provider-neutral — never mentions AWS, ElastiCache, or
 * Valkey; those live only in `@deployz/cdk`.
 */

import type { FileTree } from './detectors.js';
import {
  collectDependencyNames,
  detectEnvVarModel,
  isProductionComposeFile,
  isRuntimeSourcePath,
  listProductionComposeFiles,
  optionalQueueMode,
  parsePackageJsons,
  siblingAppFilter,
} from './detectors.js';

// ── Types ───────────────────────────────────────────────────────────────────

export type RedisConfidence = 'high' | 'medium' | 'low';

export type RedisPurpose =
  | 'cache'
  | 'queue'
  | 'background_jobs'
  | 'sessions'
  | 'rate_limiting'
  | 'locks'
  | 'broker'
  | 'unknown';

export interface RedisCompatibility {
  supported: boolean;
  reason?: string;
}

export interface RedisRequirement {
  required: boolean;
  confidence: RedisConfidence;
  purposes: RedisPurpose[];
  evidence: string[];
  connectionEnvVars: string[];
  compatibility: RedisCompatibility;
}

export type RedisEnvBindingKind = 'url' | 'host' | 'port';

export interface RedisEnvBinding {
  name: string;
  kind: RedisEnvBindingKind;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Canonical order — also the order `connectionEnvVars` is reported in. */
const KNOWN_REDIS_ENV_VARS = [
  'REDIS_URL',
  'REDIS_URI',
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_PASSWORD',
  'CACHE_URL',
  'QUEUE_REDIS_URL',
  'CELERY_BROKER_URL',
  'CELERY_RESULT_BACKEND',
] as const;

/** Names that are unambiguous on their own — "REDIS" is literally in the name. */
const UNCONDITIONAL_ENV_VARS = new Set<string>([
  'REDIS_URL',
  'REDIS_URI',
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_PASSWORD',
  'QUEUE_REDIS_URL',
]);

/** Ambiguous names (could back any cache/broker) — only count with corroboration. */
const CONDITIONAL_ENV_VARS = new Set<string>(['CACHE_URL', 'CELERY_BROKER_URL', 'CELERY_RESULT_BACKEND']);

const ENV_BINDING_KIND: Partial<Record<string, RedisEnvBindingKind>> = {
  REDIS_URL: 'url',
  REDIS_URI: 'url',
  CACHE_URL: 'url',
  QUEUE_REDIS_URL: 'url',
  CELERY_BROKER_URL: 'url',
  CELERY_RESULT_BACKEND: 'url',
  REDIS_HOST: 'host',
  REDIS_PORT: 'port',
  // REDIS_PASSWORD intentionally has no kind — no auth in MVP (spec §21).
};

/**
 * App-specific Redis connection names (`BACKEND_CACHE_REDIS_URI`,
 * `NANGO_REDIS_URL`, `SENTRY_REDIS_HOST`): the app names its own variables, so
 * the suffix decides what the value is. A password is never one of them.
 */
const PREFIXED_REDIS_ENV_REGEX = /(?:^|_)REDIS_(URL|URI|DSN|HOST|PORT)$/;
/**
 * A prefixed name with no suffix (`PAPERLESS_REDIS`) is a connection URL,
 * unless a switch word names it a flag (`APP_USE_REDIS`, `ENABLE_REDIS`).
 */
const BARE_REDIS_ENV_REGEX = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_REDIS$/;
const REDIS_SWITCH_WORD_REGEX = /(?:^|_)(?:ENABLE|USE|WITH|HAS|DISABLE|NO|SKIP)_/;

function appRedisBindingKind(name: string): RedisEnvBinding['kind'] | undefined {
  const suffix = PREFIXED_REDIS_ENV_REGEX.exec(name)?.[1];
  if (suffix !== undefined) return suffix === 'HOST' ? 'host' : suffix === 'PORT' ? 'port' : 'url';
  return BARE_REDIS_ENV_REGEX.test(name) && !REDIS_SWITCH_WORD_REGEX.test(name) ? 'url' : undefined;
}

const DEFAULT_ENV_BINDINGS: RedisEnvBinding[] = [
  { name: 'REDIS_URL', kind: 'url' },
  { name: 'REDIS_HOST', kind: 'host' },
  { name: 'REDIS_PORT', kind: 'port' },
];

const SOURCE_FILE_REGEX = /\.(ts|js|mjs|cjs|jsx|tsx|py|rb)$/;
const ENV_SAMPLE_FILE_REGEX = /(?:^|\/)\.env\.(?:example|template|sample)$/i;
const COMPOSE_FILE_REGEX = /(?:^|\/)(?:docker-)?compose(?:\.[\w.-]+)?\.ya?ml$/i;
const REQUIREMENTS_FILE_REGEX = /(?:^|\/)requirements(?:[\w.-]*)?\.txt$/i;
const PYPROJECT_FILE_REGEX = /(?:^|\/)pyproject\.toml$/i;
const GEMFILE_REGEX = /(?:^|\/)Gemfile$/;
const GOMOD_REGEX = /(?:^|\/)go\.mod$/;
const COMPOSER_JSON_REGEX = /(?:^|\/)composer\.json$/;
const README_REGEX = /(?:^|\/)README(?:\.[\w.-]+)?$/i;
// A connection URL with a host, never a scheme that a message lists as allowed (`"must use redis:// or rediss://"`).
const REDISS_SCHEME_REGEX = /rediss:\/\/[\w$[{:@]/i;

// ── package.json helpers (workspace-aware; dependencies vs devDependencies) ──

function fieldNames(pkg: Record<string, unknown>, field: string): string[] {
  const value = pkg[field];
  if (typeof value !== 'object' || value === null) return [];
  return Object.keys(value as Record<string, unknown>);
}

/**
 * npm dependency names split into "direct" (declared in `dependencies` of
 * any workspace package.json) and "dev-only" (declared in `devDependencies`
 * somewhere but never as a direct dependency anywhere).
 */
function collectNpmDependencies(tree: FileTree): { direct: Set<string>; devOnly: Set<string> } {
  const direct = new Set<string>();
  const dev = new Set<string>();
  for (const pkg of parsePackageJsons(tree)) {
    for (const name of fieldNames(pkg, 'dependencies')) direct.add(name);
    for (const name of fieldNames(pkg, 'devDependencies')) dev.add(name);
  }
  const devOnly = new Set<string>();
  for (const name of dev) {
    if (!direct.has(name)) devOnly.add(name);
  }
  return { direct, devOnly };
}

// ── Generic helpers ─────────────────────────────────────────────────────────

function findFiles(tree: FileTree, regex: RegExp): string[] {
  return Object.keys(tree).filter((p) => regex.test(p));
}

function isSourceFile(path: string): boolean {
  return SOURCE_FILE_REGEX.test(path);
}

/** Parse simple `KEY=VALUE` / `KEY: VALUE` lines from an env-sample file. */
function parseEnvLines(content: string): Map<string, string> {
  const vars = new Map<string, string>();
  const regex = /^\s*([A-Z_][A-Z0-9_]*)\s*[=:]\s*(.*)$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const name = match[1];
    const rawValue = match[2] ?? '';
    if (!name) continue;
    const value = rawValue.trim().replace(/^['"]|['"]$/g, '');
    vars.set(name, value);
  }
  return vars;
}

function isRedisScheme(value: string): boolean {
  return /^rediss?:\/\//i.test(value.trim());
}

/**
 * Whether a Python requirements.txt / pyproject.toml file declares `pkgName`
 * as a dependency. Requires a token boundary on both sides so `redis` does
 * not falsely match inside `django-redis` or `redisearch`.
 */
function hasPythonDependency(content: string, pkgName: string): boolean {
  const escaped = pkgName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(^|[\\s"'[,])${escaped}(?=[\\s"'=<>!~;,\\]]|$)`, 'im');
  return regex.test(content);
}

/** Whether a Python manifest declares `pkgName` with an extra (`celery[redis]`). */
function hasPythonExtra(content: string, pkgName: string, extra: string): boolean {
  return new RegExp(`(^|[\\s"',])${pkgName}\\[[^\\]]*\\b${extra}\\b[^\\]]*\\]`, 'im').test(content);
}

function hasRubyGem(content: string, gemName: string): boolean {
  const escaped = gemName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`gem\\s+['"]${escaped}['"]`, 'i');
  return regex.test(content);
}

// ── Signal collection ───────────────────────────────────────────────────────
//
// Every signal is tagged with a tier. For confidence purposes:
//   - any 'very-high' or 'high' signal, on its own, is enough for `high`;
//   - 'medium' signals reach `high` only as a Redis client library plus a
//     configured connection variable; otherwise they make it `medium`;
//   - 'low' signals never affect confidence on their own;
//   - evidence that the integration is optional caps the result at `medium`.

type SignalTier = 'very-high' | 'high' | 'medium' | 'low';

/** Signal types that show a Redis client library is installed — never a requirement alone. */
const CLIENT_LIBRARY_SIGNAL_TYPES = new Set([
  'npm-redis-client',
  'python-redis-client',
  'python-django-redis',
  'ruby-redis-client',
  'go-redis-client',
  'php-redis-client',
]);

interface Signal {
  tier: SignalTier;
  type: string;
  evidence: string;
  purpose?: RedisPurpose | undefined;
}

// -- Very-high: docker-compose Redis/Valkey image ----------------------------

const COMPOSE_IMAGE_REGEX = /^\s*image:\s*['"]?([^\s'"]+)['"]?/gim;

/** All `image:` values declared in compose-style files, paired with their path. */
function collectComposeImages(tree: FileTree): { path: string; image: string }[] {
  const results: { path: string; image: string }[] = [];
  for (const path of findFiles(tree, COMPOSE_FILE_REGEX)) {
    const content = tree[path];
    if (!content) continue;
    const regex = new RegExp(COMPOSE_IMAGE_REGEX.source, COMPOSE_IMAGE_REGEX.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const image = match[1];
      if (image) results.push({ path, image });
    }
  }
  return results;
}

/**
 * Only the app's PRIMARY production Compose file shows Redis in its
 * deployment shape — and a Compose Redis service alone is supporting
 * evidence, not a requirement: Compose files start Redis next to apps that
 * run without it. A root variant (`docker-compose.sqlite-redis.yml`) shows
 * Redis is an option, so it is recorded as evidence without weight; a
 * dev/test/example Compose file is not evidence at all (Stage A COMP-011).
 */
function collectComposeSignals(tree: FileTree, signals: Signal[]): void {
  const primary = listProductionComposeFiles(tree)[0];
  for (const { path, image } of collectComposeImages(tree)) {
    if (!/redis|valkey/i.test(image) || !isProductionComposeFile(path)) continue;
    if (path === primary) {
      signals.push({
        tier: 'medium',
        type: 'compose-image',
        evidence: `docker-compose service using a Redis/Valkey image (${image}) in ${path}`,
      });
    } else {
      signals.push({
        tier: 'low',
        type: 'compose-variant-image',
        evidence: `docker-compose variant using a Redis/Valkey image (${image}) in ${path}`,
      });
    }
  }
}

// -- Very-high: source-code client initialization ----------------------------

const CLIENT_INIT_PATTERNS: { pattern: RegExp; name: string; purpose?: RedisPurpose }[] = [
  { pattern: /new\s+Redis\s*\(/, name: 'new Redis(' },
  { pattern: /Redis\.from_url\s*\(/, name: 'Redis.from_url(' },
  { pattern: /redis\.Redis\s*\(/, name: 'redis.Redis(' },
  { pattern: /Sidekiq\.configure\b/, name: 'Sidekiq.configure', purpose: 'background_jobs' },
];
const CREATE_CLIENT_REGEX = /createClient\s*\(/;
const REDIS_IMPORT_REGEX = /(?:from\s+['"]redis['"]|require\(\s*['"]redis['"]\s*\))/;

// A client built only when configuration says so — `if (env.REDIS_ENABLED) {
// client = new Redis(...) }`, `if (process.env.REDIS_URL) createClient(...)` —
// is an optional integration, not a requirement (Stage A COMP-011).
const GUARD_WINDOW_CHARS = 240;
// The guard must open a block that is still open where the client is built;
// a braceless single-statement `if` scopes only its own statement.
const REDIS_GUARD_REGEX = /if\s*\([^)]*(?:REDIS|CACHE|ENABLED)[^)]*\)\s*\{[^{}]*$/i;

function isGuardedInit(content: string, index: number): boolean {
  return REDIS_GUARD_REGEX.test(content.slice(Math.max(0, index - GUARD_WINDOW_CHARS), index));
}

// A client is a boot-time requirement only when the app configures where the
// server is: a client built from a user-supplied URL (a Redis monitor type, a
// "test this connection" feature) has no connection variable of its own.
function collectSourceClientInitSignals(tree: FileTree, signals: Signal[], configured: boolean): void {
  for (const [path, content] of Object.entries(tree)) {
    if (!isSourceFile(path) || !isRuntimeSourcePath(path)) continue;

    for (const { pattern, name, purpose } of CLIENT_INIT_PATTERNS) {
      const index = content.search(pattern);
      if (index === -1) continue;
      const guarded = isGuardedInit(content, index);
      signals.push({
        tier: guarded ? 'low' : configured ? 'very-high' : 'medium',
        type: guarded ? 'source-client-init-guarded' : 'source-client-init',
        evidence: `Redis client initialization (${name}${guarded ? ', behind a configuration guard' : ''}) in ${path}`,
        purpose,
      });
    }

    const createIndex = content.search(CREATE_CLIENT_REGEX);
    if (createIndex !== -1 && REDIS_IMPORT_REGEX.test(content)) {
      const guarded = isGuardedInit(content, createIndex);
      signals.push({
        tier: guarded ? 'low' : configured ? 'very-high' : 'medium',
        type: guarded ? 'source-client-init-guarded' : 'source-client-init',
        evidence: `Redis client initialization (createClient() with a redis import${guarded ? ', behind a configuration guard' : ''}) in ${path}`,
      });
    }
  }
}

// -- Medium: known Redis env var referenced ----------------------------------

function collectEnvVarSignals(tree: FileTree, signals: Signal[], connectionEnvVars: Set<string>): void {
  // .env.example / .env.template / .env.sample (any depth).
  for (const path of findFiles(tree, ENV_SAMPLE_FILE_REGEX)) {
    const content = tree[path];
    if (!content) continue;
    const vars = parseEnvLines(content);

    const hasOtherRedisEvidenceInFile = [...UNCONDITIONAL_ENV_VARS].some((name) => vars.has(name));

    for (const [name, value] of vars) {
      if (UNCONDITIONAL_ENV_VARS.has(name)) {
        connectionEnvVars.add(name);
        signals.push({ tier: 'medium', type: 'known-env-var', evidence: `${name} referenced in ${path}` });
      } else if (CONDITIONAL_ENV_VARS.has(name)) {
        if (isRedisScheme(value) || hasOtherRedisEvidenceInFile) {
          connectionEnvVars.add(name);
          signals.push({ tier: 'medium', type: 'known-env-var', evidence: `${name} referenced in ${path}` });
        }
      }
    }
  }

  // process.env.X in source code.
  for (const [path, content] of Object.entries(tree)) {
    if (!isSourceFile(path)) continue;
    for (const name of KNOWN_REDIS_ENV_VARS) {
      if (!new RegExp(`process\\.env\\.${name}\\b`).test(content)) continue;

      if (CONDITIONAL_ENV_VARS.has(name)) {
        const hasOtherEvidence = [...UNCONDITIONAL_ENV_VARS].some((other) =>
          new RegExp(`process\\.env\\.${other}\\b`).test(content),
        );
        if (!hasOtherEvidence) continue;
      }

      connectionEnvVars.add(name);
      signals.push({ tier: 'medium', type: 'known-env-var', evidence: `process.env.${name} referenced in ${path}` });
    }
  }
}

// -- High: npm Redis-backed job library direct dependency --------------------

const NPM_JOB_LIBRARY_PURPOSE: Record<string, RedisPurpose> = {
  bull: 'queue',
  bullmq: 'queue',
  '@nestjs/bull': 'queue',
  '@nestjs/bullmq': 'queue',
};

function collectNpmJobLibrarySignals(tree: FileTree, signals: Signal[]): void {
  const { direct } = collectNpmDependencies(tree);
  for (const [dep, purpose] of Object.entries(NPM_JOB_LIBRARY_PURPOSE)) {
    if (direct.has(dep)) {
      signals.push({
        tier: 'high',
        type: `npm-job-library:${dep}`,
        evidence: `${dep} dependency in package.json`,
        purpose,
      });
    }
  }
}

// -- High/Medium: Python (celery+broker, rq, django-redis, bare redis) -------

function collectPythonSignals(tree: FileTree, signals: Signal[], connectionEnvVars: Set<string>): void {
  const files = [...findFiles(tree, REQUIREMENTS_FILE_REGEX), ...findFiles(tree, PYPROJECT_FILE_REGEX)].filter(
    isRuntimeSourcePath,
  );

  let hasCelery = false;
  let hasCeleryRedisExtra = false;
  let hasRedisClient = false;

  for (const path of files) {
    const content = tree[path];
    if (!content) continue;

    if (hasPythonDependency(content, 'celery')) hasCelery = true;
    if (hasPythonExtra(content, 'celery', 'redis')) hasCeleryRedisExtra = true;
    if (hasPythonDependency(content, 'redis')) hasRedisClient = true;

    if (hasPythonDependency(content, 'rq')) {
      signals.push({ tier: 'high', type: 'python-rq', evidence: `rq dependency in ${path}`, purpose: 'background_jobs' });
    }
    if (hasPythonDependency(content, 'django-redis')) {
      signals.push({ tier: 'medium', type: 'python-django-redis', evidence: `django-redis dependency in ${path}`, purpose: 'cache' });
    }
  }

  // A Redis broker signal: the `celery[redis]` extra, or a redis-scheme
  // CELERY_BROKER_URL/CELERY_RESULT_BACKEND (already resolved by
  // collectEnvVarSignals into connectionEnvVars). A bare `redis` client next to
  // celery proves nothing — celery runs on RabbitMQ, SQS or a database too.
  const hasBrokerSignal =
    hasCeleryRedisExtra || connectionEnvVars.has('CELERY_BROKER_URL') || connectionEnvVars.has('CELERY_RESULT_BACKEND');

  if ((hasCelery || hasCeleryRedisExtra) && hasBrokerSignal) {
    signals.push({
      tier: 'high',
      type: 'python-celery-broker',
      evidence: 'celery with a Redis broker/result-backend signal',
      purpose: 'broker',
    });
  }

  if (hasRedisClient) {
    signals.push({ tier: 'medium', type: 'python-redis-client', evidence: `redis dependency (Python) in ${files.join(', ')}` });
  }
}

// -- High: Ruby sidekiq in Gemfile; Medium: bare redis gem -------------------

function collectRubySignals(tree: FileTree, signals: Signal[]): void {
  for (const path of findFiles(tree, GEMFILE_REGEX)) {
    const content = tree[path];
    if (!content) continue;

    if (hasRubyGem(content, 'sidekiq')) {
      signals.push({ tier: 'high', type: 'ruby-sidekiq', evidence: `sidekiq gem in ${path}`, purpose: 'background_jobs' });
    }
    if (hasRubyGem(content, 'redis')) {
      signals.push({ tier: 'medium', type: 'ruby-redis-client', evidence: `redis gem in ${path}` });
    }
  }
}

// -- Medium: Go go-redis in go.mod -------------------------------------------

const GO_REDIS_IMPORTS = ['github.com/redis/go-redis', 'github.com/go-redis/redis'];

function collectGoSignals(tree: FileTree, signals: Signal[]): void {
  for (const path of findFiles(tree, GOMOD_REGEX)) {
    const content = tree[path];
    if (!content) continue;
    for (const imp of GO_REDIS_IMPORTS) {
      if (content.includes(imp)) {
        signals.push({ tier: 'medium', type: 'go-redis-client', evidence: `${imp} in ${path}` });
        break;
      }
    }
  }
}

// -- Medium: PHP predis/predis in composer.json require ----------------------

function collectPhpSignals(tree: FileTree, signals: Signal[]): void {
  for (const path of findFiles(tree, COMPOSER_JSON_REGEX)) {
    const content = tree[path];
    if (!content) continue;
    try {
      const json = JSON.parse(content) as Record<string, unknown>;
      const require = json['require'];
      if (typeof require === 'object' && require !== null && 'predis/predis' in (require as Record<string, unknown>)) {
        signals.push({ tier: 'medium', type: 'php-redis-client', evidence: `predis/predis dependency in ${path}` });
      }
    } catch {
      // A malformed composer.json is "no manifest" — never a failed analysis.
    }
  }
}

// -- Medium: npm bare Redis client dependency; Low: devDependencies-only -----

/**
 * `connect-redis` is a Redis client too (used for Express/Connect session
 * stores) — it belongs in the same "direct Redis client dependency" bucket
 * as `redis`/`ioredis`/`@redis/client`, just with a `sessions` purpose
 * instead of no purpose.
 */
const NPM_CLIENT_DEPS: Record<string, RedisPurpose | undefined> = {
  redis: undefined,
  ioredis: undefined,
  '@redis/client': undefined,
  'connect-redis': 'sessions',
};

function collectNpmClientSignals(tree: FileTree, signals: Signal[]): void {
  const { direct, devOnly } = collectNpmDependencies(tree);

  let matchedDirect = false;
  for (const [dep, purpose] of Object.entries(NPM_CLIENT_DEPS)) {
    if (direct.has(dep)) {
      matchedDirect = true;
      signals.push({ tier: 'medium', type: 'npm-redis-client', evidence: `${dep} dependency in package.json`, purpose });
    }
  }
  if (matchedDirect) return;

  for (const dep of Object.keys(NPM_CLIENT_DEPS)) {
    if (devOnly.has(dep)) {
      signals.push({ tier: 'low', type: 'npm-redis-client-dev', evidence: `${dep} present only in devDependencies` });
      break;
    }
  }
}

// -- Low: README mention ------------------------------------------------------

function collectReadmeSignals(tree: FileTree, signals: Signal[]): void {
  for (const path of findFiles(tree, README_REGEX)) {
    const content = tree[path];
    if (content && /\bredis\b/i.test(content)) {
      signals.push({ tier: 'low', type: 'readme-mention', evidence: `Redis mentioned in ${path}` });
      break;
    }
  }
}

// ── Optional-integration evidence ───────────────────────────────────────────
//
// A Redis client, a queue library or a connection variable proves the app CAN
// use Redis, not that it needs it: most apps ship Redis as one selectable
// backend and run without it by default. Each rule below is evidence that
// configuration switches Redis on, so a managed Redis would sit unused.

// Redis connection variables only: a tuning knob such as REDIS_KEY_PREFIX or
// REDIS_PASSWORD says nothing about whether a server must exist. Upstash's
// REST client is an HTTP service, not the Redis protocol Deployz hosts.
const CONNECTION_ENV_REGEX = /(?:^|_)REDIS(?:_[A-Z0-9]+)*_(?:URL|URI|DSN|HOSTS?|HOSTNAME|PORT)$|[A-Z0-9]+_REDIS$/;
const NOT_CONNECTION_ENV_REGEX = /UPSTASH|(?:^|_)REST(?:_|$)/;
const REDIS_NAME_REGEX = /\b[A-Z0-9_]*REDIS[A-Z0-9_]*\b/g;
const OPTIONAL_NOTE_REGEX = /\boptional(?:ly)?\b|\bnot required\b|\brequired only\b|\bonly required\b/i;
const REQUIRED_NOTE_REGEX = /\brequired\b/i;

// The app's own switch for the Redis-backed feature: `USE_REDIS`,
// `REDIS_ENABLED`, `USE_CELERY`. A switch for tracing, metrics or logging is not one.
const REDIS_SWITCH_REGEX =
  /\b(?:[A-Z0-9]+_)*(?:USE|ENABLED?)_(?:[A-Z0-9]+_)*(?:REDIS|CELERY|SIDEKIQ|BULLMQ?)\b|\b(?:[A-Z0-9]+_)*(?:REDIS|CELERY|SIDEKIQ|BULLMQ?)_ENABLED?\b/g;
const NOT_INTEGRATION_SWITCH_REGEX = /OTEL|INSTRUMENT|TELEMETRY|SENTRY|TRAC|LOG|DEBUG|METRIC|MONITOR|WATCH/;
const TRUTHY_VALUE_REGEX = /^(?:true|1|yes|on)$/i;

// A backend selector (`CACHE_DRIVER=file`, `QUEUE_CONNECTION=sync`,
// `JOBS_PROVIDER=local`) names the backend the app starts with.
const BACKEND_SELECTOR_REGEX =
  /^(?:[A-Z0-9]+_)*(?:CACHE|QUEUE|SESSION|JOBS?|BROKER)(?:_[A-Z0-9]+)*_(?:DRIVER|STORE|CONNECTION|PROVIDER|BACKEND|TYPE|ADAPTER)$/;

// An image that installs its own Redis server runs it next to the app.
const DOCKERFILE_REGEX = /(?:^|\/)(?:dockerfile(?:[.-][\w.-]+)?|[\w.-]+\.dockerfile)$/i;
const EMBEDDED_REDIS_INSTALL_REGEX =
  /\b(?:apt-get|apt|apk|yum|dnf|microdnf)\b[^\n]*\binstall\b[^\n]*\b(?:redis(?:-server)?|valkey)(?![\w-])/i;
// Boot code that fills in the connection when none is configured
// (`ENV['REDIS_URL'] = …` after it starts a bundled server).
const CONNECTION_DEFAULT_REGEX =
  /(?:ENV\[['"]([A-Z0-9_]*REDIS[A-Z0-9_]*)['"]\]|process\.env\.([A-Z0-9_]*REDIS[A-Z0-9_]*))\s*(?:\|\||\?\?)?=(?![=>])/;

function isConnectionEnvVar(name: string): boolean {
  return CONNECTION_ENV_REGEX.test(name) && !NOT_CONNECTION_ENV_REGEX.test(name);
}

interface EnvDeclaration {
  name: string;
  value: string;
  commented: boolean;
  /** A comment directly above (or after) the line calls the variable optional. */
  optional: boolean;
  /** A comment directly above the line says the variable is required. */
  required: boolean;
}

/** Declarations of an env sample, each with the comment block that documents it. */
function parseEnvDeclarations(content: string): EnvDeclaration[] {
  const declarations: EnvDeclaration[] = [];
  let note = '';
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    const match = /^(#\s*)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) {
      const rest = match[3] ?? '';
      const optional = OPTIONAL_NOTE_REGEX.test(`${note} ${/\s#\s*(.*)$/.exec(rest)?.[1] ?? ''}`);
      declarations.push({
        name: match[2] ?? '',
        value: rest.replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, ''),
        commented: Boolean(match[1]),
        optional,
        required: !optional && REQUIRED_NOTE_REGEX.test(note),
      });
      note = '';
    } else if (line.startsWith('#')) {
      note += ` ${line}`;
    } else {
      note = '';
    }
  }
  return declarations;
}

/** The comment lines directly above a source line. */
function commentBlockAbove(content: string, lineStart: number): string {
  const lines = content.slice(Math.max(0, lineStart - 600), lineStart).split('\n');
  lines.pop();
  const block: string[] = [];
  for (let i = lines.length - 1; i >= 0 && /^\s*(?:\/\/|\/\*|\*|#)/.test(lines[i] ?? ''); i--) block.push(lines[i] ?? '');
  return block.join(' ');
}

/** Whether the line uses the variable only after testing that it is set. */
function isPresenceGuarded(line: string, name: string): boolean {
  const operand = String.raw`[\w.$\[\]'"]*`;
  return new RegExp(
    String.raw`\bif\b(?![^\n]*\bnot\b)[^\n!]*\b${name}\b|(?:!!\s*|Boolean\(\s*|&&\s*)${operand}\b${name}\b|\b${name}['"\])]*\s*(?:&&|\?(?![?.])|\.(?:present|blank|nil|empty)\?)`,
  ).test(line);
}

/** Whether the line gives the variable a fallback value. */
function hasFallbackValue(line: string, name: string): boolean {
  return new RegExp(
    String.raw`\b${name}\b[^\n]*?(?:\|\||\?\?)\s*['"\d]|\b${name}\b['"]?\s*,\s*(?:default\s*=\s*)?['"\d]|\b${name}\b[^\n]*\.default\(`,
  ).test(line);
}

type ConnectionStatus = Map<string, 'set' | 'optional'>;

interface ConnectionVars {
  /** `set`: the app expects a connection. `optional`: it works without one. */
  status: ConnectionStatus;
  /** The same, without counting a type that merely declares the variable optional. */
  untypedStatus: ConnectionStatus;
  /** An env sample comment says a connection variable is required. */
  documentedRequired: boolean;
}

/**
 * The Redis connection variables the repository configures. Set: an env
 * sample sets it, the source gives it a fallback value, or the source reads
 * it plainly. Optional: a sample comments it out or calls it optional, the
 * source documents it as optional, or a read first tests it is set — unless a
 * sample or a fallback shows the app expects a connection anyway. A type that
 * merely declares it optional (`REDIS_URL?: string`, `.optional()`) is weaker
 * evidence: such a schema often leaves validation to the code that connects,
 * so `untypedStatus` leaves it out.
 */
function collectConnectionVars(tree: FileTree): ConnectionVars {
  const sampleSet = new Set<string>();
  const sampleOptional = new Set<string>();
  const source = new Map<string, { guarded: number; fallback: number; noted: number; typed: number }>();
  let documentedRequired = false;

  for (const path of findFiles(tree, ENV_SAMPLE_FILE_REGEX)) {
    for (const declaration of parseEnvDeclarations(tree[path] ?? '')) {
      if (!isConnectionEnvVar(declaration.name)) continue;
      if (declaration.commented || declaration.optional) sampleOptional.add(declaration.name);
      else if (declaration.value !== '') sampleSet.add(declaration.name);
      if (declaration.required && !declaration.commented) documentedRequired = true;
    }
  }

  for (const [path, content] of Object.entries(tree)) {
    if (!isSourceFile(path) || !isRuntimeSourcePath(path)) continue;
    for (const match of content.matchAll(REDIS_NAME_REGEX)) {
      const name = match[0];
      if (!isConnectionEnvVar(name)) continue;
      const index = match.index ?? 0;
      const lineStart = content.lastIndexOf('\n', index) + 1;
      const lineEnd = content.indexOf('\n', index);
      const line = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      const entry = source.get(name) ?? { guarded: 0, fallback: 0, noted: 0, typed: 0 };
      if (isPresenceGuarded(line, name)) entry.guarded += 1;
      if (hasFallbackValue(line, name)) entry.fallback += 1;
      if (OPTIONAL_NOTE_REGEX.test(`${commentBlockAbove(content, lineStart)} ${/(?:\/\/|#|\/\*).*$/.exec(line)?.[0] ?? ''}`)) {
        entry.noted += 1;
      }
      if (new RegExp(`\\b${name}\\s*\\?\\s*:|\\b${name}\\b[^\\n]*\\.(?:optional|nullish)\\(|\\b${name}\\b[^\\n]*\\bOptional\\[`).test(line)) {
        entry.typed += 1;
      }
      source.set(name, entry);
    }
  }

  const resolve = (typedCounts: boolean): ConnectionStatus => {
    const status: ConnectionStatus = new Map();
    for (const name of new Set([...sampleSet, ...sampleOptional, ...source.keys()])) {
      // A port names no server: apps default it to 6379 whether or not they need one.
      if (name.endsWith('_PORT')) continue;
      const entry = source.get(name);
      if (sampleSet.has(name) || (entry && entry.fallback > 0)) status.set(name, 'set');
      else if (sampleOptional.has(name) || (entry && (entry.noted > 0 || entry.guarded > 0 || (typedCounts && entry.typed > 0)))) {
        status.set(name, 'optional');
      } else if (entry) status.set(name, 'set');
    }
    return status;
  };
  return { status: resolve(true), untypedStatus: resolve(false), documentedRequired };
}

/** Why the repository's Redis is optional, or null when nothing says so. */
function findOptionalReason(tree: FileTree, status: ConnectionStatus, documentedRequired: boolean): string | null {
  // A sample that says Redis is required settles it, whatever else is selectable.
  if (documentedRequired) return null;

  const samples = findFiles(tree, ENV_SAMPLE_FILE_REGEX).flatMap((path) =>
    parseEnvDeclarations(tree[path] ?? '').map((declaration) => ({ ...declaration, path })),
  );
  const switchedOn = new Set(samples.filter((d) => TRUTHY_VALUE_REGEX.test(d.value) && !d.commented).map((d) => d.name));
  const composePaths = Object.keys(tree).filter((path) => COMPOSE_FILE_REGEX.test(path) && isProductionComposeFile(path));
  for (const path of [...findFiles(tree, ENV_SAMPLE_FILE_REGEX), ...composePaths, ...Object.keys(tree).filter(isSourceFile)]) {
    if (!isRuntimeSourcePath(path)) continue;
    for (const [switchName] of (tree[path] ?? '').matchAll(REDIS_SWITCH_REGEX)) {
      if (!switchedOn.has(switchName) && !NOT_INTEGRATION_SWITCH_REGEX.test(switchName)) {
        return `${switchName} switches Redis on in ${path}`;
      }
    }
  }

  const queueMode = optionalQueueMode(tree);
  if (queueMode) return `${queueMode.name} defaults to ${queueMode.value} in ${queueMode.path}; the Redis queue runs only in queue mode`;

  const selectors = samples.filter((d) => !d.commented && d.value !== '' && BACKEND_SELECTOR_REGEX.test(d.name));
  const selectedOther = selectors.find((d) => !/redis/i.test(d.value));
  if (selectedOther && !selectors.some((d) => /redis/i.test(d.value))) {
    return `${selectedOther.name}=${selectedOther.value} in ${selectedOther.path} is not Redis by default`;
  }

  for (const [path, content] of Object.entries(tree)) {
    if (!isRuntimeSourcePath(path)) continue;
    if (DOCKERFILE_REGEX.test(path) && EMBEDDED_REDIS_INSTALL_REGEX.test(content.replace(/\\\r?\n/g, ' '))) {
      return `the image in ${path} installs its own Redis server`;
    }
    const assigned = isSourceFile(path) ? CONNECTION_DEFAULT_REGEX.exec(content) : null;
    const assignedName = assigned?.[1] ?? assigned?.[2];
    if (assignedName && isConnectionEnvVar(assignedName)) return `${path} sets ${assignedName} itself when none is configured`;
  }

  if (status.size > 0 && [...status.values()].every((value) => value === 'optional')) {
    return `${[...status.keys()].sort().join(', ')} ${status.size === 1 ? 'is' : 'are'} optional`;
  }
  return null;
}

// ── Compatibility ────────────────────────────────────────────────────────────

const STACK_MODULE_DEPS = ['@redis/json', '@redis/search', 'redis-om'];
const STACK_MODULE_REASON = 'Requires Redis Stack modules (RedisJSON/RediSearch), which Deployz does not support.';
const CLUSTER_REASON = 'Requires Redis Cluster mode, which Deployz does not support.';
const TLS_REASON = "Requires TLS (rediss://) connections, which Deployz's managed Redis does not provide.";

const CLUSTER_PATTERNS = [
  /new\s+Redis\.Cluster\s*\(/,
  /createCluster\s*\(/,
  /RedisCluster\s*\(/,
  /CLUSTER\s+SLOTS/i,
];

/** True when the pattern matches on a line that starts at column 0 (module top level). */
function isTopLevelMatch(content: string, pattern: RegExp): boolean {
  const index = content.search(pattern);
  if (index === -1) return false;
  const lineStart = content.lastIndexOf('\n', index) + 1;
  return !/^\s/.test(content.slice(lineStart, index + 1));
}

function evaluateCompatibility(tree: FileTree): RedisCompatibility {
  // 1. Redis Stack modules — npm deps (dependencies + devDependencies).
  const npmDeps = collectDependencyNames(tree);
  if (STACK_MODULE_DEPS.some((dep) => npmDeps.includes(dep))) {
    return { supported: false, reason: STACK_MODULE_REASON };
  }

  // 1b. Redis Stack modules — Python (redisearch / rejson).
  const pythonFiles = [...findFiles(tree, REQUIREMENTS_FILE_REGEX), ...findFiles(tree, PYPROJECT_FILE_REGEX)];
  for (const path of pythonFiles) {
    const content = tree[path];
    if (!content) continue;
    if (hasPythonDependency(content, 'redisearch') || hasPythonDependency(content, 'rejson')) {
      return { supported: false, reason: STACK_MODULE_REASON };
    }
  }

  // 2. compose image containing `redis-stack`.
  for (const { image } of collectComposeImages(tree)) {
    if (/redis-stack/i.test(image)) {
      return { supported: false, reason: STACK_MODULE_REASON };
    }
  }

  // 3. Cluster usage — source files only, like every other text-pattern signal in
  // this module. Scanning every file (README/docs included) would flip a fully
  // compatible repo to unsupported over prose that merely mentions `createCluster()`.
  // Only an UNCONDITIONAL construction counts — one at the top level of a
  // module. A cluster client built inside a function or method is an option
  // the app offers next to its standalone client (Stage A COMP-019).
  for (const path of Object.keys(tree).filter(isSourceFile)) {
    const content = tree[path];
    if (content && CLUSTER_PATTERNS.some((pattern) => isTopLevelMatch(content, pattern))) {
      return { supported: false, reason: CLUSTER_REASON };
    }
  }

  // 4. `rediss://` anywhere in env samples or source.
  const candidatePaths = [...findFiles(tree, ENV_SAMPLE_FILE_REGEX), ...Object.keys(tree).filter(isSourceFile)];
  for (const path of candidatePaths) {
    // A comment in an env sample documents a format; it is not a connection.
    const content = ENV_SAMPLE_FILE_REGEX.test(path) ? tree[path]?.replace(/(?:^|\s)#.*$/gm, '') : tree[path];
    if (content && REDISS_SCHEME_REGEX.test(content)) {
      return { supported: false, reason: TLS_REASON };
    }
  }

  return { supported: true };
}

// ── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Assess a repository's Redis requirement: whether it needs Redis, how
 * confident that detection is, what it's used for, and whether the way it's
 * used is compatible with Deployz's managed Redis profile.
 *
 * Pure function: same input → same output every time. No AI, no network.
 * Evidence in a sibling app that the image does not hold is not this app's.
 */
export function assessRedis(repository: FileTree): RedisRequirement {
  const isSiblingApp = siblingAppFilter(repository);
  const tree: FileTree = Object.fromEntries(Object.entries(repository).filter(([path]) => !isSiblingApp(path)));
  const signals: Signal[] = [];
  const connectionEnvVars = new Set<string>();

  collectComposeSignals(tree, signals);
  const composeRedis = signals.some((s) => s.type === 'compose-image');
  const { status, untypedStatus, documentedRequired } = collectConnectionVars(tree);
  // An app whose own Compose stack runs Redis is not made optional by a type
  // that merely declares its connection variable optional.
  const strongStatus = composeRedis ? untypedStatus : status;
  const hasConfiguredConnection = (vars: ConnectionStatus): boolean => [...vars.values()].includes('set');
  collectSourceClientInitSignals(tree, signals, hasConfiguredConnection(strongStatus));
  collectEnvVarSignals(tree, signals, connectionEnvVars);
  collectNpmJobLibrarySignals(tree, signals);
  collectPythonSignals(tree, signals, connectionEnvVars);
  collectRubySignals(tree, signals);
  collectGoSignals(tree, signals);
  collectPhpSignals(tree, signals);
  collectNpmClientSignals(tree, signals);
  collectReadmeSignals(tree, signals);

  // A queue library or an unconditional client is a requirement; a client
  // library needs a configured connection next to it. A Compose Redis service
  // alone or a connection variable alone is not one: both ship in apps that
  // run without Redis.
  const hasStrongSignal = signals.some((s) => s.tier === 'very-high' || s.tier === 'high');
  const hasClientLibrary = signals.some((s) => CLIENT_LIBRARY_SIGNAL_TYPES.has(s.type));
  const strongOptionalReason = findOptionalReason(tree, strongStatus, documentedRequired);
  const optionalReason = composeRedis ? findOptionalReason(tree, status, documentedRequired) : strongOptionalReason;

  let confidence: RedisConfidence;
  if (
    (hasStrongSignal && !strongOptionalReason) ||
    (hasClientLibrary && hasConfiguredConnection(status) && !optionalReason)
  ) {
    confidence = 'high';
  } else if (signals.some((s) => s.tier !== 'low')) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  const purposes = [...new Set(signals.map((s) => s.purpose).filter((p): p is RedisPurpose => Boolean(p)))];
  if (purposes.length === 0) purposes.push('unknown');

  const evidence = [...new Set(signals.map((s) => s.evidence))];
  const reason = (hasStrongSignal ? strongOptionalReason : optionalReason) ?? optionalReason;
  if (reason && confidence !== 'high') evidence.push(`Redis looks optional: ${reason}`);
  const knownConnectionEnvVars = KNOWN_REDIS_ENV_VARS.filter((v) => connectionEnvVars.has(v));
  // Names the app reads (or its env sample documents) outside the known list.
  const appConnectionEnvVars = detectEnvVarModel(tree)
    .map((variable) => variable.key)
    .filter((key) => appRedisBindingKind(key) !== undefined && !(KNOWN_REDIS_ENV_VARS as readonly string[]).includes(key))
    .sort();
  const orderedConnectionEnvVars = [...knownConnectionEnvVars, ...appConnectionEnvVars];

  const compatibility = evaluateCompatibility(tree);
  const required = confidence === 'high' && compatibility.supported;

  return {
    required,
    confidence,
    purposes,
    evidence,
    connectionEnvVars: orderedConnectionEnvVars,
    compatibility,
  };
}

// ── Env var → binding resolution ────────────────────────────────────────────

/**
 * Resolve detected `connectionEnvVars` into the injectable bindings a
 * consumer (e.g. `@deployz/cdk`) should set on the container: which env var
 * names carry a full connection URL vs. just host/port. `REDIS_PASSWORD` is
 * never resolved — no auth in the MVP (spec §21).
 *
 * Empty or unrecognized input falls back to the three defaults Deployz
 * always injects: `REDIS_URL`, `REDIS_HOST`, `REDIS_PORT`.
 */
export function resolveRedisEnvBindings(connectionEnvVars: string[]): RedisEnvBinding[] {
  const present = new Set(connectionEnvVars);
  const bindings: RedisEnvBinding[] = [];

  for (const name of KNOWN_REDIS_ENV_VARS) {
    if (!present.has(name)) continue;
    const kind = ENV_BINDING_KIND[name];
    if (!kind) continue;
    bindings.push({ name, kind });
  }
  for (const name of [...present].sort()) {
    const kind = appRedisBindingKind(name);
    if (kind === undefined || (KNOWN_REDIS_ENV_VARS as readonly string[]).includes(name)) continue;
    bindings.push({ name, kind });
  }

  return bindings.length > 0 ? bindings : DEFAULT_ENV_BINDINGS;
}
