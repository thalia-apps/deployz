import { describe, expect, it } from 'vitest';

import { checkClaims } from '../claims/check.js';
import { extractClaims } from '../claims/extract.js';
import { makeAnalysis, makeManifest, makeObservation, makeRun } from '../claims/test-support.js';
import type { AnalysisResultFile, ClaimVerdict, FullRun, Observation, RepositoryReport } from '../contract.js';
import { fullRunHealth, renderMarkdown, repositoryReport, summaryReport } from './report.js';

type Values = Parameters<typeof makeRun>[0];

function fullRun(patch: Partial<FullRun> = {}): FullRun {
  return {
    schemaVersion: 1,
    id: 'repo-001',
    analyser: 'rules@abc1234',
    arch: 'amd64-emulated',
    startedAt: '2026-10-16T00:00:00.000Z',
    environmentNames: [],
    migration: null,
    webHealthy: true,
    healthPathStatus: 200,
    smokeStatus: 200,
    workers: [],
    evidence: [],
    infrastructureFailures: [],
    ...patch,
  };
}

function report(
  analysis: AnalysisResultFile,
  values: Values = {},
  full: FullRun | null = null,
  options: { unstable?: Observation['unstable']; set?: Observation['set'] } = {},
): RepositoryReport {
  const observation = makeObservation(makeRun(values), { ...options });
  const verdicts = checkClaims(extractClaims(analysis), observation);
  return repositoryReport({ id: 'repo-001', set: options.set ?? 'tuning' }, analysis, observation, verdicts, full);
}

const ready = () => makeAnalysis(makeManifest());
const verdictOf = (result: RepositoryReport, type: string) => result.verdicts.find((entry) => entry.claim.type === type);

