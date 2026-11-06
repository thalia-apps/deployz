// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openInNewTab } from '@/lib/billing-checkout';

// Billing provider pages (checkout, portal, invoice) open in a new tab, so
// the vendor keeps their place in Deployz.
describe('openInNewTab', () => {
  afterEach(() => vi.restoreAllMocks());

  function fakeTab() {
    return { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
  }

  it('opens the tab during the click, then points it at the minted URL with no opener', async () => {
    const tab = fakeTab();
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    let openedBeforeMint = false;

    const result = await openInNewTab(async () => {
      openedBeforeMint = open.mock.calls.length === 1;
      return 'https://sandbox.polar.sh/portal';
    });

    expect(result).toBe('new-tab');
    expect(openedBeforeMint).toBe(true);
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(tab.opener).toBeNull();
    expect(tab.location.href).toBe('https://sandbox.polar.sh/portal');
  });

  it('closes the empty tab and rethrows when the URL cannot be minted', async () => {
    const tab = fakeTab();
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);

    await expect(openInNewTab(async () => Promise.reject(new Error('Could not open billing.')))).rejects.toThrow(
      'Could not open billing.',
    );
    expect(tab.close).toHaveBeenCalledOnce();
  });

  it('uses this tab when the browser blocks the new one', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as Location);

    expect(await openInNewTab(async () => 'https://sandbox.polar.sh/checkout/x')).toBe('same-tab');
    expect(assign).toHaveBeenCalledWith('https://sandbox.polar.sh/checkout/x');
  });
});
