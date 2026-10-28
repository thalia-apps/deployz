/**
 * Merges the checked AI answers into the rules Analysis. Per question:
 *
 * - a blocker answered "required", or any answer that fails its check: the
 *   rules value stays (`rules`);
 * - a blocker answered "not used" or "optional by setting" that passes: the
 *   rejection is dismissed (`ai`). A setting adds the engine it selects (a
 *   database, Redis or S3). When Deployz does not set that variable itself,
 *   the vendor must set it: it becomes a required variable with the value.
 * - an open fact that passes: the AI value enters the analysis (`ai`). A
 *   repository kind other than "application" replaces the
 *   `no-buildable-dockerfile` rejection with `library-repository`.
 *
 * A dismissed rejection or an added engine re-runs `analyseRepo` with the
 * overrides, so everything derived from them comes from the same rules.
 * Every other rules value is final.
 */
import { analyseRepo, type AnalysisResult, type ResourceOverrides } from '../analyser.js';
import { postgresSemantic } from '../bindings.js';
import { isSecretName, type FileTree, type MigrationStartupEvidence } from '../detectors.js';
import { isGeneratableSecretName } from '../env-classification.js';
import { combineOverrides } from '../vendor-disputes.js';
import type { AnalystOutput, SupportedEngine } from './analyst.js';
import { databaseVariableSemantic, factValue, type AnswerCheck, type DockerfileValue, type MigrationValue } from './checks.js';
import { isProductionFile, type EvidencePack } from './evidence-pack.js';
import { LOCAL_FILESYSTEM_FINDING } from './open-items.js';

export type AnswerDecision = 'ai' | 'rules';

export interface MergedAnswer {
  readonly id: string;
  /** The blocker dependency or the fact name. */
  readonly subject: string;
  /** The blocker answer, or `value` / `unknown` for a fact. */
  readonly answer: string;
  readonly value: unknown;
  readonly decision: AnswerDecision;
  readonly reasons: readonly string[];
}

/** A setting that switches a dismissed blocker to an engine Deployz provides. */
export interface SettingChange {
  readonly dependency: string;
  readonly setting: string;
  readonly value: string;
  readonly engine: SupportedEngine;
  /** True when the vendor must set it; false when Deployz sets the variable itself (a binding). */
  readonly vendor: boolean;
}

export interface MergeInput {
  readonly tree: FileTree;
  readonly rules: AnalysisResult;
  readonly pack: EvidencePack;
  readonly answers: AnalystOutput;
  readonly checks: readonly AnswerCheck[];
  /** The fetched evidence files (`evidenceFileRequests`) that the rules tree does not hold. */
  readonly evidenceFiles?: FileTree | undefined;
  /** Vendor overrides already applied to `rules`: a re-run keeps them. */
  readonly baseOverrides?: ResourceOverrides | undefined;
}

export interface MergeResult {
  readonly analysis: AnalysisResult;
  /** Markers for the API: `migrationCommand` and `noMigration` when the AI decided them. */
  readonly aiResolved: readonly string[];
  /** The AI migration command to qualify, or the open question when it was not verified. */
  readonly migration: { readonly command: string } | { readonly candidate: string; readonly reason: string } | null;
  readonly settings: readonly SettingChange[];
  readonly answers: readonly MergedAnswer[];
}

type Meta = Record<string, unknown>;

function replaceFinding(findings: AnalysisResult['findings'], detector: string, patch: Partial<AnalysisResult['findings'][number]>): AnalysisResult['findings'] {
  const index = findings.findIndex((finding) => finding.detector === detector);
  const base = index >= 0 ? findings[index]! : { detector, detected: false };
  const next = { ...base, ...patch };
  return index >= 0 ? findings.map((finding, i) => (i === index ? next : finding)) : [...findings, next];
}

/** The names Deployz sets for an engine it provisions (the binding contract of the pack). */
function deployzSets(pack: EvidencePack, engine: SupportedEngine, setting: string): boolean {
  const contract = pack.bindingContract;
  const names = engine === 'redis' ? contract.whenRedis : engine === 's3' ? contract.whenStorage : contract.whenDatabase;
  return [...contract.always, ...contract.forThisRepository, ...names].includes(setting);
}

/**
 * A read with no default that stops the start when the variable is not set:
 * Elixir `System.fetch_env!("X")` or an app's own `Util.fetch_env!("X", …)`
 * (a `!` call raises), Rust `env::var("X").expect(…)` or `.unwrap()`, C#
 * `GetEnvironmentVariable("X") ?? throw`.
 */
