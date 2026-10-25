import { eq } from 'drizzle-orm';

import {
  evaluateManifestReadiness,
  generatedEnvKeys,
  normalizeDeploymentManifest,
  type ReadinessReport,
} from '@deployz/analysis';
import {
  applyEnvironmentBindings,
  evaluateEnvironmentSetup,
  keysNotNeedingValue,
  runtimeKeysNeedingValue,
  type DeploymentManifest,
  type EnvironmentSetting,
  type ManifestReadinessFinding,
} from '@deployz/contracts';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { listProvidedConfigKeys } from './config.js';
import { ApiError } from './errors.js';
import { effectiveReadinessReport } from './fix-instructions.js';
import { readEnvironmentSettings } from './environment-setup.js';
import { applicationToManifestOverrides, readStoredManifest, type ManifestApplicationRow } from './manifest.js';

// Pre-deployment preflight (AI MVP Phase 5) — the one gate every path into
// AWS provisioning runs: deployment creation, the install-link and
// deploy-link launches, and relay registration. It combines the deployment
// manifest gate (unsupported architecture, container setup, port, start
// command, required env vars against the values THIS customer has), the
// readiness report's remaining findings as warnings, and lists every check
// so the vendor sees what passed, not only what failed. Deterministic: no
// AI call, nothing fetched — it reads what analysis and configuration
// already persisted.

export type PreflightState = 'READY' | 'READY_WITH_WARNINGS' | 'ACTION_REQUIRED' | 'UNSUPPORTED';

export interface PreflightCheck {
  id: string;
  label: string;
  status: 'passed' | 'warning' | 'blocked';
  /** One short line: what was found, or what is missing. Null when the label says it all. */
  detail: string | null;
}

export interface PreflightResult {
  state: PreflightState;
  /** True when provisioning may start — warnings never block. */
  ready: boolean;
  blockers: ManifestReadinessFinding[];
  warnings: ManifestReadinessFinding[];
  checks: PreflightCheck[];
}

export interface PreflightInput {
  manifest: DeploymentManifest;
  /** Env keys with a saved value for the scope being evaluated. */
  providedEnvKeys: string[];
  /** The application's effective readiness report, when the caller has it. */
  readiness: ReadinessReport | null;
  /** Saved env-var setup decisions (docs/environment-variables.md); null = legacy behaviour. */
  settings?: EnvironmentSetting[] | null;
}

/** Readiness findings the manifest gate already reports as blockers or warnings. */
const COVERED_READINESS_FINDINGS = new Set([
  'container-setup',
  'port-unresolved',
  'start-command-missing',
  'database-migrations',
  'health-check',
]);

/** Readiness findings that name a repository change the deployment can still proceed without. */
function readinessWarnings(readiness: ReadinessReport | null): ManifestReadinessFinding[] {
  if (!readiness) return [];
  return readiness.findings
    .filter((finding) => !finding.blocking && !COVERED_READINESS_FINDINGS.has(finding.id))
    .map((finding) => ({
      id: finding.id,
      category: finding.category,
      severity: 'warning' as const,
      message: `${finding.title} — ${finding.plainEnglishExplanation}`,
    }));
}

function requiredCustomerKeys(
  manifest: DeploymentManifest,
  providedEnvKeys: string[],
  evaluation: ReturnType<typeof evaluateEnvironmentSetup>,
): { required: string[]; missing: string[] } {
  const generated = new Set(generatedEnvKeys(manifest));
  const provided = new Set(providedEnvKeys);
  const required = runtimeKeysNeedingValue(evaluation).filter((key) => !generated.has(key));
  return { required, missing: required.filter((key) => !provided.has(key)) };
}

/** At most 5 keys, then "and N more" — keeps a long list readable in a one-line detail. */
function joinKeysTruncated(keys: string[]): string {
  const shown = keys.slice(0, 5);
  const more = keys.length - shown.length;
  return more > 0 ? `${shown.join(', ')}, and ${more} more` : shown.join(', ');
}

/**
 * Evaluate the preflight. Pure — the same manifest, provided keys and
 * readiness report always give the same result.
 */
