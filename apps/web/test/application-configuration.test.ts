import type { ApplicationRequirementsSummary } from '@deployz/contracts';
import { describe, expect, it } from 'vitest';

import type { Application } from '../src/lib/applications';
import {
  detectedFactRows,
  type ApplicationReadiness,
  type DetectedApplication,
  type DetectedFact,
  type FactSource,
  type ReadinessFinding,
} from '../src/lib/readiness';
import { deriveAnalysisDetails, deriveConfigurationRows, deriveRequiredChanges } from '../src/lib/application-configuration';

/**
 * The Configuration tab's own vocabulary: one row per vendor-relevant
 * setting, "Ready" / "Not used" / "Change required" / "Recommended" /
 * "Needs review" — never "Passed", never "Not required", never an em dash or
 * an empty value.
 */

const CANONICAL_IDS = [
  'runtime',
  'build',
  'start',
  'port',
  'health',
  'database',
  'redis',
  'storage',
  'migrations',
] as const;

const fact = <T,>(value: T, source: FactSource = 'dockerfile'): DetectedFact<T> => ({
  value,
  source,
  confidence: source === 'source' || source === 'ai' ? 'likely' : 'confirmed',
  evidence: source === 'none' ? [] : [{ file: 'Dockerfile', reason: `Found in ${source}` }],
});

function fullyDetected(overrides: Partial<DetectedApplication> = {}): DetectedApplication {
  return {
    analysisVersion: 13,
    runtime: fact('node'),
    framework: fact('express', 'package-manifest'),
    build: fact('npm run build', 'package-manifest'),
    start: fact('node dist/index.js'),
    network: { port: fact(3000), bindAddress: fact(null, 'none') },
    database: { required: true, type: 'postgres', confidence: 'confirmed', evidence: [{ reason: 'pg dependency' }] },
    redis: { required: false, detected: false, supported: true, confidence: 'needs_confirmation', purposes: [], evidence: [] },
    storage: { persistentLocalRequired: false, objectStorageDetected: false, evidence: [] },
    healthCheck: { detected: true, path: '/health', confidence: 'confirmed', evidence: [{ reason: 'route' }] },
    migrations: { detected: true, command: 'npx drizzle-kit push', tools: ['drizzle-kit'], evidence: [{ reason: 'script' }] },
    environmentVariables: [],
    ...overrides,
  };
}

function nothingDetected(): DetectedApplication {
  return {
    analysisVersion: 13,
    runtime: fact('unknown', 'none'),
    framework: fact(null, 'none'),
    build: fact(null, 'none'),
    start: fact(null, 'none'),
    network: { port: fact(null, 'none'), bindAddress: fact(null, 'none') },
    database: { required: false, type: 'none', confidence: 'needs_confirmation', evidence: [] },
    redis: { required: false, detected: false, supported: true, confidence: 'needs_confirmation', purposes: [], evidence: [] },
    storage: { persistentLocalRequired: false, objectStorageDetected: false, evidence: [] },
    healthCheck: { detected: false, path: null, confidence: 'needs_confirmation', evidence: [] },
    migrations: { detected: false, command: null, tools: [], evidence: [] },
    environmentVariables: [],
  };
}

function applicationFixture(overrides: Partial<Application> = {}): Application {
  return {
    id: 'app-1',
    organizationId: 'org-1',
    name: 'Demo App',
    githubInstallationId: null,
    repoFullName: 'acme/demo',
    repoUrl: 'https://github.com/acme/demo',
    defaultBranch: 'main',
    containerPort: null,
    healthPath: null,
    migrationCommand: null,
    workerCommand: null,
    databaseRequired: false,
    storageRequired: false,
    redisRequired: false,
    defaultSizeProfile: 'small',
    minimumSizeProfile: 'small',
    analysisStatus: 'COMPLETE',
    compatibilityStatus: 'READY',
    compatibilityReason: null,
    detectedMetadata: null,
    createdAt: '2026-09-01T10:00:00Z',
    updatedAt: '2026-09-01T10:00:00Z',
    ...overrides,
  };
}

