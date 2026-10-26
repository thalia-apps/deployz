import { JSDOM } from 'jsdom';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { SpecComponent, VendorDeploymentStatus } from '@deployz/contracts';

import { DeploymentProgressCard } from '../src/components/deployment-progress-card';

// Phase 3 presence/absence duality: when the vendor status carries the
// additive `specComponents`, the component dot list reads those entries;
// without the field, the legacy component list renders exactly as before.
// The Relay / Latest job / AWS stack technical rows render in both cases.

const baseStatus: VendorDeploymentStatus = {
  stage: 'PROVISIONING',
  updatedAt: '2026-09-18T00:00:00.000Z',
  currentActivity: 'Creating the database.',
  step: 'DATABASE_STORAGE',
  steps: [
    'AWS_SETUP',
    'RELAY_CONNECT',
    'PREPARING',
    'NETWORK',
    'DATABASE_STORAGE',
    'APPLICATION',
    'HEALTH_CHECK',
    'TLS',
    'READY',
  ],
  typicalDurationSeconds: { min: 180, max: 600 },
  takingLongerThanUsual: false,
  stepStartedAt: null,
  stepTimings: [],
  statusUpdatesUnavailable: false,
  needsDomainSetup: false,
  components: [{ key: 'runtime', label: 'Application runtime', status: 'READY' }],
  relay: { connected: true, lastSeenAt: null },
  job: null,
  aws: { stackStatus: null },
  health: {
    status: 'HEALTHY',
    layers: { infrastructure: 'UNKNOWN', rollout: null, targets: null, http: null, relay: 'CONNECTED' },
    notStarted: false,
  },
  servingRelease: { releaseId: null, confirmedAt: null, confirmed: false },
  connector: { upgradeRequired: false, reason: null, updateAvailable: false, updateUrl: null, updateTemplateUrl: null, installedBuildId: null, publishedBuildId: null, stackState: 'UNKNOWN' as const, observedAt: null },
  url: null,
  failure: null,
};

const SPEC_COMPONENTS: SpecComponent[] = [
  { componentId: 'network', label: 'Private network', state: 'COMPLETE' },
  { componentId: 'database', label: 'MySQL', state: 'IN_PROGRESS' },
  { componentId: 'other', label: 'Other resources', state: 'PENDING', detail: 'AWS::S3::Bucket' },
];

function render(status: VendorDeploymentStatus): Document {
  return new JSDOM(renderToString(<DeploymentProgressCard status={status} deploymentState="INSTALLING" />))
    .window.document;
}

describe('DeploymentProgressCard — spec-derived components (phase 3)', () => {
  it('renders the spec component list when specComponents is present, replacing the legacy list', () => {
    const doc = render({ ...baseStatus, specComponents: SPEC_COMPONENTS });
    const text = doc.body.textContent ?? '';
    expect(text).toContain('Private network');
    expect(text).toContain('Complete');
    expect(text).toContain('MySQL');
    expect(text).toContain('In progress');
    expect(text).toContain('Other resources');
    expect(text).toContain('Waiting');
    // The legacy component list is replaced, not duplicated.
    expect(text).not.toContain('Application runtime');
    expect(doc.querySelectorAll('[data-testid="vendor-spec-component"]').length).toBe(3);
    // The vendor technical surface stays: relay, latest job slot, last update.
    expect(text).toContain('Deployz connector');
    expect(text).toContain('Last update');
  });

  it('falls back to the legacy component list when specComponents is absent', () => {
    const doc = render(baseStatus);
    const text = doc.body.textContent ?? '';
    expect(text).toContain('Application runtime');
    expect(text).toContain('Ready');
    expect(text).not.toContain('Private network');
    expect(doc.querySelectorAll('[data-testid="vendor-spec-component"]').length).toBe(0);
    expect(text).toContain('Deployz connector');
  });
});