const REQUIRED_READ =
  /\bfetch_env!\(\s*"([A-Z][A-Z0-9_]*)"|env::var\(\s*"([A-Z][A-Z0-9_]*)"\s*\)\s*\.(?:expect|unwrap)\(|GetEnvironmentVariable\(\s*"([A-Z][A-Z0-9_]*)"\s*\)\s*\?\?\s*throw/g;

/**
 * The required variables that the evidence files read and the rules did not
 * see (they never read these files): without them the app stops at start, so
 * a resolved fact must not make it READY. A database part becomes a binding,
 * as the rules make it for a name they read in code.
 */
function addEvidenceRequirements(meta: Meta, evidenceFiles: FileTree, pack: EvidencePack): void {
  const model = Array.isArray(meta['envVarModel']) ? (meta['envVarModel'] as Record<string, unknown>[]) : [];
  const bindings = Array.isArray(meta['infrastructureBindings']) ? (meta['infrastructureBindings'] as Record<string, unknown>[]) : [];
  const database = (meta['postgres'] as { required?: unknown } | undefined)?.required === true || (meta['mysql'] as { required?: unknown } | undefined)?.required === true;
  const contract = pack.bindingContract;
  const known = new Set<unknown>([
    ...contract.always,
    ...contract.forThisRepository,
    ...(database ? contract.whenDatabase : []),
    ...model.map((entry) => entry['key']),
    ...bindings.map((binding) => binding['applicationVariable']),
  ]);
  const added: Record<string, unknown>[] = [];
  const addedBindings: Record<string, unknown>[] = [];
  for (const path of Object.keys(evidenceFiles).filter(isProductionFile).sort()) {
    for (const match of (evidenceFiles[path] ?? '').matchAll(REQUIRED_READ)) {
      const name = match[1] ?? match[2] ?? match[3]!;
      if (known.has(name)) continue;
      known.add(name);
      const semantic = database ? postgresSemantic(name) : null;
      if (semantic !== null) {
        added.push({ key: name, secret: false, source: [`read in ${path}`], purpose: 'infrastructure_binding', required: false, confidence: 'high', classification: 'deployz_managed' });
        addedBindings.push({ resource: 'postgres', semantic, applicationVariable: name, source: 'ai', confidence: 'high' });
      } else {
        const classification = isGeneratableSecretName(name) ? 'deployz_generated' : 'customer_required';
        added.push({ key: name, secret: isSecretName(name), source: [`read in ${path}`], required: true, confidence: 'high', classification });
      }
    }
  }
  if (added.length > 0) meta['envVarModel'] = [...model, ...added];
  if (addedBindings.length > 0) meta['infrastructureBindings'] = [...bindings, ...addedBindings];
}

export function mergeAiAnswers(input: MergeInput): MergeResult {
  const { tree, rules, pack, answers, checks } = input;
  const merged: MergedAnswer[] = [];
  const checkOf = (id: string): AnswerCheck => checks.find((check) => check.id === id) ?? { id, ok: false, reasons: ['not checked'] };

  // ── Blockers: a passing "not used" or "optional by setting" dismisses the rejection. ──
  const dismissed: string[] = [];
  const settings: SettingChange[] = [];
  const overrides: { -readonly [K in keyof ResourceOverrides]: ResourceOverrides[K] } = {};
  for (const answer of answers.blockers) {
    const question = pack.questions.find((entry) => entry.id === answer.id);
    if (question?.kind !== 'blocker') continue;
    const check = checkOf(answer.id);
    const dismisses = answer.answer !== 'required' && check.ok;
    merged.push({
      id: answer.id,
      subject: question.dependency,
      answer: answer.answer,
      value: answer.answer === 'optional_by_setting' ? { setting: answer.setting, value: answer.settingValue, engine: answer.engine } : null,
      decision: dismisses ? 'ai' : 'rules',
      reasons: check.reasons,
    });
    if (!dismisses) continue;
    if (question.dependency === LOCAL_FILESYSTEM_FINDING) overrides.localFilesystem = false;
    else dismissed.push(question.reason);
    if (answer.answer === 'optional_by_setting' && answer.setting !== null && answer.settingValue !== null && answer.engine !== null) {
      const engine = answer.engine;
      if (engine === 'postgres' || engine === 'mysql') overrides.database = engine;
      if (engine === 'redis') overrides.redis = true;
      if (engine === 's3') overrides.storage = true;
      settings.push({ dependency: question.dependency, setting: answer.setting, value: answer.settingValue, engine, vendor: !deployzSets(pack, engine, answer.setting) });
    }
  }
  if (dismissed.length > 0) overrides.dismissedRejections = dismissed;

  const base = Object.keys(overrides).length > 0 ? analyseRepo(tree, combineOverrides(input.baseOverrides, overrides)) : rules;
  const meta: Meta = { ...base.metadata };
  let findings = [...base.findings];
  let rejections = base.rejections;
  const aiResolved: string[] = [];
  let migration: MergeResult['migration'] = null;

  // A setting that only the vendor can set is a required variable with the value it must have.
  if (settings.some((change) => change.vendor)) {
    const model = Array.isArray(meta['envVarModel']) ? (meta['envVarModel'] as Record<string, unknown>[]).map((entry) => ({ ...entry })) : [];
    for (const change of settings.filter((entry) => entry.vendor)) {
      const entry = model.find((item) => item['key'] === change.setting);
      const patch = { required: true, classification: 'customer_required', source: [`AI Analysis: set ${change.setting}=${change.value} to use ${change.engine}`] };
      if (entry) Object.assign(entry, patch);
      else model.push({ key: change.setting, secret: false, ...patch });
    }
    meta['envVarModel'] = model;
  }

  // ── Open facts: a passing answer fills what the rules left open. ──
  // Each fact on its own: an open fact that stays unresolved keeps its rules finding, and an
  // unresolved migration becomes a vendor question below, so a resolved fact never hides it.
  for (const answer of answers.facts) {
    const question = pack.questions.find((entry) => entry.id === answer.id);
    if (question?.kind !== 'fact') continue;
    const check = checkOf(answer.id);
    const value = answer.value === null ? null : factValue(question, answer.value);
    const applies = value !== null && check.ok;
    merged.push({
      id: answer.id,
      subject: question.fact,
      answer: answer.value === null ? 'unknown' : 'value',
      value,
      decision: applies ? 'ai' : 'rules',
      reasons: check.reasons,
    });
    if (!applies) {
      // The migration of a required database stays a vendor question: an unknown migration can stop
      // the start (Logto refuses to start with undeployed alterations), so doubt is never READY.
      if (question.fact === 'migration') {
        const unverified = value !== null ? (value as MigrationValue).command : null;
        migration = { candidate: unverified ?? '', reason: 'The AI Analysis could not tell how this app migrates its database.' };
        meta['aiMigrationQuestion'] = migration;
      }
      continue;
    }
    switch (question.fact) {
      case 'dockerfile': {
        const dockerfile = value as DockerfileValue;
        meta['dockerfilePath'] = dockerfile.path;
        const context = dockerfile.context.replace(/^\.\/?/, '').replace(/\/$/, '');
        if (context === '') delete meta['dockerfileBuildContext'];
        else meta['dockerfileBuildContext'] = context;
        // The missing-source and tie signals describe the rules' Dockerfile.
        delete meta['dockerfileMissingSources'];
        delete meta['dockerfileSelectionTied'];
        delete meta['dockerfileBuildTarget'];
        findings = replaceFinding(findings, 'dockerfile', { detected: true, value: dockerfile.path });
        break;
      }
      case 'port':
        meta['port'] = String(value);
        meta['portSource'] = 'ai';
        meta['portConfidence'] = 'high';
        findings = replaceFinding(findings, 'port', { detected: true, value: String(value), portSource: 'ai', portConfidence: 'high' });
        break;
      case 'startCommand':
        meta['startupCommands'] = [value as string];
        meta['hasStartupCommand'] = true;
        break;
      case 'healthPath':
        meta['healthPath'] = value;
        meta['healthMode'] = 'explicit';
        meta['hasHealthEndpoint'] = true;
        findings = replaceFinding(findings, 'health-endpoint', { detected: true, path: value as string, mode: 'explicit' });
        break;
      case 'databaseVariable': {
        // Deployz sets the variable to the managed database, as the rules do for an alias they find in code.
        const name = value as string;
        const read = (answer.evidence.find((item) => item.quote.includes(name)) ?? answer.evidence[0])?.path;
        const model = Array.isArray(meta['envVarModel']) ? (meta['envVarModel'] as Record<string, unknown>[]).filter((entry) => entry['key'] !== name) : [];
        model.push({ key: name, secret: false, source: [`read in ${read}`], purpose: 'infrastructure_binding', required: false, confidence: 'high', classification: 'deployz_managed' });
        meta['envVarModel'] = model;
        const bindings = Array.isArray(meta['infrastructureBindings']) ? (meta['infrastructureBindings'] as Record<string, unknown>[]) : [];
        meta['infrastructureBindings'] = [
          ...bindings.filter((binding) => binding['applicationVariable'] !== name),
          { resource: 'postgres', semantic: databaseVariableSemantic(name), applicationVariable: name, source: 'ai', confidence: 'high' },
        ];
        break;
      }
      case 'repositoryKind': {
        // A library, framework, SDK or CLI has no server to deploy: "add a Dockerfile" is the wrong fix.
        if (value === 'application') break;
        const cited = answer.evidence.map((item) => `${item.path}:${item.line}`).join(', ');
        rejections = rejections.map((rejection) =>
          rejection.detected && rejection.dependency === 'no-buildable-dockerfile'
            ? { detected: true, dependency: 'library-repository', reason: `Unsupported repository: it is a ${value as string} that others install (${cited}), not an application with a web server to run.` }
            : rejection,
        );
        break;
      }
      case 'migration': {
        const { mode, command } = value as MigrationValue;
        meta['migrationMode'] = mode;
        delete meta['migrationQuestion'];
        if (mode === 'startup') {
          // The rules' evidence shape, so the readiness report reads both the same way.
          meta['migrationStartupEvidence'] = answer.evidence.map(
            (item): MigrationStartupEvidence => ({ source: `${item.path}:${item.line}`, pattern: 'AI Analysis', fromDockerCommand: false }),
          );
        }
        if (mode === 'none') aiResolved.push('noMigration');
        if (command !== null) {
          meta['migrationCommands'] = [command];
          aiResolved.push('migrationCommand');
          migration = { command };
        }
        break;
      }
    }
  }

  addEvidenceRequirements(meta, input.evidenceFiles ?? {}, pack);

  return { analysis: { findings, rejections, metadata: meta }, aiResolved, migration, settings, answers: merged };
}
