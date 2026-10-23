import type { VendorDismissedRejection } from '@deployz/contracts';
import { describe, expect, it } from 'vitest';

import { checkAnswers } from '../src/ai-analysis/checks.js';
import { buildEvidencePack } from '../src/ai-analysis/evidence-pack.js';
import { mergeAiAnswers } from '../src/ai-analysis/merge.js';
import { analyseRepo } from '../src/analyser.js';
import type { FileTree } from '../src/detectors.js';
import { buildReadinessReport } from '../src/readiness-report.js';
import { combineOverrides, vendorResourceOverrides } from '../src/vendor-disputes.js';
import { blocker, cite, MONGO_DECLARED_ONLY } from './ai-analysis/helpers.js';

const entry = (findingId: string, reason: string): VendorDismissedRejection => ({
  findingId,
  reason,
  dismissedAt: '2026-10-23T00:00:00.000Z',
  dismissedBy: 'user-1',
});

const finding = (tree: FileTree, id: string) => buildReadinessReport(analyseRepo(tree)).findings.find((item) => item.id === id);

const LOCAL_VOLUME: FileTree = {
  Dockerfile: ['FROM node:20', 'COPY . .', 'VOLUME /data', 'EXPOSE 3000', 'CMD ["node", "src/index.js"]'].join('\n'),
  'package.json': JSON.stringify({ name: 'a', dependencies: { express: '^4' } }),
  'src/index.js': "const app = require('express')();\napp.get('/health', (q, r) => r.send('ok'));\napp.listen(process.env.PORT || 3000);",
};

describe('vendorResourceOverrides', () => {
  it('dismisses a disputed blocker while the evidence is the same', () => {
    const mongo = finding(MONGO_DECLARED_ONLY, 'unsupported-database-mongo')!;
    const rules = analyseRepo(MONGO_DECLARED_ONLY);
    const vendor = vendorResourceOverrides(rules, [entry(mongo.id, mongo.technicalEvidence)]);

    expect(vendor.applied).toBe(true);
    expect([...vendor.matched]).toEqual([0]);
    const report = buildReadinessReport(analyseRepo(MONGO_DECLARED_ONLY, vendor.overrides));
    expect(report.findings.some((item) => item.id === 'unsupported-database-mongo')).toBe(false);
    expect(buildReadinessReport(rules).outcome).toBe('NOT_DEPLOYABLE');
    expect(report.outcome).not.toBe('NOT_DEPLOYABLE');
  });

  it('does not apply an answer whose evidence changed (stale)', () => {
    const mongo = finding(MONGO_DECLARED_ONLY, 'unsupported-database-mongo')!;
    const vendor = vendorResourceOverrides(analyseRepo(MONGO_DECLARED_ONLY), [entry(mongo.id, `${mongo.technicalEvidence} (old)`)]);
    expect(vendor.applied).toBe(false);
    expect(vendor.overrides).toEqual({});
  });

  it('does not apply an answer for another finding id with the same evidence', () => {
    const mongo = finding(MONGO_DECLARED_ONLY, 'unsupported-database-mongo')!;
    const vendor = vendorResourceOverrides(analyseRepo(MONGO_DECLARED_ONLY), [entry('unsupported-message-queue', mongo.technicalEvidence)]);
    expect(vendor.applied).toBe(false);
  });

  it('never applies a finding that is not disputable', () => {
    const tree: FileTree = { ...MONGO_DECLARED_ONLY, 'serverless.yml': 'service: app\n' };
    const architecture = finding(tree, 'unsupported-architecture');
    expect(architecture).toBeDefined();
    const vendor = vendorResourceOverrides(analyseRepo(tree), [entry('unsupported-architecture', architecture!.technicalEvidence)]);
    expect(vendor.applied).toBe(false);
  });

  it('maps local file storage to the local-filesystem override', () => {
    const local = finding(LOCAL_VOLUME, 'local-file-storage')!;
    const vendor = vendorResourceOverrides(analyseRepo(LOCAL_VOLUME), [entry('local-file-storage', local.technicalEvidence)]);
    expect(vendor.overrides).toEqual({ localFilesystem: false });
    expect(finding(LOCAL_VOLUME, 'local-file-storage')).toBeDefined();
    expect(buildReadinessReport(analyseRepo(LOCAL_VOLUME, vendor.overrides)).findings.some((item) => item.id === 'local-file-storage')).toBe(false);
  });
});

describe('combineOverrides', () => {
  it('joins dismissed rejections and keeps the other values', () => {
    expect(combineOverrides({ dismissedRejections: ['a'], localFilesystem: false }, { dismissedRejections: ['b', 'a'], redis: true })).toEqual({
      dismissedRejections: ['a', 'b'],
      localFilesystem: false,
      redis: true,
    });
    expect(combineOverrides(undefined, { redis: true })).toEqual({ redis: true });
  });
});

describe('mergeAiAnswers with vendor base overrides', () => {
  it('keeps a vendor dismissal when an AI answer re-runs the rules', () => {
    const tree: FileTree = { ...MONGO_DECLARED_ONLY, Dockerfile: LOCAL_VOLUME.Dockerfile!, 'src/index.js': LOCAL_VOLUME['src/index.js']! };
    const mongo = finding(tree, 'unsupported-database-mongo')!;
    const vendor = vendorResourceOverrides(analyseRepo(tree), [entry(mongo.id, mongo.technicalEvidence)]);
    const rules = analyseRepo(tree, vendor.overrides);
    const pack = buildEvidencePack(tree, rules);
    const question = pack.questions.find((item) => item.kind === 'blocker');
    expect(question).toBeDefined();
    const blockers = [blocker(question!.id, 'not_used', { evidence: cite('Dockerfile', 3, 'VOLUME /data') })];
    const checks = checkAnswers({ pack, tree, dockerfile: 'Dockerfile', database: 'none' }, blockers, []);
    const answers = { blockers, facts: [] };

    const kept = mergeAiAnswers({ tree, rules, pack, answers, checks, baseOverrides: vendor.overrides });
    expect(kept.analysis.metadata['usesLocalFilesystem']).toBe(false);
    expect(kept.analysis.rejections.some((rejection) => rejection.detected && rejection.dependency === 'mongoose')).toBe(false);

    const lost = mergeAiAnswers({ tree, rules, pack, answers, checks });
    expect(lost.analysis.rejections.some((rejection) => rejection.detected && rejection.dependency === 'mongoose')).toBe(true);
  });
});
