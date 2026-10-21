import { describe, expect, it } from 'vitest';

import {
  applyBillingTransition,
  billableDeploymentQuantity,
  countBillableDeployments,
  productionDeploymentCounts,
  isBillableDeployment,
  servingBillingEvent,
  DEPLOYMENT_PRICE_DOLLARS,
  PLATFORM_PRICE_DOLLARS,
} from './billing-domain.js';

// ── applyBillingTransition ───────────────────────────────────────────────

const now = new Date('2026-09-01T00:00:00.000Z');

describe('applyBillingTransition', () => {
  // Rule 1: TEST deployments never become billable.
  it('a TEST deployment ignores LIVE', () => {
    expect(
      applyBillingTransition({ deploymentType: 'TEST', billingState: 'NOT_STARTED' }, 'LIVE', now),
    ).toBeNull();
  });

  it('a TEST deployment ignores REMOVED', () => {
    expect(
      applyBillingTransition({ deploymentType: 'TEST', billingState: 'NOT_STARTED' }, 'REMOVED', now),
    ).toBeNull();
  });

  // Rule 2: PRODUCTION + NOT_STARTED + LIVE -> ACTIVE.
  it('a PRODUCTION deployment activates on its first LIVE event', () => {
    expect(
      applyBillingTransition({ deploymentType: 'PRODUCTION', billingState: 'NOT_STARTED' }, 'LIVE', now),
    ).toEqual({ billingState: 'ACTIVE', billingStartedAt: now });
  });

  // Rule 3: PAUSED + LIVE -> ACTIVE; billingStartedAt is not rewritten.
  it('a PAUSED PRODUCTION deployment resumes on LIVE', () => {
    expect(
      applyBillingTransition({ deploymentType: 'PRODUCTION', billingState: 'PAUSED' }, 'LIVE', now),
    ).toEqual({ billingState: 'ACTIVE' });
  });

  // Rule 4: ACTIVE + NOT_SERVING -> PAUSED; a never-live deployment stays unbilled.
  it('an ACTIVE PRODUCTION deployment pauses on NOT_SERVING', () => {
    expect(
      applyBillingTransition({ deploymentType: 'PRODUCTION', billingState: 'ACTIVE' }, 'NOT_SERVING', now),
    ).toEqual({ billingState: 'PAUSED' });
  });

  it('a never-live PRODUCTION deployment ignores NOT_SERVING — a failed first install was never billed', () => {
    expect(
      applyBillingTransition({ deploymentType: 'PRODUCTION', billingState: 'NOT_STARTED' }, 'NOT_SERVING', now),
    ).toBeNull();
  });

  it('NOT_SERVING on an already PAUSED deployment is a no-op', () => {
    expect(
      applyBillingTransition({ deploymentType: 'PRODUCTION', billingState: 'PAUSED' }, 'NOT_SERVING', now),
    ).toBeNull();
  });

  // Rule 5: PRODUCTION + not STOPPED + REMOVED -> STOPPED.
  it('a PAUSED PRODUCTION deployment stops on REMOVED', () => {
    expect(
      applyBillingTransition({ deploymentType: 'PRODUCTION', billingState: 'PAUSED' }, 'REMOVED', now),
    ).toEqual({ billingState: 'STOPPED', billingStoppedAt: now });
  });

  it('an ACTIVE PRODUCTION deployment stops on REMOVED', () => {
    expect(
      applyBillingTransition({ deploymentType: 'PRODUCTION', billingState: 'ACTIVE' }, 'REMOVED', now),
    ).toEqual({ billingState: 'STOPPED', billingStoppedAt: now });
  });

  it('a never-live PRODUCTION deployment also stops on REMOVED, so it can never activate later', () => {
    expect(
      applyBillingTransition({ deploymentType: 'PRODUCTION', billingState: 'NOT_STARTED' }, 'REMOVED', now),
    ).toEqual({ billingState: 'STOPPED', billingStoppedAt: now });
  });

  // Rule 6: STOPPED is terminal; timestamps are write-once.
  it('LIVE after STOPPED is a no-op', () => {
    expect(
      applyBillingTransition({ deploymentType: 'PRODUCTION', billingState: 'STOPPED' }, 'LIVE', now),
    ).toBeNull();
  });

  it('REMOVED on an already-STOPPED deployment is a no-op', () => {
    expect(
      applyBillingTransition({ deploymentType: 'PRODUCTION', billingState: 'STOPPED' }, 'REMOVED', now),
    ).toBeNull();
  });

  it('a second LIVE on an ACTIVE deployment is a no-op — timestamps are write-once', () => {
    expect(
      applyBillingTransition({ deploymentType: 'PRODUCTION', billingState: 'ACTIVE' }, 'LIVE', now),
    ).toBeNull();
  });
});

