import { JSDOM } from 'jsdom';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The /install page resolves public install links first, then falls back to
// the per-deployment flow. These tests cover the existing per-deployment
// branch and the public-link fall-through.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    toString: () => mocks.cookieHeader,
  }),
}));

const mocks = vi.hoisted(() => ({
  fetchPublicInstallData: vi.fn(),
  fetchInstallData: vi.fn(),
  fetchInstallStatusServer: vi.fn(),
  cookieHeader: '',
}));

vi.mock('../src/lib/public-install-data', () => ({
  fetchPublicInstallData: mocks.fetchPublicInstallData,
}));
vi.mock('../src/lib/install-data', () => ({
  fetchInstallData: mocks.fetchInstallData,
  launchInstall: vi.fn(),
}));
vi.mock('../src/lib/install-status', () => ({
  fetchInstallStatusServer: mocks.fetchInstallStatusServer,
}));

const InstallPage = (await import('../src/app/install/[installLinkId]/page')).default;

const LINK_ID = '11111111-1111-1111-1111-111111111111';
const QUICK_CREATE = 'https://console.aws.amazon.com/cloudformation/quickcreate';

function resolvedData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    applicationName: 'Acme App',
    publisherName: 'Acme Inc',
    customerName: 'Customer One',
    region: 'us-east-1',
    plan: {
      schemaVersion: 1,
      action: 'INSTALL',
      region: 'us-east-1',
      components: [
        { kind: 'application', name: 'Application', action: 'CREATE', lifecycle: 'delete' },
        { kind: 'endpoint', name: 'Secure endpoint', action: 'CREATE', lifecycle: 'delete' },
        { kind: 'database', name: 'Database', action: 'CREATE', lifecycle: 'retain' },
      ],
      awsResources: [
        {
          id: 'ecs_service',
          name: 'ECS Fargate service',
          purpose: 'Runs the application container and restarts it if it stops',
          group: 'compute_networking',
          componentKind: 'application',
          lifecycle: 'delete',
        },
        {
          id: 'database',
          name: 'RDS PostgreSQL database',
          purpose: 'Stores persistent application data',
          group: 'data',
          componentKind: 'database',
          lifecycle: 'retain',
        },
      ],
      requirementDrift: [],
    },
    quickCreateUrl: QUICK_CREATE,
    alreadyInstalled: false,
    viewer: { kind: 'customer', email: 'owner@example.com' },
    deploymentId: 'dep-1',
    deploymentState: 'NOT_INSTALLED',
    domain: null,
    routingTarget: null,
    bootstrapStackName: 'deployz-bootstrap-acme-app-dep-1',
    waitingForRelay: false,
    relayStuck: false,
    components: null,
    releaseVersion: '1.2.0',
    ...overrides,
  };
}

function waitingStatus(): Record<string, unknown> {
  return {
    stage: 'WAITING_FOR_AWS',
    updatedAt: '2026-09-18T00:00:00.000Z',
    currentActivity: 'AWS is creating the Deployz connector in your account.',
    step: 'AWS_SETUP',
    steps: [],
    typicalDurationSeconds: { min: 180, max: 600 },
    takingLongerThanUsual: false,
    removed: false,
    statusUpdatesUnavailable: false,
    needsDomainSetup: false,
    components: [],
    url: null,
    failure: null,
  };
}

async function renderPage(linkId: string = LINK_ID): Promise<Document> {
  const element = await InstallPage({
    params: Promise.resolve({ installLinkId: linkId }),
  });
  const { window } = new JSDOM(renderToString(element));
  return window.document;
}

beforeEach(() => {
  mocks.cookieHeader = '';
  mocks.fetchPublicInstallData.mockReset();
  mocks.fetchInstallData.mockReset();
  mocks.fetchInstallStatusServer.mockReset().mockResolvedValue(null);
});

