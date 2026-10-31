/**
 * §10 rejection classes — detect UNSUPPORTED dependencies that make an app
 * "Not currently compatible" with Deployz.
 *
 * Each rejection check is a pure function: `(tree: FileTree) => RejectionFinding`.
 * No AI, no network, no side effects.
 */

import { isProductionFile, PACKAGE_MANIFEST, PACKAGE_MARKER } from './ai-analysis/evidence-pack.js';
import type { ComposeService, FileTree } from './detectors.js';
import {
  TREE_PATHS,
  CMD_CHAIN_MAX_DEPTH,
  collectDependencyNames,
  composeApplicationServices,
  composeBuildDockerfile,
  composeServices,
  detectEnvVarModel,
  detectUnbuildableDockerfile,
  exposedPorts,
  detectPostgresql,
  DIALECT_AGNOSTIC_DRIVERS,
  extractCmdScriptPaths,
  findDependencyEvidence,
  INFRA_COMPOSE_IMAGE_REGEX,
  installsPhpExtension,
  isProductionComposeFile,
  isRuntimeSourcePath,
  isWorkerServiceCommand,
  LANGUAGE_SOURCE_REGEX,
  NON_APP_DOCKERFILE_DIR_REGEX,
  listDockerfileCandidates,
  listProductionComposeFiles,
  parseComposeServices,
  productionStageText,
  selectedDockerfile,
  WORKER_SERVICE_NAME_REGEX,
} from './detectors.js';
import type { RedisRequirement } from './redis.js';
import { assessRedis } from './redis.js';

/**
 * The §10 database rejection tokens — a rejection with one of these
 * dependencies is an UNSUPPORTED DATABASE (drives `databaseState`), as
 * opposed to an unsupported architecture/cache/cloud (§11.4) which drives the
 * verdict through the architecture findings instead.
 */
export const DATABASE_REJECTION_TOKENS = new Set<string>([
  'mysql',
  'mysql2',
  'mariadb',
  'mongoose',
  'mongodb',
  'mongodb-client',
  '@elastic/elasticsearch',
  '@opensearch-project/opensearch',
  'cassandra-driver',
  'neo4j-driver',
  'sqlite',
  'clickhouse',
  'h2',
]);

// ── Types ───────────────────────────────────────────────────────────────────