describe('repositoryReport', () => {
  it('copies the identity of the repository from the observation', () => {
    expect(report(ready())).toMatchObject({
      id: 'repo-001',
      set: 'tuning',
      repository: 'owner/name',
      commit: 'a'.repeat(40),
      analyser: 'rules@abc1234',
      arch: 'amd64-emulated',
      readiness: 'READY',
    });
  });

  it('has no healthy value and no hidden problem without a full run', () => {
    expect(report(ready())).toMatchObject({ healthyWithAnalysedSettings: null, hiddenProblem: false });
  });

  describe('healthy and hidden problem', () => {
    it('is healthy with a healthy full run', () => {
      expect(report(ready(), {}, fullRun())).toMatchObject({ healthyWithAnalysedSettings: true, hiddenProblem: false });
    });

    it('is a hidden problem when READY and the full run is not healthy', () => {
      expect(report(ready(), {}, fullRun({ webHealthy: false }))).toMatchObject({
        healthyWithAnalysedSettings: false,
        hiddenProblem: true,
      });
    });

    it('is no hidden problem when the Analysis already asked for configuration', () => {
      const analysis = makeAnalysis(makeManifest(), { state: 'NEEDS_CONFIGURATION', findings: [] });
      expect(report(analysis, {}, fullRun({ webHealthy: false })).hiddenProblem).toBe(false);
    });

    it('is no hidden problem when the Analysis said NOT_COMPATIBLE', () => {
      const analysis = makeAnalysis(makeManifest(), { state: 'NOT_COMPATIBLE', findings: [] });
      expect(report(analysis, {}, fullRun({ webHealthy: false })).hiddenProblem).toBe(false);
    });
  });

  describe('readiness verdict', () => {
    it('stays NOT_CHECKABLE without a full run', () => {
      expect(verdictOf(report(ready()), 'readiness')?.verdict).toBe('NOT_CHECKABLE');
    });

    it('confirms READY when the full run is healthy', () => {
      expect(verdictOf(report(ready(), {}, fullRun()), 'readiness')?.verdict).toBe('CONFIRMED');
    });

    it('contradicts READY when the full run is not healthy', () => {
      expect(verdictOf(report(ready(), {}, fullRun({ webHealthy: false })), 'readiness')).toMatchObject({
        verdict: 'CONTRADICTED',
        observed: 'not healthy',
      });
    });

    it('confirms NOT_COMPATIBLE when the full run is not healthy', () => {
      const analysis = makeAnalysis(makeManifest(), { state: 'NOT_COMPATIBLE', findings: [] });
      expect(verdictOf(report(analysis, {}, fullRun({ webHealthy: false })), 'readiness')?.verdict).toBe('CONFIRMED');
    });

    it('contradicts NOT_COMPATIBLE when the full run is healthy', () => {
      const analysis = makeAnalysis(makeManifest(), { state: 'NOT_COMPATIBLE', findings: [] });
      expect(verdictOf(report(analysis, {}, fullRun()), 'readiness')).toMatchObject({ verdict: 'CONTRADICTED', observed: 'healthy' });
    });

    it('leaves NEEDS_CONFIGURATION open', () => {
      const analysis = makeAnalysis(makeManifest(), { state: 'NEEDS_CONFIGURATION', findings: [] });
      expect(verdictOf(report(analysis, {}, fullRun()), 'readiness')?.verdict).toBe('NOT_CHECKABLE');
    });
  });

  describe('false problems', () => {
    const unsupported = { id: 'unsupported', category: 'compatibility', severity: 'error', message: 'Unsupported storage: named volumes.' } as const;
    const notCompatible = makeAnalysis(makeManifest({ unsupported: [unsupported.message] }), { state: 'NOT_COMPATIBLE', findings: [unsupported] });

    it('has none for a correct Analysis', () => {
      expect(report(ready(), {}, fullRun()).falseProblems).toEqual([]);
    });

    it('lists NOT_COMPATIBLE reasons when the full run is healthy', () => {
      expect(report(notCompatible, {}, fullRun()).falseProblems).toEqual([
        'NOT_COMPATIBLE but the application is healthy: Unsupported storage: named volumes.',
      ]);
    });

    it('lists NOT_COMPATIBLE reasons when only the observation is healthy', () => {
      expect(report(notCompatible).falseProblems).toHaveLength(1);
    });

    it('lists none for NOT_COMPATIBLE when the application is not healthy', () => {
      expect(report(notCompatible, {}, fullRun({ webHealthy: false })).falseProblems).toEqual([]);
      expect(report(notCompatible, { webHealthy: false }).falseProblems).toEqual([]);
    });

    it('lists a required variable that the application starts without', () => {
      const analysis = makeAnalysis(
        makeManifest({
          environment: { variables: [{ key: 'SMTP_HOST', required: true, secret: false, source: [], classification: 'customer_required' }] },
        }),
      );
      const result = report(analysis, { requiredVariables: [{ name: 'SMTP_HOST', healthyWithout: true, healthyWith: true }] });
      expect(result.falseProblems).toEqual(['SMTP_HOST is required, but the application starts without it']);
    });

    it('lists a managed database that the application never used', () => {
      const analysis = makeAnalysis(makeManifest({ database: { postgres: true } }));
      expect(report(analysis).falseProblems).toEqual(['a managed postgres database is required, but the application made no SQL connection']);
    });

    it('does not list a database claim that the application replaced with SQLite', () => {
      const analysis = makeAnalysis(makeManifest({ database: { postgres: true } }));
      const sqlite = { database: { engine: null, connections: 0, tablesAfterStart: [], sqliteFileWritten: true } };
      expect(report(analysis, sqlite).falseProblems).toEqual([]);
    });

    it('lists a Valkey requirement that the application never used', () => {
      const analysis = makeAnalysis(makeManifest({ redis: { required: true, envBindings: [] } }));
      expect(report(analysis).falseProblems).toEqual(['Valkey is required, but the application made no connection']);
    });

    it('lists an unverified database variable when the application connected', () => {
      const finding = { id: 'database-connection-unverified', category: 'database', severity: 'error', message: 'x' } as const;
      const analysis = makeAnalysis(makeManifest({ database: { postgres: true } }), { state: 'NEEDS_CONFIGURATION', findings: [finding] });
      const connected = { database: { engine: 'postgres' as const, connections: 1, tablesAfterStart: ['t'], sqliteFileWritten: false } };
      expect(report(analysis, connected).falseProblems).toEqual([
        'the database variable is unverified, but the application connected with the standard bindings',
      ]);
    });

    it('lists a health path request when a probed path answers 200', () => {
      const finding = { id: 'health-path-required', category: 'health', severity: 'error', message: 'x' } as const;
      const analysis = makeAnalysis(makeManifest({ health: { path: '/', mode: 'vendor_required' } }), {
        state: 'NEEDS_CONFIGURATION',
        findings: [finding],
      });
      expect(report(analysis).falseProblems).toEqual(['a health path is required, but a probed path answers 200']);
    });

    it('lists a migration command request when the application migrates at start', () => {
      const finding = { id: 'migration-command-needs-input', category: 'database', severity: 'error', message: 'x' } as const;
      const analysis = makeAnalysis(makeManifest(), { state: 'NEEDS_CONFIGURATION', findings: [finding] });
      const migrated = { startupMigration: { tablesCreatedByStart: true, secondStartHealthy: true } };
      expect(report(analysis, migrated).falseProblems).toEqual(['a migration command is required, but the application migrates at start']);
    });

    it('lists a missing Dockerfile when the repository builds one', () => {
      const finding = { id: 'dockerfile-missing', category: 'container', severity: 'error', message: 'x' } as const;
      const manifest = makeManifest({ application: { root: '.', runtime: 'node', framework: null, dockerfilePath: null } });
      const analysis = makeAnalysis(manifest, { state: 'NEEDS_CONFIGURATION', findings: [finding] });
      expect(report(analysis).falseProblems).toEqual(['no Dockerfile was found, but the repository builds one']);
    });
  });

  it('copies the vendor questions of the Analysis', () => {
    expect(report(makeAnalysis(makeManifest(), undefined, { vendorQuestions: 3 })).vendorQuestions).toBe(3);
  });

  it('lists the unstable facts', () => {
    expect(report(ready(), {}, null, { unstable: ['redis', 'workers'] }).unstableFacts).toEqual(['redis', 'workers']);
  });

  it('merges the infrastructure failures of both runs and the full run without repeats', () => {
    const observation = makeObservation(makeRun({}, { infrastructureFailures: ['registry timeout'] }), {
      runs: [makeRun({}, { infrastructureFailures: ['registry timeout'] }), makeRun({}, { infrastructureFailures: ['dns'] })],
    });
    const result = repositoryReport(
      { id: 'repo-001', set: 'tuning' },
      ready(),
      observation,
      [],
      fullRun({ infrastructureFailures: ['dns', 'pull'] }),
    );
    expect(result.infrastructureFailures).toEqual(['registry timeout', 'dns', 'pull']);
  });

  it('reports a failed analysis without verdicts', () => {
    const failed = makeAnalysis(makeManifest(), undefined, { status: 'failed', manifest: null, gate: null, failure: 'rate limited' });
    expect(report(failed)).toMatchObject({ readiness: null, verdicts: [], falseProblems: [], hiddenProblem: false });
  });
});

