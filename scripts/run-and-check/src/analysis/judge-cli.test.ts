import { describe, expect, it } from 'vitest';

import type { JudgeRecord } from '@deployz/analysis';

import { judgedOutcome, reviewedOutcome, scoreJudgeFiles, type JudgeFile } from './judge-cli.js';

const usage = { promptTokens: 1000, completionTokens: 100, costUsd: 0.01 };
function record(decision: 'block' | 'change' | 'question' | 'none'): JudgeRecord {
  return {
    status: 'ok',
    promptVersion: 3,
    outcome: 'DEPLOYABLE_WITH_CHANGES',
    judgement: { decision, verdict: 'not_deployable', category: 'not_http', reason: 'r', evidence: [], checkReasons: [] },
    model: 'fake',
    usage,
    latencyMs: 100,
  };
}

describe('judgedOutcome', () => {
  it('blocks, turns DEPLOYABLE into DEPLOYABLE_WITH_CHANGES, and keeps the outcome otherwise', () => {
    expect(judgedOutcome('DEPLOYABLE', record('block'))).toBe('NOT_DEPLOYABLE');
    expect(judgedOutcome('DEPLOYABLE', record('change'))).toBe('DEPLOYABLE_WITH_CHANGES');
    expect(judgedOutcome('DEPLOYABLE', record('question'))).toBe('DEPLOYABLE');
    expect(judgedOutcome('DEPLOYABLE', { status: 'fallback', reason: 'Error', promptVersion: 3, latencyMs: 1 })).toBe('DEPLOYABLE');
  });
});

describe('reviewedOutcome', () => {
  it('reads the outcome the embedded judge reviewed, not the judged one', () => {
    const base = { id: 'new-1', commit: 'a', analyser: 'ai@x', status: 'analysed' as const, failure: null, manifest: null, gate: null, vendorQuestions: 0 };
    expect(reviewedOutcome({ ...base, outcome: 'NOT_DEPLOYABLE', judge: { status: 'ok', outcome: 'DEPLOYABLE' } })).toBe('DEPLOYABLE');
    expect(reviewedOutcome({ ...base, outcome: 'DEPLOYABLE', judge: { status: 'skipped' } })).toBe('DEPLOYABLE');
  });
});

describe('scoreJudgeFiles', () => {
  const file = (id: string, storedOutcome: JudgeFile['outcome'], judge: JudgeRecord | null): JudgeFile => ({
    id,
    analyser: 'judge@x',
    from: 'ai@x',
    storedOutcome,
    outcome: judgedOutcome(storedOutcome, judge),
    judge,
  });
  const accept: Record<string, string[]> = { fixed: ['NOT_DEPLOYABLE'], strict: ['DEPLOYABLE'], unsure: ['NOT_DEPLOYABLE'], still: ['NOT_DEPLOYABLE'] };
  const score = scoreJudgeFiles(
    [
      file('fixed', 'DEPLOYABLE_WITH_CHANGES', record('block')),
      file('strict', 'DEPLOYABLE', record('block')),
      file('unsure', 'DEPLOYABLE_WITH_CHANGES', record('question')),
      file('still', 'DEPLOYABLE_WITH_CHANGES', record('none')),
    ],
    (id) => accept[id] ?? null,
  );

  it('counts a question as not sure, never as wrong', () => {
    expect(score.notSure).toEqual(['unsure']);
    expect(score.wrong).toEqual(['strict', 'still']);
  });

  it('counts fixed and too-strict outcomes and the cost', () => {
    expect(score.fixed).toEqual(['fixed']);
    expect(score.tooStrict).toEqual(['strict']);
    expect(score.costUsd).toBeCloseTo(0.04);
  });
});
