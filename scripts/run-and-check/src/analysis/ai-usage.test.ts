import { describe, expect, it } from 'vitest';

import { makeAnalysis, makeManifest } from '../claims/test-support.js';
import { formatAiUsage, summariseAiUsage } from './ai-usage.js';

const ok = (prompt: number, completion: number, latencyMs: number) =>
  makeAnalysis(makeManifest(), undefined, {
    ai: {
      status: 'ok',
      analyst: { usage: { promptTokens: prompt, completionTokens: completion }, latencyMs },
      latencyMs,
    },
  });

describe('summariseAiUsage', () => {
  it('averages tokens, cost and time over the AI analyses, counts the calls, and counts fallbacks apart', () => {
    const summary = summariseAiUsage([
      ok(20_000, 4_000, 60_000),
      ok(10_000, 2_000, 30_000),
      makeAnalysis(makeManifest(), undefined, { ai: { status: 'ok', analyst: null, latencyMs: 0 } }),
      makeAnalysis(makeManifest(), undefined, { ai: { status: 'fallback', reason: 'TimeoutError' } }),
      makeAnalysis(makeManifest()),
    ]);
    expect(summary.analyses).toBe(3);
    expect(summary.calls).toBe(2);
    expect(summary.fallbacks).toEqual({ TimeoutError: 1 });
    expect(summary.analystTokens).toEqual({ prompt: 10_000, completion: 2_000 });
    // (30000 * 4 + 6000 * 20) / 1e6 / 3
    expect(summary.analystCostUsd).toBeCloseTo(0.08);
    expect(summary.latencyMs).toEqual({ mean: 30_000, max: 60_000 });
    expect(formatAiUsage(summary)).toContain('fallbacks: TimeoutError 1');
  });
});
