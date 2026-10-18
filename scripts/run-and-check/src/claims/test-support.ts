/** Builders for observation runs, observations and Analysis results in unit tests. */
import { deploymentManifestSchema, type DeploymentManifest, type ManifestReadinessResult } from '@deployz/contracts';

import type {
  AnalysisResultFile,
  Architecture,
  Evidence,
  Observation,
  ObservationFactName,
  ObservationRun,
} from '../contract.js';

type FactValues = { [K in ObservationFactName]: ObservationRun[K]['value'] };

const NO_EVIDENCE: Evidence[] = [];

/** A quiet, healthy application: builds, listens on 8080 and answers 200 on `/` and `/healthz`. */
const HEALTHY_DEFAULTS: FactValues = {
  build: { ok: true, exitCode: 0, seconds: 60, imageBytes: 1000, dockerfile: 'Dockerfile', context: '.', failure: null, fromCache: false },
  webHealthy: true,
  listeningPorts: [{ port: 8080, bind: 'all', reachableFromProbe: true }],
  httpPaths: [
    { port: 8080, path: '/', status: 200 },
    { port: 8080, path: '/healthz', status: 200 },
  ],
  smoke: { path: '/', status: 200 },
  database: { engine: null, connections: 0, tablesAfterStart: [], sqliteFileWritten: false },
  startupMigration: { tablesCreatedByStart: false, secondStartHealthy: null },
  migrationCommands: [],
  redis: { connected: false, clients: 0 },
  objectStorage: { objectsWritten: 0 },
  localDiskWrites: [],
  workers: [],
  requiredVariables: [],
  twoCopiesHealthy: true,
  restartHealthy: true,
  sizes: [],
};

export interface RunOptions {
  /** Facts whose check did not run. */
  notRun?: ObservationFactName[];
  arch?: Architecture;
  infrastructureFailures?: string[];
}

/** Replace some fact values; every other fact keeps the healthy default. */
export function makeRun(values: Partial<FactValues> = {}, options: RunOptions = {}): ObservationRun {
  const merged = { ...HEALTHY_DEFAULTS, ...values };
  const arch = options.arch ?? 'amd64-emulated';
  const facts = Object.fromEntries(
    (Object.keys(merged) as ObservationFactName[]).map((name) => {
      const skipped = options.notRun?.includes(name) === true;
      return [name, { status: skipped ? 'not_run' : 'observed', value: skipped ? null : merged[name], arch, evidence: NO_EVIDENCE }];
    }),
  ) as Pick<ObservationRun, ObservationFactName>;
  return {
    startedAt: '2026-10-16T00:00:00.000Z',
    harnessVersion: 'test',
    ...facts,
    candidates: { injectedPort: 18080, healthPaths: [], migrationCommands: [], workerCommands: [], variables: [], from: [] },
    infrastructureFailures: options.infrastructureFailures ?? [],
    timings: {},
  };
}

export function makeObservation(
  run: ObservationRun,
  options: { id?: string; set?: Observation['set']; unstable?: ObservationFactName[]; runs?: ObservationRun[] } = {},
): Observation {
  return {
    schemaVersion: 1,
    id: options.id ?? 'repo-001',
    set: options.set ?? 'tuning',
    repository: 'owner/name',
    commit: 'a'.repeat(40),
    recipeHash: 'hash',
    imageDigest: null,
    runs: options.runs ?? [run],
    unstable: options.unstable ?? [],
    complete: true,
  };
}

/** A minimal valid manifest: a Node app with a Dockerfile, port 8080, `/healthz`, no database. */
export function makeManifest(patch: Record<string, unknown> = {}): DeploymentManifest {
  return deploymentManifestSchema.parse({
    application: { root: '.', runtime: 'node', framework: null, dockerfilePath: 'Dockerfile' },
    build: { command: null, context: '.' },
    web: { command: 'node server.js', port: 8080 },
    health: { path: '/healthz', mode: 'explicit' },
    database: { postgres: false },
    redis: { required: false, envBindings: [] },
    storage: { required: false, envBindings: [] },
    migration: { command: null },
    worker: { command: null },
    environment: { variables: [] },
    externalServices: [],
    unsupported: [],
    ...patch,
  });
}

export function makeAnalysis(
  manifest: DeploymentManifest,
  gate: ManifestReadinessResult = { state: 'READY', findings: [] },
  patch: Partial<AnalysisResultFile> = {},
): AnalysisResultFile {
  return {
    id: 'repo-001',
    commit: 'a'.repeat(40),
    analyser: 'rules@abc1234',
    status: 'analysed',
    failure: null,
    manifest,
    gate,
    vendorQuestions: 0,
    ...patch,
  };
}
