// @vitest-environment jsdom
import { act } from 'react';
import { JSDOM } from 'jsdom';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deploymentPlanComponentSchema,
  deploymentPlanSchema,
  planComponentKindSchema,
  type CustomerDeploymentStatus,
  type DeploymentPlan,
  type DeploymentStep,
  type PlanComponentGroup,
} from '@deployz/contracts';

import {
  futureCapabilitySpecComponent,
  webWorkerQueueSchedulePlan,
  webWorkerQueueScheduleSpecComponents,
  webWorkersMysqlRedisPlan,
  webWorkersMysqlRedisSpecComponents,
} from './fixtures/phase4-presentations';
import { specComponentPresentation, type SpecComponentState } from '../src/lib/deployment-progress';
import { installPlanRows } from '../src/lib/install-plan';

// The Phase 3 gate: every Phase 4 composition renders through the generic
// presentation model with NO new display code — grouped plan table, spec
// component progress, and the truthful
// degradation fallbacks.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  fetchInstallStatus: vi.fn(),
  fetchInstallStatusServer: vi.fn(),
  fetchInstallData: vi.fn(),
  fetchPublicInstallData: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({}),
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, toString: () => '' }),
}));

vi.mock('../src/lib/install-status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/install-status')>();
  return {
    ...actual,
    fetchInstallStatus: mocks.fetchInstallStatus,
    fetchInstallStatusServer: mocks.fetchInstallStatusServer,
  };
});

vi.mock('../src/lib/install-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/install-data')>();
  return { ...actual, fetchInstallData: mocks.fetchInstallData };
});

vi.mock('../src/lib/public-install-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/public-install-data')>();
  return { ...actual, fetchPublicInstallData: mocks.fetchPublicInstallData };
});

const { InstallPlanComponentTable } = await import('../src/components/install-plan-component-table');
const { InstallProgress } = await import('../src/components/install-progress');
const InstallPage = (await import('../src/app/install/[installLinkId]/page')).default;

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
  vi.useRealTimers();
});

function render(element: React.ReactElement): void {
  act(() => {
    root.render(element);
  });
}

function byTestId(id: string): Element | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

function groupHeadings(): string[] {
  return Array.from(container.querySelectorAll('tbody td[colspan="3"]')).map((cell) => cell.textContent ?? '');
}

function rowTexts(): string[] {
  return Array.from(container.querySelectorAll('tbody tr')).map((row) => row.textContent ?? '');
}

// ── Schema validation: the fixtures are real wire objects ───────────────────

describe('phase 4 fixtures pass the real zod schemas', () => {
  it('both compositions parse as DeploymentPlan', () => {
    expect(deploymentPlanSchema.parse(webWorkersMysqlRedisPlan)).toBeTruthy();
    expect(deploymentPlanSchema.parse(webWorkerQueueSchedulePlan)).toBeTruthy();
  });

  it('the widened kinds worker/queue/schedule are valid plan component kinds', () => {
    expect(planComponentKindSchema.options).toContain('worker');
    expect(planComponentKindSchema.options).toContain('queue');
    expect(planComponentKindSchema.options).toContain('schedule');
  });

  it('an unrecognized kind string is rejected at the schema boundary', () => {
    expect(
      deploymentPlanComponentSchema.safeParse({
        kind: 'quantum',
        name: 'Future capability',
        action: 'CREATE',
        lifecycle: 'delete',
      }).success,
    ).toBe(false);
  });

  it('an unrecognized group value is rejected at the schema boundary', () => {
    expect(
      deploymentPlanComponentSchema.safeParse({
        kind: 'application',
        name: 'Future capability',
        action: 'CREATE',
        lifecycle: 'delete',
        group: 'quantum',
      }).success,
    ).toBe(false);
  });
});

// ── Gate 1: the customer grouped plan table renders both compositions ───────

