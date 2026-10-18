// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Application } from '../src/lib/applications';
import type {
  ApplicationArchitecture,
  ApplicationReadiness,
  DetectedApplication,
  DetectedFact,
  FactSource,
  ReadinessFinding,
} from '../src/lib/readiness';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  reanalyse: vi.fn(),
  updateApplication: vi.fn(),
  generateFixInstructions: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/lib/applications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/applications')>();
  return { ...actual, updateApplication: mocks.updateApplication };
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
    database: { required: true, type: 'postgres', confidence: 'confirmed', evidence: [] },
    redis: { required: false, detected: false, supported: true, confidence: 'needs_confirmation', purposes: [], evidence: [] },
    storage: { persistentLocalRequired: false, objectStorageDetected: true, evidence: [] },
    healthCheck: { detected: false, path: null, confidence: 'needs_confirmation', evidence: [] },
    migrations: { detected: false, command: null, tools: [], evidence: [] },
    environmentVariables: [],
  };
}

function architectureFixture(): ApplicationArchitecture {
  return {
    counts: { total: 3, detected: 1, confirmed: 2 },
    groups: [
      { group: 'application', nodes: [{ label: 'Web service', state: 'confirmed' }] },
      { group: 'data', nodes: [{ label: 'PostgreSQL', state: 'confirmed' }] },
      { group: 'cache', nodes: [{ label: 'Redis', state: 'detected' }] },
    ],
    unresolved: [
      { kind: 'queue', question: 'Do you need a background queue?', blocking: false },
      { kind: 'port', question: 'Which port does your app listen on?', blocking: true },
    ],
    externalServices: ['stripe', 'openai'],
  };
}

function readinessFixture(overrides: Partial<ApplicationReadiness> = {}): ApplicationReadiness {
  return {
    analysisStatus: 'COMPLETE',
    state: 'NEEDS_CHANGES',
    requiredCount: 0,
    recommendedCount: 0,
    summary: null,
    failureReason: null,
    findings: [],
    passed: [],
    analyzedCommitSha: 'abc1234',
    detected: fullyDetected(),
    requirements: {
      schemaVersion: 1,
      database: { detected: true, effective: true, overridden: false },
      redis: { detected: false, effective: false, overridden: false },
      storage: { detected: true, effective: true, overridden: false },
    },
    deploymentRequirementDrift: [],
    architecture: architectureFixture(),
    ...overrides,
  };
}

let currentApplication = applicationFixture();
let currentReadiness = readinessFixture();

vi.mock('../src/app/dashboard/applications/[id]/application-page-context', () => ({
  useApplicationPage: () => ({
    id: currentApplication.id,
    data: {
      application: currentApplication,
      readiness: currentReadiness,
      deployments: [],
      plan: null,
      installLinks: [],
    },
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
  mocks.generateFixInstructions.mockReturnValue(new Promise(() => undefined));
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

describe('Services & resources table', () => {
  it('shows the infrastructure and build/runtime rows in one table, and the detection state under Technical details', async () => {
    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    const table = byTestId('services-table');
    expect(table).not.toBeNull();
    for (const id of ['runtime', 'port', 'database', 'storage']) {
      expect(table?.querySelector(`[data-testid="readiness-setting-${id}"]`)).not.toBeNull();
    }
    expect(byTestId('readiness-table')).toBeNull();
    expect(byTestId('readiness-infrastructure-table')).toBeNull();

    await click(byTestId('technical-details')?.querySelector('[data-slot="collapsible-trigger"]') ?? null);
    const detectedComponents = byTestId('detected-components')?.textContent ?? '';
    expect(detectedComponents).toContain('Web service · Confirmed');
    expect(detectedComponents).toContain('Redis · Detected automatically');
  });

  it('shows an unresolved question as a Needs input row with its action', async () => {
    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    const questionRow = byTestId('inventory-row-question-0');
    expect(questionRow?.textContent).toContain('Do you need a background queue?');
    expect(questionRow?.textContent).toContain('Needs input');
    expect(questionRow?.querySelector('[data-testid="architecture-unresolved-fix-queue-0"]')).not.toBeNull();
  });

  it('puts the port question on the port row, whose edit action opens the port editor', async () => {
    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    const portRow = byTestId('readiness-setting-port');
    expect(portRow?.textContent).toContain('Which port does your app listen on?');
    expect(portRow?.textContent).toContain('Blocking');
    await click(byTestId('readiness-setting-edit-port'));

    expect(byTestId('edit-dialog-containerPort')).not.toBeNull();
    expect(byTestId('fix-instructions-dialog')).toBeNull();
    expect(mocks.generateFixInstructions).not.toHaveBeenCalled();
  });

  it('lists external services as information, never as a Needs input question', async () => {
    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    expect(byTestId('services-group-integrations')?.textContent).toContain('External integrations');
    expect(byTestId('inventory-row-integration-0')?.textContent).toContain('Stripe');
    expect(byTestId('inventory-row-integration-1')?.textContent).toContain('OpenAI');
    expect(byTestId('inventory-row-integration-0')?.textContent).not.toContain('Needs input');
    expect(byTestId('attention-summary')?.textContent).not.toContain('Stripe');
  });

  it('opens the fix-instructions dialog from an unresolved fix action', async () => {
    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    await click(byTestId('architecture-unresolved-fix-queue-0'));

    expect(byTestId('fix-instructions-dialog')).not.toBeNull();
    expect(mocks.generateFixInstructions).toHaveBeenCalled();
  });

  it('counts each question once in the attention line and shows it on its row', async () => {
    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    expect(byTestId('attention-summary-resources')?.textContent).toContain('2 items need attention');
    expect(document.getElementById('config-row-question-0')?.textContent).toContain('Needs input');
    expect(document.getElementById('config-row-port')?.textContent).toContain('Blocking');
  });

  it('shows no detected components when no architecture data exists', async () => {
    currentReadiness = readinessFixture({ architecture: null });

    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    expect(byTestId('detected-components')).toBeNull();
    expect(byTestId('inventory-row-question-0')).toBeNull();
  });

  it('shows the empty table and no size presets when analysis is incomplete and there is no plan', async () => {
    currentApplication = applicationFixture({ analysisStatus: 'PENDING' });
    currentReadiness = readinessFixture({
      analysisStatus: 'PENDING',
      state: 'ANALYSIS_INCOMPLETE',
      detected: null,
      requirements: null,
      architecture: null,
    });

    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    expect(byTestId('readiness-empty')?.textContent).toContain('Analyse the application');
    expect(byTestId('deployment-size')).toBeNull();
    expect(byTestId('deployment-size-empty')?.textContent).toBe('Size presets show after a successful analysis.');
  });
});