/** Result from a single rejection check. */
export interface RejectionFinding {
  /** Whether the unsupported dependency was detected. */
  detected: boolean;
  /** The specific dependency that triggered the rejection. */
  dependency: string;
  /** Human-readable reason for the rejection. */
  reason: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Check if a Prisma schema uses a specific provider. */
function prismaUsesProvider(tree: FileTree, provider: string): boolean {
  const content = Object.entries(tree).find(([p]) => /schema\.prisma$/i.test(p))?.[1];
  if (!content) return false;
  const regex = new RegExp(`provider\\s*=\\s*"${provider}"`, 'i');
  return regex.test(content);
}

// ── Rejection checks ────────────────────────────────────────────────────────

/**
 * Redis: standard, standalone Redis usage is a SUPPORTED managed dependency
 * (see `assessRedis` in ./redis.ts) and never rejects. Only Redis setups that
 * fall outside Deployz's managed profile — Redis Stack modules, cluster mode,
 * TLS (`rediss://`) — reject.
 *
 * `precomputed` lets `analyseRepo` share a single `assessRedis(tree)` call
 * with the `redis` detector finding and `buildMetadata`, instead of every
 * consumer re-running the (more expensive) full assessment. Direct callers
 * (e.g. tests) can simply omit it.
 */
export function checkRedisUnsupported(tree: FileTree, precomputed?: RedisRequirement): RejectionFinding {
  const assessment = precomputed ?? assessRedis(tree);
  const detected = assessment.evidence.length > 0 && !assessment.compatibility.supported;
  return {
    detected,
    dependency: 'redis-unsupported',
    reason: detected
      ? (assessment.compatibility.reason ?? 'Unsupported Redis configuration detected.')
      : 'No unsupported Redis configuration detected',
  };
}

/** MySQL: mysql2, mysql, @prisma/client with mysql provider */
const MYSQL_DEPS = ['mysql2', 'mysql'] as const;
// MySQL/MariaDB drivers in Python, Go, Ruby, JVM and Elixir manifests, and a
// Laravel database config whose default connection is MySQL (Stage A COMP-037).
const MYSQL_LANGUAGE_TOKENS = [
  'mysqlclient',
  'PyMySQL',
  'pymysql',
  'mysql-connector-python',
  'aiomysql',
  'github.com/go-sql-driver/mysql',
  // GORM's MySQL driver; it pulls go-sql-driver/mysql in as an `// indirect` module.
  'gorm.io/driver/mysql',
  'mysql-connector-j',
  'mysql-connector-java',
  'r2dbc-mysql',
  'asyncmy',
  'ext-pdo_mysql',
  'ext-mysqli',
] as const;
const PHP_MYSQL_EXTENSIONS = ['pdo_mysql', 'mysqli'] as const;
// Configuration that names MySQL as the engine: a SQLAlchemy/Go/PHP connection
// URL in source, a Django `ENGINE`, a Spring datasource URL, or the dialect of
// a config-driven JS ORM (Sequelize `dialect`, Knex `client`, Drizzle import).
const MYSQL_URL_REGEX = /mysql(?:\+\w+)?:\/\//;
const DJANGO_MYSQL_ENGINE_REGEX = /['"]ENGINE['"]\s*:\s*['"]django\.db\.backends\.mysql['"]/;
const SPRING_CONFIG_REGEX = /(?:^|\/)application(?:-[\w.]+)?\.(?:properties|ya?ml)$/;
const SPRING_MYSQL_URL_REGEX = /jdbc:mysql:/;
const JS_SOURCE_REGEX = /\.(?:ts|js|mjs|cjs|tsx|jsx)$/;
const MYSQL_ORM_DIALECT_REGEX = /\b(?:dialect|client)\s*:\s*['"]mysql2?['"]|drizzle-orm\/mysql(?:2|-core)/;
// The production JSON config of an nconf or node-config app (Ghost `config.production.json`: `"client": "mysql"`).
const PRODUCTION_JSON_CONFIG_REGEX = /(?:^|\/)config(?:\/env)?\/(?:config\.)?production\.json$/;
const JSON_MYSQL_CLIENT_REGEX = /"(?:client|dialect)"\s*:\s*"mysql2?"/;
// MariaDB-specific drivers speak a dialect Deployz does NOT host (RDS MySQL
// only) — a lone MariaDB driver stays a rejection (Phase 4B).
const MARIA_LANGUAGE_TOKENS = ['mariadb-java-client', 'myxql'] as const;
const LARAVEL_MYSQL_DEFAULT_REGEX = /env\(\s*['"]DB_CONNECTION['"]\s*,\s*['"]mysql['"]\s*\)/;
const LARAVEL_MARIA_DEFAULT_REGEX = /env\(\s*['"]DB_CONNECTION['"]\s*,\s*['"]mariadb['"]\s*\)/;
const LARAVEL_MYSQL_ENV_REGEX = /^DB_CONNECTION\s*=\s*mysql\s*$/m;
const LARAVEL_MARIA_ENV_REGEX = /^DB_CONNECTION\s*=\s*mariadb\s*$/m;

/**
 * A SQL-engine driver next to a PostgreSQL driver means the engine is a
 * configuration choice (kutt's `DB_CLIENT`, gatus' storage type), not an
 * architectural requirement — the app runs on the PostgreSQL Deployz
 * provisions. Only a lone driver, or an explicit non-PostgreSQL Prisma
 * provider / connection URL, proves the unsupported engine is the one in
 * use (Stage A COMP-002).
 */
function engineIsConfigurable(tree: FileTree): boolean {
  // Only a PostgreSQL-specific driver counts: `knex`/`drizzle-orm` are
  // dialect-agnostic and prove nothing about which engine is wired up.
  const drivers = detectPostgresql(tree).value;
  return Array.isArray(drivers) && drivers.some((driver) => !DIALECT_AGNOSTIC_DRIVERS.has(driver));
}

/** Required-vs-present evidence for MySQL: mirrors `PostgresRequirement`. */
export interface MySqlRequirement {
  required: boolean;
  /** A MySQL driver is declared (and PostgreSQL is not the engine in use). */
  detected: boolean;
  evidence: string[];
  /**
   * `mysql+pymysql` when a SQLAlchemy app declares PyMySQL and not
   * mysqlclient: SQLAlchemy reads a plain `mysql://` URL as MySQLdb
   * (mysqlclient), which the image does not have. Absent otherwise.
   */
  urlScheme?: 'mysql+pymysql';
}

const MYSQL_CONNECTION_ENV_VARS = ['MYSQL_URL', 'MYSQL_URI', 'MYSQL_HOST', 'MYSQL_DATABASE', 'MYSQL_USER'] as const;

/**
 * Assess whether a repository's MySQL usage is a real database requirement
 * (Phase 4B — RDS MySQL is a supported managed database). Mirrors
 * `assessPostgres`: `required` is true only when a MySQL driver AND at least
 * one independent signal (a Prisma mysql provider, a `mysql://` connection
 * URL, a MYSQL_* connection variable, a MySQL/MariaDB image in a production
 * Compose file, or a Laravel `DB_CONNECTION=mysql` default) are both
 * present, and PostgreSQL is not the engine actually wired up. A bare
 * driver — or a dev-only dependency — is not a database; it deploys without
 * one and raises the connection-binding question instead.
 */
export function assessMysql(tree: FileTree): MySqlRequirement {
  const evidence: string[] = [];
  const deps = collectDependencyNames(tree);

  let hasDependency = false;
  let hasIndependentEvidence = false;

  for (const dep of MYSQL_DEPS) {
    if (deps.includes(dep)) {
      hasDependency = true;
      evidence.push(`${dep} dependency in package.json`);
    }
  }
  // A MariaDB-only driver is evidence of an UNSUPPORTED dialect, never of
  // the supported MySQL engine.
  if (!hasDependency) {
    for (const token of MYSQL_LANGUAGE_TOKENS) {
      // A `// indirect` go.mod line is a transitive module (beszel: PocketBase's dbx), not the app's engine.
      if (findDependencyEvidence(tree, token, true).some(isRuntimeSourcePath)) {
        hasDependency = true;
        evidence.push(`${token} declared`);
        break;
      }
    }
  }
  // Prisma schema declaring a mysql provider — its own dependency AND
  // independent signal (a Prisma mysql app needs a MySQL server).
  if (deps.includes('@prisma/client') && prismaUsesProvider(tree, 'mysql')) {
    hasDependency = true;
    hasIndependentEvidence = true;
    evidence.push('provider = "mysql" in the Prisma schema');
  }
  // A Laravel config whose default connection is MySQL. Laravel ships its
  // MySQL support in the framework, so the config is the dependency too.
  const laravel = Object.entries(tree).find(
    ([path, content]) =>
      !!content &&
      isRuntimeSourcePath(path) &&
      ((/(?:^|\/)config\/database\.php$/.test(path) && LARAVEL_MYSQL_DEFAULT_REGEX.test(content)) ||
        (/(?:^|\/)\.env\.(?:example|sample|template)$/i.test(path) && LARAVEL_MYSQL_ENV_REGEX.test(content))),
  );
  if (laravel) {
    hasDependency = true;
    hasIndependentEvidence = true;
    evidence.push(`${laravel[0]} sets DB_CONNECTION to mysql`);
  }
  // An image that installs the PHP MySQL extension, or a Django, Spring or
  // JS ORM configuration naming MySQL, is both the driver and the engine.
  if (installsPhpExtension(tree, PHP_MYSQL_EXTENSIONS)) {
    hasDependency = true;
    hasIndependentEvidence = true;
    evidence.push('a Dockerfile installs the PHP MySQL extension');
  }
  for (const [path, content] of Object.entries(tree)) {
    if (!content || !isRuntimeSourcePath(path)) continue;
    const named =
      (path.endsWith('.py') && DJANGO_MYSQL_ENGINE_REGEX.test(content)) ||
      (SPRING_CONFIG_REGEX.test(path) && SPRING_MYSQL_URL_REGEX.test(content)) ||
      (JS_SOURCE_REGEX.test(path) && MYSQL_ORM_DIALECT_REGEX.test(content)) ||
      (PRODUCTION_JSON_CONFIG_REGEX.test(path) && JSON_MYSQL_CLIENT_REGEX.test(content));
    if (named) {
      hasDependency = true;
      hasIndependentEvidence = true;
      evidence.push(`${path} configures MySQL as the database engine`);
    }
  }
  if (!hasDependency) return { required: false, detected: false, evidence: [] };
  if (engineIsConfigurable(tree)) {
    // A PostgreSQL-specific driver is declared: PostgreSQL is the engine in
    // use and the MySQL dependency stays quiet (Stage A COMP-002).
    return { required: false, detected: false, evidence: [] };
  }

  // A mysql:// connection URL (`mysql+pymysql://` for SQLAlchemy) referenced
  // in an env file, docker-compose, or source (runtime paths only — the same
  // boundary assessPostgres draws).
  for (const [path, content] of Object.entries(tree)) {
    if (!content || !isRuntimeSourcePath(path)) continue;
    if (
      /(?:^|\/)\.env(\.\w+)?$/i.test(path) ||
      /(?:^|\/)(?:docker-)?compose(?:\.[\w.-]+)?\.ya?ml$/i.test(path) ||
      LANGUAGE_SOURCE_REGEX.test(path) ||
      JS_SOURCE_REGEX.test(path)
    ) {
      if (/mariadb:\/\//.test(content) === false && MYSQL_URL_REGEX.test(content)) {
        hasIndependentEvidence = true;
        evidence.push(`a mysql:// connection URL in ${path}`);
        break;
      }
    }
  }

  // Known MYSQL_* connection variables referenced the same ways.
  for (const name of MYSQL_CONNECTION_ENV_VARS) {
    const envFileRegex = new RegExp(`^${name}\\s*[=:]`, 'm');
    const composeRegex = new RegExp(`\\b${name}\\s*[=:]`);
    const processEnvRegex = new RegExp(`process\\.env\\.${name}\\b`);
    const literalRegex = new RegExp(`["']${name}["']`);
    for (const [path, content] of Object.entries(tree)) {
      if (!content) continue;
      if (/^\.env(\.\w+)?$/i.test(path) && envFileRegex.test(content)) {
        hasIndependentEvidence = true;
        evidence.push(`${name} referenced in ${path}`);
      } else if (/^docker-compose\.ya?ml$/i.test(path) && composeRegex.test(content)) {
        hasIndependentEvidence = true;
        evidence.push(`${name} referenced in ${path}`);
      } else if (/\.(ts|js|mjs|cjs|jsx|tsx)$/.test(path) && processEnvRegex.test(content)) {
        hasIndependentEvidence = true;
        evidence.push(`process.env.${name} referenced in ${path}`);
      } else if (LANGUAGE_SOURCE_REGEX.test(path) && isRuntimeSourcePath(path) && literalRegex.test(content)) {
        hasIndependentEvidence = true;
        evidence.push(`${name} referenced in ${path}`);
      }
    }
  }

  // A mysql/mariadb image in any production Compose file — the app expects
  // to host its own MySQL-protocol database.
  for (const path of Object.keys(tree)) {
    if (!/(?:^|\/)(?:docker-)?compose(?:\.[\w.-]+)?\.ya?ml$/i.test(path) || !isProductionComposeFile(path)) continue;
    const dcContent = tree[path];
    if (!dcContent) continue;
    if (/image:\s*['"]?[^\s'"]*(?:mysql|mariadb)/i.test(dcContent)) {
      hasIndependentEvidence = true;
      evidence.push(`a MySQL/MariaDB image in the production Compose file (${path})`);
      break;
    }
  }

  return {
    required: hasDependency && hasIndependentEvidence,
    detected: true,
    evidence: [...new Set(evidence)],
    ...(declaresAny(tree, ['PyMySQL', 'pymysql']) &&
    declaresAny(tree, ['SQLAlchemy', 'sqlalchemy', 'Flask-SQLAlchemy', 'flask-sqlalchemy']) &&
    !declaresAny(tree, ['mysqlclient'])
      ? { urlScheme: 'mysql+pymysql' as const }
      : {}),
  };
}

function declaresAny(tree: FileTree, tokens: readonly string[]): boolean {
  return tokens.some((token) => findDependencyEvidence(tree, token).some(isRuntimeSourcePath));
}

/**
 * MariaDB-only setups (a MariaDB-specific driver, or a Laravel default of
 * `mariadb`) are the part of the old MySQL rejection that STAYS unsupported —
 * Deployz hosts RDS MySQL and PostgreSQL only (Phase 4B).
 */
export function checkMysql(tree: FileTree): RejectionFinding {
  for (const token of MARIA_LANGUAGE_TOKENS) {
    const evidence = findDependencyEvidence(tree, token).filter(isRuntimeSourcePath);
    // A MySQL driver next to the MariaDB one makes MariaDB an option, not the requirement.
    if (evidence.length > 0 && !engineIsConfigurable(tree) && !assessMysql(tree).detected) {
      return {
        detected: true,
        dependency: 'mariadb',
        reason: `Unsupported database dependency: ${token}. Deployz supports PostgreSQL and MySQL, not MariaDB.`,
      };
    }
  }

  if (!engineIsConfigurable(tree) && !assessMysql(tree).detected) {
    const laravel = Object.entries(tree).find(
      ([path, content]) =>
        !!content &&
        isRuntimeSourcePath(path) &&
        ((/(?:^|\/)config\/database\.php$/.test(path) && LARAVEL_MARIA_DEFAULT_REGEX.test(content)) ||
          (/(?:^|\/)\.env\.(?:example|sample|template)$/i.test(path) && LARAVEL_MARIA_ENV_REGEX.test(content))),
    );
    if (laravel) {
      return {
        detected: true,
        dependency: 'mariadb',
        reason: `Unsupported database: ${laravel[0]} sets DB_CONNECTION to MariaDB. Deployz supports PostgreSQL and MySQL.`,
      };
    }
  }

  return { detected: false, dependency: 'none', reason: 'No unsupported MariaDB setup detected' };
}

/**
 * A database CLIENT dependency proves the app can talk to that database, not
 * that it stores its own data there — an automation platform, a secrets
 * manager or a BI tool ships the MongoDB, Elasticsearch and Cassandra
 * clients it connects customers' databases with. The rejection needs the
 * same corroboration a broker client needs (Stage A COMP-002, COMP-032):
 * a service running that database in the production Compose file (by its image
 * or its name: `couchdb-service` runs `budibase/database`), a
 * connection variable the app reads without a fallback, or (MongoDB) the
 * app's own data model on it.
 */
function databaseCorroboration(
  tree: FileTree,
  imageRegex: RegExp,
  envRegex: RegExp,
  modelRegex: RegExp | null,
): string | null {
  const compose = composeServices(tree);
  const service = compose?.services.find((s) => !s.optional && ((s.image && imageRegex.test(s.image)) || imageRegex.test(s.name)));
  if (compose && service) return `a ${service.name} service is defined in ${compose.file}`;
  const key = brokerConnectionRequired(tree, envRegex);
  if (key) return `${key} is required`;
  // A production image that sets the connection itself (Rocket.Chat `ENV MONGO_URL=mongodb://mongo:27017/rocketchat`),
  // not an image of the database (cognee's `Dockerfile.neo4j-custom`) or a trailing dev all-in-one stage (twenty).
  for (const path of listDockerfileCandidates(tree).filter((candidate) => isRuntimeSourcePath(candidate) && !imageRegex.test(candidate))) {
    for (const [, line] of productionStageText((tree[path] ?? '').replace(/\\\r?\n/g, ' ')).matchAll(/^\s*ENV\s+(.+)$/gim)) {
      const name = [...line!.matchAll(/(?:^|\s)(\w+)=["']?[^\s"'$]/g)].map((match) => match[1]!).find((variable) => envRegex.test(variable));
      if (name) return `${path} sets ${name}`;
    }
  }
  if (modelRegex) {
    const model = Object.entries(tree).find(
      ([path, content]) => /\.(?:ts|js|mjs|cjs)$/.test(path) && isRuntimeSourcePath(path) && !!content && modelRegex.test(content),
    );
    if (model) return `the app defines its data model on it in ${model[0]}`;
  }
  return null;
}

/** MongoDB: mongoose, mongodb, mongodb-client */
const MONGO_DEPS = ['mongoose', 'mongodb', 'mongodb-client'] as const;
const MONGO_ENV_REGEX = /^MONGO(?:DB)?_(?:URI|URL|HOST|CONNECTION_STRING)$/;
const MONGOOSE_MODEL_REGEX = /mongoose\.model\s*\(|new\s+(?:mongoose\.)?Schema\s*\(/;

/**
 * Check for a MongoDB dependency the app stores its data in (unsupported —
 * Deployz uses PostgreSQL only).
 */
export function checkMongo(tree: FileTree): RejectionFinding {
  const deps = collectDependencyNames(tree);
  for (const dep of MONGO_DEPS) {
    if (!deps.includes(dep)) continue;
    const prisma = Object.entries(tree).find(([p]) => /schema\.prisma$/i.test(p))?.[1];
    const corroboration =
      prisma && /provider\s*=\s*"mongodb"/i.test(prisma)
        ? 'Prisma is configured with the MongoDB provider'
        : databaseCorroboration(tree, /mongo/i, MONGO_ENV_REGEX, dep === 'mongoose' ? MONGOOSE_MODEL_REGEX : null);
    if (corroboration) {
      return {
        detected: true,
        dependency: dep,
        reason: `Unsupported database dependency: ${dep}, and ${corroboration}. Deployz does not support MongoDB. Use PostgreSQL.`,
      };
    }
  }
  return { detected: false, dependency: 'none', reason: 'No MongoDB dependency detected' };
}

/** Elasticsearch / OpenSearch: @elastic/elasticsearch, @opensearch-project/opensearch, and the Python clients. */
const ES_DEPS = ['@elastic/elasticsearch', '@opensearch-project/opensearch'] as const;
const ES_PYTHON_TOKENS = ['elasticsearch', 'elasticsearch-dsl', 'opensearch-py'] as const;
const PY_MANIFEST_REGEX = /(?:^|\/)(?:requirements[^/]*\.txt|Pipfile|pyproject\.toml|setup\.py)$/;
const ES_ENV_REGEX = /^(?:ELASTIC(?:SEARCH)?_(?:URL|URI|HOSTS?|NODE|NODES)|ES_(?:URL|HOSTS?|NODE)|OPENSEARCH_(?:URL|HOSTS?|NODE))$/;
// A build file that downloads the search server distribution (`elasticsearch-${version}-linux-x86_64.tar.gz`):
// the app packages the server and starts it next to itself (SonarQube).
const SEARCH_SERVER_ARCHIVE_REGEX = /\b(?:elasticsearch|opensearch)-(?:\$\{?[\w.]+\}?|\d)[\w.${}-]*\.(?:tar\.gz|tgz|zip)\b/i;
const BUILD_FILE_REGEX = /(?:^|\/)(?:build\.gradle(?:\.kts)?|pom\.xml|Makefile|Dockerfile[^/]*|[^/]+\.dockerfile|package\.json)$/i;

/**
 * Check for an Elasticsearch or OpenSearch dependency the app requires (unsupported).
 */
export function checkElasticsearch(tree: FileTree): RejectionFinding {
  for (const [path, content] of Object.entries(tree)) {
    if (!content || !BUILD_FILE_REGEX.test(path) || !isRuntimeSourcePath(path)) continue;
    const archive = SEARCH_SERVER_ARCHIVE_REGEX.exec(content)?.[0];
    if (archive) {
      return {
        detected: true,
        dependency: '@elastic/elasticsearch',
        reason: `Unsupported search engine: ${path} downloads the search server (${archive}), so the app runs Elasticsearch/OpenSearch next to itself with its index on local disk. Deployz does not support Elasticsearch/OpenSearch.`,
      };
    }
  }
  const deps = collectDependencyNames(tree);
  const python = ES_PYTHON_TOKENS.filter((token) => findDependencyEvidence(tree, token).some((path) => PY_MANIFEST_REGEX.test(path) && isRuntimeSourcePath(path)));
  for (const dep of [...ES_DEPS.filter((name) => deps.includes(name)), ...python]) {
    const corroboration = databaseCorroboration(tree, /elasticsearch|opensearch/i, ES_ENV_REGEX, null);
    if (corroboration) {
      return {
        detected: true,
        dependency: dep,
        reason: `Unsupported search engine: ${dep}, and ${corroboration}. Deployz does not support Elasticsearch/OpenSearch.`,
      };
    }
  }
  return {
    detected: false,
    dependency: 'none',
    reason: 'No Elasticsearch/OpenSearch dependency detected',
  };
}

/** Other unsupported databases: cassandra-driver, neo4j-driver, the CouchDB client nano */
const OTHER_UNSUPPORTED_DB_DEPS = ['cassandra-driver', 'neo4j-driver', 'nano', '@budibase/nano'] as const;
const OTHER_UNSUPPORTED_DB_PYTHON_TOKENS = ['neo4j', 'cassandra-driver'] as const;
const OTHER_DB_ENV_REGEX = /^(?:CASSANDRA_(?:HOSTS?|CONTACT_POINTS|URL)|NEO4J_(?:URI|URL|HOST)|COUCH_?DB_(?:URL|URI|HOST))$/;
const CLICKHOUSE_TOKENS = [
  '@clickhouse/client',
  'clickhouse-driver',
  'clickhouse-connect',
  'ecto_ch',
  'clickhousex',
  'pillar',
  'github.com/ClickHouse/clickhouse-go',
  'clickhouse-jdbc',
] as const;
const CLICKHOUSE_ECTO_ADAPTERS: readonly string[] = ['ecto_ch', 'clickhousex'];
const CLICKHOUSE_ENV_REGEX = /^CLICKHOUSE_(?:URL|HOST|DATABASE_URL|DB_URL)$/;
// ParadeDB, TimescaleDB and Citus images ship PostgreSQL extensions that Amazon RDS does not offer.
const POSTGRES_EXTENSION_IMAGE_REGEX = /^(?:[\w.-]+(?::\d+)?\/)*(?:paradedb\/|timescale\/timescaledb|citusdata\/citus)/i;
const EMBEDDED_JVM_DB_TOKENS = ['com.h2database', 'org.hsqldb', 'org.apache.derby'] as const;

/**
 * Check for other unsupported database drivers (Cassandra, Neo4j, etc.) the app requires.
 */
export function checkOtherUnsupportedDatabases(tree: FileTree): RejectionFinding {
  const deps = collectDependencyNames(tree);
  const python = OTHER_UNSUPPORTED_DB_PYTHON_TOKENS.filter((token) =>
    findDependencyEvidence(tree, token).some((path) => PY_MANIFEST_REGEX.test(path) && isRuntimeSourcePath(path)),
  );
  for (const dep of [...OTHER_UNSUPPORTED_DB_DEPS.filter((name) => deps.includes(name)), ...python]) {
    const corroboration = databaseCorroboration(tree, /cassandra|scylla|neo4j|couchdb/i, OTHER_DB_ENV_REGEX, null);
    if (corroboration) {
      return {
        detected: true,
        dependency: dep,
        reason: `Unsupported database driver: ${dep}, and ${corroboration}. Deployz does not support this database.`,
      };
    }
  }
  // ClickHouse clients in any manifest, with the same corroboration; an
  // embedded JVM database (H2, HSQLDB, Derby) with no PostgreSQL driver next
  // to it is the app's only database (Stage A COMP-037). An Ecto adapter is no
  // client for someone else's database: it makes ClickHouse an Ecto repo of the app.
  for (const token of CLICKHOUSE_TOKENS) {
    if (findDependencyEvidence(tree, token).filter(isRuntimeSourcePath).length === 0) continue;
    const corroboration = CLICKHOUSE_ECTO_ADAPTERS.includes(token)
      ? `the app's Ecto repo runs on ClickHouse through ${token}`
      : databaseCorroboration(tree, /clickhouse/i, CLICKHOUSE_ENV_REGEX, null);
    if (corroboration) {
      return {
        detected: true,
        dependency: 'clickhouse',
        reason: `Unsupported database driver: ${token}, and ${corroboration}. Deployz does not support ClickHouse.`,
      };
    }
  }
  const stackFile = listProductionComposeFiles(tree)[0];
  if (stackFile !== undefined && !isPublishedImageSample(tree, stackFile)) {
    const image = [...(tree[stackFile] ?? '').matchAll(/^\s*image:\s*["']?([^\s"'#]+)/gm)]
      .map((match) => match[1] ?? '')
      .find((name) => POSTGRES_EXTENSION_IMAGE_REGEX.test(name));
    if (image) {
      return {
        detected: true,
        dependency: 'other-database',
        reason: `Unsupported database: the production Compose file ${stackFile} runs ${image}. The app needs a PostgreSQL extension that managed PostgreSQL (Amazon RDS) does not provide.`,
      };
    }
  }
  if (!engineIsConfigurable(tree) && !assessMysql(tree).required) {
    for (const token of EMBEDDED_JVM_DB_TOKENS) {
      const evidence = findDependencyEvidence(tree, token).filter(isRuntimeSourcePath);
      if (evidence.length > 0) {
        return {
          detected: true,
          dependency: 'h2',
          reason: `Unsupported database: the embedded JVM database ${token} is declared in ${evidence[0]} with no PostgreSQL or MySQL driver. Deployz hosts PostgreSQL and MySQL only.`,
        };
      }
    }
  }
  return {
    detected: false,
    dependency: 'none',
    reason: 'No unsupported database driver detected',
  };
}

/** The newest major version of each engine that Deployz provides (RDS PostgreSQL 16, RDS MySQL 8.0). */
const PROVIDED_DATABASE_VERSIONS = { PostgreSQL: 16, MySQL: 8 } as const;
const DEPENDENCY_MANIFEST_REGEX =
  /(?:^|\/)(?:package\.json|requirements[^/]*|Pipfile|pyproject\.toml|setup\.(?:py|cfg)|composer\.json|Gemfile|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|Cargo\.toml|mix\.exs|[^/]+\.csproj)$/i;
// A statement of the minimum server version: `Requires >= 17`, `PostgreSQL 17 or later required`, `MySQL 8.4+`.
const MINIMUM_VERSION_REGEX = /(?:>=|≥|\bat least|\bminimum(?: version)?(?: is)?)\s*v?(\d+)(?:\.\d+)?\b|\b(\d+)(?:\.\d+)?\s*(?:\+|or (?:later|newer|higher|above)\b)/i;
/** Application source code: where the app checks the server version it connects to. */
const APP_SOURCE_REGEX = /\.(?:[cm]?[jt]sx?|go|py|rb|php|cs|java|kt|scala|ex|exs|rs)$/i;
const COMMENT_LINE_REGEX = /^\s*(?:#|\/\/|\/?\*|--|<!--)/;
// The line states a requirement, not a note (`Requires >= 17`, `is too old`, `not supported`).
const REQUIREMENT_WORD_REGEX = /\brequire|\bneeds?\b|\bminimum\b|\bat least\b|too old|not supported|unsupported/i;

/**
 * The app states in its source code that it needs a newer PostgreSQL or MySQL major version
 * than Deployz provides (Wiki.js 3 exits with "Requires >= 17" on PostgreSQL 16). A comment,
 * a configuration sample, a Compose file, a Dockerfile and a document only describe a setup.
 */
export function checkDatabaseVersion(tree: FileTree): RejectionFinding {
  for (const [path, content] of Object.entries(tree)) {
    if (!content || !APP_SOURCE_REGEX.test(path) || !isRuntimeSourcePath(path) || DEPENDENCY_MANIFEST_REGEX.test(path)) continue;
    for (const line of content.split('\n')) {
      if (line.length > 400 || COMMENT_LINE_REGEX.test(line) || !REQUIREMENT_WORD_REGEX.test(line)) continue;
      const engine = /postgre(?:s|sql)/i.test(line) ? 'PostgreSQL' : /\bmysql\b/i.test(line) ? 'MySQL' : null;
      if (engine === null) continue;
      const match = MINIMUM_VERSION_REGEX.exec(line);
      const minimum = Number(match?.[1] ?? match?.[2]);
      if (minimum > PROVIDED_DATABASE_VERSIONS[engine] && minimum < 100) {
        return {
          detected: true,
          dependency: 'database-version',
          reason: `Unsupported database version: the app needs ${engine} ${minimum} or later (${path}: "${line.trim().slice(0, 160)}"), and Deployz provides ${engine} ${PROVIDED_DATABASE_VERSIONS[engine]}.`,
        };
      }
    }
  }
  return { detected: false, dependency: 'none', reason: 'No database version requirement above the provided versions' };
}

// ── §11.4 architecture rejection checks ─────────────────────────────────────
// Each check detects one class of infrastructure Deployz does NOT host or
// manage. Every check is deliberately narrow (files/dependencies that can
// ONLY mean that infrastructure), so a passing repository is never blocked by
// a README mention or a dev-only helper.

// Deployment descriptors and IaC count only where the app itself lives: a
// Pulumi program under `benchmarks/`, a Terraform module under `examples/`
// or a template in a test fixture is not the app's deployment (Stage A
// COMP-036, the same runtime-path rule as COMP-003/COMP-016).
function filePathsMatching(tree: FileTree, pathRegex: RegExp): string[] {
  return Object.keys(tree).filter((p) => pathRegex.test(p) && isRuntimeSourcePath(p));
}

function contentMatches(tree: FileTree, pathRegex: RegExp, contentRegex: RegExp): string[] {
  return Object.keys(tree).filter((p) => pathRegex.test(p) && isRuntimeSourcePath(p) && !!tree[p] && contentRegex.test(tree[p]));
}

/** The tree without its non-runtime paths, for dependency-based checks. */
function runtimeTree(tree: FileTree): FileTree {
  return Object.fromEntries(Object.entries(tree).filter(([path]) => isRuntimeSourcePath(path)));
}

// Helm charts, Kubernetes manifests, Terraform and the like in a deployment
// or sample directory are options for self-hosters. They do not run beside
// the app, so they warn and never block (docs and example directories are
// already outside `isRuntimeSourcePath`). A prefixed name is one too (sqlpad `sqlpad-charts/`).
const DEPLOYMENT_SAMPLE_DIR_REGEX =
  /(?:^|\/)(?:(?:[\w.]+[-_])?(?:charts?|helm|k8s|kube|kubernetes|deploy|deployments?|infra|infrastructure|terraform|contrib|install|dogfood|scaletest)|[\w.-]+-docker)(?:\/|$)/i;

function outsideDeploymentSamples(paths: string[]): string[] {
  return paths.filter((path) => !DEPLOYMENT_SAMPLE_DIR_REGEX.test(path));
}

/**
 * A Compose file in a deployment or sample directory that runs the application
 * from a published image (every application service pulls one; infrastructure
 * and profile-gated services may be built locally), next to a Dockerfile
 * Deployz can build, is a self-hoster option, not the stack Deployz builds
 * from the repository. Its services are no evidence of what the application
 * needs: only the source (a client, a required connection variable) is.
 */
function isPublishedImageSample(tree: FileTree, file: string): boolean {
  const apps = parseComposeServices(tree[file] ?? '').filter(
    (service) =>
      !service.optional &&
      !(service.image !== null && (INFRA_COMPOSE_IMAGE_REGEX.test(service.image) || POSTGRES_EXTENSION_IMAGE_REGEX.test(service.image))),
  );
  return DEPLOYMENT_SAMPLE_DIR_REGEX.test(file) && selectedDockerfile(tree) !== null && apps.length > 0 && apps.every((service) => service.build === null);
}

/** A Go module that talks to the Kubernetes API is a cluster platform: its manifests are its runtime. */
function usesKubernetesClient(tree: FileTree): boolean {
  return contentMatches(tree, /(?:^|\/)go\.mod$/, /^\s*(?:k8s\.io\/client-go|sigs\.k8s\.io\/controller-runtime)\s/m).length > 0;
}

function kubernetesFiles(tree: FileTree): string[] {
  return [
    ...filePathsMatching(tree, /(?:^|\/)kustomization\.ya?ml$/i),
    ...filePathsMatching(tree, /(?:^|\/)Chart\.ya?ml$|(?:^|\/)helmfile\.ya?ml$/i),
    ...contentMatches(tree, /\.ya?ml$/, /^apiVersion:\s*apps\/v1\s*$[\s\S]*?^kind:\s*Deployment\s*$/m),
  ];
}

// Terraform of a CI or tooling directory sets up test infrastructure, not the app (Vault `enos/ci/`).
const IAC_TOOLING_DIR_REGEX = /(?:^|\/)(?:\.?ci|\.circleci|hack)\//i;
const TERRAFORM_MODULE_DIR_REGEX = /(?:^|\/)modules\//;

function terraformFiles(tree: FileTree): string[] {
  const files = filePathsMatching(tree, /\.tf$/)
    .concat(filePathsMatching(tree, /(?:^|\/)(?:\.terraform(?:\.lock)?\.hcl|terraform\.tfstate(?:\.backup)?|\.terraform\/)/))
    .filter((path) => !IAC_TOOLING_DIR_REGEX.test(path));
  // Modules with no root configuration that uses them are a module library, not a deployment.
  return files.some((path) => !TERRAFORM_MODULE_DIR_REGEX.test(path)) ? files : [];
}

function pulumiConfigFiles(tree: FileTree): string[] {
  return filePathsMatching(tree, /(?:^|\/)Pulumi(?:\.\w+)?\.ya?ml$/);
}

/** Deployment files the checks ignore because they sit in a deployment or sample directory; shown as a warning. */
export function listIgnoredDeploymentFiles(tree: FileTree): string[] {
  const kubernetes = checkKubernetes(tree).detected ? [] : kubernetesFiles(tree);
  const ignored = [...kubernetes, ...terraformFiles(tree), ...pulumiConfigFiles(tree)].filter((path) =>
    DEPLOYMENT_SAMPLE_DIR_REGEX.test(path),
  );
  return [...new Set(ignored)];
}

const PHP_SQLITE_OPEN_REGEX = /\bnew\s+\\?SQLite3\s*\(|\bnew\s+\\?PDO(?:\\Sqlite)?\s*\(\s*['"]sqlite:(?!:memory:)/;
// PHP code that also connects to MySQL or PostgreSQL: SQLite is one engine of several (Adminer's drivers).
const PHP_OTHER_SQL_REGEX = /\bnew\s+\\?mysqli\s*\(|\bmysqli_connect\s*\(|\bpg_connect\s*\(|['"](?:mysql|pgsql):/;

/** Production SQLite (embedded file DB): Node drivers, Prisma provider, Go driver, PHP SQLite files, sqlite:// URLs. */
export function checkSqlite(tree: FileTree): RejectionFinding {
  const deps = collectDependencyNames(tree);
  const configurable = engineIsConfigurable(tree);
  for (const dep of ['better-sqlite3', 'sqlite3'] as const) {
    if (deps.includes(dep) && !configurable) {
      return {
        detected: true,
        dependency: 'sqlite',
        reason: `Unsupported database: SQLite driver ${dep}. Deployz hosts PostgreSQL and MySQL only; an embedded file database does not survive in the container model.`,
      };
    }
  }
  const prisma = Object.entries(tree).find(([p]) => /schema\.prisma$/i.test(p))?.[1];
  if (prisma && /provider\s*=\s*"sqlite"/i.test(prisma)) {
    return {
      detected: true,
      dependency: 'sqlite',
      reason: 'Unsupported database: Prisma configured with the SQLite provider. Deployz hosts PostgreSQL and MySQL only.',
    };
  }
  if (!configurable && contentMatches(tree, /(?:^|\/)go\.mod$/, /modernc\.org\/sqlite|mattn\/go-sqlite3/).length > 0) {
    return {
      detected: true,
      dependency: 'sqlite',
      reason: 'Unsupported database: a Go SQLite driver is declared in go.mod. Deployz hosts PostgreSQL and MySQL only.',
    };
  }
  // PHP code that opens a SQLite file itself (Wallos `new SQLite3($file)`, grocy
  // `new \PDO\Sqlite('sqlite:' . $path)`); an in-memory `sqlite::memory:` probe is no database.
  const phpSources = Object.entries(tree).filter(([path, content]) => /\.php$/.test(path) && isRuntimeSourcePath(path) && content);
  const phpSqlite =
    configurable || assessMysql(tree).detected || phpSources.some(([, content]) => PHP_OTHER_SQL_REGEX.test(content ?? ''))
      ? undefined
      : phpSources.find(([, content]) => PHP_SQLITE_OPEN_REGEX.test(content ?? ''))?.[0];
  if (phpSqlite) {
    return {
      detected: true,
      dependency: 'sqlite',
      reason: `Unsupported database: ${phpSqlite} opens a SQLite database file. Deployz hosts PostgreSQL and MySQL only.`,
    };
  }
  // A Rails `config/database.yml` whose only adapter is sqlite3 keeps the whole
  // database in a file under `storage/`; the Gemfile names no PostgreSQL gem
  // (`configurable`), so no setting moves it to the database Deployz hosts.
  if (!configurable) {
    for (const [path, content] of Object.entries(tree)) {
      if (!content || !/(?:^|\/)config\/database\.yml$/.test(path)) continue;
      if (/^\s*adapter:\s*["']?sqlite3\b/m.test(content) && !/^\s*adapter:\s*["']?(?!sqlite3)\w/m.test(content)) {
        return {
          detected: true,
          dependency: 'sqlite',
          reason: `Unsupported database: ${path} configures only the sqlite3 adapter. Deployz hosts PostgreSQL and MySQL only.`,
        };
      }
    }
  }
  // A SQLite connection URL next to a PostgreSQL driver is the default of a
  // configurable engine (wallabag's `DATABASE_URL=sqlite://…` sample).
  for (const [path, content] of Object.entries(tree)) {
    if (!configurable && content && /sqlite3?:\/\/|\.db\s*=|\.sqlite\b/.test(content)) {
      const envPath = /^\.env(\.\w+)?$/i.test(path);
      const codePath = /\.(py|rb|ts|js|go)$/.test(path);
      if ((envPath || codePath) && /DATABASE_URL\s*[=:]\s*["']?sqlite/.test(content)) {
        return {
          detected: true,
          dependency: 'sqlite',
          reason: `Unsupported database: a SQLite database URL is configured in ${path}. Deployz hosts PostgreSQL and MySQL only.`,
        };
      }
    }
  }
  // The image sets the path of its SQLite file (`ENV SQLITE_DATABASE=/app/data/app.sqlite3`) and the app has no
  // PostgreSQL driver; with one, the engine selector decides (Directus `DB_CLIENT`).
  const dockerfile = selectedDockerfile(tree);
  const sqliteFile = dockerfile && !configurable && !detectPostgresql(tree).detected ?/^\s*ENV\s[^\n]*?(\/[\w./-]+\.sqlite3?)\b/im.exec(productionStageText(dockerfile.content))?.[1] : undefined;
  if (dockerfile && sqliteFile) {
    return {
      detected: true,
      dependency: 'sqlite',
      reason: `Unsupported database: ${dockerfile.path} keeps a SQLite database at ${sqliteFile}. Deployz hosts PostgreSQL and MySQL only.`,
    };
  }
  return { detected: false, dependency: 'none', reason: 'No SQLite database detected' };
}

/**
 * A message-broker client dependency proves the app CAN talk to a broker,
 * not that it needs one — umami ships kafkajs behind `KAFKA_URL`, uptime-kuma
 * ships it as a monitor target. The rejection needs corroboration: a broker
 * service in the production Compose file, or a connection variable the app
 * reads without a fallback (Stage A COMP-002).
 */
function brokerConnectionRequired(tree: FileTree, keyPattern: RegExp): string | null {
  const required = detectEnvVarModel(tree).filter((variable) => variable.required && keyPattern.test(variable.key));
  // A presence test (`if (process.env.KAFKA_URL)`, `Boolean(process.env.
  // KAFKA_URL && …)`, `enabled = process.env.KAFKA_URL && …`) makes the
  // broker a feature the app switches on, whatever the reads inside the
  // enabled path look like — but only when EVERY file that reads the
  // variable tests it; an unconditional consumer elsewhere still requires it.
  return required.find((variable) => !readsArePresenceGuarded(tree, variable.key, variable.source))?.key ?? null;
}

function readsArePresenceGuarded(tree: FileTree, key: string, source: readonly string[]): boolean {
  const read = `(?:process\\.env\\.|env\\.|os\\.environ\\.get\\(["'])?${key}\\b`;
  const guard = new RegExp(`if\\s*\\(\\s*!?\\s*${read}|(?:Boolean\\s*\\(|!!)\\s*${read}|${read}\\s*&&|&&\\s*${read}`);
  const readFiles = source.filter((entry) => entry.startsWith('read in ')).map((entry) => entry.slice('read in '.length));
  return readFiles.length > 0 && readFiles.every((path) => guard.test(tree[path] ?? ''));
}

// Connection variables only — a tuning knob such as KAFKA_MAX_MESSAGE_BYTES
// says nothing about whether a broker must exist.
const KAFKA_ENV_REGEX = /^KAFKA_(?:URL|BROKERS?|BOOTSTRAP_SERVERS|HOSTS?)$/;
const RABBITMQ_ENV_REGEX = /^(?:RABBITMQ_(?:URL|HOST)|AMQP_URL|CLOUDAMQP_URL)$/;

/** The production Compose services, unless the file is a published-image sample (`isPublishedImageSample`). */
function stackComposeServices(tree: FileTree): ReturnType<typeof composeServices> {
  const compose = composeServices(tree);
  return compose && !isPublishedImageSample(tree, compose.file) ? compose : null;
}

/** Kafka: clients/consumers + Kafka/Confluent images in compose. */
export function checkKafka(tree: FileTree): RejectionFinding {
  const compose = stackComposeServices(tree);
  if (compose?.services.some((s) => !s.optional && s.image && /kafka|confluentinc/i.test(s.image))) {
    return { detected: true, dependency: 'kafka', reason: `Unsupported infrastructure: a Kafka service is defined in ${compose.file}.` };
  }

  let client: string | null = null;
  const deps = collectDependencyNames(tree);
  for (const dep of ['kafkajs', 'kafka-node', 'node-rdkafka'] as const) {
    if (deps.includes(dep)) client = `Kafka client ${dep}`;
  }
  for (const [path, content] of Object.entries(tree)) {
    if (!content || client) break;
    if (/(?:^|\/)requirements(?:[^/]*)\.txt$/.test(path) && /^confluent-kafka|^kafka-python|^aiokafka/m.test(content)) {
      client = `a Kafka client declared in ${path}`;
    } else if (/(?:^|\/)pyproject\.toml$/.test(path) && /(?:confluent-kafka|kafka-python|aiokafka)/.test(content)) {
      client = `a Kafka client declared in ${path}`;
    } else if (/(?:^|\/)go\.mod$/.test(path) && /(?:segmentio\/kafka-go|confluent-kafka-go|Shopify\/sarama)/.test(content)) {
      client = `a Kafka client declared in ${path}`;
    } else if (/(?:^|\/)Gemfile$/.test(path) && /ruby-kafka|racecar/.test(content)) {
      client = `a Kafka client declared in ${path}`;
    }
  }
  if (client) {
    const key = brokerConnectionRequired(tree, KAFKA_ENV_REGEX);
    if (key) {
      return {
        detected: true,
        dependency: 'kafka',
        reason: `Unsupported infrastructure: ${client}, and ${key} is required. Deployz does not host Kafka; the app would need a cluster Deployz cannot provision.`,
      };
    }
  }
  return { detected: false, dependency: 'none', reason: 'No Kafka infrastructure detected' };
}

/** RabbitMQ: AMQP clients + rabbitmq services in compose. */
export function checkRabbitMq(tree: FileTree): RejectionFinding {
  const compose = stackComposeServices(tree);
  // A service that `extends` another file's rabbitmq service has no image of its own (AutoGPT).
  if (compose?.services.some((s) => !s.optional && ((s.image && /rabbitmq/i.test(s.image)) || /^rabbitmq$/i.test(s.name)))) {
    return { detected: true, dependency: 'rabbitmq', reason: `Unsupported infrastructure: a RabbitMQ service is defined in ${compose.file}.` };
  }

  let client: string | null = null;
  const deps = collectDependencyNames(tree);
  for (const dep of ['amqplib', 'amqp-connection-manager', 'bunnymq', 'rascal'] as const) {
    if (deps.includes(dep)) client = `RabbitMQ client ${dep}`;
  }
  for (const [path, content] of Object.entries(tree)) {
    if (!content || client) break;
    if (/(?:^|\/)requirements(?:[^/]*)\.txt$/.test(path) && /^pika|^aio-pika|^kombu/m.test(content)) {
      client = `a RabbitMQ client declared in ${path}`;
    } else if (/(?:^|\/)pyproject\.toml$/.test(path) && /(?:^|["'\s])(?:pika|aio-pika|kombu)(?:["'\s]|$)/.test(content)) {
      client = `a RabbitMQ client declared in ${path}`;
    } else if (/(?:^|\/)Gemfile$/.test(path) && /^gem\s+['"]bunny['"]/m.test(content)) {
      client = `a RabbitMQ client declared in ${path}`;
    } else if (isRuntimeSourcePath(path) && (JS_SOURCE_REGEX.test(path) || LANGUAGE_SOURCE_REGEX.test(path)) && /["'`]amqps?:\/\//.test(content)) {
      client = `an AMQP URL in ${path}`;
    }
  }
  if (client) {
    // A settings module that hard-codes the broker host (`RABBITMQ_HOST = "127.0.0.1"`) needs that broker as well.
    const key = brokerConnectionRequired(tree, RABBITMQ_ENV_REGEX);
    const literal = Object.entries(tree).flatMap(([path, content]) => {
      const setting = /^(RABBITMQ_(?:URL|HOST)|AMQP_URL)\s*=\s*["']/m.exec(content ?? '');
      return setting && /\.py$/.test(path) && isRuntimeSourcePath(path) ? [`${setting[1]} is set in ${path}`] : [];
    })[0];
    const corroboration = key ? `${key} is required` : literal;
    if (corroboration) {
      return {
        detected: true,
        dependency: 'rabbitmq',
        reason: `Unsupported infrastructure: ${client}, and ${corroboration}. Deployz does not host RabbitMQ.`,
      };
    }
  }
  return { detected: false, dependency: 'none', reason: 'No RabbitMQ infrastructure detected' };
}

// SQS (Standard) is a SUPPORTED managed resource (Phase 5A) — see
// async-detection.ts. A queue that resolves both a producer and a consumer
// is provisioned; anything weaker becomes a `questions` entry. Neither case
// is a rejection any more.

/** Kubernetes: kustomize/Helm/manifests. */
export function checkKubernetes(tree: FileTree): RejectionFinding {
  const files = kubernetesFiles(tree);
  if (outsideDeploymentSamples(files).length > 0 || (files.length > 0 && usesKubernetesClient(tree))) {
    return {
      detected: true,
      dependency: 'kubernetes',
      reason: `Unsupported architecture: Kubernetes manifests are present (${files.slice(0, 3).join(', ')}). Deployz runs the app as a single container, not on a Kubernetes cluster.`,
    };
  }
  return { detected: false, dependency: 'none', reason: 'No Kubernetes manifests detected' };
}

/** Serverless / SAM: serverless.yml, SAM template.yaml, samconfig.toml. */
export function checkServerless(tree: FileTree): RejectionFinding {
  const serverless = filePathsMatching(tree, /(?:^|\/)serverless\.ya?ml$/i);
  const sam = contentMatches(tree, /(?:^|\/)template\.ya?ml$/i, /Transform:\s*AWS::Serverless/);
  const samConfig = filePathsMatching(tree, /(?:^|\/)samconfig\.toml$/);
  const serverlessDir = filePathsMatching(tree, /(?:^|\/)serverless\/.*\.ya?ml$/);
  if (serverless.length > 0 || sam.length > 0 || samConfig.length > 0 || serverlessDir.length > 0) {
    const evidence = [...serverless, ...sam, ...samConfig, ...serverlessDir].slice(0, 3).join(', ');
    return {
      detected: true,
      dependency: 'serverless',
      reason: `Unsupported architecture: a serverless configuration is present (${evidence}). Deployz runs containers, not functions.`,
    };
  }
  return { detected: false, dependency: 'none', reason: 'No serverless configuration detected' };
}

/** The image a Compose service pulls, without its tag or digest. */
function composeImageName(image: string): string {
  return image.replace(/(?<=[\w}])(?:@sha256:.*|:[^/:${}]+)$/, '');
}

/** The build lines that name the Dockerfile: context and dockerfile, without args or target. */
function composeDockerfileOf(build: string): string {
  return build
    .split('|')
    .filter((line) => /^(?:context|dockerfile):/.test(line))
    .join('|');
}

/** Docker Compose defining TWO OR MORE independent application services — a multi-service app, not one container. */
export function checkDockerComposeMultiService(tree: FileTree): RejectionFinding {
  const compose = composeApplicationServices(tree);
  if (!compose || compose.services.length === 0 || isPublishedImageSample(tree, compose.file)) {
    return { detected: false, dependency: 'none', reason: 'No multi-service compose app detected' };
  }
  // Services that run the same build or image are one application: the extra
  // ones are workers or replicas. A service that builds an image and tags it
  // shares that image with every service that pulls the tag.
  const buildOfImage = new Map<string, string>();
  for (const service of compose.services) {
    if (service.build && service.image) buildOfImage.set(composeImageName(service.image), service.build);
  }
  const groups = new Map<string, ComposeService[]>();
  for (const service of compose.services) {
    const image = service.image ? composeImageName(service.image) : null;
    const key = service.build || (image ? (buildOfImage.get(image) ?? image) : '(inherited)');
    groups.set(key, [...(groups.get(key) ?? []), service]);
  }
  // Phase 4A: a service that declares a worker process gets its own ECS
  // service, so it is no longer a "second application container" — only
  // non-worker application services count against the one-app-container
  // boundary. §25.2: a worker-shaped service name with no command is still a
  // worker candidate (weak evidence — `worker.needsCommand`), not a second
  // app container; it never gets auto-provisioned, but it doesn't block
  // either.
  const isNonWorker = (s: ComposeService): boolean => {
    if (s.command !== null && isWorkerServiceCommand(s.name, s.command)) return false;
    if (s.command === null && WORKER_SERVICE_NAME_REGEX.test(s.name)) return false;
    return true;
  };
  const apps = [...groups.entries()].filter(([, members]) => members.some(isNonWorker));
  // A group built from its own Dockerfile that no other application service
  // depends on or names, next to an app that builds and tags its own image, is
  // an optional extra of the same repository (a second API), not a required
  // component.
  const mentions = (from: ComposeService[], to: ComposeService[]): boolean =>
    from.some((a) => to.some((b) => a.body.split(/[^\w.-]+/).includes(b.name)));
  const isOptionalBuild = ([key, members]: [string, ComposeService[]]): boolean => {
    const others = apps.filter(([otherKey]) => otherKey !== key);
    return (
      members.every((s) => s.build && !s.image) &&
      others.some(([, g]) => g.some((s) => s.image && s.build)) &&
      others.every(
        ([otherKey, g]) =>
          composeDockerfileOf(otherKey) !== composeDockerfileOf(key) && !mentions(members, g) && !mentions(g, members),
      )
    );
  };
  // An image-only service with no published port that waits on the app, which
  // publishes a port and does not name it, is a satellite client of the app
  // (an optional vision or analytics sidecar), not a required component.
  const dependsOn = (from: ComposeService, to: ComposeService): boolean => {
    const lines = from.body.split('\n');
    const start = lines.findIndex((l) => /^\s*depends_on:/.test(l));
    if (start === -1) return false;
    const indent = lines[start]!.search(/\S/);
    const end = lines.findIndex((l, i) => i > start && l.trim() !== '' && l.search(/\S/) <= indent);
    return lines
      .slice(start + 1, end === -1 ? undefined : end)
      .some((l) => l.trim().replace(/^-\s*/, '').replace(/:$/, '') === to.name);
  };
  const isSatellite = ([key, members]: [string, ComposeService[]]): boolean => {
    const others = apps.filter(([otherKey]) => otherKey !== key);
    return (
      others.length === 1 &&
      members.every((s) => s.image && !s.build && s.ports.length === 0) &&
      others[0]![1].some((a) => a.ports.length > 0 && members.every((s) => dependsOn(s, a)) && !mentions([a], members))
    );
  };
  const required = apps.filter((entry) => !isOptionalBuild(entry) && !isSatellite(entry));
  if (required.length >= 2) {
    return {
      detected: true,
      dependency: 'docker-compose-multi-service',
      reason: `Unsupported architecture: ${compose.file} defines ${required.length} application services (${required.map(([, members]) => members.find(isNonWorker)!.name).join(', ')}). Deployz runs ONE web process per deployment plus declared background workers.`,
    };
  }
  return { detected: false, dependency: 'none', reason: 'No multi-service compose app detected' };
}

// The Dockerfile of one component image in its own directory (Harbor `make/photon/core/Dockerfile`).
const COMPONENT_IMAGE_REGEX = /^(?:(.*)\/)?([^/]+)\/Dockerfile$/;
// Vendored, development and hidden trees hold no component of the product.
const NON_COMPONENT_DIR_REGEX = /(?:^|\/)(?:third_party|vendor|node_modules|dev|devenv|develop|development|\.[\w-][\w.-]*)\//i;
const MIN_STACK_COMPONENTS = 7;

/**
 * A microservice stack: seven or more sibling directories each hold the Dockerfile of one
 * component image (Harbor `make/photon/{core,jobservice,registry,portal,…}`). Deployz builds one
 * image, and one component (or the front end) is not the whole app.
 */
export function checkMultiImageStack(tree: FileTree): RejectionFinding {
  const paths = (tree as FileTree & { [TREE_PATHS]?: readonly string[] })[TREE_PATHS] ?? Object.keys(tree);
  const families = new Map<string, string[]>();
  for (const path of paths) {
    const match = COMPONENT_IMAGE_REGEX.exec(path);
    if (!match || !isRuntimeSourcePath(path) || NON_COMPONENT_DIR_REGEX.test(path) || NON_APP_DOCKERFILE_DIR_REGEX.test(path)) continue;
    const parent = match[1] ?? '.';
    families.set(parent, [...(families.get(parent) ?? []), match[2]!]);
  }
  const [parent, components] = [...families].sort((a, b) => b[1].length - a[1].length)[0] ?? ['', []];
  if (components.length < MIN_STACK_COMPONENTS) return { detected: false, dependency: 'none', reason: 'No multi-image stack detected' };
  return {
    detected: true,
    dependency: 'multi-image-stack',
    reason: `Unsupported architecture: ${parent}/ holds the Dockerfiles of ${components.length} component images (${components.slice(0, 6).join(', ')}), so the app is a stack of cooperating services. Deployz runs ONE web process per deployment plus declared background workers.`,
  };
}

/** Persistent volumes: k8s PVCs, Terraform EFS/EBS, compose named volumes referenced by an app service. */
export function checkPersistentVolumes(tree: FileTree): RejectionFinding {
  const pvc = outsideDeploymentSamples(contentMatches(tree, /\.ya?ml$/, /^kind:\s*PersistentVolumeClaim\s*$/m));
  if (pvc.length > 0) {
    return {
      detected: true,
      dependency: 'persistent-volume',
      reason: `Unsupported infrastructure: a Kubernetes persistent volume claim is declared (${pvc[0]}). Deployz provides object storage, not attachable volumes.`,
    };
  }
  const iac = outsideDeploymentSamples(contentMatches(tree, /\.tf$/, /aws_efs_file_system|aws_ebs_volume|aws_fsx/));
  if (iac.length > 0) {
    return {
      detected: true,
      dependency: 'persistent-volume',
      reason: `Unsupported infrastructure: a Terraform-managed persistent volume is declared (${iac[0]}).`,
    };
  }
  const compose = composeServices(tree);
  if (compose) {
    const content = tree[compose.file] ?? '';
    if (/^volumes:\s*$[\s\S]*?^\s{2}\w/.test(content)) {
      return {
        detected: true,
        dependency: 'persistent-volume',
        reason: `Unsupported storage: ${compose.file} declares named volumes. Deployz runs stateless containers with object storage for persistence.`,
      };
    }
  }
  return { detected: false, dependency: 'none', reason: 'No persistent volume declaration detected' };
}

/** Terraform IaC. */
export function checkTerraform(tree: FileTree): RejectionFinding {
  const files = outsideDeploymentSamples(terraformFiles(tree));
  if (files.length > 0) {
    return {
      detected: true,
      dependency: 'terraform',
      reason: `Unsupported infrastructure: Terraform configuration is present (${files.slice(0, 3).join(', ')}). Deployz provisions infrastructure itself and cannot run alongside customer IaC.`,
    };
  }
  return { detected: false, dependency: 'none', reason: 'No Terraform configuration detected' };
}

/** Pulumi IaC. */
export function checkPulumi(tree: FileTree): RejectionFinding {
  const config = outsideDeploymentSamples(pulumiConfigFiles(tree));
  // A Pulumi package in a deployment sample directory is the self-hoster's option, not the app.
  const deps = collectDependencyNames(
    Object.fromEntries(Object.entries(runtimeTree(tree)).filter(([path]) => !DEPLOYMENT_SAMPLE_DIR_REGEX.test(path))),
  ).filter((d) => d.startsWith('@pulumi/'));
  if (config.length > 0 || deps.length > 0) {
    const evidence = config.length > 0 ? config[0] : deps[0];
    return {
      detected: true,
      dependency: 'pulumi',
      reason: `Unsupported infrastructure: Pulumi is present (${evidence}). Deployz provisions infrastructure itself and cannot run alongside customer IaC.`,
    };
  }
  return { detected: false, dependency: 'none', reason: 'No Pulumi configuration detected' };
}

/** Customer CloudFormation (non-SAM templates the repo ships to deploy its own AWS infra). */
export function checkCloudFormation(tree: FileTree): RejectionFinding {
  // A SAM template carries AWSTemplateFormatVersion too, but it is already its
  // own rejection (checkServerless) — do not double-report it as raw CFN.
  const cfn = contentMatches(tree, /\.(ya?ml|json)$/, /AWSTemplateFormatVersion:/).filter(
    (p) => !/template\.ya?ml$/i.test(p),
  );
  const dir = filePathsMatching(tree, /(?:^|\/)cloudformation\//);
  if (cfn.length > 0 || dir.length > 0) {
    return {
      detected: true,
      dependency: 'cloudformation',
      reason: `Unsupported architecture: the repository ships its own CloudFormation template (${(cfn[0] ?? dir[0])}). Deployz owns the infrastructure for each deployment.`,
    };
  }
  return { detected: false, dependency: 'none', reason: 'No CloudFormation template detected' };
}

/**
 * Azure deployment files. A `@azure/*` package (e.g. an optional storage or
 * KMS SDK) is not evidence the app deploys TO Azure, so only files that
 * describe an Azure deployment pipeline or resource template count.
 */
export function checkAzure(tree: FileTree): RejectionFinding {
  const signals = filePathsMatching(
    tree,
    /(?:^|\/)azure-pipelines\.ya?ml$|(?:^|\/)azuredeploy(?:\.parameters)?\.json$|\.bicep$/,
  );
  if (signals.length > 0) {
    return {
      detected: true,
      dependency: 'azure',
      reason: `Unsupported cloud: an Azure deployment file is present (${signals[0]}). Deployz deploys to AWS.`,
    };
  }
  return { detected: false, dependency: 'none', reason: 'No Azure dependency detected' };
}

/**
 * GCP deployment files. A `@google-cloud/*` or `firebase-admin` package (e.g.
 * an optional KMS or storage client) is not evidence the app deploys TO GCP,
 * so only files that describe a GCP deployment target count.
 */
export function checkGcp(tree: FileTree): RejectionFinding {
  const appEngine = contentMatches(tree, /(?:^|\/)app\.ya?ml$/, /^runtime:\s*(?:nodejs|python|go|java|php)/m);
  const cloudBuild = filePathsMatching(tree, /(?:^|\/)cloudbuild\.ya?ml$|(?:^|\/)\.gcloudignore$/);
  // Google's distroless base images live on gcr.io and say nothing about
  // where the app deploys (Stage A COMP-008).
  // A Dockerfile in a deployment sample directory (kubernetes/minikube/) is
  // an alternative setup Deployz ignores.
  const gcrBase = outsideDeploymentSamples(
    contentMatches(tree, /(?:^|\/)Dockerfile(?:\.[\w.-]+)?$/i, /^FROM\s+(?:[^/\s]+\/)?gcr\.io\/(?!distroless\/)/m),
  );
  if (appEngine.length > 0 || cloudBuild.length > 0 || gcrBase.length > 0) {
    const evidence = (appEngine[0] ?? cloudBuild[0] ?? gcrBase[0]) ?? '';
    return {
      detected: true,
      dependency: 'gcp',
      reason: `Unsupported cloud: a Google Cloud deployment file is present (${evidence}). Deployz deploys to AWS.`,
    };
  }
  return { detected: false, dependency: 'none', reason: 'No Google Cloud dependency detected' };
}

/** GPU requirements — the container needs a GPU Deployz does not provision. */
export function checkGpu(tree: FileTree): RejectionFinding {
  // Only the image Deployz would build counts — a `Dockerfile.transcribe.gpu`
  // variant next to the CPU image is an option, not a requirement (Stage A COMP-027).
  const selected = listDockerfileCandidates(tree)[0];
  const docker = selected && /nvidia\/cuda|cuda:|nvidia-smi|--gpus/.test(tree[selected] ?? '') ? [selected] : [];
  // The NVIDIA GPU runtime libraries only: a hosted-API client (`nvidia-riva-client`,
  // `langchain-nvidia-ai-endpoints`) runs on a CPU.
  const python = contentMatches(
    tree,
    /(?:^|\/)(?:requirements(?:[^/]*)\.txt|pyproject\.toml)$/,
    /tensorflow-gpu|\bnvidia-(?:cuda|cudnn|cublas|cufft|curand|cusolver|cusparse|nccl|nvjitlink|nvtx|dali|tensorrt)|torch.*cuda|cuda.*torch/,
  );
  if (docker.length > 0 || python.length > 0) {
    const evidence = (docker[0] ?? python[0]) ?? '';
    return {
      detected: true,
      dependency: 'gpu',
      reason: `Unsupported infrastructure: the app requires a GPU (${evidence}). Deployz runs CPU-only containers.`,
    };
  }
  return { detected: false, dependency: 'none', reason: 'No GPU requirement detected' };
}

// Documentation, licence and repository metadata files: none of them is application source.
// A root dot-file (`.gitmodules`, `.mrconfig`) and a root shell script that updates them are repository
// tooling: a meta-repository whose code is in git submodules (ONLYOFFICE DocumentServer) has no app here.
const DOCUMENT_ONLY_PATH_REGEX =
  /^\.(?:github|gitignore|gitattributes|editorconfig)(?:\/|$)|^\.[\w.-]+$|^[\w.-]+\.sh$|(?:^|\/)(?:readme|licen[cs]e|copying|notice|changelog|contributing|code_of_conduct|security|authors|funding|roadmap)(?:\.[\w.-]+)?$|\.(?:md|rst|png|jpe?g|gif|svg|webp)$/i;

// A workspace root only lists packages; examples, templates and cookbooks are not the product.
const WORKSPACE_ROOT_MANIFEST_REGEX = /"workspaces"\s*:|^\s*\[(?:workspace|tool\.uv\.workspace)\]/m;
const SCAFFOLD_PATH_REGEX = /(?:^|\/)(?:templates?|cookbooks?|starters?|scaffolds?)\//i;
// `"main"`, `"module"` and `"types"` alone do not publish: an application's package.json has them too.
const ENTRY_FIELD_ONLY_REGEX = /^\s*"(?:main|module|types|typings)"\s*:/;

/**
 * The production package manifests when EVERY one of them publishes its code for others to
 * install (a `bin`, `exports`, a build backend, console scripts, a Rust `[lib]`), else empty.
 * One manifest that packages nothing (an application's package.json or composer.json, a Rust
 * binary crate) means the repository holds an application.
 */
function publishedPackageManifests(tree: FileTree): string[] {
  const manifests = Object.keys(tree).filter(
    (path) =>
      PACKAGE_MANIFEST.test(path) &&
      isProductionFile(path) &&
      isRuntimeSourcePath(path) &&
      !SCAFFOLD_PATH_REGEX.test(path) &&
      !WORKSPACE_ROOT_MANIFEST_REGEX.test(tree[path] ?? ''),
  );
  const publishes = (path: string): boolean => (tree[path] ?? '').split('\n').some((line) => PACKAGE_MARKER.test(line) && !ENTRY_FIELD_ONLY_REGEX.test(line));
  return manifests.every(publishes) ? manifests.sort() : [];
}

/**
 * A repository with no Dockerfile that builds a production image cannot be
 * deployed: no Deployz setting adds one. A repository whose every package
 * manifest publishes a library, framework, SDK or CLI is not an application. Rejects only on complete evidence
 * (`detectUnbuildableDockerfile`), never on a capped or partial file list
 * (COMP-021).
 */
export function checkNoBuildableDockerfile(tree: FileTree): RejectionFinding {
  // A repository of only documents has no app to build: a moved project or a mirror (readeck, glitchtip on GitHub).
  const paths = (tree as FileTree & { [TREE_PATHS]?: readonly string[] })[TREE_PATHS];
  if (paths && paths.length > 0 && paths.every((path) => DOCUMENT_ONLY_PATH_REGEX.test(path))) {
    return {
      detected: true,
      dependency: 'no-application-source',
      reason: `Unsupported repository: it holds no application source (${paths.slice(0, 3).join(', ')}), so there is no app to build.`,
    };
  }
  const reason = detectUnbuildableDockerfile(tree);
  if (reason === null) {
    return { detected: false, dependency: 'none', reason: 'A Dockerfile that can build the app exists, or the file list is incomplete' };
  }
  const packages = publishedPackageManifests(tree);
  if (packages.length > 0) {
    return {
      detected: true,
      dependency: 'library-repository',
      reason: `Unsupported repository: every package manifest publishes a library, framework, SDK or CLI that others install (${packages.slice(0, 3).join(', ')}), and no Dockerfile builds an application.`,
    };
  }
  return {
    detected: true,
    dependency: 'no-buildable-dockerfile',
    reason: `Unsupported container setup: ${reason} Deployz builds the app from a Dockerfile in the repository.`,
  };
}

// ── Stage B final batch (COMP-021 / COMP-025 / COMP-031) ─────────────────────

// Durable directory variables COMP-025 reads — a name that says the value IS
// the directory where the app keeps data it must not lose. App-specific
// state homes (THELOUNGE_HOME) and config dirs (HOMEPAGE_CONFIG_DIR) are
// included by their documented names; the generic `*_DATA_DIR` /
// `*_CONFIG_DIR` / `STORAGE_PATH` families stay as before. Build-tool and
// runtime search paths (`PKG_CONFIG_PATH`, `USER_DATA_DIR`) are NOT durable
// app state and never match.
const DIRECTORY_VAR = /(?:HOMEPAGE_CONFIG_DIR|THELOUNGE_HOME|(?:^|_)(?:DATA_DIR|CONFIG_DIR|STORAGE_PATH|DATA_FOLDER)$)/;
// The app's own YAML or TOML configuration file, and a setting in it that is the data location.
const APP_CONFIG_FILE = /(?:^|\/)config(?:\/[\w.-]+)?\.(?:ya?ml|toml)$/i;
// A temporary, cache or log directory (`CHROMIUM_DATA_DIR=/tmp/chromium-data`) is scratch space, not durable state.
const EPHEMERAL_DIR_VALUE_REGEX = /\b(?:tmp|temp|cache|logs?)\b/i;
const CONFIG_DATA_PATH_SETTING = /^\s*((?:storage|data|db|database)_(?:path|dir|directory))\s*[:=]\s*["']?([^\s"'#,]+)/im;

/**
 * COMP-025 — an app that EXPLICITLY declares durable local state through a
 * data/config directory variable (a `*_DATA_DIR` / `*_CONFIG_DIR` /
 * `STORAGE_PATH` / `HOMEPAGE_CONFIG_DIR` / `THELOUNGE_HOME` name pointing at a
 * local path) with NO Dockerfile VOLUME and NO production Compose mount needs
 * persistent storage Deployz does not provide. Narrow — no heuristic
 * write-call scanning (COMP-003/COMP-024 already cover declared container
 * state).
 */
export function checkExplicitPersistentDataDir(tree: FileTree): RejectionFinding {
  // A declared VOLUME (any candidate Dockerfile) or a production Compose
  // volume on an application service provides the durable mount instead.
  const hasVolume = listDockerfileCandidates(tree).some(
    (path) => /^\s*VOLUME\b/m.test(tree[path] ?? ''),
  );
  const compose = composeApplicationServices(tree);
  const hasMount =
    compose !== null && compose.services.some((service) => service.volumes.length > 0);
  if (hasVolume || hasMount) {
    return { detected: false, dependency: 'none', reason: 'The data directory is covered by a VOLUME or Compose mount' };
  }

  const declared = findExplicitDurableDir(tree);
  if (declared === null) {
    return { detected: false, dependency: 'none', reason: 'No explicit data/config directory declared' };
  }

  return {
    detected: true,
    dependency: 'local-filesystem',
    reason: `Unsupported storage: the app declares durable local state (${declared}) with no VOLUME or Compose mount. Deployz provides object storage, not an attached data directory.`,
  };
}

/**
 * Find a durable directory the app itself names. The declaration can sit in:
 *  - an env file line (`HOMEPAGE_CONFIG_DIR=/app/config`),
 *  - the selected Dockerfile's ENV (`HALO_WORK_DIR=/root/.halo2` is a durable
 *    work dir the app keeps attachments under),
 *  - runtime code that reads the variable with a local default on the same or
 *    a following statement (`process.env.HOMEPAGE_CONFIG_DIR ? … : join(…,
 *    "config")`), or
 *  - runtime code that reads a known state-home variable (THELOUNGE_HOME) —
 *    the read itself names the directory the environment controls.
 * Only runtime paths are scanned (COMP-003); a read in a script, test or tool
 * config never declares app state.
 */
function findExplicitDurableDir(tree: FileTree): string | null {
  const selected = listDockerfileCandidates(tree)[0];
  const dockerfileLines =
    selected === undefined ? [] : (tree[selected] ?? '').replace(/^\s*#.*$/gm, '').replace(/\\\s*\r?\n\s*/g, ' ').split('\n');
  // A configuration directory that the Dockerfile fills from the repository holds shipped
  // configuration, not state the customer writes (data, home and storage variables stay durable).
  const shippedConfigDir = (name: string, value: string): boolean =>
    /CONFIG_DIR$/.test(name) && selected !== undefined && dockerfileCopiesInto(dockerfileLines, value);
  const isRuntimeDirVar = (name: string, value: string): boolean => {
    if (!DIRECTORY_VAR.test(name)) return false;
    if (value.includes('://') || EPHEMERAL_DIR_VALUE_REGEX.test(value)) return false;
    return !shippedConfigDir(name, value);
  };

  // 1. Env-file declarations.
  for (const [path, content] of Object.entries(tree)) {
    if (!content || !isRuntimeSourcePath(path) || !/^\.env(\.\w+)?$/i.test(path)) continue;
    const line = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*([^\s#]+)/.exec(content);
    if (line?.[1] && isRuntimeDirVar(line[1], line[2] ?? '')) {
      return `${line[1]}=${line[2]} (${path})`;
    }
  }

  // 2. The selected Dockerfile's ENV — the image itself names its state/work
  //    directory (halo `ENV HALO_WORK_DIR="/root/.halo2"`). ENV can assign
  //    several variables on one logical line via `\` continuations, so
  //    continuation folds happen before scanning. Only the image Deployz
  //    builds counts, and only a durable-dir-named variable with a local value.
  if (selected !== undefined) {
    const folded = (tree[selected] ?? '').replace(/\\\s*\r?\n\s*/g, ' ');
    for (const m of folded.matchAll(/^\s*ENV\s+(.+)$/gm)) {
      for (const pair of (m[1] ?? '').split(/\s+(?=[A-Z][A-Z0-9_]*\s*=)/)) {
        const kv = /^([A-Z][A-Z0-9_]*)\s*=\s*"?([^"\s]+)/.exec(pair);
        if (
          kv?.[1] &&
          (isDurableImageDirVar(kv[1]) || isDataHomeVar(kv[1], kv[2] ?? '')) &&
          isLocalDirValue(kv[2] ?? '') &&
          !EPHEMERAL_DIR_VALUE_REGEX.test(kv[2] ?? '') &&
          !shippedConfigDir(kv[1], kv[2] ?? '')
        ) {
          return `${kv[1]}=${kv[2]} (${selected})`;
        }
      }
    }
    // A RUN step that writes a data directory into the app's configuration file
    // (SFTPGo `sed … "users_base_dir": "/srv/sftpgo/data"`).
    for (const m of productionStageText(folded).matchAll(/^\s*RUN\b.*$/gm)) {
      const setting = /["']?(\w*(?:data|base|storage)_dir)["']?\s*[:=]\s*["']?(\/[\w./-]+)/i.exec(m[0]);
      if (setting?.[1] && setting[2] && !EPHEMERAL_DIR_VALUE_REGEX.test(setting[2])) return `${setting[1]} = ${setting[2]} (${selected})`;
    }
  }

  // 3. Runtime code reads. A known state-home variable read in runtime source
  //    (thelounge `process.env.THELOUNGE_HOME`) is the declaration. Other
  //    directory variables need a local default on the same statement —
  //    `process.env.X || '/data'`, `os.getenv('X', '/data')`.
  for (const [path, content] of Object.entries(tree)) {
    if (!content || !isRuntimeSourcePath(path)) continue;
    if (!/\.(?:py|ts|js|mjs|cjs|rb|go|java|kt)$/.test(path)) continue;
    if (DIRECTORY_VAR.test(content) && /\bTHELOUNGE_HOME\b/.test(content)) {
      return 'THELOUNGE_HOME (runtime source)';
    }
    const ref = /(HOMEPAGE_CONFIG_DIR|[A-Z][A-Z0-9_]*_(?:DATA_DIR|CONFIG_DIR|DATA_FOLDER)|STORAGE_PATH)\b[^\n]*["'](\/[\w./-]+?)["']/.exec(content);
    if (ref?.[1] && ref[2] && !ref[2].includes('://') && !EPHEMERAL_DIR_VALUE_REGEX.test(ref[2]) && !shippedConfigDir(ref[1], ref[2])) {
      return `${ref[1]}=${ref[2]} (${path})`;
    }
    // Multiline fallback: `process.env.HOMEPAGE_CONFIG_DIR ? … : join(…, "config")`
    // puts the quoted default on a later line than the read.
    if (/\bHOMEPAGE_CONFIG_DIR\b/.test(content) && /["'](?:\/[\w./-]+|config)["']/.test(content)) {
      return 'HOMEPAGE_CONFIG_DIR (runtime source)';
    }
  }

  // 4. The app's own configuration file names where it keeps its data
  //    (qdrant `storage_path: ./storage`, meilisearch `db_path = "./data.ms"`).
  for (const [path, content] of Object.entries(tree)) {
    if (!content || !isRuntimeSourcePath(path) || !APP_CONFIG_FILE.test(path)) continue;
    const setting = CONFIG_DATA_PATH_SETTING.exec(content);
    if (setting?.[1] && setting[2] && isLocalDirValue(setting[2]) && !/[$<{%]|\b(?:tmp|temp|cache|logs?)\b/i.test(setting[2])) {
      return `${setting[1]} = ${setting[2]} (${path})`;
    }
  }

  return null;
}

/** True when a COPY or ADD of the Dockerfile writes into the image directory, or copies the whole build context into one of its parents. */
function dockerfileCopiesInto(dockerfileLines: string[], directory: string): boolean {
  const target = directory.replace(/\/+$/, '');
  for (const line of dockerfileLines) {
    const match = /^\s*(?:COPY|ADD)\s+(.+)$/i.exec(line);
    if (!match?.[1] || /--from=/i.test(match[1])) continue;
    const words = match[1]
      .replace(/[[\]",]/g, ' ')
      .split(/\s+/)
      .filter((word) => word !== '' && !word.startsWith('--'));
    const destination = words.at(-1)?.replace(/\/+$/, '');
    if (destination === undefined || words.length < 2) continue;
    if (destination === target) return true;
    const wholeContext = words.slice(0, -1).some((source) => source === '.' || source === './');
    if (wholeContext && target.startsWith(`${destination}/`)) return true;
  }
  return false;
}

/** A durable-dir name in the selected image's ENV. */
function isDurableImageDirVar(name: string): boolean {
  return (
    name === 'HALO_WORK_DIR' ||
    name === 'THELOUNGE_HOME' ||
    name === 'HOMEPAGE_CONFIG_DIR' ||
    /^(?:[A-Z][A-Z0-9_]*_)?(?:DATA_DIR|DATA_FOLDER|CONFIG_DIR)$/.test(name) ||
    /^[A-Z][A-Z0-9_]*_STORAGE_PATH$/.test(name)
  );
}

/** An app home variable that points at the conventional data mount (livebook `LIVEBOOK_HOME=/data`). */
function isDataHomeVar(name: string, value: string): boolean {
  return /^[A-Z][A-Z0-9_]*_HOME$/.test(name) && /^\/data(?:\/|$)/.test(value);
}

/** A declared value is a local directory, not a URL or an interpolation token. */
function isLocalDirValue(value: string): boolean {
  if (!value) return false;
  if (value.includes('://')) return false;
  if (/^\$\{/.test(value)) return false;
  // Reject flags/booleans that merely share a variable name (`DATA_DIR=1`).
  if (/^(?:true|false|0|1|yes|no)$/i.test(value)) return false;
  return true;
}

/** A web-server front end or php-fpm: part of one web service, not an extra application. */
const WEB_FRONT_END = /(?<![a-z])(?:nginx|apache2?|httpd|caddy)(?![a-z])|fpm/i;

/** A supervised queue worker or scheduler (`artisan schedule:work`), not a web process. */
function isSupervisedWorker(name: string, command: string): boolean {
  return isWorkerServiceCommand(name, command) || /\bschedul(?:e|er)\b|schedule:work|\bcrond?\b/i.test(`${name} ${command}`);
}

/** True when a COPY or ADD source of the selected Dockerfile brings the tree path into the image. */
function dockerfileCopiesPath(dockerfileLines: string[], dockerfilePath: string, path: string): boolean {
  const directory = dockerfilePath.includes('/') ? dockerfilePath.slice(0, dockerfilePath.lastIndexOf('/')) : '';
  const contexts = directory === '' ? [''] : ['', directory];
  for (const line of dockerfileLines) {
    const match = /^\s*(?:COPY|ADD)\s+(.+)$/i.exec(line);
    if (!match?.[1] || /--from=/i.test(match[1])) continue;
    const words = match[1]
      .replace(/[[\]",]/g, ' ')
      .split(/\s+/)
      .filter((word) => word !== '' && !word.startsWith('--'));
    for (const source of words.slice(0, -1)) {
      if (source.includes('://')) continue;
      const wanted = source.replace(/^\.\//, '').replace(/\/+$/, '');
      for (const context of contexts) {
        const relative = context === '' ? path : path.startsWith(`${context}/`) ? path.slice(context.length + 1) : null;
        if (relative === null) continue;
        if (wanted === '' || wanted === '.') return true;
        if (/[*?]/.test(wanted)) {
          const pattern = wanted.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
          if (new RegExp(`^${pattern}(?:/|$)`).test(relative)) return true;
        } else if (relative === wanted || relative.startsWith(`${wanted}/`)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * An image that starts several long-running processes under a supervisor (s6-overlay or
 * supervisord) runs web, API and worker processes in one container. Deployz runs one web
 * process plus declared workers, each as its own service from the same image. A web-server
 * front end (nginx, apache, caddy) and php-fpm count as one web service, and only service
 * files that the selected Dockerfile copies into the image count.
 */
export function checkMultiProcessImage(tree: FileTree): RejectionFinding {
  const selected = listDockerfileCandidates(tree)[0];
  // The image that `docker build` produces: a trailing dev all-in-one stage (twenty-app-dev) is not it.
  const dockerfile = selected === undefined ? '' : productionStageText(tree[selected] ?? '');
  const lines = dockerfile.split('\n');
  const paths = (tree as FileTree & { [TREE_PATHS]?: readonly string[] })[TREE_PATHS] ?? Object.keys(tree);
  const copied = (path: string): boolean => selected !== undefined && dockerfileCopiesPath(lines, selected, path);
  // A base image that serves the web front end itself (serversideup/php:*-fpm-nginx) supervises it too.
  const webBase = [...dockerfile.matchAll(/^\s*FROM\s+(?:--\S+\s+)*(\S+)/gim)].some((match) => WEB_FRONT_END.test(match[1] ?? ''));
  if (/s6-overlay|S6_OVERLAY|\bs6-svscan\b/i.test(dockerfile)) {
    const services = new Set<string>();
    let web = webBase;
    let worker = false;
    for (const path of paths) {
      const name = /(?:^|\/)(?:s6-rc\.d|services\.d)\/([\w.-]+)\/run$/.exec(path)?.[1];
      if (name === undefined || !copied(path)) continue;
      // A comment names other services ("supervised alongside nginx"), not this one's command.
      const script = (tree[path] ?? '').replace(/^\s*#.*$/gm, '');
      if (WEB_FRONT_END.test(`${name} ${script}`)) {
        web = true;
        continue;
      }
      services.add(name);
      worker ||= isSupervisedWorker(name, script);
    }
    // The web service plus one worker (the Laravel scheduler next to nginx and php-fpm) is two processes too.
    if (services.size >= 2 || (services.size === 1 && web && worker)) {
      return {
        detected: true,
        dependency: 'multi-process-image',
        reason: `Unsupported container setup: ${selected} runs s6-overlay with ${services.size >= 2 ? `${services.size} long-running services` : 'a web server and a worker service'} (${[...services].slice(0, 4).join(', ')}) in one container. Deployz runs one web process and declared workers as separate services.`,
      };
    }
  }
  if (/\bsupervisord\b/i.test(dockerfile)) {
    for (const [path, content] of Object.entries(tree)) {
      if (!/supervisor[\w.-]*\.(?:conf|ini)$/i.test(path) || !content || !copied(path)) continue;
      const sections = content.split(/^\s*(?=\[program:[^\]]+\])/m).filter((section) => section.startsWith('[program:'));
      const programs = sections.filter((section) => !WEB_FRONT_END.test(section));
      const web = webBase || programs.length < sections.length;
      const worker = programs.some((section) => isSupervisedWorker(/^\[program:([^\]]+)\]/.exec(section)?.[1] ?? '', section));
      if (programs.length >= 2 || (programs.length === 1 && web && worker)) {
        return {
          detected: true,
          dependency: 'multi-process-image',
          reason: `Unsupported container setup: ${selected} runs supervisord with ${programs.length >= 2 ? `${programs.length} programs` : 'a web server and a worker program'} (${path}) in one container. Deployz runs one web process and declared workers as separate services.`,
        };
      }
    }
  }
  // A shell-form start that backgrounds a server before the foreground one (`node worker.js & node server.js`).
  const start = lines
    .filter((line) => /^\s*(?:ENTRYPOINT|CMD)\b/i.test(line))
    .map((line) => line.replace(/^\s*(?:ENTRYPOINT|CMD)\s+/i, '').replace(/[[\]"]|,(?=\s*")/g, ' '))
    .join(' ');
  const inline = /(?:^|[;&|]|-c\s)\s*([^&|;]+?)\s+&(?!&)\s*([^&|;]+)/.exec(start);
  const background = inline?.[1]?.trim() ?? '';
  if (inline && !WEB_FRONT_END.test(background) && !/migrat|^(?:sleep|wait|trap)\b/i.test(background) && !/^\s*(?:wait|sleep)\b/.test(inline[2] ?? '')) {
    return {
      detected: true,
      dependency: 'multi-process-image',
      reason: `Unsupported container setup: the start command of ${selected} runs ${background} in the background next to ${inline[2]?.trim()} in one container. Deployz runs one web process and declared workers as separate services.`,
    };
  }
  // A start script that puts two or more long-running servers in the background
  // (`redis-server &`, `node server.js &`) is a supervisor of its own. A migration it waits for is no server.
  const visited = new Set<string>();
  const dockerDir = selected?.includes('/') ? selected.slice(0, selected.lastIndexOf('/')) : '';
  let frontier = extractCmdScriptPaths(lines.filter((line) => /^\s*(?:ENTRYPOINT|CMD)\b/i.test(line)).join(' '), tree, dockerDir, visited);
  const servers = new Set<string>();
  const scripts = new Set<string>();
  for (let depth = 0; depth < CMD_CHAIN_MAX_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const path of frontier.filter((entry) => entry.endsWith('.sh'))) {
      const content = (tree[path] ?? '').replace(/^\s*#.*$/gm, '');
      for (const [, command] of content.matchAll(/^\s*([^\s&|;#][^&|;#\n]*?)\s*&\s*$/gm)) {
        if (command === undefined || WEB_FRONT_END.test(command) || /migrat/i.test(command)) continue;
        servers.add(command.replace(/^(?:\w+=\S*\s+)+/, '').split(/\s+/).slice(0, 2).join(' '));
        scripts.add(path);
      }
      next.push(...extractCmdScriptPaths(content, tree, dockerDir, visited));
    }
    frontier = next;
  }
  if (servers.size >= 2) {
    return {
      detected: true,
      dependency: 'multi-process-image',
      reason: `Unsupported container setup: the start script ${[...scripts].join(', ')} runs ${servers.size} long-running servers in the background (${[...servers].slice(0, 4).join(', ')}) in one container. Deployz runs one web process and declared workers as separate services.`,
    };
  }
  return { detected: false, dependency: 'none', reason: 'The image does not run several supervised processes' };
}

/**
 * An image `ENTRYPOINT` or `CMD` that passes a configuration FILE (`--config /app/config/app.yml`)
 * that no instruction of the Dockerfile creates and the repository does not ship at that path.
 */
function requiredConfigFileArgument(tree: FileTree, selected: string | undefined, lines: string[]): { file: string; instruction: string } | null {
  for (const line of lines.filter((entry) => /^\s*(?:ENTRYPOINT|CMD)\b/.test(entry))) {
    const argument = /(?:--config(?:-file)?|-c)(?:=|"?\s*,\s*"|\s+)"?(\/[\w./-]+\/[\w.-]+\.(?:ya?ml|toml|json|conf|ini))\b/.exec(line);
    if (!argument?.[1]) continue;
    const file = argument[1];
    const directory = file.slice(0, file.lastIndexOf('/'));
    const created = lines.some((entry) => !/^\s*(?:ENV|ENTRYPOINT|CMD)\b/.test(entry) && entry.includes(directory));
    const shipped = Object.keys(tree).some((path) => file.endsWith(`/${path}`));
    if (!created && !shipped) return { file, instruction: selected ?? 'Dockerfile' };
  }
  return null;
}

/**
 * An image `ENV` that points the app at a configuration FILE no instruction of the
 * Dockerfile creates (authelia `X_AUTHELIA_CONFIG=/config/configuration.yml`): the
 * container exits until that file is mounted, and Deployz mounts no files.
 */
export function checkRequiredConfigFileMount(tree: FileTree): RejectionFinding {
  const selected = listDockerfileCandidates(tree)[0];
  const lines = (selected === undefined ? '' : (tree[selected] ?? '')).replace(/\\\s*\r?\n\s*/g, ' ').split('\n');
  for (const line of lines.filter((entry) => /^\s*ENV\b/.test(entry))) {
    for (const pair of line.matchAll(/\b([A-Z][A-Z0-9_]*_CONFIG(?:_FILE|_PATH)?)\s*=\s*"?(\/[\w./-]+\/[\w.-]+\.(?:ya?ml|toml|json|conf|ini))\b/g)) {
      const directory = pair[2]!.slice(0, pair[2]!.lastIndexOf('/'));
      if (!lines.some((entry) => !/^\s*ENV\b/.test(entry) && entry.includes(directory))) {
        return {
          detected: true,
          dependency: 'local-filesystem',
          reason: `Unsupported storage: the image reads its configuration from ${pair[2]} (${pair[1]} in ${selected}), and no Dockerfile instruction creates that file. Deployz does not mount configuration files.`,
        };
      }
    }
  }
  const argument = requiredConfigFileArgument(tree, selected, lines);
  if (argument !== null) {
    return {
      detected: true,
      dependency: 'local-filesystem',
      reason: `Unsupported storage: the image starts with the configuration file ${argument.file} (ENTRYPOINT or CMD in ${argument.instruction}), and no Dockerfile instruction creates that file. Deployz does not mount configuration files.`,
    };
  }
  return { detected: false, dependency: 'none', reason: 'No required configuration file mount detected' };
}

/**
 * COMP-031— a REQUIRED third-party service in the production Compose file
 * (a workflow engine such as Temporal that Deployz does not provision) makes
 * the app undeployable. Only default-stack (non-optional) services count.
 */
export function checkRequiredThirdPartyService(tree: FileTree): RejectionFinding {
  const compose = composeServices(tree);
  if (!compose) return { detected: false, dependency: 'none', reason: 'No Compose file to check' };
  for (const service of compose.services) {
    if (service.optional) continue;
    const image = service.image ?? '';
    if (!/(?:^|[/_-])temporal(?:[/_-]|$)|^temporalio\//i.test(image)) continue;
    return {
      detected: true,
      dependency: 'temporal',
      reason: `Unsupported infrastructure: ${compose.file} requires a Temporal server (service "${service.name}", image ${image}) which Deployz does not provision.`,
    };
  }
  return { detected: false, dependency: 'none', reason: 'No required third-party service detected' };
}

// The well-known client ports of database, cache and message-broker protocols. Clients reach them
// over raw TCP, not HTTP, and an image that listens on one is that server (EMQX, NATS, a database).
const DATASTORE_PROTOCOL_PORTS: Readonly<Record<string, string>> = {
  '1883': 'MQTT',
  '8883': 'MQTT over TLS',
  '5671': 'AMQP over TLS',
  '5672': 'AMQP',
  '9092': 'Kafka',
  '4222': 'NATS',
  '3306': 'MySQL',
  '5432': 'PostgreSQL',
  '6379': 'Redis',
  '27017': 'MongoDB',
  '9042': 'Cassandra',
  '7687': 'Neo4j Bolt',
  '26257': 'CockroachDB',
};

/**
 * The repository builds a database or message-broker server: the first port that the production
 * image exposes is the client port of such a protocol. Deployz routes HTTPS to one web port; it
 * cannot give clients a database or broker endpoint, and the server's data needs durable disk.
 * A web app that also exposes a metrics port (focalboard 9092) or bundles a database in an
 * all-in-one image (Helicone 5432) exposes its web port first.
 */
export function checkDatastoreServerImage(tree: FileTree): RejectionFinding {
  const dockerfile = selectedDockerfile(tree);
  if (dockerfile === null) return { detected: false, dependency: 'none', reason: 'No Dockerfile to check' };
  const port = exposedPorts(productionStageText(dockerfile.content))[0];
  if (port === undefined || DATASTORE_PROTOCOL_PORTS[port] === undefined) return { detected: false, dependency: 'none', reason: 'The image exposes no database or broker port first' };
  return {
    detected: true,
    dependency: 'datastore-server',
    reason: `Unsupported repository: ${dockerfile.path} exposes port ${port} (${DATASTORE_PROTOCOL_PORTS[port]}), so the image is a database or message-broker server that clients reach over its own protocol, not a web application.`,
  };
}
/** What the rules found for the engines Deployz provides: a declared service of one of them is explained by it. */
export interface DeclaredServiceContext {
  readonly postgres: boolean;
  readonly mysql: boolean;
  readonly redis: boolean;
  readonly storage: boolean;
  /** The reasons of every other detected rejection, dismissed ones included: a rejection that names the engine explains it. */
  readonly rejectionReasons: readonly string[];
}

type DeclaredEngine = 'postgres' | 'mysql' | 'redis' | 's3' | 'other';

/** Datastore and broker images, with the words a rejection reason uses for the engine. Admin and UI tools are not datastores. */
const DECLARED_DATASTORES: readonly { readonly image: RegExp; readonly engine: DeclaredEngine; readonly words: RegExp }[] = [
  { image: /cockroach/i, engine: 'other', words: /cockroach/i },
  { image: /postgres|postgis|pgvector|timescale/i, engine: 'postgres', words: /postgres/i },
  { image: /mysql|mariadb|percona/i, engine: 'mysql', words: /mysql|mariadb/i },
  { image: /redis|valkey|keydb|dragonfly/i, engine: 'redis', words: /redis/i },
  { image: /mongo/i, engine: 'other', words: /mongo/i },
  { image: /elasticsearch|opensearch/i, engine: 'other', words: /elastic|opensearch/i },
  { image: /kafka|redpanda/i, engine: 'other', words: /kafka|redpanda/i },
  { image: /rabbitmq|amqp/i, engine: 'other', words: /rabbitmq|amqp/i },
  { image: /clickhouse/i, engine: 'other', words: /clickhouse/i },
  { image: /cassandra|scylla/i, engine: 'other', words: /cassandra|scylla/i },
  { image: /neo4j/i, engine: 'other', words: /neo4j/i },
  { image: /couchdb|couchbase/i, engine: 'other', words: /couch/i },
  { image: /meilisearch|typesense|qdrant|weaviate|milvus|chroma/i, engine: 'other', words: /meilisearch|typesense|qdrant|weaviate|milvus|chroma/i },
  { image: /minio|seaweedfs|rustfs/i, engine: 's3', words: /minio|seaweedfs|rustfs/i },
];
const DATASTORE_TOOL_IMAGE_REGEX = /admin|commander|express|console|insight|exporter|kibana|dashboards|[-_/]ui(?:[:@]|$)/i;
// A test, CI, example or documentation stack is not how the app runs.
const NON_STACK_COMPOSE_PATH_REGEX =
  /(?:^|\/)(?:test|testing|tests|[\w.-]+[._-]tests?|e2e|ci|\.github|\.gitlab|\.circleci|cypress|playwright|[\w.-]*examples?|[\w.-]*samples?|demos?|docs?|benchmarks?|fixtures?|templates?)(?:\/|$)|(?:docker-)?compose[.-](?:test|testing|ci|e2e|example|sample|demo)(?:[.-][\w.-]+)?\.ya?ml$/i;
const ANY_COMPOSE_FILE_REGEX = /(?:^|\/)(?:docker-)?compose(?:[.-][\w.-]+)?\.ya?ml$/i;

// The app's own chart, not a vendored subchart (`charts/app/charts/redis/Chart.yaml`).
const HELM_CHART_REGEX = /^(?!(?:.*\/)?charts\/[^/]+\/charts\/)(?:.*\/)?Chart\.ya?ml$/;
const ENV_SAMPLE_PATH_REGEX = /(?:^|\/)\.env\.(?:example|template|sample)$/i;
// A connection setting with a value: `REDIS_URL=redis://localhost:6379`, `ELASTICSEARCH_HOST=elastic`.
const SAMPLE_CONNECTION_REGEX = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*_(?:URL|URI|DSN|HOSTS?|BROKERS?|NODES?|SERVERS?))\s*=\s*["']?([^\s"'#]+)/gm;

/** The `name:` of each entry of a chart's `dependencies:` list. */
function helmDependencies(content: string): string[] {
  const block = /^dependencies:[ \t]*\r?\n((?:[ \t].*(?:\r?\n|$)|-.*(?:\r?\n|$)|[ \t]*\r?\n)*)/m.exec(content)?.[1] ?? '';
  return [...block.matchAll(/^\s*-?\s*name:\s*["']?([\w.-]+)/gm)].map((match) => match[1]!);
}

function declaredEngineOf(image: string): (typeof DECLARED_DATASTORES)[number] | null {
  if (DATASTORE_TOOL_IMAGE_REGEX.test(image)) return null;
  return DECLARED_DATASTORES.find((entry) => entry.image.test(image)) ?? null;
}

/**
 * The Compose files that describe how the app runs: the production file, or,
 * when the repository has none, its development stack (the shallowest Compose
 * files outside test, CI, example and documentation folders).
 */
function declaredStackFiles(tree: FileTree): { files: string[]; production: boolean } {
  const production = listProductionComposeFiles(tree).find((path) => !NON_STACK_COMPOSE_PATH_REGEX.test(path));
  if (production !== undefined) return { files: [production], production: true };
  const stack = Object.keys(tree).filter((path) => ANY_COMPOSE_FILE_REGEX.test(path) && !NON_STACK_COMPOSE_PATH_REGEX.test(path));
  const depth = Math.min(...stack.map((path) => path.split('/').length));
  return { files: stack.filter((path) => path.split('/').length === depth).sort(), production: false };
}

/**
 * Whether a service's lines name another service: `links`, a host in a value (`redis://redis:6379`),
 * or, in the production stack, `depends_on`. A development stack starts its tools in order with
 * `depends_on` (saleor's optional cache), so there it is no connection.
 */
function namesService(from: ComposeService, name: string, production: boolean): boolean {
  const lines = from.body.split(/\r?\n/);
  const start = production ? -1 : lines.findIndex((line) => /^\s*depends_on:/.test(line));
  const indent = start === -1 ? 0 : lines[start]!.search(/\S/);
  const end = start === -1 ? -1 : lines.findIndex((line, index) => index > start && line.trim() !== '' && line.search(/\S/) <= indent);
  const kept = start === -1 ? lines : [...lines.slice(0, start), ...(end === -1 ? [] : lines.slice(end))];
  return kept.some((line) => line.split(/[^\w.-]+/).includes(name));
}

/** The relational engines of a stack: a development stack with more than one tests the app against each (shlink). */
const RELATIONAL_ENGINE_REGEXES = [/postgres|postgis|pgvector|timescale/i, /mysql|mariadb|percona/i, /mssql|sqlserver|sql-edge/i, /cockroach/i];

/**
 * Services that the repository's own stack declares and the rules did not
 * explain: a datastore that an application service of the stack connects to,
 * of an engine that no rules finding and no rejection accounts for; or, in a
 * development stack, a second application service from the repository that
 * the selected app needs. It is a question, not a blocker: the app may not
 * need the service at runtime (a development cache, a search engine that a
 * setting turns off). The production stack's application services are
 * `checkDockerComposeMultiService`'s.
 */
export function checkUnexplainedDeclaredServices(tree: FileTree, context: DeclaredServiceContext): RejectionFinding {
  const explained = (entry: (typeof DECLARED_DATASTORES)[number]): boolean =>
    (entry.engine === 'postgres' && context.postgres) ||
    (entry.engine === 'mysql' && context.mysql) ||
    (entry.engine === 'redis' && context.redis) ||
    (entry.engine === 's3' && context.storage) ||
    context.rejectionReasons.some((reason) => entry.words.test(reason));
  const { files, production } = declaredStackFiles(tree);
  const selected = selectedDockerfile(tree)?.path;
  const found: string[] = [];
  for (const file of files) {
    // The production file's own reader also marks the services that a lighter production variant leaves out optional (Flagsmith).
    const compose = composeServices(tree);
    const services = (production && compose?.file === file ? compose.services : parseComposeServices(tree[file] ?? '')).filter((service) => !service.optional);
    const relational = RELATIONAL_ENGINE_REGEXES.filter((regex) => services.some((service) => service.image !== null && regex.test(service.image)));
    if (!production && relational.length > 1) continue;
    const apps = services.filter(
      (service) =>
        service.image === null ||
        (declaredEngineOf(service.image) === null && !INFRA_COMPOSE_IMAGE_REGEX.test(service.image) && !DATASTORE_TOOL_IMAGE_REGEX.test(service.image)),
    );
    for (const service of services) {
      const entry = service.image ? declaredEngineOf(service.image) : null;
      if (entry === null || explained(entry) || !apps.some((app) => namesService(app, service.name, production))) continue;
      found.push(`${service.name} (${service.image}) in ${file}`);
    }
    if (production || selected === undefined) continue;
    const app = services.find((service) => composeBuildDockerfile(file, service.build) === selected);
    if (!app) continue;
    for (const other of services) {
      const dockerfile = composeBuildDockerfile(file, other.build);
      if (other === app || dockerfile === null || dockerfile === selected) continue;
      if (other.command !== null && isWorkerServiceCommand(other.name, other.command)) continue;
      if (namesService(app, other.name, production)) found.push(`${other.name} (builds ${dockerfile}) in ${file}, which ${app.name} needs`);
    }
  }
  for (const [file, content] of Object.entries(tree)) {
    if (NON_STACK_COMPOSE_PATH_REGEX.test(file.slice(0, file.lastIndexOf('/') + 1)) || !content) continue;
    if (HELM_CHART_REGEX.test(file)) {
      for (const name of helmDependencies(content)) {
        const entry = declaredEngineOf(name);
        if (entry !== null && !explained(entry)) found.push(`${name} (a Helm dependency) in ${file}`);
      }
    } else if (ENV_SAMPLE_PATH_REGEX.test(file)) {
      for (const [, key, value] of content.matchAll(SAMPLE_CONNECTION_REGEX)) {
        // The rules' own PostgreSQL, MySQL, Redis and storage assessments already read the env samples.
        const entry = declaredEngineOf(`${key} ${value!.split('://')[0]}`);
        if (entry !== null && entry.engine === 'other' && !explained(entry)) found.push(`${key} in ${file}`);
      }
    }
  }
  if (found.length === 0) return { detected: false, dependency: 'none', reason: 'No unexplained declared service' };
  return {
    detected: true,
    dependency: 'unexplained-declared-service',
    reason: `Unconfirmed service: the repository declares ${found.join('; ')}. Deployz did not find how the application uses it.`,
  };
}
