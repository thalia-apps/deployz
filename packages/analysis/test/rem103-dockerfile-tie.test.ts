import { describe, expect, it } from 'vitest';

import { analyseRepo } from '../src/analyser.js';
import { deriveAmbiguities } from '../src/evidence.js';
import type { FileTree } from '../src/detectors.js';
import { evaluateManifestReadiness, normalizeDeploymentManifest } from '../src/manifest.js';
import { buildReadinessReport, reconcileReadiness } from '../src/readiness-report.js';

const NODE_DOCKERFILE = 'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nEXPOSE 3000\nCMD ["node", "index.js"]\n';

function node(dependencies: Record<string, string>): FileTree {
  return {
    Dockerfile: NODE_DOCKERFILE,
    'package.json': JSON.stringify({ name: 'app', scripts: { start: 'node index.js' }, dependencies }),
  };
}

function withMetadata(tree: FileTree, extra: Record<string, unknown>) {
  const analysis = analyseRepo(tree);
  return { ...analysis, metadata: { ...analysis.metadata, ...extra } };
}

const NO_RESOLUTION = { containerPort: 3000, startCommand: null };

describe('REM-103 — an in-process job library raises no worker question', () => {
  const tree = node({ express: '^4.18.0', bull: '^4.12.0' });

  it('worker-command, worker.needsCommand and the architecture question stay quiet when workerNeedsProcess is false', () => {
    const analysis = withMetadata(tree, { hasWorkerProcesses: true, workerNeedsProcess: false });
    expect(buildReadinessReport(analysis).findings.map((f) => f.id)).not.toContain('worker-command');
    expect(normalizeDeploymentManifest({ metadata: analysis.metadata }, {}).worker.needsCommand).toBeFalsy();
    expect(deriveAmbiguities(tree, analysis).map((a) => a.kind)).not.toContain('ARCHITECTURE_REQUIREMENT');
  });

  it('keeps the old behaviour when the key is absent (rows from older analyses)', () => {
    const analysis = withMetadata(tree, { hasWorkerProcesses: true });
    delete (analysis.metadata as Record<string, unknown>)['workerNeedsProcess'];
    expect(buildReadinessReport(analysis).findings.map((f) => f.id)).toContain('worker-command');
    expect(normalizeDeploymentManifest({ metadata: analysis.metadata }, {}).worker.needsCommand).toBe(true);
    expect(deriveAmbiguities(tree, analysis).map((a) => a.kind)).toContain('ARCHITECTURE_REQUIREMENT');
  });

  it('still raises the question when a separate consumer is required', () => {
    const analysis = withMetadata(tree, { hasWorkerProcesses: true, workerNeedsProcess: true });
    expect(buildReadinessReport(analysis).findings.map((f) => f.id)).toContain('worker-command');
    expect(normalizeDeploymentManifest({ metadata: analysis.metadata }, {}).worker.needsCommand).toBe(true);
  });

  it('a resolved worker command still gives worker-process', () => {
    const analysis = withMetadata(tree, { hasWorkerProcesses: true, workerNeedsProcess: false });
    const report = buildReadinessReport(analysis, { workerCommandResolved: true });
    expect(report.findings.map((f) => f.id)).toContain('worker-process');
  });
});

