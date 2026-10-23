// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TEST_DEPLOYMENT_POLL_MS } from '../src/lib/application-state';
import type { ApplicationArchitecture, ApplicationReadiness, ReadinessFinding } from '../src/lib/readiness';
import { fleetDeployment } from './fixtures/fleet-deployment';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The Overview tab renders exclusively from `presentation` — this file locks
// the whole assembly (layout header + tabs + the Overview page) against the
// documented state matrix in test/application-state.test.ts, so a component
// cannot quietly drift from what the mapper derives.

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  pathname: '/dashboard/applications/app-1',
  fetchApplication: vi.fn(),
  triggerAnalysis: vi.fn(),
  fetchApplicationPlan: vi.fn(),
  fetchReadiness: vi.fn(),
  fetchDeploymentsForApplication: vi.fn(),
  fetchPublicInstallLinks: vi.fn(),
  fetchReleases: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'app-1' }),
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: mocks.push, replace: mocks.replace, refresh: mocks.refresh }),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/lib/applications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/applications')>();
  return {
    ...actual,
    fetchApplication: mocks.fetchApplication,
    triggerAnalysis: mocks.triggerAnalysis,
    fetchApplicationPlan: mocks.fetchApplicationPlan,
  };
});

vi.mock('@/lib/readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/readiness')>();
  return {
    ...actual,
    fetchReadiness: mocks.fetchReadiness,
  };
});

vi.mock('@/lib/deployments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/deployments')>();
  return {
    ...actual,
    fetchDeploymentsForApplication: mocks.fetchDeploymentsForApplication,
  };
});

vi.mock('@/lib/public-install-links', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/public-install-links')>();
  return {
    ...actual,
    fetchPublicInstallLinks: mocks.fetchPublicInstallLinks,
  };
});

vi.mock('@/lib/releases', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/releases')>();
  return {
    ...actual,
    fetchReleases: mocks.fetchReleases,
  };
});

const ApplicationLayout = (await import('../src/app/dashboard/applications/[id]/layout')).default;
const ApplicationOverviewPage = (await import('../src/app/dashboard/applications/[id]/page')).default;

