// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InstallLinkPresentation } from '../src/lib/application-state';
import { ApiRequestError } from '../src/lib/api-client';
import type { PublicInstallLinkCreated, PublicInstallLinkView } from '../src/lib/public-install-links';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom implements neither pointer capture nor scrollIntoView; Radix Select
// calls them while handling pointer events.
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false as never;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

// InstallLinkControls / PublicInstallLinkCard render purely from the
// `installLink` presentation the caller passes in — they never fetch. This
// locks each presentation `kind` to its visible shape, that a mutation only
// ever runs after the explicit click (regenerate/revoke behind their
// confirmation dialogs), and that `onChanged` (the page's refresh) always
// follows a successful mutation.

const linkMocks = vi.hoisted(() => ({
  createPublicInstallLink: vi.fn(),
  fetchApplication: vi.fn(),
  setPublicInstallLinkEnabled: vi.fn(),
  revokePublicInstallLink: vi.fn(),
  regeneratePublicInstallLink: vi.fn(),
}));

vi.mock('../src/lib/public-install-links', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/public-install-links')>();
  return {
    ...actual,
    createPublicInstallLink: linkMocks.createPublicInstallLink,
    setPublicInstallLinkEnabled: linkMocks.setPublicInstallLinkEnabled,
    revokePublicInstallLink: linkMocks.revokePublicInstallLink,
    regeneratePublicInstallLink: linkMocks.regeneratePublicInstallLink,
  };
});

vi.mock('../src/lib/applications', () => ({
  fetchApplication: linkMocks.fetchApplication,
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// The dropdown menu itself (open/close, positioning, focus trapping,
// portalling to document.body) is Radix's own behavior, exercised
// elsewhere. Mocked here to a plain always-rendered structure — matching the
// pattern in test/multi-action-loading.test.tsx — so this file can reach the
// overflow items without simulating Radix's pointer-driven open sequence in
// jsdom.
vi.mock('../src/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
    disabled,
    variant: _variant,
    ...props
  }: Record<string, unknown> & {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    variant?: string;
  }) => (
    <div role="menuitem" data-disabled={disabled || undefined} onClick={disabled ? undefined : onClick} {...props}>
      {children}
    </div>
  ),
}));

const { InstallLinkControls, PublicInstallLinkCard } = await import('../src/components/public-install-link-card');
const { toast } = await import('sonner');

const APP_ID = 'app-1';

function activeLink(overrides: Partial<PublicInstallLinkView> = {}): PublicInstallLinkView {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    url: 'https://app.deployz.dev/install/11111111-1111-1111-1111-111111111111',
    status: 'active',
    createdAt: '2026-09-04T00:00:00.000Z',
    revokedAt: null,
    recommendedSizeProfile: null,
    minimumSizeProfile: null,
    ...overrides,
  };
}

function createdLink(overrides: Partial<PublicInstallLinkCreated> = {}): PublicInstallLinkCreated {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    url: 'https://app.deployz.dev/install/11111111-1111-1111-1111-111111111111',
    htmlSnippet:
      '<a href="https://app.deployz.dev/install/11111111-1111-1111-1111-111111111111">Deploy to AWS with Deployz</a>',
    enabled: true,
    createdAt: '2026-09-04T00:00:00.000Z',
    ...overrides,
  };
}

function liveLink(link: PublicInstallLinkView, warning: string | null = null): InstallLinkPresentation {
  const status = link.status === 'active' || link.status === 'disabled' ? link.status : 'unknown';
  return { kind: 'live', link, status, warning };
}

