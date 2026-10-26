import { afterEach, describe, expect, it } from 'vitest';

import {
  RELAY_CAPABILITIES,
  RELAY_VERSION,
  accountIdFromArn,
  isBootstrapStackUpdating,
  readBootstrapStackStatus,
  readRelayIdentity,
} from './identity.js';

const ACCOUNT_ARN = 'arn:aws:lambda:us-east-1:151955775369:function:deployz-relay';

describe('accountIdFromArn', () => {
  it('extracts the account id from a Lambda ARN', () => {
    expect(accountIdFromArn(ACCOUNT_ARN)).toBe('151955775369');
  });

  it('returns null for a malformed ARN', () => {
    expect(accountIdFromArn('arn:aws:lambda:us-east-1:function')).toBeNull();
    expect(accountIdFromArn('')).toBeNull();
  });
});

describe('readRelayIdentity', () => {
  const originalRegion = process.env['AWS_REGION'];
  const originalBootstrap = process.env['DEPLOYZ_BOOTSTRAP_VERSION'];

  afterEach(() => {
    if (originalRegion === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = originalRegion;
    if (originalBootstrap === undefined) delete process.env['DEPLOYZ_BOOTSTRAP_VERSION'];
    else process.env['DEPLOYZ_BOOTSTRAP_VERSION'] = originalBootstrap;
  });

  it('derives account and region from the Lambda context', () => {
    process.env['AWS_REGION'] = 'us-east-1';
    const identity = readRelayIdentity({ invokedFunctionArn: ACCOUNT_ARN });
    expect(identity.awsAccountId).toBe('151955775369');
    expect(identity.region).toBe('us-east-1');
    expect(identity.relayVersion).toBe(RELAY_VERSION);
    expect(identity.capabilities).toEqual(RELAY_CAPABILITIES);
  });

  it('omits account and region when context and env are absent', () => {
    delete process.env['AWS_REGION'];
    const identity = readRelayIdentity(undefined);
    expect(identity.awsAccountId).toBeUndefined();
    expect(identity.region).toBeUndefined();
    expect(identity.relayVersion).toBe(RELAY_VERSION);
  });

  it('reports the bootstrap version only when the env carries one', () => {
    delete process.env['DEPLOYZ_BOOTSTRAP_VERSION'];
    expect(readRelayIdentity(undefined).bootstrapVersion).toBeNull();
    process.env['DEPLOYZ_BOOTSTRAP_VERSION'] = '2026-08-28.1';
    expect(readRelayIdentity(undefined).bootstrapVersion).toBe('2026-08-28.1');
    process.env['DEPLOYZ_BOOTSTRAP_VERSION'] = '';
    expect(readRelayIdentity(undefined).bootstrapVersion).toBeNull();
  });
});

describe('RELAY_CAPABILITIES', () => {
  it('advertises only what this build can actually execute', () => {
    expect(RELAY_CAPABILITIES.domainManagement).toBe(true);
    expect(RELAY_CAPABILITIES.deployRelease).toBe(true);
    expect(RELAY_CAPABILITIES.rollback).toBe(true);
    expect(RELAY_CAPABILITIES.restart).toBe(true);
    expect(RELAY_CAPABILITIES.configUpdate).toBe(true);
    expect(RELAY_CAPABILITIES.destroy).toBe(true);
  });
});

describe('readBootstrapStackStatus', () => {
  it('returns the status of the stack', async () => {
    const cfn = {
      describeStack: async (name: string) => ({
        found: true as const,
        stack: { stackName: name, status: 'UPDATE_IN_PROGRESS', tags: {} },
      }),
    };
    await expect(readBootstrapStackStatus(cfn, 'deployz-bootstrap')).resolves.toBe('UPDATE_IN_PROGRESS');
  });

  it('returns null when the read fails or the stack is not found', async () => {
    await expect(
      readBootstrapStackStatus({ describeStack: async () => ({ found: false, errorCode: 'AccessDenied' }) }, 'x'),
    ).resolves.toBeNull();
    await expect(
      readBootstrapStackStatus({ describeStack: async () => Promise.reject(new Error('throttled')) }, 'x'),
    ).resolves.toBeNull();
  });
});

describe('isBootstrapStackUpdating', () => {
  it('is true only for update and update-rollback progress states', () => {
    for (const status of [
      'UPDATE_IN_PROGRESS',
      'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS',
      'UPDATE_ROLLBACK_IN_PROGRESS',
      'UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS',
    ]) {
      expect(isBootstrapStackUpdating(status)).toBe(true);
    }
    for (const status of [null, 'CREATE_IN_PROGRESS', 'DELETE_IN_PROGRESS', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE']) {
      expect(isBootstrapStackUpdating(status)).toBe(false);
    }
  });
});
