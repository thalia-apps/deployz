import { JARGON_PATTERN } from '@deployz/copy-map';
import { describe, expect, it } from 'vitest';

import { DEPLOYMENT_STATES } from '../src/lib/deployment-vocabulary';
import {
  CUSTOMER_BUCKETS,
  CUSTOMER_BUCKET_BADGE,
  STATUS_FILTER_GROUPS,
  STATUS_GROUPS,
  STATUS_GROUP_LABELS,
  customerBucket,
  deploymentDisplayStatus,
  isStatusGroup,
  statusGroupRank,
} from '../src/lib/deployment-status-groups';
import type { FleetDeployment } from '../src/lib/deployments';
import { fleetDeployment } from './fixtures/fleet-deployment';

function withState(state: string, overrides: Parameters<typeof fleetDeployment>[0] = {}) {
  return fleetDeployment({ state: state as FleetDeployment['state'], ...overrides });
}

describe('deploymentDisplayStatus — precise labels', () => {
  it.each([
    ['NOT_INSTALLED', 'Waiting for customer', 'waiting'],
    ['WAITING_FOR_RELAY', 'Setting up', 'in-progress'],
    ['INSTALLING', 'Setting up', 'in-progress'],
    ['UPDATING', 'Updating', 'in-progress'],
    ['UPDATE_AVAILABLE', 'Live', 'update-available'],
    ['HEALTHY', 'Live', 'healthy'],
    ['DISCONNECTED', 'Needs attention · Disconnected', 'attention'],
    ['DELETING', 'Removing', 'in-progress'],
    ['DELETED', 'Removed', 'removed'],
  ] as const)('%s reads "%s" under %s', (state, label, group) => {
    expect(deploymentDisplayStatus(withState(state))).toMatchObject({ label, group });
  });

  it('marks a launch that has not connected past the staleness window, in the same group', () => {
    const started = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    expect(
      deploymentDisplayStatus(withState('WAITING_FOR_RELAY', { installStartedAt: started(5) })),
    ).toMatchObject({ label: 'Setting up', group: 'in-progress', badge: 'info' });
    expect(
      deploymentDisplayStatus(withState('WAITING_FOR_RELAY', { installStartedAt: started(20) })),
    ).toMatchObject({ label: 'Setting up · Slow to connect', group: 'in-progress', badge: 'warning' });
  });

  it('keeps a HEALTHY deployment live while its stage is still finishing HTTPS', () => {
    const status = deploymentDisplayStatus(
      withState('HEALTHY', { deploymentStatus: { stage: 'VERIFYING', step: 'TLS' } }),
    );
    expect(status).toMatchObject({ label: 'Live', group: 'healthy' });
  });
});

describe('deploymentDisplayStatus — not started', () => {
  it('reads Not started in a neutral tone, never as not responding', () => {
    const deployment = withState('HEALTHY', {
      healthStatus: 'UNHEALTHY',
      deploymentStatus: { health: { status: 'UNHEALTHY', notStarted: true } },
    });
    expect(deploymentDisplayStatus(deployment)).toMatchObject({
      label: 'Not started',
      group: 'in-progress',
      badge: 'secondary',
    });
    expect(customerBucket(deployment)).toBe('pending');
  });
});

describe('deploymentDisplayStatus — FAILED kinds', () => {
  it('reads as "Install failed" for a first install with no prior release', () => {
    const status = deploymentDisplayStatus(withState('FAILED', { currentReleaseId: null }));
    expect(status).toMatchObject({ label: 'Install failed', group: 'attention', badge: 'destructive' });
  });

  it('reads as "Removal failed" when the failed job is DESTROY', () => {
    const status = deploymentDisplayStatus(
      withState('FAILED', { deploymentStatus: { job: { type: 'DESTROY', status: 'FAILED' } } as never }),
    );
    expect(status).toMatchObject({ label: 'Removal failed', group: 'attention', badge: 'destructive' });
  });

  it('reads as "Update failed" for a failed day-2 job on a deployment that had already installed', () => {
    const status = deploymentDisplayStatus(
      withState('FAILED', {
        currentReleaseId: 'rel-1',
        deploymentStatus: { job: { type: 'DEPLOY_RELEASE', status: 'FAILED' } } as never,
      }),
    );
    expect(status).toMatchObject({ label: 'Update failed', group: 'attention', badge: 'destructive' });
  });

  it('reads as "Install failed" for a failed day-2 job when nothing ever installed', () => {
    const status = deploymentDisplayStatus(
      withState('FAILED', {
        currentReleaseId: null,
        deploymentStatus: { job: { type: 'DEPLOY_RELEASE', status: 'FAILED' } } as never,
      }),
    );
    expect(status).toMatchObject({ label: 'Install failed' });
  });
});

