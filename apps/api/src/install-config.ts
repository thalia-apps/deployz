import { eq } from 'drizzle-orm';

import { derivedS3EnvValue, derivedUrlEnvValue, mintedEnvKeys } from '@deployz/analysis';
import {
  TASK_FAMILY_SUFFIX_PARAMETER,
  buildDeploymentResourceTags,
  deliversConfigValue,
  requirementsFromSpec,
  taskFamilySuffixForSpec,
  type DeploymentSpecV2,
} from '@deployz/contracts';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { getConfig, type ConfigStore, type EffectiveConfigEntry } from './config.js';
import { getDefaultDeploymentUrl, type DefaultHostnameConfig } from './default-https.js';
import { readEnvironmentSettings } from './environment-setup.js';
import { ApiError } from './errors.js';
import { DESIRED_COUNT_PARAMETER, buildInstallParameters } from './install-parameters.js';
import { createOrReuseJob } from './jobs.js';
import { readStoredDeploymentSpec, readStoredManifest } from './manifest.js';

// Post-install configuration (AI MVP Phase 4).
//
// A fresh install runs the template's task definition: it carries the
// managed bindings (database, cache, storage, port) and nothing the vendor
// configured. The CONFIG_UPDATE fan-out only ever targets installed
// deployments, so a value saved before the first install never reached it,
// and an app-internal secret Deployz should mint had no moment to be minted.
// This module gives a successful INSTALL that moment: one CONFIG_UPDATE job
// (no values in the payload — the relay fetches the effective config and
// mints generated secrets inside the customer's account) whenever there is
// anything to apply.

/**
 * One line of the relay's effective-config view, plus the generated keys it
 * must mint and the values Deployz derives from the deployment region.
 */
export interface RelayConfigEntry {
  key: string;
  isSecret: boolean;
  value?: string;
  source: EffectiveConfigEntry['source'] | 'generated' | 'derived';
  generated?: true;
}

/**
 * DEPLOY-027 (Phase 4): the relay's only decryption seam. Given a
 * deployment id and a key, returns the plaintext or undefined if no row
 * exists. Without a vault (the unit-test path), behavior is unchanged —
 * secrets travel without a value. With a vault (production), decrypted
 * values are overlaid onto the secret entries.
 */
export interface PendingSecretVault {
  readBound(deploymentId: string, key: string): Promise<string | undefined>;
  /** Stamp delivery for every successful decrypt in this read cycle. */
  stampDelivery(deploymentId: string, key: string): Promise<void>;
  /**
   * VENDOR-scope secrets never enter the pending-secret vault (they persist
   * as ciphertext directly on the `application_configs` row instead — see
   * apps/api/src/config.ts's `listVendorValues`). This is the same
   * decryption for the one other reader that needs it: a vendor secret an
   * effective-config entry resolves to, with no bound customer-scope value
   * to overlay. Optional so the unit-test path (no vault) is unchanged.
   */
  readVendorSecret?(applicationId: string, key: string): Promise<string | undefined>;
}

/**
 * The entries the relay applies: every effective config entry (plain values
 * travel, secret values never do) plus, for each key without a vendor or
 * customer value, the value Deployz derives (S3 region/endpoint from the
 * deployment region, the app's own public URL from the default HTTPS URL) or an entry the relay mints (a generated key). When a
 * `vault` is passed (production path), pending-secrets rows are decrypted in this
 * seam — values the vendor typed before the relay enrolled reach the
 * customer via this read, not via the queue message.
 */