function requirementsFixture(overrides: Partial<ApplicationRequirementsSummary> = {}): ApplicationRequirementsSummary {
  return {
    schemaVersion: 1,
    database: { detected: true, effective: true, overridden: false },
    redis: { detected: false, effective: false, overridden: false },
    storage: { detected: false, effective: false, overridden: false },
    ...overrides,
  };
}

function readinessFixture(overrides: Partial<ApplicationReadiness> = {}): ApplicationReadiness {
  return {
    analysisStatus: 'COMPLETE',
    state: 'READY',
    requiredCount: 4,
    recommendedCount: 0,
    summary: null,
    failureReason: null,
    findings: [],
    passed: [{ id: 'docker', label: 'Docker container detected' }],
    analyzedCommitSha: 'abc1234',
    detected: fullyDetected(),
    requirements: requirementsFixture(),
    deploymentRequirementDrift: [],
    ...overrides,
  };
}

function finding(overrides: Partial<ReadinessFinding> = {}): ReadinessFinding {
  return {
    id: 'finding-1',
    category: 'health',
    title: 'Health endpoint missing',
    severity: 'required',
    blocking: true,
    plainEnglishExplanation: 'Deployz requires an HTTP health endpoint.',
    whyItMatters: 'Without it, Deployz cannot tell if your app is running.',
    technicalEvidence: 'No route responded on /health.',
    suggestedOutcome: 'Add a GET /health route that returns HTTP 200.',
    confidence: 'confirmed',
    ...overrides,
  };
}

describe('Consolidation', () => {
  it('creates exactly one row per canonical setting, no duplicates', () => {
    const rows = deriveConfigurationRows(applicationFixture(), readinessFixture());
    const ids = rows.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of CANONICAL_IDS) expect(ids).toContain(id);
  });

  it('never turns a passed check into its own row', () => {
    const rows = deriveConfigurationRows(applicationFixture(), readinessFixture());
    expect(rows.some((row) => row.id === 'docker')).toBe(false);
    expect(rows.some((row) => row.label === 'Docker container detected')).toBe(false);
  });

  it('surfaces passed checks and detection evidence only in the analysis details, not in the rows', () => {
    const readiness = readinessFixture();
    const details = deriveAnalysisDetails(readiness);
    expect(details.some((detail) => detail.label === 'Checks completed' && detail.lines.includes('Docker container detected'))).toBe(true);
    expect(details.some((detail) => detail.id === 'runtime' && detail.lines.some((line) => line.includes('Dockerfile')))).toBe(true);
  });

  it('adds a worker row only when the application has a worker command', () => {
    const withWorker = deriveConfigurationRows(applicationFixture({ workerCommand: 'node worker.js' }), readinessFixture());
    expect(withWorker.some((row) => row.id === 'worker')).toBe(true);
    const withoutWorker = deriveConfigurationRows(applicationFixture(), readinessFixture());
    expect(withoutWorker.some((row) => row.id === 'worker')).toBe(false);
  });
});

