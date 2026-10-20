/**
 * Merges the checked AI facts into the rules Analysis. Per fact:
 *
 * - the AI agrees with the rules: nothing changes (`agree`);
 * - the AI differs and its fact passes the checks: the AI value enters (`ai`);
 * - the AI differs and its fact fails, or the reviewer's objection stayed
 *   open: the fact becomes a vendor question (`question`) when the manifest
 *   has a question for it (port, start command, health path, migration
 *   command, required variable). For the other facts the rules value stays
 *   (`rules`): it is deterministic evidence, not a guess.
 *
 * A resource fact (database, Redis, storage) re-runs `analyseRepo` with the
 * override, so everything derived from it comes from the same rules. The
 * rejections and the unsupported reasons are never changed.
 */
import { analyseRepo, type AnalysisResult, type ResourceOverrides } from '../analyser.js';
import { isDerivedS3EnvVariable, postgresSemantic } from '../bindings.js';
import { isDerivedUrlEnvVariable } from '../derived-url.js';
import { isGeneratableSecretName, isTaskRoleCredentialName } from '../env-classification.js';
import { resolveRedisEnvBindings } from '../redis.js';
import type { DetectorFinding, FileTree } from '../detectors.js';
import type { AnalystOutput, FactName } from './analyst.js';
import { guardedAnywhere, type FactCheck } from './checks.js';
import type { EvidencePack } from './evidence-pack.js';

export type FactDecision = 'agree' | 'ai' | 'question' | 'rules';

export interface MergedFact {
  readonly fact: FactName;
  readonly subject: string | null;
  readonly decision: FactDecision;
  readonly value: unknown;
  readonly reasons: readonly string[];
}

export interface MergeInput {
  readonly tree: FileTree;
  readonly rules: AnalysisResult;
  readonly pack: EvidencePack;
  readonly facts: AnalystOutput;
  readonly checks: readonly FactCheck[];
  /** Facts the reviewer objected to without a confirmed correction. */
  readonly questions: ReadonlyArray<{ fact: FactName; subject: string | null; reason: string }>;
}

export interface WorkerCommand {
  readonly id: string;
  readonly command: string;
  readonly source: string;
}

export interface MergeResult {
  readonly analysis: AnalysisResult;
  /** Markers for the API: `migrationCommand`, `noMigration` and `workers` when the AI decided them. */
  readonly aiResolved: readonly string[];
  /** The AI migration command to qualify, or the open question when it was not verified. */
  readonly migration: { readonly command: string } | { readonly candidate: string; readonly reason: string } | null;
  /** The worker list when the AI changed it. */
  readonly workers: readonly WorkerCommand[] | null;
  readonly facts: readonly MergedFact[];
}

type Meta = Record<string, unknown>;

function rulesDatabase(meta: Meta): 'postgres' | 'mysql' | 'none' {
  if ((meta['postgres'] as { required?: unknown } | undefined)?.required === true) return 'postgres';
  if ((meta['mysql'] as { required?: unknown } | undefined)?.required === true) return 'mysql';
  return 'none';
}

function rulesPort(meta: Meta): number | null {
  return typeof meta['port'] === 'string' ? Number.parseInt(meta['port'], 10) || null : null;
}

function firstString(value: unknown): string | null {
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

function rulesWorkers(meta: Meta): WorkerCommand[] {
  const raw = meta['resolvedWorkerCommands'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const record = entry as Record<string, unknown>;
    return typeof record['id'] === 'string' && typeof record['command'] === 'string'
      ? [{ id: record['id'], command: record['command'], source: typeof record['source'] === 'string' ? record['source'] : 'repository' }]
      : [];
  });
}

const CLIENT_BUILD_VARIABLE = /^(?:NEXT_PUBLIC|VITE|REACT_APP|NUXT_PUBLIC|PUBLIC|EXPO_PUBLIC|GATSBY)_/;

/**
 * True when the deterministic rules say Deployz supplies this variable: a
 * secret it mints, a binding of a provisioned database, cache or bucket, the
 * app's own URL, or PORT/HOSTNAME. Such a variable never becomes the vendor's.
 */