export function evaluatePreflight(input: PreflightInput): PreflightResult {
  const { manifest } = input;
  const evaluation = evaluateEnvironmentSetup({
    variables: manifest.environment.variables,
    settings: input.settings ?? null,
    vendorValueKeys: new Set(input.providedEnvKeys),
  });
  // Vendor-optional/none/build/deployz keys never block deployment; a
  // customer/vendor/unreviewed-required key still needs a value.
  const gateProvidedEnvKeys = [...new Set([...input.providedEnvKeys, ...keysNotNeedingValue(evaluation)])];
  const gate = evaluateManifestReadiness(manifest, { providedEnvKeys: gateProvidedEnvKeys });
  const blockers = gate.findings.filter((finding) => finding.severity === 'error');
  const gateWarnings = gate.findings.filter((finding) => finding.severity === 'warning');
  const warnings = [...gateWarnings, ...readinessWarnings(input.readiness)];
  const blockedIds = new Set(blockers.map((finding) => finding.id));
  const checks: PreflightCheck[] = [];

  if (manifest.unsupported.length > 0) {
    checks.push({
      id: 'compatibility',
      label: 'Supported architecture',
      status: 'blocked',
      detail: manifest.unsupported.join(' '),
    });
  } else {
    checks.push({ id: 'compatibility', label: 'Supported architecture', status: 'passed', detail: null });
  }

  checks.push({
    id: 'container',
    label: 'Application build configuration',
    status: blockedIds.has('dockerfile-missing') ? 'blocked' : 'passed',
    detail: manifest.application.dockerfilePath ?? 'No container build instructions were found.',
  });
  checks.push({
    id: 'start',
    label: 'Start command',
    status: blockedIds.has('start-command-missing') ? 'blocked' : 'passed',
    detail: manifest.web.command ?? 'No start command was found.',
  });
  checks.push({
    id: 'port',
    label: 'Application port',
    status: blockedIds.has('port-missing') ? 'blocked' : 'passed',
    detail: manifest.web.port !== null ? String(manifest.web.port) : 'The port the app listens on is unknown.',
  });
  checks.push({
    id: 'database',
    label: 'Database',
    status: blockedIds.has('migration-database-missing') ? 'blocked' : 'passed',
    detail: manifest.database.postgres
      ? `${manifest.database.engine === 'mysql' ? 'MySQL' : 'PostgreSQL'} — Deployz provides a managed database`
      : blockedIds.has('migration-database-missing')
        ? 'A migration command is set, but no database is required'
        : 'No database required',
  });
  checks.push({
    id: 'redis',
    label: 'Cache',
    status: 'passed',
    detail: manifest.redis.required ? 'Redis — provisioned automatically' : 'No cache required',
  });
  checks.push({
    id: 'storage',
    label: 'File storage',
    status: 'passed',
    detail: manifest.storage.required ? 'Object storage — Deployz provides a bucket' : 'No file storage required',
  });

  const managedCount = manifest.environment.variables.filter(
    (variable) => variable.classification === 'deployz_managed' || variable.classification === 'deployz_generated',
  ).length;
  checks.push({
    id: 'managed-variables',
    label: 'Deployz-managed variables',
    status: 'passed',
    detail:
      managedCount > 0
        ? `${managedCount} ${managedCount === 1 ? 'variable' : 'variables'} configured automatically`
        : 'Set at installation',
  });

  const customerKeys = requiredCustomerKeys(manifest, input.providedEnvKeys, evaluation);
  checks.push({
    id: 'customer-variables',
    label: 'Required customer variables',
    status: customerKeys.missing.length > 0 ? 'blocked' : 'passed',
    detail:
      customerKeys.required.length === 0
        ? 'Nothing for you to provide'
        : customerKeys.missing.length > 0
          ? `Missing: ${joinKeysTruncated(customerKeys.missing)}`
          : `${customerKeys.required.length} ${customerKeys.required.length === 1 ? 'value' : 'values'} provided`,
  });

  const healthMissing = input.readiness?.findings.some((finding) => finding.id === 'health-check') === true;
  checks.push({
    id: 'health',
    label: 'Health configuration',
    status: healthMissing ? 'warning' : 'passed',
    detail: healthMissing
      ? `No dedicated health endpoint detected — Deployz will probe ${manifest.health.path}`
      : `Health check at ${manifest.health.path}`,
  });
  if (healthMissing) {
    const finding = input.readiness?.findings.find((entry) => entry.id === 'health-check');
    if (finding) {
      warnings.push({
        id: finding.id,
        category: finding.category,
        severity: 'warning',
        message: `${finding.title} — ${finding.plainEnglishExplanation}`,
      });
    }
  }

  if (manifest.database.postgres) {
    const migrationMissing = gateWarnings.some((finding) => finding.id === 'migration-command-missing');
    checks.push({
      id: 'migrations',
      label: 'Database migrations',
      status: migrationMissing ? 'warning' : 'passed',
      detail: migrationMissing
        ? 'No migration command — schema updates will not run on deploy'
        : (manifest.migration.command ??
          (manifest.migration.mode === 'startup' ? 'The application runs its migrations when it starts' : null)),
    });
  }

  for (const warning of readinessWarnings(input.readiness)) {
    const [label, ...explanation] = warning.message.split(' — ');
    checks.push({
      id: warning.id,
      label: label ?? warning.id,
      status: 'warning',
      detail: explanation.length > 0 ? explanation.join(' — ') : warning.message,
    });
  }

  const state: PreflightState =
    gate.state === 'NOT_COMPATIBLE'
      ? 'UNSUPPORTED'
      : blockers.length > 0
        ? 'ACTION_REQUIRED'
        : warnings.length > 0
          ? 'READY_WITH_WARNINGS'
          : 'READY';

  return { state, ready: state === 'READY' || state === 'READY_WITH_WARNINGS', blockers, warnings, checks };
}

