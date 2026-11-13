import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import {
  createConfigDeps,
  createConfigurableCustomersFinder,
  createRelaySecretWriter,
  GENERATED_SECRET_MASK,
  SECRET_MASK,
  getConfig,
  listProvidedConfigKeys,
  listVendorValues,
  mergeConfigEntries,
  setConfig,
  setConfigBodySchema,
  toMaskedEntry,
  type ConfigDeps,
  type ConfigEntry,
  type ConfigSecretWriter,
  type ConfigStore,
} from './config.js';
import { enqueue } from './queue.js';
import { ApiError } from './errors.js';
import { createCipherStub, createDrizzlePendingSecretStore } from './pending-secrets.js';

// enqueue is only ever called by createRelaySecretWriter (below) — mocking
// it here affects no other test in this file.
vi.mock('./queue.js');

// DEPLOY-027 (Phase 4): the existing config.test.ts unit tests still need
// to exercise setConfig's masking / write-through logic without dragging in
// real KMS or DB lookups. A no-op ConfigDeps factory keeps the test surface
// identical — every assertion is on the SAME behaviour the tests already
// lock — while giving setConfig the new cipher/pendingSecrets/findScope
// seams it now requires.
//
// The brief changes one observable behaviour: when the scope has zero
// CLAIMABLE deployments (anything outside NOT_INSTALLED / WAITING_FOR_RELAY
// / DELETING / DELETED), setConfig skips the relay write-through enqueue —
// the worker would no-op anyway, and the value lives encrypted in
// pending_secrets for the next createDeploymentRecord to materialize. The
// mocks below default to a single HEALTHY claimable deployment so the
// existing assertions on the write-through continue to hold.
function buildDeps(store: ConfigStore, secretWriter: ConfigSecretWriter): ConfigDeps {
  return buildDepsWithDeployments(store, secretWriter, [
    { id: 'deployment-1', organizationId: 'org-1', state: 'HEALTHY' },
  ]);
}

function buildDepsWithDeployments(
  store: ConfigStore,
  secretWriter: ConfigSecretWriter,
  deployments: ReadonlyArray<{ id: string; organizationId: string; state: 'HEALTHY' | 'INSTALLING' | 'NOT_INSTALLED' }>,
): ConfigDeps {
  const cipher = createCipherStub();
  return {
    store,
    secretWriter,
    cipher,
    pendingSecrets: {
      async upsertStaged() {},
      async upsertBound() {},
      async materializeForDeployment() {
        return [];
      },
      async listBoundForDeployment() {
        return [];
      },
      async deleteBoundForDeployment() {},
      async deleteStagedForScope() {},
      async sweepExpired() {
        return 0;
      },
      async stampDelivery() {},
    },
    async findScopeDeployments() {
      return deployments.map((d) => ({ id: d.id, organizationId: d.organizationId, state: d.state }));
    },
    async findApplicationOrganizationId() {
      return 'org-1';
    },
  };
}

// Todo 26 — application configuration API logic. The DB boundary
// (ConfigStore) and the §31 relay write-through (ConfigSecretWriter) are
// injectable seams, exercised here with in-memory mocks — no PGlite, no AWS.
// The load-bearing assertions are the secret boundary: the API NEVER returns
// a plaintext secret, and the control-plane store never persists one.

const APP_ID = 'app-1';
const CUSTOMER_ID = 'customer-1';

/** In-memory ConfigStore mock: rows keyed by `${scope}:${key}`. */
function createMockStore(input: {
  exists?: boolean;
  vendorDefaults?: readonly ConfigEntry[];
  overrides?: Record<string, readonly ConfigEntry[]>;
}): ConfigStore & {
  written: { customerId: string | null; entry: ConfigEntry }[];
  removedKeys: { customerId: string | null; key: string }[];
} {
  const written: { customerId: string | null; entry: ConfigEntry }[] = [];
  const removedKeys: { customerId: string | null; key: string }[] = [];
  const vendorRows = [...(input.vendorDefaults ?? [])];
  const overrideRows = new Map(Object.entries(input.overrides ?? {}));
  return {
    written,
    removedKeys,
    applicationExists: () => Promise.resolve(input.exists ?? true),
    list: (_applicationId, customerId) => {
      if (customerId === null) return Promise.resolve(vendorRows);
      return Promise.resolve(overrideRows.get(customerId) ?? []);
    },
    upsert: (_applicationId, customerId, entry) => {
      written.push({ customerId, entry });
      const rows = customerId === null ? vendorRows : undefined;
      if (rows) {
        const index = rows.findIndex((row) => row.key === entry.key);
        if (index >= 0) rows[index] = entry;
        else rows.push(entry);
      } else if (customerId !== null) {
        const scoped = overrideRows.get(customerId) ?? [];
        const index = scoped.findIndex((row) => row.key === entry.key);
        if (index >= 0) scoped[index] = entry;
        else scoped.push(entry);
        overrideRows.set(customerId, scoped);
      }
      return Promise.resolve();
    },
    remove: (_applicationId, customerId, key) => {
      removedKeys.push({ customerId, key });
      const rows = customerId === null ? vendorRows : overrideRows.get(customerId);
      if (rows) {
        const index = rows.findIndex((row) => row.key === key);
        if (index >= 0) rows.splice(index, 1);
      }
      return Promise.resolve();
    },
  };
}