describe('summaryReport', () => {
  function entry(id: string, set: RepositoryReport['set'], patch: Partial<RepositoryReport> = {}): RepositoryReport {
    return { ...report(ready(), {}, fullRun(), { set }), id, ...patch };
  }

  const contradicted: ClaimVerdict = {
    claim: { type: 'web.port', subject: null, value: 8080, from: 'web.port' },
    verdict: 'CONTRADICTED',
    observed: 3000,
    reason: 'the app listens on another port',
    facts: ['listeningPorts'],
    arch: 'amd64-emulated',
    unstable: false,
  };
  const notCheckable: ClaimVerdict = {
    claim: { type: 'dockerfile', subject: '.', value: 'Dockerfile', from: 'application.dockerfilePath' },
    verdict: 'NOT_CHECKABLE',
    reason: 'emulation',
    facts: ['build'],
    arch: 'amd64-emulated',
    unstable: false,
  };

  it('keeps tuning and holdout in separate set entries', () => {
    const summary = summaryReport(
      [entry('repo-001', 'tuning'), entry('repo-002', 'tuning', { hiddenProblem: true }), entry('repo-101', 'holdout')],
      'rules@abc1234',
    );
    expect(summary.sets.map((set) => [set.set, set.repositories, set.hiddenProblems])).toEqual([
      ['tuning', 2, ['repo-002']],
      ['holdout', 1, []],
    ]);
  });

  it('omits a set without repositories', () => {
    expect(summaryReport([entry('repo-001', 'tuning')], 'rules@abc1234').sets.map((set) => set.set)).toEqual(['tuning']);
  });

  it('does not count a holdout problem in the tuning set', () => {
    const summary = summaryReport(
      [entry('repo-001', 'tuning'), entry('repo-101', 'holdout', { falseProblems: ['x'], verdicts: [contradicted] })],
      'rules@abc1234',
    );
    const [tuning, holdout] = summary.sets;
    expect(tuning).toMatchObject({ falseProblems: [], contradictedByClaimType: {} });
    expect(holdout).toMatchObject({ falseProblems: [{ id: 'repo-101', problem: 'x' }], contradictedByClaimType: { 'web.port': 1 } });
  });

  it('counts healthy repositories only with a healthy full run', () => {
    const summary = summaryReport(
      [
        entry('repo-001', 'tuning'),
        entry('repo-002', 'tuning', { healthyWithAnalysedSettings: false }),
        entry('repo-003', 'tuning', { healthyWithAnalysedSettings: null }),
      ],
      'rules@abc1234',
    );
    expect(summary.sets[0]!.healthyWithAnalysedSettings).toBe(1);
  });

  it('counts CONTRADICTED claims per claim type and per runtime', () => {
    const summary = summaryReport(
      [
        entry('repo-001', 'tuning', { verdicts: [contradicted, contradicted] }),
        entry('repo-002', 'tuning', { verdicts: [contradicted] }),
        entry('repo-003', 'tuning', { verdicts: [contradicted] }),
      ],
      'rules@abc1234',
      { runtimes: { 'repo-001': 'node', 'repo-002': 'node', 'repo-003': 'python' } },
    );
    expect(summary.sets[0]).toMatchObject({
      contradictedByClaimType: { 'web.port': 4 },
      contradictedByRuntime: { node: 3, python: 1 },
    });
  });

  it('files a repository without a known runtime under unknown', () => {
    const summary = summaryReport([entry('repo-001', 'tuning', { verdicts: [contradicted] })], 'rules@abc1234');
    expect(summary.sets[0]!.contradictedByRuntime).toEqual({ unknown: 1 });
  });

  it('counts the NOT_CHECKABLE reasons', () => {
    const summary = summaryReport(
      [entry('repo-001', 'tuning', { verdicts: [notCheckable, notCheckable] }), entry('repo-002', 'tuning', { verdicts: [notCheckable] })],
      'rules@abc1234',
    );
    expect(summary.sets[0]!.notCheckableReasons).toEqual({ emulation: 3 });
  });

  it('lists unstable facts and vendor questions per repository', () => {
    const summary = summaryReport(
      [entry('repo-001', 'tuning', { unstableFacts: ['redis'], vendorQuestions: 2 }), entry('repo-002', 'tuning', { vendorQuestions: 0 })],
      'rules@abc1234',
    );
    expect(summary.sets[0]).toMatchObject({
      unstableFacts: [{ id: 'repo-001', fact: 'redis' }],
      vendorQuestions: { 'repo-001': 2, 'repo-002': 0 },
    });
  });

  it('uses the given time and the analyser name', () => {
    const summary = summaryReport([], 'rules@abc1234', { generatedAt: '2026-10-16T12:00:00.000Z' });
    expect(summary).toEqual({ schemaVersion: 1, analyser: 'rules@abc1234', generatedAt: '2026-10-16T12:00:00.000Z', sets: [] });
  });
});