/** The application row slice the preflight reads. */
export type PreflightApplicationRow = ManifestApplicationRow & { id: string; environmentSettings?: unknown };

/**
 * Preflight for an application before a deployment exists: the manifest is
 * built fresh from the analysis and the vendor's overrides, provided keys
 * are the vendor defaults plus this customer's overrides when a customer is
 * named. `extraProvidedEnvKeys` adds keys the caller knows are being
 * supplied in the same breath (the public install confirm body) — they
 * count as provided exactly like saved configuration would.
 */
export async function runApplicationPreflight(
  db: RuntimeDb,
  application: PreflightApplicationRow,
  customerId: string | null,
  extraProvidedEnvKeys: readonly string[] = [],
): Promise<{ manifest: DeploymentManifest; result: PreflightResult }> {
  const settings = readEnvironmentSettings(application);
  const manifest = applyEnvironmentBindings(
    normalizeDeploymentManifest({ metadata: application.detectedMetadata ?? {} }, applicationToManifestOverrides(application)),
    settings,
  );
  const providedEnvKeys = [
    ...(await listProvidedConfigKeys(db, application.id, customerId, settings)),
    ...extraProvidedEnvKeys,
  ];
  const result = evaluatePreflight({
    manifest,
    providedEnvKeys,
    readiness: effectiveReadinessReport(application),
    settings,
  });
  return { manifest, result };
}

/**
 * Preflight for a deployment that exists but has not provisioned yet: the
 * stored manifest (the contract the deployment was created with) against
 * the configuration this customer has now.
 */
export async function runDeploymentPreflight(
  db: RuntimeDb,
  deployment: { id: string; applicationId: string; customerId: string; desiredState: Record<string, unknown> | null },
  application: PreflightApplicationRow | null,
): Promise<PreflightResult> {
  const manifest = readStoredManifest(deployment.desiredState);
  if (!manifest) {
    throw new ApiError(
      422,
      'MANIFEST_NEEDS_CONFIGURATION',
      'Deployment has no valid deployment manifest. Run analysis or correct the application configuration first.',
    );
  }
  // The vendor's saved decisions always apply — without them a key the vendor
  // marked "Managed by Deployz" or optional would block the install as if
  // nobody had decided it. Callers that pass no application still get them.
  const [settingsRow] = application
    ? [application]
    : await db
        .select({ environmentSettings: schema.applications.environmentSettings })
        .from(schema.applications)
        .where(eq(schema.applications.id, deployment.applicationId))
        .limit(1);
  const settings = settingsRow ? readEnvironmentSettings(settingsRow) : null;
  const providedEnvKeys = await listProvidedConfigKeys(db, deployment.applicationId, deployment.customerId, settings, deployment.id);
  return evaluatePreflight({
    manifest,
    providedEnvKeys,
    readiness: application ? effectiveReadinessReport(application) : null,
    settings,
  });
}

/**
 * Refuse to move toward provisioning unless the preflight is ready. The
 * error codes are the ones every client already handles; `details.findings`
 * carries blockers first, then warnings.
 */
export function requirePreflightReady(result: PreflightResult): void {
  if (result.state === 'UNSUPPORTED') {
    throw new ApiError(422, 'MANIFEST_NOT_COMPATIBLE', 'This application cannot be deployed with Deployz as configured.', {
      findings: [...result.blockers, ...result.warnings],
      state: result.state,
    });
  }
  if (!result.ready) {
    throw new ApiError(
      422,
      'MANIFEST_NEEDS_CONFIGURATION',
      'This application is missing configuration required for deployment. Run analysis or correct it in the application settings first.',
      { findings: [...result.blockers, ...result.warnings], state: result.state },
    );
  }
}
