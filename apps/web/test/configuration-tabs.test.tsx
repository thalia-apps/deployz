// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The Configuration tab's four secondary tabs: Resources by default, the last
// tab per application, section anchors that pick their tab, attention counts
// from the existing readiness counts, and panels that stay mounted so unsaved
// edits survive a switch and a switch loads nothing.

const mocks = vi.hoisted(() => ({
  fetchConfig: vi.fn(),
  readiness: {} as Record<string, unknown>,
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'app-1' }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/config')>();
  return { ...actual, fetchConfig: mocks.fetchConfig };
});

vi.mock('../src/app/dashboard/applications/[id]/application-page-context', () => ({
  useApplicationPage: () => ({
    id: 'app-1',
    data: { readiness: mocks.readiness },
    loading: false,
    refresh: vi.fn(),
  }),
}));

// The panels have their own tests; here each is a stand-in that holds an
// unsaved draft, so a lost mount would show as a lost draft.
function Draft({ name }: { name: string }) {
  const [value, setValue] = useState('');
  return <input aria-label={`${name} draft`} value={value} onChange={(event) => setValue(event.target.value)} />;
}

vi.mock('../src/app/dashboard/applications/[id]/config/deployment-configuration', () => ({
  ResourcesPanel: () => <Draft name="Resources" />,
  SizePresetsPanel: () => <Draft name="Sizes" />,
  resourceAttentionCount: (readiness: { requiredCount?: number }) => readiness.requiredCount ?? 0,
}));
vi.mock('../src/app/dashboard/applications/[id]/config/environment-variables-section', () => ({
  EnvironmentVariablesSection: () => <Draft name="Variables" />,
}));
vi.mock('../src/app/dashboard/applications/[id]/config/general-settings', () => ({
  GeneralSettings: () => <Draft name="Settings" />,
}));

const { default: ApplicationConfigPage } = await import('../src/app/dashboard/applications/[id]/config/page');

let container: HTMLElement;
let root: Root;

function tab(name: string): HTMLElement {
  return document.querySelector(`[data-testid="config-tab-${name}"]`) as HTMLElement;
}
function panel(name: string): HTMLElement {
  return document.querySelector(`[data-testid="config-panel-${name}"]`) as HTMLElement;
}

async function select(name: string): Promise<void> {
  // Radix Tabs activates on mousedown.
  await act(async () => {
    tab(name).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  });
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(<ApplicationConfigPage />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readiness = { requiredCount: 2, environmentSetup: { needsDecision: 1, missingValue: 2, missingBuildValue: 0, customer: 0, total: 6 } };
  mocks.fetchConfig.mockResolvedValue({
    applicationId: 'app-1',
    customerId: null,
    customerName: null,
    vendorDefaults: [],
    customerOverrides: [],
    effective: [],
  });
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/dashboard/applications/app-1/config');
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

describe('Configuration tabs', () => {
  it('opens on Resources with four labelled tabs', async () => {
    await render();

    const tabs = Array.from(document.querySelectorAll('[role="tab"]')).map((element) => element.getAttribute('data-testid'));
    expect(tabs).toEqual(['config-tab-resources', 'config-tab-sizes', 'config-tab-variables', 'config-tab-settings']);
    expect(document.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('Configuration sections');
    expect(tab('resources').getAttribute('aria-selected')).toBe('true');
    expect(panel('resources').getAttribute('data-state')).toBe('active');
    expect(panel('sizes').getAttribute('data-state')).toBe('inactive');
    expect(panel('sizes').className).toContain('data-[state=inactive]:hidden');
  });

  it('shows counts only for the existing attention counts', async () => {
    await render();

    expect(tab('resources').textContent).toBe('Resources2 need attention');
    expect(tab('variables').textContent).toBe('Variables3 need attention');
    expect(document.querySelector('[data-testid="config-tab-sizes-count"]')).toBeNull();
    expect(document.querySelector('[data-testid="config-tab-settings-count"]')).toBeNull();

    mocks.readiness = { requiredCount: 0, environmentSetup: null };
    await render();
    expect(document.querySelectorAll('[data-testid$="-count"]')).toHaveLength(0);
  });

  it('keeps an unsaved draft across tab switches and loads the configuration once', async () => {
    await render();
    await select('variables');
    const input = document.querySelector('input[aria-label="Variables draft"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(input, 'unsaved');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await select('settings');
    await select('resources');
    await select('variables');

    expect((document.querySelector('input[aria-label="Variables draft"]') as HTMLInputElement).value).toBe('unsaved');
    expect(mocks.fetchConfig).toHaveBeenCalledTimes(1);
  });

  it('remembers the last tab per application', async () => {
    await render();
    await select('sizes');
    expect(window.sessionStorage.getItem('deployz:config-tab:app-1')).toBe('sizes');

    act(() => root.unmount());
    root = createRoot(container);
    await render();
    expect(tab('sizes').getAttribute('aria-selected')).toBe('true');
  });

  it('opens the tab a section anchor points at, and follows later anchor links', async () => {
    window.sessionStorage.setItem('deployz:config-tab:app-1', 'settings');
    window.history.replaceState(null, '', '/dashboard/applications/app-1/config#environment-variables');
    await render();
    expect(tab('variables').getAttribute('aria-selected')).toBe('true');

    await act(async () => {
      window.location.hash = '#required-changes';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(tab('resources').getAttribute('aria-selected')).toBe('true');

    // Picking a tab drops the anchor, so the same link works again.
    await select('settings');
    expect(window.location.hash).toBe('');
  });
});
