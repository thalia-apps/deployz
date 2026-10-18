import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildReports, loadAnalyses, parseClaimsArgs } from './cli.js';
import { makeAnalysis, makeManifest, makeObservation, makeRun } from './test-support.js';

describe('parseClaimsArgs', () => {
  it('reads repeated --repo and --analysis', () => {
    expect(parseClaimsArgs(['--repo', 'repo-001', '--repo', 'F1', '--analysis', 'analyses/x'])).toEqual({
      ids: ['repo-001', 'F1'],
      analysis: 'analyses/x',
    });
  });

  it('has no ids and no analysis by default', () => {
    expect(parseClaimsArgs([])).toEqual({ ids: [], analysis: undefined });
  });

  it('refuses an unknown option', () => {
    expect(() => parseClaimsArgs(['--force'])).toThrow();
  });
});

describe('loadAnalyses', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runcheck-claims-'));
    mkdirSync(dir, { recursive: true });
    for (const id of ['repo-002', 'repo-001']) {
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(makeAnalysis(makeManifest(), undefined, { id })));
    }
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('loads a folder, sorted by id', () => {
    expect(loadAnalyses(dir, []).map((analysis) => analysis.id)).toEqual(['repo-001', 'repo-002']);
  });

  it('loads one file', () => {
    expect(loadAnalyses(join(dir, 'repo-002.json'), []).map((analysis) => analysis.id)).toEqual(['repo-002']);
  });

  it('selects ids and refuses an unknown id', () => {
    expect(loadAnalyses(dir, ['repo-002']).map((analysis) => analysis.id)).toEqual(['repo-002']);
    expect(() => loadAnalyses(dir, ['repo-009'])).toThrow('No analysis for repo-009');
  });
});

describe('buildReports', () => {
  const analyses = [makeAnalysis(makeManifest(), undefined, { id: 'repo-001' }), makeAnalysis(makeManifest(), undefined, { id: 'repo-002' })];
  const observation = makeObservation(makeRun(), { id: 'repo-001', set: 'holdout' });

  it('reports each analysis that has an observation and lists the others', () => {
    const { reports, withoutObservation } = buildReports(
      analyses,
      (id) => (id === 'repo-001' ? observation : null),
      () => null,
    );
    expect(reports.map((report) => [report.id, report.set])).toEqual([['repo-001', 'holdout']]);
    expect(withoutObservation).toEqual(['repo-002']);
  });

  it('asks for the full run of the analyser and the id', () => {
    const asked: string[] = [];
    buildReports(
      analyses.slice(0, 1),
      () => observation,
      (analyser, id) => {
        asked.push(`${analyser}/${id}`);
        return null;
      },
    );
    expect(asked).toEqual(['rules@abc1234/repo-001']);
  });
});
