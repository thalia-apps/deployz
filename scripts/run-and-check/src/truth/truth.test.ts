import { readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { AnalysisResultFile } from '../contract.js';
import { GROUND_TRUTH_DIR, loadGroundTruth } from './cli.js';
import { compareWithTruth, type GroundTruth } from './truth.js';

const ids = readdirSync(GROUND_TRUTH_DIR)
  .filter((name) => name.endsWith('.yaml'))
  .map((name) => name.slice(0, -5));

describe('ground-truth files', () => {
  it.each(ids)('%s parses, names its own id and was cross-reviewed', (id) => {
    const truth = loadGroundTruth(id);
    expect(truth.id).toBe(id);
    expect(Array.isArray((truth as Record<string, unknown>)['crossReview'])).toBe(true);
  });
});

const truth = {
  id: 'new-0',
  repository: 'acme/app',
  commit: 'a'.repeat(40),
  outcome: { accept: ['DEPLOYABLE'] },
  dockerfile: { accept: ['Dockerfile'], target: null },
  port: { accept: [3000] },
  startCommand: { source: 'image', accept: [] },
  healthPath: { accept: ['/health'] },
  database: { status: 'conditional', deployzEngine: 'postgres', selectBy: { DB_DRIVER: 'postgres' } },
  migrations: { mode: 'startup', accept: [] },
  redis: { status: 'optional' },
  workers: { status: 'embedded' },
  storage: { local: 'none', s3: 'none', s3SelectBy: {} },
  env: { required: [{ name: 'APP_SECRET', secret: true }] },
} as GroundTruth;

function analysis(overrides: Partial<NonNullable<AnalysisResultFile['manifest']>> = {}): AnalysisResultFile {
  return {
    id: 'new-0',
    commit: 'a'.repeat(40),
    analyser: 'rules@test',
    status: 'analysed',
    failure: null,
    gate: null,
    vendorQuestions: 0,
    outcome: 'DEPLOYABLE',
    manifest: {
      schemaVersion: 1,
      application: { root: '.', runtime: 'node', framework: null, dockerfilePath: 'Dockerfile' },
      build: { command: null, context: '.' },
      web: { command: 'CMD: ["node", "server.js"]', port: 3000 },
      health: { path: '/health', mode: 'explicit' },
      database: { postgres: true, envBindings: [] },
      redis: { required: false, envBindings: [] },
      storage: { required: false, envBindings: [] },
      migration: { command: null, mode: 'startup' },
      worker: { command: null },
      environment: {
        variables: [
          { key: 'DB_DRIVER', required: true, secret: false, source: [], classification: 'customer_required' },
          { key: 'APP_SECRET', required: true, secret: true, source: [], classification: 'deployz_generated' },
        ],
      },
      externalServices: [],
      unsupported: [],
      ...overrides,
    } as NonNullable<AnalysisResultFile['manifest']>,
  };
}

const mismatches = (file: AnalysisResultFile) =>
  compareWithTruth(truth, file)
    .filter((result) => result.verdict !== 'MATCH')
    .map((result) => `${result.verdict} ${result.field}`);

describe('compareWithTruth', () => {
  it('matches an analysis that agrees with every field', () => {
    expect(mismatches(analysis())).toEqual([]);
  });

  it('reports a selector the vendor is never asked to set (silent SQLite)', () => {
    expect(mismatches(analysis({ environment: { variables: [] } }))).toContain('MISMATCH database.selectBy.DB_DRIVER');
  });

  it('reports a HEALTHCHECK command read as the start command', () => {
    const file = analysis({ web: { command: 'CMD: curl -f http://localhost:3000/health', port: 3000 } });
    expect(compareWithTruth({ ...truth, startCommand: { source: 'image', accept: ['node server.js'] } }, file).find((r) => r.field === 'startCommand')?.verdict).toBe(
      'MISMATCH',
    );
  });

  it('reports optional Redis that the manifest provisions', () => {
    expect(mismatches(analysis({ redis: { required: true, envBindings: [] } }))).toContain('MISMATCH redis');
  });

  it('counts a vendor question for a fact the repository answers', () => {
    expect(mismatches(analysis({ worker: { command: null, needsCommand: true } }))).toContain('QUESTION workers');
  });

  it('reports a strict `/` check when `/` redirects', () => {
    const rootTruth = { ...truth, healthPath: { accept: ['/'] } } as GroundTruth;
    const strict = compareWithTruth(rootTruth, analysis({ health: { path: '/', mode: 'explicit' } }));
    expect(strict.find((r) => r.field === 'healthPath')?.verdict).toBe('MISMATCH');
    const tolerant = compareWithTruth(rootTruth, analysis({ health: { path: '/', mode: 'root', redirectsAccepted: true } }));
    expect(tolerant.find((r) => r.field === 'healthPath')?.verdict).toBe('MATCH');
  });
});
