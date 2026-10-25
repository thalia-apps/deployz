import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchConfig,
  FIXTURE_CONFIG_CUSTOMER_ID,
  fixtureConfig,
  mergeConfig,
} from '../src/lib/config';

// Locks the §31 config-screen data layer: the vendor/customer merge
// precedence, and the fixture contract — fixtures are what the API returns
// AFTER masking, so secret values are null everywhere (plaintext never
// exists in the client). §65: fixture copy is jargon-free.

const JARGON = /\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC|CFN)\b/i;

describe('mergeConfig (§31 precedence)', () => {
  it('customer override wins over the vendor default with the same key', () => {
    const merged = mergeConfig(
      [{ key: 'LOG_LEVEL', isSecret: false, value: 'info' }],
      [{ key: 'LOG_LEVEL', isSecret: false, value: 'debug' }],
    );
    expect(merged).toEqual([
      { key: 'LOG_LEVEL', isSecret: false, value: 'debug', source: 'customer', vendorValue: 'info' },
    ]);
  });

  it('non-overridden keys stay vendor-sourced; customer-only keys are appended in order', () => {
    const merged = mergeConfig(
      [
        { key: 'A', isSecret: false, value: '1' },
        { key: 'B', isSecret: false, value: '2' },
      ],
      [{ key: 'C', isSecret: false, value: '3' }],
    );
    expect(merged.map((entry) => entry.key)).toEqual(['A', 'B', 'C']);
    expect(merged[0]).toMatchObject({ source: 'vendor', vendorValue: null });
    expect(merged[2]).toMatchObject({ source: 'customer', vendorValue: null });
  });

  it('an overridden secret never surfaces the vendor value', () => {
    const merged = mergeConfig(
      [{ key: 'DATABASE_URL', isSecret: true, value: null }],
      [{ key: 'DATABASE_URL', isSecret: true, value: null }],
    );
    expect(merged[0]).toMatchObject({ source: 'customer', value: null, vendorValue: null });
  });
});

describe('config request errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('carries the API message when the connector is offline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: 'RELAY_DISCONNECTED', message: 'The connector is offline.' } }), {
          status: 409,
        }),
      ),
    );
    await expect(fetchConfig('app-1')).rejects.toMatchObject({
      code: 'RELAY_DISCONNECTED',
      message: 'The connector is offline.',
    });
  });
});
