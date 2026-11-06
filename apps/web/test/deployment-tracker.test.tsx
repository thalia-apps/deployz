// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CustomerDeploymentStatus, DeploymentStep } from '@deployz/contracts';

// Focused tests for the redesigned customer deployment progress page.
// Covers the four wireframe areas the PR is meant to fix:
//   1. One authoritative X-of-Y stepper replacing the prior top status card.
//   2. Compact resource table with honest states (Ready / Starting / Creating
//      / Failed), no "In progress" for resources the data proves are ready.
//   3. The newest AWS activity shown in the tracker; the full feed kept
//      secondary.
//   4. Deployment details collapsed by default; resources, the step list,
//      the full feed, and existing diagnostic data remain accessible behind it.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const mocks = vi.hoisted(() => ({
  fetchInstallStatus: vi.fn(),
  fetchDomainAccess: vi.fn(),
}));

vi.mock('../src/lib/install-status', () => ({
  fetchInstallStatus: mocks.fetchInstallStatus,
}));

vi.mock('../src/lib/domains', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/domains')>();
  return { ...actual, fetchDomainAccess: mocks.fetchDomainAccess };
});

const { InstallProgress } = await import('../src/components/install-progress');

const STEPS: DeploymentStep[] = [
  'AWS_SETUP',
  'RELAY_CONNECT',
  'PREPARING',
  'NETWORK',
  'DATABASE_STORAGE',
  'MIGRATION',
  'APPLICATION',
  'HEALTH_CHECK',
  'TLS',
  'READY',
];

function baseStatus(overrides: Partial<CustomerDeploymentStatus> = {}): CustomerDeploymentStatus {
  return {
    stage: 'PROVISIONING',
    updatedAt: '2026-09-18T00:00:00.000Z',
    currentActivity: 'Creating the database.',
    step: 'DATABASE_STORAGE',
    steps: STEPS,
    typicalDurationSeconds: { min: 180, max: 600 },
    takingLongerThanUsual: false,
    removed: false,
    statusUpdatesUnavailable: false,
    needsDomainSetup: false,
    components: [],
    url: null,
    failure: null,
    ...overrides,
  };
}

function baseProps(overrides: Partial<Parameters<typeof InstallProgress>[0]> = {}) {
  return {
    installLinkId: 'link-1',
    deploymentId: 'dep-1',
    initialStatus: null,
    quickCreateUrl: null,
    initialDomain: null,
    routingTarget: null,
    ...overrides,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(props: ReturnType<typeof baseProps>): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<InstallProgress {...props} />);
  });
}

function findTestId(testId: string): HTMLElement {
  const element = container!.querySelector(`[data-testid="${testId}"]`);
  expect(element).toBeDefined();
  return element as HTMLElement;
}

async function openDeploymentDetails(): Promise<void> {
  const trigger = Array.from(container!.querySelectorAll('[data-slot="collapsible-trigger"]')).find((element) =>
    element.textContent?.includes('Deployment details'),
  ) as HTMLElement;
  expect(trigger).toBeDefined();
  await act(async () => {
    trigger.click();
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
  }
  container?.remove();
  container = null;
  root = null;
  vi.useRealTimers();
  mocks.fetchInstallStatus.mockReset();
  mocks.fetchDomainAccess.mockReset();
});

