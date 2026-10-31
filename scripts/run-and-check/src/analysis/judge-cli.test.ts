import { describe, expect, it } from 'vitest';

import type { JudgeRecord, SoftReviewRecord } from '@deployz/analysis';

import { compareJudgeFiles, judgedOutcome, reviewedOutcome, scoreJudgeFiles, storedFindings, type JudgeFile } from './judge-cli.js';

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

describe('compareJudgeFiles', () => {
  const file = (id: string, decision: 'block' | 'none', outcome: JudgeFile['outcome']): JudgeFile => ({ id, analyser: 'judge@x', from: 'ai@x', storedOutcome: 'DEPLOYABLE', outcome, judge: record(decision) });

  it('lists the ids whose verdict, decision or outcome differ, and the ids only one folder has', () => {
    const a = [file('new-1', 'block', 'NOT_DEPLOYABLE'), file('new-2', 'none', 'DEPLOYABLE'), file('new-3', 'none', 'DEPLOYABLE')];
    const b = [file('new-1', 'none', 'DEPLOYABLE'), file('new-2', 'none', 'DEPLOYABLE')];
    expect(compareJudgeFiles(a, b)).toEqual([
      'new-1: not_deployable -> block, outcome NOT_DEPLOYABLE | not_deployable -> none, outcome DEPLOYABLE',
      'new-3: not_deployable -> none, outcome DEPLOYABLE | missing',
    ]);
  });
});

describe('the soft review in the exam', () => {
  const soft = (question: boolean): SoftReviewRecord => ({
    status: 'ok',
    promptVersion: 5,
    outcome: 'DEPLOYABLE_WITH_CHANGES',
    reviews: [{ findingId: 'localhost-binding', findingEvidence: 'e', verdict: question ? 'probably_wrong' : 'stands', reason: 'r', evidence: [], question, checkReasons: [] }],
    model: 'fake',
    usage,
    latencyMs: 300,
  });
  const file = (id: string, judge: JudgeRecord, softReview: SoftReviewRecord): JudgeFile => ({
    id,
    analyser: 'judge@x',
    from: 'ai@x',
    storedOutcome: 'DEPLOYABLE_WITH_CHANGES',
    outcome: judgedOutcome('DEPLOYABLE_WITH_CHANGES', judge),
    judge,
    softReview,
  });

  it('counts a finding the vendor must confirm as not sure, and a judge block first', () => {
    const score = scoreJudgeFiles([file('asked', record('none'), soft(true)), file('kept', record('none'), soft(false)), file('blocked', record('block'), soft(true))], () => ['DEPLOYABLE']);
    expect(score.notSure).toEqual(['asked']);
    expect(score.needsConfirmation).toEqual(['asked']);
    expect(score.wrong).toEqual(['kept', 'blocked']);
    expect(score.softReviewed).toBe(3);
    expect(score.costUsd).toBeCloseTo(0.06);
    expect(score.latencyMs.max).toBe(300);
  });

  it('reads the findings of the analysis, else of a rules analysis of the same commit and outcome', () => {
    const base = { id: 'new-1', commit: 'a', analyser: 'ai@x', status: 'analysed' as const, failure: null, manifest: null, gate: null, vendorQuestions: 0, outcome: 'DEPLOYABLE_WITH_CHANGES' as const };
    const findings = [{ id: 'localhost-binding', title: 't', fixClass: 'CODE_CHANGE', technicalEvidence: 'e', confidence: 'likely' }];
    expect(storedFindings({ ...base, findings }, null)).toBe(findings);
    expect(storedFindings(base, { ...base, analyser: 'rules@x', findings })).toBe(findings);
    expect(storedFindings(base, { ...base, analyser: 'rules@x', outcome: 'NOT_DEPLOYABLE', findings })).toBeNull();
    expect(storedFindings(base, { ...base, analyser: 'rules@x', commit: 'b', findings })).toBeNull();
  });
});
