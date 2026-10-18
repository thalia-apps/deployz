// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildInstallPlan, type DeploymentPlan } from '@deployz/contracts';

import type { Application } from '../src/lib/applications';
import type {
  ApplicationReadiness,
  DetectedApplication,
  DetectedFact,
  FactSource,
  ReadinessFinding,
} from '../src/lib/readiness';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom implements neither pointer capture nor scrollIntoView; Radix Select
// calls them while handling pointer events.
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false as never;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

// The Configuration tab's Resources and Size presets panels. A required
// finding shows on its row, whose action either opens the matching setting's
// edit dialog (port-unresolved only, today) or the fix-instructions dialog
// (everything else); the attention line is reachable via `#required-changes`.

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  reanalyse: vi.fn(),
  updateApplication: vi.fn(),
  updateApplicationSizes: vi.fn(),
  fetchApplicationPlan: vi.fn(),
  generateFixInstructions: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/lib/applications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/applications')>();
  return {
    ...actual,
    updateApplication: mocks.updateApplication,
    updateApplicationSizes: mocks.updateApplicationSizes,
    fetchApplicationPlan: mocks.fetchApplicationPlan,
  };
});

vi.mock('@/lib/readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/readiness')>();
  return { ...actual, generateFixInstructions: mocks.generateFixInstructions };
});

function applicationFixture(overrides: Partial<Application> = {}): Application {
  return {
    id: 'app-1',
    organizationId: 'org-1',
    name: 'Demo App',
    githubInstallationId: null,
    repoFullName: 'acme/demo',
    repoUrl: 'https://github.com/acme/demo',
    defaultBranch: 'main',
    containerPort: null,
    healthPath: null,
    migrationCommand: null,
    workerCommand: null,
    databaseRequired: false,
    storageRequired: false,
    redisRequired: false,
    defaultSizeProfile: 'small',
    minimumSizeProfile: 'small',
    analysisStatus: 'COMPLETE',
    compatibilityStatus: 'READY',
    compatibilityReason: null,
    detectedMetadata: null,
    createdAt: '2026-09-01T10:00:00Z',
    updatedAt: '2026-09-01T10:00:00Z',
    ...overrides,
  };
}

const fact = <T,>(value: T, source: FactSource = 'dockerfile'): DetectedFact<T> => ({
  value,
  source,
  confidence: source === 'source' || source === 'ai' ? 'likely' : 'confirmed',
  evidence: source === 'none' ? [] : [{ file: 'Dockerfile', reason: `Found in ${source}` }],
});

function fullyDetected(): DetectedApplication {
  return {
    analysisVersion: 13,
    runtime: fact('node'),
    framework: fact('express', 'package-manifest'),
    build: fact('npm run build', 'package-manifest'),
    start: fact('node dist/index.js'),
    network: { port: fact(3000), bindAddress: fact(null, 'none') },
    database: { required: false, type: 'none', confidence: 'needs_confirmation', evidence: [] },
    redis: { required: false, detected: false, supported: true, confidence: 'needs_confirmation', purposes: [], evidence: [] },
    storage: { persistentLocalRequired: false, objectStorageDetected: false, evidence: [] },
    healthCheck: { detected: false, path: null, confidence: 'needs_confirmation', evidence: [] },
    migrations: { detected: false, command: null, tools: [], evidence: [] },
    environmentVariables: [],
  };
}

function finding(overrides: Partial<ReadinessFinding> = {}): ReadinessFinding {
  return {
    id: 'health-check',
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

function readinessFixture(overrides: Partial<ApplicationReadiness> = {}): ApplicationReadiness {
  return {
    analysisStatus: 'COMPLETE',
    state: 'NEEDS_CHANGES',
    requiredCount: 1,
    recommendedCount: 0,
    summary: null,
    failureReason: null,
    findings: [],
    passed: [],
    analyzedCommitSha: 'abc1234',
    detected: fullyDetected(),
    requirements: { schemaVersion: 1, database: { detected: false, effective: false, overridden: false }, redis: { detected: false, effective: false, overridden: false }, storage: { detected: false, effective: false, overridden: false } },
    deploymentRequirementDrift: [],
    ...overrides,
  };
}

let currentApplication = applicationFixture();
let currentReadiness = readinessFixture();
let currentPlan: DeploymentPlan | null = null;

vi.mock('../src/app/dashboard/applications/[id]/application-page-context', () => ({
  useApplicationPage: () => ({
    id: currentApplication.id,
    data: { application: currentApplication, readiness: currentReadiness, deployments: [], plan: currentPlan, installLinks: [] },
    loading: false,
    presentation: { readinessSummary: null, state: 'idle' },
    refresh: mocks.refresh,
    reanalyse: mocks.reanalyse,
    reanalysing: false,
  }),
}));

const { ResourcesPanel, SizePresetsPanel } = await import(
  '../src/app/dashboard/applications/[id]/config/deployment-configuration'
);

/** Both analysis-driven panels, as the Configuration tab mounts them. */
function DeploymentConfiguration() {
  return (
    <>
      <ResourcesPanel />
      <SizePresetsPanel />
    </>
  );
}

async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  });
}