function createMockWriter(): ConfigSecretWriter & {
  calls: { customerId: string; entries: readonly ConfigEntry[] }[];
  removed: { customerId: string; keys: readonly string[] }[];
} {
  const calls: { customerId: string; entries: readonly ConfigEntry[] }[] = [];
  const removed: { customerId: string; keys: readonly string[] }[] = [];
  return {
    calls,
    removed,
    writeSecrets: (_applicationId, customerId, entries) => {
      calls.push({ customerId, entries });
      return Promise.resolve();
    },
    removeSecrets: (_applicationId, customerId, keys) => {
      removed.push({ customerId, keys });
      return Promise.resolve();
    },
  };
}

const PLAINTEXT_SECRET = 'postgres://fixture-super-secret-password';

describe('config — secret masking (§31 write-only)', () => {
  it('toMaskedEntry strips the value of secret entries entirely', () => {
    expect(toMaskedEntry({ key: 'DATABASE_URL', value: PLAINTEXT_SECRET, isSecret: true })).toStrictEqual({
      key: 'DATABASE_URL',
      isSecret: true,
      value: null,
    });
  });

  it('toMaskedEntry keeps non-secret values readable', () => {
    expect(toMaskedEntry({ key: 'LOG_LEVEL', value: 'info', isSecret: false })).toStrictEqual({
      key: 'LOG_LEVEL',
      isSecret: false,
      value: 'info',
    });
  });

  it('getConfig never returns a plaintext secret — masked entries carry null', async () => {
    const store = createMockStore({
      vendorDefaults: [
        // Even if a row somehow held plaintext, the API boundary masks it.
        { key: 'DATABASE_URL', value: PLAINTEXT_SECRET, isSecret: true },
        { key: 'LOG_LEVEL', value: 'info', isSecret: false },
      ],
    });

    const view = await getConfig(APP_ID, null, store);

    const secret = view.effective.find((entry) => entry.key === 'DATABASE_URL');
    expect(secret).toMatchObject({ isSecret: true, value: null });
    expect(JSON.stringify(view)).not.toContain(PLAINTEXT_SECRET);
  });

  it('getConfig masks customer-override secrets too', async () => {
    const store = createMockStore({
      vendorDefaults: [{ key: 'LOG_LEVEL', value: 'info', isSecret: false }],
      overrides: {
        [CUSTOMER_ID]: [{ key: 'API_KEY', value: PLAINTEXT_SECRET, isSecret: true }],
      },
    });

    const view = await getConfig(APP_ID, CUSTOMER_ID, store);

    const override = view.customerOverrides.find((entry) => entry.key === 'API_KEY');
    expect(override).toMatchObject({ isSecret: true, value: null });
    expect(JSON.stringify(view)).not.toContain(PLAINTEXT_SECRET);
  });
});

describe('config — vendor defaults vs customer overrides (§31 precedence)', () => {
  const vendorDefaults: readonly ConfigEntry[] = [
    { key: 'DATABASE_URL', value: SECRET_MASK, isSecret: true },
    { key: 'LOG_LEVEL', value: 'info', isSecret: false },
    { key: 'MAX_CONNECTIONS', value: '10', isSecret: false },
  ];

  it('customer override wins over the vendor default with the same key', async () => {
    const store = createMockStore({
      vendorDefaults,
      overrides: { [CUSTOMER_ID]: [{ key: 'LOG_LEVEL', value: 'debug', isSecret: false }] },
    });

    const view = await getConfig(APP_ID, CUSTOMER_ID, store);

    const overridden = view.effective.find((entry) => entry.key === 'LOG_LEVEL');
    expect(overridden).toMatchObject({
      value: 'debug',
      source: 'customer',
      vendorValue: 'info',
    });
  });

  it('non-overridden keys keep the vendor default', async () => {
    const store = createMockStore({
      vendorDefaults,
      overrides: { [CUSTOMER_ID]: [{ key: 'LOG_LEVEL', value: 'debug', isSecret: false }] },
    });

    const view = await getConfig(APP_ID, CUSTOMER_ID, store);

    const plain = view.effective.find((entry) => entry.key === 'MAX_CONNECTIONS');
    expect(plain).toMatchObject({ value: '10', source: 'vendor', vendorValue: null });
  });

  it('customer-only keys appear in the effective config', async () => {
    const store = createMockStore({
      vendorDefaults,
      overrides: { [CUSTOMER_ID]: [{ key: 'API_KEY', value: SECRET_MASK, isSecret: true }] },
    });

    const view = await getConfig(APP_ID, CUSTOMER_ID, store);

    const customerOnly = view.effective.find((entry) => entry.key === 'API_KEY');
    expect(customerOnly).toMatchObject({ source: 'customer', isSecret: true, value: null });
  });

  it('without a customer scope the effective config is the vendor defaults', async () => {
    const store = createMockStore({
      vendorDefaults,
      overrides: { [CUSTOMER_ID]: [{ key: 'LOG_LEVEL', value: 'debug', isSecret: false }] },
    });

    const view = await getConfig(APP_ID, null, store);

    expect(view.customerOverrides).toEqual([]);
    const logLevel = view.effective.find((entry) => entry.key === 'LOG_LEVEL');
    expect(logLevel).toMatchObject({ value: 'info', source: 'vendor' });
  });

  it('mergeConfigEntries is stable-ordered: vendor order first, then customer-only keys', () => {
    const merged = mergeConfigEntries(
      [
        { key: 'A', value: '1', isSecret: false },
        { key: 'B', value: '2', isSecret: false },
      ],
      [
        { key: 'B', value: 'override', isSecret: false },
        { key: 'C', value: '3', isSecret: false },
      ],
    );
    expect(merged.map((entry) => entry.key)).toEqual(['A', 'B', 'C']);
    expect(merged[1]).toMatchObject({ value: 'override', source: 'customer', vendorValue: '2' });
  });
});

