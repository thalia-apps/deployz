// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApplicationReadiness } from '../src/lib/readiness';
import { fleetDeployment } from './fixtures/fleet-deployment';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The Applications list shows the badge the application page derives for the
// same data. It has no badge of its own to fall back to: while the reads are
// pending it shows a skeleton, and when they fail it says the status is unknown.

const mocks = vi.hoisted(() => ({
  fetchApplications: vi.fn(),
  fetchDeployments: vi.fn(),
  fetchReadiness: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/components/repository-picker', () => ({ RepositoryPicker: () => null }));

vi.mock('@/lib/applications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/applications')>();
  return { ...actual, fetchApplications: mocks.fetchApplications };
});

vi.mock('@/lib/deployments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/deployments')>();
  return { ...actual, fetchDeployments: mocks.fetchDeployments };
});

vi.mock('@/lib/readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/readiness')>();
  return { ...actual, fetchReadiness: mocks.fetchReadiness };
});

const ApplicationsPage = (await import('../src/app/dashboard/applications/page')).default;

function application(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `app-${id}`,
    repoFullName: `acme/${id}`,
    defaultBranch: 'main',
    analysisStatus: 'COMPLETE',
    compatibilityStatus: 'READY',
    ...overrides,
  };
}

function readiness(overrides: Partial<ApplicationReadiness> = {}): ApplicationReadiness {
  return {
    analysisStatus: 'COMPLETE',
    state: 'READY',
    requiredCount: 0,
    recommendedCount: 0,
    summary: null,
    failureReason: null,
    findings: [],
    passed: [],
    analyzedCommitSha: 'abc1234',
    detected: null,
    requirements: null,
    deploymentRequirementDrift: [],
    environmentSetup: null,
    ...overrides,
  };
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
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

async function renderList(): Promise<void> {
  await act(async () => {
    root.render(<ApplicationsPage />);
  });
  await act(async () => Promise.resolve());
}

function badge(id: string): string | undefined {
  return container.querySelector(`[data-testid="app-card-badge-${id}"]`)?.textContent ?? undefined;
}

describe('Applications list status', () => {
  it('shows what the application page shows, not the readiness verdict', async () => {
    mocks.fetchApplications.mockResolvedValue([
      application('a', { compatibilityStatus: 'NEEDS_ATTENTION' }),
      application('b'),
      application('c'),
    ]);
    mocks.fetchDeployments.mockResolvedValue([
      fleetDeployment({ id: 'd1', applicationId: 'b', deploymentType: 'PRODUCTION', state: 'FAILED' }),
      fleetDeployment({
        id: 'd2',
        applicationId: 'c',
        deploymentType: 'TEST',
        state: 'DELETED',
        deletedAt: '2026-10-20T00:00:00.000Z',
        currentReleaseConfirmedAt: '2026-10-19T00:00:00.000Z',
      }),
    ]);
    mocks.fetchReadiness.mockImplementation(async (id: string) =>
      id === 'a'
        ? readiness({
            environmentSetup: { needsDecision: 1, missingValue: 0, missingBuildValue: 0, customer: 0, total: 1 },
          })
        : readiness(),
    );

    await renderList();

    expect(mocks.fetchDeployments).toHaveBeenCalledWith({ includeDeleted: true });
    expect(badge('a')).toBe('Needs input');
    expect(badge('b')).toBe('Needs attention');
    expect(badge('c')).toBe('Ready to share');
  });

  it('says the status is unknown when the reads fail, never the readiness verdict', async () => {
    mocks.fetchApplications.mockResolvedValue([application('a')]);
    mocks.fetchDeployments.mockResolvedValue([]);
    mocks.fetchReadiness.mockRejectedValue(new Error('boom'));

    await renderList();

    expect(badge('a')).toBe('Status unknown');
  });

  it('shows no badge for an analysed application until its status is known', async () => {
    mocks.fetchApplications.mockResolvedValue([application('a')]);
    mocks.fetchDeployments.mockReturnValue(new Promise(() => undefined));

    await renderList();

    expect(badge('a')).toBeUndefined();
  });

  it('follows the analysis, not an older verdict, while an application is analysing', async () => {
    mocks.fetchApplications.mockResolvedValue([application('a', { analysisStatus: 'ANALYZING' })]);
    mocks.fetchDeployments.mockResolvedValue([]);

    await renderList();

    expect(badge('a')).toBe('Analysing');
    expect(mocks.fetchReadiness).not.toHaveBeenCalled();
  });
});