function byTestId(id: string): Element | null {
  return document.body.querySelector(`[data-testid="${id}"]`);
}

async function click(element: Element | null): Promise<void> {
  await act(async () => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  currentApplication = applicationFixture();
  currentReadiness = readinessFixture();
  currentPlan = null;
  mocks.fetchApplicationPlan.mockResolvedValue(null);
  mocks.generateFixInstructions.mockReturnValue(new Promise(() => undefined)); // left pending by default
  window.location.hash = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  window.location.hash = '';
});

describe('Required changes on their rows', () => {
  it('counts the required findings once and marks each affected row', async () => {
    currentReadiness = readinessFixture({
      findings: [
        finding({ id: 'health-check', category: 'health', severity: 'required' }),
        finding({
          id: 'port-unresolved',
          category: 'network',
          severity: 'required',
          title: 'Port not detected',
          plainEnglishExplanation: 'Deployz could not detect the port your app listens on.',
        }),
      ],
    });

    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    expect(byTestId('attention-summary')?.id).toBe('required-changes');
    expect(byTestId('attention-summary-resources')?.textContent).toContain('2 items need attention');
    expect(byTestId('readiness-setting-health')?.querySelector('[data-slot="badge"]')?.textContent).toBe('Change required');
    expect(byTestId('readiness-setting-port')?.querySelector('[data-slot="badge"]')).not.toBeNull();
  });

  it('does not render the attention line when nothing needs the vendor', async () => {
    currentReadiness = readinessFixture({ findings: [] });

    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    expect(document.getElementById('required-changes')).toBeNull();
  });

  it('an instructions-type finding opens the fix-instructions dialog from its row', async () => {
    currentReadiness = readinessFixture({
      findings: [finding({ id: 'container-setup', category: 'container', severity: 'required', title: 'No Dockerfile found' })],
    });

    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    await click(byTestId('readiness-finding-fix-container-setup'));

    expect(byTestId('fix-instructions-dialog')).not.toBeNull();
    expect(mocks.generateFixInstructions).toHaveBeenCalled();
  });
});

describe('Table row Fix routing', () => {
  it("the health row's Fix opens fix instructions, never the health path editor", async () => {
    currentReadiness = readinessFixture({
      findings: [finding({ id: 'health-check', category: 'health', severity: 'required' })],
    });

    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    await click(byTestId('readiness-finding-fix-health-check'));

    expect(byTestId('fix-instructions-dialog')).not.toBeNull();
    expect(byTestId('edit-dialog-healthPath')).toBeNull();
  });

  it("the port row's Fix routes through the setting's own edit action (kind 'edit'), and opens the port editor", async () => {
    currentReadiness = readinessFixture({
      findings: [finding({ id: 'port-unresolved', category: 'network', severity: 'required', title: 'Port not detected' })],
    });

    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    // A required finding on the port row routes to kind 'edit' (never kind
    // 'fix'), so the button carries the setting-edit test id, not a
    // finding-fix one.
    expect(byTestId('readiness-finding-fix-port-unresolved')).toBeNull();
    await click(byTestId('readiness-setting-edit-port'));

    expect(byTestId('edit-dialog-containerPort')).not.toBeNull();
  });

  it('shows no Ready or Not used badge in the result column', async () => {
    currentReadiness = readinessFixture({ findings: [] });

    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    const runtimeRow = byTestId('readiness-setting-runtime');
    expect(runtimeRow?.querySelector('[data-slot="badge"]')).toBeNull();

    const redisRow = byTestId('readiness-setting-redis');
    expect(redisRow?.querySelector('[data-slot="badge"]')).toBeNull();
    expect(redisRow?.textContent).toContain('Not used');
  });

  it('still shows a badge for Change required / Recommended / Needs review', async () => {
    currentReadiness = readinessFixture({
      findings: [finding({ id: 'health-check', category: 'health', severity: 'required' })],
    });

    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    const healthRow = byTestId('readiness-setting-health');
    expect(healthRow?.querySelector('[data-slot="badge"]')?.textContent).toBe('Change required');
  });
});

