// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CustomerDeploymentStatus, DeploymentPlan, DeploymentStep, SpecComponent } from '@deployz/contracts';

import { TAKING_LONGER_MESSAGE } from '../src/lib/deployment-progress';
import { OWNERSHIP_NOTE } from '../src/lib/security-details';

// react-dom/client's act() checks this flag before running; without it, every
// act() call warns even though the assertions below pass.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const mocks = vi.hoisted(() => ({
  fetchInstallStatus: vi.fn(),
  fetchDomainAccess: vi.fn(),
}));

vi.mock('../src/lib/install-status', () => ({
  fetchInstallStatus: mocks.fetchInstallStatus,
}));

// CustomDomainCard (rendered once the stage grants Access) fetches domain
// access on mount — stub it so mounting a READY/VERIFYING state never makes
// a real request. Every other export of the module (pure copy/labels) stays
// real.
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

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function findTestId(testId: string): HTMLElement {
  const element = container!.querySelector(`[data-testid="${testId}"]`);
  expect(element).not.toBeNull();
  return element as HTMLElement;
}

function findTrigger(label: string): HTMLElement {
  const trigger = Array.from(container!.querySelectorAll('[data-slot="collapsible-trigger"]')).find(
    (element) => element.textContent?.includes(label),
  ) as HTMLElement | undefined;
  expect(trigger).toBeDefined();
  return trigger!;
}