describe('servingBillingEvent', () => {
  it('a FAILED deployment is not serving, whatever the connector says', () => {
    expect(servingBillingEvent({ state: 'FAILED', relayStatus: 'CONNECTED' })).toBe('NOT_SERVING');
  });

  it('a DISCONNECTED connector is not serving, whatever the deployment says', () => {
    expect(servingBillingEvent({ state: 'HEALTHY', relayStatus: 'DISCONNECTED' })).toBe('NOT_SERVING');
    expect(servingBillingEvent({ state: 'UPDATING', relayStatus: 'DISCONNECTED' })).toBe('NOT_SERVING');
  });

  it('a connected HEALTHY or UPDATE_AVAILABLE deployment is serving', () => {
    expect(servingBillingEvent({ state: 'HEALTHY', relayStatus: 'CONNECTED' })).toBe('LIVE');
    expect(servingBillingEvent({ state: 'UPDATE_AVAILABLE', relayStatus: 'CONNECTED' })).toBe('LIVE');
  });

  it('a running update keeps the billing state as it is', () => {
    // A failed update returns to HEALTHY / UPDATE_AVAILABLE (the previous
    // release still serves), so it never reads as NOT_SERVING.
    expect(servingBillingEvent({ state: 'UPDATING', relayStatus: 'CONNECTED' })).toBeNull();
  });

  it('a connector that never reported keeps the billing state as it is', () => {
    expect(servingBillingEvent({ state: 'HEALTHY', relayStatus: 'UNKNOWN' })).toBeNull();
  });
});

describe('isBillableDeployment', () => {
  it('is true only for PRODUCTION + ACTIVE', () => {
    expect(isBillableDeployment({ deploymentType: 'PRODUCTION', billingState: 'ACTIVE' })).toBe(true);
  });

  it('is false for TEST + ACTIVE (never reachable, but the predicate itself must not bill it)', () => {
    expect(isBillableDeployment({ deploymentType: 'TEST', billingState: 'ACTIVE' })).toBe(false);
  });

  it('is false for PRODUCTION + NOT_STARTED', () => {
    expect(isBillableDeployment({ deploymentType: 'PRODUCTION', billingState: 'NOT_STARTED' })).toBe(false);
  });

  it('is false for PRODUCTION + STOPPED', () => {
    expect(isBillableDeployment({ deploymentType: 'PRODUCTION', billingState: 'STOPPED' })).toBe(false);
  });

  it('is false for PRODUCTION + PAUSED', () => {
    expect(isBillableDeployment({ deploymentType: 'PRODUCTION', billingState: 'PAUSED' })).toBe(false);
  });
});

describe('countBillableDeployments', () => {
  it('counts only the billable rows', () => {
    const rows = [
      { deploymentType: 'PRODUCTION', billingState: 'ACTIVE' },
      { deploymentType: 'PRODUCTION', billingState: 'NOT_STARTED' },
      { deploymentType: 'PRODUCTION', billingState: 'STOPPED' },
      { deploymentType: 'TEST', billingState: 'NOT_STARTED' },
      { deploymentType: 'PRODUCTION', billingState: 'ACTIVE' },
    ] as const;
    expect(countBillableDeployments(rows)).toBe(2);
  });

  it('is 0 for an empty list', () => {
    expect(countBillableDeployments([])).toBe(0);
  });
});

describe('billableDeploymentQuantity (included production deployments)', () => {
  it('is the active count when nothing is included — the pre-allowance behavior', () => {
    expect(billableDeploymentQuantity(5, 0)).toBe(5);
    expect(billableDeploymentQuantity(0, 0)).toBe(0);
  });

  it('subtracts the pooled allowance', () => {
    expect(billableDeploymentQuantity(5, 2)).toBe(3);
  });

  it('is 0 when active equals the allowance', () => {
    expect(billableDeploymentQuantity(3, 3)).toBe(0);
  });

  it('never goes negative when the allowance exceeds the active count', () => {
    expect(billableDeploymentQuantity(1, 3)).toBe(0);
    expect(billableDeploymentQuantity(0, 10000)).toBe(0);
  });

  it('crosses the threshold one deployment at a time', () => {
    expect([0, 1, 2, 3, 4].map((active) => billableDeploymentQuantity(active, 2))).toEqual([0, 0, 0, 1, 2]);
  });
});

describe('productionDeploymentCounts', () => {
  it('reports active, paused, included and billable from the rows and the allowance', () => {
    const rows = [
      { deploymentType: 'PRODUCTION', billingState: 'ACTIVE' },
      { deploymentType: 'PRODUCTION', billingState: 'ACTIVE' },
      { deploymentType: 'PRODUCTION', billingState: 'ACTIVE' },
      { deploymentType: 'PRODUCTION', billingState: 'PAUSED' },
      { deploymentType: 'PRODUCTION', billingState: 'NOT_STARTED' },
      { deploymentType: 'TEST', billingState: 'ACTIVE' },
    ] as const;
    expect(productionDeploymentCounts(rows, 2)).toEqual({ active: 3, paused: 1, included: 2, billable: 1 });
  });

  it('a TEST deployment never consumes the allowance', () => {
    const rows = [
      { deploymentType: 'TEST', billingState: 'ACTIVE' },
      { deploymentType: 'TEST', billingState: 'NOT_STARTED' },
    ] as const;
    expect(productionDeploymentCounts(rows, 1)).toEqual({ active: 0, paused: 0, included: 1, billable: 0 });
  });
});

describe('display prices', () => {
  it('keeps the display-only platform and per-deployment prices', () => {
    expect(PLATFORM_PRICE_DOLLARS).toBe(49);
    expect(DEPLOYMENT_PRICE_DOLLARS).toBe(19);
  });
});