describe('Customer deployment progress — authoritative stepper', () => {
  it('renders the X-of-Y line derived from completed and total rungs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:20:00.000Z'));
    const status = baseStatus({ step: 'APPLICATION' });
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();

    const text = container!.textContent ?? '';
    // The primary headline mirrors the server-derived stage (the legacy
    // STAGE_HEADLINE map). For stage=PROVISIONING it reads "Creating
    // application infrastructure" — the same headline the E2E scenario-ui
    // suite asserts on the customer install page. The X-of-Y secondary line
    // carries the granular progress: at step=APPLICATION exactly two rungs
    // are complete (account, infrastructure).
    expect(text).toContain('Creating application infrastructure');
    expect(text).toContain('2 of 6 steps complete');
  });

  it('renders each rung with its completed, current, or waiting marker', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:20:00.000Z'));
    const status = baseStatus({ step: 'APPLICATION' });
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();

    const text = container!.textContent ?? '';
    // Each rung's customer label is on the page. Done rungs render their
    // "done" copy ("AWS account connected", "Infrastructure created");
    // the current rung renders its active copy ("Starting application");
    // pending rungs render their pending copy ("Check application",
    // "Set up HTTPS", "Ready").
    expect(text).toContain('AWS account connected');
    expect(text).toContain('Infrastructure created');
    expect(text).toContain('Starting application');
    expect(text).toContain('Check application');
    expect(text).toContain('Set up HTTPS');
    expect(text).toContain('Ready');

    // Each rung has its own per-rung testid — the stepper is real, not a
    // single status string.
    expect(findTestId('tracker-step-account')).toBeTruthy();
    expect(findTestId('tracker-step-infrastructure')).toBeTruthy();
    expect(findTestId('tracker-step-application')).toBeTruthy();
    expect(findTestId('tracker-step-health')).toBeTruthy();
    expect(findTestId('tracker-step-https')).toBeTruthy();
    expect(findTestId('tracker-step-ready')).toBeTruthy();

    // Completed rungs render the check marker, the current rung renders the
    // spinning marker, and upcoming rungs render the neutral circle.
    expect(findTestId('step-marker-done')).toBeTruthy();
    expect(findTestId('step-marker-current')).toBeTruthy();
    expect(findTestId('step-marker-waiting')).toBeTruthy();
  });
});

describe('Customer deployment progress — normal vs delayed messaging', () => {
  it('does not show the "No action needed" reassurance while AWS is progressing normally', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = baseStatus({ takingLongerThanUsual: false, stepStartedAt: new Date().toISOString() });
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();

    const text = container!.textContent ?? '';
    expect(text).not.toContain('No action needed');
    expect(text).toContain('Usually takes 3–10 minutes');
    expect(findTestId('tracker-current-detail').textContent).toContain('Usually takes 3–10 minutes');
    expect(findTestId('tracker-step-elapsed').textContent).toBe('0s on this step');
  });

  it('shows the "No action needed" reassurance only when the server flag says so', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = baseStatus({ takingLongerThanUsual: true, stepStartedAt: new Date().toISOString() });
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();

    expect(findTestId('tracker-no-action-needed')).toBeTruthy();
    expect(container!.textContent ?? '').toContain('AWS is still processing the deployment.');
  });

  it('shows the failure panel with the existing recovery copy at FAILED', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = baseStatus({
      stage: 'FAILED',
      step: 'DATABASE_STORAGE',
      failure: {
        ownedByApplication: false,
        customerActionRequired: false,
        customerMessage: 'Deployz could not finish setting up your infrastructure.',
        component: 'database',
        reference: 'REF-777',
        technical: { stage: 'PROVISIONING', component: 'database', awsStatus: 'Resource creation failed' },
      },
    });
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();

    const text = container!.textContent ?? '';
    expect(text).toContain('Deployment failed');
    expect(text).toContain('Deployz could not finish setting up your infrastructure.');
    expect(text).toContain('Contact your software provider and ask them to retry the deployment.');
  });
});

