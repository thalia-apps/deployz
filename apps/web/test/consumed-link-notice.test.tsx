import { JSDOM } from 'jsdom';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The consumed-link notice lives on the install page (outside InstallProgress)
// and must NOT read like a failure note about the deployment currently in
// progress. This test asserts the redesigned de-emphasized copy.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));

const mocks = vi.hoisted(() => ({
  fetchPublicInstallData: vi.fn(),
  fetchInstallData: vi.fn(),
  fetchInstallStatusServer: vi.fn(),
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
      awsResources: [],
      requirementDrift: [],
    },
    quickCreateUrl: QUICK_CREATE,
    alreadyInstalled: true,
    deploymentId: 'dep-1',
    deploymentState: 'PROVISIONING',
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

async function renderPage(linkId: string = LINK_ID): Promise<Document> {
  const element = await InstallPage({
    params: Promise.resolve({ installLinkId: linkId }),
  });
  const { window } = new JSDOM(renderToString(element));
  return window.document;
}

beforeEach(() => {
  mocks.fetchPublicInstallData.mockReset();
  mocks.fetchInstallData.mockReset();
  mocks.fetchInstallStatusServer.mockReset().mockResolvedValue(null);
});

describe('InstallPage — consumed-link notice', () => {
  it('renders the de-emphasized single-line copy and does NOT imply the deployment failed', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({ status: 'ok', data: resolvedData() });

    const doc = await renderPage();

    // The redesigned copy is explicit about the link, never about the
    // deployment status.
    const notice = doc.querySelector('[data-testid="consumed-link-notice"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('This install link has been used');
    expect(notice?.textContent).toContain('Another installation needs a new link');

    // The notice must not use alarming failure vocabulary.
    const noticeText = notice?.textContent ?? '';
    expect(noticeText.toLowerCase()).not.toContain('failed');
    expect(noticeText.toLowerCase()).not.toContain('error');
    expect(noticeText.toLowerCase()).not.toContain('cannot');
  });

  it('does NOT render a standalone Security details button in the in-progress customer flow', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({ status: 'ok', data: resolvedData() });

    const doc = await renderPage();

    // The in-progress customer branch used to carry a prominent
    // "Security details" button; the redesign removes it from the primary
    // flow. The Security details page itself remains reachable via its
    // direct URL (covered by other tests), just not surfaced inside the
    // deployment progress view.
    const securityLinks = Array.from(doc.querySelectorAll('a')).filter(
      (anchor) => anchor.textContent?.trim() === 'Security details',
    );
    expect(securityLinks).toHaveLength(0);
  });
});
