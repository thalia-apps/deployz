import { JSDOM } from 'jsdom';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The /deploy page composes the install components; next/navigation hooks
// need a router context renderToString cannot provide.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const mocks = vi.hoisted(() => ({
  fetchDeployLinkData: vi.fn(),
  fetchDeployLinkStatusServer: vi.fn(),
  cookieToken: undefined as string | undefined,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (mocks.cookieToken === undefined ? undefined : { value: mocks.cookieToken }),
  }),
}));

vi.mock('../src/lib/deploy-link-flow', () => ({
  fetchDeployLinkData: mocks.fetchDeployLinkData,
  fetchDeployLinkStatusServer: mocks.fetchDeployLinkStatusServer,
}));

const DeployPage = (await import('../src/app/deploy/[publicId]/page')).default;

// Page-state tests for the hosted /deploy page: each state is driven by the
// resolve result, and the customer-visible copy must stay jargon-free with
// no internal identifiers.

const PUBLIC_ID = 'b7e2a91c-1f3a-4c5d-8e9f-0a1b2c3d4e5f';
const TOKEN = 'a'.repeat(64);
const QUICK_CREATE = 'https://console.aws.amazon.com/cloudformation/quickcreate';
const SECURITY_HREF = `/deploy/${PUBLIC_ID}/security`;

function securityLink(doc: Document): Element | undefined {
  // The waiting/launched layouts link straight to the security page; the
  // pre-launch review's "Before you deploy" section carries the same link
  // via a "Security & permissions details" button.
  return [...doc.querySelectorAll('a')].find(
    (anchor) =>
      anchor.textContent === 'Security details' ||
      anchor.textContent === 'Open security details' ||
      anchor.textContent === 'Security & permissions details',
  );
}

function resolvedData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    link: { status: 'active' },
    application: { name: 'Acme Analytics' },
    customer: { name: 'Acme' },
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
    deploymentState: 'NOT_INSTALLED',
    bootstrapStackName: 'deployz-bootstrap-acme-analytics-1',
    waitingForRelay: false,
    relayStuck: false,
    quickCreateUrl: QUICK_CREATE,
    domain: null,
    routingTarget: null,
    status: { stage: 'WAITING_FOR_AWS' },
    ...overrides,
  };
}

async function renderPage(search?: string): Promise<Document> {
  mocks.cookieToken = search === undefined ? TOKEN : undefined;
  // DeployPage is an async server component: await it to the resolved JSX
  // tree first — renderToString cannot suspend.
  const element = await DeployPage({
    params: Promise.resolve({ publicId: PUBLIC_ID }),
  });
  const { window } = new JSDOM(renderToString(element));
  return window.document;
}

beforeEach(() => {
  mocks.fetchDeployLinkData.mockReset();
  mocks.fetchDeployLinkStatusServer.mockReset().mockResolvedValue(null);
});

describe('DeployPage', () => {
  it('shows the minimal review for a not-yet-launched deployment', async () => {
    mocks.fetchDeployLinkData.mockResolvedValue({ ok: true, data: resolvedData() });
    const doc = await renderPage();

    expect(doc.body.textContent).toContain('Acme Analytics');
    expect(doc.body.textContent).toContain('Deploy Acme Analytics to your AWS account');
    // Plan-driven table content, not a hand-rolled resource-name list.
    expect(doc.body.textContent).toContain('RDS PostgreSQL database');
    expect(doc.body.textContent).toContain('What will be deployed');
    expect(doc.body.textContent).toContain('Database');
    expect(doc.body.textContent).toContain('US East (N. Virginia)');
    // No estimate in the fixture: the fallback stays explicit, never invented.
    expect(doc.body.textContent).toContain('AWS cost estimate unavailable.');
    expect(doc.body.textContent).toContain('Powered by Deployz');
    // The customer surface uses the brief's "Connect AWS account" CTA.
    expect(doc.querySelector('a[href="' + QUICK_CREATE + '"]')?.textContent).toBe('Connect AWS account');
    expect(securityLink(doc)?.getAttribute('href')).toBe(SECURITY_HREF);
    // No internal identifiers in the page.
    expect(doc.body.textContent).not.toContain(PUBLIC_ID);
  });

  it('shows the connecting view once launched, with the stack name and retry on a stuck relay', async () => {
    mocks.fetchDeployLinkData.mockResolvedValue(
      await Promise.resolve({
        ok: true,
        data: resolvedData({
          waitingForRelay: true,
          relayStuck: true,
          deploymentState: 'WAITING_FOR_RELAY',
          status: { stage: 'WAITING_FOR_AWS' },
        }),
      }),
    );
    mocks.fetchDeployLinkStatusServer.mockResolvedValue({
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
    });
    const doc = await renderPage();

    expect(doc.body.textContent).toContain('setting up inside your AWS account');
    // The expected stack name now sits collapsed under Deployment details.
    expect(doc.body.textContent).toContain('Deployment details');
    expect(doc.body.textContent).not.toContain('Technical details');
    expect(doc.body.textContent).toContain('Still connecting');
    expect(doc.body.textContent).toContain('Retry connection');
    expect(securityLink(doc)?.getAttribute('href')).toBe(SECURITY_HREF);
  });

  it('renders the resume/progress view for a launched deployment', async () => {
    mocks.fetchDeployLinkData.mockResolvedValue(
      await Promise.resolve({
        ok: true,
        data: resolvedData({
          deploymentState: 'INSTALLING',
          status: { stage: 'PROVISIONING' },
        }),
      }),
    );
    const doc = await renderPage();

    expect(doc.body.textContent).toContain('runs inside your AWS account');
    expect(doc.querySelector('[data-testid="deploy-link-url"]')).toBeNull();
    expect(securityLink(doc)?.getAttribute('href')).toBe(SECURITY_HREF);
  });

  it('renders friendly states for revoked and expired links', async () => {
    mocks.fetchDeployLinkData.mockResolvedValue({ ok: false, reason: 'revoked' });
    const revoked = await renderPage();
    expect(revoked.body.textContent).toContain('no longer valid');
    expect(revoked.body.textContent).toContain('request a new link');

    mocks.fetchDeployLinkData.mockResolvedValue({ ok: false, reason: 'expired' });
    const expired = await renderPage();
    expect(expired.body.textContent).toContain('has expired');
  });

  it('leaves a first visit to the browser gate, which reads the URL fragment', async () => {
    const doc = await renderPage('');
    expect(doc.body.textContent).toBe('');
    expect(mocks.fetchDeployLinkData).not.toHaveBeenCalled();
  });
});
