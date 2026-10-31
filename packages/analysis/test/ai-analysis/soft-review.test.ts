import { describe, expect, it } from 'vitest';

import { analyseRepo } from '../../src/analyser.js';
import {
  buildSoftReviewPack,
  decideJudgement,
  decideSoftReview,
  runFinalJudge,
  runSoftReview,
  SOFT_FINDING_IDS,
  SOFT_REVIEW_SYSTEM,
  softReviewFileRequests,
  softReviewTargets,
  type JudgeOutput,
  type SoftReviewWire,
} from '../../src/ai-analysis/judge.js';
import { TREE_PATHS, type FileTree } from '../../src/detectors.js';
import { normalizeDeploymentManifest } from '../../src/manifest.js';
import { buildReadinessReport, type ReadinessFinding } from '../../src/readiness-report.js';
import { vendorResourceOverrides } from '../../src/vendor-disputes.js';
import { fakeGateway } from './helpers.js';

// A loopback listen in source and an SQLite driver: two soft findings, NOT_DEPLOYABLE.
const tree: FileTree = {
  Dockerfile: ['FROM node:20-alpine', 'WORKDIR /app', 'COPY . .', 'ENV LISTEN_HOST=0.0.0.0', 'EXPOSE 3000', 'CMD ["node", "src/index.js"]'].join('\n'),
  'package.json': JSON.stringify({ name: 'app', dependencies: { express: '^4.0.0', 'better-sqlite3': '^9.0.0' } }),
  'src/index.js': ["const app = require('express')();", "app.get('/health', (req, res) => res.send('ok'));", "app.listen(3000, '127.0.0.1');"].join('\n'),
};
const files: FileTree = { ...tree, 'README.md': '# Notes\n\nNotes keeps its data in PostgreSQL when DATABASE_URL is set.' };
Object.defineProperty(files, TREE_PATHS, { value: [...Object.keys(tree), 'README.md'], enumerable: false });
const analysis = analyseRepo(tree);
const manifest = normalizeDeploymentManifest(analysis, {});
const report = buildReadinessReport(analysis);
const targets = softReviewTargets(report.findings);

const finding = (id: string, fixClass: ReadinessFinding['fixClass']): ReadinessFinding => ({
  id,
  category: 'test',
  title: id,
  severity: 'required',
  blocking: fixClass === 'CAPABILITY_GAP',
  ...(fixClass ? { fixClass } : {}),
  plainEnglishExplanation: '',
  whyItMatters: '',
  technicalEvidence: `${id} evidence`,
  suggestedOutcome: '',
  confidence: 'confirmed',
});

const dockerfileCite = { path: 'Dockerfile', line: 4, quote: 'ENV LISTEN_HOST=0.0.0.0' };
const wire = (reviews: SoftReviewWire['reviews']): SoftReviewWire => ({ reviews });

describe('soft and hard findings', () => {
  it('reviews only when every finding that makes the outcome is soft', () => {
    expect(report.outcome).toBe('NOT_DEPLOYABLE');
    expect(targets.map((target) => target.id).sort()).toEqual(['localhost-binding', 'unsupported-database-sqlite']);
  });

  it('never reviews a hard finding, alone or next to soft ones', () => {
    expect(softReviewTargets([finding('unsupported-database-mongo', 'CAPABILITY_GAP')])).toEqual([]);
    expect(softReviewTargets([finding('unsupported-persistent-volume', 'CODE_CHANGE'), finding('dockerfile-missing-sources', 'CODE_CHANGE')])).toEqual([]);
    expect(softReviewTargets([finding('unsupported-persistent-volume', 'CODE_CHANGE'), finding('build-context-git-metadata', 'CODE_CHANGE')])).toEqual([]);
  });

  it('ignores settings, and has nothing to review for a DEPLOYABLE outcome', () => {
    expect(softReviewTargets([finding('port-unresolved', 'SETTING')])).toEqual([]);
    expect(softReviewTargets([finding('localhost-binding', 'CODE_CHANGE'), finding('port-unresolved', 'SETTING')]).map((target) => target.id)).toEqual(['localhost-binding']);
  });

  it('keeps security, platform and source findings hard', () => {
    for (const id of ['unsupported-gpu', 'unsupported-architecture', 'unsupported-no-dockerfile', 'build-context-git-metadata', 'unsupported-datastore-server', 'unsupported-database-mongo', 'unsupported-message-queue', 'final-review-unsupported']) {
      expect(SOFT_FINDING_IDS.has(id)).toBe(false);
    }
  });
});