describe('deploymentDisplayStatus — attention overlays', () => {
  it('names the cause behind a running deployment that needs the vendor', () => {
    expect(deploymentDisplayStatus(withState('HEALTHY', { relayStatus: 'DISCONNECTED' }))).toMatchObject({
      label: 'Needs attention · Lost contact',
      group: 'attention',
    });
    expect(deploymentDisplayStatus(withState('HEALTHY', { healthStatus: 'UNHEALTHY' }))).toMatchObject({
      label: 'Needs attention · Not responding',
      badge: 'destructive',
    });
    expect(deploymentDisplayStatus(withState('UPDATE_AVAILABLE', { healthStatus: 'DEGRADED' }))).toMatchObject({
      label: 'Needs attention · Degraded',
      badge: 'warning',
    });
  });

  it('reads a failed day-2 attempt on a still-live deployment as "Update failed"', () => {
    const status = deploymentDisplayStatus(
      withState('HEALTHY', { deploymentStatus: { failure: { message: 'boom' } } as never }),
    );
    expect(status).toMatchObject({ label: 'Update failed', group: 'attention', badge: 'destructive' });
  });

  it('a failed update outranks failing health, matching the detail page headline', () => {
    const status = deploymentDisplayStatus(
      withState('HEALTHY', {
        healthStatus: 'UNHEALTHY',
        deploymentStatus: { failure: { message: 'boom' } } as never,
      }),
    );
    expect(status).toMatchObject({ label: 'Update failed' });
  });

  it('never flags a deployment that is waiting or on its way out', () => {
    for (const state of ['NOT_INSTALLED', 'WAITING_FOR_RELAY', 'DELETING', 'DELETED']) {
      const status = deploymentDisplayStatus(
        withState(state, { relayStatus: 'DISCONNECTED', healthStatus: 'UNHEALTHY' }),
      );
      expect(status.group, state).not.toBe('attention');
    }
  });

  it('surfaces a status this build does not know as attention, without leaking the raw value', () => {
    const status = deploymentDisplayStatus(withState('PAUSED_BY_FUTURE_FEATURE'));
    expect(status).toEqual({ group: 'attention', label: 'Needs attention · Unknown status', badge: 'warning' });
  });
});

describe('vocabulary guardrails', () => {
  it('has a label, a rank and a filter slot for every group', () => {
    for (const group of STATUS_GROUPS) {
      expect(STATUS_GROUP_LABELS[group]).toBeTruthy();
      expect(STATUS_FILTER_GROUPS).toContain(group);
      expect(statusGroupRank(group)).toBe(STATUS_GROUPS.indexOf(group));
    }
    expect(new Set(STATUS_FILTER_GROUPS).size).toBe(STATUS_GROUPS.length);
  });

  it('ranks attention first and removed last', () => {
    expect(STATUS_GROUPS[0]).toBe('attention');
    expect(STATUS_GROUPS.at(-1)).toBe('removed');
    expect(isStatusGroup('attention')).toBe(true);
    expect(isStatusGroup('DELETED')).toBe(false);
  });

  it('never shows raw enums or AWS jargon in any label the list can render', () => {
    const labels = [
      ...Object.values(STATUS_GROUP_LABELS),
      ...DEPLOYMENT_STATES.flatMap((state) => [
        deploymentDisplayStatus(withState(state)).label,
        deploymentDisplayStatus(withState(state, { relayStatus: 'DISCONNECTED' })).label,
      ]),
    ];
    for (const label of labels) {
      expect(label, label).not.toMatch(JARGON_PATTERN);
      expect(label, label).not.toMatch(/_/);
    }
  });
});

describe('customerBucket', () => {
  it.each([
    ['HEALTHY', 'active'],
    ['UPDATE_AVAILABLE', 'active'],
    ['UPDATING', 'active'],
    ['FAILED', 'attention'],
    ['DISCONNECTED', 'attention'],
    ['NOT_INSTALLED', 'pending'],
    ['WAITING_FOR_RELAY', 'pending'],
    ['INSTALLING', 'pending'],
    ['DELETING', 'removing'],
    ['DELETED', 'removed'],
    ['SOMETHING_NEW', 'attention'],
  ])('%s counts as %s', (state, bucket) => {
    expect(customerBucket(withState(state))).toBe(bucket);
  });

  it('counts a running deployment that lost contact as attention, like the list does', () => {
    expect(customerBucket(withState('HEALTHY', { relayStatus: 'DISCONNECTED' }))).toBe('attention');
  });

  it('has a badge for every bucket', () => {
    for (const bucket of CUSTOMER_BUCKETS) expect(CUSTOMER_BUCKET_BADGE[bucket]).toBeDefined();
  });
});