describe('#required-changes hash focus', () => {
  it('scrolls to and focuses the panel when the hash matches on load', async () => {
    currentReadiness = readinessFixture({
      findings: [finding({ id: 'health-check', category: 'health', severity: 'required' })],
    });
    window.location.hash = '#required-changes';

    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });
    await nextFrame();

    expect(document.activeElement?.id).toBe('required-changes');
  });

  it('focuses the section heading when the hash matches but nothing is required', async () => {
    currentReadiness = readinessFixture({ findings: [] });
    window.location.hash = '#required-changes';

    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });
    await nextFrame();

    expect(document.activeElement?.id).toBe('services-heading');
  });
});

function standardPlan(): DeploymentPlan {
  return buildInstallPlan({
    manifest: {
      schemaVersion: 1,
      application: { root: '.', runtime: 'node', framework: null, dockerfilePath: 'Dockerfile' },
      build: { command: 'npm run build', context: '.' },
      web: { command: 'npm start', port: 3000 },
      health: { path: '/health' },
      database: { postgres: true },
      redis: { required: false, envBindings: [] },
      storage: { required: false, envBindings: [] },
      migration: { command: null },
      worker: { command: null },
      environment: { variables: [] },
      externalServices: [],
      unsupported: [],
    },
    region: 'eu-west-1',
  });
}