describe('InstallPage per-deployment flow', () => {
  it('renders the existing install page when no public install link matches', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({ status: 'ok', data: resolvedData() });

    const doc = await renderPage();

    expect(doc.body.textContent).toContain('to your AWS account');
    expect(doc.body.textContent).toContain('Connect AWS account');
    // The new canonical AWS resources table replaces the prior component
    // summary; every detailed AWS resource the plan carries renders.
    expect(doc.body.textContent).toContain('AWS resources');
    expect(doc.body.textContent).toContain('ECS Fargate service');
    expect(doc.body.textContent).toContain('RDS PostgreSQL database');
  });

  it('forwards the browser cookies to the control plane', async () => {
    mocks.cookieHeader = 'deployz.customer_session_token=abc';
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({ status: 'ok', data: resolvedData() });

    await renderPage();

    expect(mocks.fetchInstallData).toHaveBeenCalledWith(LINK_ID, 'deployz.customer_session_token=abc');
    expect(mocks.fetchInstallStatusServer).toHaveBeenCalledWith(LINK_ID, 'deployz.customer_session_token=abc');
  });

  it('asks for email verification, and offers no AWS connection, until the owner signs in', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({
      status: 'sign_in',
      applicationName: 'Acme App',
      publisherName: 'Acme Inc',
    });

    const doc = await renderPage();

    expect(doc.body.textContent).toContain('Verify your email');
    expect(doc.body.textContent).toContain('Published by Acme Inc');
    expect(doc.body.textContent).not.toContain('Connect AWS account');
    expect(doc.body.textContent).not.toContain('AWS resources');
    expect(doc.querySelector('a[href^="https://console.aws.amazon.com"]')).toBeNull();
  });

  it('shows who is signed in', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({ status: 'ok', data: resolvedData() });

    const doc = await renderPage();

    expect(doc.querySelector('[data-testid="customer-session-bar"]')?.textContent).toContain(
      'Signed in as owner@example.com',
    );
  });

  it('delegates an unknown link to the invitation token gate', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({ status: 'not_found' });

    const doc = await renderPage();

    // The gate resolves on the client (the one-time token travels as a URL
    // fragment the server never sees); the server render shows its loading
    // state, and the token handling itself is covered by the gate tests.
    expect(doc.body.textContent).toContain('Opening your installation');
  });

  it('renders a distinct expired state for an expired link', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({
      status: 'unavailable',
      code: 'INSTALL_LINK_EXPIRED',
      message: 'This installation link has expired. Ask the publisher for a new one.',
    });

    const doc = await renderPage();

    expect(doc.body.textContent).toContain('This installation link has expired');
    expect(doc.body.textContent).toContain('Ask the publisher for a new one.');
  });

  it('says the page cannot load, not that the link expired, when the control plane does not answer', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue({ status: 'error' });
    mocks.fetchInstallData.mockResolvedValue({ status: 'error' });

    const doc = await renderPage();

    expect(doc.body.textContent).toContain("We can't load this page right now");
    expect(doc.body.textContent).toContain('Your install link is still valid');
    expect(doc.body.textContent).not.toMatch(/expired|revoked|isn't valid/i);
    expect(doc.querySelector(`a[href="/install/${LINK_ID}"]`)?.textContent).toBe('Try again');
  });

  it('does not call a public link invalid when only its own lookup failed', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue({ status: 'error' });
    mocks.fetchInstallData.mockResolvedValue({ status: 'not_found' });

    const doc = await renderPage();

    expect(doc.body.textContent).toContain("We can't load this page right now");
    expect(doc.body.textContent).not.toContain('Opening your installation');
  });

  it('renders a distinct revoked state for a revoked link', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({
      status: 'unavailable',
      code: 'INSTALL_LINK_REVOKED',
      message: 'This installation link was revoked by the publisher.',
    });

    const doc = await renderPage();

    expect(doc.body.textContent).toContain('This installation link was revoked');
    expect(doc.body.textContent).toContain('revoked by the publisher');
  });

  it('shows the waiting-for-relay view after the customer launched the install', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({
      status: 'ok',
      data: resolvedData({
        waitingForRelay: true,
        relayStuck: true,
        deploymentState: 'WAITING_FOR_RELAY',
      }),
    });
    mocks.fetchInstallStatusServer.mockResolvedValue(waitingStatus());

    const doc = await renderPage();

    expect(doc.body.textContent).toContain('Acme App');
    expect(doc.body.textContent).toContain('setting up inside your AWS account');
    expect(doc.body.textContent).toContain('Still connecting');
    expect(doc.body.textContent).toContain('link under Deployment details');
    expect(doc.body.textContent).toContain('Deployment details');
    expect(doc.body.textContent).not.toContain('Technical details');
    expect(doc.body.textContent).toContain('select Retry connection');
    expect(Array.from(doc.querySelectorAll('button')).some((b) => b.textContent === 'Retry connection')).toBe(true);
  });

  it('renders the READY branch with the deployed-by heading', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({
      status: 'ok',
      data: resolvedData({
        alreadyInstalled: true,
        deploymentState: 'HEALTHY',
      }),
    });

    const doc = await renderPage();

    expect(doc.body.textContent).toContain('Acme App');
    expect(doc.body.textContent).toContain('Deployed by Acme Inc');
  });

});

describe('InstallPage removed deployment', () => {
  it('names what can remain after a removal whose data was not deleted', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({
      status: 'ok',
      data: resolvedData({ alreadyInstalled: true, deploymentState: 'DELETED', retainedDataDeleted: false }),
    });

    const text = (await renderPage()).body.textContent ?? '';

    expect(text).toContain('What can remain in your AWS account');
    expect(text).toContain('Database');
    expect(text).toContain('Kept resources can keep costing money');
  });

  it('after a verified purge, says only the connector stack remains', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({
      status: 'ok',
      data: resolvedData({ alreadyInstalled: true, deploymentState: 'DELETED', retainedDataDeleted: true }),
    });

    const doc = await renderPage();
    const text = doc.body.textContent ?? '';

    expect(text).toContain('What remains in your AWS account');
    expect(text).not.toContain('What can remain');
    expect(text).not.toContain('Kept resources can keep costing money');
    expect([...doc.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      'The Deployz connector (stack deployz-bootstrap-acme-app-dep-1)',
    ]);
    expect(text).toContain('Acme Inc deleted the data that was kept after removal');
  });
});
