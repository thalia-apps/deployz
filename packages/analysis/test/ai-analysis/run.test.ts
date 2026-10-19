import { describe, expect, it } from 'vitest';

import { analyseRepo } from '../../src/analyser.js';
import { SpendLimitExceededError, type AiGateway } from '../../src/ai-gateway.js';
import { ANALYST_PROMPT_VERSION, REVIEWER_PROMPT_VERSION, parseAnalysisEngine, runAiAnalysis } from '../../src/ai-analysis/index.js';
import type { FileTree } from '../../src/detectors.js';
import { cite, factsOf, fakeGateway, toWire } from './helpers.js';

const tree: FileTree = {
  Dockerfile: ['FROM node:20', 'EXPOSE 3000', 'CMD ["node", "dist/index.js"]'].join('\n'),
  'package.json': JSON.stringify({ name: 'a', scripts: { start: 'node dist/index.js' }, dependencies: { express: '^4' } }),
  'src/index.ts': "app.get('/health', r);\napp.listen(3000);",
};

const rules = analyseRepo(tree);
const gatewaysOf = (analyst: AiGateway, reviewer?: AiGateway) => ({ tree, rules, gateways: { analyst, reviewer } });

const agreeingFacts = factsOf({ port: { value: 3000, confidence: 'high', evidence: cite('Dockerfile', 2, 'EXPOSE 3000') } });
const throwing = (error: Error): AiGateway => ({ generate: () => Promise.reject(error) });

describe('runAiAnalysis', () => {
  it('returns the merge and a report from a fake analyst and reviewer', async () => {
    const analyst = fakeGateway(
      toWire(factsOf({ port: { value: 9000, confidence: 'high', evidence: cite('Dockerfile', 2, 'EXPOSE 3000') } })),
      { promptTokens: 1000, completionTokens: 200 },
    );
    const reviewer = fakeGateway(
      {
        objections: [
          { fact: 'port', subject: null, reason: 'EXPOSE says 3000', proposedValue: '3000', evidence: cite('Dockerfile', 2, 'EXPOSE 3000') },
          { fact: 'healthPath', subject: null, reason: 'no route', proposedValue: '"/nope"', evidence: cite('Dockerfile', 1, 'FROM node:20') },
        ],
      },
      { promptTokens: 2000, completionTokens: 100 },
    );

    const { merge, report } = await runAiAnalysis(gatewaysOf(analyst, reviewer));

    expect(merge.analysis.metadata['port']).toBe('3000');
    expect(merge.analysis.metadata['healthPath']).toBeNull();
    expect(merge.analysis.metadata['healthMode']).toBe('vendor_required');
    expect(report.promptVersions).toEqual({ analyst: ANALYST_PROMPT_VERSION, reviewer: REVIEWER_PROMPT_VERSION });
    expect(report.analyst).toMatchObject({ model: 'fake-model', usage: { promptTokens: 1000, completionTokens: 200 } });
    expect(report.reviewer).toMatchObject({ model: 'fake-model', usage: { promptTokens: 2000, completionTokens: 100 } });
    expect(report.objections).toEqual({ total: 2, confirmed: 1, questions: 1 });
    expect(report.failedChecks).toBe(1);
    expect(report.facts).toBe(merge.facts);
    expect(report.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('gives the analyst the numbered evidence pack and the reviewer the proposed facts', async () => {
    const analyst = fakeGateway(toWire(agreeingFacts));
    const reviewer = fakeGateway({ objections: [] });
    await runAiAnalysis(gatewaysOf(analyst, reviewer));
    expect(analyst.prompts).toHaveLength(1);
    expect(analyst.prompts[0]).toContain('<<<FILE Dockerfile');
    expect(analyst.prompts[0]).toContain('2| EXPOSE 3000');
    expect(reviewer.prompts).toHaveLength(1);
    expect(reviewer.prompts[0]).toContain('## Proposed facts (JSON)');
    expect(reviewer.prompts[0]).toContain('"value":"3000"');
    // The instructions travel as the system message; the user message holds only the data.
    expect(analyst.systems[0]).toContain('UNTRUSTED DATA');
    expect(analyst.prompts[0]).not.toContain('UNTRUSTED DATA');
    expect(reviewer.systems[0]).toContain('Object ONLY');
  });

  it('works without a reviewer gateway', async () => {
    const { merge, report } = await runAiAnalysis(gatewaysOf(fakeGateway(toWire(agreeingFacts))));
    expect(report.reviewer).toBeNull();
    expect(report.objections).toEqual({ total: 0, confirmed: 0, questions: 0 });
    expect(merge.analysis.metadata['port']).toBe('3000');
    expect(merge.facts.find((item) => item.fact === 'port')?.decision).toBe('agree');
  });

  it('counts a failed check of the analyst in the report', async () => {
    const analyst = fakeGateway(toWire(factsOf({ port: { value: 9000, confidence: 'high', evidence: cite('Dockerfile', 2, 'EXPOSE 3000') } })));
    const { merge, report } = await runAiAnalysis(gatewaysOf(analyst));
    expect(merge.analysis.metadata['port']).toBeNull();
    expect(report.failedChecks).toBe(1);
  });

  it('rejects when the analyst gateway throws', async () => {
    await expect(runAiAnalysis(gatewaysOf(throwing(new Error('gateway down'))))).rejects.toThrow('gateway down');
  });

  it('rejects when the analyst object fails the schema', async () => {
    await expect(runAiAnalysis(gatewaysOf(fakeGateway({ port: 'three thousand' })))).rejects.toThrow();
    await expect(runAiAnalysis(gatewaysOf(fakeGateway({ ...toWire(agreeingFacts), extra: 1 })))).rejects.toThrow();
  });

  it('rejects when the reviewer gateway throws or returns an object that fails the schema', async () => {
    const analyst = fakeGateway(toWire(agreeingFacts));
    await expect(runAiAnalysis(gatewaysOf(analyst, throwing(new Error('reviewer down'))))).rejects.toThrow('reviewer down');
    await expect(runAiAnalysis(gatewaysOf(analyst, fakeGateway({ objections: [{ fact: 'colour' }] })))).rejects.toThrow();
  });

  it('rejects when a call uses more tokens than its budget', async () => {
    const analyst = fakeGateway(agreeingFacts, { promptTokens: 500_000, completionTokens: 10 });
    await expect(runAiAnalysis(gatewaysOf(analyst))).rejects.toBeInstanceOf(SpendLimitExceededError);
  });
});

describe('parseAnalysisEngine', () => {
  it.each([
    ['ai', 'ai'],
    ['shadow', 'shadow'],
    ['rules', 'rules'],
    [undefined, 'rules'],
    ['', 'rules'],
    ['AI', 'rules'],
    ['hybrid', 'rules'],
  ])('maps %s to %s', (value, expected) => {
    expect(parseAnalysisEngine(value)).toBe(expected);
  });
});
