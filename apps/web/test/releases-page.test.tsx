// @vitest-environment jsdom
import { act, forwardRef, useEffect, useImperativeHandle } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeploymentPlan } from '@deployz/contracts';

import type { Release } from '../src/lib/releases';
import type { FleetDeployment } from '../src/lib/deployments';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  fetchReleases: vi.fn(),
  fetchDeploymentsForApplication: vi.fn(),
  fetchDeploymentPlan: vi.fn(),
  createRelease: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'app-1' }),
}));

vi.mock('../src/lib/releases', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/releases')>();
  return {
    ...actual,
    fetchReleases: mocks.fetchReleases,
    createRelease: mocks.createRelease,
  };
});

vi.mock('@/lib/deployments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/deployments')>();
  return {
    ...actual,
    fetchDeploymentsForApplication: mocks.fetchDeploymentsForApplication,
    fetchDeploymentPlan: mocks.fetchDeploymentPlan,
  };
});

// The New release form's commit field talks to GitHub; stub it out with a
// field that is always "ready" and resolves to a fixed SHA, so these tests
// only exercise submission and the BUILD_CONFIGURATION_MISSING error path.
vi.mock('@/components/commit-picker', () => ({
  CommitPicker: forwardRef((props: { onReadyChange?: (ready: boolean) => void }, ref) => {
    useImperativeHandle(ref, () => ({
      resolveGitSha: async () => 'a'.repeat(40),
    }));
    useEffect(() => {
      props.onReadyChange?.(true);
    }, [props]);
    return null;
  }),
}));

// CreateReleaseForm reads useApplicationPage() for the default branch, but
// the page itself now also reads it for the application's repo, to link a
// release's commit to GitHub.
vi.mock('../src/app/dashboard/applications/[id]/application-page-context', () => ({
  useApplicationPage: () => ({
    refresh: async () => undefined,
    data: {
      application: {
        id: 'app-1',
        repoFullName: 'acme/api',
        defaultBranch: 'main',
      },
    },
  }),
}));

const ReleasesPage = (await import('../src/app/dashboard/applications/[id]/releases/page')).default;