function deployzProvides(name: string, meta: Meta, evidencePaths: readonly string[]): boolean {
  if (name === 'PORT' || name === 'HOSTNAME' || isGeneratableSecretName(name) || isTaskRoleCredentialName(name)) return true;
  // Inlined into the client bundle at build time: the running server never needs it.
  if (CLIENT_BUILD_VARIABLE.test(name)) return true;
  const variable = { key: name, required: true, secret: false, source: evidencePaths.map((path) => `read in ${path}`) };
  if (isDerivedUrlEnvVariable(variable)) return true;
  if (rulesDatabase(meta) !== 'none' && postgresSemantic(name) !== null) return true;
  const redis = meta['redis'] as { required?: unknown; connectionEnvVars?: unknown } | undefined;
  const redisNames = Array.isArray(redis?.connectionEnvVars) ? (redis.connectionEnvVars as string[]) : [];
  if (redis?.required === true && resolveRedisEnvBindings(redisNames).some((binding) => binding.name === name)) return true;
  return meta['usesS3'] === true && isDerivedS3EnvVariable(variable);
}

function replaceFinding(findings: DetectorFinding[], detector: string, patch: Partial<DetectorFinding>): DetectorFinding[] {
  const index = findings.findIndex((finding) => finding.detector === detector);
  const base: DetectorFinding = index >= 0 ? findings[index]! : { detector, detected: false };
  const next = { ...base, ...patch };
  return index >= 0 ? findings.map((finding, i) => (i === index ? next : finding)) : [...findings, next];
}

