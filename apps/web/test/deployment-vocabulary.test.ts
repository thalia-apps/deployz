import { describe, expect, it } from 'vitest';

import {
  DEPLOYMENT_STATE_BADGE,
  DEPLOYMENT_STATE_LABELS,
  DEPLOYMENT_STATES,
  INSTALL_COMPONENT_LABELS,
  eventFailureReason,
  eventFamily,
  eventResultLabel,
  eventTypeLabel,
  everInstalled,
  actionsUnavailableReason,
  relayWaitingStuck,
  showHealthBadge,
  showInfrastructureRows,
} from '../src/lib/deployment-vocabulary';

// Locks the §46/§65 guardrail: the fleet surfaces use ONLY the 10
// product-vocabulary states and jargon-free event labels — no raw
// AWS/CFN/ECS/ALB/IAM/Lambda/VPC terms reach the UI edge.

const JARGON = /\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC|CFN)\b/i;

describe('§46 deployment states', () => {
  it('defines exactly the 10 product-vocabulary states', () => {
    expect(DEPLOYMENT_STATES).toEqual([
      'NOT_INSTALLED',
      'WAITING_FOR_RELAY',
      'INSTALLING',
      'HEALTHY',
      'UPDATING',
      'UPDATE_AVAILABLE',
      'FAILED',
      'DISCONNECTED',
      'DELETING',
      'DELETED',
    ]);
  });

  it('maps every state to a non-empty, jargon-free label', () => {
    for (const state of DEPLOYMENT_STATES) {
      const label = DEPLOYMENT_STATE_LABELS[state];
      expect(label, `label for ${state}`).toBeTruthy();
      expect(label, `label for ${state}`).not.toMatch(JARGON);
    }
  });

  it('uses the plan §46 product wording for the key states', () => {
    expect(DEPLOYMENT_STATE_LABELS.HEALTHY).toBe('Healthy');
    expect(DEPLOYMENT_STATE_LABELS.INSTALLING).toBe('Installing');
    expect(DEPLOYMENT_STATE_LABELS.FAILED).toBe('Failed');
    expect(DEPLOYMENT_STATE_LABELS.UPDATE_AVAILABLE).toBe('Update available');
  });

  it('marks FAILED and DISCONNECTED as destructive', () => {
    expect(DEPLOYMENT_STATE_BADGE.FAILED).toBe('destructive');
    expect(DEPLOYMENT_STATE_BADGE.DISCONNECTED).toBe('destructive');
  });
});

describe('WAITING_FOR_RELAY grouping', () => {
  it('uses the copy-map wording and the neutral badge', () => {
    expect(DEPLOYMENT_STATE_LABELS.WAITING_FOR_RELAY).toBe('Waiting for AWS');
    expect(DEPLOYMENT_STATE_BADGE.WAITING_FOR_RELAY).toBe('secondary');
  });

  it('has not completed an install — grouped with NOT_INSTALLED', () => {
    for (const currentReleaseId of [null, 'r1']) {
      expect(everInstalled('WAITING_FOR_RELAY', currentReleaseId)).toBe(false);
      expect(everInstalled('WAITING_FOR_RELAY', currentReleaseId)).toBe(
        everInstalled('NOT_INSTALLED', currentReleaseId),
      );
    }
    expect(showHealthBadge('WAITING_FOR_RELAY')).toBe(false);
    expect(showInfrastructureRows('WAITING_FOR_RELAY')).toBe(false);
    expect(showInfrastructureRows('WAITING_FOR_RELAY')).toBe(
      showInfrastructureRows('NOT_INSTALLED'),
    );
  });
});

describe('relayWaitingStuck', () => {
  const now = Date.parse('2026-08-31T12:00:00.000Z');

  it('is false when nothing has launched yet', () => {
    expect(relayWaitingStuck(null, now)).toBe(false);
  });

  it('is false within the 15-minute staleness window', () => {
    expect(relayWaitingStuck('2026-08-31T11:59:00.000Z', now)).toBe(false);
    // Exactly 15 minutes is still inside the window — the API uses a strict >.
    expect(relayWaitingStuck('2026-08-31T11:45:00.000Z', now)).toBe(false);
  });

  it('is true past the 15-minute staleness window', () => {
    expect(relayWaitingStuck('2026-08-31T11:44:59.000Z', now)).toBe(true);
    expect(relayWaitingStuck('2026-08-31T11:00:00.000Z', now)).toBe(true);
  });
});

describe('install component labels', () => {
  it('labels the §24 component view in install-page display order', () => {
    expect(INSTALL_COMPONENT_LABELS).toEqual([
      ['application', 'Application'],
      ['loadBalancer', 'Load balancer'],
      ['database', 'Database'],
      ['storage', 'Storage'],
      ['redis', 'Redis cache'],
    ]);
  });
});

