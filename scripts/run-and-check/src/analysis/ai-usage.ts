/**
 * Cost and time per analysis for an AI analyser run, from the `ai` record of
 * each result file. The analyst cost uses the Claude Opus 5.5 list price; the
 * reviewer is reported in tokens because its price is not pinned here.
 */
import type { AnalysisResultFile } from '../contract.js';

/** Claude Opus 5.5, USD per million tokens. */
export const ANALYST_PRICE = { input: 4, output: 20 } as const;

interface Call {
  usage?: { promptTokens?: number; completionTokens?: number };
  latencyMs?: number;
}

export interface AiUsageSummary {
  readonly analyses: number;
  readonly fallbacks: Record<string, number>;
  readonly analystTokens: { readonly prompt: number; readonly completion: number };
  readonly reviewerTokens: { readonly prompt: number; readonly completion: number };
  readonly analystCostUsd: number;
  readonly latencyMs: { readonly mean: number; readonly max: number };
}

export function summariseAiUsage(files: readonly AnalysisResultFile[]): AiUsageSummary {
  const fallbacks: Record<string, number> = {};
  const analyst = { prompt: 0, completion: 0 };
  const reviewer = { prompt: 0, completion: 0 };
  const latencies: number[] = [];
  let analyses = 0;
  for (const file of files) {
    const ai = file.ai;
    if (!ai) continue;
    if (ai['status'] === 'fallback') {
      const reason = String(ai['reason'] ?? 'unknown');
      fallbacks[reason] = (fallbacks[reason] ?? 0) + 1;
      continue;
    }
    analyses += 1;
    const a = ai['analyst'] as Call | undefined;
    const r = ai['reviewer'] as Call | null | undefined;
    analyst.prompt += a?.usage?.promptTokens ?? 0;
    analyst.completion += a?.usage?.completionTokens ?? 0;
    reviewer.prompt += r?.usage?.promptTokens ?? 0;
    reviewer.completion += r?.usage?.completionTokens ?? 0;
    if (typeof ai['latencyMs'] === 'number') latencies.push(ai['latencyMs']);
  }
  const per = (value: number) => (analyses === 0 ? 0 : Math.round(value / analyses));
  const cost = (analyst.prompt * ANALYST_PRICE.input + analyst.completion * ANALYST_PRICE.output) / 1_000_000;
  return {
    analyses,
    fallbacks,
    analystTokens: { prompt: per(analyst.prompt), completion: per(analyst.completion) },
    reviewerTokens: { prompt: per(reviewer.prompt), completion: per(reviewer.completion) },
    analystCostUsd: analyses === 0 ? 0 : cost / analyses,
    latencyMs: {
      mean: latencies.length === 0 ? 0 : Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
      max: latencies.length === 0 ? 0 : Math.max(...latencies),
    },
  };
}

export function formatAiUsage(summary: AiUsageSummary): string {
  const fallbacks = Object.entries(summary.fallbacks).map(([reason, count]) => `${reason} ${count}`).join(', ') || 'none';
  return [
    `AI analyses: ${summary.analyses}; fallbacks: ${fallbacks}`,
    `Per analysis: analyst ${summary.analystTokens.prompt} prompt + ${summary.analystTokens.completion} completion tokens (about $${summary.analystCostUsd.toFixed(3)}); reviewer ${summary.reviewerTokens.prompt} + ${summary.reviewerTokens.completion} tokens`,
    `Time per analysis: mean ${(summary.latencyMs.mean / 1000).toFixed(1)} s, max ${(summary.latencyMs.max / 1000).toFixed(1)} s`,
  ].join('\n');
}