describe('config — unknown application', () => {
  it('getConfig throws a 404 NotFoundError', async () => {
    const store = createMockStore({ exists: false });
    await expect(getConfig('no-such-app', null, store)).rejects.toMatchObject({
      name: 'NotFoundError',
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  });

  it('setConfig throws a 404 NotFoundError before writing anything', async () => {
    const store = createMockStore({ exists: false });
    const secretWriter = createMockWriter();
    await expect(
      setConfig('no-such-app', null, [{ key: 'LOG_LEVEL', value: 'debug', isSecret: false }], buildDeps(store, secretWriter)),
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    expect(store.written).toEqual([]);
    expect(secretWriter.calls).toEqual([]);
  });
});

describe('config — setConfig writes', () => {
  it('writes non-secret entries to the store in plaintext', async () => {
    const store = createMockStore({ vendorDefaults: [] });
    const secretWriter = createMockWriter();

    const view = await setConfig(
      APP_ID,
      null,
      [{ key: 'LOG_LEVEL', value: 'debug', isSecret: false }],
      buildDeps(store, secretWriter),
    );

    expect(store.written).toEqual([
      { customerId: null, entry: { key: 'LOG_LEVEL', value: 'debug', isSecret: false, encryptedValue: null } },
    ]);
    expect(secretWriter.calls).toEqual([]);
    expect(view.effective.find((entry) => entry.key === 'LOG_LEVEL')).toMatchObject({
      value: 'debug',
    });
  });

  it('§31 write-through: secrets go via the relay; the DB stores only the mask', async () => {
    const store = createMockStore({ vendorDefaults: [] });
    const secretWriter = createMockWriter();

    const view = await setConfig(
      APP_ID,
      CUSTOMER_ID,
      [{ key: 'DATABASE_URL', value: PLAINTEXT_SECRET, isSecret: true }],
      buildDeps(store, secretWriter),
    );

    // The relay seam receives the plaintext (it writes the customer's
    // Secrets Manager)…
    expect(secretWriter.calls).toEqual([
      { customerId: CUSTOMER_ID, entries: [{ key: 'DATABASE_URL', value: PLAINTEXT_SECRET, isSecret: true }] },
    ]);
    // …but the control-plane DB stores ONLY the mask — a CUSTOMER-scope
    // secret never gets an application_configs ciphertext; it travels
    // through the pending-secret vault instead (DEPLOY-027)…
    expect(store.written).toHaveLength(1);
    expect(store.written[0]).toMatchObject({
      customerId: CUSTOMER_ID,
      entry: { key: 'DATABASE_URL', value: SECRET_MASK, isSecret: true, encryptedValue: null },
    });
    expect(JSON.stringify(store.written)).not.toContain(PLAINTEXT_SECRET);
    // …and the API response never carries the plaintext.
    expect(JSON.stringify(view)).not.toContain(PLAINTEXT_SECRET);
    expect(view.effective.find((entry) => entry.key === 'DATABASE_URL')).toMatchObject({
      isSecret: true,
      value: null,
    });
  });

  it('binds the secret to a deployment whose install is still running, besides the direct write', async () => {
    // The relay is connected but the application stack may not exist yet, so
    // the direct CONFIG_UPDATE can fail and lose the value (Hovod, Stage B
    // sprint: S3 keys delivered mid-install never reached the task). The
    // bound row is delivered by the install-time config fetch.
    const store = createMockStore({ vendorDefaults: [] });
    const secretWriter = createMockWriter();
    const deps = buildDepsWithDeployments(store, secretWriter, [
      { id: 'deployment-1', organizationId: 'org-1', state: 'INSTALLING' },
    ]);
    const bound: { deploymentId: string; key: string }[] = [];
    deps.pendingSecrets.upsertBound = async (input) => {
      bound.push({ deploymentId: input.deploymentId, key: input.key });
    };

    await setConfig(APP_ID, CUSTOMER_ID, [{ key: 'S3_SECRET_ACCESS_KEY', value: PLAINTEXT_SECRET, isSecret: true }], deps);

    expect(bound).toEqual([{ deploymentId: 'deployment-1', key: 'S3_SECRET_ACCESS_KEY' }]);
    expect(secretWriter.calls).toHaveLength(1);
  });

  it('does not bind a secret to a healthy deployment', async () => {
    const store = createMockStore({ vendorDefaults: [] });
    const deps = buildDeps(store, createMockWriter());
    const bound: string[] = [];
    deps.pendingSecrets.upsertBound = async (input) => {
      bound.push(input.key);
    };

    await setConfig(APP_ID, CUSTOMER_ID, [{ key: 'DATABASE_URL', value: PLAINTEXT_SECRET, isSecret: true }], deps);

    expect(bound).toEqual([]);
  });

  it('vendor-scope secrets persist as masked placeholders with NO relay write', async () => {
    const store = createMockStore({ vendorDefaults: [] });
    const secretWriter = createMockWriter();

    await setConfig(
      APP_ID,
      null,
      [{ key: 'DATABASE_URL', value: PLAINTEXT_SECRET, isSecret: true }],
      buildDeps(store, secretWriter),
    );

    // No customer account exists for vendor defaults — nothing to write to.
    expect(secretWriter.calls).toEqual([]);
    expect(store.written).toHaveLength(1);
    expect(store.written[0]).toMatchObject({
      customerId: null,
      entry: { key: 'DATABASE_URL', value: SECRET_MASK, isSecret: true },
    });
    // A vendor-scope secret is encrypted with the SecretCipher (secure
    // storage) — this is exactly what makes it deliverable later, unlike
    // before. The stub's format is `enc:<context hash>:<body>`.
    expect(store.written[0]?.entry.encryptedValue).toMatch(/^enc:/);
    expect(JSON.stringify(store.written)).not.toContain(PLAINTEXT_SECRET);
  });

  it('untouched secrets (empty value) are excluded from the write-through and never re-written', async () => {
    const store = createMockStore({
      vendorDefaults: [],
      overrides: { [CUSTOMER_ID]: [{ key: 'DATABASE_URL', value: SECRET_MASK, isSecret: true }] },
    });
    const secretWriter = createMockWriter();

    await setConfig(
      APP_ID,
      CUSTOMER_ID,
      [
        { key: 'DATABASE_URL', value: '', isSecret: true },
        { key: 'LOG_LEVEL', value: 'debug', isSecret: false },
      ],
      buildDeps(store, secretWriter),
    );

    // The changed plain value rides the write-through (a plain-only save
    // must still reach the running deployment); the untouched secret does not.
    expect(secretWriter.calls).toEqual([
      {
        customerId: CUSTOMER_ID,
        entries: [{ key: 'LOG_LEVEL', value: 'debug', isSecret: false }],
      },
    ]);
    expect(store.written).toEqual([
      { customerId: CUSTOMER_ID, entry: { key: 'LOG_LEVEL', value: 'debug', isSecret: false, encryptedValue: null } },
    ]);
  });

  it('a failed relay write aborts before any DB write (all-or-nothing)', async () => {
    const store = createMockStore({ vendorDefaults: [] });
    const secretWriter: ConfigSecretWriter = {
      writeSecrets: () => Promise.reject(new Error('relay unreachable')),
    };

    await expect(
      setConfig(
        APP_ID,
        CUSTOMER_ID,
        [
          { key: 'DATABASE_URL', value: PLAINTEXT_SECRET, isSecret: true },
          { key: 'LOG_LEVEL', value: 'debug', isSecret: false },
        ],
        buildDeps(store, secretWriter),
      ),
    ).rejects.toMatchObject({ statusCode: 502, code: 'CONFIG_WRITE_FAILED' });
    expect(store.written).toEqual([]);
  });
});

describe('config — a vendor default reaches running deployments', () => {
  it('sends each configurable customer one update, with no vendor secret value, and removes only keys without an override', async () => {
    const store = createMockStore({
      vendorDefaults: [{ key: 'LOG_LEVEL', value: 'info', isSecret: false }],
      overrides: { 'customer-b': [{ key: 'LOG_LEVEL', value: 'debug', isSecret: false }] },
    });
    const writer = createMockWriter();
    const deps: ConfigDeps = {
      ...buildDeps(store, writer),
      findConfigurableCustomers: async () => ['customer-a', 'customer-b'],
    };

    await setConfig(
      APP_ID,
      null,
      [
        { key: 'FEATURE_FLAG', value: 'on', isSecret: false },
        { key: 'STRIPE_SECRET_KEY', value: 'sk_live_vendor_only', isSecret: true },
      ],
      deps,
      ['LOG_LEVEL'],
    );

    expect(writer.calls.map((call) => call.customerId)).toEqual(['customer-a', 'customer-b']);
    for (const call of writer.calls) {
      expect(call.entries).toEqual([
        { key: 'FEATURE_FLAG', value: 'on', isSecret: false },
        { key: 'STRIPE_SECRET_KEY', value: '', isSecret: true },
      ]);
    }
    expect(JSON.stringify(writer.calls)).not.toContain('sk_live_vendor_only');
    // customer-b overrides LOG_LEVEL, so the removed default leaves its value alone.
    expect(writer.removed).toEqual([{ customerId: 'customer-a', keys: ['LOG_LEVEL'] }]);
  });

  it('reaches no deployment without the configurable-customers seam (new installations only)', async () => {
    const writer = createMockWriter();
    await setConfig(APP_ID, null, [{ key: 'FEATURE_FLAG', value: 'on', isSecret: false }], buildDeps(createMockStore({}), writer));
    expect(writer.calls).toEqual([]);
  });
});

describe('config — write validation', () => {
  it('rejects duplicate keys within one write', async () => {
    const store = createMockStore({});
    const secretWriter = createMockWriter();
    await expect(
      setConfig(
        APP_ID,
        null,
        [
          { key: 'LOG_LEVEL', value: 'info', isSecret: false },
          { key: 'LOG_LEVEL', value: 'debug', isSecret: false },
        ],
        buildDeps(store, secretWriter),
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_CONFIG' });
    expect(store.written).toEqual([]);
  });

  it('rejects empty keys', async () => {
    const store = createMockStore({});
    const secretWriter = createMockWriter();
    await expect(
      setConfig(APP_ID, null, [{ key: '', value: 'x', isSecret: false }], buildDeps(store, secretWriter)),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_CONFIG' });
  });

  it('rejects ApiError subclasses carry the structured-envelope fields', async () => {
    const store = createMockStore({});
    const secretWriter = createMockWriter();
    const failure = await setConfig(
      APP_ID,
      null,
      [{ key: '', value: 'x', isSecret: false }],
      buildDeps(store, secretWriter),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
  });
});

describe('config — request body schema (route boundary)', () => {
  it('accepts a well-formed write body', () => {
    const parsed = setConfigBodySchema.parse({
      customerId: CUSTOMER_ID,
      entries: [{ key: 'DATABASE_URL', value: PLAINTEXT_SECRET, isSecret: true }],
    });
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.customerId).toBe(CUSTOMER_ID);
  });

  it('accepts an absent customerId (vendor-default write)', () => {
    const parsed = setConfigBodySchema.parse({
      entries: [{ key: 'LOG_LEVEL', value: 'info', isSecret: false }],
    });
    expect(parsed.customerId).toBeUndefined();
  });

  it('rejects entries with empty keys, missing values, or non-boolean isSecret', () => {
    expect(() =>
      setConfigBodySchema.parse({ entries: [{ key: '', value: 'x', isSecret: false }] }),
    ).toThrow();
    expect(() =>
      setConfigBodySchema.parse({ entries: [{ key: 'A', isSecret: false }] }),
    ).toThrow();
    expect(() =>
      setConfigBodySchema.parse({ entries: [{ key: 'A', value: 'x', isSecret: 'yes' }] }),
    ).toThrow();
  });
});

// ── Removal (§31) ─────────────────────────────────────────────────────────

describe('config — removing a value', () => {
  // There was no delete path at all: not in the UI, and not by omitting an
  // entry, because setConfig only ever upserted what it was given. A mistyped
  // key was permanent and kept being injected into every deployment.
  it('removes a vendor default', async () => {
    const store = createMockStore({
      vendorDefaults: [
        { key: 'LOG_LEVEL', value: 'debug', isSecret: false },
        { key: 'DATABSE_URL', value: 'oops', isSecret: false },
      ],
    });
    const view = await setConfig(APP_ID, null, [], buildDeps(store, createMockWriter()), [
      'DATABSE_URL',
    ]);

    expect(store.removedKeys).toEqual([{ customerId: null, key: 'DATABSE_URL' }]);
    expect(view.vendorDefaults.map((entry) => entry.key)).toEqual(['LOG_LEVEL']);
  });

  it("removes a customer's secret from their own secret store too", async () => {
    const store = createMockStore({
      overrides: { [CUSTOMER_ID]: [{ key: 'API_TOKEN', value: SECRET_MASK, isSecret: true }] },
    });
    const writer = createMockWriter();
    await setConfig(APP_ID, CUSTOMER_ID, [], buildDeps(store, writer), ['API_TOKEN']);

    // The control plane never held the plaintext, so the relay is the only
    // thing that can remove it from the customer's account.
    expect(writer.removed).toEqual([{ customerId: CUSTOMER_ID, keys: ['API_TOKEN'] }]);
    expect(store.removedKeys).toEqual([{ customerId: CUSTOMER_ID, key: 'API_TOKEN' }]);
  });

  it('refuses to set and remove the same key in one save', async () => {
    const store = createMockStore({ vendorDefaults: [{ key: 'LOG_LEVEL', value: 'debug', isSecret: false }] });
    await expect(
      setConfig(
        APP_ID,
        null,
        [{ key: 'LOG_LEVEL', value: 'info', isSecret: false }],
        buildDeps(store, createMockWriter()),
        ['LOG_LEVEL'],
      ),
    ).rejects.toMatchObject({ code: 'CONFIG_CONFLICTING_WRITE' });
  });

  it('accepts deletes through the request body schema', () => {
    const parsed = setConfigBodySchema.parse({ customerId: null, entries: [], deletes: ['OLD_KEY'] });
    expect(parsed.deletes).toEqual(['OLD_KEY']);
  });
});

describe('config — needsReentry (legacy vendor secrets with no ciphertext)', () => {
  it('toMaskedEntry flags a vendor-scope secret with no encryptedValue as needsReentry', () => {
    expect(toMaskedEntry({ key: 'API_KEY', value: SECRET_MASK, isSecret: true }, true)).toStrictEqual({
      key: 'API_KEY',
      isSecret: true,
      value: null,
      needsReentry: true,
    });
  });

  it('a vendor-scope secret WITH an encryptedValue is not flagged', () => {
    expect(
      toMaskedEntry({ key: 'API_KEY', value: SECRET_MASK, isSecret: true, encryptedValue: 'v1:a:b:c' }, true),
    ).toStrictEqual({ key: 'API_KEY', isSecret: true, value: null });
  });

  it('the same masked row scoped as a customer override is never flagged', () => {
    expect(toMaskedEntry({ key: 'API_KEY', value: SECRET_MASK, isSecret: true }, false)).toStrictEqual({
      key: 'API_KEY',
      isSecret: true,
      value: null,
    });
  });

  it('a generated secret is never flagged even without ciphertext', () => {
    expect(toMaskedEntry({ key: 'JWT_SECRET', value: GENERATED_SECRET_MASK, isSecret: true }, true)).toStrictEqual({
      key: 'JWT_SECRET',
      isSecret: true,
      value: null,
      generated: true,
    });
  });

  it('getConfig surfaces needsReentry on the vendor-defaults view, not on the effective merge for a customer override', async () => {
    const store = createMockStore({
      vendorDefaults: [{ key: 'API_KEY', value: SECRET_MASK, isSecret: true }],
    });
    const view = await getConfig(APP_ID, null, store);
    expect(view.vendorDefaults.find((entry) => entry.key === 'API_KEY')).toMatchObject({ needsReentry: true });
  });
});

describe('config — relay write-through queue message', () => {
  it('carries entered secret VALUES transiently and keys for plain changes', async () => {
    const enqueueMock = vi.mocked(enqueue);
    enqueueMock.mockResolvedValue(true);
    const writer = createRelaySecretWriter({} as never);
    await writer.writeSecrets(APP_ID, CUSTOMER_ID, [
      { key: 'DATABASE_URL', value: 'postgres://fresh-secret', isSecret: true },
      { key: 'LOG_LEVEL', value: 'debug', isSecret: false },
      { key: 'TOUCHED_NOT_SECRET', value: '', isSecret: true },
    ]);

    expect(enqueueMock).toHaveBeenCalledWith({
      type: 'CONFIG_UPDATE',
      customerId: CUSTOMER_ID,
      applicationId: APP_ID,
      changedKeys: ['DATABASE_URL', 'LOG_LEVEL', 'TOUCHED_NOT_SECRET'],
      secrets: [{ key: 'DATABASE_URL', value: 'postgres://fresh-secret' }],
    });
  });
});

// ── DB-backed: secure storage roundtrip through the real store (§31) ───────
//
// Everything above exercises the pure logic with in-memory mocks. These
// tests go through createConfigStore/createConfigDeps against a real
// (PGlite) schema so the encrypted_value column, listProvidedConfigKeys's
// legacy-secret exclusion, and the decrypting reader (listVendorValues) are
// proven against the actual persisted rows, not a mock's approximation of
// them. Only VENDOR-scope secrets populate encrypted_value — CUSTOMER-scope
// secrets travel through the pending-secret vault (see
// pending-secret-delivery.integration.test.ts), so this suite writes vendor
// defaults only.
describe('config — secure storage against a real store', () => {
  let client: PGlite | undefined;
  let db: Db;
  let applicationId: string;
  let customerId: string;
  let deps: ConfigDeps;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    await db.insert(schema.organization).values({ id: 'org-config-crypto', name: 'Acme', slug: 'org-config-crypto' });
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId: 'org-config-crypto',
        name: 'shop',
        repoFullName: 'acme/shop',
        repoUrl: 'https://github.com/acme/shop',
      })
      .returning();
    applicationId = application!.id;
    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId: 'org-config-crypto', name: 'Buyer', email: 'buyer@example.com' })
      .returning();
    customerId = customer!.id;
    const cipher = createCipherStub();
    deps = createConfigDeps(db, createDrizzlePendingSecretStore(db, cipher), cipher);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('without a queue, creates the CONFIG_UPDATE job inline for each deployment a relay can act on', async () => {
    vi.mocked(enqueue).mockResolvedValue(false);
    const [installed] = await db
      .insert(schema.deployments)
      .values({ organizationId: 'org-config-crypto', applicationId, customerId, region: 'us-east-1', state: 'HEALTHY', enrollmentCode: crypto.randomUUID() })
      .returning();
    await db
      .insert(schema.deployments)
      .values({ organizationId: 'org-config-crypto', applicationId, customerId, region: 'us-east-1', state: 'NOT_INSTALLED', enrollmentCode: crypto.randomUUID() });

    await createRelaySecretWriter(db).writeSecrets(applicationId, customerId, [
      { key: 'API_KEY', value: 'fresh-secret', isSecret: true },
    ]);

    const jobs = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.type, 'CONFIG_UPDATE'));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      deploymentId: installed!.id,
      state: 'REQUESTED',
      payload: { changedKeys: ['API_KEY'], secrets: [{ key: 'API_KEY', value: 'fresh-secret' }] },
    });
  });

  it('setConfig -> createConfigStore round-trips a vendor secret through real ciphertext', async () => {
    await setConfig(applicationId, null, [{ key: 'STRIPE_KEY', value: 'sk_live_real_secret', isSecret: true }], deps);

    const rows = await db
      .select()
      .from(schema.applicationConfigs)
      .where(eqAppKey(applicationId, 'STRIPE_KEY'));
    expect(rows[0]?.value).toBe(SECRET_MASK);
    expect(rows[0]?.encryptedValue).toMatch(/^enc:/);
    expect(rows[0]?.encryptedValue).not.toContain('sk_live_real_secret');

    const values = await listVendorValues(db, applicationId, ['STRIPE_KEY'], deps.cipher);
    expect(values).toEqual({ STRIPE_KEY: 'sk_live_real_secret' });
  });

  it('listProvidedConfigKeys excludes a legacy vendor secret row with no ciphertext', async () => {
    await db.insert(schema.applicationConfigs).values({
      applicationId,
      customerId: null,
      key: 'LEGACY_SECRET',
      value: SECRET_MASK,
      isSecret: true,
      encryptedValue: null,
    });

    const keys = await listProvidedConfigKeys(db, applicationId, null);
    expect(keys).not.toContain('LEGACY_SECRET');
  });

  describe('customer-scope masked secret rows', () => {
    const KEY = 'MONITOR_TOKEN';
    let freshCustomerId: string;

    beforeAll(async () => {
      const [customer] = await db
        .insert(schema.customers)
        .values({ organizationId: 'org-config-crypto', name: 'Stale', email: 'stale@example.com' })
        .returning();
      freshCustomerId = customer!.id;
      await deps.cipher.encrypt('vendor-token', { organizationId: 'org-config-crypto', applicationId, key: KEY, scope: 'vendor' }).then(
        ({ ciphertext }) =>
          db.insert(schema.applicationConfigs).values({
            applicationId,
            customerId: null,
            key: KEY,
            value: SECRET_MASK,
            isSecret: true,
            encryptedValue: ciphertext,
          }),
      );
      await db
        .insert(schema.applicationConfigs)
        .values({ applicationId, customerId: freshCustomerId, key: KEY, value: SECRET_MASK, isSecret: true });
    });

    it('a stale row with no vault value and no configured deployment is not provided, even with a vendor value', async () => {
      expect(await listProvidedConfigKeys(db, applicationId, freshCustomerId)).not.toContain(KEY);
      expect(await listProvidedConfigKeys(db, applicationId, null)).toContain(KEY);
    });

    it('is provided again once the customer re-enters it (unexpired pending row)', async () => {
      await createDrizzlePendingSecretStore(db, deps.cipher).upsertStaged({
        organizationId: 'org-config-crypto',
        applicationId,
        customerId: freshCustomerId,
        key: KEY,
        ciphertext: 'enc:x',
        encryptionContext: {},
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: null,
      });
      expect(await listProvidedConfigKeys(db, applicationId, freshCustomerId)).toContain(KEY);
    });

    it('counts a key only for the deployment whose finished configuration update named it', async () => {
      const [other] = await db
        .insert(schema.customers)
        .values({ organizationId: 'org-config-crypto', name: 'Held', email: 'held@example.com' })
        .returning();
      await db
        .insert(schema.applicationConfigs)
        .values({ applicationId, customerId: other!.id, key: KEY, value: SECRET_MASK, isSecret: true });
      const makeDeployment = async (state: 'HEALTHY' | 'NOT_INSTALLED') =>
        (
          await db
            .insert(schema.deployments)
            .values({ organizationId: 'org-config-crypto', applicationId, customerId: other!.id, region: 'us-east-1', state, enrollmentCode: crypto.randomUUID() })
            .returning()
        )[0]!;
      const a = await makeDeployment('HEALTHY');
      const b = await makeDeployment('NOT_INSTALLED');
      const addJob = (deploymentId: string, payload: Record<string, unknown>) =>
        db.insert(schema.deploymentJobs).values({
          deploymentId,
          type: 'CONFIG_UPDATE',
          state: 'SUCCEEDED',
          idempotencyKey: `held-${crypto.randomUUID()}`,
          payload,
        });
      await addJob(a.id, { secrets: [{ key: KEY }] });
      expect(await listProvidedConfigKeys(db, applicationId, other!.id, null, a.id)).toContain(KEY);
      expect(await listProvidedConfigKeys(db, applicationId, other!.id, null, b.id)).not.toContain(KEY);
      expect(await listProvidedConfigKeys(db, applicationId, other!.id)).not.toContain(KEY);

      const K2 = 'LATER_TOKEN';
      await db
        .insert(schema.applicationConfigs)
        .values({ applicationId, customerId: other!.id, key: K2, value: SECRET_MASK, isSecret: true });
      expect(await listProvidedConfigKeys(db, applicationId, other!.id, null, a.id)).not.toContain(K2);

      await addJob(a.id, { changedKeys: [K2] });
      expect(await listProvidedConfigKeys(db, applicationId, other!.id, null, a.id)).toContain(K2);
    });

    it('does not reach another deployment through a bound pending row', async () => {
      const [other] = await db
        .insert(schema.customers)
        .values({ organizationId: 'org-config-crypto', name: 'Bound', email: 'bound@example.com' })
        .returning();
      await db
        .insert(schema.applicationConfigs)
        .values({ applicationId, customerId: other!.id, key: KEY, value: SECRET_MASK, isSecret: true });
      const [a, b] = await db
        .insert(schema.deployments)
        .values(
          [0, 1].map(() => ({ organizationId: 'org-config-crypto', applicationId, customerId: other!.id, region: 'us-east-1', state: 'NOT_INSTALLED' as const, enrollmentCode: crypto.randomUUID() })),
        )
        .returning();
      await createDrizzlePendingSecretStore(db, deps.cipher).upsertBound({
        organizationId: 'org-config-crypto',
        applicationId,
        deploymentId: a!.id,
        key: KEY,
        ciphertext: 'enc:x',
        encryptionContext: {},
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect(await listProvidedConfigKeys(db, applicationId, other!.id, null, a!.id)).toContain(KEY);
      expect(await listProvidedConfigKeys(db, applicationId, other!.id, null, b!.id)).not.toContain(KEY);
    });
  });

  it('listVendorValues skips a legacy secret with no ciphertext and returns plain values untouched', async () => {
    await db.insert(schema.applicationConfigs).values([
      { applicationId, customerId: null, key: 'PLAIN_BUILD_VAR', value: 'plain', isSecret: false },
      {
        applicationId,
        customerId: null,
        key: 'UNDELIVERABLE_SECRET',
        value: SECRET_MASK,
        isSecret: true,
        encryptedValue: null,
      },
    ]);

    const values = await listVendorValues(db, applicationId, ['PLAIN_BUILD_VAR', 'UNDELIVERABLE_SECRET'], deps.cipher);
    expect(values).toEqual({ PLAIN_BUILD_VAR: 'plain' });
  });
});