describe('renderMarkdown', () => {
  const reports = [
    { ...report(ready(), {}, fullRun({ webHealthy: false })), id: 'repo-001' },
    { ...report(ready(), {}, fullRun(), { set: 'holdout' }), id: 'repo-101', falseProblems: ['a | b'] },
  ];
  const text = renderMarkdown(summaryReport(reports, 'rules@abc1234', { generatedAt: 'now' }), reports);

  it('has one section per set, tuning first', () => {
    expect(text.indexOf('## Set: tuning')).toBeGreaterThan(-1);
    expect(text.indexOf('## Set: holdout')).toBeGreaterThan(text.indexOf('## Set: tuning'));
  });

  it('shows the healthy percentage and the hidden problems', () => {
    expect(text).toContain('Healthy with analysed settings: 0 of 1 (0%)');
    expect(text).toContain('Hidden problems: repo-001');
  });

  it('escapes the pipe character in table cells', () => {
    expect(text).toContain('| repo-101 | a \\| b |');
  });

  it('has a section for each metric', () => {
    for (const title of [
      '### Hidden problems',
      '### False problems',
      '### CONTRADICTED claims per claim type',
      '### CONTRADICTED claims per runtime',
      '### NOT_CHECKABLE reasons',
      '### Unstable facts',
      '### Vendor questions',
    ]) {
      expect(text).toContain(title);
    }
  });
});