describe('§65 event-type labels', () => {
  it('classifies the six §40 families', () => {
    expect(eventFamily('deploy.state.updating')).toBe('deploy');
    expect(eventFamily('rollback.restore')).toBe('rollback');
    expect(eventFamily('config.write')).toBe('config');
    expect(eventFamily('health.report')).toBe('health');
    expect(eventFamily('install.state.healthy')).toBe('install');
    expect(eventFamily('destroy.state.started')).toBe('destroy');
    expect(eventFamily('billing.usage')).toBeNull();
  });

  it('maps known workflow event types to human labels', () => {
    expect(eventTypeLabel('deploy.state.updating')).toBe('Update started');
    expect(eventTypeLabel('rollback.restore')).toBe('Previous version restored');
    expect(eventTypeLabel('install.state.healthy')).toBe('Installed and healthy');
    expect(eventTypeLabel('deploy.state.update-available')).toBe('Update available');
  });

  it('falls back to a family label for an unknown type (never raw)', () => {
    expect(eventTypeLabel('health.report')).toBe('Health');
    expect(eventTypeLabel('destroy.state.started')).toBe('Teardown');
  });

  it('classifies the redis family and maps its known event types', () => {
    expect(eventFamily('redis.provision.started')).toBe('redis');
    expect(eventTypeLabel('redis.provision.started')).toBe('Setting up cache');
    expect(eventTypeLabel('redis.provision.succeeded')).toBe('Cache ready');
    expect(eventTypeLabel('redis.provision.failed')).toBe('Cache setup failed');
  });

  it('produces no raw AWS terms for any known or fallback label', () => {
    for (const type of [
      'install.preflight.region',
      'install.preflight.scp',
      'install.relay.contact',
      'install.state.installing',
      'install.relay.health',
      'install.state.healthy',
      'deploy.preflight',
      'deploy.state.updating',
      'deploy.migration',
      'deploy.ecs-update',
      'deploy.infra-upgrade',
      'deploy.health',
      'deploy.state.healthy',
      'deploy.state.update-available',
      'rollback.state.updating',
      'rollback.disclosure',
      'rollback.restore',
      'rollback.health',
      'rollback.state.healthy',
      'config.validate',
      'config.write',
      'config.health',
      'config.state.healthy',
      'destroy.state.started',
      'health.report',
    ]) {
      expect(eventTypeLabel(type), `label for ${type}`).not.toMatch(JARGON);
    }
  });
});

describe('§62 event result labels', () => {
  it('maps results to jargon-free labels', () => {
    expect(eventResultLabel('ok')).toBe('Succeeded');
    expect(eventResultLabel('passed')).toBe('Succeeded');
    expect(eventResultLabel('success')).toBe('Succeeded');
    expect(eventResultLabel('skipped')).toBe('Skipped');
    expect(eventResultLabel('failed:MIGRATION_FAILED')).toBe('Failed');
    expect(eventResultLabel('failure')).toBe('Failed');
    expect(eventResultLabel(null)).toBeNull();
  });

  it('renders no badge for a pending result — a historical request is a fact, not ongoing state', () => {
    expect(eventResultLabel('pending')).toBeNull();
  });
});

describe('eventFailureReason', () => {
  it('surfaces payload.error for a failed result', () => {
    expect(eventFailureReason('failed:MIGRATION_FAILED', { error: 'Column already exists' })).toBe(
      'Column already exists',
    );
    // The API writes job-result events with the bare 'failure' result — the
    // form every relay-reported failure actually reaches the feed as.
    expect(eventFailureReason('failure', { error: 'No ECS service found in stack "deployz-app"' })).toBe(
      'No ECS service found in stack "deployz-app"',
    );
  });

  it('returns null for a non-failed result even with an error payload', () => {
    expect(eventFailureReason('ok', { error: 'stale leftover text' })).toBeNull();
    expect(eventFailureReason(null, { error: 'stale leftover text' })).toBeNull();
  });

  it('returns null for a failed result with no usable payload.error', () => {
    expect(eventFailureReason('failed:MIGRATION_FAILED', {})).toBeNull();
    expect(eventFailureReason('failed:MIGRATION_FAILED', { error: '' })).toBeNull();
    expect(eventFailureReason('failed:MIGRATION_FAILED', { error: '   ' })).toBeNull();
    expect(eventFailureReason('failed:MIGRATION_FAILED', { error: 42 })).toBeNull();
  });
});