function baseApplication(overrides: Record<string, unknown> = {}) {
  return {
    id: 'app-1',
    organizationId: 'org-1',
    name: 'Acme API',
    githubInstallationId: 'inst-1',
    repoFullName: 'acme/api',
    repoUrl: 'https://github.com/acme/api',
    defaultBranch: 'main',
    containerPort: null,
    healthPath: null,
    migrationCommand: null,
    workerCommand: null,
    databaseRequired: false,
    storageRequired: false,
    redisRequired: false,
    analysisStatus: 'COMPLETE' as const,
    compatibilityStatus: null,
    compatibilityReason: null,
    detectedMetadata: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function requiredFinding(overrides: Partial<ReadinessFinding> = {}): ReadinessFinding {
  return {
    id: 'health-endpoint',
    category: 'health',
    title: 'Health endpoint missing',
    severity: 'required',
    blocking: true,
    plainEnglishExplanation: 'Deployz requires an HTTP health endpoint.',
    whyItMatters: 'Without it, Deployz cannot tell if your app is running.',
    technicalEvidence: 'No route responded on /health.',
    suggestedOutcome: 'Add a GET /health route that returns HTTP 200.',
    confidence: 'confirmed',
    ...overrides,
  };
}

/** `environmentSetup` is added to `ApplicationReadiness` by a companion
 *  change; widen the fixture type locally (mirrors application-state.test.ts). */
interface EnvironmentSetupCounts {
  needsDecision: number;
  missingValue: number;
  missingBuildValue: number;
  customer: number;
  total: number;
}
type ReadinessFixture = ApplicationReadiness & { environmentSetup?: EnvironmentSetupCounts | null };

function baseReadiness(overrides: Partial<ReadinessFixture> = {}): ReadinessFixture {
  return {
    analysisStatus: 'COMPLETE',
    state: 'READY',
    requiredCount: 0,
    recommendedCount: 0,
    summary: null,
    failureReason: null,
    findings: [],
    passed: [{ id: 'docker', label: 'Docker container detected' }],
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
  mocks.pathname = '/dashboard/applications/app-1';
  mocks.fetchApplicationPlan.mockResolvedValue(null);
  mocks.fetchPublicInstallLinks.mockResolvedValue([]);
  mocks.fetchReleases.mockResolvedValue([]);

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
});

function renderPage(): void {
  root.render(
    <ApplicationLayout>
      <ApplicationOverviewPage />
    </ApplicationLayout>,
  );
}

async function waitForHeading(): Promise<HTMLElement> {
  return vi.waitFor(() => {
    const el = container.querySelector('[data-testid="application-state-heading"]');
    if (!(el instanceof HTMLElement) || !el.textContent) throw new Error('still loading');
    return el;
  });
}

interface Case {
  name: string;
  badgeLabel: string;
  arrange: () => void;
  installLinkPlacement: 'primary' | 'card' | 'none';
  hasLifecycle: boolean;
}

const CASES: Case[] = [
  {
    name: 'analysing',
    badgeLabel: 'Analysing',
    arrange: () => {
      mocks.fetchApplication.mockResolvedValue(baseApplication({ analysisStatus: 'ANALYZING' }));
      mocks.fetchReadiness.mockResolvedValue(baseReadiness({ analysisStatus: 'ANALYZING', state: 'ANALYSIS_INCOMPLETE' }));
      mocks.fetchDeploymentsForApplication.mockResolvedValue([]);
    },
    installLinkPlacement: 'none',
    hasLifecycle: true,
  },
  {
    name: 'configuration-required',
    badgeLabel: 'Needs input',
    arrange: () => {
      mocks.fetchApplication.mockResolvedValue(baseApplication());
      mocks.fetchReadiness.mockResolvedValue(
        baseReadiness({ state: 'NEEDS_CHANGES', requiredCount: 1, findings: [requiredFinding()] }),
      );
      mocks.fetchDeploymentsForApplication.mockResolvedValue([]);
    },
    installLinkPlacement: 'none',
    hasLifecycle: true,
  },
  {
    name: 'configuration-review',
    badgeLabel: 'Needs input',
    arrange: () => {
      mocks.fetchApplication.mockResolvedValue(baseApplication());
      mocks.fetchReadiness.mockResolvedValue(
        baseReadiness({ environmentSetup: { needsDecision: 2, missingValue: 0, missingBuildValue: 0, customer: 0, total: 2 } }),
      );
      mocks.fetchDeploymentsForApplication.mockResolvedValue([]);
    },
    installLinkPlacement: 'none',
    hasLifecycle: true,
  },
  {
    name: 'ready-to-test',
    badgeLabel: 'Ready to test',
    arrange: () => {
      mocks.fetchApplication.mockResolvedValue(baseApplication());
      mocks.fetchReadiness.mockResolvedValue(baseReadiness());
      mocks.fetchDeploymentsForApplication.mockResolvedValue([]);
    },
    installLinkPlacement: 'none',
    hasLifecycle: true,
  },
  {
    name: 'test-deploying',
    badgeLabel: 'Testing',
    arrange: () => {
      mocks.fetchApplication.mockResolvedValue(baseApplication());
      mocks.fetchReadiness.mockResolvedValue(baseReadiness());
      mocks.fetchDeploymentsForApplication.mockResolvedValue([
        fleetDeployment({ deploymentType: 'TEST', state: 'INSTALLING' }),
      ]);
    },
    installLinkPlacement: 'none',
    hasLifecycle: true,
  },
  {
    name: 'test-failed',
    badgeLabel: 'Test failed',
    arrange: () => {
      mocks.fetchApplication.mockResolvedValue(baseApplication());
      mocks.fetchReadiness.mockResolvedValue(baseReadiness());
      mocks.fetchDeploymentsForApplication.mockResolvedValue([
        fleetDeployment({ deploymentType: 'TEST', state: 'FAILED' }),
      ]);
    },
    installLinkPlacement: 'none',
    hasLifecycle: true,
  },
  {
    name: 'ready-to-share',
    badgeLabel: 'Ready to share',
    arrange: () => {
      mocks.fetchApplication.mockResolvedValue(baseApplication());
      mocks.fetchReadiness.mockResolvedValue(baseReadiness());
      mocks.fetchDeploymentsForApplication.mockResolvedValue([
        fleetDeployment({ deploymentType: 'TEST', state: 'HEALTHY' }),
      ]);
    },
    installLinkPlacement: 'primary',
    hasLifecycle: false,
  },
  {
    name: 'customers-active',
    badgeLabel: 'Live',
    arrange: () => {
      mocks.fetchApplication.mockResolvedValue(baseApplication());
      mocks.fetchReadiness.mockResolvedValue(baseReadiness());
      mocks.fetchDeploymentsForApplication.mockResolvedValue([
        fleetDeployment({ deploymentType: 'PRODUCTION', state: 'HEALTHY' }),
      ]);
    },
    installLinkPlacement: 'card',
    hasLifecycle: false,
  },
  {
    name: 'unavailable',
    badgeLabel: 'Unavailable',
    arrange: () => {
      mocks.fetchApplication.mockRejectedValue(new Error('boom'));
      mocks.fetchReadiness.mockRejectedValue(new Error('boom'));
      mocks.fetchDeploymentsForApplication.mockRejectedValue(new Error('boom'));
      mocks.fetchPublicInstallLinks.mockRejectedValue(new Error('boom'));
      mocks.fetchReleases.mockRejectedValue(new Error('boom'));
    },
    installLinkPlacement: 'none',
    hasLifecycle: false,
  },
];

describe.each(CASES)('$name state', ({ badgeLabel, arrange, installLinkPlacement, hasLifecycle }) => {
  beforeEach(() => {
    arrange();
  });

  it('renders one heading, the matching badge, and no leaked vocabulary', async () => {
    await act(async () => {
      renderPage();
    });
    await waitForHeading();

    // Exactly one state heading, no duplicate "Latest test deployment" or
    // other section headings competing with it.
    expect(container.querySelectorAll('[data-testid="application-state-heading"]')).toHaveLength(1);
    expect(container.querySelector('#latest-deployment-heading')).toBeNull();
    expect(container.textContent).not.toContain('Latest test deployment');

    const badge = container.querySelector('[data-testid="application-status-badge"]');
    expect(badge?.textContent).toBe(badgeLabel);

    expect(container.textContent).not.toMatch(/checks? passed/i);
    expect(container.textContent).not.toContain('Not installed');
  });

  it(`shows the setup lifecycle ${hasLifecycle ? '' : 'not '}during this state`, async () => {
    await act(async () => {
      renderPage();
    });
    await waitForHeading();
    const lifecycle = container.querySelector('[data-testid="lifecycle-steps"]');
    if (hasLifecycle) expect(lifecycle).not.toBeNull();
    else expect(lifecycle).toBeNull();
  });

  it(`places the install link as '${installLinkPlacement}'`, async () => {
    await act(async () => {
      renderPage();
    });
    await waitForHeading();

    const card = container.querySelector('[data-testid="public-install-link-card"]');
    if (installLinkPlacement === 'card') {
      expect(card).not.toBeNull();
    } else {
      expect(card).toBeNull();
    }

    if (installLinkPlacement === 'primary') {
      // The install-link controls take over the state card's own footer.
      expect(container.querySelector('[data-testid="public-install-link-create"]')).not.toBeNull();
    }
  });
});

describe('configuration-required action and Share note', () => {
  it('the primary action links to the Configuration tab required-changes anchor', async () => {
    CASES.find((c) => c.name === 'configuration-required')!.arrange();
    await act(async () => {
      renderPage();
    });
    await waitForHeading();

    const action = container.querySelector('[data-testid="readiness-review-blocker"]');
    expect(action?.getAttribute('href')).toBe('/dashboard/applications/app-1/config#required-changes');
    expect(action?.textContent).toBe('Review required changes');
  });

  it('shows the outcome and the required items in fix-class groups', async () => {
    mocks.fetchApplication.mockResolvedValue(baseApplication());
    mocks.fetchReadiness.mockResolvedValue(
      baseReadiness({
        state: 'ALMOST_READY',
        outcome: 'DEPLOYABLE_WITH_CHANGES',
        requiredCount: 2,
        findings: [
          requiredFinding({ id: 'health-check', title: 'No health check', blocking: false, fixClass: 'SETTING' }),
          requiredFinding({ id: 'local-file-storage', title: 'Files on local disk', blocking: false, fixClass: 'CODE_CHANGE' }),
        ],
      }),
    );
    mocks.fetchDeploymentsForApplication.mockResolvedValue([]);
    await act(async () => {
      renderPage();
    });
    await waitForHeading();

    expect(container.querySelector('[data-testid="deployability-outcome"]')?.textContent).toContain(
      'Deployable after repository changes',
    );
    expect(container.querySelector('[data-testid="blocker-group-SETTING"]')?.textContent).toContain('Set in Deployz');
    expect(container.querySelector('[data-testid="blocker-group-CODE_CHANGE"]')?.textContent).toContain(
      'Change in your repository',
    );
    expect(container.querySelector('[data-testid="blocker-group-CAPABILITY_GAP"]')).toBeNull();
    // local-file-storage is disputable: the card links to the row that has the answer.
    expect(container.querySelector('[data-testid="blocker-dispute-hint"] a')?.getAttribute('href')).toBe(
      '/dashboard/applications/app-1/config#required-changes',
    );
  });

  it('shows no dispute hint when no required item is disputable', async () => {
    mocks.fetchApplication.mockResolvedValue(baseApplication());
    mocks.fetchReadiness.mockResolvedValue(
      baseReadiness({
        state: 'NEEDS_CHANGES',
        outcome: 'NOT_DEPLOYABLE',
        requiredCount: 1,
        findings: [requiredFinding({ id: 'unsupported-gpu', title: 'Needs a GPU', fixClass: 'CAPABILITY_GAP' })],
      }),
    );
    mocks.fetchDeploymentsForApplication.mockResolvedValue([]);
    await act(async () => {
      renderPage();
    });
    await waitForHeading();

    expect(container.querySelector('[data-testid="blocker-group-CAPABILITY_GAP"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="blocker-dispute-hint"]')).toBeNull();
  });

  it('never-eligible states show a short Share note instead of the inactive install-link card', async () => {
    CASES.find((c) => c.name === 'ready-to-test')!.arrange();
    await act(async () => {
      renderPage();
    });
    await waitForHeading();

    expect(container.querySelector('[data-testid="public-install-link-card"]')).toBeNull();
    expect(container.textContent).toContain('Install link available after');
  });
});

describe('ready-to-share with a live link', () => {
  it('shows Copy link as primary and a visible Manage button instead of an icon-only menu', async () => {
    mocks.fetchApplication.mockResolvedValue(baseApplication());
    mocks.fetchReadiness.mockResolvedValue(baseReadiness());
    mocks.fetchDeploymentsForApplication.mockResolvedValue([
      fleetDeployment({ deploymentType: 'TEST', state: 'HEALTHY' }),
    ]);
    mocks.fetchPublicInstallLinks.mockResolvedValue([
      {
        id: 'link-1',
        url: 'https://deployz.dev/i/abc123',
        status: 'active',
        createdAt: '2026-08-01T00:00:00.000Z',
        revokedAt: null,
      },
    ]);

    await act(async () => {
      renderPage();
    });
    await waitForHeading();

    expect(container.querySelector('[data-testid="public-install-link-copy-url"]')?.textContent).toContain(
      'Copy install link',
    );
    const menuButton = container.querySelector('[data-testid="public-install-link-menu"]');
    expect(menuButton?.textContent).toContain('Manage');
  });
});

describe('Release readiness', () => {
  it('never offers a test deployment when the only release failed to build', async () => {
    CASES.find((c) => c.name === 'ready-to-test')!.arrange();
    mocks.fetchReleases.mockResolvedValue([
      {
        id: 'rel-1',
        version: 'efa70adbc63e',
        status: 'FAILED',
        failureReason: 'CodeBuild reported FAILED — BUILD: The image build did not produce an image',
        gitSha: 'efa70adbc63e'.padEnd(40, '0'),
        createdAt: '2026-09-23T17:22:39.781Z',
      },
    ]);
    await act(async () => {
      renderPage();
    });
    const heading = await waitForHeading();

    expect(heading.textContent).toBe('No release to test');
    expect(container.querySelector('[data-testid="application-status-badge"]')?.textContent).toBe('Ready to test');
    expect(container.textContent).not.toContain('Start test deployment');
    const review = Array.from(container.querySelectorAll('a')).find((a) => a.textContent === 'Review failed build');
    expect(review?.getAttribute('href')).toBe('/dashboard/applications/app-1/releases');
  });

  it('says the test deployment builds the first release from branch@sha when none exists yet', async () => {
    CASES.find((c) => c.name === 'ready-to-test')!.arrange();
    mocks.fetchApplication.mockResolvedValue(baseApplication({ defaultBranch: 'main' }));
    mocks.fetchReadiness.mockResolvedValue(baseReadiness({ analyzedCommitSha: 'abc1234def' }));
    mocks.fetchReleases.mockResolvedValue([]);

    await act(async () => {
      renderPage();
    });
    await waitForHeading();

    expect(container.textContent).toContain('builds the first release from main@abc1234');
  });

  it('says nothing about the first release when the analysed commit is unknown', async () => {
    CASES.find((c) => c.name === 'ready-to-test')!.arrange();
    mocks.fetchReadiness.mockResolvedValue(baseReadiness({ analyzedCommitSha: null }));
    mocks.fetchReleases.mockResolvedValue([]);

    await act(async () => {
      renderPage();
    });
    await waitForHeading();

    expect(container.textContent).not.toContain('builds the first release');
  });
});

describe('Application tabs', () => {
  it('render the three sections with the right hrefs and mark the active one', async () => {
    CASES.find((c) => c.name === 'ready-to-test')!.arrange();
    await act(async () => {
      renderPage();
    });
    await waitForHeading();

    const tabs = Array.from(container.querySelectorAll('[role="tab"]'));
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Overview', 'Releases', 'Configuration']);
    expect(tabs.map((tab) => tab.getAttribute('href'))).toEqual([
      '/dashboard/applications/app-1',
      '/dashboard/applications/app-1/releases',
      '/dashboard/applications/app-1/config',
    ]);

    const selected = tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]?.textContent).toBe('Overview');
  });
});

