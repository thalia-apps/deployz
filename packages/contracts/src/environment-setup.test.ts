import { describe, expect, it } from 'vitest';

import {
  buildStageVendorKeys,
  customerInputRows,
  deliversConfigValue,
  deployzProvidableKeys,
  environmentSettingsSchema,
  evaluateEnvironmentSetup,
  keysNotNeedingValue,
  missingBuildValues,
  runtimeKeysNeedingValue,
  suggestEnvironmentSetting,
  validateEnvironmentSettings,
} from './environment-setup.js';
import type { ManifestEnvVariable } from './manifest.js';

function variable(overrides: Partial<ManifestEnvVariable> & { key: string }): ManifestEnvVariable {
  return {
    required: false,
    secret: false,
    source: ['read in app.ts'],
    ...overrides,
  };
}

describe('environmentSettingsSchema', () => {
  const base = { key: 'API_KEY', stage: 'runtime' as const, required: true, secret: true };

  it('accepts a valid customer setting', () => {
    const result = environmentSettingsSchema.safeParse([{ ...base, provider: 'customer' }]);
    expect(result.success).toBe(true);
  });

  it('rejects provider customer with stage build', () => {
    const result = environmentSettingsSchema.safeParse([{ ...base, provider: 'customer', stage: 'build' }]);
    expect(result.success).toBe(false);
  });

  it('rejects provider deployz with stage build', () => {
    const result = environmentSettingsSchema.safeParse([{ ...base, provider: 'deployz', stage: 'build' }]);
    expect(result.success).toBe(false);
  });

  it('rejects provider none with required true', () => {
    const result = environmentSettingsSchema.safeParse([{ ...base, provider: 'none', required: true }]);
    expect(result.success).toBe(false);
  });

  it('rejects duplicate keys', () => {
    const result = environmentSettingsSchema.safeParse([
      { ...base, provider: 'customer' },
      { ...base, provider: 'vendor', required: false, secret: false },
    ]);
    expect(result.success).toBe(false);
  });

  it('rejects an invalid key', () => {
    const result = environmentSettingsSchema.safeParse([{ ...base, key: '1BAD', provider: 'customer' }]);
    expect(result.success).toBe(false);
  });
});

describe('deployzProvidableKeys', () => {
  it('includes managed, generated, and mintable internal-secret keys only', () => {
    const keys = deployzProvidableKeys([
      variable({ key: 'DATABASE_URL', classification: 'deployz_managed' }),
      variable({ key: 'JWT_SECRET', secret: true, purpose: 'internal_secret' }),
      variable({ key: 'STRIPE_KEY', secret: true, purpose: 'external_credential' }),
      variable({ key: 'FEATURE_FLAG', classification: 'optional' }),
    ]);
    expect(keys).toEqual(new Set(['DATABASE_URL', 'JWT_SECRET']));
  });
});

const NO_RESOURCES = { database: false, cache: false, storage: false };

