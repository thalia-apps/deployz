import { z } from 'zod';

import type { DeploymentManifest, ManifestEnvBinding, ManifestEnvVariable } from './manifest.js';

// ---------------------------------------------------------------------------
// Vendor decisions for how each detected env var gets its value
// (docs/environment-variables.md). Stored per application as a nullable jsonb
// array (`applications.environment_settings`). Pure, no DB/AWS access — the
// schema validates a single setting; `evaluateEnvironmentSetup` combines
// saved settings with detector output (`packages/analysis`) into the rows
// the web config page and the API preflight both read.
// ---------------------------------------------------------------------------

export const environmentProviderSchema = z.enum(['deployz', 'vendor', 'customer', 'none']);
export type EnvironmentProvider = z.infer<typeof environmentProviderSchema>;

export const environmentStageSchema = z.enum(['build', 'runtime']);
export type EnvironmentStage = z.infer<typeof environmentStageSchema>;

/** The managed values a vendor can map an application variable to, per resource. */
export const ENVIRONMENT_BINDING_KINDS = {
  database: ['url', 'host', 'port', 'database', 'username', 'password', 'jdbc_url'],
  cache: ['url', 'host', 'port'],
  storage: ['bucket'],
} as const;

export const environmentBindingSchema = z
  .object({
    resource: z.enum(['database', 'cache', 'storage']),
    kind: z.enum(['url', 'host', 'port', 'bucket', 'database', 'username', 'password', 'jdbc_url']),
  })
  .strict();
export type EnvironmentBinding = z.infer<typeof environmentBindingSchema>;

export const environmentSettingSchema = z
  .object({
    key: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .max(128),
    stage: environmentStageSchema,
    required: z.boolean(),
    secret: z.boolean(),
    provider: environmentProviderSchema,
    /** Customer-facing, only meaningful for provider 'customer'. */
    label: z.string().trim().max(80).optional(),
    /** Customer-facing, only meaningful for provider 'customer'. */
    help: z.string().trim().max(300).optional(),
    /**
     * Maps the variable to a managed value (for example the database URL).
     * Only for provider 'deployz' at runtime. The key may be a name that
     * analysis did not detect.
     */
    binding: environmentBindingSchema.optional(),
  })
  .strict();
export type EnvironmentSetting = z.infer<typeof environmentSettingSchema>;

/**
 * The keys a vendor may set `provider: 'deployz'` for: the analysis
 * classified them `deployz_managed`/`deployz_generated`, or they are a
 * mintable internal secret (`secret && purpose === 'internal_secret'`).
 */
export function deployzProvidableKeys(variables: readonly ManifestEnvVariable[]): Set<string> {
  const keys = new Set<string>();
  for (const variable of variables) {
    const managed =
      variable.classification === 'deployz_managed' || variable.classification === 'deployz_generated';
    const mintable = variable.secret && variable.purpose === 'internal_secret';
    if (managed || mintable) {
      keys.add(variable.key);
    }
  }
  return keys;
}