describe('Deployment size and estimate', () => {
  async function press(element: Element | null): Promise<void> {
    await act(async () => {
      for (const type of ['pointerdown', 'mousedown', 'click', 'pointerup']) {
        element?.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
      }
    });
  }

  function selectTrigger(label: string): HTMLElement {
    return document.getElementById(
      Array.from(document.querySelectorAll('label')).find((item) => item.textContent === label)?.htmlFor ?? '',
    ) as HTMLElement;
  }

  async function choose(label: string, option: string): Promise<void> {
    await press(selectTrigger(label));
    await press(Array.from(document.querySelectorAll('[role="option"]')).find((item) => item.textContent?.startsWith(option)) ?? null);
  }

  it('shows the presets read-only, apart from the default and minimum controls', async () => {
    currentPlan = standardPlan();

    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    expect(byTestId('deployment-size-presets')).not.toBeNull();
    expect(byTestId('deployment-size-small')?.textContent).toBe('SmallDefault');
    expect(byTestId('deployment-size-medium')?.textContent).toBe('Medium');
    // The presets have no inputs: the only controls are the two size selects.
    expect(document.querySelectorAll('[data-testid="deployment-size-presets"] button, [data-testid="deployment-size-presets"] input')).toHaveLength(0);
    expect(Array.from(document.querySelectorAll('[data-testid="deployment-size"] label')).map((label) => label.textContent)).toEqual([
      'Default size',
      'Minimum allowed size',
    ]);
    expect(document.body.textContent).toContain('Smallest size customers can select.');
    expect(selectTrigger('Default size').getAttribute('aria-describedby')).toBeTruthy();
    expect(selectTrigger('Minimum allowed size').getAttribute('aria-describedby')).toBeTruthy();
    expect(byTestId('deployment-cost')?.textContent).toContain('Estimates only.');
    expect(byTestId('deployment-cost-details')).toBeNull();
  });

  it('shows each size’s resources and estimate from that size’s plan', async () => {
    currentApplication = applicationFixture({ databaseRequired: true, redisRequired: true });
    currentPlan = standardPlan();
    mocks.fetchApplicationPlan.mockResolvedValue(standardPlan());

    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    expect(mocks.fetchApplicationPlan).toHaveBeenCalledWith('app-1', 'small');
    expect(mocks.fetchApplicationPlan).toHaveBeenCalledWith('app-1', 'medium');
    expect(mocks.fetchApplicationPlan).toHaveBeenCalledWith('app-1', 'large');
    // The mocked plan is the Small footprint for every size: the presets show the plan's resources.
    expect(byTestId('deployment-size-small-compute')?.textContent).toBe('0.25 vCPU · 512 MiB per service');
    expect(byTestId('deployment-size-small-database')?.textContent).toBe('db.t3.micro');
    expect(byTestId('deployment-size-small-storage')?.textContent).toBe('20 GB database storage');
    // The plan has a database and no cache.
    expect(byTestId('deployment-size-small-cache')).toBeNull();
    expect(byTestId('deployment-size-small-workers')).toBeNull();
    for (const tier of ['small', 'medium', 'large']) {
      expect(byTestId(`deployment-size-${tier}-cost`)?.textContent).toMatch(/^~\$\d+–\d+\/month \+ usage$/);
    }
  });

  it('leaves out the database and cache rows when the application has neither', async () => {
    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    expect(byTestId('deployment-size-medium-compute')?.textContent).toBe('1 vCPU · 2 GiB per service');
    expect(byTestId('deployment-size-medium-database')).toBeNull();
    expect(byTestId('deployment-size-medium-cache')).toBeNull();
    expect(byTestId('deployment-size-medium-cost')?.textContent).toBe('Estimate unavailable');
  });

  it('raises the default size to the minimum and offers no size below it', async () => {
    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });
    expect(byTestId('deployment-size-save')?.hasAttribute('disabled')).toBe(true);

    await choose('Minimum allowed size', 'Medium');

    expect(selectTrigger('Default size').textContent).toContain('Medium');
    await press(selectTrigger('Default size'));
    expect(Array.from(document.querySelectorAll('[role="option"]')).map((item) => item.textContent?.split(' ')[0])).toEqual([
      'Medium',
      'Large',
    ]);
    // The saved default stays marked until Save.
    expect(byTestId('deployment-size-small')?.textContent).toBe('SmallDefault');
  });

  it('saves the default and minimum sizes with one PATCH body and refreshes the page', async () => {
    mocks.updateApplicationSizes.mockResolvedValue(applicationFixture());
    mocks.refresh.mockResolvedValue(undefined);

    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });
    await choose('Default size', 'Large');
    expect(byTestId('deployment-size-save')?.hasAttribute('disabled')).toBe(false);

    await click(byTestId('deployment-size-save'));

    expect(mocks.updateApplicationSizes).toHaveBeenCalledWith('app-1', {
      defaultSizeProfile: 'large',
      minimumSizeProfile: 'small',
    });
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it('shows the server message when it refuses the sizes', async () => {
    const { ApiRequestError } = await import('../src/lib/api-client');
    mocks.updateApplicationSizes.mockRejectedValue(
      new ApiRequestError('SIZE_DEFAULT_BELOW_MINIMUM', 'The recommended size cannot be smaller than the minimum size.'),
    );

    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });
    await choose('Default size', 'Medium');
    await click(byTestId('deployment-size-save'));

    expect(byTestId('deployment-size-error')?.textContent).toBe(
      'The recommended size cannot be smaller than the minimum size.',
    );
  });

  it('keeps the assumptions and exclusions behind the estimate details disclosure', async () => {
    currentPlan = standardPlan();
    mocks.fetchApplicationPlan.mockResolvedValue(standardPlan());

    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });
    const trigger = Array.from(document.querySelectorAll('[data-testid="deployment-cost"] button')).find(
      (button) => button.textContent === 'Estimate details',
    );
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    await click(trigger ?? null);

    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(byTestId('deployment-cost-assumptions')?.textContent).toContain('Ireland (eu-west-1)');
    expect(byTestId('deployment-cost-assumptions')?.textContent).toContain('730 hours a month');
    expect(byTestId('deployment-cost-details')?.textContent).toContain('Deployz fees are not included.');
  });

  it('says the estimate is unavailable when the plan could not be loaded — never $0', async () => {
    currentPlan = null;

    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    expect(byTestId('deployment-size-small-cost')?.textContent).toBe('Estimate unavailable');
    expect(byTestId('inventory-row-web-meta')?.textContent).toBe('Est. AWS/month: Price unavailable');
    expect(document.body.textContent).not.toContain('$0');
  });
});

describe('Attention summary', () => {
  it('links the variables that need input to the Variables tab and leaves external services out', async () => {
    currentReadiness = readinessFixture({
      environmentSetup: { needsDecision: 2, missingValue: 1, missingBuildValue: 0, customer: 0, total: 5 },
      architecture: { groups: [], unresolved: [], externalServices: ['stripe', 'resend'] },
    });

    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    expect(byTestId('attention-summary-resources')).toBeNull();
    expect(byTestId('attention-summary-variables')?.getAttribute('href')).toBe('#environment-variables');
    expect(byTestId('attention-summary-variables')?.textContent).toBe('3 variables need input');
    // External services are information on their own rows, never an issue.
    expect(byTestId('inventory-row-integration-0')?.textContent).not.toContain('Needs');
    expect(byTestId('inventory-row-integration-0')?.textContent).toContain('Billed separately');
    expect(byTestId('integration-variables-1')?.getAttribute('href')).toBe('#environment-variables');
  });
});