describe('customer grouped plan table — composition A (web + workers + MySQL + Redis + storage)', () => {
  it('renders the groups in canonical order with both worker rows distinct', () => {
    render(<InstallPlanComponentTable plan={webWorkersMysqlRedisPlan} />);

    expect(groupHeadings()).toEqual(['Application', 'Data', 'Cache', 'Storage']);
    const rows = rowTexts();
    expect(rows).toHaveLength(10);
    expect(rows[0]).toContain('Application');
    expect(rows[1]).toContain('Web application');
    expect(rows[2]).toContain('Email worker');
    expect(rows[3]).toContain('Jobs worker');
    expect(rows[4]).toContain('Data');
    expect(rows[5]).toContain('MySQL database');
    expect(rows[6]).toContain('Cache');
    expect(rows[7]).toContain('Redis cache');
    expect(rows[8]).toContain('Storage');
    expect(rows[9]).toContain('File storage');
    // The two workers are separate rows, each exactly once.
    expect(rows.filter((row) => row.includes('Email worker'))).toHaveLength(1);
    expect(rows.filter((row) => row.includes('Jobs worker'))).toHaveLength(1);
  });
});

describe('InstallPlanComponentTable — After removal column', () => {
  it('renders Kept for a retain-lifecycle component and Removed for a delete-lifecycle component', () => {
    render(<InstallPlanComponentTable plan={webWorkersMysqlRedisPlan} />);

    const rows = rowTexts();
    const webRow = rows.find((row) => row.includes('Web application'))!;
    const mysqlRow = rows.find((row) => row.includes('MySQL database'))!;
    const storageRow = rows.find((row) => row.includes('File storage'))!;
    const redisRow = rows.find((row) => row.includes('Redis cache'))!;

    // MySQL and File storage are lifecycle: 'retain' — Kept.
    expect(mysqlRow).toContain('Kept');
    expect(mysqlRow).not.toContain('Removed');
    expect(storageRow).toContain('Kept');
    // Web application and Redis are lifecycle: 'delete' — Removed.
    expect(webRow).toContain('Removed');
    expect(webRow).not.toContain('Kept');
    expect(redisRow).toContain('Removed');
  });
});

describe('customer grouped plan table — composition B (web + worker + queue + schedule)', () => {
  it('groups the queue and the schedule under Messaging and never shows AWS jargon', () => {
    render(<InstallPlanComponentTable plan={webWorkerQueueSchedulePlan} />);

    expect(groupHeadings()).toEqual(['Application', 'Messaging']);
    const rows = rowTexts();
    expect(rows).toHaveLength(6);
    expect(rows[2]).toContain('Background worker');
    expect(rows[4]).toContain('Message queue');
    expect(rows[5]).toContain('Scheduled job');
    expect(container.textContent).not.toContain('SQS');
  });
});

// ── Gate 1b: the unknown-group fallback lives in the UI row builder ─────────

describe('unknown component genericity — fallback chain in the row builder', () => {
  const futureComponent = {
    kind: 'application',
    name: 'Future capability',
    action: 'CREATE' as const,
    lifecycle: 'delete' as const,
    // A future server adds a group value this client does not know.
    group: 'quantum' as unknown as PlanComponentGroup,
  };
  const planWithUnknownGroup = {
    ...webWorkersMysqlRedisPlan,
    components: [futureComponent],
  } as unknown as DeploymentPlan;

  it('the row builder keeps the row and falls back through kind to Application', () => {
    const rows = installPlanRows(planWithUnknownGroup);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.group).toBe('application');
    expect(rows[0]!.name).toBe('Future capability');
  });

  it('the rendered table shows the row instead of crashing or hiding it', () => {
    render(<InstallPlanComponentTable plan={planWithUnknownGroup} />);

    expect(groupHeadings()).toEqual(['Application']);
    const rows = rowTexts();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('Future capability');
  });

  it('a missing group behaves the same: visible under the kind fallback', () => {
    const rows = installPlanRows({
      ...webWorkersMysqlRedisPlan,
      components: [{ kind: 'application', name: 'Unlabeled component', action: 'CREATE', lifecycle: 'delete' }],
    });
    expect(rows[0]!.group).toBe('application');
    expect(rows[0]!.name).toBe('Unlabeled component');
  });
});

// ── Gate 2: customer progress renders specComponents verbatim ───────────────

const STEPS: DeploymentStep[] = [
  'AWS_SETUP',
  'RELAY_CONNECT',
  'PREPARING',
  'NETWORK',
  'DATABASE_STORAGE',
  'APPLICATION',
  'HEALTH_CHECK',
  'TLS',
  'READY',
];

