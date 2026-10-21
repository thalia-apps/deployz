// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeploymentPlan, PublicInstallResolve } from '../src/lib/public-install-types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Radix radio items measure their size with ResizeObserver, which jsdom lacks.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
(globalThis as { Element?: { prototype: { scrollIntoView?: unknown } } }).Element!.prototype.scrollIntoView = vi.fn();

const routerMocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => routerMocks }));

const dataMocks = vi.hoisted(() => ({
  fetchPublicInstallData: vi.fn(),
  fetchPublicInstallPlan: vi.fn(),
}));
vi.mock('../src/lib/public-install-data', () => ({
  fetchPublicInstallData: dataMocks.fetchPublicInstallData,
  fetchPublicInstallPlan: dataMocks.fetchPublicInstallPlan,
}));

const { InvitationTokenGate } = await import('../src/components/invitation-token-gate');

const LINK_ID = '22222222-2222-2222-2222-222222222222';
const STORAGE_KEY = 'deployz-install-token:' + LINK_ID;
const TOKEN = 'one-time-invitation-token';

function planFixture(): DeploymentPlan {
  return {
    schemaVersion: 1,
    action: 'INSTALL',
    region: null,
    components: [
      { kind: 'application', name: 'Application', action: 'CREATE', lifecycle: 'delete' as const },
    ],
    awsResources: [],
    requirementDrift: [],
  };
}

function sizeOption(
  id: 'small' | 'medium' | 'large',
  label: string,
  recommended: boolean,
  cpuUnits: number,
  memoryMiB: number,
): PublicInstallResolve['sizing']['options'][number] {
  return {
    id,
    label,
    description: `${label} description`,
    recommended,
    workload: { cpuUnits, memoryMiB, desiredCount: 1 },
    database: { instanceClass: `db.${id}`, storageGb: 20 },
    cache: { nodeType: `cache.${id}`, nodeCount: 1 },
  };
}

function resolveFixture(overrides: Partial<PublicInstallResolve> = {}): PublicInstallResolve {
  return {
    application: { name: 'Acme App' },
    publisher: { name: 'Acme Inc' },
    release: { version: '1.2.0', createdAt: '2026-09-01T00:00:00.000Z' },
    recommendedRegion: 'us-east-1',
    regionSelection: 'customer',
    regions: [
      { value: 'us-east-1', label: 'US East (N. Virginia)' },
      { value: 'us-west-2', label: 'US West (Oregon)' },
    ],
    requiredInputs: [],
    sizing: {
      recommended: 'medium',
      minimum: 'small',
      options: [
        sizeOption('small', 'Small', false, 1024, 2048),
        sizeOption('medium', 'Medium', true, 2048, 4096),
      ],
    },
    plan: planFixture(),
    ...overrides,
  };
}

const cleanups: Array<() => void> = [];

function renderGate(view?: 'install' | 'security'): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <InvitationTokenGate installLinkId={LINK_ID} {...(view !== undefined ? { view } : {})} />,
    );
  });
  cleanups.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });
  return container;
}

/** Flush the gate's async resolve (effect + promise microtasks). */
async function flush(): Promise<void> {
  await act(async () => {});
  await act(async () => {});
}

describe('InvitationTokenGate', () => {
  beforeEach(() => {
    dataMocks.fetchPublicInstallData.mockReset();
    dataMocks.fetchPublicInstallPlan.mockReset().mockResolvedValue(null);
    routerMocks.push.mockReset();
    window.location.hash = '';
    window.sessionStorage.clear();
  });

  afterEach(() => {
    while (cleanups.length) {
      cleanups.pop()?.();
    }
    document.body.innerHTML = '';
  });

  it('captures the fragment token, strips it from the URL, and resolves privately', async () => {
    window.location.hash = '#' + TOKEN;
    const replaceState = vi.spyOn(window.history, 'replaceState');
    dataMocks.fetchPublicInstallData.mockResolvedValue({ status: 'ok', data: resolveFixture() });

    renderGate();
    await flush();

    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(TOKEN);
    expect(replaceState).toHaveBeenCalledWith(null, '', window.location.pathname);
    expect(window.location.hash).toBe('');
    expect(dataMocks.fetchPublicInstallData).toHaveBeenCalledWith(LINK_ID, TOKEN);
    expect(document.body.textContent).toContain('Acme App');
    // The token itself never appears anywhere on the page.
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it('reuses the stored token when the fragment is gone (reload, back-navigation)', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, TOKEN);
    dataMocks.fetchPublicInstallData.mockResolvedValue({ status: 'ok', data: resolveFixture() });

    renderGate();
    await flush();

    expect(dataMocks.fetchPublicInstallData).toHaveBeenCalledWith(LINK_ID, TOKEN);
    expect(document.body.textContent).toContain('Acme App');
  });

  it('shows the used-link copy for a consumed invitation (back after confirming)', async () => {
    window.location.hash = '#' + TOKEN;
    dataMocks.fetchPublicInstallData.mockResolvedValue({
      status: 'gone',
      code: 'PUBLIC_INSTALL_LINK_USED',
    });

    renderGate();
    await flush();

    expect(document.body.textContent).toContain('This application cannot be installed');
    expect(document.body.textContent).toContain(
      'This installation link has already been used. Contact your software provider if you need another installation.',
    );
  });

  it('fails safe with the invalid-link copy for a wrong token (404)', async () => {
    window.location.hash = '#wrong-token-value';
    dataMocks.fetchPublicInstallData.mockResolvedValue(null);

    renderGate();
    await flush();

    expect(dataMocks.fetchPublicInstallData).toHaveBeenCalledWith(LINK_ID, 'wrong-token-value');
    expect(document.body.textContent).toContain("This link isn't valid");
    expect(document.body.textContent).not.toContain('wrong-token-value');
  });

  it('offers a retry, not the invalid-link copy, when the control plane does not answer', async () => {
    window.location.hash = '#' + TOKEN;
    dataMocks.fetchPublicInstallData.mockResolvedValue({ status: 'error' });

    renderGate();
    await flush();

    expect(document.body.textContent).toContain("We can't load this page right now");
    expect(document.body.textContent).not.toContain("This link isn't valid");
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it('fails safe with the invalid-link copy when no token exists', async () => {
    renderGate();
    await flush();

    expect(dataMocks.fetchPublicInstallData).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("This link isn't valid");
  });

  it('view="security" renders the Security & AWS access heading once the token resolves', async () => {
    window.location.hash = '#' + TOKEN;
    dataMocks.fetchPublicInstallData.mockResolvedValue({ status: 'ok', data: resolveFixture() });

    renderGate('security');
    await flush();

    expect(dataMocks.fetchPublicInstallData).toHaveBeenCalledWith(LINK_ID, TOKEN);
    expect(document.querySelector('h1')?.textContent).toBe('Security & AWS access');
    // The install confirm flow itself never renders on the security view.
    expect(document.querySelector('[data-slot="select-trigger"]')).toBeNull();
  });
});
