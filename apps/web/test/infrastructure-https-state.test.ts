import { describe, expect, it } from 'vitest';

import type { InfrastructureHttpsState } from '../src/lib/deployments';
import {
  INFRASTRUCTURE_HTTPS_STATE_LABEL,
  INFRASTRUCTURE_STATUS_LABEL,
  infrastructureComponentStatusLabel,
  connectorPresence,
  operationalComponentStatus,
  operationalSummaryStatus,
  purgeProgress,
  retainedUntilDeletedSentence,
} from '../src/lib/deployment-vocabulary';

describe('infrastructure HTTPS state vocabulary', () => {
  it('every https state has a non-empty label', () => {
    const states: InfrastructureHttpsState[] = [
      'SETTING_UP',
      'WAITING_FOR_CERTIFICATE',
      'ACTIVATING',
      'READY',
      'FAILED',
      'REMOVING',
    ];
    for (const state of states) {
      expect(INFRASTRUCTURE_HTTPS_STATE_LABEL[state]).toBeTruthy();
    }
  });

  it('prefers the https label when httpsState is set', () => {
    expect(
      infrastructureComponentStatusLabel({ status: 'provisioning', httpsState: 'WAITING_FOR_CERTIFICATE' }),
    ).toBe('Waiting for certificate');
  });

  it('falls back to the status label when httpsState is absent', () => {
    expect(infrastructureComponentStatusLabel({ status: 'ready' })).toBe(
      INFRASTRUCTURE_STATUS_LABEL.ready,
    );
    expect(infrastructureComponentStatusLabel({ status: 'ready' })).toBe('Ready');
  });

  it('never reads as being set up while the deployment is being removed', () => {
    for (const httpsState of ['SETTING_UP', 'WAITING_FOR_CERTIFICATE', 'ACTIVATING'] as const) {
      expect(infrastructureComponentStatusLabel({ status: 'provisioning', httpsState }, 'DELETING')).toBe(
        'Removing',
      );
    }
    expect(infrastructureComponentStatusLabel({ status: 'failed', httpsState: 'FAILED' }, 'DELETING')).toBe(
      'Failed',
    );
    expect(infrastructureComponentStatusLabel({ status: 'provisioning', httpsState: 'SETTING_UP' }, 'HEALTHY')).toBe(
      'Setting up',
    );
  });

  it('reads a component that is still provisioning as deleting during removal', () => {
    expect(operationalComponentStatus({ status: 'provisioning', resources: [] }, 'DELETING')).toBe('deleting');
    expect(operationalComponentStatus({ status: 'provisioning', resources: [] }, 'INSTALLING')).toBe('provisioning');
  });
});

describe('retained data purge progress', () => {
  const purgeJob = (state: string, createdAt = '2026-10-13T10:00:00.000Z') =>
    ({ type: 'PURGE', state, createdAt }) as never;
  const detail = (overrides: Record<string, unknown>) =>
    ({ state: 'DELETED', cleanupState: 'SKIPPED_RELAY_OFFLINE', jobs: [], ...overrides }) as never;

  it('is running while the latest PURGE job is active', () => {
    expect(purgeProgress(detail({ jobs: [purgeJob('REQUESTED')] }))).toBe('running');
    expect(purgeProgress(detail({ jobs: [purgeJob('RUNNING')] }))).toBe('running');
  });

  it('is complete after a verified purge and null otherwise', () => {
    expect(purgeProgress(detail({ cleanupState: 'COMPLETE', jobs: [purgeJob('SUCCEEDED')] }))).toBe('complete');
    expect(purgeProgress(detail({ cleanupState: 'PURGE_FAILED', jobs: [purgeJob('FAILED')] }))).toBeNull();
    expect(purgeProgress(detail({ cleanupState: 'CONFIRMED_BY_OWNER' }))).toBe('confirmed');
    expect(purgeProgress(detail({ state: 'DELETING', jobs: [purgeJob('RUNNING')] }))).toBeNull();
  });

  it('a retry after a failed purge counts as running', () => {
    const jobs = [purgeJob('FAILED', '2026-10-13T09:00:00.000Z'), purgeJob('RUNNING')];
    expect(purgeProgress(detail({ cleanupState: 'PURGE_FAILED', jobs }))).toBe('running');
  });

  it('shows retained components as deleting, then removed, instead of retained', () => {
    const storage = { status: 'retained', resources: [] } as never;
    expect(operationalComponentStatus(storage, 'DELETED', 'running')).toBe('deleting');
    expect(operationalComponentStatus(storage, 'DELETED', 'complete')).toBe('removed');
    expect(operationalComponentStatus(storage, 'DELETED')).toBe('retained');
    const data = { summary: { status: 'retained' }, components: [storage] } as never;
    expect(operationalSummaryStatus(data, 'DELETED', 'running')).toBe('deleting');
  });
});

describe('retainedUntilDeletedSentence', () => {
  it('agrees the verb with one or several kinds', () => {
    expect(retainedUntilDeletedSentence(['Storage'])).toBe('Storage stays until you delete it');
    expect(retainedUntilDeletedSentence(['Database', 'Storage'])).toBe(
      'Database and Storage stay until you delete them',
    );
    expect(retainedUntilDeletedSentence(['Database', 'Cache', 'Storage'])).toBe(
      'Database, Cache, and Storage stay until you delete them',
    );
  });
});

describe('connectorPresence', () => {
  const now = Date.parse('2026-11-13T12:00:00Z');
  it('reads the connector\'s last contact after a verified purge', () => {
    expect(connectorPresence(null, now)).toBe('unknown');
    expect(connectorPresence('not a date', now)).toBe('unknown');
    expect(connectorPresence('2026-11-13T11:55:00Z', now)).toBe('still-installed');
    expect(connectorPresence('2026-11-13T11:45:00Z', now)).toBe('silent');
    expect(connectorPresence('2026-11-10T11:45:00Z', now)).toBe('silent');
  });
});
