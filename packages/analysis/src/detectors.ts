/**
 * §18 detectors — pure deterministic functions that examine a file tree
 * and return findings about the repository's structure and dependencies.
 *
 * Each detector is a standalone pure function: `(tree: FileTree) => DetectorFinding`.
 * No AI, no network, no side effects.
 */

import { posix as posixPath } from 'node:path';

import type { ManifestEnvVariable } from '@deployz/contracts';

import { s3Semantic } from './bindings.js';

// ── Types ───────────────────────────────────────────────────────────────────

/** A file tree: path → file contents (strings only; directories are implicit via path keys). */
export interface FileTree {
  [path: string]: string;
}

/** Result from a single detector. */
export interface DetectorFinding {
  /** The detector name (e.g. "dockerfile", "framework"). */
  detector: string;
  /** Whether the pattern was detected. */
  detected: boolean;
  /** The detected value(s) — a string, array of strings, or undefined if not detected. */
  value?: string | string[] | undefined;
  /** Additional context (e.g. "detected via HEALTHCHECK instruction"). */
  details?: string | undefined;
  /**
   * A single normalized URL path, when the detector's evidence names one.
   * Only `health-endpoint` sets this today (the literal path a health check
   * targets, e.g. "/api/health") — every other detector leaves it undefined.
   */
  path?: string | undefined;
  /**
   * Stage B phase 5 — how the health endpoint is known, set only by the
   * `health-endpoint` detector: `explicit` (a declared route or HEALTHCHECK
   * URL names the path), `root` (the app's own HEALTHCHECK probes `/`), or
   * `vendor_required` (no evidence at all — Deployz must not guess).
   */
  mode?: 'explicit' | 'root' | 'vendor_required' | undefined;
  /**
   * Stage B phase 7 (COMP-030) — where a `port` finding came from:
   * `dockerfile-expose` | `compose` | `env` | `runtime-literal` |
   * `framework-default`. Set only by the `port` detector.
   */
  portSource?: string | undefined;
  /** Stage B phase 7 — how confident the port detection is. */
  portConfidence?: 'high' | 'medium' | 'low' | undefined;
  /**
   * Where the winning value was read from, for the detectors whose value
   * the canonical application analysis reports as a fact (framework, port,
   * health endpoint, start/build/migration commands, runtime, bind address).
   */
  source?: DetectorSource | undefined;
}

/** The evidence families a detector value can come from. */
export type DetectorSource = 'dockerfile' | 'package-manifest' | 'compose' | 'env-file' | 'procfile' | 'source';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Matches a package.json at the repository root or in any workspace package. */
const PACKAGE_JSON_REGEX = /(?:^|\/)package\.json$/;

/**
 * Parse every package.json in the tree, alongside the path it came from,
 * repository root first. Shared by `parsePackageJsons` (path discarded) and
 * `collectScriptsWithDir` (path kept, as the originating package's directory).
 */
function parsePackageJsonsWithPath(tree: FileTree): { path: string; pkg: Record<string, unknown> }[] {
  const paths = Object.keys(tree)
    .filter((path) => PACKAGE_JSON_REGEX.test(path))
    .sort((a, b) => a.split('/').length - b.split('/').length);

  const parsed: { path: string; pkg: Record<string, unknown> }[] = [];
  for (const path of paths) {
    const raw = tree[path];
    if (!raw) continue;
    try {
      const value = JSON.parse(raw);
      if (typeof value === 'object' && value !== null) {
        parsed.push({ path, pkg: value as Record<string, unknown> });
      }
    } catch {
      // A malformed manifest is "no manifest" — never a failed analysis.
    }
  }
  return parsed;
}

/**
 * Parse every package.json in the tree, repository root first.
 *
 * A monorepo keeps its dependencies and scripts in the workspace packages,
 * not in the root manifest — reading only the root manifest makes a
 * workspace repository look dependency-free, so every detector that asks
 * about dependencies or scripts asks about ALL of them.
 */
export function parsePackageJsons(tree: FileTree): Record<string, unknown>[] {
  return parsePackageJsonsWithPath(tree).map(({ pkg }) => pkg);
}

/** Get all keys from the package.json "scripts" field, or empty object. */
function getScripts(pkg: Record<string, unknown> | null): Record<string, string> {
  if (!pkg) return {};
  const scripts = pkg['scripts'];
  if (typeof scripts !== 'object' || scripts === null) return {};
  return scripts as Record<string, string>;
}

/** Get all dependency names from dependencies + devDependencies combined. */
function getDependencyNames(pkg: Record<string, unknown> | null): string[] {
  if (!pkg) return [];
  const names = new Set<string>();
  for (const field of ['dependencies', 'devDependencies']) {
    const deps = pkg[field];
    if (typeof deps === 'object' && deps !== null) {
      for (const name of Object.keys(deps as Record<string, unknown>)) {
        names.add(name);
      }
    }
  }
  return [...names];
}

/**
 * Every dependency declared anywhere in the repository — the root manifest
 * plus every workspace package manifest. Shared with the §10 rejection
 * checks so both sides of the verdict read the same dependency set.
 */
export function collectDependencyNames(tree: FileTree): string[] {
  const names = new Set<string>();
  for (const pkg of parsePackageJsons(tree)) {
    for (const name of getDependencyNames(pkg)) {
      names.add(name);
    }
  }
  return [...names];
}

/**
 * Every script entry declared anywhere in the repository — the root
 * manifest plus every workspace package manifest, same reasoning as
 * `collectDependencyNames`. Shared with the §35 contract-field backfill
 * (apps/api/src/analysis.ts) so migration/worker command resolution sees
 * workspace-package scripts too, not just the root manifest's.
 */
export function collectScripts(tree: FileTree): [string, string][] {
  const entries: [string, string][] = [];
  for (const pkg of parsePackageJsons(tree)) {
    for (const [name, command] of Object.entries(getScripts(pkg))) {
      if (typeof command === 'string') {
        entries.push([name, command]);
      }
    }
  }
  return entries;
}

/**
 * Same data as `collectScripts`, plus the directory of the package.json each
 * script came from (posix path relative to the repo root, "" for the root
 * manifest itself). Needed by the §35 migration-command resolver
 * (apps/api/src/analysis.ts) to locate the schema.prisma belonging to the
 * same workspace package as the matched script, not just anywhere in the tree.
 */
export function collectScriptsWithDir(tree: FileTree): [string, string, string][] {
  const entries: [string, string, string][] = [];
  for (const { path, pkg } of parsePackageJsonsWithPath(tree)) {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    for (const [name, command] of Object.entries(getScripts(pkg))) {
      if (typeof command === 'string') {
        entries.push([name, command, dir]);
      }
    }
  }
  return entries;
}

/** Find all files whose path matches a regex and return their paths. */
function findFiles(tree: FileTree, pathRegex: RegExp): string[] {
  return Object.keys(tree).filter((p) => pathRegex.test(p));
}

/** Get content of the first file matching a path regex, or null. */
function findFileContent(tree: FileTree, pathRegex: RegExp): string | null {
  const match = Object.keys(tree).find((p) => pathRegex.test(p));
  if (!match) return null;
  return tree[match] ?? null;
}

// Paths that never run inside the deployed container: tests and fixtures,
// build/release scripts, documentation generators, tool configuration. A
// disk write or an environment read there says nothing about the app at
// runtime (Stage A COMP-003, COMP-016). .NET names its test projects
// `App.Tests` / `App.UnitTests`; Rust keeps benchmarks in `benches/`.
const NON_RUNTIME_SEGMENT_REGEX =
  /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|(?:[\w.-]*[-_])?tests?|testdata|specs?|(?:[\w.-]*[-_])?e2e|cypress|evaluations?|fixtures?|stories|scripts?|tools?|bin|docs?|extra|\.?examples?|\.?storybook|playwright|benchmarks?|benches|(?:[\w-]+\.)+(?:\w*tests?|benchmarks?)(?:\.[\w.-]+)?|\.github|\.husky|\.devcontainer|\.vscode)(?:\/|$)/i;
const NON_RUNTIME_FILE_REGEX =
  /(?:\.(?:test|spec|stories|e2e|cy)\.[cm]?[jt]sx?$|(?:^|\/)(?:[\w.-]+\.config\.[cm]?[jt]s|\.(?:eslintrc|prettierrc|babelrc)(?:\.[cm]?js)?|conftest\.py|test_[\w-]+\.py|[\w-]+_test\.(?:py|go|rb))$)/i;

const NEXT_CONFIG_FILE_REGEX = /(?:^|\/)next\.config\.[cm]?[jt]s$/i;

// A typed config class (`configs/database.config.ts`) is app code, unlike a tool's `jest.config.js`.
const TYPED_CONFIG_FILE_REGEX = /(?:^|\/)configs\/[\w.-]+\.config\.[cm]?[jt]s$/i;

/** True for source the deployed container actually runs. */
export function isRuntimeSourcePath(path: string): boolean {
  return !NON_RUNTIME_SEGMENT_REGEX.test(path) && (!NON_RUNTIME_FILE_REGEX.test(path) || TYPED_CONFIG_FILE_REGEX.test(path));
}

// Compose files that describe dev/test/example tooling rather than the app's
// own production deployment shape — by path segment or by filename flavour.
const NON_PRODUCTION_COMPOSE_SEGMENT_REGEX =
  /(?:^|\/)(?:development|dev|test|testing|tests|[\w.-]+[._-]tests?|suites?|e2e|ci|[\w.-]*examples?|[\w.-]*samples?|demos?|local|\.devcontainer|playwright|benchmarks?|devenv|docs?|contrib|build|debug)(?:\/|$)/i;
const NON_PRODUCTION_COMPOSE_FILENAME_REGEX =
  /(?:docker-compose|compose)[.-](?:dev|development|test|testing|override|local|example|sample|ci|e2e|debug|demo|build)(?:[.-][\w.-]+)?\.ya?ml$/i;
const COMPOSE_FILE_REGEX = /(?:^|\/)(?:docker-compose|compose)(?:\.(?:prod|production))?\.ya?ml$/i;
const PRODUCTION_COMPOSE_FILE_REGEX = /(?:docker-compose|compose)\.(?:prod|production)\.ya?ml$/i;
// A volume that mounts the repository checkout (`.:/app`, `./../:/src`)
// belongs to a development stack: the image is not what runs.
const SOURCE_MOUNT_REGEX = /^\s*-\s*["']?(?:\.{1,2}|(?:\.\.?\/)+\.{0,2}|\$\{?PWD\}?)\/?:/m;

export function isProductionComposeFile(path: string): boolean {
  return !NON_PRODUCTION_COMPOSE_SEGMENT_REGEX.test(path) && !NON_PRODUCTION_COMPOSE_FILENAME_REGEX.test(path);
}

/**
 * Every Compose file that describes the app's own production shape, the
 * repository-root file first. Variant files at the root
 * (`docker-compose.postgres.yml`) are not matched — they are alternatives,
 * not the default shape — except through `listProductionComposeVariants`.
 */
export function listProductionComposeFiles(tree: FileTree): string[] {
  return Object.keys(tree)
    .filter((path) => COMPOSE_FILE_REGEX.test(path) && isProductionComposeFile(path) && !SOURCE_MOUNT_REGEX.test(tree[path] ?? ''))
    .sort(
      (a, b) =>
        a.split('/').length - b.split('/').length ||
        Number(PRODUCTION_COMPOSE_FILE_REGEX.test(b)) - Number(PRODUCTION_COMPOSE_FILE_REGEX.test(a)) ||
        a.localeCompare(b),
    );
}

/**
 * Compose services of the production Compose file: name, image, whether the
 * service only starts under a profile, and its volume mounts. Null when no
 * compose file describes the app's own production deployment — dev/test/
 * example compose files (e.g. `docker/development/compose.yml`, a mail
 * sandbox or PDF renderer for local tooling) are not evidence of the app's
 * architecture (`isProductionComposeFile`). Prefers a repository-root file.
 * A service another service waits on with `service_completed_successfully`
 * is a one-shot job (a migration runner), not an application container
 * (Stage A COMP-009).
 */
export interface ComposeService {
  name: string;
  image: string | null;
  /** `profiles:` set — the service does not start with the default stack (Stage A COMP-026). */
  optional: boolean;
  volumes: string[];
  /** `ports:` list entries (`host:container`). */
  ports: string[];
  /** The service's `command:` override, flattened to one line (Stage A COMP-015). */
  command: string | null;
  /** The `build:` context, Dockerfile, target and args, flattened and sorted; null when the service pulls an image. */
  build: string | null;
  /** The service's raw lines, for dependency and reference checks. */
  body: string;
}

/** The repository path of the Dockerfile a compose `build:` names, or null when the service pulls an image. */
export function composeBuildDockerfile(composeFile: string, build: string | null): string | null {
  if (build === null) return null;
  const part = (key: string): string | undefined =>
    build.split('|').find((entry) => entry.startsWith(`${key}:`))?.slice(key.length + 1).trim();
  const composeDir = composeFile.includes('/') ? composeFile.slice(0, composeFile.lastIndexOf('/')) : '';
  const context = posixJoin(composeDir, part('context') ?? '.');
  return posixJoin(context, part('dockerfile') ?? 'Dockerfile');
}

/** Join and normalize repository-relative paths (`a/./b/../c` → `a/c`). */
function posixJoin(...parts: string[]): string {
  const segments: string[] = [];
  for (const segment of parts.join('/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/');
}

export function composeServices(tree: FileTree): { file: string; services: ComposeService[] } | null {
  const path = listProductionComposeFiles(tree)[0];
  if (path === undefined) return null;
  const content = tree[path] ?? '';
  const oneShot = new Set<string>();
  for (const match of content.matchAll(/^\s+([a-zA-Z0-9_-]+):\s*\r?\n\s+condition:\s*service_completed_successfully/gm)) {
    if (match[1]) oneShot.add(match[1]);
  }
  const services: ComposeService[] = [];
  let inServices = false;
  let current: ComposeService | null = null;
  let inVolumes = false;
  let inPorts = false;
  let inCommand = false;
  let buildIndent = -1;
  let buildParts: string[] = [];
  // The file's own indentation: a service header sits one level under
  // `services:`, its keys one level deeper (two or four spaces alike).
  let serviceIndent = -1;
  for (const raw of content.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!inServices) {
      if (/^services:\s*$/.test(line)) inServices = true;
      continue;
    }
    if (/^\s*(?:#|$)/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    // Back to a top-level section ends the services block.
    if (indent === 0) {
      inServices = false;
      current = null;
      continue;
    }
    if (serviceIndent === -1) serviceIndent = indent;
    const serviceHeader = indent === serviceIndent ? /^\s*([a-zA-Z0-9_.-]+):\s*$/.exec(line) : null;
    if (serviceHeader) {
      current = { name: serviceHeader[1]!, image: null, optional: false, volumes: [], ports: [], command: null, build: null, body: '' };
      inVolumes = false;
      inPorts = false;
      inCommand = false;
      buildIndent = -1;
      buildParts = [];
      if (!oneShot.has(current.name)) services.push(current);
      continue;
    }
    if (!current) continue;
    current.body += `${line}\n`;
    if (buildIndent !== -1 && indent <= buildIndent) buildIndent = -1;
    if (buildIndent !== -1) {
      buildParts.push(line.trim().replace(/["']/g, ''));
      current.build = [...buildParts].sort().join('|');
      continue;
    }
    const keyLine = /^\s*([a-zA-Z_]+):\s*(.*)$/.exec(line);
    const isServiceKey = keyLine !== null && indent > serviceIndent && !line.trimStart().startsWith('-');
    if (isServiceKey) {
      inVolumes = false;
      inPorts = false;
      inCommand = false;
    }
    if (isServiceKey && keyLine[1] === 'image') current.image = /^["']?([^\s"']+)/.exec(keyLine[2] ?? '')?.[1] ?? null;
    if (isServiceKey && keyLine[1] === 'profiles') current.optional = true;
    if (isServiceKey && keyLine[1] === 'build') {
      const value = (keyLine[2] ?? '').trim();
      if (value === '') buildIndent = indent;
      current.build = value === '' ? '' : `context: ${value.replace(/["']/g, '')}`;
    }
    // COMP-010: `deploy.replicas: 0` declares an OPTIONAL service (a worker
    // kept for reference but never scaled by the default stack).
    if (isServiceKey && keyLine[1] === 'replicas' && (keyLine[2] ?? '').trim() === '0') {
      current.optional = true;
    }
    if (isServiceKey && keyLine[1] === 'volumes' && (keyLine[2] ?? '') === '') inVolumes = true;
    if (isServiceKey && keyLine[1] === 'ports' && (keyLine[2] ?? '') === '') inPorts = true;
    if (isServiceKey && keyLine[1] === 'command') {
      const value = (keyLine[2] ?? '').trim();
      if (value === '') inCommand = true;
      else current.command = value.replace(/^\[|\]$/g, '').replace(/["',]/g, ' ').replace(/\s+/g, ' ').trim();
    }
    const listItem = /^\s*-\s*["']?([^"']*?)["']?\s*$/.exec(line);
    if (inVolumes && listItem?.[1]) current.volumes.push(listItem[1]);
    if (inPorts && listItem?.[1]) current.ports.push(listItem[1]);
    if (inCommand && listItem?.[1] !== undefined) current.command = `${current.command ?? ''} ${listItem[1]}`.trim();
  }
  return { file: path, services };
}

/**
 * Container images a Compose service runs that are infrastructure or a
 * sidecar next to the app — a database, cache, broker, search engine, mail
 * sandbox, reverse proxy, headless browser — never the application itself
 * (Stage A COMP-026).
 */
export const INFRA_COMPOSE_IMAGE_REGEX =
  /postgres|postgis|pgvector|pgadmin|adminer|mysql|mariadb|mssql|sqlserver|sql-edge|oracle|cockroach|mongo|redis|valkey|keydb|elasticsearch|opensearch|rabbitmq|kafka|zookeeper|nats|minio|seaweedfs|garage|memcached|localstack|azurite|mailhog|mailpit|maildev|mailcatcher|smtp|postfix|clickhouse|dynamodb|meilisearch|typesense|qdrant|weaviate|milvus|chroma|nginx|caddy|traefik|haproxy|httpd|keycloak|gotenberg|tika|browserless|chrome|chromium|playwright|searxng|rustfs|ollama|vllm|prometheus|grafana|loki|jaeger|tempo|otel|temporalio|paradedb|pgautoupgrade|getsentry\/spotlight|pictrs|spicedb|authzed|cubejs|hashicorp\/vault/i;

// A bare language runtime image or a front-end/ORM dev server is a tool the
// stack runs next to the app (a build helper, a dev server, a database
// studio), never the application image.
const TOOL_COMPOSE_IMAGE_REGEX =
  /^(?:docker\.io\/)?(?:library\/)?(?:node|python|ruby|golang|php|openjdk|eclipse-temurin|maven|gradle|bun|deno|alpine|busybox|ubuntu|debian)(?:[:@]|$)/i;
// A service that runs a database or cache server (its command, its health probe or its data
// volume) is infrastructure even when its image name does not say so (`paradedb`). The
// `POSTGRES_*` keys are not a signal: an application sets them to connect.
const INFRA_COMPOSE_COMMAND_REGEX = /^(?:postgres|mysqld|mariadbd|mongod|redis-server|valkey-server|memcached)\b/i;
const INFRA_COMPOSE_BODY_REGEX = /\bpg_isready\b|\bmysqladmin\s+ping\b|:\/var\/lib\/(?:postgresql|mysql)\b/;
const DEV_TOOL_COMMAND_REGEX =
  /\b(?:vite|webpack(?:-dev-server)?|storybook|nodemon|ts-node-dev|tsx\s+watch|jest|vitest|prisma\s+studio|next\s+dev|(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?(?:dev|watch))\b|--watch\b/i;

/** Whether a command runs a development or test tool (a watcher, a dev server, a test runner), never a production process. */
export function isDevToolCommand(command: string): boolean {
  return DEV_TOOL_COMMAND_REGEX.test(command);
}

/** Compose services that run the application itself: not infrastructure, not a dev tool, not profile-gated. */
export function composeApplicationServices(tree: FileTree): { file: string; services: ComposeService[] } | null {
  const compose = composeServices(tree);
  if (!compose) return null;
  return {
    file: compose.file,
    services: compose.services.filter(
      (s) =>
        !s.optional &&
        (!s.image || (!INFRA_COMPOSE_IMAGE_REGEX.test(s.image) && !TOOL_COMPOSE_IMAGE_REGEX.test(s.image))) &&
        !(s.command !== null && (DEV_TOOL_COMMAND_REGEX.test(s.command) || INFRA_COMPOSE_COMMAND_REGEX.test(s.command))) &&
        !INFRA_COMPOSE_BODY_REGEX.test(s.body),
    ),
  };
}

/** Dependency-bearing manifests for the non-Node languages §11.5 reads. */
const PY_DEPENDENCY_FILES = /(?:^|\/)(?:requirements[^/]*\.txt|Pipfile|pyproject\.toml|setup\.py|environment\.ya?ml)$/;
const RB_DEPENDENCY_FILES = /(?:^|\/)Gemfile(?:\.lock)?$/;
const GO_DEPENDENCY_FILES = /(?:^|\/)go\.mod$/;
// PHP, JVM, .NET, Rust and Elixir manifests (Stage A COMP-029).
const OTHER_DEPENDENCY_FILES =
  /(?:^|\/)(?:composer\.json|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|libs\.versions\.toml|[\w.-]+\.csproj|Directory\.Packages\.props|Cargo\.toml|mix\.exs)$/;

/** Source-code extensions the §11.5 language detectors scan. */
const PY_SOURCE = /\.py$/;
const RB_SOURCE = /\.rb$/;
const GO_SOURCE = /\.go$/;
const JS_SOURCE = /\.(ts|js|mjs|cjs|jsx|tsx)$/;

// Converters that take one env value and decide what an absent one means.
// Number/parseInt/String are not here: they turn an absent value into NaN or "undefined".
const ENV_TRANSFORM_CALLEE_REGEX =
  /^(?:Boolean|format[A-Z]\w*|normali[sz]e[A-Z]\w*|\w+From[A-Z]\w*|load[A-Z]\w*|to[A-Z]\w*)$/;

// `process.env.KEY = …` / `process.env['KEY'] = …`: a write, not `==` or `=>`.
const JS_ENV_ASSIGNMENT_REGEX =
  /process\.env\s*\.\s*([A-Z_][A-Z0-9_]*)\s*=(?![=>])|process\.env\[["']([A-Z_][A-Z0-9_]*)["']\]\s*=(?![=>])/g;

// Stage B Wave 1 (DEPLOY-005, directus): a JS/TS module that reads its
// configuration through a local `env` object — `const env = useEnv()`,
// `import env from './env'`, `const env = process.env` — instead of
// `process.env` at every site. `env.KEY` / `env['KEY']` count as reads only
// inside such a module, so a front end's `import.meta.env.VITE_X` does not.
const CONFIG_ENV_BINDING_REGEX =
  /\b(?:const|let|var)\s+env\s*=|\bimport\s+(?:\{[^}]*\benv\b[^}]*\}|env)\s+from\b|=\s*useEnv\s*\(|[(,]\s*env\s*:\s*(?:\w+\.)?\w*Env\w*\b/;
const CONFIG_ENV_READ_SOURCE =
  String.raw`(?<![\w.$])env\s*(?:\.\s*([A-Z][A-Z0-9_]*)\b|\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\])`;

/** Whether a JS/TS module reads configuration through a local `env` object. */
function readsThroughEnvObject(content: string): boolean {
  return CONFIG_ENV_BINDING_REGEX.test(content);
}

/** Every file that can declare a dependency, for language-breadth scans. */
function isDependencyManifest(path: string): boolean {
  return (
    PY_DEPENDENCY_FILES.test(path) ||
    RB_DEPENDENCY_FILES.test(path) ||
    GO_DEPENDENCY_FILES.test(path) ||
    OTHER_DEPENDENCY_FILES.test(path) ||
    /(?:^|\/)package\.json$/.test(path)
  );
}

// A language package-manager install inside a Dockerfile `RUN` — the image
// installs that package as surely as a manifest declares it (a native
// driver such as `mysqlclient` is often installed there, next to the OS
// headers it compiles against). OS package managers (`apt-get`, `apk`) are
// not matched: their package names are not language dependencies.
const DOCKERFILE_PACKAGE_INSTALL_REGEX =
  /(?:^|\s)(?:pip3?|pipenv|poetry|gem|npm|yarn|pnpm|bun|go|composer)\s+(?:install|add|get|require|i)\b(.*)$/;

/** True when a Dockerfile installs `token` with a language package manager. */
function dockerfileInstallsPackage(content: string, token: string): boolean {
  const pattern = new RegExp(tokenPattern(token));
  return content
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .flatMap((line) => line.split(/&&|\|\||;/))
    .some((segment) => {
      const args = DOCKERFILE_PACKAGE_INSTALL_REGEX.exec(segment)?.[1];
      return args !== undefined && pattern.test(args);
    });
}

/** Escape a dependency token so it can match as an identifier-ish literal. */
function tokenPattern(token: string): string {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `(?<![A-Za-z0-9_@/.-])${escaped}(?![A-Za-z0-9_])`;
}

// Python dev tooling lives in its own groups or files: a `dev` entry of
// `[dependency-groups]`, `[tool.poetry.group.dev.dependencies]`,
// `requirements-dev.txt`. A driver declared only there (`psycopg2-binary` for
// the test suite) is not installed in the image the app runs from.
const PY_DEV_GROUP = 'dev|test|tests|lint|docs|typing';
const PY_DEV_TABLE_REGEX = new RegExp(
  String.raw`^\s*\[\[?(?:tool\.poetry\.dev-dependencies|tool\.pdm\.dev-dependencies|tool\.poetry\.group\.(?:${PY_DEV_GROUP})\.dependencies)\]\]?\s*$`,
);
const PY_DEV_GROUP_REGEX = new RegExp(String.raw`^\s*(?:${PY_DEV_GROUP})\s*=`);
const PY_DEV_REQUIREMENTS_REGEX = /(?:^|\/)requirements[-_.](?:dev|test|tests|lint|docs|ci)[\w.-]*\.txt$/i;

/** A dependency manifest's content without the Python dev-only declarations. */
function runtimeManifestContent(path: string, content: string, directOnly: boolean): string {
  if (PY_DEV_REQUIREMENTS_REGEX.test(path)) return '';
  // A `// indirect` go.mod line is a transitive module, not something the app imports.
  if (directOnly && GO_DEPENDENCY_FILES.test(path)) return content.split('\n').filter((line) => !/\/\/\s*indirect\b/.test(line)).join('\n');
  if (!/(?:^|\/)pyproject\.toml$/.test(path)) return content;
  let inDevTable = false;
  let inGroups = false;
  let inDevGroup = false;
  return content
    .split('\n')
    .filter((line) => {
      if (/^\s*\[/.test(line) && /\]\s*$/.test(line)) {
        inDevTable = PY_DEV_TABLE_REGEX.test(line);
        inGroups = /^\s*\[dependency-groups\]\s*$/.test(line);
        inDevGroup = false;
      } else if (inGroups && /^\s*[\w-]+\s*=/.test(line)) {
        inDevGroup = PY_DEV_GROUP_REGEX.test(line);
      }
      return !inDevTable && !inDevGroup;
    })
    .join('\n');
}

/**
 * Files where a dependency token appears in a DEPENDENCY position: a declared
 * dependency in a package manifest, a `require('x')`/`import x from 'x'`
 * specifier, a Python `import x` statement, or a language package-manager
 * install in a Dockerfile. Prose (READMEs, comments that
 * merely mention a product name) never counts — an undeclared mention is not
 * a dependency the app runs on. With `directOnly`, a `// indirect` go.mod
 * line (a transitive module) is not a declaration.
 */
export function findDependencyEvidence(tree: FileTree, token: string, directOnly = false): string[] {
  const evidence: string[] = [];
  for (const [path, content] of Object.entries(tree)) {
    if (!content) continue;
    if (/(?:^|\/)package\.json$/.test(path)) {
      // package.json content is free-form (name, description, scripts) — only
      // an EXACT declared dependency counts, never a prose mention.
      if (collectDependencyNames({ [path]: content }).includes(token)) {
        evidence.push(path);
      }
      continue;
    }
    if (isDependencyManifest(path) && new RegExp(tokenPattern(token)).test(runtimeManifestContent(path, content, directOnly))) {
      evidence.push(path);
      continue;
    }
    if (isDockerfilePath(path) && dockerfileInstallsPackage(content, token)) {
      evidence.push(path);
      continue;
    }
    if (PY_SOURCE.test(path) && new RegExp(`import\\s+${tokenPattern(token)}`).test(content)) {
      evidence.push(path);
      continue;
    }
    if (
      JS_SOURCE.test(path) &&
      new RegExp(`(?:require\\s*\\(|from\\s+)[\\s'"]*${tokenPattern(token)}`).test(content)
    ) {
      evidence.push(path);
      continue;
    }
  }
  return evidence;
}

// ── Detectors ───────────────────────────────────────────────────────────────

// 1. Dockerfile
// ---------------------------------------------------------------------------

// Matches a Dockerfile in ANY directory, with or without a suffix, in either
// naming order: `Dockerfile`, `dockerfile`, `docker/Dockerfile`,
// `apps/web/Dockerfile.prod`, `.docker/Dockerfile-build`,
// `docker/ce-production.Dockerfile`. A repository that keeps its Dockerfile
// out of the root is the common case, not the exception. A `.dockerignore`,
// a template (`Dockerfile.j2`) or source code named after the format
// (`dockerfile.js`) is not one (Stage A COMP-027).
const DOCKERFILE_REGEX = /(?:^|\/)(?:dockerfile(?:[.-][\w.-]+)?|[\w.-]+\.dockerfile)$/i;
const NOT_A_DOCKERFILE_REGEX = /\.(?:dockerignore|j2|jinja2?|tpl|tmpl|template|md|txt|[cm]?[jt]sx?|ex|py|rb|go|json|ya?ml|lock)$/i;

function isDockerfilePath(path: string): boolean {
  return DOCKERFILE_REGEX.test(path) && !NOT_A_DOCKERFILE_REGEX.test(path);
}

// Exact `Dockerfile`/`dockerfile` basename, no suffix — used to rank an
// unsuffixed Dockerfile above a suffixed variant at the same depth.
const EXACT_DOCKERFILE_NAME_REGEX = /(?:^|\/)dockerfile$/i;

/**
 * Rank two candidate Dockerfile paths so the more likely "real" build
 * Dockerfile sorts first: shallower paths win, then an exact `Dockerfile`
 * name over a suffixed variant (`Dockerfile.gotenberg`), then lexicographic
 * order for remaining ties. A repository can ship several Dockerfiles for
 * auxiliary services (e.g. a dev-only PDF service); picking the first one
 * `Object.keys` happens to return risks building the wrong image.
 */
// A Dockerfile that builds a dev container, a test image, an example, an OS
// package (Debian/RPM), an operator, a tool image, a sidecar image named
// after the infrastructure it runs (`twenty-postgres-spilo/`, `chrome/`),
// or a hardware/base-image variant (`Dockerfile.fips.*`, `Dockerfile.gpu`)
// is never the image Deployz should build — it ranks below every other
// candidate regardless of depth (Stage A COMP-007, COMP-027).
const DEV_DOCKERFILE_REGEX =
  /(?:^|\/)(?:\.devcontainer|\.cursor|\.github|\.vscode|\.idea|\.gitpod|dev|development|[\w-]*tests?|e2e|ci|cypress|examples?|samples?|debian|rpm|operator|hack|tools?|scaletest|dogfood|docs?|benchmarks?|playwright|engine|runners?|sidecars?|base|[\w-]+-base)(?:\/|$)|(?:^|\/)[\w.-]*(?:postgres|spilo|redis|nginx|caddy|proxy|chrome|chromium|keycloak|elasticsearch|meilisearch|mysql|mariadb|minio|gotenberg)[\w.-]*\/|(?:^|\/)[\w-]*(?:gitpod|dev|test|ci|preview|staging)[\w-]*\.dockerfile$|(?:^|\/)dockerfile(?:[.-]\w+)*[.-](?:dev|development|test|e2e|ci|compose|fips|coverage|integration|tilt|gitpod|alpine|debian|ubuntu|cpu|gpu|cuda|rocm|arm|arm64|ppc64le|rock|rock_base|deb|rpm)(?:[.-]\w+)*$/i;

// A variant of the same image for other hardware or a bundled-process layout
// ranks below the plain one (`dev/build-arm`, `docker/multi-process`).
const DOCKERFILE_VARIANT_REGEX =
  /(?:^|\/)[\w.-]*(?:[-_.](?:arm|arm64|armv\d+|aarch64)|multi[-_]?(?:process|service|container))[\w.-]*(?:\/|$)/i;
const PRODUCTION_DOCKERFILE_REGEX = /(?:^|[/._-])prod(?:uction)?(?:[/._-]|$)/i;
// A runtime that is evidently a development server: a Dockerfile that runs
// one is never the production image.
const DEV_RUNTIME_REGEX =
  /--env[= ]dev\b|\bAPP_ENV=dev(?:elopment)?\b|\bNODE_ENV=development\b|\b(?:npm|yarn|pnpm|bun)(?: run)? (?:dev|start:dev)\b|\bnodemon\b|\bnext dev\b|--reload\b|\bsleep\W+infinity\b/i;

/** A stage name that marks tooling, never the production runtime image. */
// A trailing number names a variant of the same stage (`pr-test2`); a nightly
// stage builds an unreleased channel of the app.
const NON_RUNTIME_STAGE_NAME_REGEX =
  /(?:^|[-_.])(?:dev|development|devel|test|tests|debug|local|e2e|ci|build|builder|deps|dependencies|base|fetch|prep|assets|plugins?|nightly)\d*(?:[-_.]|$)/i;

/** Join continuation lines and drop comment lines, so one instruction is one line. */
function normalizeDockerfile(content: string): string {
  return content
    .replace(/\\r?\n/g, ' ')
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/**
 * The text of the stage `docker build` produces for production: the last
 * stage whose name is not tooling (a trailing `dev` or `test` target is not
 * the image to deploy) and whose lineage runs something, plus every stage it
 * is built `FROM`. Global `ARG`s before the first `FROM` come first.
 */
export function productionStageText(content: string): string {
  const clean = normalizeDockerfile(content);
  const stages = parseDockerfileStages(clean);
  if (stages.length === 0) return clean;
  const firstFrom = clean.search(/^\s*FROM\s/im);
  return `${firstFrom > 0 ? clean.slice(0, firstFrom) : ''}\n${stageLineageText(stages, productionStageIndex(stages))}`;
}

/** Stage indexes from the root of a stage's `FROM <stage>` lineage down to the stage itself. */
function stageLineage(stages: DockerfileStage[], index: number): number[] {
  const chain = [index];
  for (let current = index; ; ) {
    const image = stages[current]!.image.toLowerCase();
    let parent = -1;
    for (let i = current - 1; i >= 0; i -= 1) {
      if (stages[i]!.name === image || String(i) === image) {
        parent = i;
        break;
      }
    }
    if (parent < 0) return chain.reverse();
    chain.push(parent);
    current = parent;
  }
}

function stageLineageText(stages: DockerfileStage[], index: number): string {
  return stageLineage(stages, index).map((i) => stages[i]!.body).join('\n');
}

/** The stage `docker build` produces: the last non-tooling stage whose lineage starts something, else the last stage. */
function productionStageIndex(stages: DockerfileStage[]): number {
  for (let i = stages.length - 1; i >= 0; i -= 1) {
    const name = stages[i]!.name;
    if ((name === null || !NON_RUNTIME_STAGE_NAME_REGEX.test(name)) && /^\s*(?:CMD|ENTRYPOINT|EXPOSE)\b/im.test(stageLineageText(stages, i))) return i;
  }
  return stages.length - 1;
}

// A base image whose default command is a shell, and an interpreter or launcher that
// exits (or waits on a terminal) when it receives no script or sub-command.
const BARE_OS_IMAGE_REGEX = /^(?:docker\.io\/)?(?:library\/)?(?:debian|ubuntu|alpine|busybox|fedora|centos|rockylinux|almalinux|amazonlinux)(?:[:@]|$)/i;
const LAUNCHER_ONLY_ENTRYPOINT_REGEX =
  /^\s*ENTRYPOINT\s+\[\s*"(?:bundle"\s*,\s*"exec|uv"\s*,\s*"run|poetry"\s*,\s*"run|pipenv"\s*,\s*"run|npx|node|python3?|ruby)"\s*\]\s*$/im;

/**
 * Why the image `docker build` produces has no default command that starts a server, or
 * null. Two sound cases: a final-stage lineage with no `CMD` and no `ENTRYPOINT` on a
 * bare OS base (its default command is a shell that exits at once), and an `ENTRYPOINT`
 * that is only a launcher (`["bundle", "exec"]`) with no `CMD` to give it a command.
 */
export function detectNoDefaultServerCommand(content: string): string | null {
  const stages = parseDockerfileStages(normalizeDockerfile(content));
  const last = stages[stages.length - 1];
  if (last === undefined || (last.name !== null && NON_RUNTIME_STAGE_NAME_REGEX.test(last.name))) return null;
  const chain = [last];
  for (let current = last; ; ) {
    const parent = stages.find((stage, index) => stage.name !== null && stage.name === current.image.toLowerCase() && stages[index] !== current);
    if (parent === undefined || chain.includes(parent)) break;
    chain.unshift(parent);
    current = parent;
  }
  const lines = chain.map((stage) => stage.body).join('\n');
  const hasCmd = /^\s*CMD\b/im.test(lines);
  const hasEntrypoint = /^\s*ENTRYPOINT\b/im.test(lines);
  const root = chain[0]!.image;
  if (!hasCmd && !hasEntrypoint && BARE_OS_IMAGE_REGEX.test(root)) {
    return `the final image is built from ${root} and has no CMD or ENTRYPOINT, so it starts a shell that exits at once`;
  }
  const entrypoints = lines.match(/^\s*ENTRYPOINT\b.*$/gim);
  const launcher = entrypoints === null ? undefined : entrypoints[entrypoints.length - 1]!.trim();
  if (!hasCmd && launcher !== undefined && LAUNCHER_ONLY_ENTRYPOINT_REGEX.test(launcher)) {
    return `${launcher} has no CMD, so the launcher starts with no command`;
  }
  return null;
}

// Directories whose Dockerfiles build a test image, a dev container or an
// example, never the application (a `dev/` build directory still can).
const NON_APP_DOCKERFILE_DIR_REGEX =
  /(?:^|\/)(?:\.devcontainer|\.cursor|\.github|\.vscode|\.idea|\.gitpod|[\w-]*tests?(?:ing)?|e2e|ci|cypress|examples?|samples?|docs?|benchmarks?|playwright)(?:\/|$)/i;

// A `dev/` build directory can hold the production Dockerfile; it counts only
// when the image starts something (a tooling image has no CMD, ENTRYPOINT or EXPOSE).
const DEV_DOCKERFILE_DIR_REGEX = /(?:^|\/)(?:dev|development)\//i;

// A template (mustache or jinja block tag, or a templated FROM) is not a Dockerfile Docker can build.
const DOCKERFILE_TEMPLATE_REGEX = /^\s*(?:\{\{[#^/>!]|\{%)|^\s*FROM\s[^\n]*\{\{/im;

/**
 * A Dockerfile that cannot be the production image: one in a test, example or
 * dev-container directory, one that builds a base layer (installs system
 * packages, but has no CMD, ENTRYPOINT or EXPOSE and copies nothing in),
 * one that starts a development server, or a template.
 */
function isUnusableDockerfile(path: string, content: string): boolean {
  if (NON_APP_DOCKERFILE_DIR_REGEX.test(path)) return true;
  if (content.length === 0) return false;
  if (DOCKERFILE_TEMPLATE_REGEX.test(content)) return true;
  const runtime = productionStageText(content);
  const lines = runtime.split('\n');
  if (lines.some((line) => /^\s*(?:CMD|ENTRYPOINT)\b/i.test(line) && DEV_RUNTIME_REGEX.test(line.replace(/["',[\]\s]+/g, ' ')))) return true;
  const startsSomething = lines.some((line) => /^\s*(?:CMD|ENTRYPOINT|EXPOSE)\b/i.test(line));
  if (DEV_DOCKERFILE_DIR_REGEX.test(path) && !startsSomething) return true;
  const copiesApp = lines.some((line) => /^\s*(?:COPY|ADD)\b/i.test(line));
  const installsSystemPackages = lines.some((line) => /^\s*RUN\b.*\b(?:apt-get|apt|apk|yum|dnf|microdnf)\b/i.test(line));
  return installsSystemPackages && !startsSomething && !copiesApp;
}

function dockerfileStartsSomething(content: string): boolean {
  return /^\s*(?:CMD|ENTRYPOINT|EXPOSE)\b/im.test(productionStageText(content));
}

function dockerfileDeclaresPort(content: string): boolean {
  const stage = productionStageText(content);
  return exposedPorts(stage).length > 0 || DOCKERFILE_ENV_PORT_REGEX.test(stage);
}

// `tied` keeps the alphabetical tie unresolved, so the caller can see which candidates no signal separates.
function compareDockerfileCandidates(tree: FileTree, tied = false): (a: string, b: string) => number {
  return (a, b) => {
    const aUnusable = isUnusableDockerfile(a, tree[a] ?? '');
    const bUnusable = isUnusableDockerfile(b, tree[b] ?? '');
    if (aUnusable !== bUnusable) return aUnusable ? 1 : -1;

    const aDev = DEV_DOCKERFILE_REGEX.test(a);
    const bDev = DEV_DOCKERFILE_REGEX.test(b);
    if (aDev !== bDev) return aDev ? 1 : -1;

    const aVariant = DOCKERFILE_VARIANT_REGEX.test(a);
    const bVariant = DOCKERFILE_VARIANT_REGEX.test(b);
    if (aVariant !== bVariant) return aVariant ? 1 : -1;

    const aProd = PRODUCTION_DOCKERFILE_REGEX.test(a);
    const bProd = PRODUCTION_DOCKERFILE_REGEX.test(b);
    if (aProd !== bProd) return aProd ? -1 : 1;

    const depthDiff = a.split('/').length - b.split('/').length;
    if (depthDiff !== 0) return depthDiff;

    const aExact = EXACT_DOCKERFILE_NAME_REGEX.test(a);
    const bExact = EXACT_DOCKERFILE_NAME_REGEX.test(b);
    if (aExact !== bExact) return aExact ? -1 : 1;

    // Fewer name segments first: `Dockerfile.server` over `Dockerfile.server.gpu`.
    const segmentDiff = (a.split('/').pop() ?? '').split('.').length - (b.split('/').pop() ?? '').split('.').length;
    if (segmentDiff !== 0) return segmentDiff;

    // An image that starts something, and one that listens on a port, outranks one that does not.
    const aStarts = dockerfileStartsSomething(tree[a] ?? '');
    const bStarts = dockerfileStartsSomething(tree[b] ?? '');
    if (aStarts !== bStarts) return aStarts ? -1 : 1;

    const aPort = dockerfileDeclaresPort(tree[a] ?? '');
    const bPort = dockerfileDeclaresPort(tree[b] ?? '');
    if (aPort !== bPort) return aPort ? -1 : 1;

    return tied ? 0 : a.localeCompare(b);
  };
}

/** The candidates that no ranking signal separates from the selected Dockerfile, or null when one candidate wins. */
export function dockerfileSelectionTied(tree: FileTree): string[] | null {
  const first = selectedDockerfile(tree)?.path;
  if (first === undefined) return null;
  const compare = compareDockerfileCandidates(tree, true);
  const tiedWithFirst = listDockerfileCandidates(tree).filter(
    (candidate) => !isUnusableDockerfile(candidate, tree[candidate] ?? '') && compare(first, candidate) === 0,
  );
  return tiedWithFirst.length > 1 ? tiedWithFirst : null;
}

/**
 * Detect a Dockerfile (case-insensitive: `Dockerfile`, `dockerfile`, `Dockerfile.prod`, etc.).
 * A repository whose only Dockerfiles are dev or base images has none Deployz can build.
 */
export function detectDockerfile(tree: FileTree): DetectorFinding {
  const match = Object.keys(tree).filter(isDockerfilePath);
  if (match.length === 0) {
    return { detector: 'dockerfile', detected: false };
  }
  const selected = selectedDockerfile(tree);
  if (!selected) {
    return { detector: 'dockerfile', detected: false, details: `Only dev or base Dockerfile(s): ${match.join(', ')}` };
  }
  return {
    detector: 'dockerfile',
    detected: true,
    value: selected.path,
    details: `Found ${match.length} Dockerfile(s): ${match.join(', ')}`,
  };
}

/**
 * All Dockerfile candidates in the tree, ranked the same way `detectDockerfile`
 * picks its single best guess. Used by the AI repository-analysis fallback to
 * detect a genuinely ambiguous multi-Dockerfile repository (the
 * `multiple-dockerfiles` unresolved question), distinct from
 * `detectDockerfile`'s "pick the most likely one" behavior.
 */
export function listDockerfileCandidates(tree: FileTree): string[] {
  return Object.keys(tree).filter(isDockerfilePath).sort(compareDockerfileCandidates(tree));
}

/** The Dockerfile Deployz would build — the top-ranked usable candidate — with its content. */
export function selectedDockerfile(tree: FileTree): { path: string; content: string } | null {
  const path = listDockerfileCandidates(tree).find((candidate) => !isUnusableDockerfile(candidate, tree[candidate] ?? ''));
  if (path === undefined) return null;
  return { path, content: tree[path] ?? '' };
}

const APP_DIR_REGEX = /(?:^|\/)(apps|services|applications)\/([^/\s"']+)/;

/**
 * The app directories (`apps/<name>`) that the production image holds: the
 * ones its stage lineage copies, following a copy of a whole stage into that
 * stage's own copies. Null when the image takes the whole build context, or
 * names no app directory.
 */
function imageAppDirs(content: string): { parent: string; names: Set<string> } | null {
  const stages = parseDockerfileStages(normalizeDockerfile(content));
  if (stages.length === 0) return null;
  const names = new Map<string, Set<string>>();
  const visited = new Set<number>();
  let whole = false;
  const visit = (index: number): void => {
    for (const i of stageLineage(stages, index)) {
      if (visited.has(i)) continue;
      visited.add(i);
      for (const [, args] of stages[i]!.body.matchAll(/^\s*(?:COPY|ADD)\s+(.+)$/gim)) {
        const tokens = args!.trim().split(/\s+/);
        const from = tokens.find((token) => token.startsWith('--from='))?.slice(7);
        const sources = tokens.filter((token) => !token.startsWith('--')).slice(0, -1);
        const fromIndex = from === undefined ? -1 : stages.indexOf(resolveDockerfileStage(from, stages, i)!);
        if (from !== undefined && fromIndex < 0) continue;
        for (const source of sources) {
          const app = APP_DIR_REGEX.exec(source);
          if (app) names.set(app[1]!, (names.get(app[1]!) ?? new Set()).add(app[2]!));
          else if (from === undefined && /^\.\/?$/.test(source)) whole = true;
          else if (from !== undefined) {
            const fromWorkdir = [...stages[fromIndex]!.body.matchAll(DOCKERFILE_WORKDIR_REGEX)].pop()?.[1];
            if (/^(?:\/|\.\/?)$/.test(source) || source.replace(/\/$/, '') === fromWorkdir?.replace(/\/$/, '')) visit(fromIndex);
          }
        }
      }
    }
  };
  visit(productionStageIndex(stages));
  if (whole || names.size !== 1) return null;
  const [parent, set] = [...names][0]!;
  return { parent, names: set };
}

/**
 * A monorepo builds one app from `apps/web/Dockerfile`; its sibling apps
 * (`apps/landing`) are other apps, so their env reads are not this
 * deployment's. A sibling stays in scope when a production compose file or a
 * Procfile points at it, or the selected Dockerfile names it. A sibling with only its
 * own Dockerfile is a separate image: a release has exactly one image, so its
 * reads never reach this container. Comment lines are not references.
 */
export function siblingAppFilter(tree: FileTree): (path: string) => boolean {
  const dockerfile = selectedDockerfile(tree);
  const match = dockerfile ? /^((?:apps|services|applications)\/)([^/]+)\/(?:.+\/)?[^/]+$/.exec(dockerfile.path) : null;
  if (dockerfile && !match) {
    // A root Dockerfile whose image holds only named app directories (cal.com
    // copies `apps/web` into its runtime stage, never `apps/api/v2`).
    const image = imageAppDirs(dockerfile.content);
    if (image === null) return () => false;
    return (path) => {
      const app = APP_DIR_REGEX.exec(path);
      return app !== null && app[1] === image.parent && !image.names.has(app[2]!);
    };
  }
  if (!dockerfile || !match) return () => false;
  const [, parent, own] = match as unknown as [string, string, string];
  const references = [dockerfile.content, ...listProductionComposeFiles(tree).map((path) => tree[path] ?? '')];
  for (const [path, content] of Object.entries(tree)) {
    if (content && /(?:^|\/)Procfile$/.test(path)) references.push(content);
  }
  const referenceText = references.map((text) => text.replace(/^[ \t]*#.*$/gm, '')).join('\n');
  const workloads = new Map<string, boolean>();
  const isWorkload = (sibling: string): boolean => {
    let known = workloads.get(sibling);
    if (known === undefined) {
      const dir = `${parent}${sibling}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      known = new RegExp(`${dir}(?![\\w.-])`).test(referenceText);
      workloads.set(sibling, known);
    }
    return known;
  };
  return (path) => {
    if (!path.startsWith(parent)) return false;
    const sibling = path.slice(parent.length).split('/')[0] ?? '';
    return sibling !== own && !isWorkload(sibling);
  };
}

// 2. Framework
// ---------------------------------------------------------------------------

// Nest runs on Express, so a Nest dependency names the framework before Express does.
const KNOWN_FRAMEWORKS = [
  'nest',
  '@nestjs/core',
  'express',
  'fastify',
  'next',
  'nuxt',
  'koa',
  'hapi',
  '@hapi/hapi',
  'restify',
] as const;

/**
 * Detect the application framework from package.json dependencies.
 * Returns the first matching framework name. An image that does not run Node
 * has no Node framework: a desktop shell or docs site in the repository does
 * not make a Go or Python image an Express app.
 */
export function detectFramework(tree: FileTree): DetectorFinding {
  if (selectedDockerfile(tree) !== null) {
    const runtime = detectRuntime(tree);
    if (runtime.detected && runtime.value !== 'node') return { detector: 'framework', detected: false };
  }
  const deps = collectDependencyNames(tree);
  for (const framework of KNOWN_FRAMEWORKS) {
    if (deps.includes(framework)) {
      return {
        detector: 'framework',
        detected: true,
        value: framework,
        details: `Framework detected: ${framework}`,
        source: 'package-manifest',
      };
    }
  }
  return { detector: 'framework', detected: false };
}

// 3. Port
// ---------------------------------------------------------------------------

/** Pattern: PORT=1234 in env files or process.env.PORT || fallback in source. */
const PORT_ENV_REGEX = /^PORT\s*=\s*(\d+)/m;
const PORT_PROCESS_REGEX = /process\.env\.PORT\s*\|\|\s*(\d+)/;
const PORT_DOCKER_COMPOSE_REGEX = /\$\{?PORT[:-](\d+)/;
// The container's own documentation of its port (Stage A COMP-001): an
// explicit `ENV PORT=3000`, an `EXPOSE 3000` / `EXPOSE ${PORT:-3333}`
// instruction, or a Compose port mapping whose CONTAINER side is the port.
const DOCKERFILE_ENV_PORT_REGEX = /^\s*ENV\s+PORT[=\s]+["']?(\d{2,5})\b/m;
const DOCKERFILE_EXPOSE_REGEX = /^\s*EXPOSE\s+([^\n#]+)/gm;
const COMPOSE_PORT_MAPPING_REGEX = /^\s*-\s*["']?(?:[\d.]+:)?\d{2,5}:(\d{2,5})(?:\/tcp)?["']?\s*$/m;
// Ports an image exposes for something other than its HTTP listener — SSH,
// mail, DNS, a bundled database — never the port Deployz routes to when the
// image exposes another one (Stage A COMP-028).
const NON_HTTP_PORTS = new Set(['22', '25', '53', '465', '587', '3306', '5432', '6379', '27017']);

/**
 * The HTTP port the selected Dockerfile exposes: the first `EXPOSE` value
 * that is a literal, a `${PORT:-n}` default, or a variable the same
 * Dockerfile sets with `ENV`/`ARG` (`EXPOSE ${APP_PORT}` after
 * `ENV APP_PORT=9000`), skipping non-HTTP ports (Stage A COMP-028).
 */
function exposedPorts(dockerfile: string): string[] {
  const values: string[] = [];
  for (const match of dockerfile.matchAll(DOCKERFILE_EXPOSE_REGEX)) {
    for (const token of (match[1] ?? '').trim().split(/\s+/)) {
      const literal = /^(\d{2,5})(?:\/tcp)?$/.exec(token);
      const withDefault = /^\$\{(\w+):-(\d{2,5})\}(?:\/tcp)?$/.exec(token);
      const variable = /^\$\{?(\w+)\}?(?:\/tcp)?$/.exec(token);
      if (literal?.[1]) values.push(literal[1]);
      else if (withDefault?.[2]) values.push(withDefault[2]);
      else if (variable?.[1]) {
        const assignment = new RegExp(`^\\s*(?:ENV|ARG)\\s+${variable[1]}[=\\s]+["']?(\\d{2,5})\\b`, 'm').exec(dockerfile);
        if (assignment?.[1]) values.push(assignment[1]);
      }
    }
  }
  return values;
}

function exposedPort(dockerfile: string): string | null {
  const values = exposedPorts(dockerfile);
  return values.find((value) => !NON_HTTP_PORTS.has(value)) ?? values[0] ?? null;
}

// A web server in the image that fronts the app (an all-in-one image), and the
// base images that serve on port 80 without an EXPOSE.
const FRONT_SERVER_REGEX = /\b(?:caddy|nginx|httpd|apache2|haproxy|traefik)\b/i;
const FRONT_SERVER_BASE_IMAGE_REGEX = /^\s*FROM\s+(?:--\S+\s+)*\S*(?:nginx|httpd|caddy|apache)\S*/im;

/**
 * The port the production stage of a Dockerfile serves on: its own `ENV PORT`
 * or `EXPOSE`, never a builder or dev stage's. An image that fronts the app
 * with a web server publishes that server's port 80, not the backend's `ENV PORT`.
 */
function runtimeDockerfilePort(content: string): { value: string; source: 'env' | 'dockerfile-expose'; via: string } | null {
  const runtime = productionStageText(content);
  if (exposedPorts(runtime).includes('80') && FRONT_SERVER_REGEX.test(runtime)) {
    return { value: '80', source: 'dockerfile-expose', via: 'EXPOSE' };
  }
  const envPort = [...runtime.matchAll(new RegExp(DOCKERFILE_ENV_PORT_REGEX.source, 'gm'))].at(-1)?.[1];
  if (envPort) return { value: envPort, source: 'env', via: 'ENV PORT' };
  const port = exposedPort(runtime);
  if (port) return { value: port, source: 'dockerfile-expose', via: 'EXPOSE' };
  // The image's own check of itself names its port variable and default
  // (`HEALTHCHECK CMD wget http://localhost:${LIVEBOOK_PORT-8080}/health`).
  const checked = /^\s*HEALTHCHECK\b[^\n]*\b(?:localhost|127\.0\.0\.1):\$\{\w+:?-(\d{2,5})\}/m.exec(runtime);
  if (checked) return { value: checked[1]!, source: 'dockerfile-expose', via: 'HEALTHCHECK' };
  return FRONT_SERVER_BASE_IMAGE_REGEX.test(runtime) ? { value: '80', source: 'dockerfile-expose', via: 'base image default' } : null;
}

/**
 * The candidate port + its provenance. Explicit sources always outrank the
 * framework default, which is stored separately (low confidence, prefill only).
 */
interface PortCandidate {
  value: string;
  source: 'dockerfile-expose' | 'compose' | 'env' | 'runtime-literal' | 'framework-default';
  confidence: 'high' | 'medium' | 'low';
  details: string;
}

/** A literal numeric port (2-5 digits). */
const LITERAL_PORT = /^(\d{2,5})$/;

/**
 * Runtime literals that name the port the app listens on — static, easy
 * patterns only. Placeholder/env-dependent values are never a candidate.
 */
function runtimeLiteralPort(tree: FileTree): { value: string; details: string } | null {
  for (const [path, content] of Object.entries(tree)) {
    if (!content || !isRuntimeSourcePath(path)) continue;
    // Go: http.ListenAndServe(":8080", nil) / Addr: ":8080"
    if (/\.go$/.test(path)) {
      const go = /(?:http\.ListenAndServe\(\s*"|Addr\s*:\s*"):(\d{2,5})"/.exec(content);
      if (go?.[1]) return { value: go[1], details: `Go ListenAndServe port ${go[1]} (${path})` };
    }
    // Python: app.run(port=8000) / uvicorn.run(app, port=8000) / --port 8000
    if (/\.py$/.test(path)) {
      const py = /\b(?:app\.run|uvicorn\.run)\([^)]*port\s*=\s*(\d{2,5})/.exec(content);
      if (py?.[1]) return { value: py[1], details: `Python run(port=...) ${py[1]} (${path})` };
    }
    // Java: server.port=8080 / server: { port: 8080 } (non-placeholder)
    if (/\.(?:properties|ya?ml)$/.test(path) && /(?:^|\/)application\./.test(path)) {
      const java = /^\s*server\s*[:.]\s*port\s*[:=]\s*(\d{2,5})\s*$/m.exec(content);
      if (java?.[1]) return { value: java[1], details: `server.port ${java[1]} (${path})` };
    }
  }
  // uvicorn --port in a start command / rails server -p / artisan serve --port.
  for (const [, command] of collectScripts(tree)) {
    const uv = /uvicorn[^\n]*--port\s+(\d{2,5})/.exec(command);
    if (uv?.[1]) return { value: uv[1], details: `uvicorn --port ${uv[1]} (start script)` };
    const rails = /rails\s+server\s+-p\s+(\d{2,5})/.exec(command);
    if (rails?.[1]) return { value: rails[1], details: `rails server -p ${rails[1]} (start script)` };
    const artisan = /artisan\s+serve[^\n]*--port\s*=?\s*(\d{2,5})/.exec(command);
    if (artisan?.[1]) return { value: artisan[1], details: `artisan serve --port ${artisan[1]} (start script)` };
  }
  return null;
}

/** True when the runtime is detected with existing high-confidence evidence. */
function hasFrameworkMarker(tree: FileTree): boolean {
  const names = collectDependencyNames(tree);
  const raw = [...Object.values(tree)].join('\n');
  if (names.includes('next')) return true;
  if (names.includes('@nestjs/core') || names.includes('express') || names.includes('fastify')) return true;
  if (/django|manage\.py|flask|uvicorn|fastapi|requirements\.txt/.test(raw)) return true;
  if (names.includes('rails') || /Gemfile/.test(raw)) return true;
  if (/spring-boot|spring\.framework/.test(raw)) return true;
  if (/phoenix|mix\.exs/.test(raw)) return true;
  if (/laravel|artisan/.test(raw)) return true;
  return false;
}

/** The framework's conventional default port, when the runtime is present. */
function frameworkDefaultPort(tree: FileTree): string | null {
  if (!hasFrameworkMarker(tree)) return null;
  const names = collectDependencyNames(tree);
  if (names.includes('next') || names.includes('express') || names.includes('fastify') || names.includes('@nestjs/core')) {
    return '3000';
  }
  const raw = [...Object.values(tree)].join('\n');
  if (/manage\.py/.test(raw) || /uvicorn|fastapi/.test(raw)) return '8000';
  if (/flask/.test(raw)) return '5000';
  if (/Gemfile/.test(raw)) return '3000';
  if (/spring-boot|spring\.framework/.test(raw)) return '8080';
  if (/phoenix|mix\.exs/.test(raw)) return '4000';
  if (/laravel|artisan/.test(raw)) return '8000';
  return null;
}

/**
 * Detect the application port from env files, docker-compose, the selected
 * Dockerfile, runtime literals, or — as a LAST-RESORT prefill — the detected
 * framework's conventional default. Explicit evidence always outranks the
 * default; the default is returned as `framework-default` / low confidence so
 * the deployment gate can keep refusing to auto-deploy on a guessed port.
 */
export function detectPort(tree: FileTree): DetectorFinding {
  const result = (candidate: PortCandidate, source: DetectorSource): DetectorFinding => ({
    detector: 'port',
    detected: true,
    value: candidate.value,
    details: candidate.details,
    source,
    portSource: candidate.source,
    portConfidence: candidate.confidence,
  });

  // 1. Env files (.env, .env.example) — explicit env config.
  for (const path of Object.keys(tree)) {
    if (/^\.env(\.\w+)?$/i.test(path)) {
      const match = PORT_ENV_REGEX.exec(tree[path] ?? '');
      if (match?.[1]) {
        return result(
          { value: match[1], source: 'env', confidence: 'high', details: `Port ${match[1]} detected in ${path}` },
          'env-file',
        );
      }
    }
  }

  // 2. docker-compose ${PORT:-NNNN} default.
  const dcContent = findFileContent(tree, /^docker-compose\.ya?ml$/i);
  if (dcContent) {
    const match = PORT_DOCKER_COMPOSE_REGEX.exec(dcContent);
    if (match?.[1]) {
      return result(
        { value: match[1], source: 'compose', confidence: 'high', details: `Port ${match[1]} detected in docker-compose` },
        'compose',
      );
    }
  }

  // 3. The selected Dockerfile's production stage: ENV PORT, EXPOSE, or the
  //    base image's own port.
  const dockerfile = selectedDockerfile(tree);
  const dockerfilePort = dockerfile ? runtimeDockerfilePort(dockerfile.content) : null;
  if (dockerfile && dockerfilePort) {
    return result(
      {
        value: dockerfilePort.value,
        source: dockerfilePort.source,
        confidence: 'high',
        details: `Port ${dockerfilePort.value} detected in ${dockerfile.path} (${dockerfilePort.via})`,
      },
      'dockerfile',
    );
  }

  // 4. Exactly one application service of the production Compose file publishes
  //    a port (host:container — the container side). A source default in a tree
  //    of several apps may belong to a service behind that port.
  const composeApps = composeApplicationServices(tree);
  const publishers = (composeApps?.services ?? []).filter((service) => service.ports.some((mapping) => COMPOSE_PORT_MAPPING_REGEX.test(`- ${mapping}`)));
  const publishedPort = publishers.length === 1 ? publishers[0]!.ports.map((mapping) => COMPOSE_PORT_MAPPING_REGEX.exec(`- ${mapping}`)?.[1]).find(Boolean) : undefined;
  if (publishedPort) {
    return result(
      { value: publishedPort, source: 'compose', confidence: 'high', details: `Port ${publishedPort} detected in ${composeApps!.file} (ports mapping)` },
      'compose',
    );
  }

  // 5. Source code: process.env.PORT || fallback.
  for (const [path, content] of Object.entries(tree)) {
    if (/\.(ts|js|mjs|cjs|jsx|tsx)$/.test(path) && isRuntimeSourcePath(path)) {
      const match = PORT_PROCESS_REGEX.exec(content);
      if (match?.[1]) {
        return result(
          { value: match[1], source: 'runtime-literal', confidence: 'high', details: `Default port ${match[1]} detected in ${path}` },
          'source',
        );
      }
    }
  }

  // 6. The application service's production Compose port mapping
  //    (host:container — the container side). A database, cache or proxy
  //    service's mapping is never the application's port.
  for (const mapping of composeApps?.services.flatMap((service) => service.ports) ?? []) {
    const match = COMPOSE_PORT_MAPPING_REGEX.exec(`- ${mapping}`);
    if (match?.[1]) {
      return result(
        { value: match[1], source: 'compose', confidence: 'high', details: `Port ${match[1]} detected in ${composeApps!.file} (ports mapping)` },
        'compose',
      );
    }
  }

  // 7. Runtime literals (Go/Python/Java/Ruby/PHP start commands).
  const literal = runtimeLiteralPort(tree);
  if (literal) {
    return result(
      { value: literal.value, source: 'runtime-literal', confidence: 'high', details: literal.details },
      'source',
    );
  }

  // 8. Framework default — prefill only, never silently deployable.
  const frameworkDefault = frameworkDefaultPort(tree);
  if (frameworkDefault && LITERAL_PORT.test(frameworkDefault)) {
    return result(
      {
        value: frameworkDefault,
        source: 'framework-default',
        confidence: 'low',
        details: `Framework default port ${frameworkDefault}`,
      },
      'source',
    );
  }

  return { detector: 'port', detected: false };
}

// 4. Health endpoint
// ---------------------------------------------------------------------------

// Route registrations, including the prefixed forms a real application uses:
// `/health`, `/healthz`, `/api/health`, `/api/v1/healthcheck`. The receiver
// group (what precedes `.get(`) feeds mount composition; the path group is
// the detector's normalized `path`. Neither group changes which strings
// match — `get(` with no receiver still matches.
// The path group is anchored to the closing quote/backtick (backreference to
// whichever one opened the literal) so the FULL literal is captured, not just
// up to the first health keyword — `/health/live` no longer truncates to
// `/health`. A `/segment` after the keyword only extends the capture when it
// starts with a slash, so `/healthful` (keyword glued to more word chars)
// still does not match.
const HEALTH_ROUTE_REGEX =
  /([A-Za-z_$][\w$]*)?\s*\.?\s*(?:get|post|put|all|route)\s*\(.*?(['"`])([\w/-]*\/(?:health|healthz|healthcheck|heartbeat|readyz|livez|up|status|ping|alive|_health)(?:\/[\w-]*)*)\2/gi;
const HEALTH_ROUTE_OBJECT_REGEX =
  /\burl:\s*(['"`])(\/[\w/-]*\/?(?:health|healthz|healthcheck|heartbeat|livez|up|status|ping|alive|_health)(?:\/[\w-]*)*)\1/g;
const HEALTH_HTTP_ADAPTER_REGEX =
  /\.getHttpAdapter\(\)\..*?(['"`])([\w/-]*\/(?:health|healthz|healthcheck|heartbeat|readyz|livez|up|status|ping|alive|_health)(?:\/[\w-]*)*)\1/;
const HEALTH_SCRIPT_REGEX = /^healthcheck$/i;
// File-based routing (Next.js, Remix, Nuxt, SvelteKit) declares the path in
// the FILE NAME, so there is no route string to match: `api/health.ts`,
// `app/api/health/route.ts`, `pages/api/healthz.js`, Remix v2 dot routes
// (`api.health.ts`), where `.` rather than `/` separates segments.
const HEALTH_ROUTE_FILE_REGEX =
  /(?:^|[/.])(?:health|healthz|healthcheck|heartbeat)(?:\.[jt]sx?|\/(?:route|index|\+server)\.[jt]sx?)$/i;
// Router-root directories: the file-based routers above never let these
// appear in the served URL. Keeping only the segments after the LAST one
// drops monorepo prefixes (`apps/remix/app/routes/...` -> `...`).
const ROUTER_ROOT_DIRS = new Set(['routes', 'pages', 'app']);
// Router mounts: `app.use('/api', router)` / `apiRouter.use('/v1', v1Router)`.
// The prefix is as literal as a route string, so composing mount prefix +
// route path yields the path the app actually serves.
const ROUTER_MOUNT_REGEX =
  /([A-Za-z_$][\w$]*)\s*\.\s*use\s*\(\s*['"`](\/[\w/-]*)['"`]\s*,\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)/g;

// Priority for resolving a single normalized `path` when more than one
// signal names one: an exact route registration (or NestJS adapter call) in
// source code names the literal path the app actually serves, so it
// outranks a path only INFERRED from a file-based router convention
// (Next.js/Remix/SvelteKit). A Dockerfile HEALTHCHECK / package.json
// "healthcheck" script only prove a check exists — the CMD text can be
// stale (the audited repo's Dockerfile still curled /health after the app
// moved its route to /api/health), so they never produce a path candidate.
const HEALTH_PATH_PRIORITY = {
  ROUTE_REGISTRATION: 0,
  FILE_ROUTE: 1,
  // A URL inside a Dockerfile HEALTHCHECK / Compose healthcheck names the
  // path the image's own check probes — real evidence, but it can lag a
  // moved route, so it ranks below anything found in code (Stage A COMP-005).
  HEALTHCHECK_URL: -1,
  // The framework's standard route (Spring Actuator), used when no route is declared.
  FRAMEWORK_STANDARD: 2,
} as const;
const HEALTH_PATH_SEGMENT_REGEX = /(?:^|\/)(?:health|healthz|healthcheck|heartbeat|readyz|livez|up|status|ping|alive|_health)$/i;
// A health URL in a container/compose health check: `curl -f http://localhost:3000/api/heartbeat`.
// The host is the container itself (localhost, a loopback/any address, or a
// `$VAR`), never a documentation link that happens to sit on the same line.
const HEALTHCHECK_URL_REGEX =
  /(?:https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\$\{?[\w:-]+\}?)|(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+)(?::\$?\{?[\w:-]+\}?)?(?:\{[^}\s]*\})?(\/[\w./-]*)?(?=["'\s?#]|$)/;
// A HEALTHCHECK that runs a script shipped in the image (`CMD node
// healthcheck.js`) names its URL inside that script (Stage A COMP-034).
const HEALTHCHECK_SCRIPT_REGEX = /[\w./-]+\.(?:[cm]?js|sh|py|rb)\b/g;
// Route registrations in Go, Python, Ruby, PHP, .NET, Elixir, Rails and JVM
// name their path as a plain string literal on the registering call:
// `HandleFunc("GET /healthcheck", …)`, `app.Get("/health", …)`,
// `@app.route('/health')`, `path('health/', …)`, `get '/up'`,
// `Route::get('/up')`, `MapGet("/health", …)`, `@GetMapping("/x")`.
// Only literals whose LAST segment is a well-known health name count.
const HEALTH_ROUTE_LITERAL_REGEX =
  /(HandleFunc|Handle|GET|Get|get|Post|post|Put|put|Route|Router|Map|path|add_url_rule|url|GetMapping|RequestMapping|value)\s*(?:\(|::)?\s*["'](?:(?:GET|HEAD|POST)\s+)?(\/?(?:[\w.-]+\/)*(?:health|healthz|healthcheck|heartbeat|readyz|livez|up|status|ping|alive|_health))\/?["']/gi;
export const LANGUAGE_SOURCE_REGEX = /\.(?:go|py|rb|php|cs|java|kt|kts|scala|ex|exs)$/i;

/** Ensure a captured/derived health path starts with a leading slash. */
function normalizeHealthPath(raw: string): string {
  return raw.startsWith('/') ? raw : `/${raw}`;
}

/**
 * Derive the URL path a file-based health-check ROUTE FILE implies, mirroring
 * how a file location maps to a URL for Next.js (app-router
 * `app/api/health/route.ts`, pages-router `pages/api/health.ts`), Remix flat
 * routes (`api+/health.ts`, dot routes `api.health.ts`), and SvelteKit
 * (`routes/api/health/+server.ts`). `routes`, `pages`, and `app` are
 * router-root directories: only the segments AFTER the LAST one survive, so a
 * monorepo prefix like `apps/remix/app/` never leaks into the path. Once an
 * `api` segment is seen, everything from there on is literal.
 */
function deriveHealthPathFromFile(filePath: string): string {
  const trimmed = filePath.replace(/\.[jt]sx?$/, '').replace(/\/(?:route|index|\+server)$/, '');
  let segments = trimmed.split('/').filter(Boolean);

  let rootIndex = -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (segment !== undefined && ROUTER_ROOT_DIRS.has(segment)) {
      rootIndex = i;
      break;
    }
  }
  segments =
    rootIndex === -1 ? segments.filter((s) => !ROUTER_ROOT_DIRS.has(s) && s !== 'src') : segments.slice(rootIndex + 1);

  // Normalise framework segment conventions: drop the remix-flat-routes `+`
  // folder marker, split dot-delimited segments (Remix v2 flat files), and
  // drop pathless layout/group segments.
  segments = segments
    .flatMap((s) => s.replace(/\+$/, '').split('.'))
    .filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('_'));

  const apiIndex = segments.indexOf('api');
  const relevant = apiIndex === -1 ? segments : segments.slice(apiIndex);
  return `/${relevant.join('/')}`;
}

/**
 * Compose the mount chain a router route hangs from: `router.get('/health')`
 * mounted by `app.use('/api', router)` serves `/api/health`. Walks mounts by
 * variable identity until a receiver nothing mounts (typically `app`), with a
 * cycle guard. Returns undefined when the receiver sits on no mount — the
 * route string is then already the full path (`app.get('/health')`), or its
 * mount simply was not found and the raw path is the honest fallback.
 */
function composeMountedPath(
  receiver: string | undefined,
  routePath: string,
  mounts: { mounter: string; prefix: string; router: string }[],
): string | undefined {
  if (receiver === undefined) return undefined;
  let path = routePath;
  let current: string | undefined = receiver;
  const seen = new Set<string>();
  let composed = false;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    // A router mounted twice (`/api/v2` and `/api`) is served at both: the shortest prefix is deterministic.
    const mount = mounts.filter((candidate) => candidate.router === current).sort((a, b) => a.prefix.length - b.prefix.length)[0];
    if (!mount) break;
    // `app.use('/', router)` is a root mount — joining must not double the slash.
    path = `${mount.prefix.replace(/\/+$/, '')}${path}`;
    composed = true;
    current = mount.mounter;
  }
  return composed ? path : undefined;
}

// ── Stage B phase 5 (COMP-005): Spring Boot helpers ─────────────────────────

/** `server.servlet.context-path` from application.properties/yml, when literal. */
function findSpringContextPath(tree: FileTree): string {
  for (const [path, content] of Object.entries(tree)) {
    if (!content || !/(?:^|\/)application\.(?:properties|ya?ml)$/i.test(path)) continue;
    const flat = /server\.servlet\.context-path\s*[:=]\s*"?(\/[^\s"#]*)["]?/.exec(content);
    if (flat?.[1]) return flat[1];
    // application.yml nests the key: `context-path: /svc` under `servlet:`.
    const nested = /^\s*context-path\s*:\s*"?(\/[^\s"#]*)["]?/m.exec(content);
    if (nested?.[1]) return nested[1];
  }
  return '';
}

/**
 * Whether Spring Actuator's web exposure still serves health. Only an
 * EXPLICIT configuration that excludes health disables it — the default
 * (health exposed) stays enabled.
 */
function findActuatorExposure(tree: FileTree): 'enabled' | 'excluded' {
  for (const [path, content] of Object.entries(tree)) {
    if (!content || !/(?:^|\/)application\.(?:properties|ya?ml)$/i.test(path)) continue;
    const includeMatch = /management\.endpoints\.web\.exposure\.include\s*[:=]\s*"?([^"\s#]*)["]?/.exec(content);
    const excludeMatch = /management\.endpoints\.web\.exposure\.exclude\s*[:=]\s*"?([^"\s#]*)["]?/.exec(content);
    const included = includeMatch?.[1] ?? '';
    const excluded = excludeMatch?.[1] ?? '';
    if (excluded.includes('health')) return 'excluded';
    if (included.length > 0 && !included.includes('health') && !included.includes('*')) return 'excluded';
  }
  return 'enabled';
}

// The prefix segments a dedicated health route may sit behind: an API root, a
// version, or a namespace such as `system` (`/api/v4/system/ping`).
const HEALTH_PREFIX_SEGMENT_REGEX = /^(?:api|v\d+(?:\.\d+)*|system|internal|backend|server|management|public)$/i;
const HEALTH_WORD_REGEX = /^(?:health|healthz|healthcheck|health-check|health_check|heartbeat|ping|alive|up|_health)$/i;
const HEALTH_PROBE_WORD_REGEX = /^(?:live|liveness|ready|readiness|alive|status)$/i;
const HEALTH_GROUP_WORD_REGEX = /^(?:health|healthz|healthcheck)$/i;

/**
 * Whether a route path is a dedicated health endpoint rather than a feature
 * route that happens to end in a health word (`/csv/status`,
 * `/v1/integrations/status`, `/api/v1/ai/health`). The last segment must be a
 * health word, and only API roots, versions and a namespace may precede it.
 * `status` is too common a feature name to stand alone behind a namespace; it
 * counts only directly under an API root, or under `/` in a JS server whose
 * routes are written out in full. `readyz` and `livez` are orchestrator
 * probes that apps often serve on a separate management listener, so they
 * never prove a route on the public port.
 */
function isDedicatedHealthPath(path: string, options: { relativeFramework?: boolean; bareStatus?: boolean } = {}): boolean {
  const segments = path.split(/[?#]/)[0]!.split('/').filter(Boolean);
  const last = segments.pop()?.toLowerCase();
  if (last === undefined) return false;
  if (last === 'status' && !HEALTH_GROUP_WORD_REGEX.test(segments.at(-1) ?? '')) {
    return !options.relativeFramework && (segments.length > 0 || options.bareStatus === true) && segments.every((segment) => /^(?:api|v\d+)$/i.test(segment));
  }
  if (HEALTH_PROBE_WORD_REGEX.test(last) && segments.length > 0 && HEALTH_GROUP_WORD_REGEX.test(segments.at(-1)!)) {
    segments.pop();
  } else if (!HEALTH_WORD_REGEX.test(last)) {
    return false;
  }
  return segments.every((segment) => HEALTH_PREFIX_SEGMENT_REGEX.test(segment));
}

/** The paths a health check command (or the script it runs) requests on the container itself. */
function probedUrlPaths(text: string): string[] {
  return [...text.matchAll(new RegExp(HEALTHCHECK_URL_REGEX.source, 'g'))].map((match) => match[1] ?? '/');
}

/**
 * The URL path a container health check probes, read from its command or the
 * script it runs. Null when it names no URL, or several different ones (a
 * script that checks more than one service).
 */
function healthcheckProbePath(command: string, tree: FileTree): string | null {
  let paths = probedUrlPaths(command);
  for (const script of command.match(HEALTHCHECK_SCRIPT_REGEX) ?? []) {
    if (paths.length > 0) break;
    const basename = script.split('/').pop() ?? script;
    const file = Object.keys(tree).find((path) => path === script || path.endsWith(`/${basename}`) || path === basename);
    if (file) paths = probedUrlPaths(tree[file] ?? '');
  }
  const distinct = [...new Set(paths)];
  return distinct.length === 1 ? distinct[0]! : null;
}

const SOURCE_FILE_RUNTIMES: [RegExp, RuntimeFamily][] = [
  [/\.[cm]?[jt]sx?$/, 'node'],
  [/\.py$/, 'python'],
  [/\.go$/, 'go'],
  [/\.(?:java|kt|kts|scala)$/, 'jvm'],
  [/\.php$/, 'php'],
  [/\.rb$/, 'ruby'],
  [/\.cs$/, 'dotnet'],
  [/\.exs?$/, 'elixir'],
  [/\.rs$/, 'rust'],
];
const START_COMMAND_RUNTIMES: [RegExp, RuntimeFamily][] = [
  [/\b(?:node|npm|npx|yarn|pnpm|bun|tsx|deno)\b/i, 'node'],
  [/\b(?:python3?|gunicorn|uvicorn|hypercorn|daphne|flask|celery|poetry)\b|manage\.py/i, 'python'],
  [/\bjava\b|\.jar\b/i, 'jvm'],
  [/\b(?:php|php-fpm|apache2-foreground|apache2ctl)\b/i, 'php'],
  [/\b(?:bundle|rails|puma|unicorn|ruby)\b/i, 'ruby'],
  [/\bdotnet\b/i, 'dotnet'],
];

/**
 * The one runtime the production stage starts, read from its CMD/ENTRYPOINT
 * and the shell script that command runs; null when the command names none
 * or several (a compiled binary, a script that starts a node and a go process).
 */
function startedRuntime(tree: FileTree, runtimeText: string): RuntimeFamily | null {
  const text = startCommandText(tree, runtimeText);
  const families = new Set(START_COMMAND_RUNTIMES.filter(([pattern]) => pattern.test(text)).map(([, family]) => family));
  return families.size === 1 ? [...families][0]! : null;
}

/** What the production stage runs at start: its CMD/ENTRYPOINT, the shell script and the package scripts that command runs. */
function startCommandText(tree: FileTree, runtimeText: string): string {
  let text = runtimeText
    .split('\n')
    .filter((line) => /^\s*(?:CMD|ENTRYPOINT)\b/i.test(line))
    .map((line) => execFormToShell(line.replace(/^\s*(?:CMD|ENTRYPOINT)\s+/i, '')))
    .join('\n');
  for (const script of text.match(/[\w./-]+\.sh\b/g) ?? []) {
    const basename = script.split('/').pop() ?? script;
    const file = Object.keys(tree).find((path) => path === basename || path.endsWith(`/${basename}`));
    if (file) text += `\n${tree[file] ?? ''}`;
  }
  const scripts = collectScripts(tree);
  for (const [, name] of text.matchAll(/\b(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?([\w:-]+)/g)) {
    text += `\n${scripts.find(([key]) => key === name)?.[1] ?? ''}`;
  }
  return text;
}

/**
 * Whether the selected Dockerfile's start command already runs the worker
 * next to the web process (`concurrently "next start" "tsx worker.ts"`, a
 * start script that runs both): a second worker workload would run it twice.
 */
export function mainCommandRunsWorker(tree: FileTree): boolean {
  const dockerfile = selectedDockerfile(tree);
  if (!dockerfile) return false;
  let text = startCommandText(tree, productionStageText(dockerfile.content));
  // A process manager config the start path names (`supervisord -c supervisord-tasks.conf`) runs its programs too.
  for (const config of text.match(/[\w./-]+\.(?:conf|ini)\b/g) ?? []) {
    const basename = config.split('/').pop() ?? config;
    const file = Object.keys(tree).find((path) => path === basename || path.endsWith(`/${basename}`));
    if (file) text += `\n${tree[file] ?? ''}`;
  }
  return (
    (/\b(?:concurrently|npm-run-all|run-p|honcho|foreman|overmind|supervisord|pm2)\b/.test(text) && /\bworkers?\b/i.test(text)) ||
    WORKER_COMMAND_REGEX.test(text)
  );
}

/** The app or package a source file belongs to: the nearest directory above it that holds a dependency manifest. */
function sourceGroup(tree: FileTree, path: string): string {
  const files = Object.keys(tree);
  for (let dir = path.split('/').slice(0, -1); dir.length > 0; dir = dir.slice(0, -1)) {
    const prefix = `${dir.join('/')}/`;
    if (files.some((file) => file.startsWith(prefix) && !file.slice(prefix.length).includes('/') && isDependencyManifest(file))) {
      return prefix;
    }
  }
  return '';
}

/**
 * Detect the health endpoint. In order of trust: the probe of the selected
 * Dockerfile's HEALTHCHECK or of a production Compose app service; an exact
 * dedicated route registered by the application (with its framework prefix
 * and version); the framework's standard route. A route that is not served by
 * the image the selected Dockerfile starts, or that two apps both register, is
 * never a confident answer — the detector reports nothing and the vendor is asked.
 */
export function detectHealthEndpoint(tree: FileTree): DetectorFinding {
  interface HealthCandidate {
    path: string;
    priority: number;
    source: DetectorSource;
    label: string;
    file?: string;
  }
  const candidates: HealthCandidate[] = [];
  const addCandidate = (candidate: HealthCandidate, options?: { relativeFramework?: boolean }): void => {
    const bareStatus = candidate.file !== undefined && /\.[cm]?[jt]sx?$/.test(candidate.file);
    if (candidate.priority < 0 || isDedicatedHealthPath(candidate.path, { ...options, bareStatus })) candidates.push(candidate);
  };

  // 0. Router mounts, collected first because a mount and the routes it
  // carries usually live in different files.
  const mounts: { mounter: string; prefix: string; router: string; file: string }[] = [];
  // `module.exports = { api: apiRouter }` lets a mount name the router by its export key (`routes.api`).
  const exportedRouters = new Map<string, string>();
  for (const [path, content] of Object.entries(tree)) {
    if (!/\.(ts|js|mjs|cjs|jsx|tsx)$/.test(path) || !content) continue;
    for (const exported of content.matchAll(/module\.exports\s*=\s*\{([^}]*)\}/g)) {
      for (const [, key, value] of (exported[1] ?? '').matchAll(/([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/g)) {
        if (key && value) exportedRouters.set(key, value);
      }
    }
  }
  for (const [path, content] of Object.entries(tree)) {
    if (!/\.(ts|js|mjs|cjs|jsx|tsx)$/.test(path) || !content) continue;
    for (const match of content.matchAll(ROUTER_MOUNT_REGEX)) {
      if (match[1] && match[2] && match[3]) {
        const member = match[3].split('.');
        const router = member.length === 2 ? (exportedRouters.get(member[1]!) ?? match[3]) : match[3];
        mounts.push({ mounter: match[1], prefix: match[2], router, file: path });
      }
    }
  }

  // 0b. A router mounted at a health prefix (`apiRouter.use('/health', router)`)
  //     registers that path whatever the inner routes are called — when the
  //     mounting router itself is mounted somewhere known, or is the app.
  for (const mount of mounts) {
    if (!HEALTH_PATH_SEGMENT_REGEX.test(mount.prefix)) continue;
    const composed = composeMountedPath(mount.mounter, mount.prefix, mounts);
    if (composed === undefined && !/^(?:app|server|application|fastify|instance)$/i.test(mount.mounter)) continue;
    addCandidate({
      path: composed ?? mount.prefix,
      priority: HEALTH_PATH_PRIORITY.ROUTE_REGISTRATION,
      source: 'source',
      label: `health router mount (${mount.prefix})`,
      file: mount.file,
    });
  }

  // 1. The selected Dockerfile's HEALTHCHECK instruction — the image Deployz
  //    builds, in its production stage, not a sibling dev/packaging image.
  const dockerfile = selectedDockerfile(tree);
  const runtimeText = dockerfile ? productionStageText(dockerfile.content) : '';
  const healthcheckLine = runtimeText
    .split('\n')
    .filter((line) => /^\s*HEALTHCHECK\b/i.test(line) && !/^\s*HEALTHCHECK\s+NONE\b/i.test(line))
    .at(-1);
  let probedPath = healthcheckLine === undefined ? null : healthcheckProbePath(healthcheckLine, tree);
  // A multi-target Dockerfile may put the HEALTHCHECK on a sibling target (`web`), not on the last
  // stage (`cli`): use the HEALTHCHECK lines of the whole file only when every one probes one path.
  if (healthcheckLine === undefined && dockerfile) {
    const probes = new Set(
      dockerfile.content
        .split('\n')
        .filter((line) => /^\s*HEALTHCHECK\b/i.test(line) && !/^\s*HEALTHCHECK\s+NONE\b/i.test(line))
        .map((line) => healthcheckProbePath(line, tree)),
    );
    if (probes.size === 1 && !probes.has(null)) probedPath = [...probes][0]!;
  }
  if (probedPath !== null) {
    addCandidate({ path: probedPath, priority: HEALTH_PATH_PRIORITY.HEALTHCHECK_URL, source: 'dockerfile', label: 'HEALTHCHECK (Dockerfile)' });
  }

  // 1b. A production Compose application service's healthcheck that probes a URL.
  for (const service of composeApplicationServices(tree)?.services ?? []) {
    const healthcheck = /healthcheck:[\s\S]*?test:[^\n]*/.exec(service.body)?.[0] ?? '';
    const composePath = healthcheckProbePath(healthcheck, tree);
    if (composePath !== null) {
      addCandidate({ path: composePath, priority: HEALTH_PATH_PRIORITY.HEALTHCHECK_URL, source: 'compose', label: `healthcheck (${service.name})` });
      break;
    }
  }

  // 1c. A package.json "healthcheck" script that probes a URL.
  for (const [name, command] of collectScripts(tree)) {
    const scriptPath = HEALTH_SCRIPT_REGEX.test(name) ? healthcheckProbePath(command, tree) : null;
    if (scriptPath !== null) {
      addCandidate({
        path: scriptPath,
        priority: HEALTH_PATH_PRIORITY.HEALTHCHECK_URL,
        source: 'package-manifest',
        label: `healthcheck (package.json script "${name}")`,
      });
    }
  }

  // 1d. Route registrations across frameworks (Go/Python/Ruby/PHP/.NET/JVM/
  //     Elixir/Rails) name their health route as a plain string literal.
  //     A declaration must exist; a name is never assumed on its own.
  const actuatorDependency = Object.entries(tree).some(
    ([path, content]) =>
      content &&
      /(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?)$/.test(path) &&
      /spring-boot(?:-starter)?-actuator/.test(content),
  );
  // Spring Boot Actuator: /actuator/health when the dependency exists and the
  // exposure config does not exclude health. It ranks BELOW an explicit route
  // declaration in code — a controller that maps its own health path wins.
  const hasJvmSource = Object.keys(tree).some((path) => /\.(?:java|kt|kts|scala)$/.test(path) && isRuntimeSourcePath(path));
  if (actuatorDependency && hasJvmSource && findActuatorExposure(tree) !== 'excluded') {
    candidates.push({
      path: `${findSpringContextPath(tree)}/actuator/health`,
      priority: HEALTH_PATH_PRIORITY.FRAMEWORK_STANDARD,
      source: 'source',
      label: 'actuator health (spring-boot-actuator)',
    });
  }
  for (const [path, content] of Object.entries(tree)) {
    if (!LANGUAGE_SOURCE_REGEX.test(path) || !content || !isRuntimeSourcePath(path)) continue;

    // Phoenix routes are read below, inside their `scope`.
    if (/\.exs?$/.test(path)) continue;
    // Class-level @RequestMapping("/api/v1") or (value = "/api") prefixes a controller's methods.
    const javaPrefixes: string[] = [];
    if (/\.(?:java|kt)$/.test(path)) {
      for (const m of content.matchAll(/@RequestMapping\(\s*(?:(?:value|path)\s*=\s*)?\{?\s*["'](\/[^"']+)["']/g)) {
        if (m[1] && !HEALTH_PATH_SEGMENT_REGEX.test(m[1])) javaPrefixes.push(m[1]);
      }
    }

    for (const match of content.matchAll(HEALTH_ROUTE_LITERAL_REGEX)) {
      const [, call, raw] = match;
      if (!raw) continue;
      // A call on a nested router object (`api.BaseRoutes.System.Handle("/ping")`)
      // registers a path relative to a prefix this file does not show.
      if (/[\w$]+\.[\w$]+\.[\w$]+\.\s*$/.test(content.slice(Math.max(0, (match.index ?? 0) - 80), match.index))) continue;
      // Only Django's `path('health/')` and Ruby's `get "up"` name a route
      // without its leading slash; elsewhere a slash-less literal is a query
      // parameter or a map key (`.Get("status")`).
      const djangoCall = /^(?:path|re_path|url|add_url_rule)$/i.test(call ?? '');
      if (!raw.startsWith('/') && !djangoCall && !path.endsWith('.rb')) continue;
      // An included Django urlconf (`app_name = …`) is mounted under a prefix this file does not show.
      if (djangoCall && /^\s*app_name\s*=/m.test(content)) continue;
      let routePath = raw.startsWith('/') ? raw : `/${raw}`;
      // Laravel API routes are served under /api; the file says so.
      if (/(?:^|\/)routes\/api\.php$/i.test(path) && !routePath.startsWith('/api')) {
        routePath = `/api${routePath}`;
      }
      if (javaPrefixes.length > 0 && !routePath.startsWith(javaPrefixes[0]!)) {
        routePath = `${javaPrefixes[0]!.replace(/\/+$/, '')}${routePath}`;
      }
      addCandidate(
        { path: routePath, priority: HEALTH_PATH_PRIORITY.ROUTE_REGISTRATION, source: 'source', label: `health route (${path})`, file: path },
        { relativeFramework: djangoCall },
      );
    }
  }

  // Go middleware that special-cases a health path: `r.URL.Path == "/healthz"`.
  for (const [path, content] of Object.entries(tree)) {
    if (!/\.go$/.test(path) || !content || !isRuntimeSourcePath(path)) continue;
    for (const match of content.matchAll(/\.URL\.Path\s*==\s*"(\/[\w/-]*)"/g)) {
      if (!HEALTH_PATH_SEGMENT_REGEX.test(match[1]!)) continue;
      addCandidate({ path: match[1]!, priority: HEALTH_PATH_PRIORITY.ROUTE_REGISTRATION, source: 'source', label: `health path check (${path})`, file: path });
    }
  }

  // ── Phoenix (Elixir): routes are declared inside `scope "/api/v1" do` ────
  for (const [path, content] of Object.entries(tree)) {
    if (!/\.(?:ex|exs)$/.test(path) || !content || !isRuntimeSourcePath(path)) continue;
    const lines = content.split('\n');
    for (const match of content.matchAll(/\b(?:get|post)\s+["'](\/[^"']*)["']/g)) {
      const raw = match[1]!;
      if (!HEALTH_PATH_SEGMENT_REGEX.test(raw)) continue;
      const routePath = `${phoenixScopePrefix(lines, content.slice(0, match.index).split('\n').length - 1)}${raw}`;
      addCandidate({ path: routePath, priority: HEALTH_PATH_PRIORITY.ROUTE_REGISTRATION, source: 'source', label: `health route (${path})`, file: path });
    }
  }

  // ── NestJS: `@Controller('health')` with an empty `@Get()`, under the
  //    literal `app.setGlobalPrefix('api')` and URI `enableVersioning` of the
  //    bootstrap file. ──
  let nestGlobalPrefix = '';
  let nestPrefixOptions = '';
  let nestDefaultVersion = '';
  for (const [path, content] of Object.entries(tree)) {
    if (!/\.ts$/.test(path) || !content || !isRuntimeSourcePath(path)) continue;
    const prefix = /\.setGlobalPrefix\(\s*['"]([^'"/]+)['"]([^;]*)/.exec(content);
    if (!prefix?.[1]) continue;
    nestGlobalPrefix = `/${prefix[1]}`;
    nestPrefixOptions = prefix[2] ?? '';
    nestDefaultVersion =
      /enableVersioning\(\s*\{(?=[^}]*VersioningType\.URI)[^}]*defaultVersion:\s*\[?\s*['"](\d+)['"]/.exec(content)?.[1] ?? '';
    break;
  }
  for (const [path, content] of Object.entries(tree)) {
    if (!/\.ts$/.test(path) || !content || !isRuntimeSourcePath(path)) continue;
    const controller = /@Controller\(\s*(?:\{\s*path:\s*)?['"]([^'"]+)['"]/.exec(content)?.[1];
    if (!controller) continue;
    const controllerPath = `/${controller.replace(/^\/+/, '')}`;
    // `@Get()` serves the controller path; `@Get('ping')` serves a sub-path of it.
    const getPaths = [...content.matchAll(/@Get\(\s*(?:['"]([\w/-]*)['"])?\s*\)/g)].map((m) => {
      const sub = (m[1] ?? '').replace(/^\/+/, '');
      return sub ? `${controllerPath}/${sub}` : controllerPath;
    });
    const routePath = getPaths.find((candidate) => HEALTH_PATH_SEGMENT_REGEX.test(candidate));
    if (routePath === undefined) continue;
    const prefix = nestPrefixOptions.includes(`'${controller}'`) ? '' : nestGlobalPrefix;
    const version = /VERSION_NEUTRAL|\bversion:/.test(content) || !nestDefaultVersion ? '' : `/v${nestDefaultVersion}`;
    addCandidate({
      path: `${prefix}${version}${routePath}`,
      priority: HEALTH_PATH_PRIORITY.ROUTE_REGISTRATION,
      source: 'source',
      label: `NestJS health controller (${path})`,
      file: path,
    });
  }

  // 3. Route patterns in source code, or a file-based route path
  for (const [path, content] of Object.entries(tree)) {
    if (!/\.(ts|js|mjs|cjs|jsx|tsx)$/.test(path)) continue;
    // Only a file inside a file-based router (`routes`, `pages`, `app`, or
    // an `api` segment) declares a URL by its name; a model or controller
    // called `heartbeat.js` does not (Stage A COMP-004).
    if (
      HEALTH_ROUTE_FILE_REGEX.test(path) &&
      path.split('/').some((segment) => ROUTER_ROOT_DIRS.has(segment) || segment === 'api')
    ) {
      addCandidate({ path: deriveHealthPathFromFile(path), priority: HEALTH_PATH_PRIORITY.FILE_ROUTE, source: 'source', label: `health route file (${path})`, file: path });
    }
    // The first dedicated health route of a file wins (`/health/live` before `/health/ready`).
    for (const routeMatch of content.matchAll(HEALTH_ROUTE_REGEX)) {
      if (!routeMatch[3]) continue;
      const before = candidates.length;
      addCandidate({
        path: composeMountedPath(routeMatch[1], normalizeHealthPath(routeMatch[3]), mounts) ?? normalizeHealthPath(routeMatch[3]),
        priority: HEALTH_PATH_PRIORITY.ROUTE_REGISTRATION,
        source: 'source',
        label: `/health route (${path})`,
        file: path,
      });
      if (candidates.length > before) break;
    }
    // Fastify route objects: `{ method: 'GET', url: '/api/status' }`.
    if (/fastify/i.test(content)) {
      for (const routeObject of content.matchAll(HEALTH_ROUTE_OBJECT_REGEX)) {
        addCandidate({ path: routeObject[2]!, priority: HEALTH_PATH_PRIORITY.ROUTE_REGISTRATION, source: 'source', label: `/health route (${path})`, file: path });
      }
    }
    const adapterMatch = HEALTH_HTTP_ADAPTER_REGEX.exec(content);
    if (adapterMatch?.[2]) {
      addCandidate({ path: normalizeHealthPath(adapterMatch[2]), priority: HEALTH_PATH_PRIORITY.ROUTE_REGISTRATION, source: 'source', label: `/health adapter (${path})`, file: path });
    }
  }

  // A route the selected Dockerfile's image does not start (a go sidecar next
  // to a node server) or that two apps of the repository both register is not
  // a confident answer.
  const started = dockerfile ? startedRuntime(tree, runtimeText) : null;
  const scoped = candidates.filter((candidate) => {
    if (candidate.file === undefined || started === null) return true;
    const language = SOURCE_FILE_RUNTIMES.find(([pattern]) => pattern.test(candidate.file!))?.[1];
    return language === undefined || language === started;
  });
  const routeGroups = new Set(scoped.flatMap((candidate) => (candidate.file === undefined ? [] : [sourceGroup(tree, candidate.file)])));
  // Behind a web server that fronts the app on port 80 (an all-in-one image),
  // the app's own routes sit under a proxy prefix the source does not show.
  const fronted = FRONT_SERVER_REGEX.test(runtimeText) && exposedPorts(runtimeText).includes('80');
  // Several apps register a route: only the one the start command names is the image's.
  const startText = routeGroups.size > 1 ? startCommandText(tree, runtimeText) : '';
  const namedGroups = [...routeGroups].filter((group) => group !== '' && startText.includes(group.slice(0, -1)));
  const confident = scoped.filter((candidate) => {
    if (candidate.file === undefined) return true;
    if (fronted) return false;
    return routeGroups.size <= 1 || (namedGroups.length === 1 && sourceGroup(tree, candidate.file) === namedGroups[0]);
  });

  if (confident.length === 0) {
    return { detector: 'health-endpoint', detected: false };
  }

  // The most specific candidate wins (lowest priority number); on an equal
  // priority the longer path wins — when a repo both registers `/health`
  // directly and mounts a health router under `/api`, the longer mounted
  // path is the one the app actually serves at that URL.
  const best = confident.reduce((winner, candidate) => {
    if (candidate.priority < winner.priority) return candidate;
    if (candidate.priority === winner.priority && candidate.path.length > winner.path.length) return candidate;
    return winner;
  });
  const sources = confident.map((candidate) => candidate.label);

  return {
    detector: 'health-endpoint',
    detected: true,
    value: sources,
    details: `Health endpoint detected via: ${sources.join('; ')}`,
    path: best.path,
    // `/` is a ROOT check (the app's own HEALTHCHECK probes the home page) —
    // never treated as an explicit health route.
    mode: best.path === '/' ? 'root' : 'explicit',
    source: best.source,
  };
}

// 5. Env vars
// ---------------------------------------------------------------------------

const ENV_VAR_REGEX = /^([A-Z_][A-Z0-9_]*)\s*[=:]/gm;
const PROCESS_ENV_REGEX = /process\.env\.(\w+)/g;

/**
 * Detect environment variables from .env files, docker-compose, and source code.
 * Returns deduplicated list of env var names.
 */
export function detectEnvVars(tree: FileTree): DetectorFinding {
  const vars = new Set<string>();

  // 1. .env / .env.example files (KEY=VALUE or KEY: VALUE)
  for (const path of Object.keys(tree)) {
    if (/^\.env(\.\w+)?$/i.test(path)) {
      const content = tree[path];
      if (!content) continue;
      let match: RegExpExecArray | null;
      while ((match = ENV_VAR_REGEX.exec(content)) !== null) {
        if (match[1]) vars.add(match[1]);
      }
    }
  }

  // 2. docker-compose.yml environment section
  const dcContent = findFileContent(tree, /^docker-compose\.ya?ml$/i);
  if (dcContent) {
    let match: RegExpExecArray | null;
    while ((match = ENV_VAR_REGEX.exec(dcContent)) !== null) {
      if (match[1]) vars.add(match[1]);
    }
  }

  // 3. Source code: process.env.X references, and `env.X` / `env['X']` in a
  //    module that reads through a local env object (DEPLOY-005).
  for (const [path, content] of Object.entries(tree)) {
    if (/\.(ts|js|mjs|cjs|jsx|tsx)$/.test(path)) {
      let match: RegExpExecArray | null;
      // Reset lastIndex by creating a new regex each time
      const regex = new RegExp(PROCESS_ENV_REGEX.source, 'g');
      while ((match = regex.exec(content)) !== null) {
        if (match[1]) vars.add(match[1]);
      }
      if (readsThroughEnvObject(content)) {
        const objectRegex = new RegExp(CONFIG_ENV_READ_SOURCE, 'g');
        while ((match = objectRegex.exec(content)) !== null) {
          const key = match[1] ?? match[2];
          if (key) vars.add(key);
        }
      }
    } else if (GO_SOURCE.test(path) && content) {
      for (const key of scanViperEnvKeys(content)) vars.add(key);
    }
  }

  const varlist = [...vars].sort();
  if (varlist.length === 0) {
    return { detector: 'env-vars', detected: false };
  }

  return {
    detector: 'env-vars',
    detected: true,
    value: varlist,
    details: `${varlist.length} environment variable(s) detected`,
  };
}

// 6. PostgreSQL usage
// ---------------------------------------------------------------------------

const PG_DRIVERS = ['pg', 'postgres', 'drizzle-orm', 'knex'] as const;

// `knex`/`drizzle-orm` are dialect-agnostic query builders/ORMs — they prove
// nothing about which SQL engine is wired up (Stage A COMP-002). Exported so
// `rejection.ts`'s `engineIsConfigurable` shares this exact set rather than
// keeping a second copy that could drift out of sync.
export const DIALECT_AGNOSTIC_DRIVERS = new Set(['knex', 'drizzle-orm']);

// Mirrors rejection.ts's `MYSQL_DEPS` — a dialect-agnostic ORM alongside a
// MySQL driver is MySQL evidence, not PostgreSQL evidence.
const MYSQL_DRIVER_DEPS = ['mysql2', 'mysql'] as const;

/** §11.5 — per-language PostgreSQL driver tokens matched against dependency manifests and imports. */
const LANGUAGE_PG_SIGNALS: { token: string; name: string }[] = [
  { token: 'psycopg2', name: 'psycopg2' },
  { token: 'psycopg', name: 'psycopg' },
  { token: 'asyncpg', name: 'asyncpg' },
  { token: 'pg8000', name: 'pg8000' },
  { token: 'github.com/jackc/pgx', name: 'jackc/pgx' },
  { token: 'github.com/lib/pq', name: 'lib/pq' },
  { token: 'pg', name: 'pg (Ruby)' },
  // PHP, JVM, .NET, Rust and Elixir drivers (Stage A COMP-029).
  { token: 'ext-pdo_pgsql', name: 'pdo_pgsql (PHP)' },
  { token: 'org.postgresql', name: 'org.postgresql (JVM)' },
  { token: 'r2dbc-postgresql', name: 'r2dbc-postgresql (JVM)' },
  { token: 'quarkus-jdbc-postgresql', name: 'quarkus-jdbc-postgresql (JVM)' },
  { token: 'Npgsql', name: 'Npgsql (.NET)' },
  { token: 'tokio-postgres', name: 'tokio-postgres (Rust)' },
  { token: 'postgrex', name: 'postgrex (Elixir)' },
];
// A Rust ORM compiled with its PostgreSQL feature (`diesel = { features =
// ["postgres"] }`, `sqlx … "postgres"`), or a PHP image that installs the
// PostgreSQL PDO extension (`docker-php-ext-install pdo_pgsql`).
const RUST_PG_FEATURE_REGEX = /(?:diesel|sqlx|sea-orm)[^\n]*\bpostgres(?:ql)?\b|features\s*=\s*\[[^\]]*"postgres(?:ql)?"|diesel\/postgres/;
const LARAVEL_CONFIG_REGEX = /(?:^|\/)config\/database\.php$/;
const LARAVEL_PGSQL_CONNECTION_REGEX = /['"]driver['"]\s*=>\s*['"]pgsql['"]/;
const PHP_PG_EXTENSION_REGEX =/(?:docker-php-ext-install|install-php-extensions)\b[^\n]*\bpdo_pgsql\b/;

/**
 * Language-level PostgreSQL evidence (drivers declared in Python/Ruby/Go
 * manifests, imports, and postgres:// connection URLs in code). Returns the
 * matched signal names — NOT raw file paths, keeping the finding value a
 * plain string list like every other driver entry.
 */
function detectLanguagePostgres(tree: FileTree): string[] {
  const detected: string[] = [];
  for (const { token, name } of LANGUAGE_PG_SIGNALS) {
    // The bare `pg` token is deliberately ambiguous (node pg, ruby pg) — only
    // accept it from a Ruby manifest line (`gem 'pg'`) to avoid false hits on
    // any file containing the word "pg".
    const paths = findDependencyEvidence(tree, token);
    if (paths.length === 0) continue;
    if (token === 'pg') {
      const rubyHit = paths.some((p) => RB_DEPENDENCY_FILES.test(p));
      if (!rubyHit) continue;
    }
    if (!detected.includes(name)) detected.push(name);
  }
  for (const [path, content] of Object.entries(tree)) {
    if (!content) continue;
    if (/(?:^|\/)Cargo\.toml$/.test(path) && RUST_PG_FEATURE_REGEX.test(content) && !detected.includes('postgres feature (Rust)')) {
      detected.push('postgres feature (Rust)');
    }
    // A `RUN … \` continuation is one instruction.
    if (isDockerfilePath(path) && PHP_PG_EXTENSION_REGEX.test(content.replace(/\\\r?\n/g, ' ')) && !detected.includes('pdo_pgsql (PHP)')) {
      detected.push('pdo_pgsql (PHP)');
    }
    // A Laravel app that lists a `pgsql` connection supports PostgreSQL next to
    // its default engine, so a MySQL default does not make MySQL the only engine.
    if (LARAVEL_CONFIG_REGEX.test(path) && LARAVEL_PGSQL_CONNECTION_REGEX.test(content) && !detected.includes('pgsql connection (Laravel)')) {
      detected.push('pgsql connection (Laravel)');
    }
  }
  // A postgresql:// connection URL in code is driver-independent evidence
  // (Python's sqlalchemy engine URL, Django settings, Go config strings).
  for (const [path, content] of Object.entries(tree)) {
    if (
      content &&
      (PY_SOURCE.test(path) || GO_SOURCE.test(path) || RB_SOURCE.test(path)) &&
      /(?:postgres|postgresql):\/\//.test(content) &&
      !detected.includes('postgres connection URL')
    ) {
      detected.push('postgres connection URL');
    }
  }
  return detected;
}

/**
 * True when non-test, non-vendored Go source imports the module: a `go.mod` requirement alone can be unused.
 * A runtime Go file that the bounded fetch did not read can hold the import, so the requirement then stands.
 */
function goModuleImportedByRuntimeSource(tree: FileTree, module: string): boolean {
  const importPattern = new RegExp(`"${tokenPattern(module)}(?:/[^"]*)?"`);
  const isRuntimeGo = (path: string): boolean => GO_SOURCE.test(path) && !/(?:^|\/)vendor\//.test(path) && isRuntimeSourcePath(path);
  if (Object.entries(tree).some(([path, content]) => isRuntimeGo(path) && importPattern.test(content))) return true;
  const allPaths = (tree as FileTree & { [TREE_PATHS]?: readonly string[] })[TREE_PATHS] ?? [];
  return allPaths.some((path) => isRuntimeGo(path) && tree[path] === undefined);
}

/**
 * True when runtime source or the image defaults an engine selector to a known engine
 * (`DatabaseType.setDefault("sqlite")`): the app picks its engine at run time, so a
 * declared driver exists for the other choice even when no fetched source imports it.
 */
function runtimeEngineSelectorDefault(tree: FileTree): boolean {
  const isEngine = ([name, value]: [string, string]): boolean =>
    DB_SELECTOR_NAME_REGEX.test(name) && (EMBEDDED_ENGINE_REGEX.test(value) || ENGINE_VALUE_REGEX.postgres.test(value));
  const dockerfile = selectedDockerfile(tree);
  return (
    (dockerfile !== null && dockerfileEnvValues(dockerfile.content).some(isEngine)) ||
    Object.entries(tree).some(
      ([path, content]) =>
        content &&
        GO_SOURCE.test(path) &&
        !/(?:^|\/)vendor\//.test(path) &&
        isRuntimeSourcePath(path) &&
        [...scanDefaultedEnvReads(content), ...scanViperEnvDefaults(content)].some(isEngine),
    )
  );
}

/**
 * True when runtime Go source declares an in-memory store next to a PostgreSQL
 * one (`TypeMemory Type = "memory"`, `TypePostgres Type = "postgres"`): the app
 * runs without a database unless its configuration selects one.
 */
function goInMemoryStoreChoice(tree: FileTree): boolean {
  return Object.entries(tree).some(
    ([path, content]) =>
      content &&
      GO_SOURCE.test(path) &&
      !/(?:^|\/)vendor\//.test(path) &&
      isRuntimeSourcePath(path) &&
      /^\s*\w+\s+\w*\s*=\s*"memory"/m.test(content) &&
      /^\s*\w+\s+\w*\s*=\s*"postgres(?:ql)?"/m.test(content),
  );
}

/**
 * True when a language-level driver signal comes from a manifest the
 * deployed app is built from (not a tool, test or docs manifest) and, for
 * Go, is a direct requirement rather than an `// indirect` one.
 */
function languageDriverDeclaredAtRuntime(tree: FileTree, signal: string): boolean {
  if (signal === 'postgres feature (Rust)' || signal === 'pdo_pgsql (PHP)' || signal === 'pgsql connection (Laravel)') return true;
  const token = LANGUAGE_PG_SIGNALS.find((candidate) => candidate.name === signal)?.token;
  if (!token) return false;
  return findDependencyEvidence(tree, token).some((path) => {
    if (!isDependencyManifest(path) || !isRuntimeSourcePath(path)) return false;
    if (!GO_DEPENDENCY_FILES.test(path)) return true;
    const line = new RegExp(`^[^\\n]*${tokenPattern(token)}[^\\n]*$`, 'm').exec(tree[path] ?? '')?.[0] ?? '';
    if (/\/\/\s*indirect/.test(line) || goInMemoryStoreChoice(tree)) return false;
    return goModuleImportedByRuntimeSource(tree, token) || runtimeEngineSelectorDefault(tree);
  });
}

/** True when a Dockerfile installs one of the PHP extensions (`docker-php-ext-install pdo_mysql`). */
export function installsPhpExtension(tree: FileTree, extensions: readonly string[]): boolean {
  const pattern = new RegExp(`(?:docker-php-ext-install|install-php-extensions)\\b[^\\n]*\\b(?:${extensions.join('|')})\\b`);
  return Object.entries(tree).some(([path, content]) => isDockerfilePath(path) && pattern.test(content.replace(/\\\r?\n/g, ' ')));
}

/**
 * Detect PostgreSQL usage from package.json dependencies, Python/Ruby/Go
 * driver signals (§11.5), or Prisma schema.
 */
export function detectPostgresql(tree: FileTree): DetectorFinding {
  const detected: string[] = [];
  const deps = collectDependencyNames(tree);
  const hasMysqlDriver = MYSQL_DRIVER_DEPS.some((dep) => deps.includes(dep));

  // Check for postgres-specific drivers
  for (const driver of PG_DRIVERS) {
    if (deps.includes(driver)) {
      // A dialect-agnostic ORM proves nothing when a MySQL driver is also
      // present — the app is wired to MySQL, not PostgreSQL.
      if (DIALECT_AGNOSTIC_DRIVERS.has(driver) && hasMysqlDriver) continue;
      detected.push(driver);
    }
  }

  // §11.5 language breadth
  for (const signal of detectLanguagePostgres(tree)) {
    if (!detected.includes(signal)) detected.push(signal);
  }

  // Check @prisma/client with postgresql provider
  if (deps.includes('@prisma/client')) {
    const schemaContent = findFileContent(tree, /schema\.prisma$/i);
    if (schemaContent && /provider\s*=\s*"postgresql"/i.test(schemaContent)) {
      detected.push('@prisma/client');
    }
  }

  if (detected.length === 0) {
    return { detector: 'postgresql', detected: false };
  }

  return {
    detector: 'postgresql',
    detected: true,
    value: detected,
    details: `PostgreSQL drivers detected: ${detected.join(', ')}`,
  };
}

/** Required-vs-present evidence for PostgreSQL: mirrors `RedisRequirement`, minus the confidence enum. */
export interface PostgresRequirement {
  required: boolean;
  evidence: string[];
}

const PG_CONNECTION_ENV_VARS = [
  'DATABASE_URL',
  'POSTGRES_URL',
  'POSTGRESQL_URL',
  'POSTGRES_HOST',
  'POSTGRES_DB',
] as const;

// Names generic enough to point at any SQL engine — the postgres-specific
// names above (POSTGRES_URL, POSTGRES_HOST, ...) don't need the scheme check.
const GENERIC_DB_URL_ENV_VARS = new Set(['DATABASE_URL']);

const COMPOSE_IMAGE_REGEX = /^\s*image:\s*['"]?([^\s'"]+)['"]?/gim;

/**
 * Assess whether a repository's PostgreSQL usage is backed by more than a
 * bare dependency. A driver/ORM library sitting unused in package.json is
 * not enough evidence to provision a managed database — `required` is only
 * true when a driver/ORM dependency AND at least one independent signal
 * (a Prisma postgresql provider, a known connection env var, or a
 * postgres/postgis docker-compose image) are both present.
 *
 * `detectPostgresql`'s `detected` (library presence) is unaffected by this
 * function and keeps driving verdicts/§20 checks — only RDS provisioning
 * (`metadata.postgres.required`) is gated here.
 */
export function assessPostgres(tree: FileTree): PostgresRequirement {
  const evidence: string[] = [];
  const deps = collectDependencyNames(tree);
  const hasMysqlDriver = MYSQL_DRIVER_DEPS.some((dep) => deps.includes(dep));

  let hasDependency = false;
  let hasIndependentEvidence = false;

  for (const driver of PG_DRIVERS) {
    if (deps.includes(driver)) {
      // A dialect-agnostic ORM proves nothing when a MySQL driver is also
      // present — the app is wired to MySQL, not PostgreSQL.
      if (DIALECT_AGNOSTIC_DRIVERS.has(driver) && hasMysqlDriver) continue;
      hasDependency = true;
      evidence.push(`${driver} dependency in package.json`);
    }
  }

  // §11.5 language breadth — a Python/Ruby/Go driver is the same "driver
  // present" signal as a Node one; a postgres:// URL in code counts as
  // INDEPENDENT evidence (it proves a connection is actually configured).
  // Outside Node a driver is compiled or installed on purpose — a Go module,
  // a Python package, a gem, a Maven artifact, a Cargo feature is never a
  // transitive extra sitting unused in the manifest — so its declaration in
  // a runtime manifest is evidence of a configured engine in itself; the
  // app names its connection through its own settings (`MEMOS_DSN`, a YAML
  // storage block), not a variable this function knows (Stage A COMP-029).
  const languageSignals = detectLanguagePostgres(tree);
  for (const signal of languageSignals) {
    if (signal === 'postgres connection URL') {
      hasIndependentEvidence = true;
      evidence.push(`${signal} in source`);
    } else {
      hasDependency = true;
      evidence.push(`${signal} driver declared`);
      if (languageDriverDeclaredAtRuntime(tree, signal)) hasIndependentEvidence = true;
    }
  }

  // Prisma schema declaring a postgresql provider.
  if (deps.includes('@prisma/client')) {
    for (const path of findFiles(tree, /schema\.prisma$/i)) {
      const content = tree[path];
      if (content && /provider\s*=\s*"postgresql"/i.test(content)) {
        hasDependency = true;
        hasIndependentEvidence = true;
        evidence.push('@prisma/client dependency in package.json');
        evidence.push(`provider = "postgresql" in ${path}`);
      }
    }
  }

  // A drizzle config for the postgresql dialect (`configs/postgresql.config.ts`):
  // an app with a SQLite default and a PostgreSQL option names its dialects
  // this way, so a PostgreSQL driver plus this config is a configured engine.
  for (const [path, content] of Object.entries(tree)) {
    if (hasDependency && /\.config\.[cm]?[jt]s$/.test(path) && content && /\bdialect\s*:\s*["']postgres(?:ql)?["']/.test(content)) {
      hasIndependentEvidence = true;
      evidence.push(`postgresql dialect configured in ${path}`);
    }
  }

  // A known connection env var referenced in an env file, docker-compose, or
  // source — a JS `process.env` read, or the name as a string literal in Go,
  // Python or Ruby configuration (Stage A COMP-013).
  for (const name of PG_CONNECTION_ENV_VARS) {
    const envFileRegex = new RegExp(`^${name}\\s*[=:]`, 'm');
    const composeRegex = new RegExp(`\\b${name}\\s*[=:]`);
    const processEnvRegex = new RegExp(`process\\.env\\.${name}\\b`);
    const envObjectRegex = new RegExp(`(?<![\\w.$])env\\s*(?:\\.\\s*${name}\\b|\\[\\s*["']${name}["']\\s*\\])`);
    const literalRegex = new RegExp(`["']${name}["']`);
    // `DATABASE_URL` is engine-agnostic by name — only a value declaring a
    // non-PostgreSQL scheme (mysql://, mariadb://) disqualifies it (mirrors
    // assessMysql's `mysql://` scheme check).
    const nonPostgresSchemeRegex = GENERIC_DB_URL_ENV_VARS.has(name)
      ? new RegExp(`${name}\\s*[=:]\\s*['"]?(?!postgres)[a-zA-Z][\\w+.-]*://`, 'i')
      : null;

    for (const [path, content] of Object.entries(tree)) {
      if (!content) continue;
      if (nonPostgresSchemeRegex && nonPostgresSchemeRegex.test(content)) continue;
      if (/^\.env(\.\w+)?$/i.test(path) && envFileRegex.test(content)) {
        hasIndependentEvidence = true;
        evidence.push(`${name} referenced in ${path}`);
      } else if (/^docker-compose\.ya?ml$/i.test(path) && composeRegex.test(content)) {
        hasIndependentEvidence = true;
        evidence.push(`${name} referenced in ${path}`);
      } else if (/\.(ts|js|mjs|cjs|jsx|tsx)$/.test(path) && processEnvRegex.test(content)) {
        hasIndependentEvidence = true;
        evidence.push(`process.env.${name} referenced in ${path}`);
      } else if (
        /\.(ts|js|mjs|cjs|jsx|tsx)$/.test(path) &&
        readsThroughEnvObject(content) &&
        envObjectRegex.test(content)
      ) {
        hasIndependentEvidence = true;
        evidence.push(`env.${name} referenced in ${path}`);
      } else if (LANGUAGE_SOURCE_REGEX.test(path) && isRuntimeSourcePath(path) && literalRegex.test(content)) {
        hasIndependentEvidence = true;
        evidence.push(`${name} referenced in ${path}`);
      }
    }
  }

  // A postgres/postgis image in any production Compose file — the root file,
  // a nested `docker/docker-compose.yml`, or a root variant such as
  // `docker-compose.postgres.yml` (an app that ships one supports PostgreSQL).
  for (const path of Object.keys(tree)) {
    if (!/(?:^|\/)(?:docker-)?compose(?:\.[\w.-]+)?\.ya?ml$/i.test(path) || !isProductionComposeFile(path)) continue;
    const dcContent = tree[path];
    if (!dcContent) continue;
    const regex = new RegExp(COMPOSE_IMAGE_REGEX.source, COMPOSE_IMAGE_REGEX.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(dcContent)) !== null) {
      const image = match[1];
      if (image && /postgres|postgis/i.test(image)) {
        hasIndependentEvidence = true;
        evidence.push(`docker-compose service using a PostgreSQL/PostGIS image (${image}) in ${path}`);
      }
    }
  }

  return {
    required: hasDependency && hasIndependentEvidence,
    evidence: [...new Set(evidence)],
  };
}

// 7. Local filesystem usage
// ---------------------------------------------------------------------------

// DECLARED durable state only. A write call in source (`fs.writeFile`, a
// Python `open(…, "w")`) proves nothing: caches, temp files, generated
// assets and log files are written by almost every real application and
// are lost harmlessly with the container. What breaks in an ephemeral
// container is state the image itself declares it keeps on disk — a
// Dockerfile `VOLUME`, or a volume the production Compose file mounts into
// the application service — with no object-storage alternative the vendor
// can configure instead (Stage A COMP-024).
const DOCKERFILE_VOLUME_REGEX = /^\s*VOLUME\s+(.+)$/gm;
// A volume that backs the default embedded database (`VOLUME /database`,
// `/var/lib/mysql`) is replaced by the PostgreSQL Deployz provisions when
// the app ships a PostgreSQL driver.
const DATABASE_VOLUME_REGEX = /(?:database|\bdb\b|sqlite|postgres|pgdata|mysql|mariadb)/i;
// Read-only mounts, the Docker socket, single-file mounts (a config file)
// and customisation directories the operator fills before start (themes,
// plugins, certificates) carry no state the app writes at runtime.
const NON_STATE_MOUNT_REGEX =
  /:ro$|\.sock(?::|$)|[^/]\.[a-z]{2,5}(?::[a-z]+)?$|\.env(?::[a-z]+)?$|\/(?:custom|config|conf|plugins?|themes?|certs?|ssl|secrets?|extensions?|addons?|static|staticfiles|node_modules|vendor|bundle|build|dist|sockets?)\/?(?::[a-z]+)?$/i;
// User-uploaded files: the one kind of local state an S3 option replaces.
const UPLOAD_VOLUME_REGEX = /upload|media|attachment|avatar|public\/system|(?:^|[/:])files?(?:[/:]|$)|\/storage(?:[/:]|$)/i;
const S3_SDK_TOKENS = ['boto3', 'django-storages', 'aws-sdk', '@aws-sdk/client-s3', 'aws-sdk-s3', 'fog-aws', 'league/flysystem-aws-s3-v3', 'minio'] as const;
// The variable that picks object storage for uploads (`UPLOAD_PROVIDER=s3`,
// `ACTIVE_STORAGE_SERVICE=amazon`, `FILE_STORAGE=s3`) or names its bucket.
const OBJECT_STORAGE_SELECTOR_REGEX =
  /\b(?:UPLOAD_PROVIDER|(?:FILE|MEDIA|UPLOAD|ATTACHMENTS?)_STORAGE(?:_TYPE|_PROVIDER|_BACKEND|_DRIVER)?|STORAGE_(?:TYPE|PROVIDER|DRIVER|BACKEND)|ACTIVE_STORAGE_SERVICE|FILESYSTEM_(?:DISK|DRIVER)|[A-Z][A-Z0-9_]*S3[A-Z0-9_]*BUCKET[A-Z0-9_]*|AWS_STORAGE_BUCKET_NAME)\b/;

// A settings file that names the S3 storage backend is SDK evidence when the
// requirements file is not part of the collected tree.
const S3_STORAGE_BACKEND_REGEX = /\bstorages\.backends\.s3(?:boto3)?\b|\bS3(?:Boto3)?Storage\b/;

/** The app ships an S3 SDK and a variable that switches uploads to it. */
function offersObjectStorageOption(tree: FileTree): boolean {
  const sourceFiles = Object.entries(tree).filter(
    ([path, content]) => content && isRuntimeSourcePath(path) && !/\.(?:md|txt|lock)$/i.test(path),
  );
  const hasSdk =
    S3_SDK_TOKENS.some((token) => findDependencyEvidence(tree, token).length > 0) ||
    sourceFiles.some(([, content]) => S3_STORAGE_BACKEND_REGEX.test(content));
  return hasSdk && sourceFiles.some(([, content]) => OBJECT_STORAGE_SELECTOR_REGEX.test(content));
}

/** The compose file's own comment above a volume entry says the volume is not required in production. */
function volumeCalledOptional(composeContent: string, volume: string): boolean {
  const lines = composeContent.split(/\r?\n/);
  const at = lines.findIndex((line) => /^\s*-\s/.test(line) && line.includes(volume));
  const comments: string[] = [];
  for (let i = at - 1; at > 0 && i >= 0 && /^\s*#/.test(lines[i]!); i--) comments.push(lines[i]!);
  return /\bnot (?:required|needed) in (?:a |the )?production\b/i.test(comments.join(' '));
}

/** The container side of a Compose volume entry (`./config:/etc/app:ro` → `/etc/app`). */
function composeMountTarget(volume: string): string {
  return volume.includes(':') ? volume.slice(volume.indexOf(':') + 1).replace(/:(?:rw|ro|z|Z)+$/, '') : volume;
}

const EMBEDDED_DATABASE_FILE_REGEX = /\.(?:sqlite3?|db)$|sqlite/i;

/** The paths that `texts` name under `volume`. */
function volumeContents(volume: string, texts: string[]): string[] {
  const escaped = volume.replace(/\/$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return texts.flatMap((text) => [...text.matchAll(new RegExp(`['"= ]${escaped}/([^'"\\s;)]+)`, 'g'))].map((m) => m[1]!));
}

/** Every value under `volume` is a SQLite/DB file path: the volume only holds the embedded database. */
function holdsOnlyEmbeddedDatabase(volume: string, texts: string[]): boolean {
  const contents = volumeContents(volume, texts);
  return contents.length > 0 && contents.every((content) => EMBEDDED_DATABASE_FILE_REGEX.test(content));
}

// A framework storage directory (Laravel `storage/`: logs, caches, sessions) or a marker file (`installed`).
const FRAMEWORK_STORAGE_CONTENT_REGEX = /^(?:storage|logs?|cache)(?:\/|$)/;

/**
 * The image keeps its embedded SQLite database under `volume` (2fauth's
 * entrypoint links `/2fauth/database.sqlite`), and the rest is framework
 * storage or a marker file, never an upload directory. With PostgreSQL the
 * database file is not used.
 */
function holdsEmbeddedDatabase(volume: string, texts: string[]): boolean {
  const contents = volumeContents(volume, texts);
  return (
    contents.some((content) => EMBEDDED_DATABASE_FILE_REGEX.test(content)) &&
    contents.every(
      (content) =>
        EMBEDDED_DATABASE_FILE_REGEX.test(content) ||
        FRAMEWORK_STORAGE_CONTENT_REGEX.test(content) ||
        (/^[\w-]+$/.test(content) && !UPLOAD_VOLUME_REGEX.test(`/${content}`)),
    )
  );
}

/** The Dockerfile and the scripts that it names, where an image sets up its data paths. */
function imageSetupTexts(tree: FileTree, dockerfile: { path: string; content: string } | null): string[] {
  if (!dockerfile) return [];
  const dockerDir = dockerfile.path.includes('/') ? dockerfile.path.split('/').slice(0, -1).join('/') : '';
  const scripts = extractCmdScriptPaths(dockerfile.content, tree, dockerDir, new Set());
  return [dockerfile.content, ...scripts.map((path) => tree[path] ?? '')];
}
// Container-side paths that hold only transient state — logs, caches, search
// indexes and temp dirs. A volume mounted there is a log/cache volume, not
// durable application data: a cache write, a temp file, a generated asset and
// a log line are all lost harmlessly (the same boundary the write-call rule
// draws above). Named volumes whose container path is `/tmp/…`, `…/logs`,
// `…/cache`, `…/.cache` or a search/index dir are not durable app state.
// An `/etc/<name>` directory holds configuration the operator provides.
const EPHEMERAL_CONTAINER_PATH_REGEX =
  /^\/(?:tmp|var\/tmp|etc\/[\w.-]+)\b|\/(?:logs?|log|cache|\.cache|search|indexes?|sessions?|run|var\/run)(?:\/|$)/i;

/**
 * Detect durable local-disk state the image declares (Dockerfile VOLUME, a
 * Compose volume on the application service) with no object-storage
 * alternative — unsupported in Deployz's ephemeral container model.
 */
export function detectLocalFilesystem(tree: FileTree): DetectorFinding {
  const detected: string[] = [];
  const hasPostgresDriver = detectPostgresql(tree).detected;
  let objectStorage: boolean | undefined;
  const hasObjectStorageOption = (): boolean => (objectStorage ??= offersObjectStorageOption(tree));

  const dockerfile = selectedDockerfile(tree);
  // `VOLUME $VAR` whose value only the base image sets: decided below from the Compose mounts.
  const unresolvedVolumes: string[] = [];
  for (const match of dockerfile?.content.matchAll(DOCKERFILE_VOLUME_REGEX) ?? []) {
    const raw = match[1]?.trim() ?? '';
    const paths = raw.startsWith('[') ? raw.match(/"([^"]+)"/g)?.map((p) => p.slice(1, -1)) ?? [] : raw.split(/\s+/);
    for (const declared of paths) {
      // `VOLUME $DATA_PATH` is the path the same Dockerfile sets with `ENV`.
      const variable = /^\$(?:\{(\w+)\}|(\w+))$/.exec(declared);
      const resolved = variable
        ? dockerfileEnvValues(dockerfile?.content ?? '').find(([name]) => name === (variable[1] ?? variable[2]))?.[1]
        : undefined;
      if (variable && !resolved) {
        unresolvedVolumes.push(declared);
        continue;
      }
      const volume = resolved || declared;
      if (hasPostgresDriver && DATABASE_VOLUME_REGEX.test(volume)) continue;
      if (hasPostgresDriver && holdsOnlyEmbeddedDatabase(volume, [dockerfile?.content ?? ''])) continue;
      if (UPLOAD_VOLUME_REGEX.test(volume) && hasObjectStorageOption()) continue;
      // A VOLUME for logs/caches/tmp (`VOLUME /tmp/…`, `VOLUME /…/cache`) is
      // transient state, not durable application data.
      if (EPHEMERAL_CONTAINER_PATH_REGEX.test(volume)) continue;
      detected.push(`VOLUME ${volume} (${dockerfile?.path})`);
    }
  }

  const compose = composeApplicationServices(tree);
  const mountTargets: string[] = [];
  let setupTexts: string[] | undefined;
  for (const service of compose?.services ?? []) {
    // A service that builds a different Dockerfile packages the app another
    // way (a compose-only wrapper image); its volumes are not this image's.
    const built = compose && composeBuildDockerfile(compose.file, service.build);
    if (built && dockerfile && built !== dockerfile.path) continue;
    for (const volume of service.volumes) {
      // The container-side mount target decides what the volume holds — a
      // named volume at `/tmp/…`, `…/logs`, `…/cache` or `…/.cache` is a
      // log/cache volume (transient), not durable app data.
      const target = composeMountTarget(volume);
      mountTargets.push(target);
      if (NON_STATE_MOUNT_REGEX.test(volume)) continue;
      if (compose && volumeCalledOptional(tree[compose.file] ?? '', volume)) continue;
      if (hasPostgresDriver && DATABASE_VOLUME_REGEX.test(volume)) continue;
      // A bind mount of a directory the repository ships (`./custom:/app/custom`)
      // carries project files, not state written at runtime.
      const source = volume.includes(':') ? volume.slice(0, volume.indexOf(':')).replace(/^\.\//, '') : null;
      if (source && !source.startsWith('/') && Object.keys(tree).some((path) => path.startsWith(`${source}/`))) continue;
      if (EPHEMERAL_CONTAINER_PATH_REGEX.test(target)) continue;
      if (hasPostgresDriver && holdsOnlyEmbeddedDatabase(target, [service.body])) continue;
      if (hasPostgresDriver && holdsEmbeddedDatabase(target, (setupTexts ??= imageSetupTexts(tree, dockerfile)))) continue;
      if (UPLOAD_VOLUME_REGEX.test(volume) && hasObjectStorageOption()) continue;
      detected.push(`volume ${volume} (${compose?.file} ${service.name})`);
    }
  }
  // The image's own service can carry an infrastructure image name (searxng runs `searxng/searxng`): the
  // Dockerfile's OCI title label names it.
  const title = /org\.opencontainers\.image\.title="?([\w.-]+)/i.exec(dockerfile?.content ?? '')?.[1]?.toLowerCase();
  const ownService = title
    ? composeServices(tree)?.services.find(
        (service) => !service.build && service.image?.replace(/[@:][^/]*$/, '').split('/').pop()?.toLowerCase() === title,
      )
    : undefined;
  if (ownService && !compose?.services.some((service) => service.name === ownService.name)) {
    mountTargets.push(...ownService.volumes.map(composeMountTarget));
  }
  // The Compose service that runs this image mounts the paths the base image declares: when it mounts at
  // least as many and every one is configuration or cache, the unresolved VOLUMEs hold no durable state.
  const unresolvedAreNonState =
    mountTargets.length >= unresolvedVolumes.length && mountTargets.every((target) => EPHEMERAL_CONTAINER_PATH_REGEX.test(target));
  if (!unresolvedAreNonState) {
    for (const volume of unresolvedVolumes) detected.push(`VOLUME ${volume} (${dockerfile?.path})`);
  }

  if (detected.length === 0 || detectS3(tree).detected) {
    return { detector: 'local-filesystem', detected: false };
  }

  return {
    detector: 'local-filesystem',
    detected: true,
    value: detected,
    details: `Durable local filesystem state declared: ${detected.join(', ')}`,
  };
}

// 8. Worker
// ---------------------------------------------------------------------------

const WORKER_DEPS = ['bull', 'agenda', 'bullmq'] as const;
// Job-queue libraries per language (Stage A COMP-015). In-process cron
// schedulers (node-cron, croner, robfig/cron, gocron, APScheduler) are not
// listed: they run inside the web process by construction and never imply
// a worker.
const WORKER_LANGUAGE_TOKENS: { token: string; name: string }[] = [
  { token: 'pg-boss', name: 'pg-boss' },
  { token: 'graphile-worker', name: 'graphile-worker' },
  { token: 'bree', name: 'bree' },
  { token: '@temporalio/worker', name: '@temporalio/worker' },
  { token: 'sidekiq', name: 'sidekiq' },
  { token: 'good_job', name: 'good_job' },
  { token: 'delayed_job', name: 'delayed_job' },
  { token: 'resque', name: 'resque' },
  { token: 'solid_queue', name: 'solid_queue' },
  { token: 'sneakers', name: 'sneakers' },
  { token: 'celery', name: 'celery' },
  { token: 'rq', name: 'rq' },
  { token: 'django-rq', name: 'django-rq' },
  { token: 'dramatiq', name: 'dramatiq' },
  { token: 'huey', name: 'huey' },
  { token: 'django-q', name: 'django-q' },
  { token: 'arq', name: 'arq' },
  { token: 'procrastinate', name: 'procrastinate' },
  { token: 'github.com/hibiken/asynq', name: 'asynq' },
  { token: 'github.com/RichardKnop/machinery', name: 'machinery' },
  { token: 'github.com/riverqueue/river', name: 'river' },
  { token: 'github.com/gocraft/work', name: 'gocraft/work' },
  { token: 'org.quartz-scheduler', name: 'quartz (JVM)' },
  { token: 'spring-boot-starter-quartz', name: 'quartz (JVM)' },
  { token: 'jobrunr', name: 'jobrunr (JVM)' },
  { token: 'Hangfire', name: 'Hangfire (.NET)' },
  { token: 'oban', name: 'oban (Elixir)' },
  { token: 'laravel/horizon', name: 'laravel/horizon' },
  { token: 'apalis', name: 'apalis (Rust)' },
];
const WORKER_COMMAND_FILE_REGEX = /(?:^|\/)(?:Procfile|[\w.-]*\.sh|supervisord?\.conf|[\w.-]*\.ini)$|(?:^|\/)(?:docker-compose|compose)\.ya?ml$|dockerfile/i;
const WORKER_COMMAND_REGEX =
  /\b(?:bundle exec )?(?:sidekiq|good_job start|rake (?:jobs|resque):work)\b|\bcelery\b[^\n]*\bworker\b|\brq\s+worker\b|\bdramatiq\s+[\w.]+|\bhuey_consumer(?:\.py)?\b|\b(?:arq|procrastinate)\b[^\n]*\bworker\b|artisan\s+(?:queue:work|queue:listen|horizon)\b|\bmanage\.py\s+(?:rqworker|qcluster|procrastinate|run_huey)\b/;
/** The worker pattern of a queue consumer that the image's own start command runs. */
export const START_COMMAND_WORKER = 'queue worker run by the start command';
const WORKER_CODE_REGEX = /(?:require|import)\s*(?:\(|.*from\s*)['"]node:worker_threads['"]/;

/**
 * Detect worker processes (Bull, Agenda, worker_threads, background job patterns).
 */
export function detectWorker(tree: FileTree): DetectorFinding {
  const detected: string[] = [];

  // Check package.json dependencies
  const deps = collectDependencyNames(tree);
  for (const dep of WORKER_DEPS) {
    if (deps.includes(dep)) {
      detected.push(dep);
    }
  }

  // Check source code for worker_threads
  for (const [path, content] of Object.entries(tree)) {
    if (/\.(ts|js|mjs|cjs|jsx|tsx)$/.test(path)) {
      if (WORKER_CODE_REGEX.test(content)) {
        if (!detected.includes('worker_threads')) {
          detected.push('worker_threads');
        }
      }
    }
  }

  // Job queues and schedulers outside Node, and a queue-worker command in a
  // Procfile, Dockerfile, Compose file or shell script (Stage A COMP-015).
  for (const { token, name } of WORKER_LANGUAGE_TOKENS) {
    if (findDependencyEvidence(tree, token).length > 0 && !detected.includes(name)) detected.push(name);
  }
  for (const [path, content] of Object.entries(tree)) {
    if (!content || !isRuntimeSourcePath(path) || !WORKER_COMMAND_FILE_REGEX.test(path)) continue;
    if (WORKER_COMMAND_REGEX.test(content) && !detected.includes('queue worker command')) detected.push('queue worker command');
  }
  // A declared worker process is worker code by definition, whatever library runs it.
  const declaredSources = new Set(detectDeclaredWorkerCommands(tree).map((declared) => declared.source));
  for (const source of declaredSources) {
    detected.push(`declared worker process (${source})`);
  }

  // Tech spec §25.2: a Compose application service whose NAME is
  // worker-shaped but has no `command:` is weak worker evidence — it can
  // never be auto-provisioned (detectDeclaredWorkerCommands skips it), but it
  // still needs to surface the manifest's `worker.needsCommand` question
  // instead of deploying silently as if it were plain app code.
  const compose = composeApplicationServices(tree);
  for (const service of compose?.services ?? []) {
    if (service.command !== null || !WORKER_SERVICE_NAME_REGEX.test(service.name)) continue;
    detected.push(`compose worker service without a command (${compose!.file} ${service.name})`);
  }

  if (detected.length === 0) {
    return { detector: 'worker', detected: false };
  }
  // The image's start path already runs the queue consumer next to the web
  // process (linkding starts `manage.py run_huey` under supervisord).
  if (declaredSources.size === 0 && mainCommandRunsWorker(tree)) {
    return {
      detector: 'worker',
      detected: true,
      value: [START_COMMAND_WORKER],
      details: `Worker patterns detected: ${detected.join(', ')}; the image's start command runs the queue worker`,
    };
  }

  return {
    detector: 'worker',
    detected: true,
    value: detected,
    details: `Worker patterns detected: ${detected.join(', ')}`,
  };
}

/**
 * A worker process the repository DECLARES outside a root package.json
 * script (which apps/api resolves itself): a Procfile non-web process, or a
 * production Compose application service whose `command:` runs a queue
 * worker or whose name is worker-shaped. Every declared process becomes its
 * own workload (Phase 4A), so ALL of them resolve — one per process, in
 * deterministic file order. Dev/test/build utility process names and
 * one-shot `release` hooks never become workloads; a workspace package
 * merely named `worker` is not one (linkwarden runs its `apps/worker`
 * inside the web container) (Stage A COMP-015).
 */
export interface DeclaredWorkerCommand {
  /** Stable workload id — the slugified process/service name (e.g. 'email-worker'). */
  id: string;
  /** The declared start command (runnable, e.g. `node worker.js`). */
  command: string;
  /** Repository path that declared the process. */
  source: string;
}

/** Process names that are dev tooling or one-shot deploy hooks, never persistent workers.
 *  `migration` is one-shot like `release`: the migration workload comes from
 *  the migration detection path, and a process of the same name must never
 *  collide with it (a duplicate workload id fails the compiler closed). */
const NON_PERSISTENT_PROCESS_NAME_REGEX =
  /^(?:web|release|migration|dev|development|test|tests|build|lint|watch|debug|console|shell|setup|format|typecheck)$/i;

/** Compose service names shaped like a worker (email-worker, workers, my_workers, …). */
export const WORKER_SERVICE_NAME_REGEX = /(?:^|[-_.])workers?(?:[-_.]|$)/i;

/** Whether a Compose application service declares a worker process via its explicit command. */
export function isWorkerServiceCommand(name: string, command: string): boolean {
  if (command.length === 0) return false;
  return WORKER_SERVICE_NAME_REGEX.test(name) || WORKER_COMMAND_REGEX.test(command);
}

/** Kebab-case a Procfile/compose process name into a stable workload id. */
function slugProcessId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'worker';
}

/**
 * The selected Dockerfile's runtime image is a known JavaScript image without
 * the runner the command starts with (outline's Procfile `yarn start` on
 * `node:26-slim`): the process exits with 127 in that image.
 */
function runtimeImageLacksRunner(tree: FileTree, command: string): boolean {
  const runner = command.split(/\s+/)[0] ?? '';
  if (!JS_RUNNERS.has(runner)) return false;
  const dockerfile = selectedDockerfile(tree);
  const image = dockerfile ? runtimeImageOf(dockerfile.content) : null;
  return image !== null && image.hasShell && image.tools.size > 0 && !image.tools.has(runner);
}

export function detectDeclaredWorkerCommands(tree: FileTree): DeclaredWorkerCommand[] {
  const declared: DeclaredWorkerCommand[] = [];
  const seen = new Set<string>();
  const push = (id: string, command: string, source: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    declared.push({ id, command, source });
  };

  for (const [path, content] of Object.entries(tree)) {
    if (!/(?:^|\/)Procfile$/.test(path) || !content || !isRuntimeSourcePath(path)) continue;
    for (const match of content.matchAll(/^([\w.-]+):\s*(.+)$/gm)) {
      const name = match[1]!;
      const command = match[2]!.trim();
      if (command.length === 0 || NON_PERSISTENT_PROCESS_NAME_REGEX.test(name) || isDevToolCommand(command)) continue;
      if (runtimeImageLacksRunner(tree, command)) continue;
      push(slugProcessId(name), command, path);
    }
  }
  const compose = composeApplicationServices(tree);
  for (const service of compose?.services ?? []) {
    if (!service.command || !isWorkerServiceCommand(service.name, service.command)) continue;
    const id = slugProcessId(service.name);
    if (id === 'web') continue;
    push(id, service.command, `${compose!.file} ${service.name}`);
  }
  return declared;
}

/**
 * Legacy single-slot reader over `detectDeclaredWorkerCommands` (the first
 * declared process). Kept for apps/api, which has not migrated to the
 * multi-worker list yet.
 */
export function detectDeclaredWorkerCommand(tree: FileTree): { command: string; source: string } | null {
  return detectDeclaredWorkerCommands(tree)[0] ?? null;
}

// 9. S3 usage
// ---------------------------------------------------------------------------

// S3-SPECIFIC packages only. The umbrella SDKs (`aws-sdk`, `boto3`,
// `github.com/aws/aws-sdk-go`) also serve SES, SQS and friends, so on their
// own they prove nothing about object storage — they count only through an
// S3 client construction in source (Stage A COMP-012).
const S3_DEPS = ['@aws-sdk/client-s3'] as const;
const S3_ENV_REGEX = /^(?:AWS_)?S3_BUCKET\s*=/m;

/**
 * Detect S3 usage from S3-specific packages (npm, Ruby `aws-sdk-s3`, the Go
 * v2 `service/s3` module, CDK), source-code S3 client usage, or S3-specific
 * env vars.
 */
export function detectS3(tree: FileTree): DetectorFinding {
  const detected: string[] = [];

  // Check package.json dependencies
  const deps = collectDependencyNames(tree);
  for (const dep of S3_DEPS) {
    if (deps.includes(dep)) {
      detected.push(dep);
    }
  }

  // §11.5 language breadth: Ruby aws-sdk-s3, Go AWS SDK S3 module.
  const LANGUAGE_S3_TOKENS = [
    { token: 'aws-sdk-s3', name: 'aws-sdk-s3' },
    { token: 'github.com/aws/aws-sdk-go-v2/service/s3', name: 'aws-sdk-go-v2 service/s3' },
    { token: 'aws_cdk.aws_s3', name: 'aws_cdk aws_s3' },
    // JVM, PHP, .NET and Elixir S3-specific artifacts (Stage A COMP-029).
    { token: 'software.amazon.awssdk:s3', name: 'awssdk s3 (JVM)' },
    { token: 'aws-java-sdk-s3', name: 'aws-java-sdk-s3 (JVM)' },
    { token: 'league/flysystem-aws-s3-v3', name: 'flysystem-aws-s3-v3 (PHP)' },
    { token: 'AWSSDK.S3', name: 'AWSSDK.S3 (.NET)' },
    { token: 'ex_aws_s3', name: 'ex_aws_s3 (Elixir)' },
  ] as const;
  for (const { token, name } of LANGUAGE_S3_TOKENS) {
    if (findDependencyEvidence(tree, token, true).length > 0 && !detected.includes(name)) {
      detected.push(name);
    }
  }

  // Source-code client usage is independent of the manifest (a vendored SDK,
  // or a dependency pinned outside the manifests we read).
  for (const [path, content] of Object.entries(tree)) {
    if (PY_SOURCE.test(path) && /boto3\.(?:client|resource)\s*\(\s*["']s3["']/.test(content)) {
      if (!detected.includes('boto3')) detected.push('boto3');
    }
    if (JS_SOURCE.test(path) && /\bAWS\.S3\s*\(/.test(content) && !detected.includes('aws-sdk')) {
      detected.push('aws-sdk');
    }
    if (
      GO_SOURCE.test(path) &&
      /(?:s3\.NewFromConfig|s3\.New\s*\()/.test(content) &&
      !detected.includes('aws-sdk-go-v2 service/s3')
    ) {
      detected.push('aws-sdk-go-v2 service/s3');
    }
    if (JS_SOURCE.test(path) && /new\s+S3Client\s*\(|S3Client\.from/.test(content)) {
      if (!detected.includes('@aws-sdk/client-s3')) detected.push('@aws-sdk/client-s3');
    }
  }

  // Check env files for S3_BUCKET / AWS_S3_BUCKET
  for (const path of Object.keys(tree)) {
    if (/^\.env(\.\w+)?$/i.test(path) || (/\.ini$/i.test(path) && isRuntimeSourcePath(path))) {
      const content = tree[path];
      if (content && S3_ENV_REGEX.test(content)) {
        if (!detected.includes('AWS_S3_BUCKET')) {
          detected.push('AWS_S3_BUCKET');
        }
      }
    }
  }

  if (detected.length === 0) {
    return { detector: 's3', detected: false };
  }

  return {
    detector: 's3',
    detected: true,
    value: detected,
    details: `S3 usage detected: ${detected.join(', ')}`,
  };
}

// 10. Migration command
// ---------------------------------------------------------------------------

const MIGRATION_PATTERNS: { pattern: RegExp; name: string }[] = [
  { pattern: /drizzle-kit\s+(push|migrate|generate)/, name: 'drizzle-kit' },
  { pattern: /prisma\s+migrate/, name: 'prisma migrate' },
  { pattern: /knex\s+migrate:(?:latest|up|rollback|make)/, name: 'knex migrate:latest' },
  { pattern: /sequelize\s+db:migrate/, name: 'sequelize db:migrate' },
  { pattern: /typeorm\s+migration:(?:run|revert|generate)/, name: 'typeorm migration:run' },
  { pattern: /npx\s+migrate/, name: 'npx migrate' },
  { pattern: /node-pg-migrate/, name: 'node-pg-migrate' },
];

// ── Stage B phase 6 (COMP-014): migrations that run OUTSIDE package.json ───

/** A dev-mode migration command — never deploy/startup evidence. */
const MIGRATION_DEV_REGEX = /migrate[\s:-]dev\b/i;

/** Migration commands an application can legitimately run at STARTUP. */
const STARTUP_MIGRATION_PATTERNS: { pattern: RegExp; name: string }[] = [
  // `\bmanage\.py` also covers a uwsgi `hook-pre-app = exec:./manage.py migrate`.
  { pattern: /\bmanage\.py\s+migrate\b/, name: 'python manage.py migrate' },
  { pattern: /prisma\s+migrate\s+deploy\b/, name: 'prisma migrate deploy' },
  { pattern: /\b(?:rails|rake)\s+db:(?:prepare|migrate)\b/, name: 'rails db:prepare/db:migrate' },
  { pattern: /flask\s+db\s+upgrade\b/, name: 'flask db upgrade' },
  { pattern: /alembic\s+upgrade\s+head\b/, name: 'alembic upgrade head' },
  { pattern: /php\s+artisan\s+migrate\s+--force/, name: 'php artisan migrate --force' },
  { pattern: /knex\s+migrate:(?:latest|up)\b/, name: 'knex migrate:latest' },
  { pattern: /typeorm\s+migration:run\b/, name: 'typeorm migration:run' },
  { pattern: /\bflyway\s+migrate\b/, name: 'flyway migrate' },
  { pattern: /\bliquibase\s+(?:update|migrate)\b/, name: 'liquibase update/migrate' },
  { pattern: /\bsequelize(?:-cli)?\s+db:migrate\b/, name: 'sequelize db:migrate' },
  { pattern: /\bdrizzle-kit\s+migrate\b/, name: 'drizzle-kit migrate' },
  { pattern: /\bnode-pg-migrate\s+up\b/, name: 'node-pg-migrate up' },
  // The app's own migrate script chained before its start command.
  {
    pattern: /\b(?:npm\s+run|yarn|pnpm(?:\s+run)?)\s+(?:db[:-])?migrate(?::(?:deploy|latest|up|prod))?(?=\s|$|[&;"'\]])/,
    name: 'migrate script',
  },
  // A binary's migrate SUBCOMMAND chained before the server (`./fider migrate && ./fider`).
  { pattern: /(?:^|[\s"'&;|])\.{0,2}\/[\w./-]*[A-Za-z][\w-]*\s+migrate(?=\s*(?:&&|;|\|\||$|["']))/, name: 'binary migrate subcommand' },
  // A wrapper script that forwards the prisma subcommands (`run-prisma-command.mjs migrate deploy`).
  { pattern: /\bmigrate\s+deploy\b/, name: 'migrate deploy' },
  // A binary's own migrate-on-boot flag (`./app -migrate`).
  { pattern: /(?:^|[\s"',])--?(?:auto-)?migrate(?:=true)?(?=[\s"',\]]|$)/, name: 'binary migrate flag' },
  // An interpreter that runs the app's own migrate script (`node ./db/migrations/$DB_DIALECT/migrate.cjs`).
  { pattern: /\b(?:node|bun|deno|tsx|python3?|php|ruby)\s+(?:[\w$./{}-]*\/)?migrat\w*\.(?:[cm]?[jt]s|py|php|rb)\b/, name: 'migrate script file' },
];

/**
 * The app's own install or upgrade command at start (`bin/console -n kimai:install`,
 * `shlink-installer init`). It is migration evidence only when the app also
 * declares a schema migration library, which that command then runs.
 */
const STARTUP_INSTALLER_REGEX = /\b(?:console|artisan|cli)\b[^\n]*?\s[\w-]+:(?:install|upgrade|update)\b|\b[\w.-]+-installer\s+(?:init|install|update|upgrade)\b/;
const MIGRATION_LIBRARY_REGEX = /doctrine\/(?:doctrine-)?migrations|robmorgan\/phinx|\bFluentMigrator\b/;
const LIBRARY_MANIFEST_REGEX = /(?:^|\/)(?:composer\.json|[^/]+\.csproj)$/;

/**
 * Application code that applies migrations itself when it runs (a migrator
 * API call, not a CLI command). Every regex of an entry must match the file.
 */
const STARTUP_CODE_MIGRATION_PATTERNS: { all: RegExp[]; name: string }[] = [
  { all: [/\.migrate\.(?:latest|up)\s*\(/], name: 'knex migrate.latest()' },
  { all: [/\bnew\s+Umzug\b/, /\.up\s*\(/], name: 'umzug up()' },
  { all: [/drizzle-orm\/[\w-]+\/migrator/, /\bmigrate\s*\(/], name: 'drizzle migrate()' },
  { all: [/\bdb-migrate\b/, /\bgetInstance\s*\(/, /\.up\s*\(/], name: 'db-migrate up()' },
  // A call, never a declaration (`async runMigrations(): Promise<void> {`).
  {
    all: [/(?<!\b(?:function|async|private|public|protected|static)\s+)\b(?:runMigrations|migrateDb|checkPendingMigrations)\s*\((?![^)]*\)\s*(?::\s*[\w<>[\]| ]+\s*)?\{)/],
    name: 'migration runner call',
  },
  { all: [/\bmigrationsRun\s*:\s*true\b/], name: 'typeorm migrationsRun' },
  {
    all: [/\b(?:exec|spawn)\w*\s*\(/, /prisma\s+migrate\s+deploy\b|["']migrate["']\s*,\s*["']deploy["']/],
    name: 'prisma migrate deploy',
  },
  { all: [/golang-migrate\/migrate/, /\.Up\s*\(\s*\)/], name: 'golang-migrate Up()' },
  { all: [/\bgoose\.Up(?:Context|To)?\s*\(/], name: 'goose.Up()' },
  { all: [/\bflask_migrate\b/, /\bupgrade\s*\(/], name: 'flask-migrate upgrade()' },
  { all: [/\bcall_command\(\s*['"]migrate['"]/], name: 'django call_command migrate' },
  { all: [/\bcommand\.upgrade\s*\(/], name: 'alembic command.upgrade()' },
];

const APP_CODE_FILE_REGEX = /\.(?:[cm]?[jt]sx?|py|go)$/;
// Migration definitions and seed data are never the code that runs them.
// Browser, CLI-subcommand and test-setup files never run at server start.
const MIGRATION_DEFINITION_SEGMENT_REGEX =
  /(?:^|\/)(?:migrations?|seeds?|seeders?|cli|command-line|commands?|client|frontend|web-frontend|webapp|browser)(?:\/|$)|(?:^|\/)test-?setup\.[a-z]+$/i;
// A file that stores data in the browser is front-end code: its `runMigrations()` upgrades local data.
const BROWSER_STORAGE_REGEX = /\b(?:localStorage|sessionStorage|indexedDB)\b/;
// Go files a server command runs, and the migrator calls they make.
const GO_ENTRY_FILE_REGEX = /(?:^|\/)(?:main|web|server|serve|start|run)\.go$/;
const GO_MIGRATOR_CALL_REGEX = /\b(?:migrations?\.(?:Up|UpWithFS|Migrate)|goose\.Up\w*|\w+\.AutoMigrate)\b/;
// The extension-less scripts an s6-overlay image (`ENTRYPOINT ["/init"]`) runs at start.
const S6_SCRIPT_PATH_REGEX = /(?:^|\/)s6-rc\.d\/[^/]+\/(?:run|up)$|(?:^|\/)cont-init\.d\/[^/]+$/;

/** An `ENV RUN_MIGRATIONS=1` / `AUTO_MIGRATE=true` style switch in the Dockerfile. */
const STARTUP_MIGRATION_ENV_REGEX =
  /^\s*ENV\s+.*\b(?:RUN_MIGRATIONS?|AUTO_MIGRAT(?:E|IONS?)|MIGRATE_ON_START(?:UP)?)\b\s*[= ]\s*["']?(?:1|true|yes|on)\b/im;

/** A deploy-safe migration command text (the same family apps/api resolves). */
const DEPLOY_MIGRATION_COMMAND_REGEX =
  /prisma\s+migrate\s+deploy\b|drizzle-kit\s+migrate\b|knex\s+migrate:(?:latest|up)\b|sequelize\s+db:migrate\b|typeorm\s+migration:run\b|node-pg-migrate\b|npx\s+migrate\b/;

/** One piece of startup-migration evidence. */
export interface MigrationStartupEvidence {
  /** Where the command lives: a script name, Dockerfile CMD/ENTRYPOINT, or a shell script path. */
  readonly source: string;
  readonly pattern: string;
  /**
   * True when the evidence is the selected Dockerfile's own CMD/ENTRYPOINT
   * text, a script that CMD/ENTRYPOINT invokes (directly or through
   * another script it calls), or application code that migrates when the
   * app runs — the exact chain the built image runs at boot. `analyser.ts` gives this evidence precedence over a package.json
   * deploy-shaped script (DEPLOY-029): the image was built to migrate
   * itself, so re-running the script as a separate pre-deploy step invents
   * a command the image never runs standalone.
   */
  readonly fromDockerCommand: boolean;
}

/** A token in Dockerfile CMD/ENTRYPOINT text (or a script it runs) that names a script file. */
const SCRIPT_PATH_TOKEN_REGEX = /[\w./-]+\.(?:sh|js|mjs|cjs|ts|ini)\b/g;

/**
 * Maximum number of script-to-script hops followed from the CMD/ENTRYPOINT
 * text. Exported so `apps/api`'s GitHub tree-fetch boundary can protect the
 * same chain from the `ANALYSIS_MAX_FILES` trim (DEPLOY-029) — see
 * `extractCmdScriptPaths` below.
 */
export const CMD_CHAIN_MAX_DEPTH = 3;

/**
 * Resolve a script token named in a CMD/ENTRYPOINT (or a script it runs) to
 * a path that actually exists in the tree — relative to the Dockerfile's own
 * directory first (`scripts/start-docker.sh` next to `docker/Dockerfile` is
 * `docker/scripts/start-docker.sh`), then relative to the tree root. An
 * absolute in-image path (`/usr/local/bin/docker-entrypoint.sh`) is the
 * same-named script the Dockerfile copied there from its own directory.
 */
function resolveCmdScriptPath(token: string, tree: FileTree, dockerDir: string): string | undefined {
  const clean = token.startsWith('/') ? (token.split('/').pop() ?? token) : token.replace(/^\.\//, '');
  const candidates = dockerDir.length > 0 ? [`${dockerDir}/${clean}`, clean] : [clean];
  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(tree, candidate)) return candidate;
  }
  // The image copies a subdirectory to its root (`COPY server .`): a script
  // named from there still resolves when exactly one tree path ends with it.
  const suffixed = Object.keys(tree).filter((path) => path.endsWith(`/${clean}`));
  return suffixed.length === 1 ? suffixed[0] : undefined;
}

/**
 * Every script path named in `text` that resolves to a tree file, not yet
 * visited. Exported (alongside `dockerfileImageCommand`/
 * `CMD_CHAIN_MAX_DEPTH`) so `apps/api`'s GitHub tree-fetch boundary can walk
 * the identical CMD/ENTRYPOINT chain — with a lazily-fetched `tree` — to
 * decide which paths must survive the `ANALYSIS_MAX_FILES` trim
 * (DEPLOY-029): a value passed here only needs a truthy key for each known
 * path, not real file content, so a caller that hasn't fetched blobs yet can
 * still use it for path resolution alone.
 */
export function extractCmdScriptPaths(text: string, tree: FileTree, dockerDir: string, visited: Set<string>): string[] {
  const found: string[] = [];
  for (const token of text.match(SCRIPT_PATH_TOKEN_REGEX) ?? []) {
    const resolved = resolveCmdScriptPath(token, tree, dockerDir);
    if (resolved && !visited.has(resolved)) {
      visited.add(resolved);
      found.push(resolved);
    }
  }
  return found;
}

/** `dist/db/migrate.js` and `src/db/migrate.ts` are the same script: compare the file name without extension. */
function scriptStem(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '');
}

const MIGRATION_SCRIPT_KEY_REGEX = /migrat/i;
// A script that runs a database tool by file (`db:migrate`, `migrate`), never the app's own start or dev command.
const DB_TOOL_SCRIPT_KEY_REGEX = /migrat|(?:^|[:_-])db(?:$|[:_-])/i;

// A script key that creates, undoes, copies, builds or tests migrations, or is
// the app's own start/dev command — never a run of the pending migrations.
const UNSAFE_MIGRATION_KEY_REGEX =
  /(?:^|[:_-])(?:create|generate|gen|make|new|rollback|down|undo|revert|reset|drop|fresh|seed|copy|build|test|push|prototype|dev|start|status)(?:$|[:_-])/i;

// Any step of a command that is not a plain "apply pending migrations": a
// create/generate/rollback/reset step, a dev schema sync (`push`), a test run,
// a copy/build/rename step, a seed, or a workspace/monorepo runner or `../`
// path (not available at the image WORKDIR). One unsafe step in a chain makes
// the whole command unsafe.
const UNSAFE_MIGRATION_COMMAND_REGEX = new RegExp(
  [
    String.raw`\bmigrat\w*(?:\.[cm]?[jt]s)?[\s:-]+(?:create|make|new|generate|rollback|down|reset|drop|fresh|revert|undo)\b`,
    String.raw`\bmakemigrations\b`,
    String.raw`\bdrizzle-kit\s+(?:generate|push|studio|drop|check|up)\b`,
    String.raw`\bprisma\s+(?:migrate\s+(?:reset|diff)|db\s+(?:push|seed|execute))\b`,
    String.raw`\bdb[\s:]push\b|\bdb:(?:reset|seed|drop)\b`,
    String.raw`\b(?:vitest|jest|mocha|ava|playwright|cypress)\b`,
    String.raw`(?:^|[\s;&|])(?:cp|mkdir|rsync|mv|rm|copyfiles|cpx|rimraf|tsc)\s`,
    String.raw`\b(?:rename|seed|build)\b`,
    String.raw`\bpnpm\s+(?:--filter|-F|-r|--recursive|--dir|-C)\b|\byarn\s+workspaces?\b|\bnpm\b[^&;|]*\s(?:-w|--workspaces?)\b|\bturbo\b|\bnx\s|\.\./`,
  ].join('|'),
  'i',
);

// Migration CLIs that normally sit in devDependencies, mapped to the package
// that provides them. The relay runs the command in the runtime image, where
// a devDependency is missing unless the Dockerfile kept dev dependencies.
const DEV_CLI_PACKAGES: Record<string, string> = {
  prisma: 'prisma',
  'drizzle-kit': 'drizzle-kit',
  knex: 'knex',
  sequelize: 'sequelize-cli',
  'sequelize-cli': 'sequelize-cli',
  typeorm: 'typeorm',
  tsx: 'tsx',
  'ts-node': 'ts-node',
  'ts-node-dev': 'ts-node-dev',
  'vite-node': 'vite-node',
  'babel-node': '@babel/node',
  esno: 'esno',
  'dotenv-flow': 'dotenv-flow',
  'dotenv-cli': 'dotenv-cli',
  dotenv: 'dotenv-cli',
  'node-pg-migrate': 'node-pg-migrate',
  'db-migrate': 'db-migrate',
};
const DEV_CLI_TOKEN_REGEX = new RegExp(`(?:^|[\\s;&|(])(${Object.keys(DEV_CLI_PACKAGES).join('|')})(?=\\s|$)`, 'g');

/**
 * The image's runtime working directory and the directory the repository was
 * copied into, read from the LAST build stage of a Dockerfile (an earlier
 * stage's WORKDIR never survives into the runtime image): the first WORKDIR
 * in that stage is where the repo lands (e.g. `/app`), and the last WORKDIR
 * is where `CMD`/the relay's `sh -c <command>` actually runs from — they
 * differ whenever the final stage `WORKDIR`s into a subdirectory afterwards
 * (Documenso's `docker/Dockerfile` sets `WORKDIR /app` then later `WORKDIR
 * /app/apps/remix`). Relative WORKDIRs chain off the previous one, as Docker
 * itself resolves them. No WORKDIR at all means both default to the same
 * directory, so no relative adjustment is needed.
 */
export function dockerfileWorkdirs(content: string): { imageRoot: string; runtimeCwd: string } {
  const lastStageStart = [...content.matchAll(/^\s*FROM\s+\S+/gim)].at(-1)?.index ?? 0;
  const finalStage = content.slice(lastStageStart);

  const dirs: string[] = [];
  let current = '/';
  for (const match of finalStage.matchAll(/^\s*WORKDIR\s+(\S+)/gim)) {
    const raw = match[1]!.replace(/^["']|["']$/g, '');
    current = raw.startsWith('/') ? raw : posixPath.join(current, raw);
    dirs.push(current);
  }
  const imageRoot = dirs[0] ?? '/';
  const runtimeCwd = dirs.at(-1) ?? imageRoot;
  return { imageRoot, runtimeCwd };
}

/** True when a Dockerfile stage runs a plain (non-production) package install and never prunes. */
function stageInstallsDevDependencies(stage: string): boolean {
  const lines = stage.split('\n');
  const installs = lines.filter((line) =>
    /^\s*RUN\b.*\b(?:npm\s+(?:ci|install|i)\b|pnpm\s+(?:install|i)\b|yarn(?:\s+install)?(?=\s*(?:&&|;|\\|$)|\s+-))/i.test(line),
  );
  return (
    installs.some((line) => !/--prod|--omit=dev|--only=prod|NODE_ENV=production/i.test(line)) &&
    !lines.some((line) => /\bprune\b/i.test(line))
  );
}

/**
 * True when the selected Dockerfile's FINAL stage evidently keeps dev
 * dependencies: it runs a plain install itself, or copies the whole app dir
 * or `node_modules` from an earlier stage that did.
 */
function finalStageKeepsDevDependencies(content: string): boolean {
  const stages = content.split(/^(?=\s*FROM\s)/im).filter((stage) => /^\s*FROM\s/i.test(stage));
  const finalStage = stages.at(-1);
  if (finalStage === undefined) return false;
  if (stageInstallsDevDependencies(finalStage)) return true;
  for (const match of finalStage.matchAll(/^\s*COPY\s+--from=(\S+)\s+(\S+)/gim)) {
    const [, from, source] = match;
    const index = stages.findIndex(
      (stage, i) => from === String(i) || new RegExp(`^\\s*FROM\\s+\\S+\\s+AS\\s+${from}\\b`, 'i').test(stage),
    );
    const copiesDependencies = match[0].includes('node_modules') || /^(?:\.\/?|\/[\w-]+\/?\.?)$/.test(source!);
    if (index >= 0 && index < stages.length - 1 && copiesDependencies && stageInstallsDevDependencies(stages[index]!)) {
      return true;
    }
  }
  return false;
}

/** True when `name` is a runtime dependency of the package.json in `dir`. */
function hasRuntimeDependency(tree: FileTree, dir: string, name: string): boolean {
  const manifest = parsePackageJsonsWithPath(tree).find(({ path }) => path === (dir ? `${dir}/package.json` : 'package.json'));
  return ['dependencies', 'optionalDependencies'].some((field) => {
    const deps = manifest?.pkg[field];
    return typeof deps === 'object' && deps !== null && name in deps;
  });
}

/**
 * The migration script Deployz may freeze into the pre-deploy one-shot task:
 * a migration-shaped script of the DEPLOYED app's own package (the repo root,
 * the Dockerfile's directory, or the runtime WORKDIR's package) that applies
 * pending migrations and nothing else, and whose CLI exists in the runtime
 * image. Prefers a deploy-shaped command. Undefined when nothing is
 * evidently safe — an absent command is safer than a wrong one running
 * unattended against the production database.
 */
/** The package directories the image runs: the root, the Dockerfile's directory and the runtime WORKDIR. */
function deployedPackageDirs(tree: FileTree): Set<string> {
  const dockerfile = selectedDockerfile(tree);
  const appDirs = new Set(['']);
  if (dockerfile) {
    const { imageRoot, runtimeCwd } = dockerfileWorkdirs(dockerfile.content);
    appDirs.add(dockerfile.path.includes('/') ? dockerfile.path.split('/').slice(0, -1).join('/') : '');
    appDirs.add(posixPath.relative(imageRoot, runtimeCwd));
  }
  return appDirs;
}

export function selectMigrationScript(tree: FileTree): [key: string, command: string, packageDir: string] | undefined {
  const dockerfile = selectedDockerfile(tree);
  const appDirs = deployedPackageDirs(tree);
  const keepsDevDependencies = dockerfile !== null && finalStageKeepsDevDependencies(dockerfile.content);

  const safe = collectScriptsWithDir(tree).filter(([key, command, dir]) => {
    // A blank value is a comment entry (`"// use x migrations:run": ""`), not a script.
    if (command.trim() === '') return false;
    if (!MIGRATION_SCRIPT_KEY_REGEX.test(key) && !DEPLOY_MIGRATION_COMMAND_REGEX.test(command)) return false;
    if (!appDirs.has(dir) || UNSAFE_MIGRATION_KEY_REGEX.test(key)) return false;
    if (MIGRATION_DEV_REGEX.test(command) || UNSAFE_MIGRATION_COMMAND_REGEX.test(command)) return false;
    if (keepsDevDependencies) return true;
    return [...command.matchAll(DEV_CLI_TOKEN_REGEX)].every(([, cli]) =>
      hasRuntimeDependency(tree, dir, DEV_CLI_PACKAGES[cli!]!),
    );
  });
  return safe.find(([, command]) => DEPLOY_MIGRATION_COMMAND_REGEX.test(command)) ?? safe[0];
}

/**
 * A package script for a database schema step (`migrate`, `alteration`) that is no deploy-safe
 * migration command: the app migrates by a step that nothing runs (Logto: `alteration: logto db alt`).
 */
export function unusableMigrationScript(tree: FileTree): [key: string, command: string] | undefined {
  return collectScripts(tree).find(([key, command]) => command.trim() !== '' && /migrat|alteration/i.test(key) && !UNSAFE_MIGRATION_KEY_REGEX.test(key));
}

/** A safe migration script exists for the deployed app — the mode='pre_deploy' signal. */
export function hasPreDeployMigration(tree: FileTree): boolean {
  return selectMigrationScript(tree) !== undefined;
}

/**
 * Migrations that run when the APPLICATION STARTS: the app's own start
 * script, the selected Dockerfile's CMD/ENTRYPOINT (plus every script that
 * CMD/ENTRYPOINT invokes, transitively), or an entrypoint/start/boot shell
 * script next to the Dockerfile (or at the app root). Evidence only — the
 * command is never invented into the manifest.
 */
export function detectStartupMigrationEvidence(tree: FileTree): MigrationStartupEvidence[] {
  const evidence: MigrationStartupEvidence[] = [];
  const migrationLibrary = Object.entries(tree).some(([path, content]) => LIBRARY_MANIFEST_REGEX.test(path) && MIGRATION_LIBRARY_REGEX.test(content ?? ''));
  const consider = (command: string, source: string, fromDockerCommand: boolean): void => {
    if (MIGRATION_DEV_REGEX.test(command)) return;
    for (const { pattern, name } of STARTUP_MIGRATION_PATTERNS) {
      if (pattern.test(command)) {
        evidence.push({ source, pattern: name, fromDockerCommand });
        return;
      }
    }
    if (migrationLibrary && STARTUP_INSTALLER_REGEX.test(command)) {
      evidence.push({ source, pattern: 'install command with a migration library', fromDockerCommand });
    }
  };

  const considerCode = (path: string, fromDockerCommand: boolean): void => {
    const content = tree[path] ?? '';
    const found = STARTUP_CODE_MIGRATION_PATTERNS.find(({ all }) => all.every((regex) => regex.test(content)));
    if (found) evidence.push({ source: path, pattern: found.name, fromDockerCommand });
  };

  const dockerfile = selectedDockerfile(tree);
  const dockerDir = dockerfile?.path?.includes('/') ? (dockerfile.path.split('/').slice(0, -1).join('/') ?? '') : '';
  // Files already scanned through the CMD/ENTRYPOINT chain, so the
  // independent boot-script heuristic below never double-counts them.
  const chainVisited = new Set<string>();

  // Follow the script(s) a boot command names (`sh scripts/start-docker.sh`,
  // `node db/init.js`), and every script THOSE scripts call in turn, up to
  // depth 3, never visiting a file twice.
  const followScripts = (text: string, fromDockerCommand: boolean): void => {
    let frontier = extractCmdScriptPaths(text, tree, dockerDir, chainVisited);
    for (let depth = 0; depth < CMD_CHAIN_MAX_DEPTH && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const path of frontier) {
        const content = tree[path];
        if (content === undefined) continue;
        consider(content, path, fromDockerCommand);
        if (APP_CODE_FILE_REGEX.test(path)) considerCode(path, fromDockerCommand);
        next.push(...extractCmdScriptPaths(content, tree, dockerDir, chainVisited));
      }
      frontier = next;
    }
  };

  // A start script that CMD/ENTRYPOINT calls (`npm start`) is what the image
  // boots, so it counts as Dockerfile-command evidence.
  const imageRunsStartScript =
    dockerfile !== null &&
    /\b(?:npm|yarn|pnpm)\s+(?:run\s+)?start\b/.test(Object.values(dockerfileImageCommand(dockerfile.content)).join(' '));
  for (const [name, command] of collectScripts(tree)) {
    if (name === 'start' || name === 'dev') {
      consider(command, `package.json script "${name}"`, name === 'start' && imageRunsStartScript);
    }
    if (name === 'start') followScripts(command, imageRunsStartScript);
  }

  if (dockerfile) {
    const { cmd, entrypoint: entry } = dockerfileImageCommand(dockerfile.content);
    if (cmd) consider(cmd, `CMD (${dockerfile.path})`, true);
    if (entry) consider(entry, `ENTRYPOINT (${dockerfile.path})`, true);
    if (STARTUP_MIGRATION_ENV_REGEX.test(dockerfile.content)) {
      evidence.push({ source: `ENV (${dockerfile.path})`, pattern: 'migrate-on-start ENV', fromDockerCommand: true });
    }

    // The built image runs this exact chain at boot, regardless of which
    // directory the scripts live in (DEPLOY-029: umami's migration lived two
    // hops below CMD, under `scripts/`).
    followScripts(`${cmd ?? ''} ${entry ?? ''}`, true);
  }

  // A Procfile `web:` line starts the app. `release:` runs before deploy and is never startup.
  for (const [path, content] of Object.entries(tree)) {
    if (!content || !PROCFILE_REGEX.test(path) || !isRuntimeSourcePath(path)) continue;
    const web = /^web:\s*(.+)$/m.exec(content);
    if (web?.[1]) consider(web[1], `Procfile web (${path})`, false);
  }

  if (dockerfile && /^\s*(?:ENTRYPOINT|CMD)\s+\[?\s*["']?\/init\b/m.test(dockerfile.content)) {
    for (const [path, content] of Object.entries(tree)) {
      if (content && S6_SCRIPT_PATH_REGEX.test(path)) consider(content, path, true);
    }
  }

  // Go: a server command file that calls a migrator, or the package function it calls (`initialize.FullInit()`).
  const imageRuntime = dockerfile ? startedRuntime(tree, productionStageText(dockerfile.content)) : null;
  if (imageRuntime === null || imageRuntime === 'go') {
    const goFiles = Object.entries(tree).filter(
      ([path, content]) =>
        content &&
        /\.go$/.test(path) &&
        isRuntimeSourcePath(path) &&
        !/(?:^|\/)(?:gen|dump|tools?)\//.test(path) &&
        !/migrat/i.test(path.split('/').pop() ?? ''),
    );
    for (const [path, content] of goFiles) {
      if (!GO_ENTRY_FILE_REGEX.test(path)) continue;
      const reached: [string, string][] = [[path, content]];
      for (const [, pkg] of content.matchAll(/\b(\w+)\.(?:Full)?Init\w*\s*\(/g)) {
        for (const [other, otherContent] of goFiles) {
          if (other !== path && new RegExp(`(?:^|/)${pkg}/[^/]+\\.go$`).test(other)) reached.push([other, otherContent]);
        }
      }
      for (const [file, text] of reached) {
        if (GO_MIGRATOR_CALL_REGEX.test(text) && !evidence.some((entry) => entry.source === file)) {
          evidence.push({ source: file, pattern: 'go migrator call on the start path', fromDockerCommand: true });
        }
      }
    }
  }

  for (const [path, content] of Object.entries(tree)) {
    if (chainVisited.has(path) || !content || !isRuntimeSourcePath(path)) continue;
    const basename = (path.split('/').pop() ?? '').toLowerCase();
    const isBootScript = /^entrypoint(?:\.|$)|^start\.sh$|^boot\.sh$|^startup\.sh$/.test(basename);
    const nearRoot =
      !path.includes('/') || (dockerDir.length > 0 && path.startsWith(`${dockerDir}/`));
    if (!isBootScript || !nearRoot) continue;
    consider(content, path, false);
  }

  // Application code that calls a migrator (`knex.migrate.latest()`): the app
  // migrates itself when it runs. A file that only a package.json CLI script
  // runs (`tsx src/db/migrate.ts`) is a pre-deploy tool, not the app — it
  // counts only when the boot chain above reached it.
  const cliStems = new Set<string>();
  for (const [name, command] of collectScripts(tree)) {
    if (!DB_TOOL_SCRIPT_KEY_REGEX.test(name)) continue;
    for (const token of command.match(SCRIPT_PATH_TOKEN_REGEX) ?? []) cliStems.add(scriptStem(token));
  }
  for (const [path, content] of Object.entries(tree)) {
    if (chainVisited.has(path) || !content || !APP_CODE_FILE_REGEX.test(path) || !isRuntimeSourcePath(path)) continue;
    if (MIGRATION_DEFINITION_SEGMENT_REGEX.test(path) || cliStems.has(scriptStem(path))) continue;
    if (BROWSER_STORAGE_REGEX.test(content)) continue;
    considerCode(path, true);
  }

  return evidence;
}

/**
 * Detect migration commands from package.json scripts.
 */
export function detectMigrationCommand(tree: FileTree): DetectorFinding {
  const detected: string[] = [];

  for (const [, command] of collectScripts(tree)) {
    for (const { pattern, name } of MIGRATION_PATTERNS) {
      if (pattern.test(command) && !detected.includes(name)) {
        detected.push(name);
      }
    }
  }

  if (detected.length === 0) {
    return { detector: 'migration-command', detected: false };
  }

  return {
    detector: 'migration-command',
    detected: true,
    value: detected,
    details: `Migration commands detected: ${detected.join(', ')}`,
    source: 'package-manifest',
  };
}

// 11. Startup command
// ---------------------------------------------------------------------------

const CMD_REGEX = /^CMD\s+(.+)$/m;
const ENTRYPOINT_REGEX = /^ENTRYPOINT\s+(.+)$/m;

/**
 * The CMD and ENTRYPOINT arguments of the image `docker build` produces: the
 * last of each in the production stage and the stages it is built `FROM`.
 * A HEALTHCHECK's `CMD` continuation line and a CMD of another stage are not
 * the image command. Exported alongside `extractCmdScriptPaths` for apps/api's
 * GitHub tree-fetch boundary (DEPLOY-029).
 */
export function dockerfileImageCommand(content: string): { cmd: string | undefined; entrypoint: string | undefined } {
  const stage = productionStageText(content);
  const last = (name: string): string | undefined => [...stage.matchAll(new RegExp(`^\\s*${name}\\s+(.+)$`, 'gim'))].pop()?.[1]?.trim();
  return { cmd: last('CMD'), entrypoint: last('ENTRYPOINT') };
}

/**
 * Detect the application startup command from the selected Dockerfile's
 * CMD/ENTRYPOINT instructions and package.json "start" script.
 */
/** A start script that builds before it runs: a compiler or bundler step. */
const START_BUILD_STEP_REGEX = /(?:^|&&|;)\s*(?:npx\s+)?(?:tsc|webpack|vite\s+build|next\s+build|nest\s+build|turbo|nx|lerna|(?:npm|yarn|pnpm)\s+(?:run\s+)?build)\b/;

/** A package.json directory that is a JavaScript workspace root. */
function isWorkspaceRoot(tree: FileTree, dir: string): boolean {
  const prefix = dir === '' ? '' : `${dir}/`;
  if (tree[`${prefix}pnpm-workspace.yaml`] !== undefined) return true;
  try {
    return 'workspaces' in (JSON.parse(tree[`${prefix}package.json`] ?? '{}') as Record<string, unknown>);
  } catch {
    return false;
  }
}

export function detectStartupCommand(tree: FileTree): DetectorFinding {
  const sources: string[] = [];
  let source: DetectorSource | undefined;

  // 1. The selected Dockerfile's CMD/ENTRYPOINT — the image Deployz builds,
  //    not every scaffold or sibling image in the repository.
  const dockerfile = selectedDockerfile(tree);
  if (dockerfile) {
    // The container runs the image command only; a package.json script is not run.
    const noDefault = detectNoDefaultServerCommand(dockerfile.content);
    if (noDefault !== null) {
      return { detector: 'startup-command', detected: false, details: `${dockerfile.path}: ${noDefault}` };
    }
    const { cmd, entrypoint } = dockerfileImageCommand(dockerfile.content);
    if (cmd) sources.push(`CMD: ${cmd}`);
    if (entrypoint) sources.push(`ENTRYPOINT: ${entrypoint}`);
    if (sources.length > 0) source = 'dockerfile';
  }

  // 2. package.json "start" script, when it belongs to the image. A workspace
  //    root's script orchestrates packages, and a script that compiles first
  //    (`tsc && node dist/app.js`) needs build tools the runtime image may not
  //    have — neither is the container's command, so the vendor is asked.
  const appDirs = deployedPackageDirs(tree);
  for (const [name, command, dir] of nodeManifestsApplyToImage(tree) ? collectScriptsWithDir(tree) : []) {
    if (name === 'start' && appDirs.has(dir) && !isWorkspaceRoot(tree, dir) && !START_BUILD_STEP_REGEX.test(command)) {
      sources.push(`start: ${command}`);
      source ??= 'package-manifest';
    }
  }

  if (sources.length === 0) {
    return { detector: 'startup-command', detected: false };
  }

  return {
    detector: 'startup-command',
    detected: true,
    value: sources,
    details: `Startup commands detected: ${sources.join('; ')}`,
    source,
  };
}

// 12. External services
// ---------------------------------------------------------------------------

/**
 * §11.3 catalog — the external services Deployz detects deterministically and
 * the well-known configuration keys each maps to. Deployz only ever COLLECTS
 * configuration for these; it never provisions the service itself. `packages`
 * are dependency tokens matched in dependency manifests/imports; `urlDomains`
 * are a secondary signal (an API host configured in code with no SDK dep).
 */
export interface ExternalServiceDefinition {
  /** Stable canonical id, also used as the manifest.externalServices entry. */
  id: string;
  /** Dependency/import tokens that prove the service SDK is used. */
  packages: string[];
  /** The service's own API hosts, matched only inside URL literals. */
  urlDomains: string[];
  /** Well-known env keys the service configures, most-required first. */
  keys: string[];
}

export const EXTERNAL_SERVICE_CATALOG: ExternalServiceDefinition[] = [
  { id: 'stripe', packages: ['stripe'], urlDomains: ['api.stripe.com'], keys: ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET'] },
  { id: 'clerk', packages: ['@clerk/clerk-sdk-node', '@clerk/clerk-js', '@clerk/nextjs', '@clerk/clerk-react', '@clerk/backend'], urlDomains: ['clerk.com'], keys: ['CLERK_SECRET_KEY', 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY'] },
  { id: 'auth0', packages: ['auth0', '@auth0/auth0-react', '@auth0/nextjs-auth0', '@auth0/auth0-spa-js', 'auth0-js'], urlDomains: ['auth0.com'], keys: ['AUTH0_DOMAIN', 'AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET'] },
  { id: 'resend', packages: ['resend'], urlDomains: ['api.resend.com'], keys: ['RESEND_API_KEY'] },
  { id: 'sendgrid', packages: ['@sendgrid/mail', '@sendgrid/client', 'sendgrid'], urlDomains: ['api.sendgrid.com'], keys: ['SENDGRID_API_KEY'] },
  { id: 'smtp', packages: ['nodemailer', 'nodemailer-smtp-transport', 'nodemailer-smtp-pool'], urlDomains: [], keys: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'] },
  { id: 'sentry', packages: ['@sentry/node', '@sentry/nextjs', '@sentry/browser', '@sentry/react', '@sentry/serverless'], urlDomains: ['sentry.io'], keys: ['SENTRY_DSN'] },
  { id: 'openai', packages: ['openai', 'openai-node'], urlDomains: ['api.openai.com'], keys: ['OPENAI_API_KEY'] },
  { id: 'anthropic', packages: ['@anthropic-ai/sdk'], urlDomains: ['api.anthropic.com'], keys: ['ANTHROPIC_API_KEY'] },
  { id: 'twilio', packages: ['twilio'], urlDomains: ['api.twilio.com'], keys: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'] },
  { id: 'shopify', packages: ['@shopify/shopify-api', 'shopify-api-node'], urlDomains: ['myshopify.com', 'shopify.com'], keys: ['SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET'] },
];

/** A single detected §11.3 integration, with its env-key mapping. */
export interface ExternalServiceRequirement {
  service: string;
  /** Evidence the vendor can read (file paths / declared packages). */
  evidence: string[];
}

/** True when a code/import scan or dependency manifest proves the token is used. */
function dependencyOrImportHit(tree: FileTree, token: string): string[] {
  if (collectDependencyNames(tree).includes(token)) return ['package.json dependency'];
  // SMTP is often used through Python's stdlib (no dependency to declare).
  if (token === 'nodemailer') {
    for (const [path, content] of Object.entries(tree)) {
      if (content && /import\s+smtplib/.test(content)) return [path];
    }
  }
  return findDependencyEvidence(tree, token);
}

/** Match a URL literal against the domains of a catalog entry. */
function urlHitsDomain(content: string, domains: string[]): boolean {
  if (domains.length === 0) return false;
  for (const domain of domains) {
    const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`https?:\\/\\/[^'"\\s]*${escaped}`).test(content)) return true;
  }
  return false;
}

/** Match a service's keys anywhere they are read or declared (env files, code, Prisma). */
function envKeyEvidence(tree: FileTree, key: string): boolean {
  const envRe = new RegExp(`^${key}\\s*[=:]`, 'm');
  for (const [path, content] of Object.entries(tree)) {
    if (!content) continue;
    if (/^\.env(\.\w+)?$/i.test(path) && envRe.test(content)) return true;
    if (JS_SOURCE.test(path) && new RegExp(`process\\.env\\.${key}\\b`).test(content)) return true;
    if (PY_SOURCE.test(path) && (new RegExp(`os\\.environ(?:\\[|\\s*\\.\\s*get\\s*\\().{0,3}['"]${key}['"]`).test(content) || new RegExp(`os\\.getenv\\s*\\(\\s*['"]${key}['"]`).test(content))) return true;
  }
  return false;
}

/**
 * Detect external (non-Deployz) service integrations (§11.3). Deterministic:
 * a canonical service is recorded only when its SDK package or API host is
 * actually present. The old generic "any external HTTP URL is a service"
 * scan is gone — it turned documentation links and CDN hosts into bogus
 * integrations.
 */
export function detectExternalServices(tree: FileTree): DetectorFinding {
  const requirements = collectExternalServices(tree);

  if (requirements.length === 0) {
    return { detector: 'external-services', detected: false };
  }

  return {
    detector: 'external-services',
    detected: true,
    value: requirements.map((r) => r.service),
    details: `External services detected: ${requirements.map((r) => r.service).join(', ')}`,
  };
}

/**
 * The §11.3 service requirements as structured metadata — the manifest
 * external-services surface and the env-model enrichment both read from it.
 */
export function detectExternalServiceRequirements(tree: FileTree): ExternalServiceRequirement[] {
  return collectExternalServices(tree);
}

/** Shared §11.3 collector used by both public entry points. */
function collectExternalServices(tree: FileTree): ExternalServiceRequirement[] {
  const requirements: ExternalServiceRequirement[] = [];
  for (const def of EXTERNAL_SERVICE_CATALOG) {
    const evidence: string[] = [];
    for (const pkg of def.packages) {
      for (const hit of dependencyOrImportHit(tree, pkg)) {
        const text = `${pkg} (${hit})`;
        if (!evidence.includes(text)) evidence.push(text);
      }
    }
    // URL evidence only counts when no package evidence exists (a host alone
    // is weaker than a declared SDK, but still a real integration when the
    // code points at the service's API).
    if (evidence.length === 0 && def.urlDomains.length > 0) {
      for (const [path, content] of Object.entries(tree)) {
        if (content && urlHitsDomain(content, def.urlDomains)) {
          evidence.push(`${def.urlDomains[0]} URL in ${path}`);
        }
      }
    }
    if (evidence.length > 0) {
      requirements.push({ service: def.id, evidence });
    }
  }
  return requirements;
}

/**
 * Map a §11.3 catalog key onto a detected integration. Returns the catalog
 * definition plus whether the repository itself evidences the key (an env
 * sample line or a code read) — only evidenced keys become REQUIRED manifest
 * variables, so a vendor that wires a different key name is never blocked on
 * a canonical one it does not use.
 */
export function findExternalServiceForEnvKey(
  tree: FileTree,
  services: string[],
  key: string,
): { service: string; key: string; evidenced: boolean } | null {
  const def = EXTERNAL_SERVICE_CATALOG.find(
    (candidate) => candidate.keys.includes(key) && services.includes(candidate.id),
  );
  if (!def) return null;
  return { service: def.id, key, evidenced: envKeyEvidence(tree, key) };
}

// 12b. Env-var model (§11.2)
// ---------------------------------------------------------------------------

const SECRET_NAME_REGEX =
  /SECRET|TOKEN|PASSWORD|PASS(?!WORD|ENGER|AGE|IVE)|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|_KEY\b|_PASS\b/i;

/**
 * Sample files the env model treats as documentation of the app's config:
 * they name variables, but their values never reach the running container.
 * A plain `.env` is a runtime file, not a sample.
 */
const ENV_SAMPLE_FILE_REGEX = /(?:^|\/)\.env\.(?:example|sample|template)$/i;

// Helpers that parse an environment value and take a default as a later
// argument: `parseEnvVarNumber(process.env.X, 10)`, `getEnv(process.env.X, 'a')`,
// `envBool(process.env.X, false)`.
const DEFAULTING_HELPER_REGEX = /^(?:parse|read|get|load|resolve|env|to)\w*$|(?:Number|Boolean|Bool|String|Int|Float|List|Env)$/;

/** Source evidence for a variable whose sample value is a path (`BASE_URL=/app`), not a URL. */
export const SAMPLE_PATH_EVIDENCE = 'sample value is a path';

/** A framework prefix whose variables are inlined into client code at build time. */
export const CLIENT_BUILD_PREFIX_REGEX = /^(?:NEXT_PUBLIC|VITE|REACT_APP|PUBLIC|NUXT_PUBLIC|EXPO_PUBLIC|GATSBY|STORYBOOK)_/;

/** A directory of browser code: its env reads are inlined at build time. */
export const CLIENT_DIRECTORY_REGEX = /(?:^|\/)(?:client|frontend|front-end|ui)\//;

/** Names that mean "the address this app is served from". */
export const OWN_URL_NAME_REGEX =
  /^(?:PUBLIC_URL|APP_URL|BASE_URL|SITE_URL|ROOT_URL|WEB_URL|APP_BASE_URL|PUBLIC_ORIGIN|ORIGIN|NEXTAUTH_URL|AUTH_URL|SITE_ROOT)$/;

/** A tuning value (a limit, a size, a timeout, a flag): the app has a default for it. */
const TUNING_NAME_REGEX =
  /(?:^|_)(?:LIMITS?|MAX|MIN|TIMEOUT|INTERVAL|SIZE|BYTES|COUNT|THRESHOLD|CONCURRENCY|THREADS|TTL|PCT|MS|SECONDS|EXPIRY|DURATION|DELAY|RETRIES|ENABLED|DISABLED|DEBUG|VERBOSE|LEVEL|FORMAT)(?:_|$)|^(?:ALLOW|SHOW|USE|ENABLE|DISABLE)_/;

/** Names the operating system sets (uptime-kuma reads LOCALAPPDATA to find a browser on Windows): never vendor input. */
const PLATFORM_ENV_NAME_REGEX =
  /^(?:LOCALAPPDATA|APPDATA|PROGRAMFILES|PROGRAMDATA|USERPROFILE|SYSTEMROOT|WINDIR|COMSPEC|HOMEDRIVE|HOMEPATH|HOME|PATH|USER|SHELL|PWD|TMPDIR|TEMP|TMP|LANG|TERM)$/;

/** An integration the app switches on only when its key is present: mail, error and usage monitoring, chat, social login. */
const OPTIONAL_INTEGRATION_NAME_REGEX =
  /^(?:MAIL|SMTP|EMAIL|MAILER|MAILGUN|SENDGRID|POSTMARK|RESEND|SES|SENTRY|POSTHOG|AMPLITUDE|ANALYTICS|DATADOG|NEWRELIC|NEW_RELIC|BUGSNAG|ROLLBAR|MIXPANEL|SCOUT|SLACK|DISCORD|TELEGRAM|TWILIO|OIDC|OAUTH|SAML|LDAP)_|_CLIENT_(?:ID|SECRET)$/;

/**
 * Whether a read makes the variable required. A strong read (a boot guard, a
 * schema without default, an `assert` helper, `ENV.fetch`, a Go `required`
 * tag) always does. A weak read (a bare argument, a stored value, a config
 * file lookup) only proves that the app reads the key. It does not make a
 * tuning value or an optional integration credential required: the app has a
 * default, or the integration is off without it. A client build-time name
 * counts only when it is the app's own address (`NEXT_PUBLIC_BASE_URL`); it
 * is a build input, never derived.
 */
function readNeedsValue(
  key: string,
  read: { needsValue: boolean; strong: boolean },
  optionalIntegration: boolean,
): boolean {
  if (PLATFORM_ENV_NAME_REGEX.test(key)) return false;
  if (read.strong) return true;
  if (!read.needsValue) return false;
  if (CLIENT_BUILD_PREFIX_REGEX.test(key)) {
    return OWN_URL_NAME_REGEX.test(key) || OWN_URL_NAME_REGEX.test(key.replace(CLIENT_BUILD_PREFIX_REGEX, ''));
  }
  return !optionalIntegration && !TUNING_NAME_REGEX.test(key);
}

/** A value that documents "no usable default" (blank or a named placeholder). */
function isPlaceholderValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  return /^<[^>]*>$|^(?:your|your[-_ ]|xxx+|changeme|change[-_ ]me|example|placeholder|\.\.\.)$/i.test(trimmed);
}

// ── Stage B phase 3 (COMP-017): schema-library / helper-form env reads ──────
// Narrow, evidence-backed recognition of the common "required config behind an
// abstraction" shapes: zod object schemas, envalid validators, throwing
// `env('KEY')` helpers, pydantic BaseSettings, JVM @Value, Go os.Getenv,
// .NET GetConnectionString. No general program interpretation.

const JAVA_SOURCE_REGEX = /\.(?:java|kt|kts|scala)$/;
const DOTNET_SOURCE_REGEX = /\.cs$/;
const PHP_SOURCE_REGEX = /\.php$/;
const RUST_SOURCE_REGEX = /\.rs$/;
const ELIXIR_SOURCE_REGEX = /\.exs?$/;
/** A Rust build script or test module file: it never runs in the deployed app. */
const RUST_NON_RUNTIME_FILE_REGEX = /(?:^|\/)(?:build|tests?)\.rs$/;
const APP_SETTINGS_FILE_REGEX = /(?:^|\/)appsettings(?:\.Production)?\.json$/;
/** Configuration for development or tests only: Elixir `config/dev.exs`, a Spring `dev`/`test` profile. */
const DEV_CONFIG_FILE_REGEX = /(?:^|\/)config\/(?:dev|test)\.exs$|(?:^|\/)application-(?:dev|development|local|test)\.(?:properties|ya?ml)$/i;
const ENV_KEY_LITERAL = /[A-Z][A-Z0-9_]*/;

/** A key literal `[A-Z][A-Z0-9_]*`, or null when the placeholder is not env-shaped. */
function envKeyLiteral(raw: string): string | null {
  return ENV_KEY_LITERAL.test(raw) ? raw : null;
}

/** The characters of a member/chain expression up to its closing delimiter (comma or brace). */
function sliceToChainEnd(content: string, start: number, limit = 240): string {
  let depth = 0;
  for (let i = start; i < content.length && i - start < limit; i += 1) {
    const ch = content[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === ',' || ch === '}')) return content.slice(start, i);
  }
  return content.slice(start, Math.min(content.length, start + limit));
}

/** zod object schemas used with process.env (`CORE_SECRET: z.string().min(1)`). */
function scanZodEnvReads(content: string): { key: string; needsValue: boolean }[] {
  const isZod = /(?:from\s+['"]zod['"]|require\(\s*['"]zod['"]\s*\))/.test(content);
  if (!isZod || !(content.includes('.object(') || /\bcreateEnv\s*\(/.test(content)) || !content.includes('process.env')) return [];
  const found: { key: string; needsValue: boolean }[] = [];
  // A schema parsed only inside a function (`getSlackEnv()`) is checked when
  // its feature runs, not at boot.
  const parseIndents = [...content.matchAll(/^([ \t]*)\S.*\.(?:safeParse|parse)\(\s*process\.env\b/gm)].map((m) => m[1]!);
  const lazy = parseIndents.length > 0 && parseIndents.every((indent) => indent.length > 0);
  const memberRegex = /^\s*([A-Z][A-Z0-9_]*)\s*:\s*z\./gm;
  let match: RegExpExecArray | null;
  while ((match = memberRegex.exec(content)) !== null) {
    const chain = sliceToChainEnd(content, memberRegex.lastIndex);
    const optional = lazy || /(?:\.default\s*\(|\.optional\s*\(|\.nullish\s*\(|\.catch\s*\()/.test(chain);
    found.push({ key: match[1]!, needsValue: !optional });
  }
  return found;
}

/**
 * Members of the same zod env schema built by a local helper
 * (`BILLING_ENABLED: envBool("false")`): the key is read, and the helper
 * decides what absence means, so the read alone never requires it.
 */
function scanZodHelperEnvReads(content: string): { key: string; needsValue: boolean }[] {
  if (scanZodEnvReads(content).length === 0) return [];
  return [...content.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:\s*[a-z][\w$]*\s*\(/gm)].map((match) => ({
    key: match[1]!,
    needsValue: false,
  }));
}

/** The header of a request handler right before a statement: `async function get(req, res) {`. */
const REQUEST_HANDLER_HEADER_REGEX = /\b(?:req|request|reply|ctx)\b[^()]*\)\s*(?:=>\s*)?\{\s*$/;

/** A feature switch: a guard on it protects one feature, never the boot. */
const FEATURE_FLAG_NAME_REGEX = /(?:^|_)(?:ENABLED?|DISABLED?)(?:_|$)/;

/**
 * Keys the app refuses to boot without: `if (!env.KEY) throw …`, or the same
 * test narrowed only by "not in mode X" (`env.DEPLOY_MODE !== "desktop" &&
 * !env.KEY`). Such a key is required even when its schema says `.optional()`.
 * A guard that applies only in a named mode (`env.CLOUD_MODE && !env.KEY`) or
 * only outside production does not count.
 */
function scanThrowGuardedEnvKeys(content: string): string[] {
  const keys: string[] = [];
  for (const guard of content.matchAll(/\bif\s*\(([^(){};]*)\)\s*\{?\s*throw\b/g)) {
    const condition = guard[1] ?? '';
    if (condition.includes('||')) continue;
    // A guard that opens a request handler fails one request, not the boot.
    if (REQUEST_HANDLER_HEADER_REGEX.test(content.slice(Math.max(0, guard.index - 160), guard.index))) continue;
    const parts = condition.split('&&').map((part) => part.trim());
    const negated = parts
      .map((part) => /^!\s*(?:process\.)?env\.([A-Z][A-Z0-9_]*)$/.exec(part)?.[1])
      .filter((key): key is string => key !== undefined);
    const modeExclusions = parts.filter((part) => {
      const literal = /^[\w$.]+\s*!==?\s*(['"`])([^'"`]*)\1$/.exec(part)?.[2];
      return literal !== undefined && !/^prod(?:uction)?$/i.test(literal);
    });
    if (negated.length === 1 && negated.length + modeExclusions.length === parts.length && !FEATURE_FLAG_NAME_REGEX.test(negated[0]!)) {
      keys.push(negated[0]!);
    }
  }
  return keys;
}

/** envalid validator objects fed to `cleanEnv` (`KEY: str()` vs `str({ default })`). */
function scanEnvalidReads(content: string): { key: string; needsValue: boolean }[] {
  if (!content.includes('cleanEnv(') && !content.includes('envalid')) return [];
  const found: { key: string; needsValue: boolean }[] = [];
  const memberRegex =
    /^\s*([A-Z][A-Z0-9_]*)\s*:\s*\b(?:str|num|bool|json|url|email|host|port|makeValidator)\s*\(/gm;
  let match: RegExpExecArray | null;
  while ((match = memberRegex.exec(content)) !== null) {
    const args = sliceToChainEnd(content, memberRegex.lastIndex);
    const optional = /(?:default|devDefault)\s*:|\.optional\s*\(/.test(args);
    found.push({ key: match[1]!, needsValue: !optional });
  }
  return found;
}

/** A file-local `env('KEY')` helper that throws when the variable is missing. */
function hasThrowingEnvHelper(content: string): boolean {
  const helperMatch = /(?:function\s+env\b[^{]*\{|=\s*\(\s*[^)]*\)\s*=>\s*\{)/.exec(content);
  if (!helperMatch) return false;
  const body = content.slice(helperMatch.index, Math.min(content.length, helperMatch.index + 600));
  return body.includes('process.env') && /throw\b/.test(body);
}

/** Calls of a throwing `env('KEY')` helper. */
function scanEnvHelperReads(content: string): { key: string; needsValue: boolean }[] {
  const found: { key: string; needsValue: boolean }[] = [];
  const callRegex = /\benv\(\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = callRegex.exec(content)) !== null) {
    found.push({ key: match[1]!, needsValue: true });
  }
  return found;
}

/** pydantic v2 BaseSettings class fields (required unless defaulted/optional). */
function scanPydanticSettingsReads(content: string): { key: string; needsValue: boolean }[] {
  if (!content.includes('BaseSettings') || !/(?:from\s+pydantic|pydantic_settings)\s*import|import\s+pydantic/.test(content)) {
    return [];
  }
  const found: { key: string; needsValue: boolean }[] = [];
  const classRegex = /^\s*class\s+\w+\s*\(\s*BaseSettings\s*\)\s*:/gm;
  let _classMatch: RegExpExecArray | null;
  while ((_classMatch = classRegex.exec(content)) !== null) {
    const blockStart = content.indexOf('\n', classRegex.lastIndex) + 1;
    const nextTopLevel = content.search(/\n\s*(?:class|def|@)\s/g);
    const blockEnd = nextTopLevel > blockStart ? nextTopLevel : content.length;
    const block = content.slice(blockStart, blockEnd);
    const fieldRegex = /^\s*([A-Za-z_]\w*)\s*:\s*([^=\n#]+?)(?:\s*=\s*([^\n#]+))?(?:\s*#.*)?$/gm;
    let fieldMatch: RegExpExecArray | null;
    while ((fieldMatch = fieldRegex.exec(block)) !== null) {
      const name = fieldMatch[1]!;
      if (name.startsWith('_')) continue;
      const annotation = fieldMatch[2] ?? '';
      const assignment = (fieldMatch[3] ?? '').trim();
      const optionalAnnotation = /\bOptional\b|\bNone\b|\|?\s*None\s*(?:$|,)|=\s*None/.test(annotation);
      let needsValue: boolean;
      if (assignment.length === 0) {
        needsValue = !optionalAnnotation;
      } else if (assignment.startsWith('Field(')) {
        // `Field(...)` / `Field(alias=...)` with no default ⇒ required; any
        // `default=`, `= None`, or `optional` ⇒ not.
        needsValue = !/default\s*=|optional\s*=|=\s*None\b/.test(assignment);
      } else {
        needsValue = false; // a literal default or `= None`
      }
      // The env var Pydantic reads: the field's own uppercase name, or an
      // explicit Field(alias=...) when present.
      const alias = /alias\s*=\s*['"]([A-Z_][A-Z0-9_]*)['"]/.exec(assignment)?.[1];
      const key = alias ?? name.toUpperCase();
      found.push({ key, needsValue });
    }
  }
  return found;
}

/** JVM `@Value("${KEY}")` (required unless `:default`) and `System.getenv("KEY")`. */
function scanJvmEnvReads(content: string): { key: string; needsValue: boolean }[] {
  const found: { key: string; needsValue: boolean }[] = [];
  const valueRegex = /@Value\s*\(\s*"\$\{\s*([^}]+)\}\s*"/g;
  let match: RegExpExecArray | null;
  while ((match = valueRegex.exec(content)) !== null) {
    const placeholder = match[1]!;
    const hasDefault = placeholder.includes(':');
    const key = envKeyLiteral(hasDefault ? placeholder.slice(0, placeholder.indexOf(':')) : placeholder);
    if (key !== null && !placeholder.includes('.')) {
      found.push({ key, needsValue: !hasDefault });
    }
  }
  const getenvRegex = /System\.getenv\(\s*"([A-Z][A-Z0-9_]*)"\s*\)/g;
  while ((match = getenvRegex.exec(content)) !== null) {
    found.push({ key: match[1]!, needsValue: false });
  }
  return found;
}

/**
 * Go viper with an env prefix (Stage B Wave 1, DEPLOY-005, memos):
 * `viper.SetEnvPrefix("memos")` + `viper.AutomaticEnv()` make every
 * `viper.Get*("dsn")`, `viper.SetDefault("dsn", …)` and `Flags().String("dsn", …)`
 * key readable as `MEMOS_DSN` — a name that never appears as a literal. The
 * env names are synthesised from the prefix and the keys the module names;
 * `-` becomes `_` (viper's usual `SetEnvKeyReplacer`). Nothing marks them
 * required: viper never refuses to start on a missing key.
 */
export function scanViperEnvKeys(content: string): string[] {
  if (!content.includes('viper.')) return [];
  const prefixMatch = /viper\.SetEnvPrefix\(\s*"([A-Za-z][A-Za-z0-9_-]*)"\s*\)/.exec(content);
  if (!prefixMatch || !/viper\.AutomaticEnv\s*\(/.test(content)) return [];
  const prefix = prefixMatch[1]!;
  const keys = new Set<string>();
  const keyRegex =
    /viper\.(?:Get\w*|SetDefault|BindEnv|IsSet)\(\s*"([a-zA-Z][\w.-]*)"|\.(?:Persistent)?Flags\(\)\.\w+\(\s*"([a-zA-Z][\w.-]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = keyRegex.exec(content)) !== null) {
    const name = viperEnvName(content, prefix, (match[1] ?? match[2])!);
    if (name !== null) keys.add(name);
  }
  for (const key of viperTypedKeys(content).values()) {
    const name = viperEnvName(content, prefix, key);
    if (name !== null) keys.add(name);
  }
  return [...keys].sort();
}

/** The env name viper reads for a key: `PREFIX_KEY`, with `-` and (given `SetEnvKeyReplacer`) `.` as `_`. */
function viperEnvName(content: string, prefix: string, key: string): string | null {
  if (key.includes('.') && !/SetEnvKeyReplacer\(\s*strings\.NewReplacer\([^)]*"\."/.test(content)) return null;
  return `${prefix.toUpperCase().replace(/-/g, '_')}_${key.toUpperCase().replace(/[-.]/g, '_')}`;
}

/**
 * Typed viper keys that a boot guard stops the process without
 * (`if CorsEnable.GetBool() && ServicePublicURL.GetString() == "" { log.Fatalf(…) }`):
 * every other condition is a flag whose default is true.
 */
function scanViperFatalEmptyKeys(content: string): string[] {
  const prefix = /viper\.SetEnvPrefix\(\s*"([A-Za-z][A-Za-z0-9_-]*)"\s*\)/.exec(content)?.[1];
  if (prefix === undefined || !/viper\.AutomaticEnv\s*\(/.test(content)) return [];
  const typedKeys = viperTypedKeys(content);
  const found: string[] = [];
  for (const [, condition] of content.matchAll(/\bif\s+([^{}\n]+?)\s*\{\s*log\.Fatal\w*\(/g)) {
    const parts = condition!.split('&&').map((part) => part.trim());
    const empty = parts.map((part) => /^(\w+)\.GetString\(\)\s*==\s*""$/.exec(part)?.[1]).filter((name) => name !== undefined);
    const flagsOn = parts.every(
      (part) => /^\w+\.GetString\(\)\s*==\s*""$/.test(part) || new RegExp(`\\b${/^(\w+)\.GetBool\(\)$/.exec(part)?.[1] ?? '\\0'}\\.setDefault\\(true\\)`).test(content),
    );
    const key = empty.length === 1 ? typedKeys.get(empty[0]!) : undefined;
    const name = key === undefined || !flagsOn ? null : viperEnvName(content, prefix, key);
    if (name !== null) found.push(name);
  }
  return found;
}

/** Typed config keys (``DatabaseType Key = `database.type` ``) by identifier. */
function viperTypedKeys(content: string): Map<string, string> {
  return new Map([...content.matchAll(/^[ \t]*(\w+)[ \t]+\w*Key[ \t]*=[ \t]*[`"]([a-z][\w.-]*)[`"]/gm)].map((m) => [m[1]!, m[2]!]));
}

/** Go `os.Getenv` / `os.LookupEnv`, required only with an adjacent missing-check or a required struct tag. */
function scanGoEnvReads(content: string): { key: string; needsValue: boolean }[] {
  const found: { key: string; needsValue: boolean }[] = [];
  const readRegex = /os\.(?:Getenv|LookupEnv)\(\s*"([A-Z][A-Z0-9_]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = readRegex.exec(content)) !== null) {
    const key = match[1]!;
    // `if os.Getenv("KEY") == "" { log.Fatal/panic… }` — the app refuses to
    // boot without the value. The window starts before the call so the
    // enclosing `if` is visible.
    const from = Math.max(0, match.index - 60);
    const vicinity = content.slice(from, Math.min(content.length, match.index + 240));
    const missingCheck = new RegExp(
      `if\\s+os\\.(?:Getenv|LookupEnv)\\(\\s*"${key}"[^)]*\\)\\s*==\\s*""\\s*\\{`,
    ).test(vicinity);
    const refuses = missingCheck && /log\.Fatal|panic\s*\(|log\.Panic/.test(vicinity);
    found.push({ key, needsValue: refuses });
  }
  // envconfig struct tags: `envconfig:"KEY,required"` (inline option) or a
  // tag carrying both the env name and a required/validate marker.
  const tagRegex = /envconfig:"([A-Z][A-Z0-9_]*)(?:,([^"]*))?"/g;
  while ((match = tagRegex.exec(content)) !== null) {
    const key = match[1]!;
    const options = match[2] ?? '';
    // A single backtick-delimited struct tag that also declares
    // required:"true" / validate:"required" for this key.
    const combined = new RegExp(
      'envconfig:"' + key + '"[^`]*(?:required:"true"|validate:"required")',
    ).test(content);
    found.push({ key, needsValue: options.includes('required') || combined });
  }
  // envdecode / caarlos0-env struct tags (DEPLOY-032, fider's app/pkg/env):
  // `env:"KEY"` (optional) or `env:"KEY,required"` — required unless a
  // default makes the value optional again: envdecode's inline `default=`
  // option or caarlos0-env's sibling `envDefault:"…"` tag on the same field.
  const envTagRegex = /env:"([A-Z][A-Z0-9_]*)(?:,([^"]*))?"/g;
  while ((match = envTagRegex.exec(content)) !== null) {
    const key = match[1]!;
    const options = match[2] ?? '';
    const lineEnd = content.indexOf('\n', match.index);
    const restOfField = content.slice(match.index, lineEnd === -1 ? content.length : lineEnd);
    const hasDefault = options.includes('default=') || /envDefault:"/.test(restOfField);
    found.push({ key, needsValue: options.includes('required') && !hasDefault });
  }
  return found;
}

/**
 * .NET reads, required only behind a `?? throw` (or a null-forgiving `!` on an
 * environment read): `GetRequiredSection`, `GetConnectionString("X")` (the
 * environment sets it as `ConnectionStrings__X`), `Environment.GetEnvironmentVariable("X")`,
 * and the root configuration's `configuration["Section:Key"]` / `GetValue<T>("Section:Key")`
 * (the environment sets them as `Section__Key`). A configuration key that is
 * not env-shaped (`"datadir"`) or a section's own key names no variable.
 */
function scanDotnetEnvReads(content: string): { key: string; needsValue: boolean }[] {
  const found: { key: string; needsValue: boolean }[] = [];
  const readRegex =
    /(GetRequiredSection|GetConnectionString)\(\s*"(\w+)"\s*\)|Environment\.GetEnvironmentVariable\(\s*"([A-Za-z_]\w*)"\s*\)(!(?!=))?|\b(?:_?[Cc]onfiguration|[Cc]onfig)(?:\[\s*"([\w:]+)"\s*\]|\.GetValue<[\w?]+>\(\s*"([\w:]+)"\s*[,)])/g;
  let match: RegExpExecArray | null;
  while ((match = readRegex.exec(content)) !== null) {
    const tail = content.slice(match.index + match[0].length, match.index + match[0].length + 120);
    const throwGuarded = /^\s*\?\?\s*(?:throw\b|new\b)/.test(tail);
    const [, method, sectionOrConnection, environmentKey, nullForgiving, indexedKey, valueKey] = match;
    if (method !== undefined) {
      if (method === 'GetConnectionString') found.push({ key: `ConnectionStrings__${sectionOrConnection!}`, needsValue: throwGuarded });
      else if (/^[A-Z][A-Z0-9_]*$/.test(sectionOrConnection!)) found.push({ key: sectionOrConnection!, needsValue: true });
    } else if (environmentKey !== undefined) {
      found.push({ key: environmentKey, needsValue: throwGuarded || nullForgiving !== undefined });
    } else {
      const configKey = (indexedKey ?? valueKey)!;
      if (!configKey.includes(':') && !/^[A-Z][A-Z0-9_]*$/.test(configKey)) continue;
      found.push({ key: configKey.replace(/:/g, '__'), needsValue: indexedKey !== undefined && throwGuarded });
    }
  }
  return found;
}

/**
 * The non-empty values of `appsettings.json` / `appsettings.Production.json`,
 * by the variable that overrides them (`ConnectionStrings__Default`): a .NET
 * read of such a key has a default.
 */
function appSettingsDefaults(tree: FileTree): Set<string> {
  const keys = new Set<string>();
  const visit = (value: unknown, prefix: string): void => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [name, child] of Object.entries(value)) visit(child, prefix ? `${prefix}__${name}` : name);
    } else if (prefix && value !== null && value !== '') {
      keys.add(prefix);
    }
  };
  for (const [path, content] of Object.entries(tree)) {
    if (!content || !APP_SETTINGS_FILE_REGEX.test(path) || !isRuntimeSourcePath(path)) continue;
    try {
      visit(JSON.parse(content.trimStart().replace(/^\s*\/\/.*$/gm, '')), '');
    } catch {
      // A file that is not plain JSON gives no defaults.
    }
  }
  return keys;
}

/**
 * Rust `env::var("X")` (also through `dotenvy::var` or a crate's own `env`
 * module): required when the read ends in `.expect(…)`, `.unwrap()` or `?`;
 * `unwrap_or`, `ok()`, `is_ok()` and `var_os` tolerate absence. `env!` is a
 * build-time read, and a `#[cfg(test)]` module is not production code.
 */
function scanRustEnvReads(content: string): { key: string; needsValue: boolean }[] {
  const production = content.split(/#\[cfg\(test\)\]/)[0] ?? '';
  return [...production.matchAll(/\b(?:env|dotenvy?)::var(_os)?\(\s*"([A-Z][A-Z0-9_]*)"\s*\)(\s*(?:\.(?:expect|unwrap)\(|\?))?/g)].map((m) => ({
    key: m[2]!,
    needsValue: m[1] === undefined && m[3] !== undefined,
  }));
}

/**
 * Elixir: `System.fetch_env!("X")` (or an app's own `fetch_env!` wrapper) and
 * `System.get_env("X") || raise …` stop the start without the variable, but
 * only in a `config/*.exs` file and outside a branch: a `case`, `if`, `cond`,
 * `unless` or `with` (other than `if config_env() == :prod`) runs the read
 * only for some settings, and a function in `lib/` only when it is called.
 * Any other read tolerates absence.
 */
function scanElixirEnvReads(path: string, content: string): { key: string; needsValue: boolean }[] {
  const found: { key: string; needsValue: boolean }[] = [];
  const config = /(?:^|\/)config\/[^/]+\.exs$/.test(path);
  const lines = content.split('\n');
  for (const m of content.matchAll(/(?:\bSystem\.(get_env|fetch_env)|\bfetch_env!)\(\s*"([A-Z][A-Z0-9_]*)"\s*(\))?(\s*\|\|\s*raise\b)?/g)) {
    const linePrefix = content.slice(content.lastIndexOf('\n', m.index) + 1, m.index);
    if (linePrefix.includes('#')) continue;
    const stops = m[1] === undefined || (m[1] === 'get_env' && m[3] !== undefined && m[4] !== undefined);
    const lineIndex = content.slice(0, m.index).split('\n').length - 1;
    found.push({ key: m[2]!, needsValue: stops && config && !/\b(?:if|unless)\b|->/.test(linePrefix) && !insideElixirBranch(lines, lineIndex) });
  }
  return found;
}

/** The path of the Phoenix `scope "/x"` blocks that enclose a line, by indentation (`/api` for `scope "/api"` › `scope []`). */
function phoenixScopePrefix(lines: readonly string[], index: number): string {
  let prefix = '';
  let indent = lines[index]!.search(/\S/);
  for (let i = index - 1; i >= 0 && indent > 0; i--) {
    const own = lines[i]!.search(/\S/);
    if (own < 0 || own >= indent) continue;
    indent = own;
    const scope = /^\s*scope\s+["'](\/[^"']*)["']/.exec(lines[i]!)?.[1];
    if (scope !== undefined) prefix = `${scope.replace(/\/+$/, '')}${prefix}`;
  }
  return prefix;
}

/** Whether a line sits, by indentation, inside a `case`/`if`/`cond`/`unless`/`with` branch other than `if config_env() == :prod`. */
function insideElixirBranch(lines: readonly string[], index: number): boolean {
  let indent = lines[index]!.search(/\S/);
  for (let i = index - 1; i >= 0 && indent > 0; i--) {
    const own = lines[i]!.search(/\S/);
    if (own < 0 || own >= indent) continue;
    indent = own;
    if (/^\s*(?:case|cond|unless|with)\b|^\s*if\b(?!\s+config_env\(\)\s*(?:==\s*:prod\b|in\s*\[))|->\s*$/.test(lines[i]!)) return true;
  }
  return false;
}

/** CGI and server names PHP's `$_SERVER` and `getenv` also return: the web server sets them, not the vendor. */
const PHP_SERVER_NAME_REGEX = /^(?:HTTPS?|HTTP_\w+|REQUEST_\w+|SERVER_\w+|REMOTE_\w+|SCRIPT_\w+|PHP_\w+|DOCUMENT_\w+|PATH_\w+|QUERY_STRING|CONTENT_\w+|GATEWAY_\w+|ORIG_\w+|REDIRECT_\w+|UNIQUE_ID)$/;

/**
 * A PHP backed enum of env names that reads `env($this->value)` (Shlink's
 * `case DB_DRIVER = 'DB_DRIVER'` with `EnvVars::DB_DRIVER->loadFromEnv()`):
 * each case name with the env name it reads.
 */
function phpEnvEnumCases(content: string): Map<string, string> {
  if (!/\benum\s+\w+\s*:\s*string\b/.test(content)) return new Map();
  if (!/(?:\bgetenv\(\s*|(?<![\w>:$\\])env\(\s*|\$_(?:ENV|SERVER)\[\s*)\$this->value\b/.test(content)) return new Map();
  return new Map([...content.matchAll(/^\s*case\s+(\w+)\s*=\s*['"]([A-Z][A-Z0-9_]*)['"]\s*;/gm)].map((m) => [m[1]!, m[2]!]));
}

/**
 * PHP `getenv('X')`, `$_ENV['X']`, `$_SERVER['X']` and Laravel `env('X')`: an
 * unset variable reads as false or null, so a read is required only behind a
 * `?: throw` / `?? throw`.
 */
function scanPhpEnvReads(content: string): { key: string; needsValue: boolean }[] {
  const found: { key: string; needsValue: boolean }[] = [...phpEnvEnumCases(content).values()].map((key) => ({ key, needsValue: false }));
  for (const m of content.matchAll(/(?:\bgetenv\(\s*|\$_(?:ENV|SERVER)\[\s*|(?<![\w>:$\\])env\(\s*)['"]([A-Z][A-Z0-9_]*)['"]\s*([,)\]])/g)) {
    if (PHP_SERVER_NAME_REGEX.test(m[1]!)) continue;
    if (/^\s*(?:\/\/|\*|#)/.test(content.slice(content.lastIndexOf('\n', m.index) + 1, m.index))) continue;
    const tail = content.slice(m.index + m[0].length, m.index + m[0].length + 80);
    found.push({ key: m[1]!, needsValue: m[2] !== ',' && /^\s*\)?\s*(?:\?:|\?\?)\s*throw\b/.test(tail) });
  }
  return found;
}

// ── Stage B phase 3 (COMP-017): env-var purpose classification ──────────────

/** Standard provisioned env names the manifest/cdk always inject. */
const INFRA_BINDING_NAMES = new Set<string>([
  'DATABASE_URL',
  'DATABASE_HOST',
  'DATABASE_PORT',
  'DATABASE_NAME',
  'DATABASE_USER',
  'DATABASE_PASSWORD',
  // The `DB_*` family the binding phase now injects (DEPLOY-005).
  'DB_URL',
  'DB_URI',
  'DB_CONNECTION_STRING',
  'DB_HOST',
  'DB_PORT',
  'DB_NAME',
  'DB_DATABASE',
  'DB_USER',
  'DB_USERNAME',
  'DB_PASSWORD',
  'DB_PASS',
  'DB_CONNECTION_URI',
  'DSN',
  'SQLALCHEMY_DATABASE_URI',
  'POSTGRES_URL',
  'POSTGRESQL_URL',
  'POSTGRES_URI',
  'POSTGRES_CONNECTION_STRING',
  'POSTGRES_DATABASE',
  'POSTGRES_USERNAME',
  'POSTGRES_SERVER',
  'MYSQL_URL',
  'MYSQL_HOST',
  'MYSQL_PORT',
  'MYSQL_DATABASE',
  'MYSQL_USER',
  'MYSQL_PASSWORD',
  'SPRING_DATASOURCE_URL',
  'SPRING_DATASOURCE_USERNAME',
  'SPRING_DATASOURCE_PASSWORD',
  'REDIS_URL',
  'REDIS_HOST',
  'REDIS_PORT',
  'CELERY_BROKER_URL',
  'CELERY_RESULT_BACKEND',
  'QUEUE_REDIS_URL',
  'CACHE_URL',
  'STORAGE_BUCKET',
  'S3_BUCKET',
  'AWS_S3_BUCKET',
  'AWS_REGION',
  'S3_REGION',
  'S3_ENDPOINT',
]);

/** Alias shapes the infrastructure-binding phase can inject (MEMOS_DSN, PAPERLESS_DBHOST…). */
const INFRA_BINDING_ALIAS_REGEX =
  /(?:_DSN|_DATABASE_URL|_DATABASE_URI|_DB_URL|_DB_URI|_POSTGRES_URL|_POSTGRESQL_URL|_DBHOST|_DBPORT|_DBNAME|_DBUSER|_DBPASS|_BUCKET(?:_NAME)?|_S3_REGION|_DB_CONNECTION_(?:URI|URL|STRING)|_POSTGRES_URI|_MYSQL_URL|_DB_{1,2}(?:HOST|PORT|NAME|DATABASE|USER|USERNAME|PASSWORD|PASS)|_POSTGRES(?:DB)?_(?:HOST|PORT|DB|DATABASE|USER|USERNAME|PASSWORD)|_DATASOURCE_(?:URL|JDBC_URL|USERNAME|PASSWORD)|_JDBC_URL|_REDIS_(?:URL|URI|DSN|HOST|PORT))$/i;

/** Every §11.3 external-service catalog key (a vendor credential name). */
function externalServiceCatalogKeys(): Set<string> {
  const keys = new Set<string>();
  for (const def of EXTERNAL_SERVICE_CATALOG) {
    for (const key of def.keys) keys.add(key);
  }
  return keys;
}

export type EnvVarPurpose =
  | 'internal_secret'
  | 'external_credential'
  | 'infrastructure_binding'
  | 'optional_configuration'
  | 'unknown';

/**
 * Stage B phase 4 — whether a variable is a Deployz-GENERATABLE application
 * INTERNAL secret (never an external vendor credential, never a provisioned
 * binding). The eligible class: secret-shaped names like AUTH_SECRET /
 * SESSION_SECRET / JWT_SECRET / SECRET_KEY / ENCRYPTION_KEY /
 * NEXTAUTH_SECRET / COOKIE_SECRET / APP_SECRET — they all fall out of the
 * purpose rule below; no name list is the source of truth.
 */
const GENERIC_VENDOR_CREDENTIAL_SHAPE =
  /_(?:API_KEY|API_SECRET|CLIENT_SECRET|CLIENT_ID|ACCESS_KEY|ACCESS_TOKEN|SECRET_KEY|PRIVATE_KEY|PUBLIC_KEY)$/i;

/**
 * A mail relay's credential (MAIL_PASSWORD, SMTP_PASS, MAILER_USER…) belongs
 * to a provider the vendor chose — a credential Deployz can never generate.
 * Without this, a `*_PASSWORD` name read as an internal secret and the
 * relay minted a random SMTP password (DEPLOY-013, kutt).
 */
const MAIL_CREDENTIAL_SHAPE =
  /^(?:MAIL|SMTP|EMAIL|MAILER)_(?:[A-Z0-9]+_)*(?:PASSWORD|PASS|USER(?:NAME)?|API_KEY|TOKEN|SECRET)$/i;

/**
 * A credential of a resource Deployz provisions (DB_PASSWORD, REDIS_PASSWORD,
 * POSTGRES_USER…) is a binding, never an application-internal secret: the
 * binding phase supplies it, and minting a random one would sever the
 * connection it belongs to (DEPLOY-013, kutt's DB_PASSWORD).
 */
const PROVISIONED_CREDENTIAL_SHAPE =
  /^(?:DB|DATABASE|POSTGRES|POSTGRESQL|PG|REDIS|CACHE|VALKEY)_?(?:PASSWORD|PASS|USER(?:NAME)?|SECRET|AUTH)$/i;

/**
 * A name that carries a provider token as one of its `_`-separated segments
 * belongs to that provider's own credential, never an application-internal
 * secret Deployz can mint (DEPLOY-030): outline's AWS_ACCESS_KEY_ID,
 * DROPBOX_APP_KEY, GITHUB_WEBHOOK_SECRET, SLACK_VERIFICATION_TOKEN and
 * OIDC_TOKEN_URI, and fider's EMAIL_AWSSES_ACCESS_KEY_ID and
 * BLOB_STORAGE_S3_ACCESS_KEY_ID, all contain KEY/SECRET/TOKEN and matched no
 * external-credential shape below, so the relay minted garbage values that
 * switched integrations on nobody configured.
 */
const PROVIDER_PREFIX_SHAPE =
  /(?:^|_)(?:AWS|AWSSES|AMAZON|GCP|GCS|GOOGLE|AZURE|GITHUB|GITLAB|BITBUCKET|SLACK|DISCORD|DROPBOX|BOX|OIDC|OAUTH|SAML|OKTA|AUTH0|SENTRY|STRIPE|PAYPAL|TWILIO|SENDGRID|MAILGUN|POSTMARK|SES|S3|MINIO|CLOUDFLARE|DATADOG|NEWRELIC|OPENAI|ANTHROPIC|LINKEDIN|FACEBOOK|TWITTER|APPLE|MICROSOFT|ZOOM|NOTION|LINEAR|JIRA|ATLASSIAN)_/;

/**
 * TLS material (a certificate/key pair the vendor supplies together, or not
 * at all) is configuration, never a mintable secret: outline's SSL_KEY
 * validates `@CannotUseWithout("SSL_CERT")` and exits at boot when only a
 * minted SSL_KEY is set (DEPLOY-030).
 */
const TLS_MATERIAL_SHAPE =
  /^(?:SSL|TLS|HTTPS)_(?:[A-Z0-9]+_)*(?:KEY|CERT|CERTIFICATE|CA|CA_CERT|PRIVATE_KEY|PUBLIC_KEY)(?:_FILE|_PATH)?$/i;

/** External-credential double-guard: catalog keys, a provider prefix, or a generic vendor-credential name shape. */
export function isExternalCredentialShape(key: string): boolean {
  return (
    externalServiceCatalogKeys().has(key) ||
    PROVIDER_PREFIX_SHAPE.test(key) ||
    GENERIC_VENDOR_CREDENTIAL_SHAPE.test(key) ||
    MAIL_CREDENTIAL_SHAPE.test(key)
  );
}

/** Deterministic purpose for one env var key. */
export function classifyEnvVarPurpose(key: string): { purpose: EnvVarPurpose; confidence: 'high' | 'medium' | 'low' } {
  // Exact/curated infrastructure-binding names and shapes are checked before
  // the (deliberately broad) provider-prefix external-credential shape below
  // — otherwise a Deployz-injected AWS_S3_BUCKET/S3_ATTACHMENTS_BUCKET would
  // misclassify as an external credential instead of a binding.
  if (INFRA_BINDING_NAMES.has(key)) {
    return { purpose: 'infrastructure_binding', confidence: 'high' };
  }
  if (INFRA_BINDING_ALIAS_REGEX.test(key) || PROVISIONED_CREDENTIAL_SHAPE.test(key)) {
    return { purpose: 'infrastructure_binding', confidence: 'medium' };
  }
  // TLS material (SSL_KEY/HTTPS_PRIVATE_KEY/…) is checked before the generic
  // vendor-credential shape below, which also matches a bare `_PRIVATE_KEY`/
  // `_PUBLIC_KEY` suffix — the more specific SSL/TLS/HTTPS-prefixed shape
  // must win so a certificate/key pair is configuration, not a credential.
  if (TLS_MATERIAL_SHAPE.test(key)) {
    return { purpose: 'optional_configuration', confidence: 'high' };
  }
  if (isExternalCredentialShape(key)) {
    return { purpose: 'external_credential', confidence: 'high' };
  }
  if (isSecretName(key)) {
    return { purpose: 'internal_secret', confidence: 'medium' };
  }
  return { purpose: 'optional_configuration', confidence: 'medium' };
}

/**
 * Dockerfile `ARG NAME` (no default) names that a compose file supplies under
 * `build.args`. The value maps to an evidence line such as
 * `docker-compose.yml build arg SELF_HOSTED=true` (the value is left out for
 * secret-looking names).
 */
function detectComposeBuildArgs(tree: FileTree): Map<string, string> {
  const found = new Map<string, string>();
  const dockerfile = selectedDockerfile(tree);
  if (!dockerfile) return found;
  const bareArgs = new Set([...dockerfile.content.matchAll(/^\s*ARG\s+([A-Z][A-Z0-9_]*)\s*$/gm)].map((m) => m[1]!));
  if (bareArgs.size === 0) return found;
  for (const [path, content] of Object.entries(tree)) {
    if (!content || !isProductionComposeFile(path)) continue;
    for (const block of content.matchAll(/^[ \t]*args:[ \t]*\n((?:[ \t]+[^\n]*\n?)+)/gm)) {
      for (const entry of (block[1] ?? '').matchAll(/^[ \t]*-?[ \t]*([A-Z][A-Z0-9_]*)[ \t]*[=:][ \t]*["']?([^\s"'#]+)/gm)) {
        const key = entry[1]!;
        if (!bareArgs.has(key) || found.has(key) || entry[2]!.startsWith('$')) continue;
        const value = isSecretName(key) ? '' : `=${entry[2]!.slice(0, 40)}`;
        found.set(key, `${path} build arg ${key}${value}`);
      }
    }
  }
  return found;
}

/**
 * A global `ARG NAME` with no default (before the first `FROM`) that a `FROM` of the
 * production stage lineage reads (`FROM ${NAME}`) is a build input the image needs:
 * without a value the base image is empty and the build fails (coder: `BASE_IMAGE`).
 * An argument a production Compose file sets through `build.args` is not asked for.
 */
function detectBaseImageBuildArgs(tree: FileTree): Map<string, string> {
  const found = new Map<string, string>();
  const dockerfile = selectedDockerfile(tree);
  if (!dockerfile) return found;
  const content = normalizeDockerfile(dockerfile.content);
  const stages = parseDockerfileStages(content);
  if (stages.length === 0) return found;
  const firstFrom = content.search(/^\s*FROM\s/im);
  const globalArgs = firstFrom > 0 ? content.slice(0, firstFrom) : '';
  const lineage = stageLineage(stages, productionStageIndex(stages)).map((index) => stages[index]!);
  // `FROM base-${VARIANT}` selects one of the stages named `base-…` (livebook): their base images count too.
  const stagePatterns = lineage
    .map((stage) => stage.image.toLowerCase().split(/\$\{?\w+\}?/))
    .filter((parts) => parts.length > 1 && parts.some((part) => part.length > 0))
    .map((parts) => new RegExp(`^${parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+')}$`));
  const selectable = stages.filter((stage) => stage.name !== null && stagePatterns.some((pattern) => pattern.test(stage.name!)));
  const baseImages = [...lineage, ...selectable].map((stage) => stage.image);
  for (const [, name] of globalArgs.matchAll(/^\s*ARG\s+([A-Z][A-Z0-9_]*)\s*$/gm)) {
    const referenced = baseImages.some((image) => new RegExp(`\\$(?:${name}\\b|\\{${name}\\})`).test(image));
    if (referenced) found.set(name!, `${dockerfile.path} build arg ${name} selects the base image; the build fails without it`);
  }
  // A stage the build runs that declares an ARG with no default and stops
  // without it (memos `: "${VERSION:?Pass VERSION …}"`).
  const defaulted = new Set([...globalArgs.matchAll(/^\s*ARG\s+(.+)$/gim)].flatMap(([, list]) => list!.split(/\s+/).filter((arg) => arg.includes('=')).map((arg) => arg.split('=')[0]!)));
  for (const index of builtStageIndexes(stages, productionStageIndex(stages))) {
    const body = stages[index]!.body;
    for (const [, list] of body.matchAll(/^\s*ARG\s+(.+)$/gim)) {
      for (const name of list!.split(/\s+/)) {
        if (!/^[A-Z][A-Z0-9_]*$/.test(name) || defaulted.has(name) || found.has(name)) continue;
        if (new RegExp(`^\\s*RUN\\b.*\\$\\{${name}:?\\?`, 'im').test(body)) {
          found.set(name, `${dockerfile.path} build arg ${name} has no default and a RUN step stops without it; the build fails without it`);
        }
      }
    }
  }
  return found;
}

/** The stages `docker build` runs for a target: its `FROM` lineage and every stage it copies or mounts from. */
function builtStageIndexes(stages: DockerfileStage[], target: number): Set<number> {
  const built = new Set<number>();
  const visit = (index: number): void => {
    for (const i of stageLineage(stages, index)) {
      if (built.has(i)) continue;
      built.add(i);
      for (const [, ref] of stages[i]!.body.matchAll(/--(?:from|mount=[^\s]*\bfrom)=([^\s,]+)/g)) {
        const source = resolveDockerfileStage(ref!, stages, i);
        if (source !== undefined) visit(stages.indexOf(source));
      }
    }
  };
  visit(target);
  return built;
}

/**
 * The §11.2 env-var model — every environment variable the app reads or
 * declares, with honest required/secret/source attributes.
 *
 * `required` is deliberately narrow (high precision over recall). A variable
 * is REQUIRED only when ALL of these hold:
 *   - the app READS it somewhere and the read NEEDS a value — no inline
 *     `??`/`||` fallback, and not a pure presence guard (`=== 'x'` checks,
 *     `if (process.env.X)`), and not a defaulted read (Python
 *     `os.getenv('X', d)`, Ruby `ENV.fetch('X', d)`);
 *   - nothing in the repository supplies a usable default value (a real
 *     value in a runtime env file such as `.env`, or a read with an inline
 *     fallback). A `.env.example`/`.env.sample`/`.env.template` value is
 *     never a default — it does not reach the container.
 *
 * A sample entry the app never reads (NEXTAUTH_SECRET in a repo with no auth
 * code) is NOT required. §11.3 well-known service keys that the repository
 * evidences (read or declared) are upgraded to required+secret — an SDK
 * dependency without its credential cannot function.
 *
 * A read chained straight into further use (`process.env.X.split(',')`,
 * never stored raw) is also NOT required when the same file early-returns on
 * that key's absence (`if (!process.env.X) return …`) — only an early
 * **throw** for that key still means required (Documenso's
 * NEXT_PRIVATE_DATABASE_REPLICA_URLS, COMP false-positive fix).
 */
/** The managed resources Deployz provisions for the app; a selector only matters for what is provisioned. */
export interface ProvisionedResources {
  database: 'postgres' | 'mysql' | null;
  storage: boolean;
}

// A selector names the engine/backend the app uses: DB, DB_TYPE, DATABASE_CLIENT,
// DB_CONNECTION, MB_DB_TYPE, PAPERLESS_DBENGINE, MEMOS_DRIVER. A `*_DRIVER` only
// counts when its default is a database engine, so MAIL_DRIVER=smtp never does.
// The database NAME of a known engine (POSTGRES_DB) is not a selector.
const DB_SELECTOR_NAME_REGEX =
  /^(?!(?:POSTGRES|POSTGRESQL|MYSQL|MARIADB|PG)_)(?:(?:[A-Z0-9]+_)*(?:DB|DATABASE)(?:_(?:CLIENT|TYPE|DRIVER|ENGINE|DIALECT|BACKEND|CONNECTION|ADAPTER|VENDOR|PROVIDER))?|[A-Z0-9_]*_DBENGINE|[A-Z0-9]+_DRIVER)$/;
// `FILES_TYPE` is plural on purpose: `FILE_TYPE` and `ALLOWED_FILE_TYPES` name MIME types.
// A debug or profiler tool keeps its own records (`DEBUGBAR_STORAGE_DRIVER`), not the app's files.
const STORAGE_SELECTOR_NAME_REGEX =
  /^(?!(?:DEBUGBAR|TELESCOPE|CLOCKWORK|PROFILER|DEBUG)_).*?(?:^|_)(?:FILE_)?STORAGE(?:_(?:TYPE|DRIVER|PROVIDER|BACKEND|SERVICE|MODE|LOCATIONS?))?$|(?:^|_)UPLOAD_PROVIDER$|_STORAGE_PROVIDER$|^ACTIVE_STORAGE_SERVICE$|(?:^|_)(?:FILES|UPLOADS?|ATTACHMENTS?)_(?:TYPE|DRIVER|PROVIDER|BACKEND)$|(?:^|_)DATASOURCE_TYPE$/;
/** The TLS mode of the app's database connection: `VIKUNJA_DATABASE_SSLMODE`, `DB_SSL_MODE`, `PGSSLMODE`. */
const DB_SSL_MODE_NAME_REGEX = /^(?:PGSSLMODE|(?:[A-Z0-9]+_)*(?:DB|DATABASE|POSTGRES|POSTGRESQL|PG)_SSL_?MODE)$/;
// A database selector name that picks the engine; `REDIS_DB` and `DB_CONNECTION` do not.
const DB_ENGINE_SELECTOR_NAME_REGEX = /(?:^|_)(?:DB|DATABASE)_(?:CLIENT|TYPE|DRIVER|ENGINE|DIALECT|BACKEND|ADAPTER|VENDOR|PROVIDER)$|DBENGINE$/;

const EMBEDDED_ENGINE_REGEX = /^(?:sqlite3?|better-sqlite3|libsql|h2|bolt|django\.db\.backends\.sqlite3)(?:$|[:/])/i;
const ENGINE_VALUE_REGEX = {
  postgres: /^(?:pg|pgsql|postgres(?:ql|db)?|node-postgres|postgis|django\.db\.backends\.postgresql\w*)(?:$|[:/+])/i,
  mysql: /^(?:mysql2?|mariadb|django\.db\.backends\.mysql|mysql\+\w+)(?:$|[:/])/i,
};
const ENGINE_LABEL = { postgres: 'PostgreSQL', mysql: 'MySQL' };
const LOCAL_STORAGE_VALUE_REGEX = /^(?:local|disk|fs|file|filesystem|local[_-]?disk)$/i;
const S3_STORAGE_VALUE_REGEX = /^(?:s3|aws|amazon|amazons3|aws[-_]?s3|s_3)$/i;
/** `process.env.A && process.env.B ? new S3(` — the S3 client exists only when every variable of the chain is set. */
const S3_PRESENCE_CHAIN_REGEX = /((?:process\.env\.[A-Z][A-Z0-9_]*\s*&&\s*)+process\.env\.[A-Z][A-Z0-9_]*)\s*\?\s*new\s+S3(?:Client)?\(/g;
export const S3_PRESENCE_EVIDENCE = 'S3 is used only when all of these are set; otherwise files go to the container disk';
/** A Go string literal that is itself a database selector name: `EnvDatabaseDialect = "GOTIFY_DATABASE_DIALECT"`. */
const GO_SELECTOR_LITERAL_REGEX = /"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)"/g;

/** Files whose env reads and defaults can name a selector. */
const SELECTOR_SOURCE_REGEX = /\.(?:[cm]?[jt]sx?|py|rb|go|php|java|kt|kts|scala)$/i;
/** Rails `config/*.yml`, Laravel `config/*.php`, a `config.yml` and Spring `application*` — small files that read env vars. */
const CONFIG_ENV_FILE_REGEX =
  /(?:^|\/)config\/[\w.-]+\.(?:ya?ml|php)$|(?:^|\/)config\.ya?ml$|(?:^|\/)application(?:-[\w.-]+)?\.(?:properties|ya?ml)$/i;

/** A typed config class field bound to an env var: `@Env('DB_TYPE', schema) type: DbType = 'sqlite';`. */
const DECORATED_ENV_REGEX = /@Env\(\s*["']([A-Z][A-Z0-9_]*)["']/g;
const DECORATED_ENV_DEFAULT_REGEX =
  /@Env\(\s*["']([A-Z][A-Z0-9_]*)["'][^;]*?\)\s*(?:(?:public|private|protected|readonly)\s+)*\w+[?!]?\s*(?::\s*[^=;\n]+?)?\s*=\s*(["'`])([^"'`\n]*)\2\s*;/g;

/** Env reads through an imported helper: `assertEnv('DB_URL')` throws when unset, `getEnv('X')` does not. */
const ENV_HELPER_CALL_REGEX = /(?<![\w.$])(assertEnv|requireEnv|mustGetEnv|getEnv\w*)\(\s*["']([A-Z][A-Z0-9_]*)["']\s*(,)?/g;
/** Env names listed for a boot check: `requiredEnvVars.push('DB_HOST', …)`, `validateEnv(['STORAGE_LOCATIONS'])`. */
const ENV_NAME_LIST_REGEX = /\brequired\w*env\w*(?:\s*:[^=;\n]+)?\s*(?:=\s*\[|\.push\()([^\])]*)|\bvalidate\w*env\w*\(\s*\[([^\]]*)/gi;

/** Env reads with an inline default, in every language the tree carries: `[name, default]`. */
function scanDefaultedEnvReads(content: string): [string, string][] {
  const found: [string, string][] = [];
  // JS `env.X || 'd'`, `process.env['X'] ?? 'd'`
  for (const m of content.matchAll(/\benv(?:\.([A-Z][A-Z0-9_]*)|\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\])\s*(?:\|\||\?\?)\s*["'`]([^"'`\n]*)["'`]/g)) {
    found.push([(m[1] ?? m[2])!, m[3]!]);
  }
  // Ruby `ENV['X'] || 'd'`
  for (const m of content.matchAll(/\bENV\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]\s*\|\|\s*["']([^"'\n]*)["']/g)) {
    found.push([m[1]!, m[2]!]);
  }
  // `os.getenv("X", "d")`, `os.environ.get`, `ENV.fetch`, PHP/Strapi `env('X', 'd')`, `env.get('X', 'd')`,
  // django-environ `env.str('X', 'd')`, Go `getEnv("X", "d")`
  for (const m of content.matchAll(/\b\w*env\w*(?:\.(?:get|fetch|getenv|str|url|db_url))?\s*\(\s*["'`]([A-Za-z0-9_]+)["'`]\s*,\s*(?:default\s*=\s*)?["'`]([^"'`\n]*)["'`]/gi)) {
    if (m[1] === m[1]!.toUpperCase()) found.push([m[1]!, m[2]!]);
  }
  // NestJS `configService.get<string>('X', 'd')`
  for (const m of content.matchAll(/\.get(?:OrThrow)?(?:<[^>\n]*>)?\(\s*["'`]([A-Z][A-Z0-9_]*)["'`]\s*,\s*["'`]([^"'`\n]*)["'`]\s*\)/g)) {
    found.push([m[1]!, m[2]!]);
  }
  // Typed config class `@Env('X', schema?) prop: T = 'd'`
  for (const m of content.matchAll(DECORATED_ENV_DEFAULT_REGEX)) found.push([m[1]!, m[3]!]);
  // Spring / shell `${X:default}`
  for (const m of content.matchAll(/\$\{([A-Z][A-Z0-9_]*):-?([^}\n]*)\}/g)) found.push([m[1]!, m[2]!]);
  // Schema defaults: envalid `X: str({ default: 'd' })`, zod `X: z.enum([…]).default('d')`
  for (const m of content.matchAll(/\b([A-Z][A-Z0-9_]*)\s*:\s*\w+\(\s*\{[^}]*?\bdefault\s*:\s*["'`]([^"'`\n]*)["'`]/g)) {
    found.push([m[1]!, m[2]!]);
  }
  for (const m of content.matchAll(/\b([A-Z][A-Z0-9_]*)\s*:\s*z\.[^\n]*?\.default\(\s*["'`]([^"'`\n]*)["'`]/g)) found.push([m[1]!, m[2]!]);
  // PHP env enum defaults: `self::DB_DRIVER => 'sqlite'`
  const enumCases = phpEnvEnumCases(content);
  for (const m of content.matchAll(/\bself::(\w+)\s*=>\s*['"]([^'"\n]*)['"]/g)) {
    const name = enumCases.get(m[1]!);
    if (name !== undefined) found.push([name, m[2]!]);
  }
  return found;
}

/**
 * Fields of a class-validator env schema (`class ConfigVariables { @IsOptional() STORAGE_TYPE: StorageDriverType = StorageDriverType.LOCAL; }`):
 * `[name, default]`. An enum member default is read as its member name (`LOCAL`).
 */
function scanValidatedConfigFields(content: string): [string, string | null][] {
  if (!/\bfrom\s+["']class-validator["']/.test(content)) return [];
  return [
    ...content.matchAll(/^[ \t]+([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)[?!]?(?:[ \t]*:[ \t]*[^=;\n]+?)?(?:[ \t]*=[ \t]*([^;\n]*))?[ \t]*;/gm),
  ].map((m): [string, string | null] => {
    const initializer = m[2]?.trim() ?? '';
    return [m[1]!, /^["'`]([^"'`\n]*)["'`]$/.exec(initializer)?.[1] ?? /^\w+\.([A-Z][A-Z0-9_]*)$/.exec(initializer)?.[1] ?? null];
  });
}

/**
 * Python `ConfigParser` whose `before_get` lets `os.getenv(option)` override every ini key
 * (CTFd): each `config_ini["section"]["KEY"]` read is an env variable, with its `or "default"`.
 */
function scanIniEnvOverrideReads(content: string): [string, string | null][] {
  if (!/def before_get\b[\s\S]{0,400}?(?:os\.getenv|os\.environ\.get)\(\s*option\b/.test(content)) return [];
  return [...content.matchAll(/\[["'][\w.-]+["']\]\[["']([A-Z][A-Z0-9_]*)["']\]\)?(?:[ \t]*\\?\s*or\s+["']([^"'\n]*)["'])?/g)].map(
    (m): [string, string | null] => [m[1]!, m[2] ?? null],
  );
}

/** Env reads compared with a literal (`os.getenv("DB") == "postgres"`): `[name, literal]`. */
function scanComparedEnvReads(content: string): [string, string][] {
  const found: [string, string][] = [];
  for (const m of content.matchAll(
    /(?:process\.env\.([A-Z][A-Z0-9_]*)|\b(?:os\.getenv|os\.environ\.get|getenv|env)\(\s*["']([A-Z][A-Z0-9_]*)["']\s*\)|ENV\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\])\s*(?:===?|!==?)\s*["']([^"'\n]+)["']/g,
  )) {
    found.push([(m[1] ?? m[2] ?? m[3])!, m[4]!]);
  }
  return found;
}

/** django-environ reads (`env.str('X')`): only an engine selector without a default needs a value; settings guard the rest. */
function scanDjangoEnvironReads(content: string): { key: string; needsValue: boolean }[] {
  if (!/\bimport environ\b|\benviron\.Env\(/.test(content)) return [];
  const constructorDefaults = new Set([...content.matchAll(/\b([A-Z][A-Z0-9_]*)\s*=\s*\(/g)].map((m) => m[1]!));
  return [...content.matchAll(/\benv(?:\.\w+)?\(\s*["']([A-Z][A-Z0-9_]*)["']\s*(,)?/g)].map((m) => ({
    key: m[1]!,
    needsValue: m[2] === undefined && !constructorDefaults.has(m[1]!) && isRequiredEngineSelector(m[1]!),
  }));
}

/**
 * Go viper `SetDefault("driver", "sqlite")`, a flag default or a typed-key
 * `DatabaseType.setDefault("sqlite")` under `SetEnvPrefix("memos")` → `MEMOS_DRIVER`.
 */
function scanViperEnvDefaults(content: string): [string, string][] {
  const prefix = /viper\.SetEnvPrefix\(\s*"([A-Za-z][A-Za-z0-9_-]*)"\s*\)/.exec(content)?.[1];
  if (prefix === undefined || !/viper\.AutomaticEnv\s*\(/.test(content)) return [];
  const found: [string, string][] = [];
  const typedKeys = viperTypedKeys(content);
  for (const m of content.matchAll(
    /viper\.SetDefault\(\s*"([a-zA-Z][\w.-]*)"\s*,\s*"([^"\n]*)"|\.(?:Persistent)?Flags\(\)\.String\w*\(\s*"([a-zA-Z][\w.-]*)"\s*,\s*"([^"\n]*)"|\b(\w+)\.setDefault\(\s*"([^"\n]*)"/g,
  )) {
    const key = m[1] ?? m[3] ?? typedKeys.get(m[5] ?? '');
    const name = key === undefined ? null : viperEnvName(content, prefix, key);
    if (name !== null) found.push([name, (m[2] ?? m[4] ?? m[6])!]);
  }
  return found;
}

/** `KEY=value` / `KEY: value` lines of a sample or compose file. */
function envLineValues(content: string): [string, string][] {
  return [...content.matchAll(/^[ \t]*-?[ \t]*([A-Z][A-Z0-9_]*)[ \t]*[=:][ \t]*["']?([^\s"'#]*)/gm)].map(
    (m): [string, string] => [m[1]!, m[2]!],
  );
}

/** Files that hold an env defaults map: `env.ts`, `env/constants/defaults.ts`. */
const ENV_DEFAULTS_FILE_REGEX = /(?:^|\/)(?:env|environment)(?:\/|\.[cm]?[jt]s$)|(?:^|\/)defaults?\.[cm]?[jt]s$/i;

/** `NAME: 'value',` entries of an env defaults map (`const defaults = { DB_CLIENT: 'sqlite3' }`). */
function scanDefaultsMapEnvValues(content: string): [string, string][] {
  return [...content.matchAll(/^[ \t]*([A-Z][A-Z0-9_]*)[ \t]*:[ \t]*(["'`])([^"'`\n]*)\2[ \t]*,?[ \t]*(?:\/\/.*)?$/gm)].map(
    (m): [string, string] => [m[1]!, m[3]!],
  );
}

/** `ENV NAME=value` / `ENV NAME value` pairs of a Dockerfile — the image's own default for each variable. */
function dockerfileEnvValues(content: string): [string, string][] {
  const found: [string, string][] = [];
  for (const m of content.replace(/\\r?\n/g, ' ').matchAll(/^[ \t]*ENV[ \t]+(.+)$/gim)) {
    const body = m[1]!;
    const pairs = [...body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|(\S*))/g)];
    if (pairs.length === 0) {
      const legacy = /^([A-Za-z_][A-Za-z0-9_]*)[ \t]+["']?([^"'\s]*)/.exec(body);
      if (legacy) found.push([legacy[1]!, legacy[2]!]);
    }
    for (const pair of pairs) found.push([pair[1]!, pair[2] ?? pair[3] ?? pair[4]!]);
  }
  return found;
}

/** Env sample files at any depth of the selected app — not sibling apps, docs, tests or examples. */
function appEnvSampleFiles(tree: FileTree, isSiblingApp: (path: string) => boolean): string[] {
  return Object.keys(tree).filter(
    (path) => tree[path] && ENV_SAMPLE_FILE_REGEX.test(path) && isRuntimeSourcePath(path) && !isSiblingApp(path),
  );
}

/**
 * COMP-022, generalised — selectors whose default is an embedded or different
 * engine (or local disk storage) while a managed one is provisioned. Such a
 * selector must be REQUIRED: without a value the app boots on SQLite or the
 * container disk and silently drops data instead of using the provisioned
 * resource. Never flagged when the default already names the provisioned
 * engine, or when the resource is not provisioned.
 *
 * Each selector carries an evidence string that names the value to use when
 * the code or a sample file shows it.
 */
function unresolvedSelectors(
  tree: FileTree,
  isSiblingApp: (path: string) => boolean,
  provisioned: ProvisionedResources,
  reads: ReadonlyMap<string, { files: string[] }>,
): Map<string, { evidence: string; files: string[] }> {
  type Value = { value: string; file: string };
  const codeDefaults = new Map<string, Value[]>();
  const sampleValues = new Map<string, Value[]>();
  const compared = new Map<string, Value[]>();
  const imageDefaults = new Map<string, Value[]>();
  const literalReads = new Map<string, string>();
  const presenceChain: { name: string; file: string }[] = [];
  const add = (map: Map<string, Value[]>, name: string, value: string, file: string): void => {
    if (!DB_SELECTOR_NAME_REGEX.test(name) && !STORAGE_SELECTOR_NAME_REGEX.test(name) && !DB_SSL_MODE_NAME_REGEX.test(name)) return;
    map.set(name, [...(map.get(name) ?? []), { value, file }]);
  };
  for (const [path, content] of Object.entries(tree)) {
    if (!content || !isRuntimeSourcePath(path) || isSiblingApp(path)) continue;
    if (!SELECTOR_SOURCE_REGEX.test(path) && !CONFIG_ENV_FILE_REGEX.test(path)) continue;
    for (const [name, value] of scanDefaultedEnvReads(content)) add(codeDefaults, name, value, path);
    for (const [name, value] of [...scanValidatedConfigFields(content), ...scanIniEnvOverrideReads(content)]) {
      if (value !== null) add(codeDefaults, name, value, path);
    }
    for (const [name, value] of scanComparedEnvReads(content)) add(compared, name, value, path);
    if (GO_SOURCE.test(path)) {
      for (const [name, value] of scanViperEnvDefaults(content)) add(codeDefaults, name, value, path);
      for (const [, name] of content.matchAll(GO_SELECTOR_LITERAL_REGEX)) {
        if (DB_ENGINE_SELECTOR_NAME_REGEX.test(name!)) literalReads.set(name!, path);
      }
    }
    if (JS_SOURCE.test(path)) {
      // A config table that pairs a config path with its env name: `env('datasource.type', 'DATASOURCE_TYPE', 'string')`.
      for (const [, name] of content.matchAll(/\benv\(\s*["'][\w.-]+["']\s*,\s*["']([A-Z][A-Z0-9_]*)["']/g)) {
        if (STORAGE_SELECTOR_NAME_REGEX.test(name!)) literalReads.set(name!, path);
      }
    }
    if (provisioned.storage && JS_SOURCE.test(path)) {
      for (const [, chain] of content.matchAll(S3_PRESENCE_CHAIN_REGEX)) {
        for (const [, name] of chain!.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
          if (s3Semantic(name!) === null) presenceChain.push({ name: name!, file: path });
        }
      }
    }
    if (JS_SOURCE.test(path) && ENV_DEFAULTS_FILE_REGEX.test(path)) {
      for (const [name, value] of scanDefaultsMapEnvValues(content)) add(codeDefaults, name, value, path);
    }
  }
  const dockerfile = selectedDockerfile(tree);
  if (dockerfile) for (const [name, value] of dockerfileEnvValues(dockerfile.content)) add(imageDefaults, name, value, dockerfile.path);
  const runtimeSamples = new Set(appEnvSampleFiles(tree, isSiblingApp));
  const runtimeSampleNames = new Set<string>();
  for (const path of [...runtimeSamples, ...listProductionComposeFiles(tree)]) {
    for (const [name, value] of envLineValues(tree[path] ?? '')) {
      add(sampleValues, name, value, path);
      if (runtimeSamples.has(path)) runtimeSampleNames.add(name);
    }
  }

  const result = new Map<string, { evidence: string; files: string[] }>();
  const engine = provisioned.database;
  const sampleNamesEngineSelector = [...sampleValues.keys()].some((name) => DB_SELECTOR_NAME_REGEX.test(name));
  const names = new Set([
    ...codeDefaults.keys(),
    ...sampleValues.keys(),
    ...compared.keys(),
    ...imageDefaults.keys(),
    ...literalReads.keys(),
  ]);
  for (const name of names) {
    // The managed PostgreSQL database accepts only TLS connections (RDS `rds.force_ssl`).
    if (DB_SSL_MODE_NAME_REGEX.test(name)) {
      const disabled = [...(imageDefaults.get(name) ?? codeDefaults.get(name) ?? [])].find(({ value }) => /^disable$/i.test(value));
      if (engine === 'postgres' && disabled !== undefined) {
        result.set(name, { evidence: `TLS setting: default "disable" cannot reach the managed PostgreSQL database, which accepts only TLS — set "require"`, files: [disabled.file] });
      }
      continue;
    }
    const isStorage = provisioned.storage && STORAGE_SELECTOR_NAME_REGEX.test(name);
    const isDb = !isStorage && engine !== null && DB_SELECTOR_NAME_REGEX.test(name);
    if (!isDb && !isStorage) continue;
    // The image's `ENV` value wins over any default in the code, and over a comparison.
    const image = imageDefaults.get(name);
    // An image `ENV` for a variable the app never reads says nothing — except next to an env sample
    // that documents an engine selector: the app reads its selectors where the fetched tree does not reach.
    if (image && !(isDb && sampleNamesEngineSelector) && !reads.has(name) && !codeDefaults.has(name)) continue;
    const fromCode = image ?? codeDefaults.get(name) ?? [];
    const comparedHere = image ? [] : (compared.get(name) ?? []);
    // A sample value is only a default for a variable the app actually reads — or for a variable the
    // fetched tree never reads and gives no default (teable reads it in a file the bounded fetch missed).
    const unread = !reads.has(name) && !literalReads.has(name) && fromCode.length === 0 && runtimeSampleNames.has(name);
    const fromSamples = fromCode.length > 0 || reads.has(name) || literalReads.has(name) || unread ? (sampleValues.get(name) ?? []) : [];
    const wanted = isStorage ? S3_STORAGE_VALUE_REGEX : ENGINE_VALUE_REGEX[engine!];
    // A selector with no default that the code only compares with the
    // provisioned value (`os.getenv("DB") == "postgres"`) takes the other
    // branch when unset.
    const unsetFallback =
      fromCode.length === 0 && comparedHere.some(({ value }) => wanted.test(value)) ? { value: 'unset' } : undefined;
    // A selector the app reads through a config table or a Go constant, with no default in the code, the
    // image or a sample, is an undecided choice: those reads hide their defaults from the scanners.
    const noDefaultFound =
      literalReads.has(name) &&
      fromCode.length === 0 &&
      comparedHere.length === 0 &&
      (sampleValues.get(name) ?? []).length === 0
        ? { value: 'not found' }
        : undefined;
    const bad =
      [...fromCode, ...fromSamples].find(({ value }) =>
        isStorage
          ? LOCAL_STORAGE_VALUE_REGEX.test(value)
          : EMBEDDED_ENGINE_REGEX.test(value) ||
            (['postgres', 'mysql'] as const).some((other) => other !== engine && ENGINE_VALUE_REGEX[other].test(value)),
      ) ?? unsetFallback ?? noDefaultFound;
    if (!bad) continue;

    const values: string[] = [];
    const note = (value: string): void => {
      if (/^[\w.-]+$/.test(value) && wanted.test(value) && !values.includes(value)) values.push(value);
    };
    for (const { value } of sampleValues.get(name) ?? []) note(value);
    const files = [
      ...new Set([...fromCode, ...comparedHere].map((entry) => entry.file).concat(reads.get(name)?.files ?? [], literalReads.get(name) ?? [])),
    ];
    for (const file of files) {
      for (const literal of (tree[file] ?? '').matchAll(/["'`]([^"'`\s]{1,60})["'`]/g)) note(literal[1]!);
    }
    const hint = values.length > 0 ? values.slice(0, 3).map((value) => `"${value}"`).join(' or ') : null;
    const notFound = bad === noDefaultFound;
    const evidence = isStorage
      ? `storage selector: ${notFound ? 'the default was not found' : `default "${bad.value}" stores files on the container disk`} — set ${hint === null ? 'a value that stores files outside the container' : `${hint} to use the managed S3 bucket`}`
      : `engine selector: ${notFound ? 'the default was not found' : bad === unsetFallback ? 'when unset the app uses another engine' : `default "${bad.value}" ${EMBEDDED_ENGINE_REGEX.test(bad.value) ? 'stores data on the container disk' : `is not the managed ${ENGINE_LABEL[engine!]} engine`}`} — set ${hint ?? `a ${ENGINE_LABEL[engine!]} value`} to use the managed ${ENGINE_LABEL[engine!]} database`;
    result.set(name, { evidence, files });
  }
  for (const { name, file } of presenceChain) {
    if (!result.has(name)) result.set(name, { evidence: S3_PRESENCE_EVIDENCE, files: [file] });
  }
  return result;
}

/** A database engine selector (`DB_TYPE`, `DJANGO_DB_ENGINE`) read with no default must be set. */
function isRequiredEngineSelector(key: string): boolean {
  return DB_SELECTOR_NAME_REGEX.test(key) && /(?:^|_)(?:DB|DATABASE|DBENGINE)(?:_|$)/.test(key);
}

/** Env reads in framework config files; a read without a default is required only for a secret. */
const LARAVEL_DRIVER_CONFIG_REGEX = /(?:^|\/)config\/(?:broadcasting|cache|database|filesystems|logging|mail|passport|queue|session)\.php$/i;

function scanConfigFileEnvReads(path: string, content: string): { key: string; needsValue: boolean }[] {
  const found: { key: string; needsValue: boolean }[] = [];
  const add = (key: string, hasDefault: boolean): void => {
    found.push({ key, needsValue: !hasDefault && (isSecretName(key) || OWN_URL_NAME_REGEX.test(key)) });
  };
  if (/\.php$/i.test(path)) {
    // A Laravel driver file holds one block per driver (`'ably' => ['key' => env('ABLY_KEY')]`), and
    // the app reads a block only when it selects that driver: its secrets are not boot inputs.
    const driverFile = LARAVEL_DRIVER_CONFIG_REGEX.test(path);
    for (const m of content.matchAll(/\benv\(\s*["']([A-Z][A-Z0-9_]*)["']\s*(,)?/g)) {
      const key = m[1]!;
      add(key, m[2] !== undefined || (driverFile && !OWN_URL_NAME_REGEX.test(key)));
    }
  } else if (/application[^/]*\.(?:properties|ya?ml)$/i.test(path)) {
    for (const m of content.matchAll(/\$\{([A-Z][A-Z0-9_]*)(:[^}]*)?\}/g)) add(m[1]!, m[2] !== undefined);
    // Spring relaxed binding: a `spring.datasource` property is also read from SPRING_DATASOURCE_*.
    // Not when the file pins an embedded driver: a PostgreSQL URL there fails the H2 driver (HAPI FHIR).
    const configuresDatasource = /\.properties$/i.test(path)
      ? /^\s*spring\.datasource\./m.test(content)
      : /^spring:[ \t]*\r?\n(?:[ \t]+\S[^\r\n]*\r?\n|[ \t]*\r?\n)*?[ \t]+datasource:/m.test(content);
    const embeddedDriver = /^\s*(?:spring\.datasource\.)?driver(?:-class-name|ClassName)\s*[:=]\s*["']?org\.(?:h2|hsqldb|apache\.derby)\./m.test(content);
    if (configuresDatasource && !embeddedDriver) {
      for (const key of ['SPRING_DATASOURCE_URL', 'SPRING_DATASOURCE_USERNAME', 'SPRING_DATASOURCE_PASSWORD']) add(key, true);
    }
  } else {
    // A Rails `config/storage.yml` service block is built only when the app selects that
    // service, and `ENV['X']` is nil when unset: the app boots without it.
    const storageServices = /(?:^|\/)config\/storage\.ya?ml$/i.test(path);
    for (const m of content.matchAll(/\bENV\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]\s*(\|\|)?/g)) add(m[1]!, storageServices || m[2] !== undefined);
    for (const m of content.matchAll(/\bENV\.fetch\(\s*["']([A-Z][A-Z0-9_]*)["']\s*(,|\)\s*\{)?/g)) add(m[1]!, m[2] !== undefined);
    // Symfony `%env(X)%`, `%env(int:X)%`: a `default:` processor or an `env(X):` parameter is the default.
    for (const m of content.matchAll(/%env\(((?:[\w-]+:)*)([A-Z][A-Z0-9_]*)\)%/g)) {
      add(m[2]!, m[1]!.split(':').includes('default') || new RegExp(`^\\s*['"]?env\\(${m[2]!}\\)['"]?\\s*:`, 'm').test(content));
    }
    // `$(NAME)` / `${NAME:default}` substitution in a YAML config; the engine selector has no other source
    for (const m of content.matchAll(/\$[({]([A-Z][A-Z0-9_]*)(:[^)}\n]*)?[)}]/g)) {
      const key = m[1]!;
      found.push({ key, needsValue: m[2] === undefined && (isSecretName(key) || isRequiredEngineSelector(key)) });
    }
  }
  return found;
}

export function detectEnvVarModel(
  tree: FileTree,
  externalServices: string[] = [],
  provisioned?: ProvisionedResources,
): ManifestEnvVariable[] {
  // ── 1. Declarations: every KEY=VALUE line in any env file we ship with. ──
  const declarations = new Map<string, { realValue: boolean; sampleEmpty: boolean; samplePath: boolean; files: string[] }>();
  for (const [path, content] of Object.entries(tree)) {
    if (!content || !/^\.env(\.\w+)?$/i.test(path)) continue;
    const isSample = ENV_SAMPLE_FILE_REGEX.test(path);
    // `\s` includes the newline, so a `\s*` after `=` would swallow the rest
    // of the file — use space/tab-only gaps so each KEY=VALUE line parses on
    // its own line.
    const regex = /^[ \t]*([A-Z_][A-Z0-9_]*)[ \t]*=[ \t]*(.*)$/gm;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const key = match[1];
      if (!key) continue;
      const value = (match[2] ?? '').replace(/\s+#.*$/, '').trim();
      const current = declarations.get(key) ?? { realValue: false, sampleEmpty: false, samplePath: false, files: [] };
      // A sample value (`S3_ENDPOINT=http://minio:9000` in .env.example) is
      // documentation, never a runtime default.
      if (!isSample && !isPlaceholderValue(value)) current.realValue = true;
      if (isSample && isPlaceholderValue(value)) current.sampleEmpty = true;
      if (isSample && value.startsWith('/')) current.samplePath = true;
      if (!current.files.includes(path)) current.files.push(path);
      declarations.set(key, current);
    }
  }

  // Sample files deeper in the app (`apps/api/.env.example`) document binding
  // names too. They never feed `declarations`, so they cannot change which
  // variables are required; only infrastructure-binding names are listed.
  const isSiblingApp = siblingAppFilter(tree);
  const nestedSampleFiles = new Map<string, string[]>();
  for (const path of appEnvSampleFiles(tree, isSiblingApp)) {
    if (!path.includes('/')) continue;
    for (const [key] of envLineValues(tree[path] ?? '')) {
      if (classifyEnvVarPurpose(key).purpose !== 'infrastructure_binding') continue;
      nestedSampleFiles.set(key, [...(nestedSampleFiles.get(key) ?? []), path]);
    }
  }
  // The selected Dockerfile's `ENV` names a binding the image reads too.
  const imageDockerfile = selectedDockerfile(tree);
  for (const [key] of imageDockerfile ? dockerfileEnvValues(imageDockerfile.content) : []) {
    if (classifyEnvVarPurpose(key).purpose !== 'infrastructure_binding') continue;
    nestedSampleFiles.set(key, [...(nestedSampleFiles.get(key) ?? []), imageDockerfile!.path]);
  }

  // ── 2. Reads: which variables the app actually reads, and whether a read
  //      NEEDS a value vs. tolerates absence (fallback or presence guard). ──
  const reads = new Map<string, { needsValue: boolean; strong: boolean; files: string[] }>();
  // Keys a zod schema declares `.optional()` or `.default()`: the schema says
  // the app tolerates their absence, whatever a bare read elsewhere suggests.
  const schemaOptionalKeys = new Set<string>();
  // Keys a boot guard throws without (`scanThrowGuardedEnvKeys`): required
  // whatever the schema says.
  const bootRequiredKeys = new Set<string>();
  // A `weak` read is a heuristic: a bare argument, a stored value or a
  // config-file lookup. It proves the app reads the key, not that the app
  // refuses to start without it.
  const recordRead = (key: string, needsValue: boolean, file: string, weak = false): void => {
    const current = reads.get(key) ?? { needsValue: false, strong: false, files: [] };
    if (needsValue) current.needsValue = true;
    if (needsValue && !weak) current.strong = true;
    if (!current.files.includes(file)) current.files.push(file);
    reads.set(key, current);
  };

  // A variable the runtime source ASSIGNS (`process.env.UV_THREADPOOL_SIZE = …`,
  // `process.env.EE_ENV_LOADED = 'true'`) is set by the app itself, so a read
  // of it is never the vendor's to configure.
  const assignedKeys = new Set<string>();
  for (const [path, content] of Object.entries(tree)) {
    if (!content || !JS_SOURCE.test(path) || !isRuntimeSourcePath(path) || isSiblingApp(path)) continue;
    for (const assigned of content.matchAll(JS_ENV_ASSIGNMENT_REGEX)) {
      const assignedKey = assigned[1] ?? assigned[2];
      if (assignedKey) assignedKeys.add(assignedKey);
    }
  }

  // `next start` loads `next.config.*` at boot, so its throw guards stop the
  // start (cal.com `if (!process.env.NEXTAUTH_URL) throw`). A standalone
  // `server.js` carries the built config instead and never runs the file.
  const nextConfigRunsAtStart = imageDockerfile !== null && !/\.next\/standalone|\bserver\.js\b/.test(productionStageText(imageDockerfile.content));
  for (const [path, content] of Object.entries(tree)) {
    if (!content || !nextConfigRunsAtStart || !NEXT_CONFIG_FILE_REGEX.test(path) || isSiblingApp(path)) continue;
    for (const key of scanThrowGuardedEnvKeys(content)) {
      recordRead(key, true, path);
      bootRequiredKeys.add(key);
    }
  }

  for (const [path, content] of Object.entries(tree)) {
    if (!content || !isRuntimeSourcePath(path) || isSiblingApp(path) || DEV_CONFIG_FILE_REGEX.test(path)) continue;
    if (JS_SOURCE.test(path)) {
      // `process.env.X` / `process.env['X']` everywhere; `env.X` / `env['X']`
      // too when the module reads through a local env object (DEPLOY-005).
      const createsEnvSchema = /\bcreateEnv\s*\(/.test(content);
      const readRegex = new RegExp(
        String.raw`process\.env\s*\.\s*([A-Z_][A-Z0-9_]*)|process\.env\[["']([A-Z_][A-Z0-9_]*)["']\]` +
          (readsThroughEnvObject(content) ? `|${CONFIG_ENV_READ_SOURCE}` : ''),
        'g',
      );
      let match: RegExpExecArray | null;
      while ((match = readRegex.exec(content)) !== null) {
        const key = match[1] ?? match[2] ?? match[3] ?? match[4];
        if (!key) continue;
        // A glob in prose (`process.env.NEXT_PUBLIC_*`) names no variable.
        if (content[match.index + match[0].length] === '*') continue;
        // A read in a comment (`* parseTimeout(process.env.X)`) is documentation.
        if (/^\s*(?:\*|\/\/)/.test(content.slice(content.lastIndexOf('\n', match.index) + 1, match.index))) continue;
        // `delete process.env.X` removes the variable; it reads nothing.
        if (/\bdelete\s+$/.test(content.slice(Math.max(0, match.index - 10), match.index))) continue;
        // The same file tests the key for presence (`Boolean(process.env.X)`, `!!process.env.X`,
        // `if (process.env.X)`, `process.env.X && …`, `typeof process.env.X`), so it tolerates its absence.
        const presenceTested = new RegExp(
          `(?:Boolean\\s*\\(\\s*|!!\\s*|\\bif\\s*\\(\\s*)process\\.env\\.${key}\\b(?!\\s*[=!])|process\\.env\\.${key}\\s*(?:&&|\\?(?!\\?)|!==?\\s*(?:null|undefined)\\b)|\\btypeof\\s+process\\.env\\.${key}\\b`,
        ).test(content);
        if (assignedKeys.has(key) || presenceTested) {
          recordRead(key, false, path);
          continue;
        }
        // A read through the module's env object proves the app reads the
        // key — the model, the binding aliases and secret minting need that —
        // but never that it REQUIRES a value: the env module that built the
        // object owns the defaults (outline's `env.CDN_URL` in a call has a
        // default inside `server/env.ts`), so the process.env call-argument
        // and bare-secret rules below do not transfer (DEPLOY-005, outline).
        if (match[3] !== undefined || match[4] !== undefined) {
          recordRead(key, false, path);
          continue;
        }
        // Statement-bound tail: a `??`/`||` on a LATER statement must not look
        // like a fallback for this read.
        const rawTail = content.slice(match.index + match[0].length, match.index + match[0].length + 160);
        // t3-env `runtimeEnv: { KEY: process.env.KEY, … }` only forwards the
        // value to `createEnv`; its zod schema decides what is required.
        if (
          createsEnvSchema &&
          new RegExp(`(?:^|[\\s,{])${key}\\s*:\\s*$`).test(content.slice(Math.max(0, match.index - 60), match.index)) &&
          /^\s*[,}]/.test(rawTail)
        ) {
          recordRead(key, false, path);
          continue;
        }
        const statementEnd = rawTail.search(/[\n;]/);
        const tail = statementEnd === -1 ? rawTail : rawTail.slice(0, statementEnd);
        const head = content.slice(Math.max(0, match.index - 60), match.index);
        // A read only TOLERATES an absent variable (never REQUIRES it) when it
        // is a presence GUARD: an equality/ternary test, a negation, a boolean
        // chain, or the direct condition of if/while/catch. A read inside an
        // ordinary function call (`new Stripe(process.env.KEY)`) is NOT a
        // guard — it is a required value.
        const lastOpen = head.lastIndexOf('(');
        const inConditional =
          lastOpen >= 0 &&
          !head.includes(')', lastOpen) &&
          /(?:if|while|catch)\s*$/.test(head.slice(0, lastOpen).replace(/\s+$/, ''));
        // A read that is itself the alternative of a `??`/`||` chain
        // (`process.env.A ?? process.env.B`) is a fallback, not a
        // requirement; and a read handed to a parsing helper alongside a
        // default argument (`parseEnvVarNumber(process.env.PORT, 4242)`)
        // carries that default (Stage A COMP-017).
        const isAlternative = /(?:\?\?|\|\|)\s*$/.test(head);
        const callee = /([A-Za-z_$][\w$]*)\s*\(\s*(?:[^()]*,\s*)?$/.exec(head)?.[1] ?? '';
        // The default must be a literal (a string, number, boolean, null or a
        // CONSTANT) — `axios.get(process.env.URL, { headers })` carries none.
        // The call may span lines (`parseEnvVarNumber(\n process.env.X,\n 10,`),
        // and a `parse*` helper takes any expression as its default
        // (`isEnterprise ? 100 : 5`, `options?.limit ?? 5000`).
        const helperTail = rawTail.split(';')[0] ?? '';
        const helperWithDefault =
          (/^parse\w*$/.test(callee) && /^\s*,\s*[^\s,)]/.test(helperTail)) ||
          (DEFAULTING_HELPER_REGEX.test(callee) &&
            /^\s*(?:\|\|[^,;\n]*)?,\s*(?:['"`][^'"`]*['"`]|-?\d[\d._]*(?:\s*[*+/-]\s*\d[\d._]*)*|true|false|null|undefined|[A-Z][A-Z0-9_]*)\s*[,)]/.test(helperTail));
        const hasFallback =
          /(?:\?\?|\|\|)\s*\S/.test(tail) || /(?:\?\?=|\|\|=)/.test(tail) || isAlternative || helperWithDefault;
        const isGuard =
          /^\s*(?:===|!==|==|!=)/.test(tail) ||
          /^\s*\?/.test(tail) ||
          /!\s*[A-Za-z_$][\w$.:]*$/.test(head) ||
          /(?:&&|\|\|)\s*[A-Za-z_$][\w$.:]*$/.test(head) ||
          // A boolean chain or coercion tests presence: `Boolean(process.env.A
          // && process.env.B)`, `!!process.env.A`, `enabled = process.env.A && …`.
          /^\s*&&/.test(tail) ||
          /&&\s*$/.test(head) ||
          /(?:Boolean\s*\(|!!)\s*$/.test(head) ||
          // A predicate helper (`isEnabled(process.env.X)`, `toBool(process.env.X)`) reads a flag: unset is false.
          /\b(?:is[A-Z]\w*|(?:to|parse|as)Bool(?:ean)?)\s*\(\s*$/.test(head) ||
          inConditional;
        // A non-secret read stored as-is (`const url = process.env.X;`,
        // `host: process.env.X,`) proves nothing about need — the consumer
        // decides later. It is required only when the code then refuses to
        // run without it: `if (!url) throw …`. A secret-named variable stays
        // required on a bare read: a missing credential is a boot failure,
        // an unset option is a default (Stage A COMP-023).
        const assignedName = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(head)?.[1];
        const isBareAssignment = /[=:]\s*$/.test(head) && /^\s*(?:[;,)}\]]|$)/.test(tail) && !isSecretName(key);
        // A read chained straight into further use before storage
        // (`process.env.X.split(',')`) is bare in the same sense — the
        // consumer decides what the transformed value means, not this read.
        const isBareChainAccess = !isSecretName(key) && /^\.[A-Za-z_$]/.test(tail);
        // A secret-named read stored in a local (`const key = process.env.X;`)
        // that the code then tests (`if (!key) return`) without
        // throwing tolerates its absence.
        const isSecretLocalAssignment =
          Boolean(assignedName) && isSecretName(key) && /^\s*(?:[;,)}\]]|$)/.test(tail);
        let throwGuarded = false;
        let returnGuarded = false;
        if (isBareAssignment || isBareChainAccess || isSecretLocalAssignment) {
          const guardTargets = [
            `process\\.env\\.${key}\\b`,
            `process\\.env\\[["']${key}["']\\]`,
            `(?<![\\w.$])env\\.${key}\\b`,
            `(?<![\\w.$])env\\[["']${key}["']\\]`,
            assignedName ? `${assignedName}\\b` : null,
          ]
            .filter(Boolean)
            .join('|');
          const exitGuard = new RegExp(
            `if\\s*\\(\\s*!\\s*(?:${guardTargets})[^)]*\\)\\s*\\{?\\s*(throw|return)\\b`,
          ).exec(content);
          throwGuarded = exitGuard?.[1] === 'throw';
          returnGuarded = exitGuard?.[1] === 'return';
        }
        // A bare assignment needs a throw to become required (existing
        // behaviour); a bare chain access is required by default and only
        // an early RETURN (not throw) on the same key clears it.
        const localTested =
          isSecretLocalAssignment &&
          new RegExp(
            `if\\s*\\(\\s*!*\\s*${assignedName}\\b`,
          ).test(content);
        const bareNeedsValue = isBareAssignment
          ? throwGuarded
          : isBareChainAccess
            ? !returnGuarded
            : isSecretLocalAssignment
              ? throwGuarded || !localTested
              : true;
        // A non-secret value handed alone to a named converter (`formatBaseUri(process.env.X)`,
        // `authTypeFromString(process.env.X)`)
        // is turned into the app's own default or validated there, like a bare
        // stored read: the converter decides what absence means.
        const isBareTransform =
          !isSecretName(key) &&
          ENV_TRANSFORM_CALLEE_REGEX.test(/([A-Za-z_$][\w$]*)\s*\(\s*$/.exec(head)?.[1] ?? '') &&
          /^\s*\)/.test(tail);
        // A typed config class only exposes the value; its consumer decides whether it is needed.
        // Client code reads the value at build time; a bare read there is not a runtime need.
        const clientRead = CLIENT_DIRECTORY_REGEX.test(path) && !throwGuarded;
        recordRead(
          key,
          !hasFallback && !isGuard && !isBareTransform && bareNeedsValue && !TYPED_CONFIG_FILE_REGEX.test(path) && !clientRead,
          path,
          !throwGuarded,
        );
      }
      // Stage B phase 3 (COMP-017): schema-library and helper-form reads —
      // zod object schemas parsed against process.env, envalid validator
      // objects, and a file-local throwing `env('KEY')` helper.
      for (const entry of [
        ...scanZodEnvReads(content),
        ...scanZodHelperEnvReads(content),
        ...scanEnvalidReads(content),
        ...(hasThrowingEnvHelper(content) ? scanEnvHelperReads(content) : []),
      ]) {
        recordRead(entry.key, entry.needsValue, path);
      }
      for (const entry of scanZodEnvReads(content)) {
        if (!entry.needsValue) schemaOptionalKeys.add(entry.key);
      }
      for (const m of content.matchAll(DECORATED_ENV_REGEX)) recordRead(m[1]!, false, path);
      for (const [name] of scanValidatedConfigFields(content)) recordRead(name, false, path);
      for (const m of content.matchAll(ENV_HELPER_CALL_REGEX)) {
        recordRead(m[2]!, /^(?:assert|require|mustGet)/.test(m[1]!) && m[3] === undefined, path);
      }
      for (const m of content.matchAll(ENV_NAME_LIST_REGEX)) {
        for (const name of (m[1] ?? m[2] ?? '').matchAll(/["']([A-Z][A-Z0-9_]*)["']/g)) recordRead(name[1]!, false, path);
      }
      for (const key of scanThrowGuardedEnvKeys(content)) bootRequiredKeys.add(key);
    } else if (/schema\.prisma$/i.test(path)) {
      const envRegex = /env\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*\)/g;
      let match: RegExpExecArray | null;
      while ((match = envRegex.exec(content)) !== null) {
        if (match[1]) recordRead(match[1], true, path);
      }
    } else if (PY_SOURCE.test(path)) {
      const indexRegex = /os\.environ\[["']([A-Z_][A-Z0-9_]*)["']\](?!\s*=(?!=))/g;
      let match: RegExpExecArray | null;
      while ((match = indexRegex.exec(content)) !== null) {
        if (match[1]) recordRead(match[1], true, path);
      }
      const defaultedRegex = /os\.(?:environ\.get|getenv)\(\s*["']([A-Z_][A-Z0-9_]*)["']/g;
      while ((match = defaultedRegex.exec(content)) !== null) {
        // `os.getenv('X')` returns None when absent (app decides); only the
        // index form `os.environ['X']` REQUIRES the variable.
        if (match[1]) recordRead(match[1], false, path);
      }
      // Stage B phase 3 (COMP-017): pydantic v2 BaseSettings class fields.
      for (const entry of [...scanPydanticSettingsReads(content), ...scanDjangoEnvironReads(content)]) {
        recordRead(entry.key, entry.needsValue, path);
      }
      for (const [name] of scanIniEnvOverrideReads(content)) recordRead(name, false, path);
    } else if (RB_SOURCE.test(path)) {
      const fetchRegex = /ENV\.fetch\(\s*["']([A-Z_][A-Z0-9_]*)["']/g;
      let match: RegExpExecArray | null;
      while ((match = fetchRegex.exec(content)) !== null) {
        const hasDefault = /,|\)\s*(?:\{|do\b)/.test(content.slice(match.index, match.index + 80));
        // The same file tests the key for presence (`ENV['X'].to_s.empty?`, `if ENV['X']`).
        const presenceTested = new RegExp(
          `ENV\\[["']${match[1]}["']\\](?:\\.to_s)?\\.(?:empty|blank|present|nil)\\?|(?:if|unless)\\s+ENV\\[["']${match[1]}["']\\]|ENV\\.key\\?\\(\\s*["']${match[1]}["']`,
        ).test(content);
        if (match[1]) recordRead(match[1], !hasDefault && !presenceTested, path);
      }
    } else if (JAVA_SOURCE_REGEX.test(path)) {
      for (const entry of scanJvmEnvReads(content)) {
        recordRead(entry.key, entry.needsValue, path);
      }
    } else if (GO_SOURCE.test(path)) {
      for (const key of scanViperEnvKeys(content)) recordRead(key, false, path);
      for (const key of scanViperFatalEmptyKeys(content)) {
        recordRead(key, true, path);
        bootRequiredKeys.add(key);
      }
      for (const entry of scanGoEnvReads(content)) {
        recordRead(entry.key, entry.needsValue, path);
      }
    } else if (DOTNET_SOURCE_REGEX.test(path)) {
      for (const entry of scanDotnetEnvReads(content)) {
        recordRead(entry.key, entry.needsValue, path);
      }
    } else if (CONFIG_ENV_FILE_REGEX.test(path)) {
      for (const entry of scanConfigFileEnvReads(path, content)) {
        recordRead(entry.key, entry.needsValue, path, true);
      }
      // `src/Config/EnvVars.php` is PHP source in a config directory.
      for (const key of phpEnvEnumCases(content).values()) recordRead(key, false, path);
    } else if (PHP_SOURCE_REGEX.test(path)) {
      for (const entry of scanPhpEnvReads(content)) recordRead(entry.key, entry.needsValue, path);
    } else if (RUST_SOURCE_REGEX.test(path) && !RUST_NON_RUNTIME_FILE_REGEX.test(path)) {
      for (const entry of scanRustEnvReads(content)) recordRead(entry.key, entry.needsValue, path);
    } else if (ELIXIR_SOURCE_REGEX.test(path)) {
      for (const entry of scanElixirEnvReads(path, content)) recordRead(entry.key, entry.needsValue, path);
    }
  }
  const dotnetDefaults = appSettingsDefaults(tree);

  // Selectors with a bad default are reads too (a Ruby `ENV['DB'] || 'sqlite'`
  // or a PHP `env('DB_CONNECTION', 'sqlite')` is not caught above).
  const selectors = unresolvedSelectors(
    tree,
    isSiblingApp,
    provisioned ?? { database: detectPostgresql(tree).detected ? 'postgres' : null, storage: detectS3(tree).detected },
    reads,
  );
  for (const [name, selector] of selectors) for (const file of selector.files) recordRead(name, false, file);

  // A Dockerfile `ARG NAME` with no default that the repository's compose file
  // feeds through `build.args` is a build input the image needs
  // (rallly: `SELF_HOSTED=true` switches Next.js to `output: standalone`, and the
  // Dockerfile copies that output). Deployz passes only vendor build values, so
  // the variable must be listed as required, with the compose value as evidence.
  // An `ARG` that selects the base image is the same kind of input.
  const composeBuildArgs = new Map([...detectBaseImageBuildArgs(tree), ...detectComposeBuildArgs(tree)]);

  // ── 3. Combine into the model. ──
  const keys = new Set<string>([
    ...declarations.keys(),
    ...reads.keys(),
    ...composeBuildArgs.keys(),
    ...nestedSampleFiles.keys(),
    ...selectors.keys(),
  ]);
  const entries: ManifestEnvVariable[] = [];

  for (const key of [...keys].sort()) {
    const declared = declarations.get(key);
    const read = reads.get(key);
    const buildArg = composeBuildArgs.get(key);
    // §11.3: a credential of a service the repository evidences stays required.
    const serviceKey = findExternalServiceForEnvKey(tree, externalServices, key);
    const optionalIntegration = !serviceKey?.evidenced && OPTIONAL_INTEGRATION_NAME_REGEX.test(key);
    const needsValue =
      (read !== undefined && readNeedsValue(key, read, optionalIntegration) && !schemaOptionalKeys.has(key)) ||
      (read !== undefined && bootRequiredKeys.has(key)) ||
      buildArg !== undefined;
    const hasDefault = declared?.realValue === true || dotnetDefaults.has(key);
    const source: string[] = [];
    if (buildArg) source.push(buildArg);

    const selector = selectors.get(key);
    if (selector) source.push(selector.evidence);
    if (declared) {
      for (const file of declared.files) source.push(`${file} declares ${key}`);
      if (declared.samplePath) source.push(SAMPLE_PATH_EVIDENCE);
    }
    for (const file of nestedSampleFiles.get(key) ?? []) source.push(`${file} declares ${key}`);
    if (read) {
      for (const file of read.files) source.push(`read in ${file}`);
    }

    // A defaulted/guarded read that never NEEDS the value is never required,
    // even when a sample line is empty — and a platform-provided variable is
    // never the vendor's to configure. COMP-022: a selector defaulting to an
    // embedded engine or local disk next to the provisioned resource is the
    // one exception — it must be set for that resource to be used.
    const required = (needsValue || selector !== undefined) && !hasDefault && !isPlatformEnvVar(key);

    let secret = isSecretName(key);
    // §11.3 upgrade: an evidenced well-known service credential is a secret
    // and is required — the SDK cannot operate without it.
    if (serviceKey?.evidenced) {
      secret = true;
      source.push(`${serviceKey.service} requires ${key}`);
    }
    // Stage B phase 3: deterministic purpose/confidence for every variable —
    // infra binding name or alias, external-service credential, internal
    // secret, or plain configuration.
    // A key that switches S3 on belongs to the vendor, even when its name looks like an internal secret.
    const classification = source.includes(S3_PRESENCE_EVIDENCE)
      ? { purpose: secret ? ('external_credential' as const) : classifyEnvVarPurpose(key).purpose, confidence: 'medium' as const }
      : classifyEnvVarPurpose(key);
    // Stage B phase 4: application-INTERNAL required secrets Deployz can
    // generate (never external vendor credentials, never provisioned
    // bindings). `generatable` is set only when true — absence reads as "not
    // generatable", keeping old data valid.
    const generatable =
      classification.purpose === 'internal_secret' && required && !isExternalCredentialShape(key);
    // Never drop a var the app declares-and-reads from the config surface —
    // but drop nothing: a sample-only var is still worth listing as optional.
    entries.push({
      key,
      required,
      secret,
      source,
      purpose: classification.purpose,
      confidence: classification.confidence,
      ...(generatable ? { generatable: true } : {}),
    });
  }

  return entries;
}

/**
 * A name that itself names a location (a URI/URL/endpoint/host) is never a
 * secret, even when it contains TOKEN/KEY: outline's OIDC_TOKEN_URI points
 * at a discovery endpoint, not a credential (DEPLOY-030). A public or
 * publishable key is published to clients, so it is not a secret either.
 */
const LOCATION_SUFFIX_REGEX = /_(?:URI|URL|ENDPOINT|HOST|PUBLIC_KEY|PUBLISHABLE_KEY)$/i;

/**
 * A token count or limit (BOOK_RAG_CHUNK_MAX_TOKENS, LLM_TOKEN_LIMIT) is a
 * number, not a credential, even though the name contains TOKEN. Only
 * quantity forms match: plural credential names (API_TOKENS) stay secret.
 */
const TOKEN_QUANTITY_REGEX = /(?:^|_)(?:MAX|MIN|NUM)_TOKENS(?=_|$)|(?:^|_)TOKENS_(?:LIMIT|PER)(?=_|$)|_TOKEN_(?:LIMIT|COUNT|BUDGET|MAX|MIN)(?=_|$)/gi;

/** Name-based credential heuristic — value-free, so it can never leak anything. */
export function isSecretName(key: string): boolean {
  return (
    SECRET_NAME_REGEX.test(key.replace(TOKEN_QUANTITY_REGEX, '_')) && !LOCATION_SUFFIX_REGEX.test(key)
  );
}

// Variables the runtime, the container platform or a CI/hosting provider
// supplies (Deployz itself injects PORT and HOSTNAME); an app reading one
// without a fallback is not asking the vendor for a value (Stage A COMP-016).
const PLATFORM_ENV_VARS = new Set<string>([
  'NODE_ENV',
  'NODE_OPTIONS',
  'PORT',
  'HOST',
  'HOSTNAME',
  'HOME',
  'PATH',
  'LD_LIBRARY_PATH',
  'PWD',
  'TZ',
  'LANG',
  'CI',
  'DEBUG',
  'VERCEL',
  'VERCEL_ENV',
  'VERCEL_URL',
  'NETLIFY',
  'GITHUB_ACTIONS',
  'NEXT_RUNTIME',
  'NEXT_PHASE',
  'NEXT_TELEMETRY_DISABLED',
]);

function isPlatformEnvVar(key: string): boolean {
  return PLATFORM_ENV_VARS.has(key) || key.startsWith('npm_');
}

// 13. Package manager
// ---------------------------------------------------------------------------

// Checked in priority order: a lockfile can only belong to one of these, but
// a repository is only ever expected to carry one at a time.
const LOCKFILE_MANAGERS: { pattern: RegExp; name: string }[] = [
  { pattern: /(?:^|\/)pnpm-lock\.yaml$/, name: 'pnpm' },
  { pattern: /(?:^|\/)yarn\.lock$/, name: 'yarn' },
  { pattern: /(?:^|\/)bun\.lockb?$/, name: 'bun' },
  { pattern: /(?:^|\/)package-lock\.json$/, name: 'npm' },
];

/**
 * Detect the package manager from the root package.json "packageManager"
 * field (a Corepack pin, e.g. "pnpm@9.0.0") or, failing that, a lockfile
 * present anywhere in the tree. The packageManager field wins when both are
 * present — it is an explicit pin, a lockfile is only circumstantial evidence.
 */
export function detectPackageManager(tree: FileTree): DetectorFinding {
  if (!nodeManifestsApplyToImage(tree)) return { detector: 'package-manager', detected: false };
  const rootRaw = tree['package.json'];
  if (rootRaw) {
    try {
      const rootPkg = JSON.parse(rootRaw) as Record<string, unknown>;
      const pin = rootPkg['packageManager'];
      if (typeof pin === 'string' && pin.trim()) {
        const name = pin.split('@')[0];
        if (name) {
          return {
            detector: 'package-manager',
            detected: true,
            value: name,
            details: `Package manager pinned via package.json "packageManager": ${pin}`,
          };
        }
      }
    } catch {
      // A malformed root manifest is "no pin" — fall through to lockfile detection.
    }
  }

  for (const { pattern, name } of LOCKFILE_MANAGERS) {
    if (Object.keys(tree).some((path) => pattern.test(path))) {
      return {
        detector: 'package-manager',
        detected: true,
        value: name,
        details: `Package manager detected via lockfile (${name})`,
      };
    }
  }

  return { detector: 'package-manager', detected: false };
}

// 14. Build command
// ---------------------------------------------------------------------------

const NODE_PACKAGE_MANAGER_RUN_REGEX = /^\s*RUN\b[^\n]*\b(?:npm|npx|yarn|pnpm|bun)\s/im;

/**
 * Whether package.json manifests (scripts, lockfiles) describe the image
 * Deployz builds. Without a Dockerfile the manifest is the app. With one,
 * only when the selected Dockerfile builds or runs Node — a Python image
 * never runs a sibling front end's `react-scripts build`.
 */
function nodeManifestsApplyToImage(tree: FileTree): boolean {
  const dockerfile = selectedDockerfile(tree);
  if (!dockerfile) return true;
  return (
    parseDockerfileStages(dockerfile.content).some((stage) => runtimeFromImage(stage.image) === 'node') ||
    NODE_PACKAGE_MANAGER_RUN_REGEX.test(dockerfile.content.replace(/\\\r?\n/g, ' '))
  );
}

/**
 * Detect the application build command from package.json "build" scripts,
 * repository root first, same ordering as `parsePackageJsons` — only when
 * those scripts belong to the image Deployz builds.
 */
export function detectBuildCommand(tree: FileTree): DetectorFinding {
  const commands: string[] = [];

  for (const [name, command] of nodeManifestsApplyToImage(tree) ? collectScripts(tree) : []) {
    if (name === 'build') {
      commands.push(command);
    }
  }

  if (commands.length === 0) {
    return { detector: 'build-command', detected: false };
  }

  return {
    detector: 'build-command',
    detected: true,
    value: commands,
    details: `Build commands detected: ${commands.join('; ')}`,
    source: 'package-manifest',
  };
}

// 15. Runtime
// ---------------------------------------------------------------------------

/** The runtime family a base image or dependency manifest belongs to. */
export type RuntimeFamily = 'node' | 'python' | 'ruby' | 'go' | 'jvm' | 'dotnet' | 'php' | 'elixir' | 'rust';

// Captures the base image and, when present, its `AS <name>` stage alias.
const DOCKERFILE_STAGE_REGEX = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+[Aa][Ss]\s+(\S+))?/gim;
const DOCKERFILE_WORKDIR_REGEX = /^\s*WORKDIR\s+(\S+)/gim;

/** Base-image name → runtime family, matched on the image path without registry or tag. */
const RUNTIME_IMAGES: { pattern: RegExp; runtime: RuntimeFamily }[] = [
  { pattern: /(?:^|\/)(?:node|bun|denoland\/deno|deno)$/i, runtime: 'node' },
  { pattern: /(?:^|\/)(?:python|pypy)$/i, runtime: 'python' },
  { pattern: /(?:^|\/)(?:ruby|jruby)$/i, runtime: 'ruby' },
  { pattern: /(?:^|\/)golang$/i, runtime: 'go' },
  { pattern: /(?:^|\/)(?:eclipse-temurin|openjdk|amazoncorretto|maven|gradle|jetty|tomcat)$/i, runtime: 'jvm' },
  { pattern: /(?:^|\/)dotnet\/(?:sdk|aspnet|runtime)$/i, runtime: 'dotnet' },
  { pattern: /(?:^|\/)(?:php|composer)$/i, runtime: 'php' },
  { pattern: /(?:^|\/)(?:elixir|hexpm\/elixir|erlang)$/i, runtime: 'elixir' },
  { pattern: /(?:^|\/)rust$/i, runtime: 'rust' },
];

/** Dependency manifest → runtime family, when no Dockerfile base image decides. */
const RUNTIME_MANIFESTS: { pattern: RegExp; runtime: RuntimeFamily }[] = [
  { pattern: PACKAGE_JSON_REGEX, runtime: 'node' },
  { pattern: PY_DEPENDENCY_FILES, runtime: 'python' },
  { pattern: /(?:^|\/)Gemfile$/, runtime: 'ruby' },
  { pattern: GO_DEPENDENCY_FILES, runtime: 'go' },
  { pattern: /(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?)$/, runtime: 'jvm' },
  { pattern: /(?:^|\/)(?:[\w.-]+\.csproj|[\w.-]+\.sln|global\.json)$/, runtime: 'dotnet' },
  { pattern: /(?:^|\/)composer\.json$/, runtime: 'php' },
  { pattern: /(?:^|\/)mix\.exs$/, runtime: 'elixir' },
  { pattern: /(?:^|\/)Cargo\.toml$/, runtime: 'rust' },
];

/**
 * Strip a digest, a tag and a registry host (`public.ecr.aws/docker/
 * library/node:22`) down to the image name.
 */
function imageName(image: string): string {
  const withoutDigest = image.split('@')[0] ?? image;
  const tagIndex = withoutDigest.lastIndexOf(':');
  const path = tagIndex > withoutDigest.lastIndexOf('/') ? withoutDigest.slice(0, tagIndex) : withoutDigest;
  return path.replace(/^[^/]+\.[^/]+\//, '').replace(/^library\//, '');
}

function runtimeFromImage(image: string): RuntimeFamily | null {
  const name = imageName(image);
  const known = RUNTIME_IMAGES.find(({ pattern }) => pattern.test(name))?.runtime;
  if (known !== undefined) return known;
  // `astral-sh/uv:0.12-python3.14-trixie-slim` is a Python image with uv on top.
  return /(?:^|\/)astral-sh\/uv$/.test(name) && /[:-]python\d/.test(image.split('@')[0] ?? image) ? 'python' : null;
}

interface DockerfileStage {
  name: string | null;
  image: string;
  /** This stage's own instructions, from its `FROM` up to the next one. */
  body: string;
}

/** Split a Dockerfile into its build stages, each stage's own instructions included. */
function parseDockerfileStages(content: string): DockerfileStage[] {
  const matches = [...content.matchAll(DOCKERFILE_STAGE_REGEX)].filter((match) => (match[1] ?? '').length > 0);
  return matches.map((match, i) => {
    const start = match.index ?? 0;
    const end = i + 1 < matches.length ? (matches[i + 1]!.index ?? content.length) : content.length;
    return { name: match[2] ? match[2].toLowerCase() : null, image: match[1]!, body: content.slice(start, end) };
  });
}

/** A stage name or numeric index, resolved against stages declared earlier in the file. */
function resolveDockerfileStage(ref: string, stages: DockerfileStage[], beforeIndex: number): DockerfileStage | undefined {
  if (/^\d+$/.test(ref)) return stages[Number(ref)];
  const name = ref.toLowerCase();
  for (let i = beforeIndex - 1; i >= 0; i -= 1) {
    if (stages[i]!.name === name) return stages[i];
  }
  return undefined;
}

interface DockerfileCopyFrom {
  from: string;
  sources: string[];
  dest: string;
}

/** `COPY --from=<stage> <src>... <dest>` lines within one stage's own body. */
function parseCopyFromLines(stageBody: string): DockerfileCopyFrom[] {
  const copies: DockerfileCopyFrom[] = [];
  for (const line of stageBody.replace(/\\\r?\n/g, ' ').split('\n')) {
    const copyMatch = /^\s*COPY\s+(.+)$/i.exec(line);
    if (!copyMatch) continue;
    const rest = copyMatch[1]!.trim();
    const fromMatch = /--from=(\S+)/.exec(rest);
    if (!fromMatch) continue;
    const tokens = rest.split(/\s+/).filter((token) => !token.startsWith('--'));
    if (tokens.length < 2) continue;
    copies.push({ from: fromMatch[1]!, sources: tokens.slice(0, -1), dest: tokens[tokens.length - 1]! });
  }
  return copies;
}

/** The executable path a stage's own CMD/ENTRYPOINT runs, resolved against its WORKDIR. */
function stageExecutablePath(stageBody: string): string | null {
  const command = CMD_REGEX.exec(stageBody)?.[1] ?? ENTRYPOINT_REGEX.exec(stageBody)?.[1];
  if (!command) return null;
  const firstToken = execFormToShell(command).trim().split(/\s+/)[0] ?? '';
  if (firstToken.startsWith('/')) return firstToken;
  if (!firstToken.startsWith('./')) return null;
  const workdir = [...stageBody.matchAll(DOCKERFILE_WORKDIR_REGEX)].pop()?.[1] ?? '/';
  return `${workdir.replace(/\/$/, '')}/${firstToken.slice(2)}`;
}

/** True when a COPY's destination is where the given executable path ends up. */
function copyProvides(copy: DockerfileCopyFrom, executablePath: string): boolean {
  if (copy.dest === executablePath) return true;
  const destDir = copy.dest.endsWith('/') ? copy.dest.slice(0, -1) : copy.dest;
  const execDir = executablePath.slice(0, executablePath.lastIndexOf('/')) || '/';
  const execName = executablePath.slice(executablePath.lastIndexOf('/') + 1);
  return destDir === execDir && copy.sources.some((source) => (source.split('/').pop() ?? '') === execName);
}

/**
 * When a multi-stage build's final stage is itself a bare OS image (no
 * runtime of its own — fider ships its Go binary from `debian:bookworm-slim`),
 * resolve the runtime through the stage(s) that final stage's own
 * `COPY --from=` draws on: prefer whichever referenced stage supplies the
 * file the final stage's CMD/ENTRYPOINT actually runs, otherwise the first
 * referenced stage (in file order) that maps to a runtime at all.
 */
function runtimeFromCopiedStages(finalStage: DockerfileStage, stages: DockerfileStage[]): { runtime: RuntimeFamily; image: string } | null {
  const finalIndex = stages.length - 1;
  const referenced = parseCopyFromLines(finalStage.body)
    .map((copy) => ({ copy, stage: resolveDockerfileStage(copy.from, stages, finalIndex) }))
    .filter((entry): entry is { copy: DockerfileCopyFrom; stage: DockerfileStage } => entry.stage !== undefined);

  const executablePath = stageExecutablePath(finalStage.body);
  if (executablePath) {
    const provider = referenced.find((entry) => copyProvides(entry.copy, executablePath));
    const runtime = provider ? runtimeFromImage(provider.stage.image) : null;
    if (runtime) return { runtime, image: provider!.stage.image };
  }
  for (const entry of referenced) {
    const runtime = runtimeFromImage(entry.stage.image);
    if (runtime) return { runtime, image: entry.stage.image };
  }
  return null;
}

/**
 * Detect the runtime family the deployed container runs. The selected
 * Dockerfile decides first: the base image of the production stage or of the
 * stage it is built `FROM` (walking the lineage from the leaf to the root);
 * otherwise the runtime reached through the final stage's own `COPY --from=`
 * references (see `runtimeFromCopiedStages`).
 * Without either, the shallowest dependency manifest decides — a root
 * `package.json` outranks a nested `requirements.txt`. A manifest that names
 * no application (a `go.mod` with no Go source below it, a `package.json`
 * with no dependencies) is tooling and decides only when nothing else remains.
 */
export function detectRuntime(tree: FileTree): DetectorFinding {
  const dockerfile = selectedDockerfile(tree);
  if (dockerfile) {
    const stages = parseDockerfileStages(normalizeDockerfile(dockerfile.content));
    const finalStage = stages[stages.length - 1];
    if (finalStage) {
      const lineageStage = dockerfileStageChain(stages, productionStageIndex(stages)).find((stage) => runtimeFromImage(stage.image) !== null);
      const resolved = lineageStage
        ? { runtime: runtimeFromImage(lineageStage.image)!, image: lineageStage.image }
        : stages.length > 1
          ? runtimeFromCopiedStages(finalStage, stages)
          : null;
      if (resolved) {
        return {
          detector: 'runtime',
          detected: true,
          value: resolved.runtime,
          details: `Base image ${resolved.image} in ${dockerfile.path}`,
          source: 'dockerfile',
        };
      }
    }
  }

  const allPaths = (tree as FileTree & { [TREE_PATHS]?: readonly string[] })[TREE_PATHS] ?? Object.keys(tree);
  const isToolingManifest = (path: string): boolean => {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    if (GO_DEPENDENCY_FILES.test(path)) return !allPaths.some((candidate) => candidate.startsWith(dir) && GO_SOURCE.test(candidate));
    if (PACKAGE_JSON_REGEX.test(path)) return collectDependencyNames({ [path]: tree[path] ?? '' }).length === 0;
    return false;
  };
  const allManifests = Object.keys(tree)
    .filter((path) => RUNTIME_MANIFESTS.some(({ pattern }) => pattern.test(path)))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  const appManifests = allManifests.filter((path) => !isToolingManifest(path));
  for (const path of appManifests.length > 0 ? appManifests : allManifests) {
    const runtime = RUNTIME_MANIFESTS.find(({ pattern }) => pattern.test(path))?.runtime;
    if (runtime) {
      return {
        detector: 'runtime',
        detected: true,
        value: runtime,
        details: `Dependency manifest ${path}`,
        source: 'package-manifest',
      };
    }
  }

  return { detector: 'runtime', detected: false };
}

// 15b. Migration runner
// ---------------------------------------------------------------------------

/** Whether the runtime image can run a migration command the way Deployz runs it. */
export type MigrationRunnerVerdict =
  | { readonly runnable: true; readonly needsNpx: boolean }
  | { readonly runnable: false; readonly reason: string };

/** The package runners a migration command can start with. */
const JS_RUNNERS: ReadonlySet<string> = new Set(['npx', 'npm', 'yarn', 'pnpm', 'bun', 'bunx', 'node', 'deno']);

/** Bare ORM CLI invocation (a package.json script) → the package that ships the binary. */
const ORM_CLI_PACKAGES: Readonly<Record<string, string>> = {
  prisma: 'prisma',
  'drizzle-kit': 'drizzle-kit',
  knex: 'knex',
  sequelize: 'sequelize-cli',
  'sequelize-cli': 'sequelize-cli',
  typeorm: 'typeorm',
  'node-pg-migrate': 'node-pg-migrate',
  migrate: 'migrate',
};

const NODE_MODULES_INSTALL_REGEX =
  /\b(?:npm\s+(?:ci|install|i)|yarn\s+install|pnpm\s+(?:install|i)|bun\s+install)\b(?![^\n]*(?:\s-g\b|--global\b))/;
const PRODUCTION_ONLY_REGEX = /--omit[= ]dev\b|--production\b|--prod\b|--only[= ]prod|NODE_ENV[= ]["']?production\b/;

interface RuntimeImage {
  /** The external image the runtime stage ancestry starts from. */
  readonly base: string;
  readonly hasShell: boolean;
  readonly tools: ReadonlySet<string>;
  /** What the runtime image shows of installed node_modules. */
  readonly nodeModules: 'none' | 'production' | 'all';
}

/** The runtime stage and its `FROM <stage>` ancestry, runtime stage first. */
function dockerfileStageChain(stages: DockerfileStage[], index: number): DockerfileStage[] {
  const chain: DockerfileStage[] = [];
  let position = index;
  let stage = stages[position];
  while (stage !== undefined && chain.length <= stages.length) {
    chain.push(stage);
    const parent = resolveDockerfileStage(stage.image, stages, position);
    if (parent === undefined) break;
    position = stages.indexOf(parent);
    stage = parent;
  }
  return chain;
}

function nodeModulesOf(text: string): 'none' | 'production' | 'all' {
  const installs = text.split('\n').filter((line) => NODE_MODULES_INSTALL_REGEX.test(line));
  if (installs.length === 0) return 'none';
  return PRODUCTION_ONLY_REGEX.test(text) ? 'production' : 'all';
}

/**
 * What the selected Dockerfile's runtime stage provides, read from the final
 * stage and the stages it is built `FROM`: the base image's own tools, the
 * runners its instructions install or remove, and the node_modules it
 * installs or copies from another stage. Null when the base image is a
 * build argument or another value that cannot be read.
 */
function runtimeImageOf(content: string): RuntimeImage | null {
  const stages = parseDockerfileStages(content);
  const chain = dockerfileStageChain(stages, stages.length - 1);
  const base = chain.at(-1)?.image;
  if (base === undefined || base.includes('$')) return null;
  const text = chain.map((stage) => stage.body).join('\n');
  const name = imageName(base);
  const tools = new Set<string>();
  if (/(?:^|\/)node$/.test(name) && !name.startsWith('chainguard/')) {
    for (const tool of ['node', 'npm', 'npx']) tools.add(tool);
    // The official Node images stopped shipping Yarn with Node 26.
    const major = /:(\d+)/.exec(base.split('@')[0] ?? base)?.[1];
    if (major === undefined || Number(major) < 26) tools.add('yarn');
  } else if (/(?:^|\/)bun$/.test(name)) {
    for (const tool of ['bun', 'bunx']) tools.add(tool);
  } else if (/(?:^|\/)deno$/.test(name)) {
    tools.add('deno');
  }
  if (tools.has('npm')) {
    if (/\bcorepack\s+enable\b|\bnpm\s+(?:i|install)\s+(?:-g|--global)\b[^\n]*\bpnpm\b/.test(text)) tools.add('pnpm');
    if (/\bcorepack\s+enable\b|\bnpm\s+(?:i|install)\s+(?:-g|--global)\b[^\n]*\byarn\b/.test(text)) tools.add('yarn');
    if (/\brm\b[^\n]*\/(?:npm|npx)\b/.test(text)) {
      tools.delete('npm');
      tools.delete('npx');
    }
  }

  // A COPY --from carries node_modules when it names them, or copies the
  // whole working directory the source stage installed into.
  let nodeModules = nodeModulesOf(text);
  for (const stage of chain) {
    for (const copy of parseCopyFromLines(stage.body)) {
      const from = resolveDockerfileStage(copy.from, stages, stages.indexOf(stage));
      if (from === undefined) continue;
      const fromChain = dockerfileStageChain(stages, stages.indexOf(from));
      const fromText = fromChain.map((s) => s.body).join('\n');
      const workdir = fromChain
        .map((s) => [...s.body.matchAll(DOCKERFILE_WORKDIR_REGEX)].at(-1)?.[1])
        .find((dir) => dir !== undefined)
        ?.replace(/\/$/, '');
      const carriesNodeModules = copy.sources.some(
        (source) => source.includes('node_modules') || source.replace(/\/$/, '') === workdir,
      );
      if (!carriesNodeModules) continue;
      const copied = nodeModulesOf(fromText);
      if (copied === 'all' || (copied === 'production' && nodeModules === 'none')) nodeModules = copied;
    }
  }
  return { base, hasShell: !/^(?:distroless\/|scratch$)/.test(name), tools, nodeModules };
}

/** Whether a package.json in the tree declares the package for the node_modules the image holds. */
function packageInstalled(tree: FileTree, pkg: string, nodeModules: RuntimeImage['nodeModules']): boolean {
  if (nodeModules === 'none') return false;
  return parsePackageJsonsWithPath(tree).some(({ pkg: manifest }) => {
    const dependencies = manifest['dependencies'];
    const devDependencies = manifest['devDependencies'];
    const inProduction = typeof dependencies === 'object' && dependencies !== null && pkg in dependencies;
    const inDevelopment = typeof devDependencies === 'object' && devDependencies !== null && pkg in devDependencies;
    return inProduction || (nodeModules === 'all' && inDevelopment);
  });
}

/**
 * Whether the image Deployz builds from the selected Dockerfile can run a
 * migration command as the relay runs it: `sh -c <command>` at the image's
 * WORKDIR, without the package script runner's PATH. Only a JavaScript
 * package runner (or a bare ORM CLI, which needs `npx`) is checked; any
 * other command is left to the vendor. The runner must ship with the
 * runtime image or be installed by its instructions, and a CLI that `npx`
 * starts must already be in the image's node_modules, because `npx` would
 * otherwise download it at run time. Dependencies alone never prove that.
 * Anything uncertain is not runnable, so the vendor decides.
 */
export function migrationRunnerVerdict(tree: FileTree, command: string): MigrationRunnerVerdict {
  const [first = '', ...rest] = command.trim().split(/\s+/);
  const bareCli = ORM_CLI_PACKAGES[first] !== undefined;
  const runner = bareCli ? 'npx' : first;
  if (!JS_RUNNERS.has(runner)) return { runnable: true, needsNpx: false };

  const dockerfile = selectedDockerfile(tree);
  if (dockerfile === null) {
    return { runnable: false, reason: 'no Dockerfile shows what the runtime image contains' };
  }
  const image = runtimeImageOf(dockerfile.content);
  if (image === null) {
    return { runnable: false, reason: `the runtime image of ${dockerfile.path} cannot be determined` };
  }
  if (!image.hasShell) {
    return { runnable: false, reason: `the runtime image ${image.base} has no shell to run a command` };
  }
  if (!image.tools.has(runner)) {
    return { runnable: false, reason: `the runtime image ${image.base} is not shown to provide ${runner}` };
  }
  if (runner === 'npx') {
    const cli = bareCli ? first : rest.find((token) => !token.startsWith('-'));
    const pkg = cli !== undefined ? (ORM_CLI_PACKAGES[cli] ?? cli) : undefined;
    if (pkg === undefined || !packageInstalled(tree, pkg, image.nodeModules)) {
      return {
        runnable: false,
        reason: `the runtime image is not shown to contain ${pkg ?? 'the command'}, so npx would download it at run time`,
      };
    }
  }
  return { runnable: true, needsNpx: bareCli };
}

// 16. Bind address
// ---------------------------------------------------------------------------

const LOOPBACK_LITERAL = /['"](?:127\.0\.0\.1|localhost|::1)['"]/;
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|::1)$/;
const ALL_INTERFACES_LITERAL = /['"](?:0\.0\.0\.0|::)['"]/;
const LISTEN_CALL_REGEX = /\.listen\s*\(([^)]*)\)/g;
const LISTEN_AND_SERVE_REGEX = /ListenAndServe(?:TLS)?\s*\(\s*['"`]([^'"`:]*):/g;
const PY_RUN_HOST_REGEX = /\.run\s*\([^)]*host\s*=\s*['"](?:127\.0\.0\.1|localhost)['"]/;
const GUNICORN_CONF_BIND_REGEX = /^\s*bind\s*=\s*['"](?:127\.0\.0\.1|localhost):/m;
const COMMAND_HOST_FLAG_REGEX = /(?:--host(?:name)?[=\s]+|-H\s+|-b\s+|--bind[=\s]+)['"]?(127\.0\.0\.1|localhost|0\.0\.0\.0|::)(?=[\s:'"]|$)/;
const DOCKERFILE_ENV_HOST_REGEX = /^\s*ENV\s+(?:HOST|HOSTNAME|BIND_ADDRESS)[=\s]+["']?(127\.0\.0\.1|localhost|0\.0\.0\.0)\b/m;
const LOOPBACK_BY_DEFAULT_REGEX = /(?:^|\s)(?:uvicorn|flask\s+run)(?:\s|$)(?![^\n]*(?:--host|-h\s))/;
const PROCFILE_REGEX = /(?:^|\/)Procfile$/;
// A desktop shell (Electron, Tauri) listens on loopback by design and is never the deployed server.
const DESKTOP_SEGMENT_REGEX = /(?:^|\/)(?:desktop|electron|tauri|src-tauri)(?:\/|$)/i;
const ELECTRON_IMPORT_REGEX = /from\s+['"]electron['"]|require\(\s*['"]electron['"]\s*\)/;

/** `["uvicorn", "main:app"]` (Dockerfile exec form) → `uvicorn main:app`. */
function execFormToShell(command: string): string {
  const trimmed = command.trim();
  if (!trimmed.startsWith('[')) return trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) && parsed.every((part) => typeof part === 'string') ? parsed.join(' ') : trimmed;
  } catch {
    return trimmed;
  }
}

/** The commands the container starts with, from the sources that decide production. */
function startCommandTexts(tree: FileTree): { file: string; text: string }[] {
  const texts: { file: string; text: string }[] = [];
  const dockerfile = selectedDockerfile(tree);
  if (dockerfile) {
    for (const command of Object.values(dockerfileImageCommand(dockerfile.content))) {
      if (command) texts.push({ file: dockerfile.path, text: execFormToShell(command) });
    }
  }
  for (const [path, content] of Object.entries(tree)) {
    if (!PROCFILE_REGEX.test(path) || !content || !isRuntimeSourcePath(path)) continue;
    const web = /^web:\s*(.+)$/m.exec(content);
    if (web?.[1]) texts.push({ file: path, text: web[1] });
  }
  for (const [name, command, dir] of collectScriptsWithDir(tree)) {
    if (name === 'start') texts.push({ file: dir === '.' ? 'package.json' : `${dir}/package.json`, text: command });
  }
  return texts;
}

/**
 * Detect whether the server binds only to a loopback address. A container
 * that listens on 127.0.0.1/localhost never receives load-balancer traffic,
 * so the health check fails and the deployment never becomes healthy. Only
 * evidence that decides production counts: the selected Dockerfile's
 * CMD/ENTRYPOINT/ENV, a Procfile `web:` line, the `start` script, and
 * runtime source — never a dev script or a sample env file.
 */
export function detectBindAddress(tree: FileTree): DetectorFinding {
  const loopback: string[] = [];
  // A loopback literal in source is a default: an all-interfaces host in the production command overrides it.
  const sourceLoopback: string[] = [];
  const allInterfaces: string[] = [];

  const dockerfile = selectedDockerfile(tree);
  // What the image runs at start, including the shell script its ENTRYPOINT/CMD names.
  const startText = dockerfile ? startCommandText(tree, productionStageText(dockerfile.content)) : '';
  const startFlag = COMMAND_HOST_FLAG_REGEX.exec(startText);
  if (startFlag?.[1] && !LOOPBACK_HOST.test(startFlag[1])) allInterfaces.push(`${startFlag[0].trim()} (start command)`);
  const envHost = dockerfile ? DOCKERFILE_ENV_HOST_REGEX.exec(dockerfile.content) : null;
  if (dockerfile && envHost?.[1]) {
    (LOOPBACK_HOST.test(envHost[1]) ? loopback : allInterfaces).push(`${envHost[0].trim()} (${dockerfile.path})`);
  }

  for (const { file, text } of startCommandTexts(tree)) {
    const flag = COMMAND_HOST_FLAG_REGEX.exec(text);
    if (flag?.[1]) {
      (LOOPBACK_HOST.test(flag[1]) ? loopback : allInterfaces).push(`${text.trim()} (${file})`);
    } else if (LOOPBACK_BY_DEFAULT_REGEX.test(text)) {
      // uvicorn and `flask run` bind 127.0.0.1 when no host is given.
      loopback.push(`${text.trim()} binds 127.0.0.1 by default (${file})`);
    }
  }
  // Only the start command or the image ENV overrides a source default; another file's 0.0.0.0 does not.
  const commandBindsAllInterfaces = allInterfaces.length > 0;

  for (const [path, content] of Object.entries(tree)) {
    if (!content || !isRuntimeSourcePath(path)) continue;
    if (DESKTOP_SEGMENT_REGEX.test(path) || ELECTRON_IMPORT_REGEX.test(content)) continue;
    if (JS_SOURCE.test(path)) {
      for (const match of content.matchAll(LISTEN_CALL_REGEX)) {
        const args = match[1] ?? '';
        if (LOOPBACK_LITERAL.test(args)) sourceLoopback.push(`listen(${args.trim()}) (${path})`);
        else if (ALL_INTERFACES_LITERAL.test(args)) allInterfaces.push(`listen(${args.trim()}) (${path})`);
      }
    } else if (PY_SOURCE.test(path)) {
      // An `app.run(host=…)` counts only in a module the image runs (a dev `serve.py` is never started).
      const module = (path.split('/').pop() ?? path).replace(/\.py$/, '');
      const runByImage = startText === '' || startText.split(/[^\w-]+/).includes(module);
      if (runByImage && PY_RUN_HOST_REGEX.test(content)) sourceLoopback.push(`server host set to a loopback address (${path})`);
      if (/gunicorn/i.test(path) && GUNICORN_CONF_BIND_REGEX.test(content)) {
        sourceLoopback.push(`gunicorn bind on a loopback address (${path})`);
      }
    } else if (GO_SOURCE.test(path)) {
      for (const match of content.matchAll(LISTEN_AND_SERVE_REGEX)) {
        const host = match[1] ?? '';
        if (LOOPBACK_HOST.test(host)) sourceLoopback.push(`ListenAndServe("${host}:…") (${path})`);
      }
    }
  }

  if (!commandBindsAllInterfaces) loopback.push(...sourceLoopback);
  if (loopback.length > 0) {
    return {
      detector: 'bind-address',
      detected: true,
      value: 'localhost',
      details: `Server binds only to a loopback address: ${loopback.join('; ')}`,
      source: 'source',
    };
  }
  if (allInterfaces.length > 0) {
    return {
      detector: 'bind-address',
      detected: false,
      value: 'all-interfaces',
      details: `Server binds to all interfaces: ${allInterfaces.join('; ')}`,
      source: 'source',
    };
  }
  return { detector: 'bind-address', detected: false };
}

// 17. Dockerfile git-copy build context
// ---------------------------------------------------------------------------

// A `COPY`/`ADD` instruction line, any stage (continuations already
// collapsed to spaces before this runs — see the `RUN … \` handling above).
const DOCKERFILE_COPY_ADD_REGEX = /^\s*(?:COPY|ADD)\s+([^\n#]+)$/gm;
// A `--from=` copy reads from another build stage or a named image, never
// from the build context — the tarball's missing `.git` cannot affect it.
const COPY_FROM_FLAG_REGEX = /--from=/;
// The source is `.git` itself or a path inside it (`.git/HEAD`), not a
// lookalike (`.gitignore`, `.github`, `.gitattributes`, `.gitmodules`).
const GIT_SOURCE_TOKEN_REGEX = /^(?:\.\/)?\.git(?:\/.*)?$/;
const DOCKERFILE_RUN_REGEX = /^\s*RUN\s+([^\n]+)$/gm;
// A command of a RUN step that reads git history (`git rev-parse HEAD > .git_sha`).
const GIT_HISTORY_COMMAND_REGEX = /^\s*git\s+(?:rev-parse|describe|log|rev-list|show)\b/;
// The Dockerfile makes its own repository, so git reads work without the context's `.git`.
const GIT_REPOSITORY_SETUP_REGEX = /\bgit\s+(?:clone|init)\b/;

/**
 * The source tokens of a `COPY`/`ADD` instruction's argument string — every
 * token but the destination — handling both the JSON array form
 * (`COPY ["a", "b", "dest"]`) and the plain shell form. Flags (`--chown=`,
 * `--chmod=`, `--link`) are dropped first.
 */
function copyAddSources(args: string): string[] {
  const trimmed = args.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.length > 1 && parsed.every((part) => typeof part === 'string')) {
        return parsed.slice(0, -1);
      }
    } catch {
      // Malformed JSON form — no sources to check.
    }
    return [];
  }
  const tokens = trimmed.split(/\s+/).filter((token) => !token.startsWith('--'));
  return tokens.length > 1 ? tokens.slice(0, -1) : [];
}

/**
 * Detect a `COPY`/`ADD` instruction in the selected Dockerfile whose source
 * is the repository's `.git` directory, or a `RUN` step that reads git history
 * from it. Deployz builds images from a GitHub
 * tarball (source-fetch.ts), which never contains `.git`, so the copy fails
 * the build with a checksum error before the vendor gets a useful message
 * (DEPLOY-031, sosedoff/pgweb: `COPY .git/ .` feeds a `git rev-parse` in the
 * Makefile).
 */
export function detectGitCopyInDockerfile(tree: FileTree): DetectorFinding {
  const dockerfile = selectedDockerfile(tree);
  if (!dockerfile) return { detector: 'dockerfile-git-copy', detected: false };

  const collapsed = dockerfile.content.replace(/\\\r?\n/g, ' ');
  const matches: string[] = [];
  for (const match of collapsed.matchAll(DOCKERFILE_COPY_ADD_REGEX)) {
    const args = match[1] ?? '';
    if (COPY_FROM_FLAG_REGEX.test(args)) continue;
    if (copyAddSources(args).some((token) => GIT_SOURCE_TOKEN_REGEX.test(token))) {
      matches.push(match[0].trim());
    }
  }
  // A RUN command that reads git history with no `||` fallback fails the build (chatwoot's
  // `RUN git rev-parse HEAD > /app/.git_sha`).
  if (!GIT_REPOSITORY_SETUP_REGEX.test(collapsed)) {
    for (const match of collapsed.matchAll(DOCKERFILE_RUN_REGEX)) {
      const commands = (match[1] ?? '').split(/&&|;/);
      if (commands.some((command) => GIT_HISTORY_COMMAND_REGEX.test(command) && !command.includes('||'))) {
        matches.push(match[0].trim());
      }
    }
  }

  if (matches.length === 0) return { detector: 'dockerfile-git-copy', detected: false };
  return {
    detector: 'dockerfile-git-copy',
    detected: true,
    value: matches,
    details: `Dockerfile copies or reads .git from the build context, which the tarball build never has: ${matches.join('; ')} (${dockerfile.path})`,
    source: 'dockerfile',
  };
}

/**
 * The full repository path list, when the caller knows it. The tree holds only
 * the files analysis reads; the fetch layer attaches every tracked path under
 * this symbol (never an enumerable key, so no detector sees it as a file).
 */
export const TREE_PATHS: unique symbol = Symbol.for('deployz.analysis.treePaths');

/**
 * `COPY`/`ADD` sources of the selected Dockerfile, or of `dockerfilePath` (no `--from`), that are not in
 * the repository, from the root or from the Dockerfile's directory: a build
 * output a CI step makes before `docker build` (listmonk's `COPY listmonk .`,
 * tolgee's prebuilt `BOOT-INF`). The release build has only the repository, so
 * that Dockerfile can never build. Empty when the path list is unknown.
 */
export function detectDockerfileMissingCopySources(tree: FileTree, dockerfilePath?: string): string[] {
  const paths = (tree as FileTree & { [TREE_PATHS]?: readonly string[] })[TREE_PATHS];
  const dockerfile = dockerfilePath === undefined ? selectedDockerfile(tree) : { path: dockerfilePath, content: tree[dockerfilePath] ?? '' };
  if (!paths || !dockerfile) return [];
  const dockerDir = dockerfile.path.includes('/') ? dockerfile.path.slice(0, dockerfile.path.lastIndexOf('/')) : '';
  const exists = (path: string): boolean => paths.some((candidate) => candidate === path || candidate.startsWith(`${path}/`));
  const missing: string[] = [];
  for (const match of dockerfile.content.replace(/\\\r?\n/g, ' ').matchAll(DOCKERFILE_COPY_ADD_REGEX)) {
    const args = match[1] ?? '';
    if (COPY_FROM_FLAG_REGEX.test(args)) continue;
    // Flags may precede the JSON form (`COPY --chown=app ["a b", "./"]`).
    for (const token of copyAddSources(args.replace(/^(?:\s*--\S+)+\s*(?=\[)/, ''))) {
      if (/[*?$[]|^[a-z]+:\/\//i.test(token) || GIT_SOURCE_TOKEN_REGEX.test(token)) continue;
      // A leading `/` is still relative to the build context.
      const source = token.replace(/^\/+/, '').replace(/^\.\//, '').replace(/\/+$/, '');
      if (source === '' || source === '.') continue;
      if (exists(source) || (dockerDir !== '' && exists(`${dockerDir}/${source}`))) continue;
      if (!missing.includes(source)) missing.push(source);
    }
  }
  return missing;
}

// Directories a build step writes. A missing one proves nothing: the vendor's
// own build may make it, so it never counts as an unbuildable Dockerfile.
const GENERATED_DIRECTORY_REGEX = /^(?:dist|build|out|target|bin|obj|\.next|\.output|node_modules|vendor|public|static|assets|generated|coverage)$/i;
// A Dockerfile that exists only for development or tests (never the production image).
const DEV_ONLY_DOCKERFILE_REGEX =
  /(?:^|\/)(?:\.devcontainer|\.gitpod)\/|(?:^|\/)dockerfile(?:[.-]\w+)*[.-](?:dev|development|test|e2e|ci|gitpod)(?:[.-]\w+)*$|(?:^|\/)[\w-]*(?:dev|test|ci)[\w-]*\.dockerfile$/i;

/**
 * A Dockerfile whose name marks it for development (`Dockerfile.dev`) is dev-only when its
 * content agrees: it runs a dev server, starts nothing, or builds nothing. A name alone is not
 * evidence: a project can publish its production image from `Dockerfile.dev`.
 */
function isDevOnlyDockerfile(path: string, content: string): boolean {
  if (!DEV_ONLY_DOCKERFILE_REGEX.test(path)) return false;
  const lines = productionStageText(content).split('\n');
  const start = lines.filter((line) => /^\s*(?:CMD|ENTRYPOINT)\b/i.test(line));
  const runsDevServer = start.some((line) => DEV_RUNTIME_REGEX.test(line.replace(/["',[\]\s]+/g, ' ')));
  const buildsSomething = lines.some((line) => /^\s*RUN\b.*\b(?:build|compile|publish)\b/i.test(line));
  return runsDevServer || start.length === 0 || !buildsSomething;
}

/**
 * Why the repository has no Dockerfile that builds a production image, or
 * null when it has one or the evidence is incomplete (COMP-021). Complete
 * evidence needs the full tracked path list, every Dockerfile in it fetched,
 * and no git submodule. It rejects when every Dockerfile is a development-only
 * file or a template, or when the selected Dockerfile copies sources the
 * repository does not contain (a prebuilt binary or archive), and every other
 * candidate with a CMD or ENTRYPOINT copies missing sources too. A generated
 * directory and `COPY --from=` never reject on their own.
 */
/** A COPY or ADD from the build context (not `--from` another stage or image), or a bind mount of it. */
function copiesFromContext(dockerfile: string): boolean {
  return dockerfile
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .some((line) => (/^\s*(?:COPY|ADD)\s/i.test(line) && !/--from=/i.test(line)) || (/--mount=type=bind/i.test(line) && !/\bfrom=/i.test(line)));
}

export function detectUnbuildableDockerfile(tree: FileTree): string | null {
  const paths = (tree as FileTree & { [TREE_PATHS]?: readonly string[] })[TREE_PATHS];
  if (!paths || paths.includes('.gitmodules')) return null;
  const tracked = paths.filter(isDockerfilePath);
  if (tracked.some((path) => tree[path] === undefined)) return null;
  if (tracked.length === 0) return 'No Dockerfile exists in the repository.';

  const buildable = tracked.filter(
    (path) => !isDevOnlyDockerfile(path, tree[path] ?? '') && !isUnusableDockerfile(path, tree[path] ?? ''),
  );
  if (buildable.length === 0) {
    return `The only Dockerfile${tracked.length > 1 ? 's are' : ' is'} for development or a template (${tracked.slice(0, 3).join(', ')}).`;
  }
  const missing = detectDockerfileMissingCopySources(tree).filter(
    (source) => !GENERATED_DIRECTORY_REGEX.test(source.split('/')[0] ?? ''),
  );
  // An image that takes nothing from the build context runs code from another image, not
  // from this commit (outline copies build/ and node_modules/ from the floating outline-base image).
  const selectedPath = selectedDockerfile(tree)?.path;
  if (missing.length === 0 && selectedPath !== undefined && !copiesFromContext(tree[selectedPath] ?? '')) {
    const fromContext = buildable.some(
      (path) => path !== selectedPath && /^\s*(?:CMD|ENTRYPOINT)\b/im.test(productionStageText(tree[path] ?? '')) && copiesFromContext(tree[path] ?? ''),
    );
    return fromContext ? null : `The Dockerfile (${selectedPath}) copies nothing from the repository, so the image runs code from another image, not from this commit.`;
  }
  if (missing.length === 0) return null;
  if (tracked.length === 1) {
    return `The only Dockerfile (${tracked[0]}) copies ${missing.slice(0, 3).join(', ')}, which the repository does not contain.`;
  }
  // Another candidate with a command that copies only repository content is a Dockerfile
  // the vendor can select (n8n's every image copies a CI build output; its base image
  // only EXPOSEs a port).
  const selected = selectedDockerfile(tree)?.path;
  const alternative = buildable.some(
    (path) =>
      path !== selected &&
      /^\s*(?:CMD|ENTRYPOINT)\b/im.test(productionStageText(tree[path] ?? '')) &&
      detectDockerfileMissingCopySources(tree, path).length === 0,
  );
  if (alternative) return null;
  return `Every Dockerfile with a start command copies files the repository does not contain (${selected} copies ${missing.slice(0, 3).join(', ')}).`;
}

// 18. Dockerfile build context
// ---------------------------------------------------------------------------

// Files that only exist at the root of a JavaScript workspace. A Dockerfile
// that copies one of them builds from the repository root, never from its
// own directory.
const WORKSPACE_ROOT_FILES = new Set(['turbo.json', 'pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'rush.json']);
const TURBO_PRUNE_REGEX = /\bturbo\s+prune\b/;

/**
 * Detect a Dockerfile kept in a subdirectory that is written for the
 * repository root as its build context. The build otherwise uses the
 * Dockerfile's own directory (packages/cdk/src/lambda/worker.ts), which
 * makes `COPY turbo.json turbo.json` or `COPY apps/web/package.json …` fail
 * with a checksum error (Stage B sprint, lukevella/rallly: `turbo prune`
 * monorepo Dockerfile under `apps/web/`). The finding value is the context
 * to use, `.`.
 */
export function detectDockerfileBuildContext(tree: FileTree): DetectorFinding {
  const dockerfile = selectedDockerfile(tree);
  if (!dockerfile) return { detector: 'dockerfile-build-context', detected: false };
  const slash = dockerfile.path.lastIndexOf('/');
  if (slash <= 0) return { detector: 'dockerfile-build-context', detected: false };
  const directory = dockerfile.path.slice(0, slash);

  const collapsed = dockerfile.content.replace(/\\\r?\n/g, ' ');
  const evidence = new Set<string>();
  if (TURBO_PRUNE_REGEX.test(collapsed)) evidence.add('turbo prune');
  // With the full path list: a source that exists only at the root (`COPY go.mod
  // go.sum ./` in `scripts/Dockerfile`) needs the root as its context.
  const paths = (tree as FileTree & { [TREE_PATHS]?: readonly string[] })[TREE_PATHS];
  const exists = (path: string): boolean =>
    paths !== undefined && paths.some((candidate) => candidate === path || candidate.startsWith(`${path}/`));
  for (const match of collapsed.matchAll(DOCKERFILE_COPY_ADD_REGEX)) {
    const args = match[1] ?? '';
    if (COPY_FROM_FLAG_REGEX.test(args)) continue;
    for (const token of copyAddSources(args)) {
      const source = token.replace(/^\.\//, '');
      if (/[$*?]|^[a-z]+:\/\//i.test(source)) continue;
      const rootOnly = source !== '.' && exists(source) && !exists(`${directory}/${source}`);
      if (source === directory || source.startsWith(`${directory}/`) || WORKSPACE_ROOT_FILES.has(source) || rootOnly) {
        evidence.add(`COPY ${source}`);
      }
    }
  }

  if (evidence.size === 0) return { detector: 'dockerfile-build-context', detected: false };
  return {
    detector: 'dockerfile-build-context',
    detected: true,
    value: '.',
    details: `${dockerfile.path} is written for the repository root as its build context: ${[...evidence].join('; ')}`,
    source: 'dockerfile',
  };
}

// A last stage that only packages or publishes build output (uptime-kuma's `upload-artifact`).
const TOOLING_LAST_STAGE_REGEX = /(?:^|[-_.])(?:artifacts?|upload|export|publish|lint)(?:[-_.]|$)/i;

/**
 * The stage to build when the Dockerfile's last stage is a tooling stage and
 * an earlier named stage starts the application. `docker build` builds the
 * last stage by default, so the build needs `--target <stage>`.
 */
export function detectDockerfileBuildTarget(tree: FileTree): DetectorFinding {
  const dockerfile = selectedDockerfile(tree);
  if (!dockerfile) return { detector: 'dockerfile-build-target', detected: false };
  const stages = parseDockerfileStages(normalizeDockerfile(dockerfile.content));
  const last = stages[stages.length - 1];
  if (last?.name == null || !(NON_RUNTIME_STAGE_NAME_REGEX.test(last.name) || TOOLING_LAST_STAGE_REGEX.test(last.name))) {
    return { detector: 'dockerfile-build-target', detected: false };
  }
  const target = stages[productionStageIndex(stages)];
  if (target === last || target?.name == null) return { detector: 'dockerfile-build-target', detected: false };
  return {
    detector: 'dockerfile-build-target',
    detected: true,
    value: target.name,
    details: `${dockerfile.path} ends with the tooling stage ${last.name}; the application stage is ${target.name}`,
    source: 'dockerfile',
  };
}

// Host-header allow lists. A wildcard (`['*']`, `"*"`) or a cleared list allows every host.
const HOST_VALIDATION_PATTERNS: readonly { file: RegExp; pattern: RegExp; allowsAll: RegExp }[] = [
  // Django `ALLOWED_HOSTS = [...]` / `env.list('ALLOWED_HOSTS')`
  { file: /\.py$/, pattern: /^\s*ALLOWED_HOSTS\s*=\s*\S/m, allowsAll: /^\s*ALLOWED_HOSTS\s*=\s*\[\s*["']\*["']\s*\]/m },
  // Rails `config.hosts << "example.com"`
  { file: /(?:^|\/)config\/(?:application|environments\/production)\.rb$/, pattern: /^\s*config\.hosts\s*(?:<<|=|\.push|\.concat)/m, allowsAll: /^\s*config\.hosts\s*(?:\.clear\b|=\s*(?:nil|\[\s*\]))/m },
  // ASP.NET `"AllowedHosts": "example.com"`
  { file: /(?:^|\/)appsettings(?:\.Production)?\.json$/, pattern: /"AllowedHosts"\s*:\s*"[^"]*"/, allowsAll: /"AllowedHosts"\s*:\s*"\*"/ },
  // Laravel trusted hosts
  { file: /(?:^|\/)(?:bootstrap\/app|app\/Http\/Kernel)\.php$/, pattern: /->trustHosts\(|^\s*\\App\\Http\\Middleware\\TrustHosts::class/m, allowsAll: /$^/ },
];

/**
 * The app rejects a request whose Host header it does not know. An AWS ALB
 * health check sends the task IP as Host, so such an app answers it 400 while
 * it serves its own domain (healthchecks: ALLOWED_HOSTS from SITE_ROOT).
 */
export function detectHostValidation(tree: FileTree): DetectorFinding {
  const found: string[] = [];
  for (const [path, content] of Object.entries(tree)) {
    if (!content || !isRuntimeSourcePath(path)) continue;
    for (const { file, pattern, allowsAll } of HOST_VALIDATION_PATTERNS) {
      if (file.test(path) && pattern.test(content) && !allowsAll.test(content)) found.push(path);
    }
  }
  if (found.length === 0) return { detector: 'host-validation', detected: false };
  return { detector: 'host-validation', detected: true, value: found, details: `The app checks the Host header: ${found.join(', ')}` };
}

/**
 * Where a repository file lies in the runtime image of the selected Dockerfile: a path relative
 * to the image's final `WORKDIR` (absolute when the file lies outside it). The build context
 * follows `detectDockerfileBuildContext`; `COPY --from` is followed through the stages. Null when
 * no `COPY` or `ADD` of the production lineage places the file. A repository path is not an
 * image path (paperless: `COPY ./src ./` puts `src/manage.py` at `manage.py`).
 */
export function pathInRuntimeImage(tree: FileTree, repoPath: string): string | null {
  const dockerfile = selectedDockerfile(tree);
  if (!dockerfile) return null;
  const stages = parseDockerfileStages(normalizeDockerfile(dockerfile.content));
  if (stages.length === 0) return null;
  const directory = dockerfile.path.includes('/') ? dockerfile.path.slice(0, dockerfile.path.lastIndexOf('/')) : '';
  const contextDir = detectDockerfileBuildContext(tree).detected ? '' : directory;
  const clean = (token: string): string => token.replace(/^[["']+|[\]",']+$/g, '');

  // Where `target` (a context path, or a path in a source stage) lies in one stage's image, and that stage's WORKDIR.
  const trace = (index: number, target: string, depth: number): { placed: string | null; workdir: string } => {
    let placed: string | null = null;
    let workdir = '/';
    if (depth > stages.length) return { placed, workdir };
    for (const lineageIndex of stageLineage(stages, index)) {
      for (const line of stages[lineageIndex]!.body.split('\n')) {
        const dir = /^\s*WORKDIR\s+(\S+)/i.exec(line)?.[1];
        if (dir !== undefined) {
          workdir = posixPath.resolve(workdir, clean(dir));
          continue;
        }
        const args = /^\s*(?:COPY|ADD)\s+(.+)$/i.exec(line)?.[1];
        if (args === undefined) continue;
        const fromStage = /--from=(\S+)/.exec(args)?.[1];
        const tokens = args.trim().split(/\s+/).filter((token) => !token.startsWith('--')).map(clean);
        if (tokens.length < 2 || tokens.some((token) => /[$*?<]|:\/\//.test(token))) continue;
        let source = { path: target, workdir: contextDir };
        if (fromStage !== undefined) {
          const sourceStage = resolveDockerfileStage(fromStage, stages, lineageIndex);
          if (sourceStage === undefined) continue;
          const upstream = trace(stages.indexOf(sourceStage), target, depth + 1);
          if (upstream.placed === null) continue;
          source = { path: upstream.placed, workdir: upstream.workdir };
        }
        const dest = tokens.pop()!;
        const destination = posixPath.resolve(workdir, dest);
        for (const token of tokens) {
          const sourcePath = fromStage === undefined ? posixJoin(source.workdir, token) : posixPath.resolve(source.workdir, token);
          if (source.path === sourcePath) {
            const intoDirectory = dest.endsWith('/') || dest === '.' || tokens.length > 1;
            placed = intoDirectory ? posixPath.join(destination, posixPath.basename(source.path)) : destination;
          } else if (sourcePath === '' || source.path.startsWith(`${sourcePath === '/' ? '' : sourcePath}/`)) {
            placed = posixPath.join(destination, sourcePath === '' ? source.path : source.path.slice(sourcePath === '/' ? 1 : sourcePath.length + 1));
          }
        }
      }
    }
    return { placed, workdir };
  };

  const { placed, workdir } = trace(productionStageIndex(stages), repoPath, 0);
  if (placed === null) return null;
  const relative = posixPath.relative(workdir, placed);
  return relative.startsWith('..') ? placed : relative;
}
