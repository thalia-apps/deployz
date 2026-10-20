import { describe, expect, it } from 'vitest';

import { analyseRepo } from '../../src/analyser.js';
import type { BlockerAnswer, FactAnswer } from '../../src/ai-analysis/analyst.js';
import { checkAnswers } from '../../src/ai-analysis/checks.js';
import { buildEvidencePack } from '../../src/ai-analysis/evidence-pack.js';
import { mergeAiAnswers } from '../../src/ai-analysis/merge.js';
import type { FileTree } from '../../src/detectors.js';
import { blocker, cite, fact, MONGO_DECLARED_ONLY, MONGO_OR_POSTGRES } from './helpers.js';

function merge(tree: FileTree, blockers: BlockerAnswer[], facts: FactAnswer[] = []) {
  const rules = analyseRepo(tree);
  const pack = buildEvidencePack(tree, rules);
  const answers = { blockers, facts };
  const dockerfile = typeof rules.metadata['dockerfilePath'] === 'string' ? rules.metadata['dockerfilePath'] : null;
  const checks = checkAnswers({ pack, tree, dockerfile, database: 'none' }, blockers, facts);
  return { rules, result: mergeAiAnswers({ tree, rules, pack, answers, checks }) };
}

const reasons = (analysis: { metadata: Record<string, unknown> }) => analysis.metadata['unsupportedReasons'] as string[];
const variable = (analysis: { metadata: Record<string, unknown> }, key: string) =>
  (analysis.metadata['envVarModel'] as Array<Record<string, unknown>>).find((entry) => entry['key'] === key);

const DB_TYPE = [...cite('src/db.js', 1, 'process.env.DB_TYPE'), ...cite('src/db.js', 2, "type === 'postgres'")];

describe('mergeAiAnswers: blockers', () => {
  it('"optional by setting" dismisses the rejection, adds the engine, and asks the vendor for the setting', () => {
    const { rules, result } = merge(MONGO_OR_POSTGRES, [
      blocker('q1', 'optional_by_setting', { setting: 'DB_TYPE', settingValue: 'postgres', engine: 'postgres', evidence: DB_TYPE }),
    ]);
    expect(reasons(rules)).toHaveLength(1);
    expect(reasons(result.analysis)).toEqual([]);
    expect(result.analysis.rejections.some((rejection) => rejection.dependency === 'mongoose')).toBe(false);
    expect((result.analysis.metadata['postgres'] as { required: boolean }).required).toBe(true);
    expect(variable(result.analysis, 'DB_TYPE')).toMatchObject({ required: true, classification: 'customer_required', source: ['AI Analysis: set DB_TYPE=postgres to use postgres'] });
    expect(result.settings).toEqual([{ dependency: 'mongoose', setting: 'DB_TYPE', value: 'postgres', engine: 'postgres', vendor: true }]);
    expect(result.answers).toEqual([expect.objectContaining({ id: 'q1', subject: 'mongoose', decision: 'ai' })]);
  });

  it('a setting that Deployz sets itself needs no vendor change', () => {
    const tree: FileTree = {
      ...MONGO_OR_POSTGRES,
      'src/db.js': ["const url = process.env.DATABASE_URL || 'mongodb://localhost/app';", "if (url.startsWith('postgres://')) module.exports = require('./pg');", "else module.exports = require('mongoose');"].join('\n'),
    };
    const { result } = merge(tree, [
      blocker('q1', 'optional_by_setting', {
        setting: 'DATABASE_URL',
        settingValue: 'postgres://',
        engine: 'postgres',
        evidence: [...cite('src/db.js', 1, 'process.env.DATABASE_URL'), ...cite('src/db.js', 2, "url.startsWith('postgres://')")],
      }),
    ]);
    expect(reasons(result.analysis)).toEqual([]);
    expect(result.settings[0]).toMatchObject({ setting: 'DATABASE_URL', vendor: false });
    expect(variable(result.analysis, 'DATABASE_URL')?.['classification']).not.toBe('customer_required');
  });

  it('"not used" dismisses the rejection and adds nothing', () => {
    const { result } = merge(MONGO_DECLARED_ONLY, [blocker('q1', 'not_used', { evidence: cite('src/index.js', 1, "require('express')") })]);
    expect(reasons(result.analysis)).toEqual([]);
    expect((result.analysis.metadata['postgres'] as { required: boolean }).required).toBe(false);
    expect(result.settings).toEqual([]);
  });

  it('keeps the rejection for "required" and for an answer that fails its check', () => {
    for (const answer of [blocker('q1', 'required'), blocker('q1', 'not_used', { evidence: cite('src/index.js', 1, "require('express')") })]) {
      const { rules, result } = merge(MONGO_OR_POSTGRES, [answer]);
      expect(reasons(result.analysis)).toEqual(reasons(rules));
      expect(result.answers[0]!.decision).toBe('rules');
    }
  });

  it('dismisses declared local-filesystem state that the code never uses', () => {
    const tree: FileTree = {
      Dockerfile: ['FROM node:20', 'COPY . .', 'VOLUME /data', 'EXPOSE 3000', 'CMD ["node", "src/index.js"]'].join('\n'),
      'package.json': JSON.stringify({ name: 'a', dependencies: { express: '^4' } }),
      'src/index.js': "const app = require('express')();\napp.get('/health', (q, r) => r.send('ok'));\napp.listen(process.env.PORT || 3000);",
    };
    const rules = analyseRepo(tree);
    expect(rules.metadata['usesLocalFilesystem']).toBe(true);
    const id = buildEvidencePack(tree, rules).questions.find((question) => question.kind === 'blocker')!.id;
    const { result } = merge(tree, [blocker(id, 'not_used', { evidence: cite('Dockerfile', 3, 'VOLUME /data') })]);
    expect(result.analysis.metadata['usesLocalFilesystem']).toBe(false);
  });
});

describe('mergeAiAnswers: open facts', () => {
  const tree: FileTree = {
    Dockerfile: 'FROM node:20\nEXPOSE 3000\nCMD ["node", "src/index.js"]',
    'package.json': JSON.stringify({ name: 'a', dependencies: { express: '^4' } }),
    'src/index.js': "const app = require('express')();\napp.use('/', require('./pages'));\napp.listen(3000);",
  };
  const id = buildEvidencePack(tree, analyseRepo(tree)).questions.find((question) => question.kind === 'fact')!.id;

  it('a health path that passes enters the analysis', () => {
    const { result } = merge(tree, [], [fact(id, '/', { evidence: cite('src/index.js', 2, "app.use('/'") })]);
    expect(result.analysis.metadata).toMatchObject({ healthPath: '/', healthMode: 'explicit' });
    expect(result.answers).toEqual([expect.objectContaining({ subject: 'healthPath', decision: 'ai' })]);
  });

  it('an unknown or failing fact leaves the rules question open', () => {
    for (const answer of [fact(id, null), fact(id, '/nope', { evidence: cite('src/index.js', 2, "app.use('/'") })]) {
      const { result } = merge(tree, [], [answer]);
      expect(result.analysis.metadata['healthMode']).toBe('vendor_required');
      expect(result.answers[0]!.decision).toBe('rules');
    }
  });
});