describe('Active to terminal polling', () => {
  it('stops polling once a test deployment settles from installing to healthy', async () => {
    vi.useFakeTimers();
    mocks.fetchApplication.mockResolvedValue(baseApplication());
    mocks.fetchReadiness.mockResolvedValue(baseReadiness());
    mocks.fetchDeploymentsForApplication
      .mockResolvedValueOnce([fleetDeployment({ deploymentType: 'TEST', state: 'INSTALLING' })])
      .mockResolvedValue([fleetDeployment({ deploymentType: 'TEST', state: 'HEALTHY' })]);

    await act(async () => {
      renderPage();
    });
    await act(async () => Promise.resolve());

    let heading = container.querySelector('[data-testid="application-state-heading"]') as HTMLElement;
    expect(heading.textContent).toBe('Test deployment in progress');
    expect(heading.querySelector('[data-slot="spinner"]')).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TEST_DEPLOYMENT_POLL_MS);
    });

    heading = container.querySelector('[data-testid="application-state-heading"]') as HTMLElement;
    expect(heading.textContent).toBe('Ready to share');
    expect(heading.querySelector('[data-slot="spinner"]')).toBeNull();

    const callsAtSettle = mocks.fetchDeploymentsForApplication.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(mocks.fetchDeploymentsForApplication.mock.calls.length).toBe(callsAtSettle);
  });
});

