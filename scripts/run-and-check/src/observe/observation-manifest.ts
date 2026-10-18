import { deploymentManifestSchema, type DeploymentManifest, type ManifestEnvBinding } from '@deployz/contracts';

import type { AnalysisResultFile, Claim, Recipe } from '../contract.js';
import { OBSERVATION_PORT, collectCandidates } from './candidates.js';

const MINIMAL_MANIFEST: DeploymentManifest = {
  schemaVersion: 1,
  application: { root: '.', runtime: 'unknown', framework: null, dockerfilePath: null },
  build: { command: null, context: '.' },
  web: { command: null, port: null },
  health: { path: '/' },
  database: { postgres: false },
  redis: { required: false, envBindings: [] },
  storage: { required: false, envBindings: [] },
  migration: { command: null },
  worker: { command: null },
  environment: { variables: [] },
  externalServices: [],
  unsupported: [],
};

function byName(bindings: readonly ManifestEnvBinding[]): ManifestEnvBinding[] {
  const seen = new Map<string, ManifestEnvBinding>();
  for (const binding of bindings) if (!seen.has(binding.name)) seen.set(binding.name, binding);
  return [...seen.values()];
}

/**
 * A manifest with every candidate service switched on, so the application
 * gets everything. It only builds the environment (`deps.env`); no Analysis
 * is judged by it.
 */
export function buildObservationManifest(
  recipe: Recipe,
  analyses: readonly AnalysisResultFile[],
  claims: readonly Claim[] = [],
): DeploymentManifest {
  const manifests = analyses.flatMap((file) => (file.manifest === null ? [] : [file.manifest]));
  const base = structuredClone(manifests[0] ?? MINIMAL_MANIFEST);
  const candidates = collectCandidates(recipe, analyses, claims);
  const variables = new Map(manifests.flatMap((m) => m.environment.variables).map((variable) => [variable.key, variable] as const));
  const workers = new Map(manifests.flatMap((m) => m.workers ?? []).map((worker) => [worker.id, worker] as const));
  const migration = candidates.migrationCommands[0] ?? null;
  const workerCommand = candidates.workerCommands[0] ?? null;
  // Every candidate worker command gets a worker entry, so the compiler emits its task definition.
  const declaredCommands = new Set([...workers.values()].map((worker) => worker.command.trim()));
  candidates.workerCommands
    .filter((command) => !declaredCommands.has(command))
    .forEach((command) => {
      const id = candidates.workerIds[command]!;
      if (!workers.has(id)) workers.set(id, { id, command, source: 'run-and-check candidate' });
    });
  const declaredWorkers = [...workers.values()];

  return deploymentManifestSchema.parse({
    ...base,
    web: { command: null, port: OBSERVATION_PORT },
    health: { path: '/' },
    database: {
      postgres: true,
      engine: recipe.databaseEngine ?? 'postgres',
      envBindings: byName(manifests.flatMap((m) => m.database.envBindings ?? [])),
    },
    redis: { required: true, envBindings: byName(manifests.flatMap((m) => m.redis.envBindings)) },
    storage: { required: true, envBindings: byName(manifests.flatMap((m) => m.storage.envBindings)) },
    migration: { command: migration, ...(migration === null ? {} : { mode: 'pre_deploy' }) },
    worker: { command: workerCommand },
    ...(declaredWorkers.length > 0 ? { workers: declaredWorkers } : {}),
    environment: { variables: [...variables.values()] },
  });
}
