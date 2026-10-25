import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// A reusable public link that is disabled or revoked shows the same reason on
// its security page as on its install page, not the generic invalid-link copy.

const mocks = vi.hoisted(() => ({
  fetchInstallData: vi.fn(),
  fetchPublicInstallData: vi.fn(),
}));

vi.mock('../src/lib/install-data', () => ({ fetchInstallData: mocks.fetchInstallData }));
vi.mock('../src/lib/public-install-data', () => ({ fetchPublicInstallData: mocks.fetchPublicInstallData }));

const InstallSecurityPage = (await import('../src/app/install/[installLinkId]/security/page')).default;

const LINK_ID = '004bbc16-1e2c-4234-bb40-fd2866694ac4';

async function render(): Promise<string> {
  const element = await InstallSecurityPage({ params: Promise.resolve({ installLinkId: LINK_ID }) });
  return renderToString(element);
}

describe('/install/[id]/security for an unavailable public link', () => {
  it.each([
    ['PUBLIC_INSTALL_LINK_DISABLED', 'not currently available for installation'],
    ['PUBLIC_INSTALL_LINK_REVOKED', 'has been revoked'],
  ])('shows the %s reason', async (code, reason) => {
    mocks.fetchInstallData.mockResolvedValue({ status: 'not_found' });
    mocks.fetchPublicInstallData.mockResolvedValue({ status: 'gone', code });

    const html = await render();

    expect(html).toContain('This application cannot be installed');
    expect(html).toContain(reason);
    expect(html).not.toContain('isn&#x27;t valid');
  });
});
