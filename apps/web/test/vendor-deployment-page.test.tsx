import { JSDOM } from 'jsdom';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { InfrastructureSummary } from '../src/components/infrastructure-summary';
import { activityEventLabel } from '../src/lib/activity';
import type {
  ActivityEvent,
  FleetDeploymentDetail,
  InfrastructureComponent,
  InfrastructureResource,
  InfrastructureResponse,
} from '../src/lib/deployments';
import {
  operationalComponentStatus,
  operationalSummaryStatus,
  visibleResources,
} from '../src/lib/deployment-vocabulary';
import { infraCheckReport, type InfraCheck } from '../src/lib/diagnostics';
import { updateTargetRelease, type Release } from '../src/lib/releases';

import { makeInfrastructureResponse } from './fixtures/infrastructure';

// The vendor deployment detail and diagnostics pages: update target,
// operational vs. retention status, resource counts, activity labels, and
// the infrastructure-check outcome.

function release(overrides: Partial<Release>): Release {
  return {
    id: 'r',
    version: 'v1.0.0',
    status: 'READY',
    failureReason: null,
    gitSha: 'a'.repeat(40),
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function resource(status: string, physicalId: string): InfrastructureResource {
  return { logicalId: 'AppStorage', physicalId, type: 'AWS::S3::Bucket', status, statusReason: null };
}

function storage(resources: InfrastructureResource[]): InfrastructureComponent {
  return {
    kind: 'storage',
    name: 'Storage',
    purpose: '',
    status: 'retained',
    awsService: 'S3',
    region: 'us-east-2',
    lifecycle: 'retain',
    resources,
  };
}

// A retry after a rolled-back first install: the first attempt's bucket was
// kept (DELETE_SKIPPED), its policy deleted; the retry's resources run.
const AFTER_RETRY = [
  resource('CREATE_COMPLETE', 'bucket-2'),
  resource('DELETE_SKIPPED', 'bucket-1'),
  resource('DELETE_COMPLETE', 'policy-1'),
];

describe('updateTargetRelease', () => {
  const current = release({ id: 'cur', version: 'v1.0.0', createdAt: '2026-09-01T00:00:00.000Z' });

  it('names the newest READY release created after the running one', () => {
    const releases = [
      current,
      release({ id: 'a', version: 'v1.1.0', createdAt: '2026-09-02T00:00:00.000Z' }),
      release({ id: 'b', version: 'v1.2.0', createdAt: '2026-09-03T00:00:00.000Z' }),
      release({ id: 'c', version: 'v1.3.0', status: 'BUILDING', createdAt: '2026-09-04T00:00:00.000Z' }),
    ];
    expect(updateTargetRelease(releases, 'cur')?.version).toBe('v1.2.0');
  });

  it('never guesses: no newer READY release or an unknown running release gives null', () => {
    const older = release({ id: 'old', version: 'v0.9.0', createdAt: '2026-08-01T00:00:00.000Z' });
    expect(updateTargetRelease([current, older], 'cur')).toBeNull();
    expect(updateTargetRelease([older], 'cur')).toBeNull();
    expect(updateTargetRelease([older], null)).toBeNull();
  });
});

describe('operational infrastructure status', () => {
  it('lists and counts only resources that still exist while the deployment exists', () => {
    expect(visibleResources(AFTER_RETRY, 'HEALTHY').map((r) => r.physicalId)).toEqual([
      'bucket-2',
      'bucket-1',
    ]);
    expect(visibleResources(AFTER_RETRY, 'DELETED')).toHaveLength(3);
  });

  it('reads a retained component with running resources as ready on a live deployment', () => {
    expect(operationalComponentStatus(storage(AFTER_RETRY), 'HEALTHY')).toBe('ready');
    expect(operationalComponentStatus(storage(AFTER_RETRY), 'UPDATE_AVAILABLE')).toBe('ready');
  });

  it('keeps retained when only kept resources remain, or once the deployment is removed', () => {
    expect(operationalComponentStatus(storage([resource('DELETE_SKIPPED', 'b')]), 'HEALTHY')).toBe(
      'retained',
    );
    expect(operationalComponentStatus(storage(AFTER_RETRY), 'DELETED')).toBe('retained');
    expect(operationalComponentStatus(storage(AFTER_RETRY), 'DELETING')).toBe('retained');
  });

  it('rolls the summary up to healthy when retention was the only reason', () => {
    const data = makeInfrastructureResponse({
      summary: { status: 'retained', componentCount: 1, technicalResourceCount: 3 },
      components: [storage(AFTER_RETRY)],
    });
    expect(operationalSummaryStatus(data, 'HEALTHY')).toBe('healthy');
    expect(operationalSummaryStatus(data, 'DELETED')).toBe('retained');
  });
});

describe('InfrastructureSummary', () => {
  function detail(state: string, cleanupState: string | null = null): FleetDeploymentDetail {
    return {
      id: 'dep-1',
      state,
      cleanupState,
      jobs: [],
      currentReleaseId: 'rel-1',
      relayStatus: 'CONNECTED',
      lastHealthAt: null,
    } as unknown as FleetDeploymentDetail;
  }

  function render(
    state: string,
    overrides: Partial<InfrastructureResponse> = {},
    cleanupState: string | null = null,
  ): string {
    const data = makeInfrastructureResponse({
      summary: { status: 'retained', componentCount: 1, technicalResourceCount: 3 },
      components: [storage(AFTER_RETRY)],
      expectations: {
        schemaVersion: 1,
        components: [
          { kind: 'storage', expected: true, present: true },
          { kind: 'cache', expected: false, present: false },
        ],
        missing: [],
        unexpected: [],
      },
      ...overrides,
    });
    const html = renderToString(
      <InfrastructureSummary detail={detail(state, cleanupState)} infrastructure={data} infrastructureError={false} />,
    );
    return new JSDOM(html).window.document.body.textContent ?? '';
  }

  it('never presents retention as health or teardown on a live deployment', () => {
    const text = render('HEALTHY');
    expect(text).toContain('All required services are ready.');
    expect(text).not.toContain('Retained');
    expect(text).toContain('Cache');
    expect(text).toContain('Not required');
    expect(text).toContain('View components and 2 AWS resources');
  });

  it('says the connector is disconnected, not online, once Delete retained data finished', () => {
    const text = render('DELETED', {}, 'COMPLETE');
    expect(text).toContain('Disconnected · access revoked');
    expect(text).not.toContain('Online');
  });

  it('labels a snapshot from a disconnected relay as the last known state', () => {
    const text = render('DELETING', {
      connectionState: 'disconnected',
      summary: { status: 'deleting', componentCount: 1, technicalResourceCount: 3 },
      components: [{ ...storage(AFTER_RETRY), status: 'deleting' }],
    });
    expect(text).toContain('Last known: Services are being removed.');
    expect(text).toContain('Showing the last verified state');
  });
});

describe('activityEventLabel', () => {
  function event(eventType: string, payload: Record<string, unknown> = {}): ActivityEvent {
    return {
      occurredAt: '2026-09-01T00:00:00.000Z',
      eventType,
      actorType: 'system',
      result: 'success',
      previousState: null,
      requestedState: null,
      payload,
    };
  }

  it('names the completed install step instead of a generic line', () => {
    expect(activityEventLabel(event('deployment.step_completed', { step: 'NETWORK' }))).toBe(
      'Network created',
    );
    expect(activityEventLabel(event('deployment.step_completed', { step: 'TLS' }))).toBe('HTTPS set up');
  });

  it('falls back to the event-type label for other events', () => {
    expect(activityEventLabel(event('default_https.active'))).toBe('HTTPS active');
    expect(activityEventLabel(event('deployment.step_completed', { step: 'NOPE' }))).toBe(
      'Step Completed',
    );
  });
});

describe('infraCheckReport', () => {
  const now = Date.parse('2026-09-23T12:00:00.000Z');
  const fresh = '2026-09-23T11:58:00.000Z';
  const old = '2026-09-23T11:00:00.000Z';
  const passed: InfraCheck = { name: 'stack-exists', passed: true, detail: '' };
  const cache: InfraCheck = { name: 'cache', passed: false, required: false, detail: '' };
  const failed: InfraCheck = { name: 'compute', passed: false, detail: '' };

  it('passes only on a fresh report with no required failures', () => {
    expect(infraCheckReport([passed, cache], fresh, 'CONNECTED', now)).toEqual({ kind: 'passed' });
  });

  it('never reports a pass without a completed check', () => {
    expect(infraCheckReport([], fresh, 'CONNECTED', now)).toEqual({ kind: 'unavailable' });
  });

  it('marks an old report, or one from a disconnected relay, as stale', () => {
    expect(infraCheckReport([passed], old, 'CONNECTED', now)).toEqual({ kind: 'stale' });
    expect(infraCheckReport([passed], fresh, 'DISCONNECTED', now)).toEqual({ kind: 'stale' });
    expect(infraCheckReport([passed], null, 'CONNECTED', now)).toEqual({ kind: 'stale' });
  });

  it('leads with the failing checks, and keeps staleness alongside them', () => {
    expect(infraCheckReport([passed, failed], fresh, 'CONNECTED', now)).toEqual({
      kind: 'issues',
      issues: [failed],
      stale: false,
    });
    expect(infraCheckReport([failed], old, 'CONNECTED', now)).toMatchObject({ stale: true });
  });
});
