import { JSDOM } from 'jsdom';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DeploymentUrlCard } from '../src/components/deployment-url-card';
import type { FleetDeploymentDetail, HealthStatus } from '../src/lib/deployments';

/**
 * Component/DOM tests for the deployment detail URL card (Phase 9).
 *
 * The card is rendered with react-dom/server and parsed with jsdom so we can
 * assert on the visible text and affordances without needing a full browser.
 */

function status(): FleetDeploymentDetail['deploymentStatus'] {
  return {
    stage: 'READY',
    updatedAt: '2026-09-01T00:00:00.000Z',
    currentActivity: 'Live and healthy.',
    step: 'READY',
    steps: ['AWS_SETUP', 'RELAY_CONNECT', 'PREPARING', 'NETWORK', 'APPLICATION', 'HEALTH_CHECK', 'TLS', 'READY'],
    typicalDurationSeconds: null,
    takingLongerThanUsual: false,
    stepStartedAt: null,
    stepTimings: [],
    statusUpdatesUnavailable: false,
    needsDomainSetup: false,
    components: [],
    relay: { connected: true, lastSeenAt: null },
    job: null,
    aws: { stackStatus: null },
    health: { status: 'HEALTHY', layers: { infrastructure: 'UNKNOWN', rollout: null, targets: null, http: null, relay: 'CONNECTED' } },
    url: 'https://d-dep-9f1c.deployz.dev',
    failure: null,
  } as unknown as FleetDeploymentDetail['deploymentStatus'];
}

function detail(overrides: Partial<FleetDeploymentDetail> = {}): FleetDeploymentDetail {
  return {
    id: 'dep-9f1c',
    customerId: 'cust-1',
    applicationId: 'app-1',
    organizationId: 'org-1',
    region: 'us-east-1',
    state: 'HEALTHY',
    awsAccountId: '1234••••••••',
    currentReleaseId: 'rel-1',
    previousReleaseId: null,
    currentReleaseConfirmedAt: null,
    relayStatus: 'CONNECTED',
    healthStatus: 'HEALTHY' as HealthStatus,
    components: null,
    installLinkId: 'link-1',
    installLinkExpiresAt: null,
    observedState: null,
    infraVersion: '1',
    installationId: 'inst-1',
    deploymentType: 'PRODUCTION',
    billingState: 'NOT_STARTED',
    billingStartedAt: null,
    billingStoppedAt: null,
    lastHealthAt: '2026-09-01T00:00:00.000Z',
    deletedAt: null,
    cleanupState: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    createdBy: null,
    updatedBy: null,
    customerName: 'Acme',
    applicationName: 'Example App',
    version: '1.0.0',
    relayVersion: null,
    bootstrapVersion: null,
    relayCapabilities: null,
    runningImageDigest: null,
    attemptNumber: 1,
    bootstrapStackName: null,
    installStartedAt: null,
    deploymentStatus: status(),
    jobs: [],
    customDomain: null,
    appUrl: 'https://d-dep-9f1c.deployz.dev',
    defaultUrl: 'https://d-dep-9f1c.deployz.dev',
    ...overrides,
  };
}

function render(d: FleetDeploymentDetail): Document {
  const html = renderToString(<DeploymentUrlCard detail={d} />);
  const { window } = new JSDOM(html);
  return window.document;
}

function withHttps(httpsStatus: 'READY' | 'IN_PROGRESS'): FleetDeploymentDetail['deploymentStatus'] {
  return {
    ...status(),
    components: [{ key: 'https', label: 'Secure access (HTTPS)', status: httpsStatus }],
  } as unknown as FleetDeploymentDetail['deploymentStatus'];
}

function text(doc: Document): string {
  return doc.body.textContent ?? '';
}

