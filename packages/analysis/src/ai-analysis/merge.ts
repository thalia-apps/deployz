/**
 * Merges the checked AI answers into the rules Analysis. Per question:
 *
 * - a blocker answered "required", or any answer that fails its check: the
 *   rules value stays (`rules`);
 * - a blocker answered "not used" or "optional by setting" that passes: the
 *   rejection is dismissed (`ai`). A setting adds the engine it selects (a
 *   database, Redis or S3). When Deployz does not set that variable itself,
 *   the vendor must set it: it becomes a required variable with the value.
 * - an open fact that passes: the AI value enters the analysis (`ai`).
 *
 * A dismissed rejection or an added engine re-runs `analyseRepo` with the
 * overrides, so everything derived from them comes from the same rules.
 * Every other rules value is final.
 */
import { analyseRepo, type AnalysisResult, type ResourceOverrides } from '../analyser.js';
import type { FileTree } from '../detectors.js';
import type { AnalystOutput, SupportedEngine } from './analyst.js';
import { factValue, type AnswerCheck, type DockerfileValue, type MigrationValue } from './checks.js';
import type { EvidencePack } from './evidence-pack.js';
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

  const base = Object.keys(overrides).length > 0 ? analyseRepo(tree, overrides) : rules;
  const meta: Meta = { ...base.metadata };
  let findings = [...base.findings];
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
  for (const answer of answers.facts) {
    const question = pack.questions.find((entry) => entry.id === answer.id);
    if (question?.kind !== 'fact') continue;
    const check = checkOf(answer.id);
    const value = answer.value === null ? null : factValue(question, answer.value);
    const applies = check.ok && value !== null;
    merged.push({
      id: answer.id,
      subject: question.fact,
      answer: answer.value === null ? 'unknown' : 'value',
      value,
      decision: applies ? 'ai' : 'rules',
      reasons: check.reasons,
    });
    if (!applies) {
      const unverified = question.fact === 'migration' && value !== null ? (value as MigrationValue).command : null;
      if (unverified !== null) {
        migration = { candidate: unverified, reason: 'The AI Analysis could not verify this migration command.' };
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
      case 'migration': {
        const { mode, command } = value as MigrationValue;
        meta['migrationMode'] = mode;
        if (mode === 'startup') meta['migrationStartupEvidence'] = answer.evidence.map((item) => ({ path: item.path, line: item.line, fromDockerCommand: false }));
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

  return { analysis: { findings, rejections: base.rejections, metadata: meta }, aiResolved, migration, settings, answers: merged };
}