function baseStatus(overrides: Partial<CustomerDeploymentStatus> = {}): CustomerDeploymentStatus {
  return {
    stage: 'PROVISIONING',
    updatedAt: '2026-09-18T00:00:00.000Z',
    currentActivity: 'Creating the infrastructure.',
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

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe('customer progress renders specComponents (composition A + future capability)', () => {
  it('renders every spec component with its label, state words, and detail', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = baseStatus({
      specComponents: [...webWorkersMysqlRedisSpecComponents, futureCapabilitySpecComponent],
    } as Partial<CustomerDeploymentStatus>);
    mocks.fetchInstallStatus.mockResolvedValue(status);

    render(
      <InstallProgress
        installLinkId="link-1"
        deploymentId="dep-1"
        initialStatus={status}
        quickCreateUrl={null}
        initialDomain={null}
        routingTarget={null}
        plan={webWorkersMysqlRedisPlan}
      />,
    );
    await flush();

    expect(byTestId('deployment-resources')).toBeNull();
    const trigger = Array.from(container.querySelectorAll('[data-slot="collapsible-trigger"]')).find((element) =>
      element.textContent?.includes('Deployment details'),
    ) as HTMLElement;
    expect(trigger).toBeDefined();
    await act(async () => {
      trigger.click();
    });

    expect(byTestId('deployment-resources')).not.toBeNull();
    // The redesigned resource table renders one row per spec component,
    // each with its own testid. The test below asserts the Resources
    // section header is present; row-level testids are covered in
    // deployment-tracker.test.tsx.
    expect(byTestId('resource-row-web')).not.toBeNull();
    const text = container.textContent ?? '';
    // Every component is present, none hidden — including the future one.
    expect(text).toContain('Web application');
    expect(text).toContain('Email worker');
    expect(text).toContain('Jobs worker');
    expect(text).toContain('MySQL database');
    expect(text).toContain('Redis cache');
    expect(text).toContain('File storage');
    expect(text).toContain('Future capability');
    // Mixed states render as words.
    expect(text).toContain('In progress');
    expect(text).toContain('Complete');
    expect(text).toContain('Waiting');
    // Detail strings pass through verbatim.
    expect(text).toContain('Task definition registered');
    expect(text).toContain('Waiting for the database engine');
  });

  it('an unrecognized state presents neutral rather than crashing', () => {
    const view = specComponentPresentation({
      componentId: 'future-capability-x',
      label: 'Future capability',
      state: 'QUANTUM' as SpecComponentState,
    });
    expect(view.label).toBe('Future capability');
    expect(view.stateLabel).toBe('Waiting');
    expect(view.tone).toBe('neutral');
  });
});

// ── Gate 6: degradation — missing costEstimate, null region ─────────────────

describe('truthful degradation on the customer install page', () => {
  function resolvedData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      applicationName: 'Acme App',
      publisherName: 'Acme Inc',
      customerName: 'Customer One',
      region: 'us-east-2',
      plan: webWorkersMysqlRedisPlan,
      quickCreateUrl: 'https://console.aws.amazon.com/cloudformation/quickcreate',
      alreadyInstalled: false,
      viewer: { kind: 'customer', email: 'owner@example.com' },
      deploymentId: 'dep-1',
      deploymentState: 'NOT_INSTALLED',
      domain: null,
      routingTarget: null,
      bootstrapStackName: 'deployz-bootstrap-acme-app-dep-1',
      waitingForRelay: false,
      relayStuck: false,
      components: null,
      releaseVersion: '1.2.0',
      ...overrides,
    };
  }

  async function renderInstallPage(): Promise<Document> {
    const element = await InstallPage({
      params: Promise.resolve({ installLinkId: '11111111-1111-1111-1111-111111111111' }),
    });
    const { window } = new JSDOM(renderToString(element));
    return window.document;
  }

  it('renders "Estimate unavailable" without a costEstimate and survives a null region', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallStatusServer.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({
      status: 'ok',
      data: resolvedData({
        region: null,
        plan: { ...webWorkersMysqlRedisPlan, region: null, costEstimate: undefined },
      }),
    });

    const doc = await renderInstallPage();

    const text = doc.body.textContent ?? '';
    expect(text).toContain('AWS cost estimate unavailable.');
    // No region line renders for an unknown region — never a raw code.
    expect(text).not.toContain('US East');
    // The page itself still renders the full composition.
    expect(text).toContain('RDS MySQL database');
  });
});