describe('Customer deployment progress — resource statuses', () => {
  it('shows Ready for resources the data proves are ready, never "In progress"', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = baseStatus({
      components: [
        { key: 'runtime', label: 'Application runtime', status: 'READY' },
        { key: 'database', label: 'PostgreSQL database', status: 'IN_PROGRESS' },
        { key: 'redis', label: 'Redis', status: 'NOT_REQUIRED' },
      ],
    });
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();

    expect(container!.querySelector('[data-testid="deployment-resources"]')).toBeNull();
    await openDeploymentDetails();

    const text = container!.textContent ?? '';
    expect(text).toContain('Resources');
    expect(text).toContain('Application runtime');
    expect(text).toContain('Ready');
    expect(text).toContain('PostgreSQL database');
    expect(text).toContain('Creating');
    expect(text).not.toContain('Redis');
    expect(text).not.toContain('Not required');
  });

  it('renders one row per spec component, each with an honest state label', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = baseStatus({
      components: [{ key: 'runtime', label: 'Application runtime', status: 'READY' }],
      specComponents: [
        { componentId: 'network', label: 'Private network', state: 'COMPLETE' },
        { componentId: 'database', label: 'MySQL', state: 'IN_PROGRESS' },
        { componentId: 'application', label: 'Web', state: 'FAILED' },
      ],
    });
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();

    expect(container!.textContent ?? '').not.toContain('Private network');
    await openDeploymentDetails();

    const text = container!.textContent ?? '';
    expect(text).toContain('Private network');
    expect(text).toContain('Complete');
    expect(text).toContain('MySQL');
    expect(text).toContain('In progress');
    expect(text).toContain('Web');
    expect(text).toContain('Failed');
    expect(text).not.toContain('Application runtime');
  });
});

describe('Customer deployment progress — live AWS activity', () => {
  it('shows the newest activity in the tracker and the full feed only inside Deployment details', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = baseStatus({
      recentActivity: [
        { key: 'a2', at: new Date().toISOString(), message: 'Creating the database.', state: 'IN_PROGRESS' },
        { key: 'a1', at: new Date().toISOString(), message: 'Network created.', state: 'COMPLETE' },
      ],
    });
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();

    const latest = findTestId('latest-aws-activity');
    expect(latest.textContent).toContain('Latest AWS activity');
    expect(latest.textContent).toContain('Creating the database.');
    expect(container!.textContent ?? '').not.toContain('Network created.');
    expect(container!.querySelector('[data-testid="live-aws-activity-list"]')).toBeNull();

    await openDeploymentDetails();

    expect(findTestId('live-aws-activity-list')).toBeTruthy();
    const text = container!.textContent ?? '';
    expect(text).toContain('Live AWS activity');
    expect(text).toContain('Network created.');
    expect(text).toContain('Creating the database.');
  });

  it('hides the activity section when AWS has not reported anything', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = baseStatus({ recentActivity: undefined });
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();

    expect(container!.querySelector('[data-testid="latest-aws-activity"]')).toBeNull();
    expect(container!.querySelector('[data-testid="live-aws-activity-list"]')).toBeNull();
  });
});

describe('Customer deployment progress — Deployment details', () => {
  it('is collapsed by default — no raw CloudFormation events in the visible text', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = baseStatus({
      technicalDetails: {
        reference: 'REF-123',
        facts: [{ label: 'Stack status', value: 'CREATE_IN_PROGRESS' }],
        events: [
          {
            at: new Date().toISOString(),
            logicalResourceId: 'DatabaseInstance',
            resourceType: 'AWS::RDS::DBInstance',
            resourceStatus: 'CREATE_IN_PROGRESS',
            resourceStatusReason: null,
          },
        ],
      },
    });
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();

    const text = container!.textContent ?? '';
    expect(text).not.toContain('CREATE_IN_PROGRESS');
    expect(text).not.toContain('DatabaseInstance');
    expect(text).not.toContain('REF-123');
  });

  it('reveals the reference and raw events only after the disclosure is opened', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = baseStatus({
      technicalDetails: {
        reference: 'REF-123',
        facts: [{ label: 'Stack status', value: 'CREATE_IN_PROGRESS' }],
        events: [
          {
            at: new Date().toISOString(),
            logicalResourceId: 'DatabaseInstance',
            resourceType: 'AWS::RDS::DBInstance',
            resourceStatus: 'CREATE_IN_PROGRESS',
            resourceStatusReason: null,
          },
        ],
      },
    });
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();

    await openDeploymentDetails();

    const text = container!.textContent ?? '';
    expect(text).toContain('REF-123');
    expect(text).toContain('CREATE_IN_PROGRESS');
    expect(text).toContain('DatabaseInstance');
  });
});