describe('Vocabulary', () => {
  const fixtures: Array<[string, ApplicationReadiness]> = [
    ['fully detected', readinessFixture()],
    ['nothing detected', readinessFixture({ detected: nothingDetected(), requirements: requirementsFixture({ database: { detected: false, effective: false, overridden: false } }) })],
    ['legacy response without requirements', readinessFixture({ requirements: null })],
  ];

  for (const [name, readiness] of fixtures) {
    it(`never shows "Passed", "Not required", an em dash, or an empty value (${name})`, () => {
      const rows = deriveConfigurationRows(applicationFixture(), readiness);
      for (const row of rows) {
        expect(row.value).not.toBe('');
        expect(row.value).not.toContain('—');
        expect(row.value).not.toContain('Passed');
        expect(row.value).not.toContain('Not required');
        expect(row.result.label).not.toBe('Passed');
        expect(row.result.label).not.toBe('Not required');
        if (row.detail !== null) {
          expect(row.detail).not.toContain('Not required');
        }
      }
    });
  }

  it('reports Needs review when the API sent no requirements', () => {
    const rows = deriveConfigurationRows(applicationFixture(), readinessFixture({ requirements: null }));
    const database = rows.find((row) => row.id === 'database')!;
    const redis = rows.find((row) => row.id === 'redis')!;
    const storage = rows.find((row) => row.id === 'storage')!;
    for (const row of [database, redis, storage]) {
      expect(row.value).toBe('Needs review');
      expect(row.result).toEqual({ label: 'Needs review', variant: 'warning' });
    }
  });

  it('always carries the storage explanation as help, and never calls a connected bucket "Not used"', () => {
    const rows = deriveConfigurationRows(applicationFixture(), readinessFixture());
    const storage = rows.find((row) => row.id === 'storage')!;
    expect(storage.value).toBe('Bucket created, not connected');
    expect(storage.help).toBe(
      'Every deployment gets a storage bucket, kept after uninstall. Deployz always gives your app the bucket name in STORAGE_BUCKET, S3_BUCKET and AWS_S3_BUCKET, and the AWS Region in AWS_REGION. This setting controls whether Deployz also fills the other storage variables that your app reads.',
    );

    const connected = deriveConfigurationRows(
      applicationFixture(),
      readinessFixture({ requirements: requirementsFixture({ storage: { detected: true, effective: true, overridden: false } }) }),
    );
    const connectedStorage = connected.find((row) => row.id === 'storage')!;
    expect(connectedStorage.value).toBe('Connected (storage variables filled)');
    expect(connectedStorage.help).toBe(storage.help);
  });
});

describe('Add vs Edit', () => {
  it('offers Add for absent optional capabilities', () => {
    const rows = deriveConfigurationRows(
      applicationFixture(),
      readinessFixture({ detected: nothingDetected(), requirements: requirementsFixture({ database: { detected: false, effective: false, overridden: false } }) }),
    );
    for (const id of ['database', 'redis', 'health', 'migrations']) {
      const row = rows.find((r) => r.id === id)!;
      expect(row.action).toMatchObject({ label: 'Add', kind: 'edit' });
    }
    // Storage always has a bucket — its unconnected action is "Connect", not "Add".
    const storage = rows.find((r) => r.id === 'storage')!;
    expect(storage.action).toMatchObject({ label: 'Connect', kind: 'edit', field: 'storageRequired' });
  });

  it('offers Edit for configured editable settings', () => {
    const rows = deriveConfigurationRows(applicationFixture(), readinessFixture());
    for (const id of ['database', 'health', 'migrations']) {
      const row = rows.find((r) => r.id === id)!;
      expect(row.action).toMatchObject({ label: 'Edit', kind: 'edit' });
    }
  });

  it('port is always Edit and runtime/build/start/worker are never editable', () => {
    const rows = deriveConfigurationRows(applicationFixture({ workerCommand: 'node worker.js' }), readinessFixture());
    expect(rows.find((r) => r.id === 'port')?.action).toMatchObject({ label: 'Edit', kind: 'edit' });
    for (const id of ['runtime', 'build', 'start', 'worker']) {
      expect(rows.find((r) => r.id === id)?.action).toBeNull();
    }
  });
});