function makeRelease(overrides: Partial<Release>): Release {
  return {
    id: 'rel-1',
    version: 'v1.0.0',
    status: 'READY',
    failureReason: null,
    gitSha: 'a'.repeat(40),
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeDeployment(overrides: Partial<FleetDeployment>): FleetDeployment {
  return {
    id: 'dep-1',
    customerId: 'cus-1',
    applicationId: 'app-1',
    organizationId: 'org-1',
    region: 'us-east-1',
    state: 'HEALTHY',
    awsAccountId: null,
    currentReleaseId: null,
    previousReleaseId: null,
    relayStatus: 'CONNECTED',
    healthStatus: 'HEALTHY',
    components: null,
    installLinkId: 'link-1',
    desiredState: {},
    observedState: null,
    infraVersion: 'runtime-v1',
    installationId: 'inst-1',
    deploymentType: 'PRODUCTION',
    billingState: 'NOT_STARTED',
    billingStartedAt: null,
    billingStoppedAt: null,
    lastHealthAt: null,
    deletedAt: null,
    cleanupState: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    createdBy: null,
    updatedBy: null,
    customerName: 'Acme Corp',
    applicationName: 'MyApp',
    version: null,
    relayVersion: null,
    ...overrides,
  } as FleetDeployment;
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  // A settled no-change plan by default: table tests that happen to load
  // deployments must not crash on the infrastructure line's own fetch.
  mocks.fetchDeploymentPlan.mockResolvedValue(makeUpdatePlan({ status: 'none' }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function renderPage(): void {
  root.render(<ReleasesPage />);
}

async function waitForTable(): Promise<HTMLElement> {
  return vi.waitFor(() => {
    const el = container.querySelector('table');
    if (!el) throw new Error('still loading');
    return el as HTMLElement;
  });
}

describe('Releases table', () => {
  it('orders releases newest first', async () => {
    mocks.fetchReleases.mockResolvedValue([
      makeRelease({ id: 'old', version: 'v0.1.0', createdAt: '2026-09-01T00:00:00.000Z' }),
      makeRelease({ id: 'new', version: 'v0.2.0', createdAt: '2026-09-10T00:00:00.000Z' }),
    ]);
    mocks.fetchDeploymentsForApplication.mockResolvedValue([]);

    await act(async () => {
      renderPage();
    });
    await waitForTable();

    const rows = Array.from(container.querySelectorAll('tbody tr[data-testid^="release-row-"]'));
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'release-row-new',
      'release-row-old',
    ]);
  });

  it('marks the newest READY release as what customers install when a newer one failed', async () => {
    mocks.fetchReleases.mockResolvedValue([
      makeRelease({ id: 'ready', version: 'v0.1.0', status: 'READY', createdAt: '2026-09-01T00:00:00.000Z' }),
      makeRelease({
        id: 'failed',
        version: 'v0.1.1',
        status: 'FAILED',
        failureReason: 'Failed to fetch repo tarball (ref: sadsad22)',
        createdAt: '2026-09-10T00:00:00.000Z',
      }),
    ]);
    mocks.fetchDeploymentsForApplication.mockResolvedValue([]);

    await act(async () => {
      renderPage();
    });
    await waitForTable();

    const summary = container.querySelector('[data-testid="release-install-summary"]');
    expect(summary?.textContent).toBe('Customer installs get v0.1.0 (commit aaaaaaa).');

    const readyRow = container.querySelector('[data-testid="release-row-ready"]');
    expect(readyRow?.textContent).toContain('Customer installs');

    const failedRow = container.querySelector('[data-testid="release-row-failed"]');
    expect(failedRow?.textContent).not.toContain('Customer installs');
    // The failure explanation is visible on the row itself, not only behind a disclosure.
    expect(container.querySelector('[data-testid="release-failure-failed"]')?.textContent).toBeTruthy();
  });

  it('expanding a row reveals the full commit SHA and timestamp', async () => {
    const release = makeRelease({ id: 'rel-1', gitSha: 'b2806f9010820a5659899cd0ce0b98d31561041', createdAt: '2026-09-01T12:00:00.000Z' });
    mocks.fetchReleases.mockResolvedValue([release]);
    mocks.fetchDeploymentsForApplication.mockResolvedValue([]);

    await act(async () => {
      renderPage();
    });
    await waitForTable();

    expect(container.textContent).not.toContain(release.gitSha);

    const toggle = container.querySelector('[aria-controls="release-details-rel-1"]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    await act(async () => {
      toggle.click();
    });

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const details = container.querySelector('[data-testid="release-details-rel-1"]');
    expect(details?.textContent).toContain(release.gitSha);
    expect(details?.textContent).toMatch(/2026/);
  });

  it('distinguishes test and customer deployments running a release', async () => {
    const release = makeRelease({ id: 'rel-1' });
    mocks.fetchReleases.mockResolvedValue([release]);
    mocks.fetchDeploymentsForApplication.mockResolvedValue([
      makeDeployment({ id: 'd1', currentReleaseId: 'rel-1', deploymentType: 'TEST' }),
      makeDeployment({ id: 'd2', currentReleaseId: 'rel-1', deploymentType: 'PRODUCTION' }),
      makeDeployment({ id: 'd3', currentReleaseId: 'rel-1', deploymentType: 'PRODUCTION' }),
      makeDeployment({ id: 'd4', currentReleaseId: 'rel-1', deploymentType: 'PRODUCTION', state: 'DELETED', deletedAt: '2026-09-02T00:00:00.000Z' }),
    ]);

    await act(async () => {
      renderPage();
    });
    await waitForTable();

    const row = container.querySelector('[data-testid="release-row-rel-1"]');
    expect(row?.textContent).toContain('Test deployment');
    expect(row?.textContent).toContain('2 customer deployments');
  });

  it('shows an empty state when there are no releases', async () => {
    mocks.fetchReleases.mockResolvedValue([]);
    mocks.fetchDeploymentsForApplication.mockResolvedValue([]);

    await act(async () => {
      renderPage();
    });

    await vi.waitFor(() => {
      const el = container.querySelector('#empty-releases');
      if (!el) throw new Error('still loading');
      return el;
    });

    expect(container.textContent).toContain('No releases yet');
  });

  it('shows an error state when releases fail to load', async () => {
    mocks.fetchReleases.mockRejectedValue(new Error('boom'));
    mocks.fetchDeploymentsForApplication.mockResolvedValue([]);

    await act(async () => {
      renderPage();
    });

    await vi.waitFor(() => {
      const el = container.querySelector('#releases-error');
      if (!el) throw new Error('still loading');
      return el;
    });

    expect(container.textContent).toContain("Couldn't load releases");
  });
});

describe('Build polling', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-reads a building release until it settles, without a reload', async () => {
    mocks.fetchDeploymentsForApplication.mockResolvedValue([]);
    mocks.fetchReleases
      .mockResolvedValueOnce([makeRelease({ id: 'b', version: 'v0.1.0', status: 'BUILDING' })])
      .mockResolvedValue([makeRelease({ id: 'b', version: 'v0.1.0', status: 'FAILED', failureReason: 'x' })]);

    vi.useFakeTimers({ shouldAdvanceTime: true });
    await act(async () => {
      renderPage();
    });
    await waitForTable();
    expect(container.querySelector('[data-testid="release-row-b"]')?.textContent).toContain('Building');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(container.querySelector('[data-testid="release-row-b"]')?.textContent).toContain('Build failed');
    expect(mocks.fetchReleases).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mocks.fetchReleases).toHaveBeenCalledTimes(2);
  });
});