export const environmentSettingsSchema = z
  .array(environmentSettingSchema)
  .max(1000)
  .superRefine((settings, ctx) => {
    const seen = new Set<string>();
    settings.forEach((setting, index) => {
      if (seen.has(setting.key)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate key "${setting.key}".`,
          path: [index, 'key'],
        });
      }
      seen.add(setting.key);

      if (setting.provider === 'customer' && setting.stage === 'build') {
        ctx.addIssue({
          code: 'custom',
          message: 'A customer cannot provide a build-stage value.',
          path: [index, 'provider'],
        });
      }
      if (setting.provider === 'deployz' && setting.stage === 'build') {
        ctx.addIssue({
          code: 'custom',
          message: 'Deployz cannot provide a build-stage value.',
          path: [index, 'provider'],
        });
      }
      if (setting.binding) {
        if (setting.provider !== 'deployz' || setting.stage !== 'runtime') {
          ctx.addIssue({
            code: 'custom',
            message: 'A managed value is only for a runtime setting that Deployz provides.',
            path: [index, 'binding'],
          });
        } else if (
          !(ENVIRONMENT_BINDING_KINDS[setting.binding.resource] as readonly string[]).includes(setting.binding.kind)
        ) {
          ctx.addIssue({
            code: 'custom',
            message: `A ${setting.binding.resource} has no "${setting.binding.kind}" value.`,
            path: [index, 'binding', 'kind'],
          });
        }
      }
      if (setting.provider === 'none' && setting.required) {
        ctx.addIssue({
          code: 'custom',
          message: 'An optional setting cannot be required.',
          path: [index, 'required'],
        });
      }
    });
  });
export type EnvironmentSettings = z.infer<typeof environmentSettingsSchema>;

/** Which managed resources the manifest provisions. */
export function provisionedResources(manifest: DeploymentManifest): Record<EnvironmentBinding['resource'], boolean> {
  return {
    database: manifest.database.postgres,
    cache: manifest.redis.required,
    storage: manifest.storage.required,
  };
}

/**
 * Problems the schema does not catch: `provider: 'deployz'` on a key the
 * manifest does not allow Deployz to provide, and a managed value for a
 * resource the manifest does not provision. Plain, short messages
 * (ASD-STE100 style) for display alongside the setting.
 */
export function validateEnvironmentSettings(
  settings: readonly EnvironmentSetting[],
  allowedDeployzKeys: ReadonlySet<string>,
  provisioned: Record<EnvironmentBinding['resource'], boolean>,
): string[] {
  const problems: string[] = [];
  for (const setting of settings) {
    if (setting.binding) {
      if (!provisioned[setting.binding.resource]) {
        problems.push(`Deployz does not provide a ${setting.binding.resource} for this application. Remove "${setting.key}".`);
      }
    } else if (setting.provider === 'deployz' && !allowedDeployzKeys.has(setting.key)) {
      problems.push(`Deployz cannot provide "${setting.key}". Choose a different source.`);
    }
  }
  return problems;
}

/**
 * The manifest with the vendor's mapped variables added to its env bindings,
 * so every task definition receives them. A mapped database value clears
 * `database.connectionUnverified`. Preflight and the frozen deployment
 * manifest both use this one function. Returns the manifest unchanged when no
 * setting maps a value.
 */
export function applyEnvironmentBindings(
  manifest: DeploymentManifest,
  settings: readonly EnvironmentSetting[] | null,
): DeploymentManifest {
  const mapped = (settings ?? []).filter((setting) => setting.binding !== undefined);
  if (mapped.length === 0) return manifest;
  const provisioned = provisionedResources(manifest);
  const added = (resource: EnvironmentBinding['resource'], existing: readonly ManifestEnvBinding[]): ManifestEnvBinding[] => {
    const names = new Set(existing.map((binding) => binding.name));
    return mapped.flatMap(({ key, binding }) =>
      provisioned[resource] && binding?.resource === resource && !names.has(key) ? [{ name: key, kind: binding.kind }] : [],
    );
  };
  const database = { ...manifest.database };
  if (provisioned.database && mapped.some((setting) => setting.binding?.resource === 'database')) {
    const existing = database.envBindings ?? [];
    database.envBindings = [...existing, ...added('database', existing)];
    delete database.connectionUnverified;
  }
  return {
    ...manifest,
    database,
    redis: { ...manifest.redis, envBindings: [...manifest.redis.envBindings, ...added('cache', manifest.redis.envBindings)] },
    storage: {
      ...manifest.storage,
      envBindings: [...manifest.storage.envBindings, ...added('storage', manifest.storage.envBindings)],
    },
  };
}

const BUILD_STAGE_KEY_PATTERN = /^(NEXT_PUBLIC_|VITE_|REACT_APP_|NUXT_PUBLIC_|EXPO_PUBLIC_|GATSBY_|PUBLIC_)/;

/** A suggested setting for a detected variable — shown, never auto-saved. */
export interface EnvironmentSettingSuggestion {
  setting: EnvironmentSetting;
  certainty: 'detected' | 'uncertain';
  evidence: string[];
  /** One short plain sentence explaining the suggestion. */
  reason: string;
}

/** Suggests a setting for one detected env var, per the spec's Suggestions rules. */
export function suggestEnvironmentSetting(variable: ManifestEnvVariable): EnvironmentSettingSuggestion {
  const fedAsBuildArg = variable.source.some((entry) => / build arg /.test(entry));
  const stage: EnvironmentStage = BUILD_STAGE_KEY_PATTERN.test(variable.key) || fedAsBuildArg ? 'build' : 'runtime';
  const evidence = [...variable.source];
  if (stage === 'build' && !fedAsBuildArg) {
    evidence.push('Name prefix is usually inlined at build time — confirm.');
  }

  let provider: EnvironmentProvider;
  let reason: string;
  if (variable.classification === 'deployz_managed' || variable.classification === 'deployz_generated') {
    provider = 'deployz';
    reason = 'Deployz provides this value.';
  } else if (variable.required && variable.secret) {
    provider = 'customer';
    reason = 'The code reads it with no default, and the name looks like a credential.';
  } else if (variable.required && !variable.secret) {
    provider = 'vendor';
    reason = 'The code reads it with no default.';
  } else {
    provider = 'none';
    reason =
      variable.classification === 'unknown'
        ? 'Only listed in a sample file.'
        : 'Read with a default.';
  }

  const required = provider === 'none' ? false : variable.required;

  const uncertain =
    variable.classification === 'unknown' ||
    variable.confidence === 'low' ||
    (evidence.length === 1 && evidence[0]?.includes('.example'));

  return {
    setting: {
      key: variable.key,
      stage,
      required,
      secret: variable.secret,
      provider,
    },
    certainty: uncertain ? 'uncertain' : 'detected',
    evidence,
    reason,
  };
}

export type EnvironmentSetupStatus = 'needs-decision' | 'missing-value' | 'ready' | 'customer' | 'optional';

export interface EnvironmentSetupRow {
  key: string;
  /** Whether analysis detected this variable (false for a vendor-added, undetected key). */
  detected: boolean;
  setting: EnvironmentSetting | null;
  suggestion: EnvironmentSettingSuggestion | null;
  effectiveProvider: EnvironmentProvider | 'unreviewed';
  stage: EnvironmentStage;
  required: boolean;
  secret: boolean;
  status: EnvironmentSetupStatus;
}

export interface EnvironmentSetupEvaluation {
  rows: EnvironmentSetupRow[];
  counts: {
    needsDecision: number;
    missingValue: number;
    missingBuildValue: number;
    ready: number;
    customer: number;
    deployz: number;
    optional: number;
    total: number;
  };
}

const STATUS_ORDER: Record<EnvironmentSetupStatus, number> = {
  'needs-decision': 0,
  'missing-value': 1,
  customer: 2,
  ready: 3,
  optional: 4,
};

/**
 * Combines detected variables and saved settings into the rows the config
 * page and preflight both read. Effective resolution per key = saved
 * setting ?? legacy default (today's behaviour, so existing applications
 * keep working unchanged).
 */
export function evaluateEnvironmentSetup(input: {
  variables: readonly ManifestEnvVariable[];
  settings: readonly EnvironmentSetting[] | null;
  /** Keys with a deliverable vendor-default value. */
  vendorValueKeys: ReadonlySet<string>;
}): EnvironmentSetupEvaluation {
  const { variables, settings, vendorValueKeys } = input;
  const settingsByKey = new Map((settings ?? []).map((setting) => [setting.key, setting]));
  const variablesByKey = new Map(variables.map((variable) => [variable.key, variable]));
  const keys = new Set<string>([...variablesByKey.keys(), ...settingsByKey.keys()]);

  const rows: EnvironmentSetupRow[] = [];
  for (const key of keys) {
    const variable = variablesByKey.get(key) ?? null;
    const setting = settingsByKey.get(key) ?? null;
    const detected = variable !== null;
    const suggestion = variable ? suggestEnvironmentSetting(variable) : null;

    let effectiveProvider: EnvironmentProvider | 'unreviewed';
    let stage: EnvironmentStage;
    let required: boolean;
    let secret: boolean;
    let status: EnvironmentSetupStatus;

    if (setting) {
      effectiveProvider = setting.provider;
      stage = setting.stage;
      required = setting.required;
      secret = setting.secret;
      if (setting.provider === 'deployz') {
        status = 'ready';
      } else if (setting.provider === 'vendor') {
        const hasValue = vendorValueKeys.has(key);
        status = hasValue ? 'ready' : setting.required ? 'missing-value' : 'optional';
      } else if (setting.provider === 'customer') {
        status = 'customer';
      } else {
        status = 'optional';
      }
    } else if (variable) {
      const legacyManaged =
        variable.classification === 'deployz_managed' || variable.classification === 'deployz_generated';
      const legacyCustomerRequired =
        variable.classification === 'customer_required' ||
        (variable.classification === undefined && variable.required);

      stage = 'runtime';
      required = variable.required;
      secret = variable.secret;

      if (legacyManaged) {
        effectiveProvider = 'deployz';
        status = 'ready';
      } else if (legacyCustomerRequired) {
        effectiveProvider = 'unreviewed';
        status = 'needs-decision';
      } else if (vendorValueKeys.has(key)) {
        // The vendor saved a value for a name that analysis now detects. A
        // later analysis must not turn that value into "not used".
        effectiveProvider = 'vendor';
        status = 'ready';
      } else {
        effectiveProvider = 'none';
        status = 'optional';
      }
    } else {
      // A setting exists for a key analysis did not detect (vendor-added),
      // but we already handled the `setting` branch above — unreachable.
      continue;
    }

    rows.push({
      key,
      detected,
      setting,
      suggestion,
      effectiveProvider,
      stage,
      required,
      secret,
      status,
    });
  }

  rows.sort((a, b) => {
    const statusDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    return statusDiff !== 0 ? statusDiff : a.key.localeCompare(b.key);
  });

  const counts = {
    needsDecision: 0,
    missingValue: 0,
    missingBuildValue: 0,
    ready: 0,
    customer: 0,
    deployz: 0,
    optional: 0,
    total: rows.length,
  };
  for (const row of rows) {
    if (row.status === 'needs-decision') counts.needsDecision += 1;
    if (row.status === 'missing-value') {
      counts.missingValue += 1;
      if (row.stage === 'build') counts.missingBuildValue += 1;
    }
    if (row.status === 'ready') counts.ready += 1;
    if (row.status === 'customer') counts.customer += 1;
    if (row.status === 'optional') counts.optional += 1;
    if (row.effectiveProvider === 'deployz') counts.deployz += 1;
  }

  return { rows, counts };
}

/** Runtime-stage keys the deployment preflight must see a deliverable value for. */
export function runtimeKeysNeedingValue(evaluation: EnvironmentSetupEvaluation): string[] {
  return evaluation.rows
    .filter((row) => row.stage === 'runtime')
    .filter(
      (row) =>
        row.effectiveProvider === 'unreviewed' ||
        ((row.effectiveProvider === 'vendor' || row.effectiveProvider === 'customer') && row.required),
    )
    .map((row) => row.key);
}

/** Every detected key the preflight does not need a value for (the complement of `runtimeKeysNeedingValue`). */
export function keysNotNeedingValue(evaluation: EnvironmentSetupEvaluation): string[] {
  const needing = new Set(runtimeKeysNeedingValue(evaluation));
  return evaluation.rows.filter((row) => row.detected && !needing.has(row.key)).map((row) => row.key);
}

/** Runtime rows the customer must supply a value for at install/config time. */
export function customerInputRows(evaluation: EnvironmentSetupEvaluation): EnvironmentSetupRow[] {
  return evaluation.rows.filter((row) => {
    if (row.stage !== 'runtime') return false;
    if (row.setting) return row.effectiveProvider === 'customer';
    // Legacy: no saved setting — "unreviewed required" behaves as today,
    // asking the customer.
    return row.effectiveProvider === 'unreviewed' && row.required;
  });
}

/**
 * Whether a saved value from `source` reaches a deployment under the vendor's
 * decision for its key. "Set by vendor" takes the vendor default or the
 * vendor's per-customer override; "Set by customer" takes only the customer's
 * value; "Managed by Deployz" and "Optional / not needed" take no saved value.
 * A value left from an earlier decision therefore never overrides the new
 * source. No decision keeps the legacy rule: every saved value is delivered.
 */
export function deliversConfigValue(setting: EnvironmentSetting | undefined, source: 'vendor' | 'customer'): boolean {
  if (!setting) return true;
  if (setting.provider === 'vendor') return true;
  if (setting.provider === 'customer') return source === 'customer';
  return false;
}

/** Build-stage keys whose settings have `provider: 'vendor'`. */
export function buildStageVendorKeys(settings: readonly EnvironmentSetting[]): string[] {
  return settings.filter((setting) => setting.stage === 'build' && setting.provider === 'vendor').map((s) => s.key);
}

/**
 * Required build-stage vendor keys with no deliverable vendor value —
 * blocks release creation (`BUILD_CONFIGURATION_MISSING`).
 */
export function missingBuildValues(
  settings: readonly EnvironmentSetting[],
  vendorValueKeys: ReadonlySet<string>,
): string[] {
  return settings
    .filter(
      (setting) =>
        setting.stage === 'build' &&
        setting.provider === 'vendor' &&
        setting.required &&
        !vendorValueKeys.has(setting.key),
    )
    .map((setting) => setting.key);
}