describe('Overridden detail line', () => {
  it('shows "Set by you · detected: <value>" for an overridden port', () => {
    const rows = deriveConfigurationRows(applicationFixture({ containerPort: 8080 }), readinessFixture());
    const port = rows.find((r) => r.id === 'port')!;
    expect(port.value).toBe('8080');
    expect(port.detail).toBe('Set by you · detected: 3000');
    expect(port.result).toEqual({ label: 'Ready', variant: 'success' });
  });

  it('omits the detail line when there is no detected value to show', () => {
    const rows = deriveConfigurationRows(
      applicationFixture({ containerPort: 8080 }),
      readinessFixture({ detected: fullyDetected({ network: { port: fact(null, 'none'), bindAddress: fact(null, 'none') } }) }),
    );
    const port = rows.find((r) => r.id === 'port')!;
    expect(port.detail).toBeNull();
    expect(port.result).toEqual({ label: 'Ready', variant: 'success' });
  });

  it('shows the detail line for an overridden database requirement', () => {
    const rows = deriveConfigurationRows(
      applicationFixture(),
      readinessFixture({ requirements: requirementsFixture({ database: { detected: true, effective: false, overridden: true } }) }),
    );
    const database = rows.find((r) => r.id === 'database')!;
    expect(database.value).toBe('Not used');
    expect(database.detail).toBe('Set by you · detected: PostgreSQL database');
    expect(database.result).toEqual({ label: 'Ready', variant: 'success' });
  });

  it('names MySQL for a MySQL database in the row and in the analysis facts', () => {
    const detected = fullyDetected({
      database: { required: true, type: 'mysql', confidence: 'confirmed', evidence: [{ reason: 'mysqlclient declared' }] },
    });
    const rows = deriveConfigurationRows(applicationFixture(), readinessFixture({ detected }));
    const database = rows.find((r) => r.id === 'database')!;
    expect(database.value).toBe('MySQL database');
    expect(database.result).toEqual({ label: 'Ready', variant: 'success' });

    const fact = detectedFactRows(detected).find((row) => row.id === 'database')!;
    expect(fact.value).toBe('MySQL — Deployz provides a managed database');
    expect(fact.found).toBe(true);
  });

  it('shows the detail line for an overridden storage requirement that is connected', () => {
    const rows = deriveConfigurationRows(
      applicationFixture(),
      readinessFixture({ requirements: requirementsFixture({ storage: { detected: false, effective: true, overridden: true } }) }),
    );
    const storage = rows.find((r) => r.id === 'storage')!;
    expect(storage.value).toBe('Connected (storage variables filled)');
    expect(storage.detail).toBe('Set by you · detected: Bucket created, not connected');
    expect(storage.help).not.toBeNull();
  });
});

describe('Sorting: blocking first', () => {
  it('puts a blocking row first, a recommended row next, and keeps the rest stable', () => {
    const rows = deriveConfigurationRows(
      applicationFixture(),
      readinessFixture({
        findings: [
          finding({ id: 'health-check', category: 'health', severity: 'required' }),
          finding({ id: 'slow-port', category: 'network', severity: 'recommended', title: 'Port binding could be faster' }),
        ],
      }),
    );
    const ids = rows.map((row) => row.id);
    const healthIndex = ids.indexOf('health');
    const portIndex = ids.indexOf('port');
    expect(healthIndex).toBe(0);
    expect(portIndex).toBeGreaterThan(healthIndex);
    for (const id of ['runtime', 'build', 'start', 'database', 'redis', 'storage', 'migrations']) {
      expect(ids.indexOf(id)).toBeGreaterThan(portIndex);
    }
    expect(rows[healthIndex]!.blocking).toBe(true);
    expect(rows[portIndex]!.blocking).toBe(false);
    expect(rows[portIndex]!.result.label).toBe('Recommended');
  });
});

