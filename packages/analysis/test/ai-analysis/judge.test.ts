import { describe, expect, it } from 'vitest';

import { analyseRepo } from '../../src/analyser.js';
import { buildJudgePack, decideJudgement, JUDGE_SYSTEM, judgeFileRequests, runFinalJudge, type JudgeOutput } from '../../src/ai-analysis/judge.js';
import { TREE_PATHS, type FileTree } from '../../src/detectors.js';
import { normalizeDeploymentManifest } from '../../src/manifest.js';
import { buildReadinessReport } from '../../src/readiness-report.js';
import { fakeGateway } from './helpers.js';

const tree: FileTree = {
  Dockerfile: ['FROM node:20-alpine', 'WORKDIR /app', 'COPY . .', 'EXPOSE 3000', 'CMD ["node", "src/index.js"]'].join('\n'),
  'package.json': JSON.stringify({ name: 'app', dependencies: { express: '^4.0.0' } }),
  'src/index.js': ["const app = require('express')();", "app.get('/health', (req, res) => res.send('ok'));", 'app.listen(process.env.PORT || 3000);'].join('\n'),
};
const README = ['[![build](https://example.com/badge.svg)](https://example.com)', '', '# Ledger', '', 'Ledger keeps every event in ClickHouse and needs Kafka for ingestion.'].join('\n');
const analysis = analyseRepo(tree);
const manifest = normalizeDeploymentManifest(analysis, {});
const files: FileTree = { ...tree, 'README.md': README };
Object.defineProperty(files, TREE_PATHS, { value: [...Object.keys(tree), 'README.md'], enumerable: false });

const cite = { path: 'README.md', line: 5, quote: 'needs Kafka for ingestion' };
const output = (overrides: Partial<JudgeOutput>): JudgeOutput => ({ verdict: 'keep', category: null, reason: 'It fits.', evidence: [], ...overrides });

describe('the judge pack', () => {
  const pack = buildJudgePack({ outcome: 'DEPLOYABLE', manifest, answers: [], files });

  it('asks for the README it does not have', () => {
    const listing: FileTree = { ...tree };
    Object.defineProperty(listing, TREE_PATHS, { value: [...Object.keys(tree), 'README.md'], enumerable: false });
    expect(judgeFileRequests(manifest, listing)).toEqual(['README.md']);
  });

  it('shows the outcome, the README from its first heading and the Dockerfile with line numbers', () => {
    expect(pack.prompt).toContain('Outcome so far: DEPLOYABLE');
    expect(pack.prompt).toContain('5| Ledger keeps every event in ClickHouse');
    expect(pack.prompt).not.toContain('badge.svg');
    expect(pack.prompt).toContain('5| CMD ["node", "src/index.js"]');
  });
});

describe('decideJudgement (stricter only)', () => {
  const windows = buildJudgePack({ outcome: 'DEPLOYABLE_WITH_CHANGES', manifest, answers: [], files }).windows;

  it('blocks a cited "not_deployable" with a category', () => {
    const judgement = decideJudgement('DEPLOYABLE_WITH_CHANGES', output({ verdict: 'not_deployable', category: 'unsupported_service', evidence: [cite] }), windows);
    expect(judgement.decision).toBe('block');
  });

  it('turns a "not_deployable" whose quote is not on the cited line into a question', () => {
    const judgement = decideJudgement('DEPLOYABLE', output({ verdict: 'not_deployable', category: 'unsupported_service', evidence: [{ ...cite, quote: 'needs MongoDB' }] }), windows);
    expect(judgement.decision).toBe('question');
    expect(judgement.checkReasons[0]).toMatch(/README.md:5/);
  });

  it('turns a "not_deployable" without evidence or a category into a question', () => {
    expect(decideJudgement('DEPLOYABLE', output({ verdict: 'not_deployable', category: 'unsupported_service' }), windows).decision).toBe('question');
    expect(decideJudgement('DEPLOYABLE', output({ verdict: 'not_deployable', evidence: [cite] }), windows).decision).toBe('question');
  });

  it('applies "needs_changes" only to a DEPLOYABLE outcome', () => {
    const change = output({ verdict: 'needs_changes', evidence: [cite] });
    expect(decideJudgement('DEPLOYABLE', change, windows).decision).toBe('change');
    expect(decideJudgement('DEPLOYABLE_WITH_CHANGES', change, windows).decision).toBe('none');
  });

  it('asks the vendor for "not_sure" and changes nothing for "keep"', () => {
    expect(decideJudgement('DEPLOYABLE', output({ verdict: 'not_sure', category: 'several_services', evidence: [cite] }), windows).decision).toBe('question');
    expect(decideJudgement('DEPLOYABLE', output({}), windows).decision).toBe('none');
  });
});