function click(element: Element | null): void {
  element?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

async function flush(): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  linkMocks.fetchApplication.mockRejectedValue(new Error('no application in this test'));
  vi.stubGlobal('navigator', {
    clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

function renderControls(
  installLink: InstallLinkPresentation,
  onChanged = vi.fn().mockResolvedValue(undefined),
  primary = false,
) {
  act(() => {
    root.render(
      <InstallLinkControls applicationId={APP_ID} installLink={installLink} onChanged={onChanged} primary={primary} />,
    );
  });
  return { onChanged };
}

describe('InstallLinkControls visibility per kind', () => {
  it('shows a skeleton while loading', () => {
    renderControls({ kind: 'loading' });
    expect(container.querySelector('[data-testid="public-install-link-loading"]')).not.toBeNull();
  });

  it('shows an inline destructive alert on error', () => {
    renderControls({ kind: 'error', message: "We couldn't load the customer install link." });
    const alert = container.querySelector('[data-testid="public-install-link-error"]');
    expect(alert?.textContent).toBe("We couldn't load the customer install link.");
  });

  it('shows the reason text when unavailable', () => {
    renderControls({ kind: 'unavailable', reason: 'Available after a successful test deployment.' });
    expect(container.textContent).toContain('Available after a successful test deployment.');
    expect(container.querySelector('button')).toBeNull();
  });

  it('shows nothing for the hidden kind', () => {
    renderControls({ kind: 'hidden' });
    expect(container.textContent).toBe('');
  });

  it('shows the create button and an optional note', () => {
    renderControls({ kind: 'create', note: 'The previous link was revoked. Create a new link to share the application.' });
    expect(container.querySelector('[data-testid="public-install-link-create"]')).not.toBeNull();
    expect(container.textContent).toContain('The previous link was revoked');
  });

  it('shows the status badge and controls for a live link', () => {
    renderControls(liveLink(activeLink()));
    expect(container.querySelector('[data-testid="public-install-link-status"]')?.textContent).toBe('Active');
    expect(container.querySelector('[data-testid="public-install-link-copy-url"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="public-install-link-preview"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="public-install-link-menu"]')).not.toBeNull();
  });

  it('shows Disabled and disables Copy link when the link is disabled', () => {
    renderControls(liveLink(activeLink({ status: 'disabled' })));
    expect(container.querySelector('[data-testid="public-install-link-status"]')?.textContent).toBe('Disabled');
    expect(
      (container.querySelector('[data-testid="public-install-link-copy-url"]') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('shows "Needs review" for an unknown status', () => {
    renderControls(liveLink(activeLink({ status: 'revoked' as never })));
    expect(container.querySelector('[data-testid="public-install-link-status"]')?.textContent).toBe(
      'Needs review',
    );
  });

  it('shows the early-link warning', () => {
    renderControls(liveLink(activeLink(), 'This link is live, but the application is not ready to share.'));
    expect(container.textContent).toContain('This link is live, but the application is not ready to share.');
  });

  it('never renders the raw URL as text', () => {
    renderControls(liveLink(activeLink()));
    expect(container.querySelector('[data-testid="public-install-link-url"]')).toBeNull();
    expect(container.textContent).not.toContain('https://app.deployz.dev/install/');
  });

  it('shows a visible "Manage" button as the overflow trigger, and Copy link stays primary', () => {
    renderControls(liveLink(activeLink()), undefined, true);
    const menu = container.querySelector('[data-testid="public-install-link-menu"]');
    expect(menu?.textContent).toContain('Manage');
    expect(container.querySelector('[data-testid="public-install-link-copy-url"]')?.textContent).toContain(
      'Copy install link',
    );
  });
});

describe('InstallLinkControls actions', () => {
  it('creates a link and calls onChanged', async () => {
    linkMocks.createPublicInstallLink.mockResolvedValue(createdLink());
    const { onChanged } = renderControls({ kind: 'create', note: null });

    await act(async () => {
      click(container.querySelector('[data-testid="public-install-link-create"]'));
    });
    await flush();

    expect(linkMocks.createPublicInstallLink).toHaveBeenCalledWith(APP_ID, undefined);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('Install link created.');
  });

  it('shows the application default size, only sizes the minimum allows, and creates the link with the chosen size', async () => {
    linkMocks.fetchApplication.mockResolvedValue({ defaultSizeProfile: 'medium', minimumSizeProfile: 'medium' });
    linkMocks.createPublicInstallLink.mockResolvedValue(createdLink());
    renderControls({ kind: 'create', note: null });
    await flush();

    const trigger = container.querySelector('[data-slot="select-trigger"]') as HTMLElement;
    expect(container.textContent).toContain('Recommended size');
    expect(trigger.textContent).toContain('Medium');

    await act(async () => {
      for (const type of ['pointerdown', 'mousedown', 'click', 'pointerup']) {
        trigger.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
      }
    });
    const options = Array.from(document.querySelectorAll('[role="option"]'));
    expect(options.map((option) => option.textContent)).toEqual([
      'Medium (1 vCPU · 2 GiB)',
      'Large (2 vCPU · 4 GiB)',
    ]);
    await act(async () => {
      for (const type of ['pointerdown', 'mousedown', 'click', 'pointerup']) {
        options[1]?.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
      }
    });

    await act(async () => {
      click(container.querySelector('[data-testid="public-install-link-create"]'));
    });
    await flush();

    expect(linkMocks.createPublicInstallLink).toHaveBeenCalledWith(APP_ID, 'large');
  });

  it('shows the size a link froze, and nothing for an older link without one', () => {
    renderControls(liveLink(activeLink({ recommendedSizeProfile: 'medium' })));
    expect(container.querySelector('[data-testid="public-install-link-size"]')?.textContent).toBe(
      'Recommended size: Medium',
    );

    act(() => {
      root.render(
        <InstallLinkControls
          applicationId={APP_ID}
          installLink={liveLink(activeLink())}
          onChanged={vi.fn().mockResolvedValue(undefined)}
        />,
      );
    });
    expect(container.querySelector('[data-testid="public-install-link-size"]')).toBeNull();
  });

  it('copies the direct link and reports success', async () => {
    renderControls(liveLink(activeLink()));
    await act(async () => {
      click(container.querySelector('[data-testid="public-install-link-copy-url"]'));
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(activeLink().url);
    expect(toast.success).toHaveBeenCalledWith('Install link copied.');
  });

  it('reports a clipboard failure without throwing', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    renderControls(liveLink(activeLink()));
    await act(async () => {
      click(container.querySelector('[data-testid="public-install-link-copy-url"]'));
    });
    await flush();
    expect(toast.error).toHaveBeenCalledWith('Couldn\'t copy. Copy it manually.');
  });

  it('copies the HTML snippet from the overflow menu', async () => {
    renderControls(liveLink(activeLink()));
    await act(async () => {
      click(container.querySelector('[data-testid="public-install-link-menu"]'));
    });
    await act(async () => {
      click(document.querySelector('[data-testid="public-install-link-copy-snippet"]'));
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      '<a href="https://app.deployz.dev/install/11111111-1111-1111-1111-111111111111">Deploy to AWS with Deployz</a>',
    );
    expect(toast.success).toHaveBeenCalledWith('HTML snippet copied.');
  });

  it('disables and enables the link from the overflow menu', async () => {
    linkMocks.setPublicInstallLinkEnabled.mockResolvedValue({ link: activeLink({ status: 'disabled' }) });
    const { onChanged } = renderControls(liveLink(activeLink()));

    await act(async () => {
      click(container.querySelector('[data-testid="public-install-link-menu"]'));
    });
    await act(async () => {
      click(document.querySelector('[data-testid="public-install-link-toggle"]'));
    });
    await flush();

    expect(linkMocks.setPublicInstallLinkEnabled).toHaveBeenCalledWith(activeLink().id, false);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('Install link disabled.');
  });

  it('requires confirmation before regenerating', async () => {
    linkMocks.regeneratePublicInstallLink.mockResolvedValue(createdLink());
    const { onChanged } = renderControls(liveLink(activeLink()));

    await act(async () => {
      click(container.querySelector('[data-testid="public-install-link-menu"]'));
    });
    await act(async () => {
      click(document.querySelector('[data-testid="public-install-link-regenerate"]'));
    });

    expect(document.body.textContent).toContain('Regenerate this install link?');
    expect(linkMocks.regeneratePublicInstallLink).not.toHaveBeenCalled();

    await act(async () => {
      click(document.querySelector('[data-testid="public-install-link-regenerate-confirm"]'));
    });
    await flush();

    expect(linkMocks.regeneratePublicInstallLink).toHaveBeenCalledWith(activeLink().id);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('requires confirmation before revoking', async () => {
    linkMocks.revokePublicInstallLink.mockResolvedValue({ link: activeLink({ status: 'revoked' }) });
    const { onChanged } = renderControls(liveLink(activeLink()));

    await act(async () => {
      click(container.querySelector('[data-testid="public-install-link-menu"]'));
    });
    await act(async () => {
      click(document.querySelector('[data-testid="public-install-link-revoke"]'));
    });

    expect(document.body.textContent).toContain('Revoke this install link?');
    expect(linkMocks.revokePublicInstallLink).not.toHaveBeenCalled();

    await act(async () => {
      click(document.querySelector('[data-testid="public-install-link-revoke-confirm"]'));
    });
    await flush();

    expect(linkMocks.revokePublicInstallLink).toHaveBeenCalledWith(activeLink().id);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('shows the API error inline instead of a toast', async () => {
    linkMocks.createPublicInstallLink.mockRejectedValue(
      new ApiRequestError('PUBLIC_INSTALL_LINK_EXISTS', 'Link exists'),
    );
    const { onChanged } = renderControls({ kind: 'create', note: null });

    await act(async () => {
      click(container.querySelector('[data-testid="public-install-link-create"]'));
    });
    await flush();

    expect(container.querySelector('[data-testid="public-install-link-error"]')?.textContent).toBe(
      'An install link already exists.',
    );
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});

describe('PublicInstallLinkCard', () => {
  it('renders a titled card wrapping the controls', () => {
    act(() => {
      root.render(
        <PublicInstallLinkCard
          applicationId={APP_ID}
          installLink={liveLink(activeLink())}
          onChanged={vi.fn().mockResolvedValue(undefined)}
        />,
      );
    });
    const card = container.querySelector('[data-testid="public-install-link-card"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('Customer install link');
    expect(card?.querySelector('[data-testid="public-install-link-status"]')).not.toBeNull();
  });
});