export async function buildRelayConfigEntries(
  db: RuntimeDb,
  deployment: {
    id?: string;
    applicationId: string;
    customerId: string;
    region: string;
    desiredState: Record<string, unknown> | null;
    /** The running control plane's prefix and zone for the derived default
     *  URL (production `d-` / `deployz.dev` when absent). */
    defaultHostname?: DefaultHostnameConfig;
  },
  store: ConfigStore,
  vault?: PendingSecretVault,
): Promise<RelayConfigEntry[]> {
  const view = await getConfig(deployment.applicationId, deployment.customerId, store);
  const manifest = readStoredManifest(deployment.desiredState);
  const [application] = await db
    .select({ environmentSettings: schema.applications.environmentSettings })
    .from(schema.applications)
    .where(eq(schema.applications.id, deployment.applicationId))
    .limit(1);
  const settings = application ? readEnvironmentSettings(application) : null;
  const settingsByKey = new Map((settings ?? []).map((setting) => [setting.key, setting]));
  const mintable = new Set<string>(manifest ? mintedEnvKeys(manifest, settings) : []);
  const entries: RelayConfigEntry[] = [];
  for (const entry of view.effective) {
    // A value left from an earlier decision never overrides the key's
    // current source (docs/environment-variables.md).
    if (!deliversConfigValue(settingsByKey.get(entry.key), entry.source)) continue;
    if (entry.isSecret && vault !== undefined && deployment.id !== undefined) {
      try {
        const plaintext = await vault.readBound(deployment.id, entry.key);
        if (plaintext !== undefined) {
          entries.push({
            key: entry.key,
            isSecret: true,
            value: plaintext,
            source: entry.source,
          });
          continue;
        }
      } catch {
        // Decrypt failure: omit the value, keep the row, return the masked
        // entry — the relay's next cycle retries.
      }
    }
    // A vendor secret never binds a pending-secret row (see
    // `PendingSecretVault.readVendorSecret`'s doc) — it decrypts straight
    // off the application_configs ciphertext instead.
    if (entry.isSecret && entry.source === 'vendor' && vault?.readVendorSecret !== undefined) {
      try {
        const plaintext = await vault.readVendorSecret(deployment.applicationId, entry.key);
        if (plaintext !== undefined) {
          entries.push({
            key: entry.key,
            isSecret: true,
            value: plaintext,
            source: entry.source,
          });
          continue;
        }
      } catch {
        // Decrypt failure: omit the value, keep the row, return the masked
        // entry — the relay's next cycle retries.
      }
    }
    entries.push({
      key: entry.key,
      isSecret: entry.isSecret,
      ...(entry.isSecret ? {} : { value: entry.value ?? '' }),
      source: entry.source,
      ...(entry.isSecret && mintable.has(entry.key) ? { generated: true as const } : {}),
    });
  }
  const configured = new Set(entries.map((entry) => entry.key));
  // Precedence: an explicit vendor/customer value (above) always wins over a
  // derived value.
  if (manifest !== null) {
    const defaultUrl = deployment.id === undefined ? null : getDefaultDeploymentUrl(deployment.id, deployment.defaultHostname);
    for (const variable of manifest.environment.variables) {
      if (configured.has(variable.key)) continue;
      const value =
        (manifest.storage.required ? derivedS3EnvValue(variable, deployment.region) : null) ??
        (defaultUrl === null ? null : derivedUrlEnvValue(variable, defaultUrl));
      if (value === null) continue;
      configured.add(variable.key);
      entries.push({ key: variable.key, isSecret: false, value, source: 'derived' });
    }
  }
  for (const key of mintable) {
    if (configured.has(key)) continue;
    entries.push({ key, isSecret: true, source: 'generated', generated: true });
  }
  return entries;
}

/**
 * Whether anything must reach the task before it first starts (DEPLOY-009):
 * a vendor/customer value or a generated secret. An application that
 * validates such a value at boot exits on an unconfigured task, so the
 * install then creates the service with zero tasks and the first deploy
 * after the configuration pass is the first start.
 */
export async function configPrecedesFirstStart(
  db: RuntimeDb,
  deployment: { applicationId: string; customerId: string; region: string; desiredState: Record<string, unknown> | null },
  store: ConfigStore,
): Promise<boolean> {
  return (await buildRelayConfigEntries(db, deployment, store)).length > 0;
}

/**
 * The task-family suffix of a deployment's compiled stack (empty for an
 * artifact with shared family names). Refused when the stack needs a suffix
 * and no installation is registered (the same refusal as a deploy without a
 * connected relay): no family could be named, and a deploy must never run
 * without its migration.
 */
export function requireTaskFamilySuffix(spec: DeploymentSpecV2, installationId: string | null): string {
  const suffix = taskFamilySuffixForSpec(spec, installationId);
  if (suffix === null) {
    throw new ApiError(
      409,
      'RELAY_NOT_CONNECTED',
      'No relay is connected to this deployment. Reconnect it before deploying.',
    );
  }
  return suffix;
}

