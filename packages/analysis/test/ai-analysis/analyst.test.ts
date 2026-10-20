import { describe, expect, it } from 'vitest';

import { analyseRepo } from '../../src/analyser.js';
import { SpendLimitExceededError } from '../../src/ai-gateway.js';
import { ANALYST_MAX_TOTAL_TOKENS, ANALYST_SYSTEM, fromWire, runAnalyst } from '../../src/ai-analysis/analyst.js';
import { buildEvidencePack } from '../../src/ai-analysis/evidence-pack.js';
import { blocker, cite, fact, fakeGateway, MONGO_OR_POSTGRES, toWire } from './helpers.js';

const tree = { ...MONGO_OR_POSTGRES, 'src/index.js': "const app = require('express')();\napp.listen(process.env.PORT || 3000);" };
const pack = buildEvidencePack(tree, analyseRepo(tree));

describe('the analyst questions', () => {
  it('asks the datastore blocker and the open health path, and nothing else', () => {
    expect(pack.questions.map((question) => (question.kind === 'fact' ? question.fact : question.category))).toEqual(['datastore', 'healthPath']);
  });
});

describe('fromWire', () => {
  it('splits the answers by question kind', () => {
    const output = fromWire(toWire([blocker('q1', 'required')], [fact('q2', '/health')]), pack);
    expect(output.blockers).toEqual([blocker('q1', 'required')]);
    expect(output.facts).toEqual([fact('q2', '/health')]);
  });

  it('reads an "unknown" fact as no value', () => {
    const wire = toWire([], [fact('q2', 'x')]);
    wire.answers[0]!.answer = 'unknown';
    expect(fromWire(wire, pack).facts[0]!.value).toBeNull();
  });

  it('refuses an unknown question, a repeated answer and an answer outside the closed set', () => {
    expect(() => fromWire(toWire([blocker('q9', 'required')]), pack)).toThrow(/unknown question q9/);
    expect(() => fromWire(toWire([blocker('q1', 'required'), blocker('q1', 'not_used')]), pack)).toThrow(/twice/);
    expect(() => fromWire(toWire([{ ...blocker('q1', 'required'), answer: 'maybe' as 'required' }]), pack)).toThrow();
    expect(() => fromWire(toWire([blocker('q1', 'optional_by_setting', { engine: 'mongodb' as 'postgres' })]), pack)).toThrow();
  });
});

describe('runAnalyst', () => {
  it('sends the instructions as the system message and the pack as the prompt', async () => {
    const gateway = fakeGateway(toWire([blocker('q1', 'required')], [fact('q2', null)]));
    const result = await runAnalyst(pack, gateway);
    expect(gateway.systems[0]).toBe(ANALYST_SYSTEM);
    expect(gateway.prompts[0]).toContain('## Question q1 (kind "blocker", datastore)');
    expect(gateway.prompts[0]).toContain('src/db.js');
    expect(result.output.blockers[0]!.answer).toBe('required');
  });

  it('fails the spend check on the reported usage', async () => {
    const gateway = fakeGateway(toWire([blocker('q1', 'required', { evidence: cite('src/db.js', 1, 'DB_TYPE') })]), {
      promptTokens: ANALYST_MAX_TOTAL_TOKENS,
      completionTokens: 1,
    });
    await expect(runAnalyst(pack, gateway)).rejects.toBeInstanceOf(SpendLimitExceededError);
  });
});