async function openDeploymentDetails(): Promise<void> {
  await act(async () => {
    click(findTrigger('Deployment details'));
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

describe('InstallProgress — success flow', () => {
  it('shows the live step detail, recent activity, keeps Deployment details closed by default, then goes quiet on READY', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:20:00.000Z'));

    const stepStartedAt = new Date(Date.now() - (4 * 60_000 + 12_000)).toISOString(); // 4m12s ago
    let current = baseStatus({
      stepStartedAt,
      recentActivity: [
        { key: 'a2', at: new Date(Date.now() - 5_000).toISOString(), message: 'Creating the database.', state: 'IN_PROGRESS' },
        { key: 'a1', at: new Date(Date.now() - 60_000).toISOString(), message: 'Network created.', state: 'COMPLETE' },
      ],
      technicalDetails: {
        reference: 'REF-123',
        facts: [{ label: 'Stack status', value: 'CREATE_IN_PROGRESS' }],
        events: [
          {
            at: new Date(Date.now() - 10_000).toISOString(),
            logicalResourceId: 'DatabaseInstance',
            resourceType: 'AWS::RDS::DBInstance',
            resourceStatus: 'CREATE_IN_PROGRESS',
            resourceStatusReason: null,
          },
        ],
      },
    });
    mocks.fetchInstallStatus.mockImplementation(() => Promise.resolve(current));
    mocks.fetchDomainAccess.mockResolvedValue({ canManage: false, domain: null });

    mount(baseProps({ initialStatus: current }));
    await flush();

    const text = () => container!.textContent ?? '';

    // The tracker headline + X-of-Y line — primary progress, not raw stage.
    // The headline mirrors the server-derived stage (legacy STAGE_HEADLINE),
    // so PROVISIONING renders "Creating application infrastructure" — the
    // same headline the E2E scenario-ui suite asserts on the customer page.
    expect(text()).toContain('Creating application infrastructure');
    expect(text()).toContain('1 of 6 steps complete');
    // The current rung is named and described; wire substeps (database,
    // storage, etc.) are technical detail — they stay behind Deployment details.
    expect(text()).toContain('Creating infrastructure');
    expect(text()).toContain('Create the network, database, and storage for your application.');
    expect(text()).toContain('Creating the database.');
    expect(text()).toContain('Usually takes 3–10 minutes');
    expect(findTestId('tracker-step-elapsed').textContent).toBe('4m 12s on this step');
    expect(findTestId('tracker-current-detail').textContent).not.toContain('4m 12s');

    // The tracker carries only the newest activity item; the full feed waits
    // behind Deployment details.
    expect(findTestId('latest-aws-activity').textContent).toContain('Creating the database.');
    expect(text()).not.toContain('Network created.');
    expect(text()).not.toContain('Live AWS activity');

    // Jargon confined to the collapsed Deployment details disclosure: closed
    // by default, Radix does not render its children, so none of the raw
    // facts/events show up in the visible text yet.
    expect(text()).not.toContain('CREATE_IN_PROGRESS');
    expect(text()).not.toContain('DatabaseInstance');
    expect(text()).not.toContain('REF-123');

    // Reference, facts and the raw CloudFormation events all live behind the
    // one bottom "Deployment details" disclosure now.
    await openDeploymentDetails();
    expect(text()).toContain('Live AWS activity');
    expect(text()).toContain('Network created.');
    expect(text()).toContain('REF-123');
    expect(text()).toContain('CREATE_IN_PROGRESS');
    expect(text()).toContain('DatabaseInstance');

    // The deployment finishes: the next poll returns READY.
    current = baseStatus({ stage: 'READY', step: 'READY', url: 'https://app.example.com', removed: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(text()).not.toContain('on this step');
    expect(text()).not.toContain('Live AWS activity');
    expect(container!.querySelector('[data-testid="latest-aws-activity"]')).toBeNull();
    // The tracker headline mirrors the server-derived stage. At READY that
    // is "Your application is ready" (the legacy STAGE_HEADLINE copy the
    // E2E scenario-ui suite asserts on the customer install page); the
    // access section beneath keeps the customer-facing sentence
    // "Available securely at ...".
    expect(text()).toContain('Your application is ready');
    expect(text()).toContain('Access');
    const callsAtReady = mocks.fetchInstallStatus.mock.calls.length;

    // Terminal (READY): polling slows to once a minute, not the 5 s cadence.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    const extraCalls = mocks.fetchInstallStatus.mock.calls.length - callsAtReady;
    expect(extraCalls).toBeGreaterThanOrEqual(4);
    expect(extraCalls).toBeLessThanOrEqual(5);
  });

  it('a FAILED page picks up the vendor retry without a reload', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const failed = baseStatus({
      stage: 'FAILED',
      step: 'DATABASE_STORAGE',
      failure: {
        ownedByApplication: false,
        customerActionRequired: false,
        customerMessage: 'Deployz could not finish setting up your infrastructure.',
        component: 'database',
        reference: 'REF-1',
        technical: { stage: 'PROVISIONING', component: 'database', awsStatus: 'Resource creation failed' },
      },
    });
    mocks.fetchInstallStatus.mockResolvedValue(failed);

    mount(baseProps({ initialStatus: failed }));
    await flush();
    expect(container!.textContent).toContain('Deployment failed');

    // The vendor retries: the next status is a running install again.
    mocks.fetchInstallStatus.mockResolvedValue(baseStatus({ stage: 'PROVISIONING', step: 'NETWORK' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(container!.textContent).not.toContain('Deployment failed');
    // The primary headline mirrors the server-derived stage. Once the vendor
    // retries, the deployment is back at PROVISIONING and the customer page
    // carries the same "Creating application infrastructure" headline it had
    // before the failure.
    expect(container!.textContent).toContain('Creating application infrastructure');
  });
});

describe('InstallProgress — long-running flow', () => {
  it('grows the elapsed time through a stalled poll, and keeps the same tracker copy once it lands', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const stepStartedAt = new Date(Date.now()).toISOString();
    const status = baseStatus({ stepStartedAt });

    // First fetch (on mount) resolves immediately; the next one (at the 5s
    // poll mark) hangs until resolved manually, so real time can pass beyond
    // the last successful check.
    let resolveStalled!: (value: CustomerDeploymentStatus) => void;
    mocks.fetchInstallStatus
      .mockResolvedValueOnce(status)
      .mockImplementationOnce(() => new Promise((resolve) => (resolveStalled = resolve)));

    mount(baseProps({ initialStatus: status }));
    await flush();

    const text = () => container!.textContent ?? '';
    expect(text()).toContain('0s on this step');
    // The redesigned primary view intentionally drops the freshness stamp
    // ("Checked N seconds ago") — that's a technical-detail indicator, not
    // customer progress. The tracker's elapsed counter is what the customer
    // reads, and stays as the only timing line in the visible flow.
    expect(text()).not.toContain('Checked');

    // The poll fires at 5s and stalls; three more seconds pass on the
    // 1-second ticker with no successful check yet — the elapsed counter
    // keeps growing on its own ticker.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(text()).toContain('8s on this step');

    // The stalled poll finally lands: the tracker keeps its copy unchanged
    // (no freshness stamp appears in the primary view — that was the
    // technical-detail element the redesign moved out).
    resolveStalled(status);
    await flush();
    expect(text()).toContain('8s on this step');
    expect(text()).not.toContain('Checked');
  });

  it('shows the exact reassuring sentence when taking longer than usual', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = baseStatus({ takingLongerThanUsual: true, stepStartedAt: new Date().toISOString() });
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();

    expect(container!.textContent ?? '').toContain(TAKING_LONGER_MESSAGE);
  });

  it('does not promise that AWS is still working before the connector has connected', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = baseStatus({
      stage: 'WAITING_FOR_AWS',
      step: 'AWS_SETUP',
      currentActivity: 'AWS is creating the Deployz connector in your account.',
      takingLongerThanUsual: true,
      stepStartedAt: new Date().toISOString(),
    });
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();

    expect(container!.textContent ?? '').not.toContain('No action needed');
  });

  it('the HTTPS step waiting on the customer keeps its fixed copy — no elapsed counter, no "still working" nudge', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = baseStatus({
      stage: 'VERIFYING',
      step: 'TLS',
      needsDomainSetup: true,
      takingLongerThanUsual: true,
      typicalDurationSeconds: null,
      stepStartedAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    const text = container!.textContent ?? '';
    // The redesigned tracker keeps the domain-waiting explanation in the
    // Access section ("set up a custom domain below to finish") rather than
    // as a wire-substep label inside the tracker.
    expect(text).toContain('Set up a custom domain below for a secure address');
    expect(text).not.toContain('on this step');
    expect(text).not.toMatch(/still working/);
  });

  it('while the health check runs and no address is confirmed, Access does not claim none is configured', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = baseStatus({ stage: 'VERIFYING', step: 'HEALTH_CHECK', url: null });
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();

    const text = container!.textContent ?? '';
    expect(text).toContain('The address appears here after health checks pass.');
    expect(text).not.toContain('No public address configured');
  });

  it('renders the starting-application step through the same live detail', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = baseStatus({
      step: 'APPLICATION',
      currentActivity: 'Starting the application.',
      stepStartedAt: new Date().toISOString(),
    });
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();

    const text = container!.textContent ?? '';
    expect(text).toContain('Starting application');
    expect(text).toContain('Starting the application.');
    expect(findTestId('tracker-current-detail').textContent).toContain('Starting the application.');
    expect(findTestId('tracker-step-elapsed').textContent).toBe('0s on this step');
  });

  it('shows Live AWS activity only once AWS has reported something — never before launch, never with an empty feed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const waiting = baseStatus({
      stage: 'WAITING_FOR_AWS',
      step: 'AWS_SETUP',
      currentActivity: 'AWS is creating the Deployz connector in your account.',
      stepStartedAt: new Date().toISOString(),
    });
    mocks.fetchInstallStatus.mockResolvedValue(waiting);

    mount(baseProps({ initialStatus: waiting }));
    await flush();
    expect(container!.textContent).toContain('AWS is creating the Deployz connector in your account.');
    // No recentActivity reported yet: neither the latest row nor the feed shows.
    expect(container!.querySelector('[data-testid="latest-aws-activity"]')).toBeNull();
    await openDeploymentDetails();
    expect(container!.textContent).not.toContain('Live AWS activity');

    mocks.fetchInstallStatus.mockResolvedValue(
      baseStatus({
        stage: 'CONNECTING',
        step: 'RELAY_CONNECT',
        currentActivity: 'The connector is ready.',
        recentActivity: [
          { key: 'a1', at: new Date().toISOString(), message: 'Connector enrolled.', state: 'COMPLETE' },
        ],
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(findTestId('latest-aws-activity').textContent).toContain('Connector enrolled.');
    expect(container!.textContent).toContain('Live AWS activity');
    expect(container!.textContent).toContain('Connector enrolled.');
  });

  it('a payload without the new optional fields still renders the plain duration line and does not crash', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    // No stepStartedAt/recentActivity/provisioningIssue/technicalDetails —
    // the older-API mixed-version window (§brief).
    const status = baseStatus();
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();

    const text = container!.textContent ?? '';
    expect(text).toContain('Usually takes 3–10 minutes');
    expect(text).not.toContain('on this step');
    // No events reported: neither the latest row nor the feed is shown.
    expect(container!.querySelector('[data-testid="latest-aws-activity"]')).toBeNull();
    expect(text).not.toContain('Live AWS activity');
  });
});

describe('InstallProgress — failure flow', () => {
  it('shows the AWS-reported-a-problem alert immediately during PROVISIONING', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = baseStatus({ provisioningIssue: { message: 'A database resource failed to create.' } });
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();

    const text = container!.textContent ?? '';
    expect(text).toContain('AWS reported a problem');
    expect(text).toContain('A database resource failed to create.');
  });

  it('a FAILED payload shows the friendly message, with the raw reason inside opened Technical details', async () => {
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
        reference: 'REF-999',
        technical: { stage: 'PROVISIONING', component: 'database', awsStatus: 'Resource creation failed' },
      },
      technicalDetails: {
        reference: 'REF-999',
        facts: [{ label: 'Stack status', value: 'ROLLBACK_COMPLETE' }],
        events: [
          {
            at: new Date().toISOString(),
            logicalResourceId: 'DatabaseInstance',
            resourceType: 'AWS::RDS::DBInstance',
            resourceStatus: 'CREATE_FAILED',
            resourceStatusReason: 'The parameter MasterUserPassword is not a valid password.',
          },
        ],
      },
    });
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();

    const text = () => container!.textContent ?? '';
    expect(text()).toContain('Deployment failed');
    expect(text()).toContain('Deployz could not finish setting up your infrastructure.');
    // The failed rung stays visible; completed rungs collapse into "N steps
    // done" (ux-guidelines §9) — expand it to see them stayed complete.
    expect(text()).toContain('Creating infrastructure failed');
    expect(text()).not.toContain('(in progress)');
    // A failed step has no next step: the operation stopped there.
    expect(text()).not.toContain('Next:');
    await act(async () => {
      click(findTrigger('step done'));
    });
    expect(text()).toContain('AWS account connected');
    // Default next steps: the vendor owns the retry.
    expect(text()).toContain('No action is required.');
    expect(text()).not.toContain('ROLLBACK_COMPLETE');
    expect(text()).not.toContain('is not a valid password');

    const trigger = container!.querySelector('[data-slot="collapsible-trigger"]') as HTMLElement;
    await act(async () => {
      click(trigger);
    });
    expect(text()).toContain('ROLLBACK_COMPLETE');
    expect(text()).toContain('is not a valid password');
  });

  it('a FAILED payload with cleanup in progress and customer action shows the cleanup sentence and the actionable next step', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = baseStatus({
      stage: 'FAILED',
      step: 'APPLICATION',
      cleanup: 'IN_PROGRESS',
      failure: {
        ownedByApplication: false,
        customerActionRequired: true,
        customerMessage: 'AWS could not grant Deployz the permissions it needs.',
        component: null,
        reference: 'REF-424',
        technical: null,
      },
    });
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();

    const text = () => container!.textContent ?? '';
    expect(text()).toContain('Deployment failed');
    expect(text()).toContain('Starting application failed');
    expect(text()).toContain('Deployz stopped the deployment and is cleaning up resources from this attempt.');
    expect(text()).toContain(
      'Something in the AWS account or setup must change before a retry can succeed. Contact your software provider to retry after that change.',
    );
    expect(text()).not.toContain('No action is required.');
  });

  it('a FAILED payload whose resources may remain shows the retained-resources cleanup sentence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = baseStatus({
      stage: 'FAILED',
      step: 'APPLICATION',
      cleanup: 'RETAINED',
      failure: {
        ownedByApplication: false,
        customerActionRequired: false,
        customerMessage: 'Deployz could not finish setting up your infrastructure.',
        component: null,
        reference: 'REF-425',
        technical: null,
      },
    });
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();

    const text = () => container!.textContent ?? '';
    expect(text()).toContain('Some data or resources may remain in your AWS account.');
    expect(text()).toContain('No action is required.');
  });
});

