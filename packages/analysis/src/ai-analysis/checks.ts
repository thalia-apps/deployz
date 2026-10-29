/**
 * Fixed checks for the AI answers. Each check is plain code over the evidence
 * pack the model saw and the repository tree, so the same answers always get
 * the same verdicts:
 *
 * - every cited line exists in the pack and contains its quote, and a cited
 *   line supports the claim (it names the port, the path, the setting, …);
 * - "optional by setting": a cited line reads the setting, and the value
 *   selects an engine that Deployz provides;
 * - "not used": no production source file imports or connects to the item;
 * - "required" for a declared service: a cited production source line names
 *   the service or its engine (a Compose file, an env sample or a document
 *   only declares it);
 * - the start command is the image's CMD/ENTRYPOINT or a script the CMD runs;
 * - the port agrees with the Dockerfile EXPOSE / ENV PORT / HEALTHCHECK, or
 *   the app reads PORT (Deployz sets PORT to the manifest port);
 * - the database variable is read on a cited production line, and its name
 *   says that it holds a whole connection URL or JDBC URL;
 * - a repository kind other than "application" has high confidence and a
 *   cited manifest line that packages the code for others to install, or for
 *   a datastore a cited production line that names its role or its protocol port;
 * - a low-confidence answer never passes.
 */
import { postgresSemantic } from '../bindings.js';
import { composeServices, listDockerfileCandidates, productionStageText, type FileTree } from '../detectors.js';
import type { BlockerAnswer, Confidence, Evidence, FactAnswer, SupportedEngine } from './analyst.js';
import { DATASTORE_ROLE, isProductionFile, PACKAGE_MANIFEST, PACKAGE_MARKER, packFiles, ROOT_README, startScripts, type EvidencePack, type Question } from './evidence-pack.js';
import type { BlockerItem } from './open-items.js';