describe('validateEnvironmentSettings', () => {
  it('flags provider deployz on a disallowed key', () => {
    const problems = validateEnvironmentSettings(
      [{ key: 'STRIPE_KEY', stage: 'runtime', required: true, secret: true, provider: 'deployz' }],
      new Set(['DATABASE_URL']),
      NO_RESOURCES,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('STRIPE_KEY');
  });

  it('passes when the key is allowed', () => {
    const problems = validateEnvironmentSettings(
      [{ key: 'DATABASE_URL', stage: 'runtime', required: true, secret: false, provider: 'deployz' }],
      new Set(['DATABASE_URL']),
      NO_RESOURCES,
    );
    expect(problems).toEqual([]);
  });
});

describe('suggestEnvironmentSetting', () => {
  it('suggests deployz for a managed key', () => {
    const suggestion = suggestEnvironmentSetting(
      variable({ key: 'DATABASE_URL', classification: 'deployz_managed' }),
    );
    expect(suggestion.setting.provider).toBe('deployz');
    expect(suggestion.reason).toBe('Deployz provides this value.');
  });

  it('suggests the build stage for a variable a compose file feeds as a build arg (A1-009)', () => {
    const suggestion = suggestEnvironmentSetting(
      variable({ key: 'SELF_HOSTED', required: true, source: ['docker-compose.yml build arg SELF_HOSTED=true'] }),
    );
    expect(suggestion.setting).toMatchObject({ stage: 'build', provider: 'vendor', required: true });
    expect(suggestion.evidence).toEqual(['docker-compose.yml build arg SELF_HOSTED=true']);
  });

  it('suggests customer for a required secret', () => {
    const suggestion = suggestEnvironmentSetting(variable({ key: 'STRIPE_KEY', required: true, secret: true }));
    expect(suggestion.setting.provider).toBe('customer');
  });

  it('suggests vendor for a required, non-secret value', () => {
    const suggestion = suggestEnvironmentSetting(variable({ key: 'REGION', required: true, secret: false }));
    expect(suggestion.setting.provider).toBe('vendor');
    expect(suggestion.reason).toBe('The code reads it with no default.');
  });

  it('suggests none and uncertain for an unknown, sample-only key', () => {
    const suggestion = suggestEnvironmentSetting(
      variable({ key: 'MAYBE', required: false, classification: 'unknown', source: ['.env.example'] }),
    );
    expect(suggestion.setting.provider).toBe('none');
    expect(suggestion.certainty).toBe('uncertain');
    expect(suggestion.reason).toBe('Only listed in a sample file.');
  });

  it('detects build stage from a NEXT_PUBLIC_ prefix', () => {
    const suggestion = suggestEnvironmentSetting(variable({ key: 'NEXT_PUBLIC_API_URL', required: true }));
    expect(suggestion.setting.stage).toBe('build');
  });

  it('defaults optional read-with-default keys to runtime and none', () => {
    const suggestion = suggestEnvironmentSetting(
      variable({ key: 'LOG_LEVEL', required: false, classification: 'optional' }),
    );
    expect(suggestion.setting.stage).toBe('runtime');
    expect(suggestion.setting.provider).toBe('none');
    expect(suggestion.reason).toBe('Read with a default.');
  });
});

describe('evaluateEnvironmentSetup', () => {
  it('legacy (no settings): managed -> deployz/ready, required customer -> needs-decision, optional -> optional', () => {
    const evaluation = evaluateEnvironmentSetup({
      variables: [
        variable({ key: 'DATABASE_URL', classification: 'deployz_managed' }),
        variable({ key: 'STRIPE_KEY', required: true, secret: true, classification: 'customer_required' }),
        variable({ key: 'LOG_LEVEL', required: false, classification: 'optional' }),
      ],
      settings: null,
      vendorValueKeys: new Set(),
    });
    const byKey = new Map(evaluation.rows.map((r) => [r.key, r]));
    expect(byKey.get('DATABASE_URL')?.status).toBe('ready');
    expect(byKey.get('DATABASE_URL')?.effectiveProvider).toBe('deployz');
    expect(byKey.get('STRIPE_KEY')?.status).toBe('needs-decision');
    expect(byKey.get('STRIPE_KEY')?.effectiveProvider).toBe('unreviewed');
    expect(byKey.get('LOG_LEVEL')?.status).toBe('optional');
    expect(evaluation.counts.needsDecision).toBe(1);
    expect(evaluation.counts.ready).toBe(1);
    expect(evaluation.counts.optional).toBe(1);
  });

  it('legacy: an optional variable with a saved vendor value stays vendor-provided', () => {
    const evaluation = evaluateEnvironmentSetup({
      variables: [variable({ key: 'ADMIN_EMAIL', required: false, classification: 'optional' })],
      settings: null,
      vendorValueKeys: new Set(['ADMIN_EMAIL']),
    });
    const row = evaluation.rows[0];
    expect(row?.effectiveProvider).toBe('vendor');
    expect(row?.status).toBe('ready');
  });

  it('legacy: undefined classification and required counts as needs-decision', () => {
    const evaluation = evaluateEnvironmentSetup({
      variables: [variable({ key: 'SOME_KEY', required: true })],
      settings: null,
      vendorValueKeys: new Set(),
    });
    expect(evaluation.rows[0]?.status).toBe('needs-decision');
  });

  it('vendor provider: missing value vs present value', () => {
    const settings = [
      { key: 'REGION', stage: 'runtime' as const, required: true, secret: false, provider: 'vendor' as const },
    ];
    const missing = evaluateEnvironmentSetup({
      variables: [variable({ key: 'REGION', required: true })],
      settings,
      vendorValueKeys: new Set(),
    });
    expect(missing.rows[0]?.status).toBe('missing-value');

    const present = evaluateEnvironmentSetup({
      variables: [variable({ key: 'REGION', required: true })],
      settings,
      vendorValueKeys: new Set(['REGION']),
    });
    expect(present.rows[0]?.status).toBe('ready');
  });

  it('counts missingBuildValue only for build-stage missing-value rows', () => {
    const settings = [
      {
        key: 'NEXT_PUBLIC_API_URL',
        stage: 'build' as const,
        required: true,
        secret: false,
        provider: 'vendor' as const,
      },
      { key: 'REGION', stage: 'runtime' as const, required: true, secret: false, provider: 'vendor' as const },
    ];
    const evaluation = evaluateEnvironmentSetup({
      variables: [
        variable({ key: 'NEXT_PUBLIC_API_URL', required: true }),
        variable({ key: 'REGION', required: true }),
      ],
      settings,
      vendorValueKeys: new Set(),
    });
    expect(evaluation.counts.missingValue).toBe(2);
    expect(evaluation.counts.missingBuildValue).toBe(1);
  });

  it('includes a vendor-added, undetected key as a row', () => {
    const settings = [
      { key: 'EXTRA_KEY', stage: 'runtime' as const, required: false, secret: false, provider: 'none' as const },
    ];
    const evaluation = evaluateEnvironmentSetup({ variables: [], settings, vendorValueKeys: new Set() });
    expect(evaluation.rows).toHaveLength(1);
    expect(evaluation.rows[0]).toMatchObject({ key: 'EXTRA_KEY', detected: false, suggestion: null, status: 'optional' });
  });

  it('sorts rows needs-decision, missing-value, customer, ready, optional, then by key', () => {
    const settings = [
      { key: 'B_VENDOR', stage: 'runtime' as const, required: true, secret: false, provider: 'vendor' as const },
      { key: 'A_CUSTOMER', stage: 'runtime' as const, required: true, secret: true, provider: 'customer' as const },
    ];
    const evaluation = evaluateEnvironmentSetup({
      variables: [
        variable({ key: 'Z_UNREVIEWED', required: true }),
        variable({ key: 'B_VENDOR', required: true }),
        variable({ key: 'A_CUSTOMER', required: true, secret: true }),
        variable({ key: 'M_MANAGED', classification: 'deployz_managed' }),
        variable({ key: 'X_OPTIONAL', classification: 'optional' }),
      ],
      settings,
      vendorValueKeys: new Set(),
    });
    expect(evaluation.rows.map((r) => r.key)).toEqual([
      'Z_UNREVIEWED',
      'B_VENDOR',
      'A_CUSTOMER',
      'M_MANAGED',
      'X_OPTIONAL',
    ]);
  });
});

describe('runtimeKeysNeedingValue / keysNotNeedingValue', () => {
  it('splits detected keys correctly', () => {
    const settings = [
      { key: 'REGION', stage: 'runtime' as const, required: true, secret: false, provider: 'vendor' as const },
      {
        key: 'NEXT_PUBLIC_URL',
        stage: 'build' as const,
        required: true,
        secret: false,
        provider: 'vendor' as const,
      },
    ];
    const evaluation = evaluateEnvironmentSetup({
      variables: [
        variable({ key: 'DATABASE_URL', classification: 'deployz_managed' }),
        variable({ key: 'REGION', required: true }),
        variable({ key: 'NEXT_PUBLIC_URL', required: true }),
        variable({ key: 'UNREVIEWED', required: true }),
      ],
      settings,
      vendorValueKeys: new Set(),
    });
    expect(runtimeKeysNeedingValue(evaluation).sort()).toEqual(['REGION', 'UNREVIEWED']);
    expect(keysNotNeedingValue(evaluation).sort()).toEqual(['DATABASE_URL', 'NEXT_PUBLIC_URL']);
  });
});

describe('customerInputRows', () => {
  it('excludes optional rows and includes customer/unreviewed-required runtime rows', () => {
    const settings = [
      { key: 'STRIPE_KEY', stage: 'runtime' as const, required: true, secret: true, provider: 'customer' as const },
    ];
    const evaluation = evaluateEnvironmentSetup({
      variables: [
        variable({ key: 'STRIPE_KEY', required: true, secret: true }),
        variable({ key: 'LEGACY_REQUIRED', required: true, classification: 'customer_required' }),
        variable({ key: 'LOG_LEVEL', classification: 'optional' }),
      ],
      settings,
      vendorValueKeys: new Set(),
    });
    const keys = customerInputRows(evaluation).map((r) => r.key);
    expect(keys.sort()).toEqual(['LEGACY_REQUIRED', 'STRIPE_KEY']);
  });
});

describe('buildStageVendorKeys / missingBuildValues', () => {
  it('lists build-stage vendor keys and flags required ones without a value', () => {
    const settings = [
      { key: 'A', stage: 'build' as const, required: true, secret: false, provider: 'vendor' as const },
      { key: 'B', stage: 'build' as const, required: false, secret: false, provider: 'vendor' as const },
      { key: 'C', stage: 'runtime' as const, required: true, secret: false, provider: 'vendor' as const },
    ];
    expect(buildStageVendorKeys(settings).sort()).toEqual(['A', 'B']);
    expect(missingBuildValues(settings, new Set())).toEqual(['A']);
    expect(missingBuildValues(settings, new Set(['A']))).toEqual([]);
  });
});

describe('deliversConfigValue', () => {
  const setting = (provider: 'deployz' | 'vendor' | 'customer' | 'none') => ({
    key: 'API_URL',
    stage: 'runtime' as const,
    required: true,
    secret: false,
    provider,
  });

  it('delivers every saved value when the vendor has not decided', () => {
    expect(deliversConfigValue(undefined, 'vendor')).toBe(true);
    expect(deliversConfigValue(undefined, 'customer')).toBe(true);
  });

  it('never lets a value from an earlier decision override the current source', () => {
    expect(deliversConfigValue(setting('vendor'), 'vendor')).toBe(true);
    expect(deliversConfigValue(setting('vendor'), 'customer')).toBe(true);
    expect(deliversConfigValue(setting('customer'), 'customer')).toBe(true);
    expect(deliversConfigValue(setting('customer'), 'vendor')).toBe(false);
    for (const provider of ['deployz', 'none'] as const) {
      expect(deliversConfigValue(setting(provider), 'vendor')).toBe(false);
      expect(deliversConfigValue(setting(provider), 'customer')).toBe(false);
    }
  });
});