describe('InstallProgress — AWS deployment details (READY)', () => {
  const summary = {
    applicationStackName: 'deployz-app-abcd1234',
    region: 'us-east-1',
    releaseVersion: 'v1.4.2',
  };

  function readyStatus(overrides: Partial<CustomerDeploymentStatus> = {}): CustomerDeploymentStatus {
    return baseStatus({ stage: 'READY', step: 'READY', url: 'https://app.example.com', ...overrides });
  }

  async function openSummaryTrigger(): Promise<() => string> {
    const trigger = Array.from(container!.querySelectorAll('[data-slot="collapsible-trigger"]')).find((element) =>
      element.textContent?.includes('Deployment details'),
    ) as HTMLElement | undefined;
    expect(trigger).toBeDefined();
    await act(async () => {
      click(trigger!);
    });
    return () => container!.textContent ?? '';
  }

  it('READY with awsSummary renders the collapsed summary, the CloudFormation link, and the ownership note', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = readyStatus({ awsSummary: summary });
    mocks.fetchInstallStatus.mockResolvedValue(status);
    mocks.fetchDomainAccess.mockResolvedValue({ canManage: false, domain: null });

    mount(baseProps({ initialStatus: status }));
    await flush();

    const closedText = container!.textContent ?? '';
    // The ownership note is always visible at READY; the stack details stay
    // collapsed behind Deployment details.
    expect(closedText).toContain('Deployment details');
    expect(closedText).toContain(OWNERSHIP_NOTE);
    expect(closedText).not.toContain(summary.applicationStackName);

    const text = await openSummaryTrigger();
    expect(text()).toContain(summary.applicationStackName);
    expect(text()).toContain('us-east-1');
    expect(text()).toContain(summary.releaseVersion);
    expect(text()).toContain('Last checked');
    expect(text()).toContain('https://app.example.com');

    const consoleLink = Array.from(container!.querySelectorAll('a')).find((anchor) =>
      anchor.getAttribute('href')?.includes('cloudformation'),
    );
    expect(consoleLink).toBeDefined();
    expect(consoleLink!.getAttribute('href')).toBe(
      `https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks?filteringText=${summary.applicationStackName}`,
    );
    expect(consoleLink!.getAttribute('target')).toBe('_blank');
    expect(consoleLink!.getAttribute('rel')).toBe('noreferrer');
  });

  it('READY without awsSummary renders no summary section', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = readyStatus();
    mocks.fetchInstallStatus.mockResolvedValue(status);
    mocks.fetchDomainAccess.mockResolvedValue({ canManage: false, domain: null });

    mount(baseProps({ initialStatus: status }));
    await flush();

    const text = () => container!.textContent ?? '';
    // Deployment details still renders for the step list, but the stack
    // summary is absent: no reference, no stack summary, no routing target,
    // no plan inventory.
    expect(text()).not.toContain('AWS deployment details');
    expect(text()).not.toContain('Application stack name');
    // The ownership note is unconditional at READY, independent of awsSummary.
    expect(text()).toContain(OWNERSHIP_NOTE);
  });

  it('a non-READY stage renders no summary, even when awsSummary is present', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = baseStatus({ awsSummary: summary });
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();

    const text = () => container!.textContent ?? '';
    expect(text()).not.toContain('AWS deployment details');
    expect(text()).not.toContain(summary.applicationStackName);
    expect(text()).not.toContain(OWNERSHIP_NOTE);
  });

  it('at READY, renders no step list, one "Open application" link, and a Deployment details trigger', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = readyStatus({ awsSummary: summary });
    mocks.fetchInstallStatus.mockResolvedValue(status);
    mocks.fetchDomainAccess.mockResolvedValue({ canManage: false, domain: null });

    mount(baseProps({ initialStatus: status }));
    await flush();

    // The redesigned tracker keeps the full stepper at READY (every rung
    // marked complete) so the customer sees the journey, not just the
    // outcome. The "Next:" hint that the legacy StepList emitted is gone —
    // there is no next step.
    expect(container!.querySelector('[data-testid="step-list-next"]')).toBeNull();
    expect(container!.textContent ?? '').toContain('Your application is ready');
    expect(container!.textContent ?? '').toContain('AWS account connected');

    const openApplicationLinks = Array.from(container!.querySelectorAll('a')).filter((anchor) =>
      anchor.textContent?.includes('Open application'),
    );
    expect(openApplicationLinks).toHaveLength(1);

    const deploymentDetailsTriggers = Array.from(
      container!.querySelectorAll('[data-slot="collapsible-trigger"]'),
    ).filter((element) => element.textContent?.includes('Deployment details'));
    expect(deploymentDetailsTriggers.length).toBeGreaterThanOrEqual(1);
  });
});