describe('database engine in readiness evidence and copy', () => {
  const migrationEvidence = (extra: Record<string, unknown>) =>
    buildReadinessReport(
      withMetadata(node({ express: '^4.18.0' }), { migrationMode: 'unknown', hasMigrationCommand: false, ...extra }),
    ).findings.find((f) => f.id === 'database-migrations')?.technicalEvidence;

  it('names MySQL when MySQL is required, even beside an optional PostgreSQL driver', () => {
    const evidence = migrationEvidence({
      usesPostgresql: true,
      usesMysql: true,
      postgres: { required: false },
      mysql: { required: true },
    });
    expect(evidence).toContain('MySQL');
    expect(evidence).not.toContain('PostgreSQL');
  });

  it('names PostgreSQL when PostgreSQL is required', () => {
    const evidence = migrationEvidence({
      usesPostgresql: true,
      usesMysql: true,
      postgres: { required: true },
      mysql: { required: true },
      postgresqlDrivers: ['pg'],
    });
    expect(evidence).toContain('PostgreSQL');
  });

  it('falls back to the detected driver when nothing is required', () => {
    expect(migrationEvidence({ usesPostgresql: false, usesMysql: true, postgres: {}, mysql: {} })).toContain('MySQL');
    expect(
      migrationEvidence({ usesPostgresql: true, usesMysql: false, postgres: {}, mysql: {}, postgresqlDrivers: ['pg'] }),
    ).toContain('PostgreSQL');
  });
});

describe('health-check is resolved by the vendor health path', () => {
  // A health handler whose route analysis does not resolve keeps the question open.
  const report = buildReadinessReport(analyseRepo({ Dockerfile: 'FROM node:20\nEXPOSE 3000\nCMD ["node", "x.js"]\n', 'src/health_controller.js': '' }));

  it('moves the finding to the passed checks when healthPathDecided', () => {
    expect(report.findings.map((f) => f.id)).toContain('health-check');
    const resolved = reconcileReadiness(report, { ...NO_RESOLUTION, healthPathDecided: true });
    expect(resolved.findings.map((f) => f.id)).not.toContain('health-check');
    expect(resolved.passed).toContainEqual({ id: 'health-check', label: 'Health check path set in the application details' });
  });

  it('keeps the finding without the decision', () => {
    expect(reconcileReadiness(report, { ...NO_RESOLUTION, healthPathDecided: false }).findings.map((f) => f.id)).toContain('health-check');
  });
});

describe('dockerfile-target-unresolved', () => {
  const tied = ['Dockerfile', 'docker/Dockerfile.alt'];
  const analysis = withMetadata(node({ express: '^4.18.0' }), { dockerfilePath: 'Dockerfile', dockerfileSelectionTied: tied });

  it('is a recommended, non-blocking needs_confirmation finding naming the selected file', () => {
    const finding = buildReadinessReport(analysis).findings.find((f) => f.id === 'dockerfile-target-unresolved');
    expect(finding).toMatchObject({ severity: 'recommended', blocking: false, confidence: 'needs_confirmation' });
    expect(finding?.plainEnglishExplanation).toContain('"Dockerfile"');
    expect(finding?.technicalEvidence).toContain('docker/Dockerfile.alt');
    expect(finding?.suggestedOutcome).toContain('Dockerfile.production');
  });

  it('is not raised without a tie', () => {
    const none = withMetadata(node({ express: '^4.18.0' }), { dockerfilePath: 'Dockerfile' });
    expect(buildReadinessReport(none).findings.map((f) => f.id)).not.toContain('dockerfile-target-unresolved');
    const single = withMetadata(node({ express: '^4.18.0' }), { dockerfileSelectionTied: ['Dockerfile'] });
    expect(buildReadinessReport(single).findings.map((f) => f.id)).not.toContain('dockerfile-target-unresolved');
  });

  it('is cleared by the vendor Dockerfile path and stays open otherwise', () => {
    const report = buildReadinessReport(analysis);
    const decided = reconcileReadiness(report, { ...NO_RESOLUTION, dockerfilePathDecided: true });
    expect(decided.findings.map((f) => f.id)).not.toContain('dockerfile-target-unresolved');
    expect(decided.passed.map((p) => p.id)).toContain('dockerfile-target-unresolved');
    expect(reconcileReadiness(report, NO_RESOLUTION).findings.map((f) => f.id)).toContain('dockerfile-target-unresolved');
  });

  it('is not a deployment gate', () => {
    const manifest = normalizeDeploymentManifest({ metadata: analysis.metadata }, {});
    expect(evaluateManifestReadiness(manifest).findings.map((f) => f.id)).not.toContain('dockerfile-target-unresolved');
  });
});