describe('the soft review pack', () => {
  const pack = buildSoftReviewPack({ outcome: 'NOT_DEPLOYABLE', manifest, answers: [], files, findings: targets });

  it('names each finding by position and shows the Dockerfile, the README and the file the evidence names', () => {
    expect(pack.prompt).toContain('- f1: ');
    expect(pack.prompt).toContain('- f2: ');
    expect(pack.prompt).toContain('4| ENV LISTEN_HOST=0.0.0.0');
    expect(pack.prompt).toContain('3| app.listen(3000, \'127.0.0.1\');');
    expect(pack.prompt).toContain('Notes keeps its data in PostgreSQL');
  });

  it('asks for the files it does not have', () => {
    const listing: FileTree = {};
    Object.defineProperty(listing, TREE_PATHS, { value: [...Object.keys(tree), 'README.md', '.env.example'], enumerable: false });
    expect(softReviewFileRequests(manifest, targets, listing).sort()).toEqual(['.env.example', 'Dockerfile', 'README.md', 'src/index.js']);
  });
});

describe('decideSoftReview (ask, never remove)', () => {
  const pack = buildSoftReviewPack({ outcome: 'NOT_DEPLOYABLE', manifest, answers: [], files, findings: targets });
  const bindIndex = targets.findIndex((target) => target.id === 'localhost-binding') + 1;

  it('asks the vendor for a cited "probably_wrong"', () => {
    const items = decideSoftReview(targets, wire([{ id: `f${bindIndex}`, verdict: 'probably_wrong', reason: 'The image sets 0.0.0.0.', evidence: [dockerfileCite] }]), pack.windows);
    const bind = items.find((item) => item.findingId === 'localhost-binding')!;
    expect(bind).toMatchObject({ verdict: 'probably_wrong', question: true, checkReasons: [] });
    expect(items.filter((item) => item.findingId !== 'localhost-binding').every((item) => !item.question)).toBe(true);
  });

  it('asks nothing when the quote is not on the cited line or there is no evidence', () => {
    const wrongQuote = decideSoftReview(targets, wire([{ id: `f${bindIndex}`, verdict: 'probably_wrong', reason: 'x', evidence: [{ ...dockerfileCite, line: 2 }] }]), pack.windows);
    expect(wrongQuote.every((item) => !item.question)).toBe(true);
    const none = decideSoftReview(targets, wire([{ id: `f${bindIndex}`, verdict: 'probably_wrong', reason: 'x', evidence: [] }]), pack.windows);
    expect(none.find((item) => item.findingId === 'localhost-binding')).toMatchObject({ question: false, checkReasons: ['no evidence'] });
  });

  it('keeps every finding and the outcome, marks the questioned one and adds the vendor question', () => {
    const reviews = decideSoftReview(targets, wire([{ id: `f${bindIndex}`, verdict: 'probably_wrong', reason: 'The image sets 0.0.0.0.', evidence: [dockerfileCite] }]), pack.windows);
    const after = buildReadinessReport({ ...analysis, metadata: { ...analysis.metadata, aiSoftReview: { status: 'ok', reviews } } });
    expect(after.outcome).toBe(report.outcome);
    for (const before of report.findings) expect(after.findings.some((item) => item.id === before.id && item.severity === before.severity)).toBe(true);
    expect(after.findings.find((item) => item.id === 'localhost-binding')).toMatchObject({ severity: 'required', confidence: 'needs_confirmation' });
    const question = after.findings.find((item) => item.id === 'final-review-confirm-localhost-binding')!;
    expect(question).toMatchObject({ severity: 'recommended', fixClass: 'SETTING', confidence: 'needs_confirmation' });
    expect(question.technicalEvidence).toContain('Dockerfile:4 "ENV LISTEN_HOST=0.0.0.0"');
  });

  it('adds no question when the final judge blocks', () => {
    const reviews = decideSoftReview(targets, wire([{ id: `f${bindIndex}`, verdict: 'probably_wrong', reason: 'x', evidence: [dockerfileCite] }]), pack.windows);
    const after = buildReadinessReport({
      ...analysis,
      metadata: {
        ...analysis.metadata,
        aiSoftReview: { status: 'ok', reviews },
        aiJudge: { status: 'ok', judgement: { decision: 'block', verdict: 'not_deployable', category: 'local_disk_data', reason: 'x', evidence: [], checkReasons: [] } },
      },
    });
    expect(after.findings.some((item) => item.id.startsWith('final-review-confirm-'))).toBe(false);
  });
});