describe('Finding to row mapping', () => {
  it('maps a category finding onto its existing row and marks it Change required', () => {
    const rows = deriveConfigurationRows(
      applicationFixture(),
      readinessFixture({ findings: [finding({ id: 'db-missing', category: 'database', severity: 'required' })] }),
    );
    const database = rows.find((r) => r.id === 'database')!;
    expect(database.result).toEqual({ label: 'Change required', variant: 'destructive' });
    expect(database.blocking).toBe(true);
    expect(database.action).toEqual({ label: 'Fix', kind: 'fix' });
    expect(database.findingIds).toEqual(['db-missing']);
  });

  it('combines two findings on the same row: the required one wins, both ids are kept', () => {
    const rows = deriveConfigurationRows(
      applicationFixture(),
      readinessFixture({
        findings: [
          finding({ id: 'db-recommendation', category: 'database', severity: 'recommended', title: 'Use connection pooling' }),
          finding({ id: 'db-required', category: 'database', severity: 'required', title: 'Database missing' }),
        ],
      }),
    );
    const database = rows.find((r) => r.id === 'database')!;
    expect(database.result.label).toBe('Change required');
    expect(database.blocking).toBe(true);
    // Both findings share the default fixture explanation; the required one
    // (not the recommended one) is what wins the row's `help` text.
    expect(database.help).toBe('Deployz requires an HTTP health endpoint.');
    expect(database.findingIds.sort()).toEqual(['db-recommendation', 'db-required']);
  });

  it('keeps the setting edit action when its findings are only recommended', () => {
    const rows = deriveConfigurationRows(
      applicationFixture(),
      readinessFixture({ findings: [finding({ id: 'db-recommendation', category: 'database', severity: 'recommended' })] }),
    );
    const database = rows.find((r) => r.id === 'database')!;
    expect(database.result.label).toBe('Recommended');
    expect(database.blocking).toBe(false);
    expect(database.action).toEqual({ label: 'Edit', kind: 'edit', field: 'databaseRequired' });
    expect(database.help).toBe('Deployz requires an HTTP health endpoint.');
  });

  it('opens fix instructions for a recommended-only row that has no action of its own', () => {
    const rows = deriveConfigurationRows(
      applicationFixture({ workerCommand: 'node worker.js' }),
      readinessFixture({ findings: [finding({ id: 'worker-note', category: 'workers', severity: 'recommended' })] }),
    );
    expect(rows.find((r) => r.id === 'worker')!.action).toEqual({ label: 'Fix', kind: 'fix' });
  });

  it('hides the migration recommendation once the vendor sets the database to Not used', () => {
    const migrations = finding({ id: 'database-migrations', category: 'database', severity: 'recommended' });
    const notUsed = deriveConfigurationRows(
      applicationFixture(),
      readinessFixture({
        findings: [migrations],
        requirements: requirementsFixture({ database: { detected: true, effective: false, overridden: true } }),
      }),
    );
    const database = notUsed.find((r) => r.id === 'database')!;
    expect(database.value).toBe('Not used');
    expect(database.findingIds).toEqual([]);
    expect(database.help).toBeNull();
    expect(notUsed.some((r) => r.id === 'finding-database-migrations')).toBe(false);

    const used = deriveConfigurationRows(applicationFixture(), readinessFixture({ findings: [migrations] }));
    expect(used.find((r) => r.id === 'database')!.findingIds).toEqual(['database-migrations']);
  });

  it('gives an unknown-category finding its own extra row', () => {
    const rows = deriveConfigurationRows(
      applicationFixture(),
      readinessFixture({
        findings: [
          finding({
            id: 'weird-1',
            category: 'architecture',
            severity: 'required',
            title: 'Monorepo layout not supported',
            suggestedOutcome: 'Move the app to its own repository.',
          }),
        ],
      }),
    );
    const extra = rows.find((row) => row.findingIds.includes('weird-1'))!;
    expect(extra).toBeDefined();
    expect(extra.label).toBe('Monorepo layout not supported');
    expect(extra.value).toBe('Move the app to its own repository.');
    expect(extra.result).toEqual({ label: 'Change required', variant: 'destructive' });
    expect(extra.blocking).toBe(true);
  });

  it('gives a workers finding its own row when there is no worker command', () => {
    const rows = deriveConfigurationRows(
      applicationFixture(),
      readinessFixture({
        findings: [finding({ id: 'worker-1', category: 'workers', severity: 'recommended', title: 'Add a background worker' })],
      }),
    );
    expect(rows.some((row) => row.id === 'worker')).toBe(false);
    const extra = rows.find((row) => row.findingIds.includes('worker-1'))!;
    expect(extra).toBeDefined();
    expect(extra.result.label).toBe('Recommended');
  });

  it('routes a required port-unresolved finding to the port editor, not fix instructions', () => {
    const rows = deriveConfigurationRows(
      applicationFixture(),
      readinessFixture({
        findings: [finding({ id: 'port-unresolved', category: 'network', severity: 'required', title: 'Port not detected' })],
      }),
    );
    const port = rows.find((r) => r.id === 'port')!;
    expect(port.action).toEqual({ label: 'Fix', kind: 'edit', field: 'containerPort' });
  });

  it('routes a required health-check finding to fix instructions, never the health path editor', () => {
    const rows = deriveConfigurationRows(
      applicationFixture(),
      readinessFixture({
        findings: [finding({ id: 'health-check', category: 'health', severity: 'required', title: 'Health endpoint missing' })],
      }),
    );
    const health = rows.find((r) => r.id === 'health')!;
    expect(health.action).toEqual({ label: 'Fix', kind: 'fix' });
  });

  it('uses requiredChangeLabel for a mapped required finding not in the label table (falls back to its own title)', () => {
    const rows = deriveConfigurationRows(
      applicationFixture(),
      readinessFixture({
        findings: [
          finding({
            id: 'weird-1',
            category: 'architecture',
            severity: 'required',
            title: 'Monorepo layout not supported',
          }),
        ],
      }),
    );
    const extra = rows.find((row) => row.findingIds.includes('weird-1'))!;
    expect(extra.label).toBe('Monorepo layout not supported');
    expect(extra.action).toEqual({ label: 'Fix', kind: 'fix' });
  });

  it('uses requiredChangeLabel for a known finding id even in an unmapped-category extra row', () => {
    const rows = deriveConfigurationRows(
      applicationFixture(),
      readinessFixture({
        findings: [
          finding({
            id: 'container-setup',
            category: 'container',
            severity: 'required',
            title: 'No Dockerfile found',
          }),
        ],
      }),
    );
    const extra = rows.find((row) => row.findingIds.includes('container-setup'))!;
    expect(extra.label).toBe('Add container build instructions (Dockerfile)');
    expect(extra.action).toEqual({ label: 'Fix', kind: 'fix' });
  });
});

