/**
 * Reads the Analysis claims out of an Analysis result file: one claim per
 * claim type, and one per worker and per vendor-supplied variable. `from`
 * names the manifest field (or gate field) a claim came from.
 */
import { generatedEnvKeys, mintedEnvKeys } from '@deployz/analysis';
import {
  deployzProvidableKeys,
  evaluateEnvironmentSetup,
  runtimeKeysNeedingValue,
  type DeploymentManifest,
} from '@deployz/contracts';

import type { AnalysisResultFile, Claim } from '../contract.js';

/** `manifest.unsupported` reasons that say the app keeps durable data on local disk or a volume. */
const LOCAL_STATE_REASON = /persistent local filesystem|durable local state|named volumes|persistent volume/i;

/**
 * The required variables the vendor must supply: the production setup
 * evaluation of a new application needs a value for them, and Deployz does
 * not generate, mint, bind or manage them.
 */
export function vendorRequiredVariables(manifest: DeploymentManifest): string[] {
  const needingValue = new Set(
    runtimeKeysNeedingValue(
      evaluateEnvironmentSetup({ variables: manifest.environment.variables, settings: null, vendorValueKeys: new Set() }),
    ),
  );
  const provided = new Set<string>([
    ...generatedEnvKeys(manifest),
    ...mintedEnvKeys(manifest, null),
    ...deployzProvidableKeys(manifest.environment.variables),
  ]);
  const bindings = [
    ...(manifest.database.postgres ? (manifest.database.envBindings ?? []) : []),
    ...(manifest.redis.required ? manifest.redis.envBindings : []),
    ...(manifest.storage.required ? manifest.storage.envBindings : []),
  ];
  for (const binding of bindings) provided.add(binding.name);
  return manifest.environment.variables
    .filter((variable) => variable.required && needingValue.has(variable.key) && !provided.has(variable.key))
    .map((variable) => variable.key);
}

/** The `from` of a Dockerfile claim when the gate itself says the image cannot build. */
export const PREDICTED_UNBUILDABLE = 'application.dockerfilePath (gate: unbuildable)';

/** The gate predicts a failed build: a container error, or an unsupported reason that names .git or the Dockerfile. */
function predictsUnbuildable(gate: NonNullable<AnalysisResultFile['gate']>): boolean {
  return gate.findings.some(
    (finding) =>
      finding.severity === 'error' &&
      (finding.category === 'container' || (finding.id === 'unsupported' && /\.git\b|Dockerfile/.test(finding.message))),
  );
}

function databaseEngine(manifest: DeploymentManifest): 'postgres' | 'mysql' | 'none' {
  if (!manifest.database.postgres) return 'none';
  return manifest.database.engine ?? 'postgres';
}

export function extractClaims(file: AnalysisResultFile): Claim[] {
  const { manifest, gate } = file;
  if (manifest === null || gate === null) return [];

  const claims: Claim[] = [
    { type: 'readiness', subject: null, value: gate.state, from: 'gate.state' },
    // The build context rides in `subject`: one claim states the Dockerfile and the context together.
    {
      type: 'dockerfile',
      subject: manifest.build.context,
      value: manifest.application.dockerfilePath,
      from: predictsUnbuildable(gate) ? PREDICTED_UNBUILDABLE : 'application.dockerfilePath',
    },
    { type: 'web.port', subject: null, value: manifest.web.port, from: 'web.port' },
    {
      type: 'health.path',
      subject: null,
      // A `vendor_required` path is a neutral placeholder, not a claim.
      value: manifest.health.mode === 'vendor_required' ? null : manifest.health.path,
      from: 'health.path',
    },
    { type: 'database.engine', subject: null, value: databaseEngine(manifest), from: 'database.postgres' },
    { type: 'redis.required', subject: null, value: manifest.redis.required, from: 'redis.required' },
    { type: 'storage.required', subject: null, value: manifest.storage.required, from: 'storage.required' },
    {
      type: 'storage.local',
      subject: null,
      value: manifest.unsupported.some((reason) => LOCAL_STATE_REASON.test(reason)),
      from: 'unsupported',
    },
    { type: 'migration.mode', subject: null, value: manifest.migration.mode ?? null, from: 'migration.mode' },
  ];

  if (manifest.migration.command !== null) {
    claims.push({ type: 'migration.command', subject: null, value: manifest.migration.command, from: 'migration.command' });
  }

  const workers = manifest.workers ?? [];
  for (const worker of workers) {
    claims.push({ type: 'worker.command', subject: worker.id, value: worker.command, from: `workers.${worker.id}.command` });
  }
  // The legacy slot repeats the first declared worker; it is a claim only when no worker is declared.
  if (workers.length === 0 && manifest.worker.command !== null) {
    claims.push({ type: 'worker.command', subject: 'worker', value: manifest.worker.command, from: 'worker.command' });
  }

  for (const name of vendorRequiredVariables(manifest)) {
    claims.push({ type: 'env.required', subject: name, value: true, from: `environment.variables.${name}` });
  }
  return claims;
}