export function mergeAiFacts(input: MergeInput): MergeResult {
  const { tree, rules, pack, facts, checks, questions } = input;
  const decisions: MergedFact[] = [];
  const checkOf = (fact: FactName, subject: string | null = null) =>
    checks.find((check) => check.fact === fact && check.subject === subject) ?? { ok: false, reasons: ['not checked'] };
  const questionOf = (fact: FactName, subject: string | null = null) =>
    questions.find((question) => question.fact === fact && question.subject === subject);

  /** The decision for a fact, given whether the AI value differs from the rules and whether the manifest can ask. */
  const decide = (fact: FactName, differs: boolean, canAsk: boolean, subject: string | null = null): { decision: FactDecision; reasons: string[] } => {
    const objection = questionOf(fact, subject);
    const check = checkOf(fact, subject);
    if (!differs && objection === undefined) return { decision: 'agree', reasons: [] };
    if (differs && check.ok && objection === undefined) return { decision: 'ai', reasons: [] };
    const reasons = [...(objection ? [`reviewer: ${objection.reason}`] : []), ...(differs ? check.reasons : [])];
    return { decision: canAsk ? 'question' : 'rules', reasons };
  };
  const record = (fact: FactName, value: unknown, outcome: { decision: FactDecision; reasons: string[] }, subject: string | null = null): FactDecision => {
    decisions.push({ fact, subject, value, ...outcome });
    return outcome.decision;
  };

  // ── Resources first: they re-run the rules with the verified overrides. ──
  const overrides: { -readonly [K in keyof ResourceOverrides]: ResourceOverrides[K] } = {};
  const database = facts.database.value;
  // PostgreSQL wins when the app can run on it (docs/ai-analysis.md): the AI may remove a database the rules
  // require only with high confidence and verified evidence; a wrong removal fails the deployment.
  const removesDatabase = database === 'none' && rulesDatabase(rules.metadata) !== 'none';
  const databaseOutcome = decide('database', database !== rulesDatabase(rules.metadata), false);
  if (removesDatabase && databaseOutcome.decision === 'ai' && facts.database.confidence !== 'high') {
    record('database', database, { decision: 'rules', reasons: ['the rules require a database; the AI removes one only with high confidence'] });
  } else if (record('database', database, databaseOutcome) === 'ai') overrides.database = database;
  const redis = facts.redis.value;
  const rulesRedis = (rules.metadata['redis'] as { required?: unknown } | undefined)?.required === true;
  if (record('redis', redis, decide('redis', redis !== rulesRedis, false)) === 'ai') overrides.redis = redis;
  const storage = facts.storage.value;
  if (record('storage', storage, decide('storage', storage !== (rules.metadata['usesS3'] === true), false)) === 'ai') overrides.storage = storage;

  const base = Object.keys(overrides).length > 0 ? analyseRepo(tree, overrides) : rules;
  const meta: Meta = { ...base.metadata };
  let findings = [...base.findings];
  const aiResolved: string[] = [];

  // ── Dockerfile ──
  const dockerfile = facts.dockerfile.value;
  const rulesContext = typeof meta['dockerfileBuildContext'] === 'string' ? meta['dockerfileBuildContext'] : '.';
  const dockerfileDiffers =
    dockerfile !== null && (dockerfile.path !== meta['dockerfilePath'] || dockerfile.context.replace(/^\.\//, '') !== rulesContext.replace(/^\.\//, ''));
  if (record('dockerfile', dockerfile, decide('dockerfile', dockerfileDiffers, false)) === 'ai' && dockerfile !== null) {
    meta['dockerfilePath'] = dockerfile.path;
    const context = dockerfile.context.replace(/^\.\/?/, '').replace(/\/$/, '');
    if (context === '') delete meta['dockerfileBuildContext'];
    else meta['dockerfileBuildContext'] = context;
    // The missing-source and tie signals describe the rules' Dockerfile.
    delete meta['dockerfileMissingSources'];
    delete meta['dockerfileSelectionTied'];
    delete meta['dockerfileBuildTarget'];
    findings = replaceFinding(findings, 'dockerfile', { detected: true, value: dockerfile.path });
  }

  // ── Port ──
  const port = facts.port.value;
  const portDecision = record('port', port, decide('port', port !== null && port !== rulesPort(meta), true));
  if (portDecision === 'ai' && port !== null) {
    meta['port'] = String(port);
    meta['portSource'] = 'ai';
    meta['portConfidence'] = 'high';
    findings = replaceFinding(findings, 'port', { detected: true, value: String(port), portSource: 'ai', portConfidence: 'high' });
  } else if (portDecision === 'question') {
    meta['port'] = null;
    delete meta['portSource'];
    delete meta['portConfidence'];
    findings = replaceFinding(findings, 'port', { detected: false, value: undefined });
  }

  // ── Start command ──
  const start = facts.startCommand.value;
  // The image runs its own CMD; the start command only answers the gate. A failed
  // AI description is a question only when the rules found no command either.
  const rulesStart = firstString(meta['startupCommands']);
  const startDecision = record('startCommand', start, decide('startCommand', start !== null && start !== rulesStart, rulesStart === null));
  if (startDecision === 'ai' && start !== null) {
    meta['startupCommands'] = [start];
    meta['hasStartupCommand'] = true;
  } else if (startDecision === 'question') {
    meta['startupCommands'] = [];
    meta['hasStartupCommand'] = false;
  }

  // ── Health path ──
  const health = facts.healthPath.value;
  const rulesHealth = meta['healthMode'] === 'vendor_required' ? null : typeof meta['healthPath'] === 'string' ? meta['healthPath'] : null;
  const healthDecision = record('healthPath', health, decide('healthPath', health !== null && health !== rulesHealth, true));
  if (healthDecision === 'ai' && health !== null) {
    meta['healthPath'] = health;
    meta['healthMode'] = 'explicit';
    meta['hasHealthEndpoint'] = true;
    findings = replaceFinding(findings, 'health-endpoint', { detected: true, path: health, mode: 'explicit' });
  } else if (healthDecision === 'question') {
    meta['healthPath'] = null;
    meta['healthMode'] = 'vendor_required';
    findings = replaceFinding(findings, 'health-endpoint', { detected: false, path: undefined, mode: 'vendor_required' });
  }

  // ── Migration ──
  const migration = facts.migration.value;
  let migrationResult: MergeResult['migration'] = null;
  const modeDiffers = migration.mode !== 'unknown' && migration.mode !== meta['migrationMode'];
  const migrationOutcome = decide('migration', modeDiffers || migration.command !== null, migration.command !== null);
  // "No migration" holds only when the deployment has no database after the merge
  // (the analyst may have said "none" for a database that the rules keep).
  const migrationDecision =
    migration.mode === 'none' && rulesDatabase(meta) !== 'none' && migrationOutcome.decision === 'ai'
      ? record('migration', migration, { decision: 'rules', reasons: ['the deployment keeps a database, so its schema is migrated'] })
      : record('migration', migration, migrationOutcome);
  if (migrationDecision === 'ai') {
    meta['migrationMode'] = migration.mode;

    if (migration.mode === 'startup') {
      meta['migrationStartupEvidence'] = facts.migration.evidence.map((item) => ({ path: item.path, line: item.line, fromDockerCommand: false }));
    }
    if (migration.command !== null) {
      meta['migrationCommands'] = [migration.command];
      aiResolved.push('migrationCommand');
      migrationResult = { command: migration.command };
    }
  } else if (migrationDecision === 'question' && migration.command !== null) {
    migrationResult = { candidate: migration.command, reason: 'The AI Analysis could not verify this migration command.' };
    meta['aiMigrationQuestion'] = migrationResult;
  }

  // A "no migration" that holds (verified, or the same as the rules) also removes any
  // migration script the rules picked: the deployment has no database to migrate.
  if (migration.mode === 'none' && rulesDatabase(meta) === 'none' && (migrationDecision === 'ai' || migrationDecision === 'agree')) {
    aiResolved.push('noMigration');
  }

  // ── Workers: the rules' declared workers plus every verified AI worker. ──
  const workers = rulesWorkers(meta);
  let workersChanged = false;
  for (const worker of facts.workers) {
    const known = workers.some((existing) => existing.command === worker.command || existing.id === worker.id);
    const outcome = decide('workers', !known, false, worker.id);
    if (record('workers', worker.command, outcome, worker.id) === 'ai') {
      workers.push({ id: worker.id, command: worker.command, source: worker.evidence[0]?.path ?? 'repository' });
      workersChanged = true;
    }
  }
  if (workersChanged) {
    meta['resolvedWorkerCommands'] = workers;
    aiResolved.push('workers');
  }

  // ── Required variables ──
  const model = Array.isArray(meta['envVarModel']) ? (meta['envVarModel'] as Record<string, unknown>[]).map((entry) => ({ ...entry })) : [];
  const evidenceOf = new Map(facts.requiredVariables.map((variable) => [variable.name, variable.evidence.map((item) => item.path)]));
  const aiNames = new Set(
    facts.requiredVariables.map((variable) => variable.name).filter((name) => !deployzProvides(name, meta, evidenceOf.get(name) ?? [])),
  );
  for (const question of questions) if (question.fact === 'requiredVariables' && question.subject !== null) aiNames.add(question.subject);
  for (const name of aiNames) {
    const entry = model.find((item) => item['key'] === name);
    // Deployz provides these values itself; they are never the vendor's to supply.
    if (entry?.['classification'] === 'deployz_managed' || entry?.['classification'] === 'deployz_generated') continue;
    // A variable that the analyst claims and the checks refute (a default, a guard, low
    // confidence) is dropped; only an open reviewer objection asks the vendor.
    const objected = questions.some((question) => question.fact === 'requiredVariables' && question.subject === name);
    const outcome = decide('requiredVariables', entry?.['required'] !== true, objected, name);
    if (record('requiredVariables', true, outcome, name) === 'agree') continue;
    if (outcome.decision === 'ai' || outcome.decision === 'question') {
      if (entry) Object.assign(entry, { required: true, classification: 'customer_required' });
      else model.push({ key: name, required: true, secret: /SECRET|KEY|TOKEN|PASSWORD/.test(name), source: ['ai'], classification: 'customer_required' });
    }
  }
  // A rules-required variable that the AI left out, and that the evidence reads with a default or a guard, is optional.
  for (const entry of model) {
    const key = entry['key'];
    if (entry['required'] !== true || typeof key !== 'string' || aiNames.has(key) || entry['classification'] !== 'customer_required') continue;
    const guarded = guardedAnywhere(pack, key);
    if (guarded === null) continue;
    entry['required'] = false;
    entry['classification'] = 'optional';
    decisions.push({ fact: 'requiredVariables', subject: key, decision: 'ai', value: false, reasons: [`${guarded} reads it with a default or a guard`] });
  }
  meta['envVarModel'] = model;

  return {
    analysis: { findings, rejections: rules.rejections, metadata: { ...meta, unsupportedReasons: rules.metadata['unsupportedReasons'] } },
    aiResolved,
    migration: migrationResult,
    workers: workersChanged ? workers : null,
    facts: decisions,
  };
}