function architectureFixture(): ApplicationArchitecture {
  return {
    counts: { total: 3, detected: 2, confirmed: 1 },
    groups: [
      { group: 'application', nodes: [{ label: 'Web service', state: 'confirmed' }] },
      { group: 'data', nodes: [{ label: 'PostgreSQL', state: 'detected' }] },
      { group: 'edge', nodes: [{ label: 'Load balancer', state: 'detected' }] },
    ],
    unresolved: [{ kind: 'cache', question: 'Do you need a cache?', blocking: false }],
    externalServices: [],
  };
}

describe('services detected line', () => {
  it('counts architecture components and links into Configuration › Services', async () => {
    mocks.fetchApplication.mockResolvedValue(baseApplication());
    mocks.fetchReadiness.mockResolvedValue(baseReadiness({ architecture: architectureFixture() }));
    mocks.fetchDeploymentsForApplication.mockResolvedValue([]);

    await act(async () => {
      renderPage();
    });
    await waitForHeading();

    const line = container.querySelector('[data-testid="application-services-count"]');
    expect(line?.textContent).toContain('3 services detected');
    const link = line?.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/dashboard/applications/app-1/config#services');
  });

  it('does not render when there is nothing detected and no plan', async () => {
    mocks.fetchApplication.mockResolvedValue(baseApplication());
    mocks.fetchReadiness.mockResolvedValue(baseReadiness());
    mocks.fetchDeploymentsForApplication.mockResolvedValue([]);

    await act(async () => {
      renderPage();
    });
    await waitForHeading();

    expect(container.querySelector('[data-testid="application-services-count"]')).toBeNull();
  });
});
