/**
 * Fixed checks for the AI facts. Each check is plain code over the evidence
 * pack the model saw, so the same facts always get the same verdicts:
 *
 * - every cited line exists in the pack and contains its quote, and the line
 *   supports the claim (it names the port, the path, the variable, …);
 * - a required variable is an unguarded read with no default;
 * - the port agrees with the Dockerfile EXPOSE / ENV PORT / HEALTHCHECK, or
 *   the app reads PORT (Deployz sets PORT to the manifest port);
 * - a low-confidence fact never passes.
 *
 * The rejections are not checked here: `merge.ts` never changes them.
 */
import { listDockerfileCandidates, type FileTree } from '../detectors.js';
import type { AnalystOutput, Confidence, Evidence, FactName } from './analyst.js';
import { startScripts, type EvidencePack } from './evidence-pack.js';

export interface FactCheck {
  readonly fact: FactName;
  /** The worker id or variable name for a per-item fact. */
  readonly subject: string | null;
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

export interface CheckContext {
  readonly pack: EvidencePack;
  readonly tree: FileTree;
}

type Supports = (line: string) => boolean;

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function packLines(pack: EvidencePack, path: string): readonly string[] | undefined {
  return pack.files.find((file) => file.path === path)?.lines;
}

/**
 * The cited line, if the pack has it and it contains the quote. One line of
 * tolerance either way absorbs an off-by-one count; the line returned is the
 * one that holds the quote.
 */
export function citedLine(pack: EvidencePack, evidence: Evidence): string | null {
  const lines = packLines(pack, evidence.path);
  if (lines === undefined) return null;
  const quote = normalize(evidence.quote);
  if (quote.length < 2) return null;
  for (const offset of [0, -1, 1]) {
    const line = lines[evidence.line - 1 + offset];
    if (line !== undefined && normalize(line).includes(quote)) return line;
  }
  return null;
}

/** Every evidence item must resolve to a pack line that supports the claim; at least one is needed. */
/**
 * Every cited line must exist and contain its quote; at least one of them must
 * support the claim. A citation is a reasoning chain (the ENTRYPOINT line and
 * the CMD line, a route and its mount point), so the other lines need not
 * repeat the value.
 */
export function checkEvidence(pack: EvidencePack, evidence: readonly Evidence[], supports: Supports): string[] {
  if (evidence.length === 0) return ['no evidence'];
  const reasons: string[] = [];
  let supported = false;
  for (const item of evidence) {
    const line = citedLine(pack, item);
    if (line === null) reasons.push(`${item.path}:${item.line} does not exist in the evidence or does not contain the quote`);
    else if (supports(line)) supported = true;
  }
  if (!supported) reasons.push(`no cited line supports the claim (${evidence.map((item) => `${item.path}:${item.line}`).join(', ')})`);
  return reasons;
}

function confidenceReasons(confidence: Confidence): string[] {
  return confidence === 'low' ? ['low confidence'] : [];
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
const mentions = (token: string): Supports => {
  const base = token.split('/').pop() ?? token;
  return (line) => line.includes(token) || (base.length >= 3 && line.includes(base));
};

// ── Required variables ─────────────────────────────────────────────────────

/** A default or a presence check right after the name: `|| x`, `?? x`, `, default`, `:-x`, `or x`. */
const DEFAULT_AFTER = /^["'\]\s)]{0,4}\s*(?:\|\||\?\?|\?:|:-|:=|\bor\b|,\s*[^\s)\]])/;
/** A presence check before the name on the same line. */
const GUARD_BEFORE = /\b(?:if|unless|when|isset|has|exists|in)\b|\?\.|\bhas_key\b/;

/** True when `line` reads `name` with a default or behind a presence check. */
export function guardedRead(line: string, name: string): boolean {
  const pattern = new RegExp(`\\b${escape(name)}\\b`, 'g');
  for (const match of line.matchAll(pattern)) {
    const after = line.slice(match.index + name.length);
    const before = line.slice(0, match.index);
    if (DEFAULT_AFTER.test(after) || GUARD_BEFORE.test(before)) return true;
  }
  return false;
}

/** Any pack line (outside env samples) that reads `name` with a default or a guard. */
export function guardedAnywhere(pack: EvidencePack, name: string): string | null {
  for (const file of pack.files) {
    if (/(?:^|\/)\.env\.\w+$/.test(file.path)) continue;
    for (const [index, line] of file.lines.entries()) {
      if (line.includes(name) && guardedRead(line, name)) return `${file.path}:${index + 1}`;
    }
  }
  return null;
}

export function checkRequiredVariable(ctx: CheckContext, variable: AnalystOutput['requiredVariables'][number]): FactCheck {
  const reasons = [
    ...confidenceReasons(variable.confidence),
    ...checkEvidence(ctx.pack, variable.evidence, (line) => new RegExp(`\\b${escape(variable.name)}\\b`).test(line) && !guardedRead(line, variable.name)),
  ];
  const guarded = guardedAnywhere(ctx.pack, variable.name);
  if (guarded !== null) reasons.push(`${guarded} reads it with a default or a guard`);
  return { fact: 'requiredVariables', subject: variable.name, ok: reasons.length === 0, reasons };
}

// ── Port ───────────────────────────────────────────────────────────────────

/** The port signals of the production stage (after the last FROM): EXPOSE, ENV PORT, HEALTHCHECK. */
export function dockerfilePorts(content: string): number[] {
  const stages = content.split(/^\s*FROM\s/im);
  const stage = stages[stages.length - 1] ?? '';
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
  return pack.files.some((file) => file.lines.some((line) => READS_PORT.test(line)));
}

export function checkPort(ctx: CheckContext, port: AnalystOutput['port'], dockerfile: string | null): FactCheck {
  if (port.value === null) return { fact: 'port', subject: null, ok: true, reasons: [] };
  const value = port.value;
  const reasons = [
    ...confidenceReasons(port.confidence),
    ...checkEvidence(ctx.pack, port.evidence, (line) => new RegExp(`(?<!\\d)${value}(?!\\d)|\\bPORT\\b`).test(line)),
  ];
  const declared = dockerfile !== null ? dockerfilePorts(ctx.tree[dockerfile] ?? '') : [];
  if (declared.length > 0 && !declared.includes(value) && !readsPort(ctx.pack)) {
    reasons.push(`the Dockerfile declares ${declared.join(', ')} and the app does not read PORT`);
  }
  return { fact: 'port', subject: null, ok: reasons.length === 0, reasons };
}

// ── The other facts ────────────────────────────────────────────────────────

const POSTGRES = /postgres|\bpg\b|psycopg|pgx|lib\/pq|npgsql|postgrex|jdbc:postgresql|pdo_pgsql|asyncpg|sequelize|prisma|typeorm|knex|DATABASE_URL/i;
const MYSQL = /mysql|mariadb|pdo_mysql|myxql|jdbc:mysql/i;
const NO_DATABASE = /sqlite|in[-_ ]?memory|\bh2\b|embedded|nedb|bolt|badger/i;
// A line that serves the root page: the request pipeline or route table of a server-rendered app (`app.UseOqtane(...)`, `app.MapRazorPages()`, `urlpatterns`).
const SERVES_ROOT = /\.(?:Map|Use)\w*\(|\.Run\(\)|\burlpatterns\b|\broutes?\b|\brouter\b/i;
const REDIS = /redis|valkey|bullmq|\bbull\b|sidekiq|celery|\brq\b|resque|horizon/i;
const OPTIONAL = /optional|enabled|disable|default|\bif\b|unless|\|\||\?\?|false|null|nil|None|local|file|disk|memory/i;
const STORAGE = /\bs3\b|aws-sdk|boto|minio|bucket|ex_aws|flysystem|active_?storage|object.?storage|storage/i;
const MIGRATION = /migrat|upgrade|db:prepare|db\s+push|ecto|alembic|flyway|liquibase|schema/i;

function checkDockerfile(ctx: CheckContext, dockerfile: AnalystOutput['dockerfile']): FactCheck {
  if (dockerfile.value === null) return { fact: 'dockerfile', subject: null, ok: true, reasons: [] };
  const { path, context } = dockerfile.value;
  const reasons = [...confidenceReasons(dockerfile.confidence)];
  if (!Object.prototype.hasOwnProperty.call(ctx.tree, path)) reasons.push(`${path} does not exist`);
  else if (!listDockerfileCandidates(ctx.tree).includes(path)) reasons.push(`${path} is not a Dockerfile candidate`);
  const contextDir = context.replace(/^\.\/?/, '').replace(/\/$/, '');
  if (contextDir !== '' && !Object.keys(ctx.tree).some((file) => file.startsWith(`${contextDir}/`))) {
    reasons.push(`the build context ${context} does not exist`);
  }
  return { fact: 'dockerfile', subject: null, ok: reasons.length === 0, reasons };
}

function simple(fact: FactName, ctx: CheckContext, item: { confidence: Confidence; evidence: Evidence[] }, supports: Supports): FactCheck {
  const reasons = [...confidenceReasons(item.confidence), ...checkEvidence(ctx.pack, item.evidence, supports)];
  return { fact, subject: null, ok: reasons.length === 0, reasons };
}

function checkDatabase(ctx: CheckContext, database: AnalystOutput['database']): FactCheck {
  const supports = database.value === 'postgres' ? POSTGRES : database.value === 'mysql' ? MYSQL : NO_DATABASE;
  return simple('database', ctx, database, (line) => supports.test(line));
}

/** The files on the image's start path: the Dockerfile, the scripts it starts, and a Procfile. */
function startPathFiles(ctx: CheckContext, dockerfile: string | null): Set<string> {
  const files = new Set<string>(startScripts(dockerfile ?? undefined, ctx.tree));
  if (dockerfile !== null) files.add(dockerfile);
  for (const path of Object.keys(ctx.tree)) if (/(?:^|\/)Procfile$/.test(path)) files.add(path);
  return files;
}

function checkMigration(
  ctx: CheckContext,
  migration: AnalystOutput['migration'],
  database: AnalystOutput['database']['value'],
  dockerfile: string | null,
): FactCheck {
  const { mode, command } = migration.value;
  if (mode === 'unknown' && command === null) return { fact: 'migration', subject: null, ok: true, reasons: [] };
  if (mode === 'none') {
    const ok = database === 'none';
    return { fact: 'migration', subject: null, ok, reasons: ok ? [] : ['mode none with a database needs a vendor decision'] };
  }
  if (mode === 'pre_deploy' && command === null) {
    return { fact: 'migration', subject: null, ok: false, reasons: ['pre_deploy without a command'] };
  }
  const token = command !== null ? distinctiveToken(command) : null;
  // A migration flag of the binary (`-migrate`, `--upgrade`), as the line that defines the flag names it.
  const migrationWords = (command ?? '')
    .split(/\s+/)
    .filter((part) => part.startsWith('-'))
    .map((part) => part.replace(/^-+/, '').replace(/=.*$/, ''))
    .filter((part) => part.length >= 3 && MIGRATION.test(part));
  const supports = token === null ? (line: string) => MIGRATION.test(line) : (line: string) => mentions(token)(line) || migrationWords.some((word) => line.includes(word));
  const check = simple('migration', ctx, migration, supports);
  if (mode !== 'startup') return check;
  // A migration at start must be on the start path, not in a dev script or a README.
  const startPath = startPathFiles(ctx, dockerfile);
  const offPath = migration.evidence.filter((item) => !startPath.has(item.path)).map((item) => `${item.path} is not on the image start path`);
  return offPath.length === 0 ? check : { ...check, ok: false, reasons: [...check.reasons, ...offPath] };
}

/** Check every analyst fact. The order follows `FACT_NAMES`, then one entry per worker and per variable. */
export function checkFacts(ctx: CheckContext, output: AnalystOutput, fallbackDockerfile: string | null): FactCheck[] {
  const dockerfile = checkDockerfile(ctx, output.dockerfile);
  const selected = dockerfile.ok && output.dockerfile.value !== null ? output.dockerfile.value.path : fallbackDockerfile;
  const checks: FactCheck[] = [
    dockerfile,
    checkPort(ctx, output.port, selected),
    output.startCommand.value === null
      ? { fact: 'startCommand', subject: null, ok: true, reasons: [] }
      : simple('startCommand', ctx, output.startCommand, mentions(distinctiveToken(output.startCommand.value))),
    output.healthPath.value === null
      ? { fact: 'healthPath', subject: null, ok: true, reasons: [] }
      : simple('healthPath', ctx, output.healthPath, (line) => {
          const path = output.healthPath.value!;
          const last = path.split('/').filter(Boolean).pop() ?? path;
          return line.includes(path) || (last.length >= 3 && line.includes(last)) || (path === '/' && SERVES_ROOT.test(line));
        }),
    checkDatabase(ctx, output.database),
    simple('redis', ctx, output.redis, (line) => REDIS.test(line) && (output.redis.value || OPTIONAL.test(line))),
    simple('storage', ctx, output.storage, (line) => (output.storage.value ? STORAGE.test(line) : OPTIONAL.test(line))),
    checkMigration(ctx, output.migration, output.database.value, selected),
  ];
  const workerIds = new Set<string>();
  for (const worker of output.workers) {
    const reasons = [...confidenceReasons(worker.confidence), ...checkEvidence(ctx.pack, worker.evidence, mentions(distinctiveToken(worker.command)))];
    if (workerIds.has(worker.id)) reasons.push('duplicate worker id');
    workerIds.add(worker.id);
    checks.push({ fact: 'workers', subject: worker.id, ok: reasons.length === 0, reasons });
  }
  for (const variable of output.requiredVariables) checks.push(checkRequiredVariable(ctx, variable));
  return checks;
}