describe('deriveRequiredChanges', () => {
  it('is empty before analysis has completed', () => {
    expect(
      deriveRequiredChanges(readinessFixture({ analysisStatus: 'ANALYZING', findings: [finding()] })),
    ).toEqual([]);
  });

  it('lists only required findings, with a plain-language label and explanation', () => {
    const changes = deriveRequiredChanges(
      readinessFixture({
        findings: [
          finding({ id: 'health-check', category: 'health', severity: 'required' }),
          finding({ id: 'db-recommendation', category: 'database', severity: 'recommended' }),
        ],
      }),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]!.label).toBe('Add a health check route');
    expect(changes[0]!.explanation).toBe('Deployz requires an HTTP health endpoint.');
    expect(changes[0]!.fix).toEqual({ kind: 'instructions' });
  });

  it('falls back to suggestedOutcome when there is no plain-English explanation', () => {
    const changes = deriveRequiredChanges(
      readinessFixture({
        findings: [finding({ id: 'port-unresolved', severity: 'required', plainEnglishExplanation: '' })],
      }),
    );
    expect(changes[0]!.explanation).toBe('Add a GET /health route that returns HTTP 200.');
    expect(changes[0]!.fix).toEqual({ kind: 'edit', field: 'containerPort' });
  });

  it('opens the migration editor for an unconfirmed migration runner', () => {
    const changes = deriveRequiredChanges(
      readinessFixture({ findings: [finding({ id: 'migration-command-needs-input', category: 'database', severity: 'required' })] }),
    );
    expect(changes[0]!.label).toBe('Choose how database migrations run');
    expect(changes[0]!.fix).toEqual({ kind: 'edit', field: 'migrationCommand' });
  });
});

describe('Analysis incomplete', () => {
  it('returns no rows while analysis has not completed', () => {
    expect(deriveConfigurationRows(applicationFixture(), readinessFixture({ analysisStatus: 'ANALYZING', detected: null }))).toEqual([]);
    expect(deriveConfigurationRows(applicationFixture(), readinessFixture({ analysisStatus: 'PENDING', detected: null }))).toEqual([]);
  });

  it('returns no rows for a legacy COMPLETE response with no detected facts', () => {
    expect(deriveConfigurationRows(applicationFixture(), readinessFixture({ detected: null }))).toEqual([]);
  });
});

describe('deriveAnalysisDetails', () => {
  it('is empty when there is nothing detected and nothing passed', () => {
    expect(deriveAnalysisDetails(readinessFixture({ detected: null, passed: [] }))).toEqual([]);
  });

  it('formats evidence as "file — reason" and falls back to just the reason', () => {
    const readiness = readinessFixture({
      detected: fullyDetected({ runtime: { value: 'node', source: 'dockerfile', confidence: 'confirmed', evidence: [{ reason: 'No file reference' }] } }),
    });
    const details = deriveAnalysisDetails(readiness);
    const runtime = details.find((detail) => detail.id === 'runtime')!;
    expect(runtime.lines).toEqual(['No file reference']);
  });
});