/**
 * The INSTALL job's payload: the compiled template's URL + parameters, the
 * Redis/database flags, the deployment identity tags, the canonical manifest
 * and — when configuration must precede the first start and there is a
 * release to run — `startAfterConfig`, the marker that this install starts no
 * task by itself (the service is created with `param_DesiredCount=0`; the
 * post-install CONFIG_UPDATE and the auto-deploy that follow are the first
 * start).
 *
 * `templateUrl`, `databaseRequired`/`redisRequired` come from the
 * deployment's frozen spec (the compiled artifact the relay must fetch and
 * the verification contract it must satisfy), never re-derived — a
 * deployment created before the compiler existed fails closed here.
 * `installationId` names the installation the stack is created for; its
 * task-family suffix makes every task family of the stack its own.
 */
export async function buildInstallPayload(
  db: RuntimeDb,
  deployment: {
    id: string;
    applicationId: string;
    customerId: string;
    organizationId: string;
    region: string;
    desiredState: Record<string, unknown> | null;
    specV2: Record<string, unknown> | null;
  },
  store: ConfigStore,
  installationId: string | null,
): Promise<Record<string, unknown>> {
  const manifest = readStoredManifest(deployment.desiredState);
  if (!manifest) {
    throw new ApiError(
      422,
      'MANIFEST_NEEDS_CONFIGURATION',
      'Deployment has no valid deployment manifest. Run analysis or correct the application configuration first.',
    );
  }
  const spec = readStoredDeploymentSpec(deployment.specV2);
  if (!spec || spec.artifactLocation === null || spec.verificationContract === null) {
    throw new ApiError(
      422,
      'DEPLOYMENT_SPEC_MISSING',
      'Deployment has no compiled infrastructure spec. Recreate the deployment to install it.',
    );
  }
  const requirements = requirementsFromSpec(spec)!;
  const familySuffix = requireTaskFamilySuffix(spec, installationId);
  const startAfterConfig = await configPrecedesFirstStart(db, deployment, store);
  const { parameters, releaseId } = await buildInstallParameters(db, deployment.id, {
    startAfterConfig,
  });
  return {
    templateUrl: spec.artifactLocation,
    parameters: familySuffix === '' ? parameters : { ...parameters, [TASK_FAMILY_SUFFIX_PARAMETER]: familySuffix },
    databaseRequired: requirements.databaseRequired,
    redisRequired: requirements.redisRequired,
    // Control-plane-minted deployz identity tags. The relay applies them as
    // stack-level CreateStack tags, so CloudFormation propagates them to every
    // taggable resource. Stable internal ids only (vendorId is the owning
    // organization's id) — never names/emails/secrets/PII.
    tags: buildDeploymentResourceTags({
      deploymentId: deployment.id,
      applicationId: deployment.applicationId,
      customerId: deployment.customerId,
      vendorId: deployment.organizationId,
      ...(releaseId !== null ? { releaseId } : {}),
    }),
    // The canonical manifest this deployment was created with — the relay
    // derives port/health/binding parameters from it (Phase 2).
    manifest,
    ...(parameters[DESIRED_COUNT_PARAMETER] === '0' ? { startAfterConfig: true } : {}),
  };
}

/**
 * Queue the first configuration pass for a deployment whose INSTALL just
 * succeeded, when there is anything to apply. Idempotent per install job;
 * a replayed INSTALL result reuses the job. Creates no event: the result
 * route records `config.updated` / `config.failed` as for any config job.
 */
export async function queuePostInstallConfig(
  db: RuntimeDb,
  deployment: {
    id: string;
    applicationId: string;
    customerId: string;
    region: string;
    desiredState: Record<string, unknown> | null;
  },
  installJobId: string,
  store: ConfigStore,
): Promise<{ queued: boolean }> {
  const entries = await buildRelayConfigEntries(db, deployment, store);
  if (entries.length === 0) return { queued: false };
  const { created } = await createOrReuseJob(db, {
    deploymentId: deployment.id,
    type: 'CONFIG_UPDATE',
    idempotencyKey: `${deployment.id}:CONFIG_UPDATE:install:${installJobId}`,
    payload: { reason: 'install', changedKeys: entries.map((entry) => entry.key) },
    requestedBy: null,
  });
  return { queued: created };
}
