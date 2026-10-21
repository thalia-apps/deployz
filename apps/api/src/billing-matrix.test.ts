import { describe, expect, it } from 'vitest';

import type { DeploymentBillingState, DeploymentType } from '@deployz/contracts';

import { applyBillingTransition, isBillableDeployment, type BillingEvent } from './billing-domain.js';
import { mapSubscriptionStatus } from './billing-webhooks.js';

// Paddle migration Phase 15 — the billing matrix, exhaustively. The suites
// beside this one test behaviour by story; this one walks every cell of the
// pure decision tables so a gap is a failing test, not an oversight. The
// human-readable version of the same tables is docs/billing/billing-matrix.md
// — keep the two in step.

const NOW = new Date('2026-09-08T00:00:00.000Z');

const TYPES: DeploymentType[] = ['TEST', 'PRODUCTION'];
const STATES: DeploymentBillingState[] = ['NOT_STARTED', 'ACTIVE', 'PAUSED', 'STOPPED'];
const EVENTS: BillingEvent[] = ['LIVE', 'NOT_SERVING', 'REMOVED'];

/** Every (type, state, event) cell and the ONLY patch it may produce. */
const TRANSITIONS = TYPES.flatMap((deploymentType) =>
  STATES.flatMap((billingState) =>
    EVENTS.map((event) => {
      let expected: ReturnType<typeof applyBillingTransition>;
      if (deploymentType === 'TEST') expected = null; // never billable, whatever happens
      else if (billingState === 'STOPPED') expected = null; // terminal
      else if (event === 'LIVE')
        expected =
          billingState === 'NOT_STARTED'
            ? { billingState: 'ACTIVE', billingStartedAt: NOW }
            : billingState === 'PAUSED'
              ? { billingState: 'ACTIVE' } // resume; billingStartedAt is write-once
              : null;
      else if (event === 'NOT_SERVING')
        expected = billingState === 'ACTIVE' ? { billingState: 'PAUSED' } : null; // never-live stays unbilled
      else expected = { billingState: 'STOPPED', billingStoppedAt: NOW };
      return { deploymentType, billingState, event, expected };
    }),
  ),
);

describe('billing transition matrix — all 24 cells', () => {
  it('covers every cell exactly once', () => {
    expect(TRANSITIONS).toHaveLength(TYPES.length * STATES.length * EVENTS.length);
  });

  it.each(TRANSITIONS)(
    '$deploymentType + $billingState + $event -> $expected',
    ({ deploymentType, billingState, event, expected }) => {
      expect(applyBillingTransition({ deploymentType, billingState }, event, NOW)).toEqual(expected);
    },
  );

  it('a TEST deployment produces no patch from any cell — the single most important row', () => {
    for (const billingState of STATES)
      for (const event of EVENTS)
        expect(applyBillingTransition({ deploymentType: 'TEST', billingState }, event, NOW)).toBeNull();
  });
});

describe('billable predicate — all 8 cells', () => {
  it.each(
    TYPES.flatMap((deploymentType) =>
      STATES.map((billingState) => ({
        deploymentType,
        billingState,
        billable: deploymentType === 'PRODUCTION' && billingState === 'ACTIVE',
      })),
    ),
  )('$deploymentType + $billingState billable: $billable', ({ deploymentType, billingState, billable }) => {
    expect(isBillableDeployment({ deploymentType, billingState })).toBe(billable);
  });
});

describe('Paddle subscription status -> Deployz status', () => {
  it.each([
    ['active', 'ACTIVE'],
    // Deployz sells no trials, but Paddle can still report one; it bills, so it is ACTIVE.
    ['trialing', 'ACTIVE'],
    ['past_due', 'PAST_DUE'],
    ['paused', 'PAUSED'],
    ['canceled', 'CANCELED'],
  ] as const)('%s -> %s', (paddle, ours) => {
    expect(mapSubscriptionStatus(paddle)).toBe(ours);
  });

  it.each(['', 'unknown', 'ACTIVE', 'deleted', 'incomplete'])(
    'anything Paddle might add later (%s) is ignored, never guessed',
    (paddle) => {
      expect(mapSubscriptionStatus(paddle)).toBeUndefined();
    },
  );
});