describe('runSoftReview', () => {
  it('sends its own system prompt and falls back on an answer that does not parse', async () => {
    const gateway = fakeGateway(wire([]));
    const record = await runSoftReview({ outcome: 'NOT_DEPLOYABLE', manifest, answers: [], files, findings: targets }, gateway);
    expect(gateway.systems[0]).toBe(SOFT_REVIEW_SYSTEM);
    expect(record.status === 'ok' && record.reviews.every((item) => item.verdict === 'stands')).toBe(true);
    expect((await runSoftReview({ outcome: 'NOT_DEPLOYABLE', manifest, answers: [], files, findings: targets }, fakeGateway({ reviews: 'no' }))).status).toBe('fallback');
  });
});

describe('the stricter-only judge with vendor answers', () => {
  const kafka = { path: 'README.md', line: 3, quote: 'Notes keeps its data in PostgreSQL' };
  const block = (category: JudgeOutput['category']): JudgeOutput => ({ verdict: 'not_deployable', category, reason: 'x', evidence: [kafka] });
  const pack = buildSoftReviewPack({ outcome: 'NOT_DEPLOYABLE', manifest, answers: [], files, findings: targets });
  const answers = [{ id: 'unsupported-database-mongo', technicalEvidence: 'Unsupported database: MongoDB driver mongoose.' }];

  it('turns a block in a disputed category into a question, and still blocks another category', () => {
    expect(decideJudgement('DEPLOYABLE', block('unsupported_service'), pack.windows, answers).decision).toBe('question');
    expect(decideJudgement('DEPLOYABLE', block('several_services'), pack.windows, answers).decision).toBe('block');
    expect(decideJudgement('DEPLOYABLE', block('unsupported_service'), pack.windows).decision).toBe('block');
  });

  it('shows the vendor answers to the judge', async () => {
    const gateway = fakeGateway({ verdict: 'keep', category: null, reason: 'ok', evidence: [] });
    await runFinalJudge({ outcome: 'DEPLOYABLE', manifest, answers: [], files, vendorAnswers: answers }, gateway);
    expect(gateway.prompts[0]).toContain('The vendor answered that these items are not used in production.');
    expect(gateway.prompts[0]).toContain('- Unsupported database: MongoDB driver mongoose.');
  });
});

describe('a vendor answer on a questioned loopback binding', () => {
  it('applies while the evidence matches and removes the finding', () => {
    const evidence = report.findings.find((item) => item.id === 'localhost-binding')!.technicalEvidence;
    const vendor = vendorResourceOverrides(analysis, [{ findingId: 'localhost-binding', reason: evidence, dismissedAt: 'now', dismissedBy: 'u' }]);
    expect(vendor.overrides).toEqual({ loopbackBinding: false });
    expect(buildReadinessReport(analyseRepo(tree, vendor.overrides)).findings.some((item) => item.id === 'localhost-binding')).toBe(false);
    expect(vendorResourceOverrides(analysis, [{ findingId: 'localhost-binding', reason: 'other', dismissedAt: 'now', dismissedBy: 'u' }]).applied).toBe(false);
  });
});
