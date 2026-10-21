import { describe, expect, it } from 'vitest';

import { retryEligibilityFor, type RetryEligibilityInput } from './retry-eligibility.js';

const CONNECTED: RetryEligibilityInput = {
  state: 'FAILED',
  relayStatus: 'CONNECTED',
  installSucceeded: false,
  hasRelease: false,
  failureCode: 'UNKNOWN',
};

describe('retryEligibilityFor', () => {
  it('marks a failed first install retryable and names the vendor for a user-action code', () => {
    expect(retryEligibilityFor({ ...CONNECTED, failureCode: 'CONTAINER_START_FAILED' })).toEqual({
      action: 'RETRY_INSTALL',
      retryable: true,
      whoMustAct: 'VENDOR',
    });
    expect(retryEligibilityFor({ ...CONNECTED, failureCode: 'AWS_PERMISSION_DENIED' })).toEqual({
      action: 'RETRY_INSTALL',
      retryable: true,
      whoMustAct: 'VENDOR',
    });
  });

  it('never blocks a failed first install on rollback or terminal evidence', () => {
    expect(retryEligibilityFor({ ...CONNECTED, failureCode: 'STACK_CREATE_FAILED' })).toEqual({
      action: 'RETRY_INSTALL',
      retryable: true,
      whoMustAct: 'VENDOR',
    });
    expect(retryEligibilityFor({ ...CONNECTED, failureCode: 'REGION_NOT_SUPPORTED' })).toEqual({
      action: 'RETRY_INSTALL',
      retryable: true,
      whoMustAct: 'VENDOR',
    });
    expect(retryEligibilityFor({ ...CONNECTED, failureCode: 'UNSUPPORTED_ARCHITECTURE' })).toEqual({
      action: 'RETRY_INSTALL',
      retryable: true,
      whoMustAct: 'VENDOR',
    });
  });

  it('routes a deployz-side fault to the contact path, not a retry', () => {
    expect(retryEligibilityFor({ ...CONNECTED, failureCode: 'IMAGE_PULL_FAILED' })).toEqual({
      action: 'CONTACT_DEPLOYZ',
      retryable: false,
      whoMustAct: 'DEPLOYZ',
    });
    expect(retryEligibilityFor({ ...CONNECTED, failureCode: 'TEMPLATE_UNAVAILABLE' })).toEqual({
      action: 'CONTACT_DEPLOYZ',
      retryable: false,
      whoMustAct: 'DEPLOYZ',
    });
  });

  it('offers the retry for a reconcile-first failure of a first install: nothing reconciles it', () => {
    for (const failureCode of ['RDS_UNAVAILABLE', 'UNKNOWN', 'RELAY_DISCONNECTED']) {
      expect(retryEligibilityFor({ ...CONNECTED, failureCode })).toEqual({
        action: 'RETRY_INSTALL',
        retryable: true,
        whoMustAct: null,
      });
    }
    expect(
      retryEligibilityFor({ ...CONNECTED, failureCode: 'RELAY_DISCONNECTED', relayStatus: 'DISCONNECTED' }),
    ).toEqual({ action: 'RETRY_INSTALL', retryable: false, whoMustAct: null });
  });

  it('tells a reconcile-first failure to wait only where the heartbeat self-heal can run', () => {
    const wait = { action: 'WAIT', retryable: false, whoMustAct: null };
    const installed = { ...CONNECTED, installSucceeded: true, failureCode: 'RDS_UNAVAILABLE' };
    expect(retryEligibilityFor({ ...installed, state: 'HEALTHY', hasRelease: true })).toEqual(wait);
    expect(retryEligibilityFor({ ...installed, state: 'FAILED', hasRelease: true })).toEqual(wait);
    // An install that never ran a release has nothing for the self-heal to restore.
    expect(retryEligibilityFor({ ...installed, state: 'FAILED', hasRelease: false })).toEqual({
      action: 'DEPLOY_AGAIN',
      retryable: true,
      whoMustAct: null,
    });
  });

  it('clamps any retry action to non-retryable while the relay is disconnected', () => {
    expect(
      retryEligibilityFor({ ...CONNECTED, failureCode: 'CONTAINER_START_FAILED', relayStatus: 'DISCONNECTED' }),
    ).toEqual({ action: 'RETRY_INSTALL', retryable: false, whoMustAct: 'VENDOR' });
  });

  it('points a failed day-2 operation at deploy-again', () => {
    const day2: RetryEligibilityInput = {
      state: 'FAILED',
      relayStatus: 'CONNECTED',
      installSucceeded: true,
      hasRelease: true,
      failureCode: 'ECS_DEPLOYMENT_FAILED',
    };
    expect(retryEligibilityFor(day2)).toEqual({
      action: 'DEPLOY_AGAIN',
      retryable: true,
      whoMustAct: 'VENDOR',
    });
    expect(retryEligibilityFor({ ...day2, state: 'UPDATE_AVAILABLE' })).toEqual({
      action: 'DEPLOY_AGAIN',
      retryable: true,
      whoMustAct: 'VENDOR',
    });
  });

  it('returns none for in-flight, gone, or failure-free deployments', () => {
    const none = { action: 'NONE', retryable: false, whoMustAct: null };
    expect(retryEligibilityFor({ ...CONNECTED, state: 'INSTALLING' })).toEqual(none);
    expect(retryEligibilityFor({ ...CONNECTED, state: 'UPDATING' })).toEqual(none);
    expect(retryEligibilityFor({ ...CONNECTED, state: 'DELETED' })).toEqual(none);
    expect(retryEligibilityFor({ ...CONNECTED, state: 'HEALTHY', failureCode: null })).toEqual(none);
    expect(retryEligibilityFor({ ...CONNECTED, failureCode: null })).toEqual(none);
  });
});