function eqAppKey(applicationId: string, key: string) {
  return and(eq(schema.applicationConfigs.applicationId, applicationId), eq(schema.applicationConfigs.key, key));
}

describe('config — pre-relay removals and delivery rules against a real store', () => {
  let client: PGlite | undefined;
  let db: Db;
  let applicationId: string;
  let customerId: string;
  let deploymentId: string;
  let deps: ConfigDeps;
  let pendingSecrets: ReturnType<typeof createDrizzlePendingSecretStore>;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    await db.insert(schema.organization).values({ id: 'org-config-prerelay', name: 'Acme', slug: 'org-config-prerelay' });
    const [application] = await db
      .insert(schema.applications)
      .values({ organizationId: 'org-config-prerelay', name: 'shop', repoFullName: 'acme/prerelay', repoUrl: 'https://github.com/acme/prerelay' })
      .returning();
    applicationId = application!.id;
    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId: 'org-config-prerelay', name: 'Buyer', email: 'buyer@example.com' })
      .returning();
    customerId = customer!.id;
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId: 'org-config-prerelay',
        applicationId,
        customerId,
        region: 'us-east-1',
        state: 'WAITING_FOR_RELAY',
        enrollmentCode: 'enrol-prerelay',
      })
      .returning();
    deploymentId = deployment!.id;
    const cipher = createCipherStub();
    pendingSecrets = createDrizzlePendingSecretStore(db, cipher);
    deps = createConfigDeps(db, pendingSecrets, cipher);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('removing one customer secret before the relay connects keeps the other pending secrets', async () => {
    await setConfig(
      applicationId,
      customerId,
      [
        { key: 'LICENSE_KEY', value: 'license-a', isSecret: true },
        { key: 'SMTP_PASS', value: 'smtp-a', isSecret: true },
      ],
      deps,
    );
    expect((await pendingSecrets.listBoundForDeployment(deploymentId)).map((row) => row.key).sort()).toEqual([
      'LICENSE_KEY',
      'SMTP_PASS',
    ]);

    await setConfig(applicationId, customerId, [], deps, ['SMTP_PASS']);

    expect((await pendingSecrets.listBoundForDeployment(deploymentId)).map((row) => row.key)).toEqual(['LICENSE_KEY']);
  });

  it('finds only customers whose deployment a connected relay can configure now', async () => {
    const finder = createConfigurableCustomersFinder(db);
    // The only deployment so far waits for its relay.
    expect(await finder(applicationId)).toEqual([]);
    const customers = await db
      .insert(schema.customers)
      .values([
        { organizationId: 'org-config-prerelay', name: 'Healthy', email: 'healthy@example.com' },
        { organizationId: 'org-config-prerelay', name: 'Disconnected', email: 'disconnected@example.com' },
      ])
      .returning();
    await db.insert(schema.deployments).values([
      { organizationId: 'org-config-prerelay', applicationId, customerId: customers[0]!.id, region: 'us-east-1', state: 'HEALTHY', relayStatus: 'CONNECTED', enrollmentCode: 'enrol-healthy' },
      { organizationId: 'org-config-prerelay', applicationId, customerId: customers[1]!.id, region: 'us-east-1', state: 'HEALTHY', relayStatus: 'DISCONNECTED', enrollmentCode: 'enrol-disconnected' },
    ]);
    expect(await finder(applicationId)).toEqual([customers[0]!.id]);
  });

  it('counts a saved value as provided only when its source still supplies the key', async () => {
    await db.insert(schema.applicationConfigs).values([
      { applicationId, customerId: null, key: 'API_URL', value: 'https://stale.example.com', isSecret: false },
      { applicationId, customerId: null, key: 'LOG_LEVEL', value: 'info', isSecret: false },
    ]);
    const settings = [
      { key: 'API_URL', stage: 'runtime' as const, required: true, secret: false, provider: 'customer' as const },
      { key: 'LOG_LEVEL', stage: 'runtime' as const, required: false, secret: false, provider: 'vendor' as const },
    ];
    const keys = await listProvidedConfigKeys(db, applicationId, customerId, settings);
    expect(keys).toContain('LOG_LEVEL');
    expect(keys).not.toContain('API_URL');
    expect(await listProvidedConfigKeys(db, applicationId, customerId)).toContain('API_URL');
  });
});