describe('runFinalJudge', () => {
  it('skips an outcome that is already NOT_DEPLOYABLE and makes no call', async () => {
    const gateway = fakeGateway(output({}));
    const record = await runFinalJudge({ outcome: 'NOT_DEPLOYABLE', manifest, answers: [], files }, gateway);
    expect(record).toMatchObject({ status: 'skipped', reason: 'not_deployable' });
    expect(gateway.prompts).toHaveLength(0);
  });

  it('sends the policy as the system message and records the judgement', async () => {
    const gateway = fakeGateway(output({ verdict: 'not_deployable', category: 'unsupported_service', reason: 'It needs Kafka.', evidence: [cite] }));
    const record = await runFinalJudge({ outcome: 'DEPLOYABLE', manifest, answers: [], files }, gateway);
    expect(gateway.systems[0]).toBe(JUDGE_SYSTEM);
    expect(record.status === 'ok' && record.judgement.decision).toBe('block');
  });

  it('falls back and changes nothing when the answer does not parse', async () => {
    const record = await runFinalJudge({ outcome: 'DEPLOYABLE', manifest, answers: [], files }, fakeGateway({ verdict: 'maybe' }));
    expect(record.status).toBe('fallback');
  });
});

describe('the readiness report with a judgement', () => {
  const judged = (decision: 'block' | 'change' | 'question') =>
    buildReadinessReport({
      ...analysis,
      metadata: {
        ...analysis.metadata,
        aiJudge: {
          status: 'ok',
          judgement: { decision, verdict: 'not_deployable', category: 'unsupported_service', reason: 'It needs Kafka.', evidence: [cite], checkReasons: [] },
        },
      },
    });
  const before = buildReadinessReport(analysis);

  it('only ever adds a finding', () => {
    for (const decision of ['block', 'change', 'question'] as const) {
      const after = judged(decision);
      expect(after.findings.slice(0, -1).map((finding) => finding.id).sort()).toEqual(before.findings.map((finding) => finding.id).sort());
    }
  });

  it('makes a block NOT_DEPLOYABLE, a change DEPLOYABLE_WITH_CHANGES and a question a recommended confirmation', () => {
    expect(before.outcome).toBe('DEPLOYABLE');
    expect(judged('block').outcome).toBe('NOT_DEPLOYABLE');
    expect(judged('change').outcome).toBe('DEPLOYABLE_WITH_CHANGES');
    const question = judged('question');
    expect(question.outcome).toBe('DEPLOYABLE');
    expect(question.findings.find((finding) => finding.id === 'final-review-question')).toMatchObject({ severity: 'recommended', confidence: 'needs_confirmation' });
  });

  it('puts the reason and the cited line in the technical evidence, not in the customer copy', () => {
    const finding = judged('block').findings.find((item) => item.id === 'final-review-unsupported')!;
    expect(finding.title).toBe('Needs a service Deployz cannot host');
    expect(finding.plainEnglishExplanation).not.toContain('Kafka');
    expect(finding.technicalEvidence).toContain('README.md:5 "needs Kafka for ingestion"');
  });

  it('blocks the deployment gate for a block only', () => {
    const blocked = normalizeDeploymentManifest({ metadata: { ...analysis.metadata, aiJudge: { status: 'ok', judgement: { decision: 'block', reason: 'It needs Kafka.' } } } }, {});
    const asked = normalizeDeploymentManifest({ metadata: { ...analysis.metadata, aiJudge: { status: 'ok', judgement: { decision: 'question', reason: 'It may need Kafka.' } } } }, {});
    expect(blocked.unsupported).toContain('Final review: It needs Kafka.');
    expect(asked.unsupported).toEqual(manifest.unsupported);
  });
});
