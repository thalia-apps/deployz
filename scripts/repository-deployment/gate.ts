/**
 * B1 — the deployment gate over a pinned snapshot, through the production
 * analysis path the Docker run-and-check harness drives (`openAnalysisSession`:
 * `runApplicationAnalysis` → `normalizeDeploymentManifest` →
 * `evaluateManifestReadiness`), read from the Stage B side: what verdict does
 * the gate give? The verdict is reported, not graded.
 *
 * B2 offline — the same gate with the Stage B vendor configuration applied
 * (overrides merged the way `applicationToManifestOverrides` merges them,
 * configured and generated keys counted as provided), so a configuration
 * is validated before any AWS resource exists.
 */
import { evaluateManifestReadiness, normalizeDeploymentManifest } from '@deployz/analysis';
import { applicationToManifestOverrides } from '@deployz/api/manifest';
import type { DeploymentManifest, DeploymentManifestOverrides, ManifestReadinessResult } from '@deployz/contracts';

import type { RawAnalysis } from '../run-and-check/src/analysis/session.js';
import { providedKeys, type RepositoryConfig, type VendorOverrides } from './config.js';
import type { StageBResult } from './results.js';

/** Stage B vendor overrides in the manifest's override vocabulary (PATCH /api/applications/:id → manifest). */
export function overridesToManifest(overrides: VendorOverrides | undefined): DeploymentManifestOverrides {
  if (!overrides) return {};
  const out: DeploymentManifestOverrides = {};
  if (overrides.containerPort !== undefined) out.port = overrides.containerPort;
  if (overrides.healthPath !== undefined) out.healthPath = overrides.healthPath;
  if (overrides.migrationCommand !== undefined) out.migrationCommand = overrides.migrationCommand;
  if (overrides.databaseRequired !== undefined) out.databaseRequired = overrides.databaseRequired;
  if (overrides.storageRequired !== undefined) out.storageRequired = overrides.storageRequired;
  if (overrides.redisRequired !== undefined) out.redisRequired = overrides.redisRequired;
  if (overrides.appRoot !== undefined) out.appRoot = overrides.appRoot;
  if (overrides.dockerfilePath !== undefined) out.dockerfilePath = overrides.dockerfilePath;
  if (overrides.buildContext !== undefined) out.buildContext = overrides.buildContext;
  if (overrides.buildCommand !== undefined) out.buildCommand = overrides.buildCommand;
  if (overrides.startCommand !== undefined) out.startCommand = overrides.startCommand;
  return out;
}

/** The gate re-evaluated with the Stage B configuration — the B2 offline check. */
export function evaluateConfiguredGate(
  raw: RawAnalysis,
  entry: RepositoryConfig,
): { manifest: DeploymentManifest; gate: ManifestReadinessResult } {
  if (raw.status !== 'analysed') throw new Error('cannot evaluate the gate of a failed analysis');
  const manifest = normalizeDeploymentManifest(
    { metadata: raw.row.detectedMetadata ?? {} },
    { ...applicationToManifestOverrides(raw.row), ...overridesToManifest(entry.overrides) },
  );
  const gate = evaluateManifestReadiness(manifest, { providedEnvKeys: providedKeys(entry) });
  return { manifest, gate };
}

/** Fill the `gate` section of a result from one in-process analysis. */
export function gateSection(
  raw: RawAnalysis,
  entry: RepositoryConfig,
  analysisVersion: number,
): { gate: StageBResult['gate']; manifest: DeploymentManifest | null; configuredManifest: DeploymentManifest | null } {
  if (raw.status !== 'analysed' || !raw.gate) {
    return {
      gate: {
        status: 'FAIL',
        verdict: null,
        analysisVerdict: raw.row.compatibilityStatus,
        gateFindings: [],
        requiredKeys: [],
        missingKeys: [],
        unsupported: [],
        configuredVerdict: null,
        configuredFindings: [],
        source: 'in-process',
        analysisVersion,
        manifest: null,
        detail: raw.failure ?? 'analysis did not complete',
      },
      manifest: null,
      configuredManifest: null,
    };
  }
  const configured = evaluateConfiguredGate(raw, entry);
  const verdict = raw.gate.state;
  return {
    gate: {
      status: verdict === 'NOT_COMPATIBLE' ? 'FAIL' : 'PASS',
      verdict,
      analysisVerdict: raw.row.compatibilityStatus,
      gateFindings: raw.gate.findings.map((finding) => finding.id),
      requiredKeys: requiredKeys(raw.manifest),
      missingKeys: missingKeys(raw.gate),
      unsupported: unsupportedBlockers(raw),
      configuredVerdict: configured.gate.state,
      configuredFindings: configured.gate.findings.map((finding) => finding.id),
      source: 'in-process',
      analysisVersion,
      manifest: raw.manifest ? manifestFacts(raw.manifest) : null,
      detail: null,
    },
    manifest: raw.manifest,
    configuredManifest: configured.manifest,
  };
}

/** Every env key the manifest marks required. */
function requiredKeys(manifest: DeploymentManifest | null): string[] {
  return (manifest?.environment.variables ?? []).filter((variable) => variable.required).map((variable) => variable.key).sort();
}

/** What blocks the repository: the detected rejections, the local filesystem and a background worker. */
function unsupportedBlockers(raw: RawAnalysis): string[] {
  const metadata = (raw.row.detectedMetadata ?? {}) as Record<string, unknown>;
  const blockers = new Set<string>();
  for (const rejection of raw.analysis?.rejections ?? []) {
    if (rejection.detected) blockers.add(rejection.dependency);
  }
  if (metadata['usesLocalFilesystem'] === true) blockers.add('local-filesystem');
  if (metadata['hasWorkerProcesses'] === true && raw.manifest !== null && raw.manifest.worker.command !== null) blockers.add('background-worker');
  return [...blockers].sort();
}

/** The keys the gate's `required-env-vars-missing` finding names — what a vendor must still provide. */
export function missingKeys(gate: ManifestReadinessResult): string[] {
  const finding = gate.findings.find((f) => f.id === 'required-env-vars-missing');
  const match = finding ? /no value yet: (.+?)\. Set them/.exec(finding.message) : null;
  return match?.[1] ? match[1].split(',').map((key) => key.trim()).filter(Boolean).sort() : [];
}

/** The manifest facts a deployment acts on, in the result's shape. */
export function manifestFacts(manifest: DeploymentManifest): NonNullable<StageBResult['gate']['manifest']> {
  const names = (bindings: { name: string }[] | undefined) => (bindings ?? []).map((binding) => binding.name).sort();
  return {
    dockerfilePath: manifest.application.dockerfilePath,
    buildContext: manifest.build.context,
    appRoot: manifest.application.root,
    port: manifest.web.port,
    healthPath: manifest.health.path,
    healthMode: manifest.health.mode ?? null,
    migrationCommand: manifest.migration.command,
    migrationMode: manifest.migration.mode ?? null,
    postgres: manifest.database.postgres,
    redis: manifest.redis.required,
    storage: manifest.storage.required,
    databaseBindings: names(manifest.database.envBindings),
    redisBindings: names(manifest.redis.envBindings),
    storageBindings: names(manifest.storage.envBindings),
    generatedKeys: manifest.environment.variables.filter((v) => v.classification === 'deployz_generated').map((v) => v.key).sort(),
  };
}