describe('config — a removed deployment does not take a new install’s secret', () => {
  let client: PGlite | undefined;
  let db: Db;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('stages the secret for the next deployment when the customer only has removed ones', async () => {
    await db.insert(schema.organization).values({ id: 'org-config-removed', name: 'Acme', slug: 'org-config-removed' });
    const [application] = await db
      .insert(schema.applications)
      .values({ organizationId: 'org-config-removed', name: 'shop', repoFullName: 'acme/removed', repoUrl: 'https://github.com/acme/removed' })
      .returning();
    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId: 'org-config-removed', name: 'Buyer', email: 'buyer-removed@example.com' })
      .returning();
    const [removed] = await db
      .insert(schema.deployments)
      .values({
        organizationId: 'org-config-removed',
        applicationId: application!.id,
        customerId: customer!.id,
        region: 'us-east-1',
        state: 'DELETED',
        enrollmentCode: 'enrol-removed',
      })
      .returning();
    const cipher = createCipherStub();
    const deps = createConfigDeps(db, createDrizzlePendingSecretStore(db, cipher), cipher);

    await setConfig(application!.id, customer!.id, [{ key: 'ADMIN_PASSWORD', value: 'a-test-value', isSecret: true }], deps);

    const rows = await db
      .select()
      .from(schema.pendingSecrets)
      .where(eq(schema.pendingSecrets.applicationId, application!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'ADMIN_PASSWORD', customerId: customer!.id, deploymentId: null });
    expect(rows.some((row) => row.deploymentId === removed!.id)).toBe(false);
  });
});