// The reason the day-2 actions are unavailable. A deployment being removed is
// gated by its own lifecycle, not by the connector: the canary showed
// "not supported by the currently installed Deployz connector" during a
// disconnect, sending the vendor to check a connector that was fine. Order
// mirrors the API's gates in call order (apps/api/src/server.ts): lifecycle
// → never-installed → relay liveness → busy operation → connector
// capabilities.
describe('actionsUnavailableReason', () => {
  it('blames the lifecycle, not the connector, while a deployment is being removed', () => {
    const reason = actionsUnavailableReason({
      state: 'DELETING',
      everRan: true,
      relayStatus: 'CONNECTED',
      anyCapabilityGatedOff: true,
    });
    expect(reason).toContain('being removed');
    expect(reason).not.toContain('connector');
  });

  it('says a removed deployment no longer takes actions', () => {
    expect(
      actionsUnavailableReason({
        state: 'DELETED',
        everRan: true,
        relayStatus: 'CONNECTED',
        anyCapabilityGatedOff: false,
      }),
    ).toContain('has been removed');
  });

  it('blames the running operation, not the connector, while one owns the deployment', () => {
    const reason = actionsUnavailableReason({
      state: 'UPDATING',
      everRan: true,
      relayStatus: 'CONNECTED',
      busy: true,
      anyCapabilityGatedOff: true,
    });
    expect(reason).toContain('when this operation finishes');
    expect(reason).not.toContain('connector');
  });

  it('falls back to the connector once the operation settles', () => {
    expect(
      actionsUnavailableReason({
        state: 'UPDATING',
        everRan: true,
        relayStatus: 'CONNECTED',
        busy: false,
        anyCapabilityGatedOff: true,
      }),
    ).toContain('connector');
  });

  it('still explains a never-installed deployment and a gated connector', () => {
    expect(
      actionsUnavailableReason({
        state: 'FAILED',
        everRan: false,
        relayStatus: 'CONNECTED',
        anyCapabilityGatedOff: false,
      }),
    ).toContain("hasn't completed an install");
    expect(
      actionsUnavailableReason({
        state: 'HEALTHY',
        everRan: true,
        relayStatus: 'CONNECTED',
        anyCapabilityGatedOff: true,
      }),
    ).toContain('connector');
  });

  it('is null when every action is available', () => {
    expect(
      actionsUnavailableReason({
        state: 'HEALTHY',
        everRan: true,
        relayStatus: 'CONNECTED',
        anyCapabilityGatedOff: false,
      }),
    ).toBeNull();
  });

  // §16.4: an offline relay must disable the day-2 actions up front, exactly
  // as the API refuses them (RELAY_DISCONNECTED / RELAY_NOT_CONNECTED). The
  // liveness reason outranks the capability copy — a connector that simply
  // is not there cannot be "not supporting" the action.
  it('gates on a disconnected relay before the connector capabilities', () => {
    const reason = actionsUnavailableReason({
      state: 'HEALTHY',
      everRan: true,
      relayStatus: 'DISCONNECTED',
      anyCapabilityGatedOff: true,
    });
    expect(reason).toContain('Deployz connector is offline');
    expect(reason).not.toContain('not supported');
  });

  it('gates on a relay that has never connected', () => {
    expect(
      actionsUnavailableReason({
        state: 'HEALTHY',
        everRan: true,
        relayStatus: 'UNKNOWN',
        anyCapabilityGatedOff: false,
      }),
    ).toContain('The Deployz connector has not connected');
  });

  it('reports the missing capability only once the relay is online', () => {
    expect(
      actionsUnavailableReason({
        state: 'HEALTHY',
        everRan: true,
        relayStatus: 'CONNECTED',
        anyCapabilityGatedOff: true,
      }),
    ).toContain('connector');
  });
});

describe('deploy link events', () => {
  it('labels every deploy_link event type in jargon-free copy', () => {
    expect(eventTypeLabel('deploy_link.created')).toBe('Deploy link created');
    expect(eventTypeLabel('deploy_link.opened')).toBe('Customer opened the deploy link');
    expect(eventTypeLabel('deploy_link.launched')).toBe('Customer started the deployment');
    expect(eventTypeLabel('deploy_link.retry.requested')).toBe('Customer retried the deployment');
    expect(eventTypeLabel('deploy_link.revoked')).toBe('Deploy link revoked');
    expect(eventTypeLabel('deploy_link.regenerated')).toBe('Deploy link regenerated');
  });

  it('groups deploy_link events under one family', () => {
    expect(eventFamily('deploy_link.created')).toBe('deploy_link');
    expect(eventFamily('deploy_link.retry.requested')).toBe('deploy_link');
    expect(eventFamily('deploy_link.revoked')).toBe('deploy_link');
  });
});
