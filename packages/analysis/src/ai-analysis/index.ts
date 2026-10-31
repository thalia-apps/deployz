/**
 * AI-first application Analysis: open items → evidence pack → one analyst
 * call → fixed checks → merge. A repository with no open item makes no call.
 * Any failure throws, and the caller falls back to the rules Analysis. The AI
 * never calls AWS, never writes infrastructure or a secret value, and never
 * sets deployment or job state.
 */
import type { AnalysisResult, ResourceOverrides } from '../analyser.js';
import type { AiGateway, TokenUsage } from '../ai-gateway.js';
import { TREE_PATHS, type FileTree } from '../detectors.js';
import { ANALYST_PROMPT_VERSION, ANALYST_TIMEOUT_MS, runAnalyst, type AnalystOutput } from './analyst.js';
import { checkAnswers } from './checks.js';
import { buildEvidencePack } from './evidence-pack.js';
import { mergeAiAnswers, type MergeResult } from './merge.js';

export { ANALYST_PROMPT_VERSION } from './analyst.js';
export { evidenceFileRequests } from './evidence-pack.js';
export {
  appliedJudgement,
  buildJudgePack,
  buildSoftReviewPack,
  decideJudgement,
  decideSoftReview,
  JUDGE_PROMPT_VERSION,
  JUDGE_REASON_PREFIX,
  JUDGE_SYSTEM,
  judgeFileRequests,
  questionedFindings,
  runFinalJudge,
  runSoftReview,
  SOFT_FINDING_IDS,
  SOFT_REVIEW_SYSTEM,
  softReviewFileRequests,
  softReviewTargets,
} from './judge.js';
export type { Judgement, JudgeInput, JudgeOutput, JudgeRecord, SoftReviewInput, SoftReviewItem, SoftReviewRecord, VendorAnswer } from './judge.js';
export type { AnalystOutput, BlockerAnswer, Evidence, FactAnswer } from './analyst.js';
export type { AnswerCheck } from './checks.js';
export type { EvidencePack, Question } from './evidence-pack.js';
export type { MergedAnswer, MergeResult, SettingChange } from './merge.js';
export type { OpenItem } from './open-items.js';

/** ANALYSIS_ENGINE: `rules` (the default), `shadow` (the AI runs and changes nothing) or `ai`. */
export type AnalysisEngine = 'rules' | 'shadow' | 'ai';

export function parseAnalysisEngine(value: string | undefined): AnalysisEngine {
  return value === 'shadow' || value === 'ai' ? value : 'rules';
}

export interface AiAnalysisGateways {
  readonly analyst: AiGateway;
}

export interface CallRecord {
  readonly model: string | undefined;
  readonly usage: TokenUsage;
  readonly latencyMs: number;
}

/** What the AI Analysis stores next to its result: enough to compare engines and count cost. */
export interface AiAnalysisReport {
  readonly promptVersion: number;
  /** Null when the rules left no open item, so no call was made. */
  readonly analyst: CallRecord | null;
  readonly questions: number;
  readonly failedChecks: number;
  readonly answers: MergeResult['answers'];
  readonly settings: MergeResult['settings'];
  readonly latencyMs: number;
}

export interface AiAnalysisOutcome {
  readonly merge: MergeResult;
  readonly report: AiAnalysisReport;
}

/**
 * `evidenceFiles` are the files of `evidenceFileRequests` that the caller
 * fetched: the pack and the checks read them, the merge re-runs the rules on
 * the rules tree only.
 */
export async function runAiAnalysis(
  input: {
    tree: FileTree;
    rules: AnalysisResult;
    gateways: AiAnalysisGateways;
    evidenceFiles?: FileTree | undefined;
    /** Vendor overrides already applied to `rules`. */
    baseOverrides?: ResourceOverrides | undefined;
  },
  options: { abortSignal?: AbortSignal | undefined } = {},
): Promise<AiAnalysisOutcome> {
  const started = Date.now();
  const { tree, rules } = input;
  const evidenceTree: FileTree = { ...tree, ...input.evidenceFiles };
  Object.defineProperty(evidenceTree, TREE_PATHS, { value: (tree as FileTree & { [TREE_PATHS]?: readonly string[] })[TREE_PATHS], enumerable: false });
  const pack = buildEvidencePack(evidenceTree, rules);

  let answers: AnalystOutput = { blockers: [], facts: [] };
  let analyst: CallRecord | null = null;
  if (pack.questions.length > 0) {
    const timeout = AbortSignal.timeout(ANALYST_TIMEOUT_MS);
    const abortSignal = options.abortSignal ? AbortSignal.any([options.abortSignal, timeout]) : timeout;
    const result = await runAnalyst(pack, input.gateways.analyst, { abortSignal });
    answers = result.output;
    analyst = { model: result.model, usage: result.usage, latencyMs: Date.now() - started };
  }

  const meta = rules.metadata;
  const database = (meta['postgres'] as { required?: unknown } | undefined)?.required === true ? 'postgres' : (meta['mysql'] as { required?: unknown } | undefined)?.required === true ? 'mysql' : 'none';
  const dockerfile = typeof meta['dockerfilePath'] === 'string' ? meta['dockerfilePath'] : null;
  const checks = checkAnswers({ pack, tree: evidenceTree, dockerfile, database }, answers.blockers, answers.facts);
  const merge = mergeAiAnswers({ tree, rules, pack, answers, checks, evidenceFiles: input.evidenceFiles, baseOverrides: input.baseOverrides });
  return {
    merge,
    report: {
      promptVersion: ANALYST_PROMPT_VERSION,
      analyst,
      questions: pack.questions.length,
      failedChecks: checks.filter((check) => !check.ok).length,
      answers: merge.answers,
      settings: merge.settings,
      latencyMs: Date.now() - started,
    },
  };
}
