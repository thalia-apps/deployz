import { describe, expect, it } from 'vitest';

import { connectorStackState, connectorUpdateEvent, connectorUpdateOffer } from './connector-update.js';

const bound = { region: 'us-east-1', state: 'HEALTHY', relayBoundAt: new Date(), bootstrapStackName: 'deployz-acme-1' };
const config = { buildId: 'abc123def456', legacyUrl: undefined, deployableRegions: ['us-east-1', 'us-east-2'] };

describe('connectorUpdateOffer', () => {
  it('points at the existing stack and the immutable versioned template of the published build', () => {
    const offer = connectorUpdateOffer(bound, config)!;
    expect(offer.publishedBuildId).toBe('abc123def456');
    expect(offer.templateUrl).toBe(
      'https://deployz-templates-us-east-1.s3.us-east-1.amazonaws.com/bootstrap/v1/versions/abc123def456/bootstrap-template-v1.json',
    );
    expect(offer.updateUrl).toBe(
      'https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks?filteringStatus=active&filteringText=deployz-acme-1',
    );
  });

  it('uses the regional bucket of the deployment', () => {
    expect(connectorUpdateOffer({ ...bound, region: 'us-east-2' }, config)!.templateUrl).toContain(
      'deployz-templates-us-east-2.s3.us-east-2.amazonaws.com/bootstrap/v1/versions/abc123def456/',
    );
  });

  it('falls back to the fixed latest template when the build id is unknown', () => {
    const offer = connectorUpdateOffer(bound, { ...config, buildId: undefined })!;
    expect(offer.publishedBuildId).toBeNull();
    expect(offer.templateUrl).toMatch(/bootstrap\/v1\/bootstrap-template-v1\.json$/);
  });

  it('offers nothing before enrollment or after removal, and no template for an unpublished region', () => {
    expect(connectorUpdateOffer({ ...bound, relayBoundAt: null }, config)).toBeNull();
    expect(connectorUpdateOffer({ ...bound, state: 'DELETED' }, config)).toBeNull();
    expect(connectorUpdateOffer({ ...bound, region: 'eu-west-1' }, config)!.templateUrl).toBeNull();
  });
});

describe('connectorStackState', () => {
  it('maps CloudFormation statuses to the connector stack state', () => {
    expect(connectorStackState('UPDATE_IN_PROGRESS')).toBe('UPDATING');
    expect(connectorStackState('UPDATE_ROLLBACK_IN_PROGRESS')).toBe('UPDATING');
    expect(connectorStackState('UPDATE_COMPLETE_CLEANUP_IN_PROGRESS')).toBe('UPDATING');
    expect(connectorStackState('UPDATE_ROLLBACK_COMPLETE')).toBe('ROLLED_BACK');
    expect(connectorStackState('UPDATE_ROLLBACK_FAILED')).toBe('FAILED');
    expect(connectorStackState('UPDATE_FAILED')).toBe('FAILED');
    expect(connectorStackState('CREATE_COMPLETE')).toBe('STABLE');
    expect(connectorStackState('UPDATE_COMPLETE')).toBe('STABLE');
    expect(connectorStackState('ROLLBACK_COMPLETE')).toBe('UNKNOWN');
    expect(connectorStackState(null)).toBe('UNKNOWN');
  });
});

describe('connectorUpdateEvent', () => {
  const event = (
    previous: { installedBuildId: string | null; status: string | null },
    next: { installedBuildId: string | null; status: string },
  ) => connectorUpdateEvent(previous, next, 'new');

  it('verifies a stable stack on the published build after an update', () => {
    expect(event({ installedBuildId: 'old', status: 'UPDATE_COMPLETE' }, { installedBuildId: 'new', status: 'UPDATE_COMPLETE' })).toBe(
      'connector.update_verified',
    );
    expect(event({ installedBuildId: 'new', status: 'UPDATE_IN_PROGRESS' }, { installedBuildId: 'new', status: 'UPDATE_COMPLETE' })).toBe(
      'connector.update_verified',
    );
    // An old relay never reported a status before the update.
    expect(event({ installedBuildId: 'old', status: null }, { installedBuildId: 'new', status: 'UPDATE_COMPLETE' })).toBe(
      'connector.update_verified',
    );
  });

  it('does not verify a fresh install, an unchanged stack or another build', () => {
    expect(event({ installedBuildId: 'new', status: null }, { installedBuildId: 'new', status: 'CREATE_COMPLETE' })).toBeNull();
    expect(event({ installedBuildId: 'new', status: 'CREATE_IN_PROGRESS' }, { installedBuildId: 'new', status: 'CREATE_COMPLETE' })).toBeNull();
    expect(event({ installedBuildId: 'new', status: 'UPDATE_COMPLETE' }, { installedBuildId: 'new', status: 'UPDATE_COMPLETE' })).toBeNull();
    expect(event({ installedBuildId: 'old', status: 'UPDATE_IN_PROGRESS' }, { installedBuildId: 'other', status: 'UPDATE_COMPLETE' })).toBeNull();
    expect(
      connectorUpdateEvent({ installedBuildId: 'old', status: 'UPDATE_IN_PROGRESS' }, { installedBuildId: 'new', status: 'UPDATE_COMPLETE' }, null),
    ).toBeNull();
  });

  it('records a rollback and an update failure on the first report only', () => {
    expect(event({ installedBuildId: 'old', status: 'UPDATE_ROLLBACK_IN_PROGRESS' }, { installedBuildId: 'old', status: 'UPDATE_ROLLBACK_COMPLETE' })).toBe(
      'connector.update_rolled_back',
    );
    expect(event({ installedBuildId: 'old', status: 'UPDATE_ROLLBACK_COMPLETE' }, { installedBuildId: 'old', status: 'UPDATE_ROLLBACK_COMPLETE' })).toBeNull();
    expect(event({ installedBuildId: 'old', status: 'UPDATE_ROLLBACK_IN_PROGRESS' }, { installedBuildId: 'old', status: 'UPDATE_ROLLBACK_FAILED' })).toBe(
      'connector.update_failed',
    );
    expect(event({ installedBuildId: 'old', status: 'DELETE_IN_PROGRESS' }, { installedBuildId: 'old', status: 'DELETE_FAILED' })).toBeNull();
  });
});