export interface AnswerCheck {
  /** The question id. */
  readonly id: string;
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

export interface CheckContext {
  readonly pack: EvidencePack;
  readonly tree: FileTree;
  /** The rules' selected Dockerfile. */
  readonly dockerfile: string | null;
  /** The rules' database engine, for the migration answer. */
  readonly database: 'postgres' | 'mysql' | 'none';
}

type Supports = (line: string, path: string) => boolean;

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const word = (name: string): RegExp => new RegExp(`(?<![\\w-])${escape(name)}(?![\\w-])`);

/**
 * The cited line, if a window of the pack shows it and it contains the quote.
 * One line of tolerance either way absorbs an off-by-one count.
 */
export function citedLine(pack: EvidencePack, evidence: Evidence): string | null {
  const quote = normalize(evidence.quote);
  if (quote.length < 2) return null;
  for (const offset of [0, -1, 1]) {
    const number = evidence.line + offset;
    for (const file of packFiles(pack)) {
      if (file.path !== evidence.path) continue;
      const line = file.lines[number - file.start];
      if (line !== undefined && normalize(line).includes(quote)) return line;
    }
  }
  return null;
}

/** Every cited line must exist in the pack and contain its quote. */
function citationReasons(pack: EvidencePack, evidence: readonly Evidence[]): string[] {
  if (evidence.length === 0) return ['no evidence'];
  return evidence
    .filter((item) => citedLine(pack, item) === null)
    .map((item) => `${item.path}:${item.line} does not exist in the evidence or does not contain the quote`);
}

/**
 * Every cited line must exist and contain its quote; at least one of them must
 * support the claim. A citation is a reasoning chain (the ENTRYPOINT line and
 * the CMD line, a route and its mount point), so the other lines need not
 * repeat the value.
 */
export function checkEvidence(pack: EvidencePack, evidence: readonly Evidence[], supports: Supports): string[] {
  const reasons = citationReasons(pack, evidence);
  if (evidence.length === 0) return reasons;
  const supported = evidence.some((item) => {
    const line = citedLine(pack, item);
    return line !== null && supports(line, item.path);
  });
  if (!supported) reasons.push(`no cited line supports the claim (${evidence.map((item) => `${item.path}:${item.line}`).join(', ')})`);
  return reasons;
}

function confidenceReasons(confidence: Confidence): string[] {
  return confidence === 'low' ? ['low confidence'] : [];
}

function result(id: string, reasons: readonly string[]): AnswerCheck {
  return { id, ok: reasons.length === 0, reasons };
}

/** The longest token of a command: the part a citation most likely repeats. */
export function distinctiveToken(command: string): string {
  const tokens = command
    .replace(/["'[\],]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !/^(?:exec|sh|bash|-c|&&|run|npm|pnpm|yarn|bundle|python|python3|node|php|java|dotnet|mix)$/.test(token));
  return tokens.sort((a, b) => b.length - a.length)[0] ?? command.trim();
}

/** The line names the token, or the file name of a path token (`/usr/local/bin/entrypoint.sh` → `entrypoint.sh`). */
const mentions = (token: string): ((line: string) => boolean) => {
  const base = token.split('/').pop() ?? token;
  return (line) => line.includes(token) || (base.length >= 3 && line.includes(base));
};

// ── Production reach ───────────────────────────────────────────────────────

const DEPLOYMENT_FILE = /(?:^|\/)(?:Dockerfile[^/]*|[^/]*\.dockerfile|(?:docker-)?compose[^/]*\.ya?ml|\.env\.\w+|[^/]*\.md|[^/]*\.txt|LICENSE[^/]*)$/i;
/** Dependency manifests: a declared dependency is not an import. */
const MANIFEST = /(?:^|\/)(?:package\.json|composer\.json|Gemfile|pyproject\.toml|setup\.(?:py|cfg)|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|[^/]+\.csproj|mix\.exs|Cargo\.toml|deno\.jsonc?)$/i;

/** The production source files: production files that are not deployment files, documents or dependency manifests. */
function productionSources(tree: FileTree): string[] {
  return Object.keys(tree).filter((path) => isProductionFile(path) && !DEPLOYMENT_FILE.test(path) && !MANIFEST.test(path));
}

/** The first production source line that matches, as `path:line`. */
function firstMatch(tree: FileTree, matches: (line: string) => boolean): string | null {
  for (const path of productionSources(tree)) {
    for (const [index, line] of (tree[path] ?? '').split(/\r?\n/).entries()) {
      if (matches(line)) return `${path}:${index + 1}`;
    }
  }
  return null;
}

const IMPORT_LINE = /\b(?:import|require|from|use|using|include|alias|extern crate)\b/;
/** Connection strings and drivers of the datastores Deployz does not host. */
const DATASTORE_PATTERN: Record<string, RegExp> = {
  mongo: /mongo(?:db|ose)?\b|mongodb(?:\+srv)?:\/\//i,
  elastic: /elastic(?:search)?|opensearch/i,
  opensearch: /opensearch|elastic(?:search)?/i,
  clickhouse: /clickhouse|ecto_ch/i,
  sqlite: /sqlite|\.db["']|:memory:/i,
  mariadb: /mariadb/i,
  h2: /\bh2\b|jdbc:h2|h2database/i,
  cassandra: /cassandra/i,
  neo4j: /neo4j|bolt:\/\//i,
  couch: /couch/i,
  dynamo: /dynamo/i,
};

/** Any service name or engine word of a declared-service item, in any case. */
export function declaredServicePattern(item: BlockerItem): RegExp {
  return new RegExp(item.terms.map(escape).join('|') || '(?!)', 'i');
}

function datastorePattern(item: BlockerItem): RegExp {
  const engine = item.terms.find((term) => term in DATASTORE_PATTERN);
  return engine !== undefined ? DATASTORE_PATTERN[engine]! : word(item.dependency);
}

/** Reasons the item is used: a production import of the datastore, a production line that names the path or the service. */
function usedBy(ctx: CheckContext, item: BlockerItem): string[] {
  if (item.category === 'datastore') {
    const pattern = datastorePattern(item);
    const imported = firstMatch(ctx.tree, (line) => pattern.test(line) && (IMPORT_LINE.test(line) || /:\/\/|jdbc:|adapter|driver|dialect|client/i.test(line)));
    return imported !== null ? [`${imported} imports or connects to it`] : [];
  }
  if (item.category === 'declared_service') {
    const pattern = declaredServicePattern(item);
    const named = firstMatch(ctx.tree, (line) => pattern.test(line));
    return named !== null ? [`${named} names the service or its engine`] : [];
  }
  if (item.category === 'local_state') {
    const declared = item.terms.filter((term) => term.startsWith('/') || /^[A-Z][A-Z0-9_]{2,}$/.test(term)).filter((term) => !/^(?:STORAGE|FILESYSTEM_DISK|BUCKET)$/.test(term));
    if (declared.length === 0) return ['the finding names no path or variable to check'];
    const named = firstMatch(ctx.tree, (line) => declared.some((term) => (term.startsWith('/') ? line.includes(term) : word(term).test(line))));
    return named !== null ? [`${named} uses the declared path or variable`] : [];
  }
  // A second service of the production Compose file is not used only when it is a third-party image
  // (it does not build from this repository) and no production line names it as a host or a variable.
  const services = composeServices(ctx.tree)?.services ?? [];
  const listed = services.filter((service) => item.terms.includes(service.name));
  const built = listed.filter((service) => service.build);
  if (built.length !== 1) return ['exactly one listed service must build the app from this repository'];
  const others = listed.filter((service) => !service.build);
  if (others.length === 0) return ['no other listed service is a third-party image'];
  const reasons: string[] = [];
  for (const service of others) {
    const variable = service.name.toUpperCase().replace(/-/g, '_');
    const named = firstMatch(ctx.tree, (line) => word(service.name).test(line) || new RegExp(`\\b${escape(variable)}_`).test(line));
    if (named !== null) reasons.push(`${named} names the service ${service.name}`);
  }
  return reasons;
}

// ── Blocker answers ────────────────────────────────────────────────────────

/** The words that show the engine Deployz provides. MariaDB is not MySQL here: Deployz rejects it. */
export const ENGINE_PATTERN: Record<SupportedEngine, RegExp> = {
  postgres: /postgres|\bpg\b|pgsql|psql/i,
  mysql: /mysql/i,
  redis: /redis|valkey/i,
  s3: /\bs3\b|\baws\b|amazon/i,
};

/** The engines a setting may select for each blocker category. */
const ENGINES_FOR: Record<BlockerItem['category'], readonly SupportedEngine[]> = {
  datastore: ['postgres', 'mysql'],
  local_state: ['s3', 'postgres', 'mysql'],
  compose_service: ['postgres', 'mysql', 'redis', 's3'],
  declared_service: ['postgres', 'mysql', 'redis', 's3'],
};

/** A required declared service needs a cited production source line that uses it: the stack only declares it. */
function requiredDeclaredServiceReasons(ctx: CheckContext, question: BlockerItem, answer: BlockerAnswer): string[] {
  const pattern = declaredServicePattern(question);
  const sources = new Set(productionSources(ctx.tree));
  const used = answer.evidence.some((item) => {
    const line = citedLine(ctx.pack, item);
    return line !== null && sources.has(item.path) && pattern.test(line);
  });
  return [
    ...confidenceReasons(answer.confidence),
    ...citationReasons(ctx.pack, answer.evidence),
    ...(used ? [] : ['no cited production source line uses the service']),
  ];
}

export function checkBlocker(ctx: CheckContext, question: Question & BlockerItem, answer: BlockerAnswer): AnswerCheck {
  if (answer.answer === 'required') return result(question.id, question.category === 'declared_service' ? requiredDeclaredServiceReasons(ctx, question, answer) : []);
  const reasons = confidenceReasons(answer.confidence);
  if (answer.answer === 'not_used') {
    reasons.push(...citationReasons(ctx.pack, answer.evidence), ...usedBy(ctx, question));
    return result(question.id, reasons);
  }
  const { setting, settingValue, engine } = answer;
  if (setting === null || settingValue === null || engine === null) return result(question.id, [...reasons, 'a setting, its value and the engine are required']);
  if (!ENGINES_FOR[question.category].includes(engine)) reasons.push(`${engine} does not replace a ${question.category.replace('_', ' ')}`);
  const lines = answer.evidence.map((item) => citedLine(ctx.pack, item));
  reasons.push(...citationReasons(ctx.pack, answer.evidence));
  if (!lines.some((line) => line !== null && word(setting).test(line))) reasons.push(`no cited line reads ${setting}`);
  const selects =
    ENGINE_PATTERN[engine].test(settingValue) || lines.some((line) => line !== null && line.includes(settingValue) && ENGINE_PATTERN[engine].test(line));
  if (!selects) reasons.push(`no cited line shows that ${setting}=${settingValue} selects ${engine}`);
  return result(question.id, reasons);
}

// ── Port ───────────────────────────────────────────────────────────────────

/** The port signals of the production stage lineage: EXPOSE, ENV PORT, HEALTHCHECK. */
export function dockerfilePorts(content: string): number[] {
  const stage = productionStageText(content);
  const ports = new Set<number>();
  for (const match of stage.matchAll(/^\s*EXPOSE\s+([^\n]+)/gim)) {
    for (const token of match[1]!.split(/\s+/)) {
      const port = Number.parseInt(token, 10);
      if (Number.isInteger(port) && port > 0) ports.add(port);
    }
  }
  for (const match of stage.matchAll(/^\s*ENV\s+(?:[^\n]*\s)?PORT[=\s]+["']?(\d{2,5})/gim)) ports.add(Number(match[1]));
  for (const match of stage.matchAll(/^\s*HEALTHCHECK[^\n]*?(?:localhost|127\.0\.0\.1|0\.0\.0\.0)?:(\d{2,5})\b/gim)) ports.add(Number(match[1]));
  return [...ports];
}

const READS_PORT =
  /process\.env\.PORT\b|process\.env\[["']PORT["']\]|getenv\(\s*["']PORT["']|environ(?:\.get\()?\[?\s*["']PORT["']|ENV\[["']PORT["']\]|ENV\.fetch\(["']PORT["']|System\.get_env\(\s*["']PORT["']|System\.getenv\(\s*["']PORT["']|Deno\.env\.get\(\s*["']PORT["']|Bun\.env\.PORT|\$\{?PORT\b|ASPNETCORE_(?:URLS|HTTP_PORTS)|server\.port=\$\{PORT/;

function readsPort(pack: EvidencePack): boolean {
  return packFiles(pack).some((file) => file.lines.some((line) => READS_PORT.test(line)));
}

export function checkPort(ctx: CheckContext, id: string, port: number, answer: FactAnswer): AnswerCheck {
  const reasons = [
    ...confidenceReasons(answer.confidence),
    ...checkEvidence(ctx.pack, answer.evidence, (line) => new RegExp(`(?<!\\d)${port}(?!\\d)|\\bPORT\\b`).test(line)),
  ];
  const declared = ctx.dockerfile !== null ? dockerfilePorts(ctx.tree[ctx.dockerfile] ?? '') : [];
  if (declared.length > 0 && !declared.includes(port) && !readsPort(ctx.pack)) {
    reasons.push(`the Dockerfile declares ${declared.join(', ')} and the app does not read PORT`);
  }
  return result(id, reasons);
}

// ── Start command ──────────────────────────────────────────────────────────

/** An ENTRYPOINT or CMD argument as one command line: the exec form `["a", "b"]` joined, the shell form as written. */
function instructionCommand(argument: string): string {
  const text = argument.trim();
  if (text.startsWith('[')) {
    try {
      const parts = JSON.parse(text) as unknown;
      if (Array.isArray(parts) && parts.every((part) => typeof part === 'string')) return parts.join(' ');
    } catch {
      return text;
    }
  }
  return text;
}

/** The production stage's ENTRYPOINT and CMD (the last of each), with line continuations joined. */
export function imageCommand(dockerfile: string): { entrypoint: string | null; cmd: string | null } {
  const stage = productionStageText(dockerfile);
  const last = (name: string): string | null => {
    const matches = [...stage.matchAll(new RegExp(`^\\s*${name}\\s+(.+)$`, 'gim'))];
    const argument = matches[matches.length - 1]?.[1];
    return argument === undefined ? null : instructionCommand(argument);
  };
  return { entrypoint: last('ENTRYPOINT'), cmd: last('CMD') };
}

const flat = (command: string): string => normalize(command.replace(/["']/g, ''));

/** The package.json script that a `npm|yarn|pnpm|bun [run] <name>` command runs. */
function packageScript(tree: FileTree, dockerfile: string, command: string): string | null {
  const name = command.match(/^(?:exec\s+)?(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?([\w:.-]+)\s*$/)?.[1];
  if (name === undefined) return null;
  const directory = dockerfile.includes('/') ? dockerfile.slice(0, dockerfile.lastIndexOf('/') + 1) : '';
  for (const path of [`${directory}package.json`, 'package.json']) {
    try {
      const scripts = (JSON.parse(tree[path] ?? '{}') as { scripts?: Record<string, unknown> }).scripts ?? {};
      const script = scripts[name];
      if (typeof script === 'string') return script;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * The start command is the image's own command: its CMD, its ENTRYPOINT, the
 * two together, or a script that the CMD runs (a package.json script, or the
 * script file that the CMD or the ENTRYPOINT starts).
 */
export function isImageStartCommand(tree: FileTree, dockerfile: string | null, command: string): boolean {
  if (dockerfile === null) return false;
  const { entrypoint, cmd } = imageCommand(tree[dockerfile] ?? '');
  const given = flat(command);
  const forms = [cmd, entrypoint, entrypoint !== null && cmd !== null ? `${entrypoint} ${cmd}` : null].filter((form): form is string => form !== null);
  if (forms.some((form) => flat(form) === given)) return true;
  if (forms.some((form) => { const script = packageScript(tree, dockerfile, flat(form)); return script !== null && flat(script) === given; })) return true;
  // A command that runs a script file the image command names (`sh scripts/start.sh`, `./docker-entrypoint.sh`).
  const scripts = startScripts(dockerfile, tree).map((path) => path.split('/').pop()!);
  const file = given.match(/^(?:exec\s+)?(?:(?:ba)?sh\s+)?(\S+\.(?:sh|bash))\b/)?.[1]?.split('/').pop();
  return file !== undefined && scripts.includes(file) && forms.some((form) => form.includes(file));
}

function checkStartCommand(ctx: CheckContext, id: string, command: string, answer: FactAnswer): AnswerCheck {
  const reasons = confidenceReasons(answer.confidence);
  if (!isImageStartCommand(ctx.tree, ctx.dockerfile, command)) reasons.push('it is not the image CMD or ENTRYPOINT, or a script that the CMD runs');
  return result(id, reasons);
}

// ── The other facts ────────────────────────────────────────────────────────

// A line that serves the root page: the request pipeline or route table of a server-rendered app (`app.UseOqtane(...)`, `app.MapRazorPages()`, `urlpatterns`).
const SERVES_ROOT = /\.(?:Map|Use)\w*\(|\.Run\(\)|\burlpatterns\b|\broutes?\b|\brouter\b/i;
const MIGRATION = /migrat|upgrade|db:prepare|db\s+push|ecto|alembic|flyway|liquibase|schema/i;

function simple(id: string, ctx: CheckContext, answer: FactAnswer, supports: Supports): AnswerCheck {
  return result(id, [...confidenceReasons(answer.confidence), ...checkEvidence(ctx.pack, answer.evidence, supports)]);
}

export interface DockerfileValue {
  readonly path: string;
  readonly context: string;
}

function checkDockerfile(ctx: CheckContext, id: string, value: DockerfileValue, answer: FactAnswer): AnswerCheck {
  const reasons = [...confidenceReasons(answer.confidence)];
  if (!Object.prototype.hasOwnProperty.call(ctx.tree, value.path)) reasons.push(`${value.path} does not exist`);
  else if (!listDockerfileCandidates(ctx.tree).includes(value.path)) reasons.push(`${value.path} is not a Dockerfile candidate`);
  const contextDir = value.context.replace(/^\.\/?/, '').replace(/\/$/, '');
  if (contextDir !== '' && !Object.keys(ctx.tree).some((file) => file.startsWith(`${contextDir}/`))) {
    reasons.push(`the build context ${value.context} does not exist`);
  }
  return result(id, reasons);
}

export interface MigrationValue {
  readonly mode: 'startup' | 'pre_deploy' | 'none';
  readonly command: string | null;
}

/** The files on the image's start path: the Dockerfile, the scripts it starts, and a Procfile. */
function startPathFiles(ctx: CheckContext): Set<string> {
  const files = new Set<string>(startScripts(ctx.dockerfile ?? undefined, ctx.tree));
  if (ctx.dockerfile !== null) files.add(ctx.dockerfile);
  for (const path of Object.keys(ctx.tree)) if (/(?:^|\/)Procfile$/.test(path)) files.add(path);
  return files;
}

function checkMigration(ctx: CheckContext, id: string, value: MigrationValue, answer: FactAnswer): AnswerCheck {
  const { mode, command } = value;
  if (mode === 'none') return result(id, ctx.database === 'none' ? [] : ['mode none with a database needs a vendor decision']);
  if (mode === 'pre_deploy' && command === null) return result(id, ['pre_deploy without a command']);
  const token = command !== null ? distinctiveToken(command) : null;
  // A migration flag of the binary (`-migrate`, `--upgrade`), as the line that defines the flag names it.
  const migrationWords = (command ?? '')
    .split(/\s+/)
    .filter((part) => part.startsWith('-'))
    .map((part) => part.replace(/^-+/, '').replace(/=.*$/, ''))
    .filter((part) => part.length >= 3 && MIGRATION.test(part));
  // A cited line of the script file that the command runs (`python3 manage.py migrate` cites manage.py).
  const script = token?.split('/').pop();
  const runsScript = (path: string) => script !== undefined && script.includes('.') && MIGRATION.test(command ?? '') && path.split('/').pop() === script;
  const supports: Supports =
    token === null ? (line) => MIGRATION.test(line) : (line, path) => mentions(token)(line) || migrationWords.some((part) => line.includes(part)) || runsScript(path);
  const check = simple(id, ctx, answer, supports);
  // Arguments added to a package script (`npm run alteration deploy`) must be shown by a cited line:
  // an invented or incomplete argument fails the migration, and the deployment stops before the app starts.
  const added = command === null ? undefined : /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[\w:.@/-]+\s+(?:--\s+)?(\S.*)$/.exec(command.trim())?.[1];
  if (added !== undefined && !answer.evidence.some((item) => normalize(citedLine(ctx.pack, item) ?? '').includes(normalize(added)))) {
    return result(id, [...check.reasons, `no cited line shows the script arguments "${added}"`]);
  }
  if (mode !== 'startup') return check;
  // A migration at start is shown on the start path or in the app's own boot code or configuration,
  // never in a dev script, a test or a README. A dependency manifest is context: it shows the migration
  // only for Spring Boot with Flyway or Liquibase, which migrate at start by themselves.
  const allowed = new Set([...startPathFiles(ctx), ...productionSources(ctx.tree)]);
  const reasons = answer.evidence
    .filter((item) => !allowed.has(item.path) && !MANIFEST.test(item.path))
    .map((item) => `${item.path} is not on the image start path or in the app's boot code`);
  const shown = answer.evidence.some((item) => {
    const line = citedLine(ctx.pack, item);
    return line !== null && supports(line, item.path) && (allowed.has(item.path) || springBootMigrates(ctx.tree, item.path, line));
  });
  if (check.ok && !shown) reasons.push("no cited line on the image start path or in the app's boot code runs the migration");
  return reasons.length === 0 ? check : result(id, [...check.reasons, ...reasons]);
}

const MIGRATION_OFF = /(?:flyway|liquibase)\.enabled\s*[=:]\s*["']?false|(?:flyway|liquibase):[ \t]*\r?\n(?:[ \t]+[^\n]*\n){0,5}?[ \t]+enabled:[ \t]*["']?false/i;

/** A Spring Boot build that declares Flyway or Liquibase on the cited line, and no production setting that turns it off. */
function springBootMigrates(tree: FileTree, path: string, line: string): boolean {
  if (!/(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?)$/.test(path) || !/flyway|liquibase/i.test(line)) return false;
  if (!/spring-boot|org\.springframework\.boot/.test(tree[path] ?? '')) return false;
  return !productionSources(tree).some((source) => MIGRATION_OFF.test(tree[source] ?? ''));
}

/** The binding format of a database variable, from its name: only a whole connection (a URL or a JDBC URL). */
export function databaseVariableSemantic(name: string): 'url' | 'jdbc_url' | null {
  const semantic = postgresSemantic(name);
  return semantic === 'url' || semantic === 'jdbc_url' ? semantic : null;
}

/** A line that reads an environment variable or interpolates one into configuration. */
const READS_VARIABLE = /process\.env|getenv|environ|ENV\[|ENV\.fetch|System\.(?:get|fetch)_?env|Environment\.GetEnvironmentVariable|os\.Getenv|std::env|env::var|\benv\(|\$\{\w/i;

function checkDatabaseVariable(ctx: CheckContext, id: string, name: string, answer: FactAnswer): AnswerCheck {
  const reasons = confidenceReasons(answer.confidence);
  if (databaseVariableSemantic(name) === null) reasons.push(`${name} does not name a database URL or JDBC URL`);
  const sources = new Set(productionSources(ctx.tree));
  reasons.push(...checkEvidence(ctx.pack, answer.evidence, (line, path) => sources.has(path) && word(name).test(line) && READS_VARIABLE.test(line)));
  return result(id, reasons);
}

// ── Repository kind ────────────────────────────────────────────────────────

export const REPOSITORY_KINDS = ['application', 'datastore', 'library', 'framework', 'sdk', 'cli'] as const;
export type RepositoryKind = (typeof REPOSITORY_KINDS)[number];

/**
 * A repository that is not an application changes the outcome to "not
 * deployable", the costliest wrong answer: it needs a cited packaging line
 * of a manifest, or for a datastore a cited production line that names its
 * role or the client port of its protocol. "application" changes nothing.
 */
function checkRepositoryKind(ctx: CheckContext, id: string, kind: RepositoryKind, answer: FactAnswer): AnswerCheck {
  if (kind === 'application') return result(id, []);
  const reasons = confidenceReasons(answer.confidence);
  // A README sentence wraps ("open source relational" / "databases."): a README line supports the role
  // when it and the lines next to it name it.
  const readmeRoleLines = new Set(
    packFiles(ctx.pack)
      .filter((file) => ROOT_README.test(file.path))
      .flatMap((file) => file.lines.filter((line, index) => DATASTORE_ROLE.test(file.lines.slice(Math.max(0, index - 1), index + 2).join(' ').replace(/\s+/g, ' ')))),
  );
  const supports =
    kind === 'datastore'
      ? (line: string, path: string) => (isProductionFile(path) && DATASTORE_ROLE.test(line)) || (ROOT_README.test(path) && readmeRoleLines.has(line))
      : (line: string, path: string) => PACKAGE_MANIFEST.test(path) && PACKAGE_MARKER.test(line);
  reasons.push(...checkEvidence(ctx.pack, answer.evidence, supports));
  return result(id, reasons);
}

/** A fact answer's value in its typed shape, or null when it does not parse. */
export function factValue(question: Question, value: string): number | string | DockerfileValue | MigrationValue | null {
  if (question.kind !== 'fact') return null;
  switch (question.fact) {
    case 'port': {
      const port = Number(value);
      return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
    }
    case 'healthPath':
      return value.startsWith('/') && value.length <= 200 ? value : null;
    case 'startCommand':
      return value.trim().length > 0 ? value.trim() : null;
    case 'databaseVariable':
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.trim()) ? value.trim() : null;
    case 'repositoryKind':
      return (REPOSITORY_KINDS as readonly string[]).includes(value.trim()) ? value.trim() : null;
    case 'dockerfile':
    case 'migration': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        return null;
      }
      const record = (parsed ?? {}) as Record<string, unknown>;
      if (question.fact === 'dockerfile') {
        return typeof record['path'] === 'string' && typeof record['context'] === 'string' ? { path: record['path'], context: record['context'] } : null;
      }
      const mode = record['mode'];
      const command = record['command'];
      return (mode === 'startup' || mode === 'pre_deploy' || mode === 'none') && (command === null || (typeof command === 'string' && command.length > 0))
        ? { mode, command: command as string | null }
        : null;
    }
  }
}

export function checkFact(ctx: CheckContext, question: Question, answer: FactAnswer): AnswerCheck {
  if (question.kind !== 'fact' || answer.value === null) return result(answer.id, []);
  const value = factValue(question, answer.value);
  if (value === null) return result(answer.id, [`${answer.value} is not a valid ${question.fact}`]);
  switch (question.fact) {
    case 'port':
      return checkPort(ctx, answer.id, value as number, answer);
    case 'startCommand':
      return checkStartCommand(ctx, answer.id, value as string, answer);
    case 'healthPath': {
      const path = value as string;
      const last = path.split('/').filter(Boolean).pop() ?? path;
      return simple(answer.id, ctx, answer, (line) => line.includes(path) || (last.length >= 3 && line.includes(last)) || (path === '/' && SERVES_ROOT.test(line)));
    }
    case 'dockerfile':
      return checkDockerfile(ctx, answer.id, value as DockerfileValue, answer);
    case 'migration':
      return checkMigration(ctx, answer.id, value as MigrationValue, answer);
    case 'databaseVariable':
      return checkDatabaseVariable(ctx, answer.id, value as string, answer);
    case 'repositoryKind':
      return checkRepositoryKind(ctx, answer.id, value as RepositoryKind, answer);
  }
}

/** Check every answer. An answer to an unknown question is never in the output (`fromWire` refuses it). */
export function checkAnswers(ctx: CheckContext, blockers: readonly BlockerAnswer[], facts: readonly FactAnswer[]): AnswerCheck[] {
  const questionOf = (id: string) => ctx.pack.questions.find((question) => question.id === id)!;
  return [
    ...blockers.map((answer) => checkBlocker(ctx, questionOf(answer.id) as Question & BlockerItem, answer)),
    ...facts.map((answer) => checkFact(ctx, questionOf(answer.id), answer)),
  ];
}