describe('DeploymentUrlCard', () => {
  it('shows the application URL once, with open/copy actions and no custom domain', () => {
    const doc = render(detail({ deploymentStatus: withHttps('READY') }));

    expect(text(doc)).toContain('Application URL');
    expect(text(doc)).toContain('https://d-dep-9f1c.deployz.dev');
    expect(text(doc)).toContain('HTTPS active');
    expect(text(doc)).toContain('Open application');
    expect(text(doc)).toContain('Copy URL');
    // Health lives in the page header, never in the access block.
    expect(text(doc)).not.toContain('Healthy');
    expect(text(doc)).not.toContain('Secure');

    expect(text(doc)).toContain('Custom domain');
    expect(text(doc)).toContain('Not configured');
    expect(doc.querySelector('a[href="/install/link-1"]')?.textContent).toBe('Add custom domain');
  });

  it('claims HTTPS only when the server confirmed it serves', () => {
    expect(text(render(detail()))).not.toContain('HTTPS active');
    expect(text(render(detail({ deploymentStatus: withHttps('IN_PROGRESS') })))).not.toContain(
      'HTTPS active',
    );
    // A READY HTTPS component never upgrades a plain-HTTP address.
    const http = detail({
      appUrl: 'http://deployz-alb-1a2b.us-east-2.elb.amazonaws.com',
      deploymentStatus: withHttps('READY'),
    });
    expect(text(render(http))).not.toContain('HTTPS active');
  });

  it('drops the HTTPS claim when the connector is not reporting or the latest probe failed', () => {
    const base = withHttps('READY') as unknown as Record<string, unknown> & {
      health: { layers: Record<string, unknown> };
    };
    const lostContact = { ...base, statusUpdatesUnavailable: true };
    expect(text(render(detail({ deploymentStatus: lostContact as never })))).not.toContain('HTTPS active');
    const probeFailed = {
      ...base,
      health: {
        ...base.health,
        layers: {
          ...base.health.layers,
          http: { ok: false, statusCode: 530, latencyMs: null, checkedAt: '2026-09-01T00:00:00.000Z' },
        },
      },
    };
    expect(text(render(detail({ deploymentStatus: probeFailed as never })))).not.toContain('HTTPS active');
  });

  it('renders the API-provided defaultUrl rather than a client-minted hostname', () => {
    // The API's real default-HTTPS hostname (from the stored state) must win
    // over the client-side d-<id>.deployz.dev projection.
    const d = detail({
      appUrl: null,
      defaultUrl: 'https://d-from-api.deployz.dev',
    });
    const doc = render(d);

    expect(text(doc)).toContain('https://d-from-api.deployz.dev');
    expect(text(doc)).not.toContain('https://d-dep-9f1c.deployz.dev');
  });

  it('keeps the Deployz address primary while a custom domain is pending', () => {
    const d = detail({
      appUrl: 'https://d-dep-9f1c.deployz.dev',
      customDomain: { hostname: 'app.customer.com', status: 'waiting_for_dns' },
    });
    const doc = render(d);

    const open = [...doc.querySelectorAll('a')].find((a) => a.textContent?.includes('Open application'));
    expect(open?.getAttribute('href')).toBe('https://d-dep-9f1c.deployz.dev');
    expect(text(doc)).toContain('app.customer.com');
    expect(text(doc)).toContain('Waiting for domain setup');
    expect(doc.querySelector('a[href="/install/link-1"]')?.textContent).toBe('Check custom domain');
  });

  it('shows an active custom domain as the primary URL with the Deployz address as a fallback', () => {
    const d = detail({
      appUrl: 'https://app.customer.com',
      customDomain: { hostname: 'app.customer.com', status: 'active' },
      deploymentStatus: withHttps('READY'),
    });
    const doc = render(d);

    expect(text(doc)).toContain('https://app.customer.com');
    expect(text(doc)).toContain('HTTPS active');
    expect(text(doc)).toContain('Also available at https://d-dep-9f1c.deployz.dev');

    // Exactly one "Open application" affordance, pointing at the primary URL.
    const openLinks = [...doc.querySelectorAll('a')].filter((a) =>
      a.textContent?.includes('Open application'),
    );
    expect(openLinks).toHaveLength(1);
    expect(openLinks[0]?.getAttribute('href')).toBe('https://app.customer.com');

    expect(text(doc)).toContain('Active');
    expect(doc.querySelector('a[href="/install/link-1"]')?.textContent).toBe('Manage custom domain');
  });

  it('shows a needs-attention treatment when the custom domain has failed', () => {
    const d = detail({
      appUrl: 'https://d-dep-9f1c.deployz.dev',
      customDomain: { hostname: 'app.customer.com', status: 'error' },
    });
    const doc = render(d);

    expect(text(doc)).toContain('https://d-dep-9f1c.deployz.dev');
    expect(doc.querySelector('[data-testid="custom-domain-error"]')?.textContent).toContain(
      'Needs attention',
    );
    expect(doc.querySelector('a[href="/install/link-1"]')?.textContent).toBe('Manage custom domain');
  });

  it('shows a brief removing treatment while a custom domain is being removed', () => {
    const d = detail({
      appUrl: 'https://d-dep-9f1c.deployz.dev',
      customDomain: { hostname: 'app.customer.com', status: 'removing' },
    });
    const doc = render(d);

    expect(text(doc)).toContain('https://d-dep-9f1c.deployz.dev');
    expect(text(doc)).toContain('Removing domain…');
  });
});