describe('Create release form', () => {
  beforeEach(() => {
    mocks.fetchReleases.mockResolvedValue([]);
    mocks.fetchDeploymentsForApplication.mockResolvedValue([]);
  });

  async function openForm(): Promise<void> {
    await act(async () => {
      renderPage();
    });
    await vi.waitFor(() => {
      const el = container.querySelector('#empty-releases');
      if (!el) throw new Error('still loading');
      return el;
    });
    const toggle = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Create release',
    ) as HTMLButtonElement;
    await act(async () => {
      toggle.click();
    });
  }

  it('has no per-release migration command field', async () => {
    await openForm();
    expect(container.querySelector('#migrationCommand')).toBeNull();
  });

  it('shows the BUILD_CONFIGURATION_MISSING message and a link to Configuration when a release cannot build', async () => {
    const { BuildConfigurationMissingError } = await import('../src/lib/releases');
    mocks.createRelease.mockRejectedValue(new BuildConfigurationMissingError(['STRIPE_SECRET', 'SENTRY_DSN']));

    await openForm();

    const form = container.querySelector('[data-testid="create-release-form"]') as HTMLElement;
    const versionInput = form.querySelector('#version') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(versionInput, 'v1.0.0');
    versionInput.dispatchEvent(new Event('input', { bubbles: true }));

    const submitButton = Array.from(form.querySelectorAll('button')).find(
      (button) => button.textContent === 'Create release',
    ) as HTMLButtonElement;

    await act(async () => {
      submitButton.click();
    });

    expect(container.textContent).toContain(
      'Set these build values before you build a release: STRIPE_SECRET, SENTRY_DSN.',
    );
    const link = container.querySelector('a[href="/dashboard/applications/app-1/config#environment-variables"]');
    expect(link?.textContent).toBe('Review configuration');
  });
});

function makeUpdatePlan(infrastructureChange: DeploymentPlan['infrastructureChange']): DeploymentPlan {
  return {
    schemaVersion: 1,
    action: 'UPDATE',
    region: 'us-east-1',
    components: [],
    awsResources: [],
    requirementDrift: [],
    ...(infrastructureChange ? { infrastructureChange } : {}),
  };
}

describe('Release infrastructure line', () => {
  beforeEach(() => {
    mocks.fetchReleases.mockResolvedValue([makeRelease({ id: 'rel-1' })]);
    mocks.fetchDeploymentsForApplication.mockResolvedValue([
      makeDeployment({ id: 'dep-1', state: 'HEALTHY' }),
    ]);
  });

  it('shows a quiet no-changes line when the update plan reports no infrastructure change', async () => {
    mocks.fetchDeploymentPlan.mockResolvedValue(makeUpdatePlan({ status: 'none' }));

    await act(async () => {
      renderPage();
    });
    await waitForTable();

    await vi.waitFor(() => {
      if (!container.querySelector('[data-testid="release-infrastructure-none"]')) {
        throw new Error('still loading');
      }
    });
    expect(container.querySelector('[data-testid="release-infrastructure-none"]')?.textContent).toBe(
      'No infrastructure changes',
    );
    expect(mocks.fetchDeploymentPlan).toHaveBeenCalledWith('dep-1', 'update');
    expect(container.querySelector('[data-testid="release-infrastructure-unsupported"]')).toBeNull();
  });

  it('shows a warning alert when the release needs unsupported topology changes', async () => {
    mocks.fetchDeploymentPlan.mockResolvedValue(
      makeUpdatePlan({ status: 'unsupported', reason: 'topology_changed' }),
    );

    await act(async () => {
      renderPage();
    });
    await waitForTable();

    await vi.waitFor(() => {
      if (!container.querySelector('[data-testid="release-infrastructure-unsupported"]')) {
        throw new Error('still loading');
      }
    });
    expect(container.textContent).toContain('Infrastructure requirements changed');
    expect(container.textContent).toContain(
      'This release needs infrastructure changes. Deployz cannot apply them to an existing deployment. Create a new deployment for each customer that needs this release.',
    );
    expect(container.querySelector('[data-testid="release-infrastructure-none"]')).toBeNull();
  });

  it('hides the block when the plan fetch fails', async () => {
    mocks.fetchDeploymentPlan.mockRejectedValue(new Error('boom'));

    await act(async () => {
      renderPage();
    });
    await waitForTable();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="release-infrastructure-none"]')).toBeNull();
    expect(container.querySelector('[data-testid="release-infrastructure-unsupported"]')).toBeNull();
    // The page itself is unaffected.
    expect(container.querySelector('[data-testid="release-row-rel-1"]')).not.toBeNull();
  });

  it('hides the block when the application has no deployments', async () => {
    mocks.fetchDeploymentsForApplication.mockResolvedValue([]);

    await act(async () => {
      renderPage();
    });
    await waitForTable();

    expect(mocks.fetchDeploymentPlan).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="release-infrastructure-none"]')).toBeNull();
    expect(container.querySelector('[data-testid="release-infrastructure-unsupported"]')).toBeNull();
  });
});
