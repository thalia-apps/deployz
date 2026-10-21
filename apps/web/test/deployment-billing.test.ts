import { describe, expect, it } from 'vitest';

import {
  deploymentBillingLabel,
  isTestDeployment,
} from '@/lib/deployment-billing';

// Paddle migration Phase 11 — what a vendor is told a deployment costs. The
// label reads the deployment's own billing state, never its health: that
// separation is the whole reason billing_state exists apart from §46 state.
// With included production deployments the allowance is pooled, so no label
// ever names a per-deployment price.
describe('deploymentBillingLabel', () => {
  it('a test deployment is always free, whatever its billing state says', () => {
    for (const billingState of ['NOT_STARTED', 'ACTIVE', 'PAUSED', 'STOPPED'] as const) {
      expect(deploymentBillingLabel({ deploymentType: 'TEST', billingState })).toBe(
        'Free test deployment',
      );
    }
  });

  it('a live production deployment counts toward the pooled total — never "$19"', () => {
    const label = deploymentBillingLabel({ deploymentType: 'PRODUCTION', billingState: 'ACTIVE' });
    expect(label).toBe('Counts toward your production deployment total');
    expect(label).not.toMatch(/\$/);
  });

  it('a production deployment that never went live counts only once live', () => {
    expect(
      deploymentBillingLabel({ deploymentType: 'PRODUCTION', billingState: 'NOT_STARTED' }),
    ).toBe('Counts toward your production deployment total once live');
  });

  it('a failed or disconnected production deployment is paused and not counted', () => {
    expect(deploymentBillingLabel({ deploymentType: 'PRODUCTION', billingState: 'PAUSED' })).toBe(
      'Billing paused — not counted while it is failed or disconnected',
    );
  });

  it('a removed production deployment no longer counts', () => {
    expect(deploymentBillingLabel({ deploymentType: 'PRODUCTION', billingState: 'STOPPED' })).toBe(
      'No longer counts toward your production deployment total',
    );
  });
});

describe('isTestDeployment', () => {
  it('is true only for TEST', () => {
    expect(isTestDeployment({ deploymentType: 'TEST', billingState: 'NOT_STARTED' })).toBe(true);
    expect(isTestDeployment({ deploymentType: 'PRODUCTION', billingState: 'ACTIVE' })).toBe(false);
  });
});
