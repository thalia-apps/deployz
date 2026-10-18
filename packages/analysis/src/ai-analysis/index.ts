/**
 * AI-first application Analysis: evidence pack → analyst → reviewer →
 * fixed checks → merge. Any failure throws, and the caller falls back to the
 * rules Analysis. The AI never calls AWS, never writes infrastructure or a
 * secret value, and never sets deployment or job state.
 */
import type { AnalysisResult } from '../analyser.js';
import type { AiGateway, TokenUsage } from '../ai-gateway.js';
import type { FileTree } from '../detectors.js';
import { ANALYST_PROMPT_VERSION, ANALYST_TIMEOUT_MS, runAnalyst } from './analyst.js';
import { checkFacts } from './checks.js';
import { buildEvidencePack } from './evidence-pack.js';
import { mergeAiFacts, type MergeResult } from './merge.js';
import { resolveObjections, REVIEWER_PROMPT_VERSION, REVIEWER_TIMEOUT_MS, runReviewer, type ObjectionOutcome } from './reviewer.js';

export { ANALYST_PROMPT_VERSION } from './analyst.js';
export type { AnalystOutput, Evidence, FactName } from './analyst.js';
export type { FactCheck } from './checks.js';
export type { EvidencePack } from './evidence-pack.js';
export type { FactDecision, MergedFact, MergeResult, WorkerCommand } from './merge.js';
export { REVIEWER_PROMPT_VERSION } from './reviewer.js';

/** ANALYSIS_ENGINE: `rules` (the default), `shadow` (the AI runs and changes nothing) or `ai`. */
export type AnalysisEngine = 'rules' | 'shadow' | 'ai';

export function parseAnalysisEngine(value: string | undefined): AnalysisEngine {
  return value === 'shadow' || value === 'ai' ? value : 'rules';
}

export interface AiAnalysisGateways {
  readonly analyst: AiGateway;
  /** Omitted: the analyst facts go to the checks without a review. */
  readonly reviewer?: AiGateway | undefined;
}

export interface CallRecord {
  readonly model: string | undefined;
  readonly usage: TokenUsage;
  readonly latencyMs: number;
}

/** What the AI Analysis stores next to its result: enough to compare engines and count cost. */
export interface AiAnalysisReport {
  readonly promptVersions: { readonly analyst: number; readonly reviewer: number };
  readonly analyst: CallRecord;
  readonly reviewer: CallRecord | null;
  readonly objections: { readonly total: number; readonly confirmed: number; readonly questions: number };
  readonly failedChecks: number;
  readonly facts: MergeResult['facts'];
  readonly latencyMs: number;
}

export interface AiAnalysisOutcome {
  readonly merge: MergeResult;
  readonly report: AiAnalysisReport;
}

async function timed<T>(timeoutMs: number, signal: AbortSignal | undefined, call: (signal: AbortSignal) => Promise<T>): Promise<{ value: T; latencyMs: number }> {
  const started = Date.now();
  const timeout = AbortSignal.timeout(timeoutMs);
  const value = await call(signal ? AbortSignal.any([signal, timeout]) : timeout);
  return { value, latencyMs: Date.now() - started };
}

export async function runAiAnalysis(
  input: { tree: FileTree; rules: AnalysisResult; gateways: AiAnalysisGateways },
  options: { abortSignal?: AbortSignal | undefined } = {},
): Promise<AiAnalysisOutcome> {
  const started = Date.now();
  const { tree, rules, gateways } = input;
  const pack = buildEvidencePack(tree, rules);
  const fallbackDockerfile = typeof rules.metadata['dockerfilePath'] === 'string' ? rules.metadata['dockerfilePath'] : null;
  const ctx = { pack, tree };

  const analyst = await timed(ANALYST_TIMEOUT_MS, options.abortSignal, (abortSignal) => runAnalyst(pack, gateways.analyst, { abortSignal }));
  let facts = analyst.value.output;
  let questions: ReturnType<typeof resolveObjections>['questions'] = [];
  let outcomes: ReadonlyArray<{ outcome: ObjectionOutcome }> = [];
  let reviewer: CallRecord | null = null;
  if (gateways.reviewer !== undefined) {
    const reviewerGateway = gateways.reviewer;
    const review = await timed(REVIEWER_TIMEOUT_MS, options.abortSignal, (abortSignal) => runReviewer(pack, facts, reviewerGateway, { abortSignal }));
    const resolved = resolveObjections(ctx, facts, review.value.output.objections, fallbackDockerfile);
    facts = resolved.facts;
    questions = resolved.questions;
    outcomes = resolved.outcomes;
    reviewer = { model: review.value.model, usage: review.value.usage, latencyMs: review.latencyMs };
  }

  const checks = checkFacts(ctx, facts, fallbackDockerfile);
  const merge = mergeAiFacts({ tree, rules, pack, facts, checks, questions });
  return {
    merge,
    report: {
      promptVersions: { analyst: ANALYST_PROMPT_VERSION, reviewer: REVIEWER_PROMPT_VERSION },
      analyst: { model: analyst.value.model, usage: analyst.value.usage, latencyMs: analyst.latencyMs },
      reviewer,
      objections: {
        total: outcomes.length,
        confirmed: outcomes.filter((item) => item.outcome === 'confirmed').length,
        questions: outcomes.filter((item) => item.outcome === 'question').length,
      },
      failedChecks: merge.facts.filter((fact) => fact.decision === 'question' || fact.decision === 'rules').length,
      facts: merge.facts,
      latencyMs: Date.now() - started,
    },
  };
}