describe('fullRunHealth', () => {
  const base = {
    schemaVersion: 1 as const,
    id: 'repo-007',
    analyser: 'rules@x',
    arch: 'amd64-emulated' as const,
    startedAt: '2026-10-16T00:00:00.000Z',
    environmentNames: [],
    migration: null,
    healthPathStatus: null,
    smokeStatus: null,
    workers: [],
    evidence: [],
  };

  it('is null when the run failed on a limit of the test', () => {
    expect(fullRunHealth({ ...base, webHealthy: false, infrastructureFailures: ['needs internet at run time: getaddrinfo EAI_AGAIN'] })).toBeNull();
    expect(fullRunHealth({ ...base, webHealthy: false, infrastructureFailures: ['emulation: qemu-x86_64: QEMU internal SIGSEGV'] })).toBeNull();
  });

  it('is the health otherwise', () => {
    expect(fullRunHealth({ ...base, webHealthy: false, infrastructureFailures: [] })).toBe(false);
    expect(fullRunHealth({ ...base, webHealthy: true, infrastructureFailures: ['needs internet at run time: x'] })).toBe(true);
    expect(fullRunHealth(null)).toBeNull();
  });
});

describe('Wave 5 report rules', () => {
  const failedBuild = {
    build: { ok: false, exitCode: 1, seconds: 1, imageBytes: null, dockerfile: 'Dockerfile', context: '.', failure: 'dockerfile' as const, fromCache: true },
  };

  it('makes a READY repository whose image does not build a hidden problem', () => {
    const result = report(ready(), failedBuild);
    expect(result.hiddenProblem).toBe(true);
    expect(result.healthyWithAnalysedSettings).toBe(false);
    expect(verdictOf(result, 'readiness')).toMatchObject({ verdict: 'CONTRADICTED', observed: 'not buildable' });
  });

  it('confirms NOT_COMPATIBLE when the image does not build', () => {
    const analysis = makeAnalysis(makeManifest(), { state: 'NOT_COMPATIBLE', findings: [] });
    expect(verdictOf(report(analysis, failedBuild), 'readiness')?.verdict).toBe('CONFIRMED');
  });

  it('confirms redis.required=false when the app used Valkey only because it was there and the full run is healthy', () => {
    const result = report(ready(), { redis: { connected: true, clients: 2 } }, fullRun({ webHealthy: true }));
    expect(verdictOf(result, 'redis.required')).toMatchObject({ verdict: 'CONFIRMED', reason: 'the full run without Valkey is healthy' });
  });
});
