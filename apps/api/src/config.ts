import { and, eq, gt, inArray, isNull, ne, notInArray, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import { DEFAULT_PENDING_SECRET_TTL_MS, deliversConfigValue, type EnvironmentSetting } from '@deployz/contracts';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { ApiError, NotFoundError } from './errors.js';
import { createOrReuseJob } from './jobs.js';
import type { PendingSecretStore, SecretCipher } from './pending-secrets.js';
import { enqueue, type QueueMessage } from './queue.js';

// §31 application configuration API — vendor defaults (customer_id NULL)
// vs customer-specific overrides, with write-only secrets.
//
// Secret boundary (§31): secret values are write-only. They are written to
// the CUSTOMER's Secrets Manager via the relay write-through (todo 18's
// CONFIG_UPDATE workflow) and are NEVER stored in the control-plane DB in
// plaintext — the row carries the SECRET_MASK placeholder so key precedence
// and the isSecret flag keep working. The API NEVER returns a plaintext
// secret: masked views carry `value: null` for isSecret entries.
//
// Seams (same graceful-degradation pattern as billing/github): ConfigStore
// is the DB boundary (drizzle impl below, mocked in unit tests) and
// ConfigSecretWriter is the relay write-through (a no-op stub by default —
// the real relay dispatch plumbing lands with the deployment wiring; unit
// tests inject a mock).

// ── Types ─────────────────────────────────────────────────────────────────

/** A single config entry (§31). Also the stored row shape the store returns. */
export interface ConfigEntry {
  readonly key: string;
  readonly value: string;
  readonly isSecret: boolean;
  /**
   * VENDOR-scope only: ciphertext of the real secret value, produced by
   * `deps.cipher.encrypt` (the same SecretCipher DEPLOY-027's pending-secret
   * vault uses) with a deterministic context — present only when Deployz can
   * actually deliver this secret later (build args, post-install
   * CONFIG_UPDATE). `value` still carries SECRET_MASK for these rows.
   * CUSTOMER-scope secrets never populate this column — they travel through
   * the pending-secret vault instead (apps/api/src/pending-secrets.ts).
   * Undefined/null for plain values and for legacy secret rows written
   * before this column existed.
   */
  readonly encryptedValue?: string | null;
}

/** A config entry as the API returns it — secrets NEVER carry a value. */
export interface MaskedConfigEntry {
  readonly key: string;
  readonly isSecret: boolean;
  /** Null for secrets (write-only, §31); the plaintext value otherwise. */
  readonly value: string | null;
  /**
   * True when Deployz generated this secret (Stage B phase 4) — the vendor
   * did not type it. Derived from the stored marker, never from plaintext.
   */
  readonly generated?: boolean;
  /**
   * True for a VENDOR-scope secret row with no ciphertext (legacy, written
   * before secure storage existed): its plaintext was already discarded, so
   * it can never be delivered to a build or a deployment. The vendor has to
   * type it again — the UI surfaces this instead of quietly staying "ready".
   */
  readonly needsReentry?: boolean;
}

/** The effective entry after merging vendor defaults with customer overrides. */
export interface EffectiveConfigEntry extends MaskedConfigEntry {
  /** Where the effective value comes from — customer overrides win (§31). */
  readonly source: 'vendor' | 'customer';
  /** The vendor default when a customer override is in effect (null for secrets). */
  readonly vendorValue: string | null;
}

/** Everything the config screen needs for one application + customer scope. */
export interface ApplicationConfigView {
  readonly applicationId: string;
  /** Null when viewing vendor defaults; the customer id when scoped. */
  readonly customerId: string | null;
  readonly vendorDefaults: readonly MaskedConfigEntry[];
  readonly customerOverrides: readonly MaskedConfigEntry[];
  readonly effective: readonly EffectiveConfigEntry[];
}

// ── Request validation (route boundary) ───────────────────────────────────

export const configEntrySchema = z.object({
  key: z.string().min(1),
  value: z.string(),
  isSecret: z.boolean(),
});

export const setConfigBodySchema = z.object({
  /** Null/absent = write vendor defaults; a customer id = write overrides. */
  customerId: z.string().min(1).nullish(),
  entries: z.array(configEntrySchema).max(200),
  /**
   * Keys to remove in this same write. Adds, edits and removals travel
   * together so one Save is one atomic change to the scope. Without this
   * there was no delete path at all — not in the UI, and not by omitting an
   * entry, since setConfig only ever upserted what it was given.
   */
  deletes: z.array(z.string().min(1)).max(200).optional(),
});

// ── Seams ─────────────────────────────────────────────────────────────────

/** DB boundary for application_configs (+ the application existence check). */
export interface ConfigStore {
  applicationExists(applicationId: string): Promise<boolean>;
  /** Rows for the vendor scope (customerId null) or one customer's overrides. */
  list(applicationId: string, customerId: string | null): Promise<readonly ConfigEntry[]>;
  upsert(applicationId: string, customerId: string | null, entry: ConfigEntry): Promise<void>;
  /** Remove one key from a scope. Absent keys are not an error. */
  remove(applicationId: string, customerId: string | null, key: string): Promise<void>;
}

/**
 * §31 relay write-through: writes secret entries to the CUSTOMER's Secrets
 * Manager via the relay. The control plane never persists plaintext secrets.
 */
export interface ConfigSecretWriter {
  writeSecrets(applicationId: string, customerId: string, entries: readonly ConfigEntry[]): Promise<void>;
  /**
   * Remove secrets from the CUSTOMER's own secret store. A key deleted here
   * must not keep existing in their account — the control plane never held
   * the plaintext, so the relay is the only thing that can remove it.
   */
  removeSecrets(applicationId: string, customerId: string, keys: readonly string[]): Promise<void>;
}

export interface ConfigDeps {
  readonly store: ConfigStore;
  readonly secretWriter: ConfigSecretWriter;
  /** DEPLOY-027 (Phase 4) at-rest KMS-backed secret store. */
  readonly pendingSecrets: PendingSecretStore;
  /** Cipher used to encrypt/decrypt values before persisting to pending_secrets. */
  readonly cipher: SecretCipher;
  /**
   * Scope-deployments query seam. Production wires this to a drizzle query
   * over deployments filtered by (applicationId, customerId); tests inject
   * a fake so no DB is needed.
   */
  readonly findScopeDeployments: (applicationId: string, customerId: string) => Promise<
    ReadonlyArray<{ id: string; organizationId: string; state: typeof schema.deployments.$inferSelect['state'] }>
  >;
  /**
   * Lookup seam for the application's organization. The DEPLOY-027 staged
   * rows need an organizationId even when the scope has zero deployments —
   * the application's own row is the canonical source.
   */
  readonly findApplicationOrganizationId: (applicationId: string) => Promise<string | undefined>;
  /**
   * Customers with a deployment of this application whose relay can act on
   * a configuration change now. A vendor-default change reaches them.
   * Optional: without it, a vendor-default change reaches new installations only.
   */
  readonly findConfigurableCustomers?: (applicationId: string) => Promise<readonly string[]>;
}

// ── Secret masking (§31 write-only) ───────────────────────────────────────

/** Placeholder stored/emitted in place of a secret value (never plaintext). */
export const SECRET_MASK = '***';
/**
 * Stored marker for a Deployz-GENERATED secret (Stage B phase 4). Distinct
 * from SECRET_MASK so the API can tell "the vendor typed a secret" from
 * "Deployz generated one" without ever storing the plaintext. Both are
 * masks — neither is a value.
 */
export const GENERATED_SECRET_MASK = '***deployz-generated***';

/**
 * Mask one entry for the API boundary — secrets lose their value entirely.
 * `isVendorScope` flags a vendor-default row (customer_id NULL) so a legacy
 * secret with no ciphertext (written before secure storage existed) can be
 * surfaced as `needsReentry` — it is undeliverable, unlike a customer-scope
 * masked row which may already live in that customer's own Secrets Manager.
 */
export function toMaskedEntry(entry: ConfigEntry, isVendorScope = false): MaskedConfigEntry {
  if (!entry.isSecret) return { key: entry.key, isSecret: false, value: entry.value };
  const generated = entry.value === GENERATED_SECRET_MASK;
  if (generated) return { key: entry.key, isSecret: true, value: null, generated: true };
  const needsReentry = isVendorScope && (entry.encryptedValue === null || entry.encryptedValue === undefined);
  return needsReentry
    ? { key: entry.key, isSecret: true, value: null, needsReentry: true }
    : { key: entry.key, isSecret: true, value: null };
}

// ── Vendor/customer merge (pure) ──────────────────────────────────────────

/**
 * Merge vendor defaults with customer overrides into the effective config
 * (§31: a customer override takes precedence over the vendor default with the
 * same key). Order is stable: vendor-default order first, then customer-only
 * keys. All values are masked — secrets never surface here.
 */
export function mergeConfigEntries(
  vendorDefaults: readonly ConfigEntry[],
  customerOverrides: readonly ConfigEntry[],
): EffectiveConfigEntry[] {
  const order: string[] = [];
  const byKey = new Map<string, EffectiveConfigEntry>();

  for (const row of vendorDefaults) {
    order.push(row.key);
    byKey.set(row.key, { ...toMaskedEntry(row, true), source: 'vendor', vendorValue: null });
  }
  for (const row of customerOverrides) {
    const vendor = byKey.get(row.key);
    const masked = toMaskedEntry(row, false);
    if (vendor) {
      byKey.set(row.key, { ...masked, source: 'customer', vendorValue: vendor.value });
    } else {
      order.push(row.key);
      byKey.set(row.key, { ...masked, source: 'customer', vendorValue: null });
    }
  }

  const merged: EffectiveConfigEntry[] = [];
  for (const key of order) {
    const entry = byKey.get(key);
    if (entry) merged.push(entry);
  }
  return merged;
}

// ── Read ──────────────────────────────────────────────────────────────────

/**
 * Read an application's config for one scope: vendor defaults always, plus
 * the customer's overrides when customerId is given. Secrets are masked —
 * the response NEVER contains a plaintext secret value.
 */
export async function getConfig(
  applicationId: string,
  customerId: string | null,
  store: ConfigStore,
): Promise<ApplicationConfigView> {
  if (!(await store.applicationExists(applicationId))) {
    throw new NotFoundError('Application not found');
  }
  const vendorDefaults = await store.list(applicationId, null);
  const customerOverrides: readonly ConfigEntry[] =
    customerId === null ? [] : await store.list(applicationId, customerId);

  return {
    applicationId,
    customerId,
    vendorDefaults: vendorDefaults.map((entry) => toMaskedEntry(entry, true)),
    customerOverrides: customerOverrides.map((entry) => toMaskedEntry(entry, false)),
    effective: mergeConfigEntries(vendorDefaults, customerOverrides),
  };
}

// ── Write ─────────────────────────────────────────────────────────────────

/**
 * Write config entries for one scope (vendor defaults when customerId is
 * null, customer overrides otherwise).
 *
 * §31 write-through for secrets: entries flagged isSecret with a fresh value
 * are written to the CUSTOMER's Secrets Manager via the relay BEFORE anything
 * persists, and the control-plane row stores only SECRET_MASK — plaintext
 * never touches the DB. Untouched secret fields arrive as empty strings
 * (write-only inputs never echo the old value) and are skipped — an empty
 * secret means "leave unchanged". Vendor-scope secrets have no customer
 * account to write to, so they persist as masked placeholders only.
 *
 * DEPLOY-027 (Phase 4): a customer-required secret typed before the relay
 * connects must survive until a deployment is ready to consume it. The
 * staged/bound pending_secrets rows are the durable transport: pre-relay
 * deployments get per-deployment bound ciphertext immediately, the
 * "no deployment yet" path persists a staged row that the next
 * createDeploymentRecord materializes. Plaintext is encrypted ONCE per key
 * with the staged context, then bound rows re-encrypt with the deployment
 * context — only the relay config fetch ever decrypts.
 *
 * All-or-nothing: a failed relay write aborts before any DB write.
 */
export async function setConfig(
  applicationId: string,
  customerId: string | null,
  entries: readonly ConfigEntry[],
  deps: ConfigDeps,
  deletes: readonly string[] = [],
): Promise<ApplicationConfigView> {
  validateEntries(entries);
  if (!(await deps.store.applicationExists(applicationId))) {
    throw new NotFoundError('Application not found');
  }

  // A key cannot be written and removed in one save — that is a client bug,
  // and guessing which the vendor meant is worse than saying so.
  const writtenKeys = new Set(entries.map((entry) => entry.key));
  const conflicting = deletes.filter((key) => writtenKeys.has(key));
  if (conflicting.length > 0) {
    throw new ApiError(
      400,
      'CONFIG_CONFLICTING_WRITE',
      `These values are both set and removed in the same save: ${conflicting.join(', ')}.`,
    );
  }

  // Every customer-scoped change propagates to the running deployment —
  // plain values included, not only secrets. A save that only touched plain
  // variables previously enqueued nothing, so the running application never
  // saw it while the screen promised it would "within a few minutes"
  // (verified live). Untouched secrets (empty value) are not changes.
  const changedEntries = entries.filter((entry) => !(entry.isSecret && entry.value.length === 0));

  // DEPLOY-027 (Phase 4): one query splits the scope's deployments into
  // claimable (a relay can act on them today — anything outside the four
  // pre-relay states) and pre-relay (NOT_INSTALLED, WAITING_FOR_RELAY,
  // DELETING, DELETED). The exact filter mirrors packages/cdk/src/lambda/worker.ts:420-428.
  const scopeDeployments =
    customerId === null
      ? { claimable: [] as ScopeDeployment[], preRelay: [] as ScopeDeployment[], bindable: [] as ScopeDeployment[] }
      : splitScopeDeployments(await deps.findScopeDeployments(applicationId, customerId));
  // DEPLOY-027 (Phase 4): the org id comes from the application's own row
  // when the scope has no deployments — staged rows need it, and the worker's
  // CONFIG_UPDATE fanout already trusts that every deployment in scope shares
  // an application.organization_id.
  const applicationOrganizationId = await deps.findApplicationOrganizationId(applicationId);
  const organizationId =
    scopeDeployments.claimable[0]?.organizationId ??
    scopeDeployments.preRelay[0]?.organizationId ??
    applicationOrganizationId;

  // Encrypt each non-empty secret value ONCE per key, with the staged
  // context. A bind failure here is a hard 502 — we never persist a half-
  // encrypted state. The cap (4096 bytes) matches KMS Encrypt's plaintext
  // limit. Vendor-scope secrets have no customer account to bind to, so they
  // skip this path entirely (the row carries SECRET_MASK only).
  const encryptedSecrets: Array<{
    entry: ConfigEntry;
    ciphertext: string;
    encryptionContext: Record<string, string>;
  }> = [];
  if (customerId !== null) {
    if (organizationId !== undefined) {
      for (const entry of changedEntries) {
        if (!entry.isSecret) continue;
        if (Buffer.byteLength(entry.value, 'utf8') > 4096) {
          throw new ApiError(
            422,
            'SECRET_VALUE_TOO_LARGE',
            `Secret value for key "${entry.key}" exceeds the KMS 4096-byte plaintext limit.`,
          );
        }
        const stagedContext: Record<string, string> = {
          organizationId,
          applicationId,
          key: entry.key,
          customerId,
        };
        try {
          const { ciphertext, encryptionContext } = await deps.cipher.encrypt(
            entry.value,
            stagedContext,
          );
          encryptedSecrets.push({ entry, ciphertext, encryptionContext });
        } catch {
          throw new ApiError(
            502,
            'CONFIG_WRITE_FAILED',
            'The configuration could not be written. Try again in a moment.',
          );
        }
      }
    }
  }

  // The relay write-through is for deployments the worker can act on today
  // (claimable). When zero claimable deployments exist we skip the enqueue:
  // every candidate is pre-relay, the worker would no-op, and the bound
  // ciphertext rows below deliver via GET /api/relay/config as soon as the
  // relay enrolls.
  if (customerId !== null && changedEntries.length > 0 && scopeDeployments.claimable.length > 0) {
    try {
      await deps.secretWriter.writeSecrets(applicationId, customerId, changedEntries);
    } catch {
      throw new ApiError(
        502,
        'CONFIG_WRITE_FAILED',
        'The configuration could not be written. Try again in a moment.',
      );
    }
  }

  for (const entry of entries) {
    if (entry.isSecret && entry.value.length === 0) continue; // untouched secret
    // VENDOR-scope secrets have no pending-secret vault to bind to (that
    // path is customer-only, see `encryptedSecrets` above) — the ciphertext
    // that makes them deliverable later (build args, post-install
    // CONFIG_UPDATE) lives directly on the row, encrypted with the same
    // SecretCipher and a deterministic, reconstructible context. CUSTOMER-
    // scope secrets never populate this column: they travel through the
    // pending-secret vault instead, so the row here carries the mask only.
    let stored: ConfigEntry;
    if (entry.isSecret && customerId === null) {
      if (Buffer.byteLength(entry.value, 'utf8') > 4096) {
        throw new ApiError(
          422,
          'SECRET_VALUE_TOO_LARGE',
          `Secret value for key "${entry.key}" exceeds the KMS 4096-byte plaintext limit.`,
        );
      }
      const vendorOrganizationId = applicationOrganizationId;
      if (vendorOrganizationId === undefined) {
        throw new ApiError(
          502,
          'CONFIG_WRITE_FAILED',
          'The configuration could not be written. Try again in a moment.',
        );
      }
      try {
        const { ciphertext } = await deps.cipher.encrypt(
          entry.value,
          vendorSecretContext(vendorOrganizationId, applicationId, entry.key),
        );
        stored = { key: entry.key, value: SECRET_MASK, isSecret: true, encryptedValue: ciphertext };
      } catch {
        throw new ApiError(
          502,
          'CONFIG_WRITE_FAILED',
          'The configuration could not be written. Try again in a moment.',
        );
      }
    } else if (entry.isSecret) {
      stored = { key: entry.key, value: SECRET_MASK, isSecret: true, encryptedValue: null };
    } else {
      stored = { ...entry, encryptedValue: null };
    }
    await deps.store.upsert(applicationId, customerId, stored);
  }

  // DEPLOY-027 (Phase 4): persist the at-rest secret rows.
  //   * Zero claimable deployments AND at least one pre-relay deployment →
  //     staged rows persist for every encrypted key. The next
  //     createDeploymentRecord call materializes them.
  //   * One or more pre-relay deployments → bound rows per deployment,
  //     re-encrypted with the deployment context. The relay picks them up
  //     the moment its /api/relay/config fetch runs for that deployment.
  // The encryption context binds the row to its scope so a stolen row's
  // ciphertext cannot be reused against an unrelated tenant.
  const expiresAt = new Date(Date.now() + DEFAULT_PENDING_SECRET_TTL_MS);
  if (customerId !== null) {
    if (organizationId !== undefined) {
      if (scopeDeployments.bindable.length > 0) {
        for (const { entry } of encryptedSecrets) {
          for (const deployment of scopeDeployments.bindable) {
            // Re-bind with the deployment context so a relay holding this
            // row can only decrypt it for the matching deployment.
            const boundContext: Record<string, string> = {
              organizationId: deployment.organizationId,
              applicationId,
              deploymentId: deployment.id,
              key: entry.key,
              customerId,
            };
            let boundCiphertext: string;
            try {
              ({ ciphertext: boundCiphertext } = await deps.cipher.encrypt(entry.value, boundContext));
            } catch {
              throw new ApiError(
                502,
                'CONFIG_WRITE_FAILED',
                'The configuration could not be written. Try again in a moment.',
              );
            }
            await deps.pendingSecrets.upsertBound({
              organizationId: deployment.organizationId,
              applicationId,
              deploymentId: deployment.id,
              key: entry.key,
              ciphertext: boundCiphertext,
              encryptionContext: boundContext,
              expiresAt,
            });
          }
        }
      }
      // No claimable AND no pre-relay deployments (yet): persist staged rows
      // so the first deployment to land materializes them.
      if (scopeDeployments.claimable.length === 0 && scopeDeployments.preRelay.length === 0) {
        for (const { entry, ciphertext, encryptionContext } of encryptedSecrets) {
          await deps.pendingSecrets.upsertStaged({
            organizationId,
            applicationId,
            customerId,
            key: entry.key,
            ciphertext,
            encryptionContext,
            expiresAt,
            createdBy: null,
          });
        }
      }
    }
  }

  if (deletes.length > 0) {
    // Removals propagate for every key: a removed secret has to leave the
    // customer's own secret store, and a removed plain variable has to leave
    // the running task definition — both travel as removedKeys on the same
    // CONFIG_UPDATE write-through.
    if (customerId !== null) {
      try {
        await deps.secretWriter.removeSecrets(applicationId, customerId, deletes);
      } catch {
        throw new ApiError(
          502,
          'CONFIG_WRITE_FAILED',
          'The configuration could not be written. Try again in a moment.',
        );
      }
    }
    for (const key of deletes) {
      await deps.store.remove(applicationId, customerId, key);
    }
    // Drop the staged and pre-relay bound rows for the deleted keys only, so
    // the relay config fetch does not see them. Rows for other keys stay:
    // they still have to reach the deployment.
    if (customerId !== null) {
      for (const key of deletes) {
        await deps.pendingSecrets.deleteStagedForScope({
          applicationId,
          customerId,
          key,
        });
      }
      for (const deployment of scopeDeployments.preRelay) {
        await deps.pendingSecrets.deleteBoundForDeployment(deployment.id, deletes);
      }
    }
  }

  // A vendor default reaches every running deployment of the application,
  // as a customer override reaches that customer's. Vendor secrets never
  // ride the queue: the relay decrypts them from its config read. A removed
  // default leaves only deployments that have no override for the key.
  if (customerId === null && deps.findConfigurableCustomers !== undefined && (changedEntries.length > 0 || deletes.length > 0)) {
    const plainChanges = changedEntries.map((entry) => (entry.isSecret ? { ...entry, value: '' } : entry));
    try {
      for (const customer of await deps.findConfigurableCustomers(applicationId)) {
        if (plainChanges.length > 0) await deps.secretWriter.writeSecrets(applicationId, customer, plainChanges);
        const overridden = new Set((await deps.store.list(applicationId, customer)).map((entry) => entry.key));
        const removed = deletes.filter((key) => !overridden.has(key));
        if (removed.length > 0) await deps.secretWriter.removeSecrets(applicationId, customer, removed);
      }
    } catch {
      throw new ApiError(
        502,
        'CONFIG_WRITE_FAILED',
        'The configuration was saved, but it could not be sent to running deployments. Save again in a moment.',
      );
    }
  }

  return getConfig(applicationId, customerId, deps.store);
}

const PRE_RELAY_STATES = new Set([
  'NOT_INSTALLED',
  'WAITING_FOR_RELAY',
  'DELETING',
  'DELETED',
]);

interface ScopeDeployment {
  id: string;
  organizationId: string;
}

function splitScopeDeployments(
  rows: ReadonlyArray<{ id: string; organizationId: string; state: typeof schema.deployments.$inferSelect['state'] }>,
): { claimable: ScopeDeployment[]; preRelay: ScopeDeployment[]; bindable: ScopeDeployment[] } {
  const claimable: ScopeDeployment[] = [];
  const preRelay: ScopeDeployment[] = [];
  const bindable: ScopeDeployment[] = [];
  for (const row of rows) {
    const deployment = { id: row.id, organizationId: row.organizationId };
    if (PRE_RELAY_STATES.has(row.state)) {
      preRelay.push(deployment);
      bindable.push(deployment);
    } else {
      claimable.push(deployment);
      // While the install runs, the relay is connected but the application
      // stack may not exist yet: the direct CONFIG_UPDATE then finds no ECS
      // service and fails, and its payload is scrubbed on claim, so the
      // value would be lost. A bound row is delivered by the install-time
      // CONFIG_UPDATE's config fetch regardless.
      if (row.state === 'INSTALLING') bindable.push(deployment);
    }
  }
  return { claimable, preRelay, bindable };
}

/** Empty keys and duplicate keys within one write are rejected (§31). */
function validateEntries(entries: readonly ConfigEntry[]): void {
  const seen = new Set<string>();
  const invalidKeys: string[] = [];
  for (const entry of entries) {
    if (entry.key.length === 0) {
      invalidKeys.push('');
      continue;
    }
    if (seen.has(entry.key)) {
      invalidKeys.push(entry.key);
      continue;
    }
    seen.add(entry.key);
  }
  if (invalidKeys.length > 0) {
    throw new ApiError(400, 'INVALID_CONFIG', 'Configuration keys are invalid', { invalidKeys });
  }
}

/**
 * The deterministic EncryptionContext for a VENDOR-scope secret row. Unlike
 * the pending-secret vault's per-row context, this one is never stored —
 * `organizationId` + `applicationId` + `key` are exactly the values already
 * on hand at decrypt time (`listVendorValues`, the relay's vendor-secret
 * read in `buildRelayConfigEntries`), so recomputing it is simpler than
 * persisting a second column. `scope: 'vendor'` keeps it from ever
 * colliding with a customer-scope pending-secret context that happens to
 * share the same organization/application/key.
 */
function vendorSecretContext(
  organizationId: string,
  applicationId: string,
  key: string,
): Record<string, string> {
  return { organizationId, applicationId, key, scope: 'vendor' };
}

// ── Real seams ────────────────────────────────────────────────────────────

// application_configs.application_id is uuid-keyed: fixture/dev ids are not
// UUIDs and can never match — skip the query (Postgres would raise "invalid
// input syntax for type uuid" instead of returning no rows).
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Drizzle-backed ConfigStore over the real schema. */
export function createConfigStore(db: RuntimeDb): ConfigStore {
  const scopeWhere = (applicationId: string, customerId: string | null, key?: string): SQL => {
    const conditions: SQL[] = [eq(schema.applicationConfigs.applicationId, applicationId)];
    conditions.push(
      customerId === null
        ? isNull(schema.applicationConfigs.customerId)
        : eq(schema.applicationConfigs.customerId, customerId),
    );
    if (key !== undefined) {
      conditions.push(eq(schema.applicationConfigs.key, key));
    }
    return and(...conditions) as SQL;
  };

  return {
    async applicationExists(applicationId) {
      if (!UUID_PATTERN.test(applicationId)) return false;
      const rows = await db
        .select({ id: schema.applications.id })
        .from(schema.applications)
        .where(eq(schema.applications.id, applicationId))
        .limit(1);
      return rows.length > 0;
    },

    async list(applicationId, customerId) {
      if (!UUID_PATTERN.test(applicationId)) return [];
      if (customerId !== null && !UUID_PATTERN.test(customerId)) return [];
      const rows = await db
        .select({
          key: schema.applicationConfigs.key,
          value: schema.applicationConfigs.value,
          isSecret: schema.applicationConfigs.isSecret,
          encryptedValue: schema.applicationConfigs.encryptedValue,
        })
        .from(schema.applicationConfigs)
        .where(scopeWhere(applicationId, customerId))
        .orderBy(schema.applicationConfigs.key);
      return rows;
    },

    // Select-then-insert/update keeps this portable — it does not depend on
    // ON CONFLICT inference against the NULLS NOT DISTINCT unique index.
    async upsert(applicationId, customerId, entry) {
      const existing = await db
        .select({ id: schema.applicationConfigs.id })
        .from(schema.applicationConfigs)
        .where(scopeWhere(applicationId, customerId, entry.key))
        .limit(1);
      if (existing.length > 0) {
        await db
          .update(schema.applicationConfigs)
          .set({ value: entry.value, isSecret: entry.isSecret, encryptedValue: entry.encryptedValue ?? null })
          .where(scopeWhere(applicationId, customerId, entry.key));
        return;
      }
      await db.insert(schema.applicationConfigs).values({
        applicationId,
        customerId,
        key: entry.key,
        value: entry.value,
        isSecret: entry.isSecret,
        encryptedValue: entry.encryptedValue ?? null,
      });
    },

    async remove(applicationId, customerId, key) {
      if (!UUID_PATTERN.test(applicationId)) return;
      if (customerId !== null && !UUID_PATTERN.test(customerId)) return;
      await db
        .delete(schema.applicationConfigs)
        .where(scopeWhere(applicationId, customerId, key));
    },
  };
}

/**
 * Relay write-through backed by SQS. Enqueues a CONFIG_UPDATE relay command
 * to the job queue so the worker can dispatch it to the relay Lambda in the
 * customer account. New secret VALUES ride the queue message transiently —
 * the relay persists them into the customer's own Secrets Manager; the
 * control plane's durable stores only ever see keys and the SECRET_MASK
 * placeholder. The relay fetches the effective configuration over its
 * authenticated channel when it executes. Without a queue (local dev,
 * simulated E2E) `enqueue` reports false and the fan-out runs inline.
 */
export function createRelaySecretWriter(db: RuntimeDb): ConfigSecretWriter {
  async function send(message: ConfigUpdateMessage): Promise<void> {
    if (!(await enqueue(message))) await fanOutConfigUpdate(db, message, crypto.randomUUID());
  }
  return {
    async writeSecrets(applicationId, customerId, entries) {
      const secrets = entries
        .filter((entry) => entry.isSecret && entry.value.length > 0)
        .map(({ key, value }) => ({ key, value }));
      await send({
        type: 'CONFIG_UPDATE',
        customerId,
        applicationId,
        changedKeys: entries.map((entry) => entry.key),
        ...(secrets.length > 0 ? { secrets } : {}),
      });
    },

    async removeSecrets(applicationId, customerId, keys) {
      await send({ type: 'CONFIG_UPDATE', customerId, applicationId, removedKeys: [...keys] });
    },
  };
}

type ConfigUpdateMessage = Extract<QueueMessage, { type: 'CONFIG_UPDATE' }>;

/**
 * Turns a config write-through into per-deployment CONFIG_UPDATE jobs (the
 * worker runs it for a queued message; the API runs it inline without a
 * queue). The durable payload carries newly-entered secret VALUES only long
 * enough for the relay to claim them — `GET /api/relay/commands` serves the
 * payload once and scrubs the values from the stored row in the same
 * request (see `redactClaimedPayload` in server.ts). Until that claim, the
 * job row in the control-plane DB holds the plaintext values.
 */
export async function fanOutConfigUpdate(
  db: RuntimeDb,
  message: ConfigUpdateMessage,
  messageId: string,
): Promise<void> {
  // Only deployments a relay can actually act on: nothing is enrolled before
  // install, and nothing remains to configure during/after removal. A job
  // created for those rows would sit REQUESTED until the watchdog failed it.
  const deployments = await db
    .select()
    .from(schema.deployments)
    .where(
      and(
        eq(schema.deployments.customerId, message.customerId),
        // One customer can run several of the vendor's applications: a save
        // for one must never reach (or remove a same-named key from) another.
        message.applicationId !== undefined ? eq(schema.deployments.applicationId, message.applicationId) : undefined,
        notInArray(schema.deployments.state, [
          'NOT_INSTALLED',
          'WAITING_FOR_RELAY',
          'DELETING',
          'DELETED',
        ]),
      ),
    );

  console.log(
    JSON.stringify({
      event: 'worker:config-update-fanout',
      messageId,
      customerId: message.customerId,
      applicationId: message.applicationId ?? null,
      deployments: deployments.length,
      // Values never leave the process in a log line — count only.
      secretCount: message.secrets?.length ?? 0,
    }),
  );

  for (const deployment of deployments) {
    // CONFIG_UPDATE sits outside the one-active-mutating-job index on
    // purpose: the secret value rides this payload transiently (§31 phase
    // 1.2) and skipping the fanout because an install/deploy is active
    // would lose it. The relay claim route hands it out only once no other
    // service mutation of the deployment is running.
    await createOrReuseJob(db, {
      deploymentId: deployment.id,
      type: 'CONFIG_UPDATE',
      // Keyed on the SQS message, so a redelivery of the same write reuses
      // the job it already created while a genuinely new write makes a new
      // one - writing the same key twice is a legitimate second job.
      idempotencyKey: `${deployment.id}:CONFIG_UPDATE:${messageId}`,
      payload: {
        ...(message.changedKeys ? { changedKeys: [...message.changedKeys] } : {}),
        ...(message.secrets ? { secrets: message.secrets.map((s) => ({ ...s })) } : {}),
        ...(message.removedKeys ? { removedKeys: [...message.removedKeys] } : {}),
      },
      requestedBy: null,
    });
  }
}

/** DEPLOY-027 (Phase 4): default scope-deployments lookup over the db. */
export function createScopeDeploymentsFinder(
  db: RuntimeDb,
): ConfigDeps['findScopeDeployments'] {
  return async (applicationId, customerId) => {
    if (!UUID_PATTERN.test(applicationId) || !UUID_PATTERN.test(customerId)) return [];
    return db
      .select({
        id: schema.deployments.id,
        organizationId: schema.deployments.organizationId,
        state: schema.deployments.state,
      })
      .from(schema.deployments)
      .where(
        and(
          eq(schema.deployments.applicationId, applicationId),
          eq(schema.deployments.customerId, customerId),
        ),
      );
  };
}

/** DEPLOY-027 (Phase 4): the default ConfigDeps for the live API. */
export function createConfigDeps(
  db: RuntimeDb,
  pendingSecrets: PendingSecretStore,
  cipher: SecretCipher,
): ConfigDeps {
  return {
    store: createConfigStore(db),
    secretWriter: createRelaySecretWriter(db),
    pendingSecrets,
    cipher,
    findScopeDeployments: createScopeDeploymentsFinder(db),
    findApplicationOrganizationId: createApplicationOrganizationIdFinder(db),
    findConfigurableCustomers: createConfigurableCustomersFinder(db),
  };
}

/**
 * Customers with a deployment of the application that a relay can act on now:
 * past the pre-relay states, not being removed, relay not disconnected (the
 * same filter as the worker's fan-out and the config route's relay gate).
 */
export function createConfigurableCustomersFinder(db: RuntimeDb): NonNullable<ConfigDeps['findConfigurableCustomers']> {
  return async (applicationId) => {
    if (!UUID_PATTERN.test(applicationId)) return [];
    const rows = await db
      .selectDistinct({ customerId: schema.deployments.customerId })
      .from(schema.deployments)
      .where(
        and(
          eq(schema.deployments.applicationId, applicationId),
          notInArray(schema.deployments.state, [...PRE_RELAY_STATES] as (typeof schema.deployments.$inferSelect)['state'][]),
          ne(schema.deployments.relayStatus, 'DISCONNECTED'),
        ),
      );
    return rows.map((row) => row.customerId);
  };
}

function createApplicationOrganizationIdFinder(
  db: RuntimeDb,
): ConfigDeps['findApplicationOrganizationId'] {
  return async (applicationId) => {
    if (!UUID_PATTERN.test(applicationId)) return undefined;
    const rows = await db
      .select({ organizationId: schema.applications.organizationId })
      .from(schema.applications)
      .where(eq(schema.applications.id, applicationId))
      .limit(1);
    return rows[0]?.organizationId;
  };
}

/**
 * The env keys that already carry a value for one deployment scope: vendor
 * defaults for the application plus this customer's overrides (§31 merge
 * order). Used by the §11.2 readiness gate at deployment creation to decide
 * which required env vars are already provided.
 *
 * A VENDOR-scope secret row with no ciphertext (legacy, written before
 * secure storage existed) is excluded — its plaintext was already discarded,
 * so it can never actually reach a build or a deployment. Counting it as
 * "provided" is exactly the readiness-says-ready-but-nothing-arrives gap
 * this module closes. A customer-scope masked secret row is counted only
 * while its value can still reach the deployment: with `deploymentId`, a
 * pending row bound to it or a finished configuration update of it that named
 * the key; without one (pre-creation), a reusable staged row. Otherwise the
 * customer enters it again.
 */
export async function listProvidedConfigKeys(
  db: RuntimeDb,
  applicationId: string,
  customerId: string | null,
  settings: readonly EnvironmentSetting[] | null = null,
  deploymentId: string | null = null,
): Promise<string[]> {
  if (!UUID_PATTERN.test(applicationId) || (customerId !== null && !UUID_PATTERN.test(customerId))) return [];
  const rows = await db
    .select({
      key: schema.applicationConfigs.key,
      customerId: schema.applicationConfigs.customerId,
      isSecret: schema.applicationConfigs.isSecret,
      encryptedValue: schema.applicationConfigs.encryptedValue,
    })
    .from(schema.applicationConfigs)
    .where(
      and(
        eq(schema.applicationConfigs.applicationId, applicationId),
        customerId === null
          ? isNull(schema.applicationConfigs.customerId)
          : or(isNull(schema.applicationConfigs.customerId), eq(schema.applicationConfigs.customerId, customerId)),
      ),
    );
  const settingsByKey = new Map((settings ?? []).map((setting) => [setting.key, setting]));
  const customerSecretKeys = rows.filter((row) => row.customerId !== null && row.isSecret).map((row) => row.key);
  const reachable =
    customerId === null || customerSecretKeys.length === 0
      ? new Set<string>()
      : await reachableCustomerSecretKeys(db, applicationId, customerId, customerSecretKeys, deploymentId);
  // A customer row wins over the vendor row for its key, so an unreachable
  // customer secret leaves the key without a value even when the vendor has one.
  const unreachable = new Set(
    customerId === null ? [] : customerSecretKeys.filter((key) => !reachable.has(key)),
  );
  const deliverable = rows.filter(
    (row) =>
      !(row.customerId === null && row.isSecret && row.encryptedValue === null) &&
      !(row.customerId !== null && row.isSecret && unreachable.has(row.key)) &&
      !(row.customerId === null && unreachable.has(row.key)) &&
      deliversConfigValue(settingsByKey.get(row.key), row.customerId === null ? 'vendor' : 'customer'),
  );
  return [...new Set(deliverable.map((row) => row.key))];
}

/**
 * The customer secret keys whose value can still reach one deployment.
 *
 * Without a deployment (pre-creation), only reusable staged rows count: they
 * are materialized for the deployment when it is created. With a deployment,
 * a key counts only when a bound pending row for that deployment is unexpired
 * or a finished CONFIG_UPDATE job of that same deployment named the key (job
 * payloads keep key names after the values are scrubbed). A deployment that
 * is being deleted receives nothing.
 */
async function reachableCustomerSecretKeys(
  db: RuntimeDb,
  applicationId: string,
  customerId: string,
  keys: readonly string[],
  deploymentId: string | null,
): Promise<Set<string>> {
  const now = new Date();
  if (deploymentId === null) {
    const staged = await db
      .select({ key: schema.pendingSecrets.key })
      .from(schema.pendingSecrets)
      .where(
        and(
          eq(schema.pendingSecrets.applicationId, applicationId),
          eq(schema.pendingSecrets.customerId, customerId),
          isNull(schema.pendingSecrets.deploymentId),
          inArray(schema.pendingSecrets.key, [...keys]),
          gt(schema.pendingSecrets.expiresAt, now),
        ),
      );
    return new Set(staged.map((row) => row.key));
  }
  if (!UUID_PATTERN.test(deploymentId)) return new Set();
  const [deployment] = await db
    .select({ id: schema.deployments.id })
    .from(schema.deployments)
    .where(
      and(
        eq(schema.deployments.id, deploymentId),
        eq(schema.deployments.applicationId, applicationId),
        eq(schema.deployments.customerId, customerId),
        notInArray(schema.deployments.state, ['DELETING', 'DELETED']),
      ),
    )
    .limit(1);
  if (deployment === undefined) return new Set();
  const bound = await db
    .select({ key: schema.pendingSecrets.key })
    .from(schema.pendingSecrets)
    .where(
      and(
        eq(schema.pendingSecrets.deploymentId, deploymentId),
        inArray(schema.pendingSecrets.key, [...keys]),
        gt(schema.pendingSecrets.expiresAt, now),
      ),
    );
  const jobs = await db
    .select({ payload: schema.deploymentJobs.payload })
    .from(schema.deploymentJobs)
    .where(
      and(
        eq(schema.deploymentJobs.deploymentId, deploymentId),
        eq(schema.deploymentJobs.type, 'CONFIG_UPDATE'),
        inArray(schema.deploymentJobs.state, ['SUCCEEDED', 'SUCCESS']),
      ),
    );
  const delivered = new Set(bound.map((row) => row.key));
  for (const { payload } of jobs) {
    const names = [
      ...stringList(payload?.['changedKeys']),
      ...((Array.isArray(payload?.['secrets']) ? payload['secrets'] : []) as { key?: unknown }[]).map((entry) => entry?.key),
    ];
    for (const name of names) if (typeof name === 'string' && keys.includes(name)) delivered.add(name);
  }
  return delivered;
}

function stringList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Decrypted (or plain) vendor-default values for the given keys, for the
 * given application. Used by the build worker to fill build-time variables
 * (packages/cdk/src/lambda/worker.ts's `loadBuildVariables`) — vendor
 * defaults only; a build has no customer to scope to.
 */
export async function listVendorValues(
  db: RuntimeDb,
  applicationId: string,
  keys: readonly string[],
  cipher: SecretCipher,
): Promise<Record<string, string>> {
  if (!UUID_PATTERN.test(applicationId) || keys.length === 0) return {};
  const [application] = await db
    .select({ organizationId: schema.applications.organizationId })
    .from(schema.applications)
    .where(eq(schema.applications.id, applicationId))
    .limit(1);
  if (application === undefined) return {};
  const rows = await db
    .select({
      key: schema.applicationConfigs.key,
      value: schema.applicationConfigs.value,
      isSecret: schema.applicationConfigs.isSecret,
      encryptedValue: schema.applicationConfigs.encryptedValue,
    })
    .from(schema.applicationConfigs)
    .where(
      and(
        eq(schema.applicationConfigs.applicationId, applicationId),
        isNull(schema.applicationConfigs.customerId),
        inArray(schema.applicationConfigs.key, [...keys]),
      ),
    );

  const result: Record<string, string> = {};
  for (const row of rows) {
    if (row.isSecret) {
      if (!row.encryptedValue) continue; // legacy, undeliverable — see listProvidedConfigKeys
      try {
        result[row.key] = await cipher.decrypt(
          row.encryptedValue,
          vendorSecretContext(application.organizationId, applicationId, row.key),
        );
      } catch {
        continue; // decrypt failure: omit the value, same as a legacy row
      }
    } else {
      result[row.key] = row.value;
    }
  }
  return result;
}
