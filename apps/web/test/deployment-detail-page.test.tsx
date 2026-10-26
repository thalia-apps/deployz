// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FleetDeploymentDetail } from '../src/lib/deployments';
import type { Release } from '../src/lib/releases';

import { fleetDeployment } from './fixtures/fleet-deployment';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The first render loads the whole page module graph.
vi.setConfig({ testTimeout: 30_000 });

const mocks = vi.hoisted(() => ({
  fetchDeployment: vi.fn(),
  fetchDeploymentEvents: vi.fn(),
  fetchDeploymentInfrastructure: vi.fn(),
  fetchDeploymentPlan: vi.fn(),
  fetchReleases: vi.fn(),
  fetchDiagnostics: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'dep-1' }) }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('../src/lib/deployments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/deployments')>();
  return {
    ...actual,
    fetchDeployment: mocks.fetchDeployment,
    fetchDeploymentEvents: mocks.fetchDeploymentEvents,
    fetchDeploymentInfrastructure: mocks.fetchDeploymentInfrastructure,
    fetchDeploymentPlan: mocks.fetchDeploymentPlan,
  };
});
vi.mock('../src/lib/releases', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/releases')>();
  return { ...actual, fetchReleases: mocks.fetchReleases };
});
vi.mock('../src/lib/diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/diagnostics')>();
  return { ...actual, fetchDiagnostics: mocks.fetchDiagnostics };
});

const { default: DeploymentDetailPage } = await import('../src/app/dashboard/deployments/[id]/page');

function release(id: string, version: string): Release {
  return {
    id,
    version,
    status: 'READY',
    failureReason: null,
    gitSha: 'a'.repeat(40),
    createdAt: '2026-09-01T00:00:00.000Z',
  };
}

function detail(failureCode?: string): FleetDeploymentDetail {
  const base = fleetDeployment({
    currentReleaseId: 'r1',
    relayCapabilities: {
      deployRelease: true,
      rollback: true,
      restart: true,
      configUpdate: true,
      destroy: true,
      domainManagement: true,
    },
    deploymentStatus: {
      health: { status: 'HEALTHY', layers: {} },
      aws: { stackStatus: null },
      servingRelease: { releaseId: null, confirmedAt: null, confirmed: false },
      connector: { upgradeRequired: false, reason: null, updateAvailable: false, updateUrl: null, updateTemplateUrl: null, installedBuildId: null, publishedBuildId: null, stackState: 'UNKNOWN' as const, observedAt: null },
      url: null,
      failure: failureCode
        ? { code: failureCode, component: null, reference: 'ref-1', message: 'It failed.', awsStatus: null }
        : null,
    } as never,
  });
  return { ...base, jobs: [], customDomain: null, appUrl: null, defaultUrl: null };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderPage(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<DeploymentDetailPage />);
  });
}

beforeEach(() => {
  mocks.fetchDeployment.mockResolvedValue(detail());
  mocks.fetchDeploymentEvents.mockResolvedValue([]);
  mocks.fetchDeploymentInfrastructure.mockRejectedValue(new Error('unused'));
  mocks.fetchDeploymentPlan.mockResolvedValue({ requirementDrift: [] });
  mocks.fetchReleases.mockResolvedValue([release('r1', 'v1.0.0')]);
  mocks.fetchDiagnostics.mockResolvedValue([]);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((b) => b.textContent === label);
}

describe('deployment detail page loading', () => {
  it('renders the deployment while releases and activity are still pending', async () => {
    mocks.fetchReleases.mockReturnValue(new Promise(() => undefined));
    mocks.fetchDeploymentEvents.mockReturnValue(new Promise(() => undefined));
    await renderPage();
    expect(document.body.textContent).toContain('MyApp');
    expect(document.body.textContent).toContain('Loading activity…');
    expect(document.body.textContent).not.toContain("Couldn't load this deployment");
  });

  it('marks only the activity feed as unavailable when its request fails', async () => {
    mocks.fetchDeploymentEvents.mockRejectedValue(new Error('down'));
    await renderPage();
    expect(document.body.textContent).toContain('Activity unavailable');
    expect(document.body.textContent).toContain('MyApp');
  });
});

describe('Deploy update dialog', () => {
  it('refetches releases each time the dialog opens and offers the newer release', async () => {
    await renderPage();
    expect(mocks.fetchReleases).toHaveBeenCalledTimes(1);

    mocks.fetchReleases.mockResolvedValue([release('r1', 'v1.0.0'), release('r2', 'v1.1.0')]);
    await act(async () => {
      button('Deploy update')!.click();
    });
    expect(mocks.fetchReleases).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain('v1.1.0');
  });

  it('shows the retry path when the refresh fails', async () => {
    await renderPage();
    mocks.fetchReleases.mockRejectedValue(new Error('down'));
    await act(async () => {
      button('Deploy update')!.click();
    });
    expect(document.body.textContent).toContain("Couldn't load releases");
    mocks.fetchReleases.mockResolvedValue([release('r1', 'v1.0.0'), release('r2', 'v1.1.0')]);
    await act(async () => {
      button('Try again')!.click();
    });
    expect(document.body.textContent).toContain('v1.1.0');
  });
});

describe('Configuration action after a failure', () => {
  function configurationLink(): Element | undefined {
    return [...document.querySelectorAll('a')].find((a) => a.textContent === 'Configuration');
  }

  it('is offered when nothing failed', async () => {
    await renderPage();
    expect(configurationLink()).toBeDefined();
  });

  it('is offered for a failure fixed on the Configuration screen', async () => {
    mocks.fetchDeployment.mockResolvedValue(detail('MISSING_SECRET'));
    await renderPage();
    expect(configurationLink()).toBeDefined();
  });

  it('is not offered for a failure that configuration cannot fix', async () => {
    mocks.fetchDeployment.mockResolvedValue(detail('QUOTA_EXCEEDED'));
    await renderPage();
    expect(configurationLink()).toBeUndefined();
    expect(button('Configuration')).toBeUndefined();
  });
});