describe('InstallProgress — resources summary', () => {
  const plan: DeploymentPlan = {
    schemaVersion: 1,
    action: 'INSTALL',
    region: 'us-east-1',
    components: [
      { kind: 'application', name: 'Application', action: 'CREATE', lifecycle: 'delete' },
      { kind: 'database', name: 'Database', action: 'CREATE', lifecycle: 'retain' },
    ],
    awsResources: [
      {
        id: 'ecs_service',
        name: 'ECS Fargate service',
        purpose: 'Runs the application container',
        group: 'compute_networking',
        componentKind: 'application',
        lifecycle: 'delete',
      },
      {
        id: 'database',
        name: 'RDS PostgreSQL database',
        purpose: 'Stores persistent application data',
        group: 'data',
        componentKind: 'database',
        lifecycle: 'retain',
      },
    ],
    requirementDrift: [],
  };

  it('renders one row per required component with its status, drops NOT_REQUIRED, and links the plan inventory', async () => {
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

    mount(baseProps({ initialStatus: status, plan }));
    await flush();

    expect(container!.querySelector('[data-testid="deployment-resources"]')).toBeNull();
    await openDeploymentDetails();

    const text = container!.textContent ?? '';
    expect(text).toContain('Resources');
    expect(text).toContain('Application runtime');
    expect(text).toContain('Ready');
    expect(text).toContain('PostgreSQL database');
    expect(text).toContain('Creating');
    // A component this deployment does not require is never listed.
    expect(text).not.toContain('Redis');
    expect(text).not.toContain('Not required');
    // The plan's inventory stays behind its own closed disclosure inside
    // Deployment details — its raw AWS resource names are never in the open text.
    expect(text).not.toContain('RDS PostgreSQL database');

    await act(async () => {
      click(findTrigger('AWS infrastructure details'));
    });
    expect(container!.textContent ?? '').toContain('RDS PostgreSQL database');
  });

  it('renders no resources section when no component applies and no plan carries an inventory', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = baseStatus({ components: [] });
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();
    await openDeploymentDetails();

    expect(container!.textContent ?? '').not.toContain('Resources');
  });
});

// Phase 3: when the status payload carries the additive `specComponents`
// (a frozen spec exists), the Resources summary reads those entries instead
// of the legacy component list — same visual style, labels + state words +
// optional detail. Without the field, the legacy rows render exactly as
// before (covered by the resources-summary tests above).
describe('InstallProgress — spec-derived components', () => {
  function statusWithSpecComponents(
    specComponents: SpecComponent[],
    overrides: Partial<CustomerDeploymentStatus> = {},
  ): CustomerDeploymentStatus {
    return baseStatus({
      components: [{ key: 'runtime', label: 'Application runtime', status: 'READY' }],
      ...overrides,
      specComponents,
    } as Partial<CustomerDeploymentStatus>);
  }

  it('renders one row per spec component with its state words, and replaces the legacy list', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = statusWithSpecComponents([
      { componentId: 'network', label: 'Private network', state: 'COMPLETE' },
      { componentId: 'database', label: 'MySQL', state: 'IN_PROGRESS' },
      { componentId: 'application', label: 'Web', state: 'FAILED' },
      { componentId: 'other', label: 'Other resources', state: 'PENDING' },
    ]);
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();

    expect(container!.querySelector('[data-testid="deployment-resources"]')).toBeNull();
    await openDeploymentDetails();

    const text = container!.textContent ?? '';
    expect(text).toContain('Resources');
    expect(text).toContain('Private network');
    expect(text).toContain('Complete');
    expect(text).toContain('MySQL');
    expect(text).toContain('In progress');
    expect(text).toContain('Failed');
    // The unknown/other bucket renders exactly like a normal entry: provided
    // label, neutral waiting state — never a raw AWS resource type.
    expect(text).toContain('Other resources');
    expect(text).not.toContain('AWS::');
    expect(text).toContain('Waiting');
    // The legacy component list is replaced, not duplicated.
    expect(text).not.toContain('Application runtime');
    // The redesigned resource table renders one row per component, each with
    // its own testid. The container testid still identifies the Resources
    // section.
    expect(container!.querySelector('[data-testid="deployment-resources"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="resource-row-network"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="resource-row-database"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="resource-row-application"]')).not.toBeNull();
  });

  it('renders every spec component with its provided label even when the componentId is unknown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = statusWithSpecComponents([
      { componentId: 'brand-new-kind', label: 'Brand new kind', state: 'IN_PROGRESS' },
    ]);
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();
    await openDeploymentDetails();

    const text = container!.textContent ?? '';
    expect(text).toContain('Brand new kind');
    expect(text).toContain('In progress');
  });
});
