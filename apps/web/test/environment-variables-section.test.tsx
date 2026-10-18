// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnvironmentSettingsResponse } from '../src/lib/environment-settings';
import type { MaskedConfigEntry } from '../src/lib/config';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Radix Select/Collapsible measure and scroll elements jsdom does not
// implement; none of that matters for these assertions.
class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

// The Configuration page's "Environment variables" section (docs/environment-variables.md):
// summary counts, grouped order, the filters and search, bulk classification,
// custom values in the same table, truthful save failures, the
// provider-select constraints (customer disallowed at build stage, Deployz
// only for a providable key), the vendor runtime-secret warning, the
// customer-facing preview, the needsReentry warning, and the save order
// (settings, then values — never analysis).

const mocks = vi.hoisted(() => ({
  fetchEnvironmentSettings: vi.fn(),
  saveEnvironmentSettings: vi.fn(),
  saveConfig: vi.fn(),
}));

vi.mock('../src/lib/environment-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/environment-settings')>();
  return {
    ...actual,
    fetchEnvironmentSettings: mocks.fetchEnvironmentSettings,
    saveEnvironmentSettings: mocks.saveEnvironmentSettings,
  };
});

vi.mock('../src/lib/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/config')>();
  return { ...actual, saveConfig: mocks.saveConfig };
});

const { EnvironmentVariablesSection } = await import(
  '../src/app/dashboard/applications/[id]/config/environment-variables-section'
);

function response(overrides: Partial<EnvironmentSettingsResponse> = {}): EnvironmentSettingsResponse {
  return {
    settings: null,
    variables: [
      {
        key: 'DATABASE_URL',
        required: true,
        secret: false,
        source: ['read in app.py'],
        classification: 'customer_required',
      },
      {
        key: 'API_KEY',
        required: true,
        secret: true,
        source: ['read in app.py'],
      },
      {
        key: 'LOG_LEVEL',
        required: false,
        secret: false,
        source: ['read with a default'],
        classification: 'optional',
      },
      {
        key: 'INTERNAL_SECRET',
        required: true,
        secret: true,
        source: ['generated'],
        classification: 'deployz_generated',
      },
      {
        key: 'NEXT_PUBLIC_ANALYTICS_ID',
        required: false,
        secret: false,
        source: ['.env.example'],
        classification: 'optional',
      },
    ],
    deployzKeys: ['INTERNAL_SECRET'],
    provisioned: { database: false, cache: false, storage: false },
    vendorValueKeys: [],
    ...overrides,
  };
}

let container: HTMLElement;
let root: Root;

function byTestId(id: string): Element | null {
  return document.body.querySelector(`[data-testid="${id}"]`);
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error('element not found');
  await act(async () => {
    element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true }));
  });
}

async function setValue(element: Element | null, value: string): Promise<void> {
  if (!element) throw new Error('element not found');
  // React tracks <input> value through the native setter, not a plain
  // property assignment — bypass its tracking so the dispatched 'input'
  // event is seen as a real change (same trick create-deployment-page.test
  // and friends do not need because they type via user-event; here there is
  // no such helper, so this replicates it directly).
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchEnvironmentSettings.mockResolvedValue(response());
  mocks.saveEnvironmentSettings.mockImplementation(async (_id, settings) => response({ settings }));
  mocks.saveConfig.mockResolvedValue({
    applicationId: 'app-1',
    customerId: null,
    customerName: null,
    vendorDefaults: [],
    customerOverrides: [],
    effective: [],
  });
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

async function renderSection(vendorDefaults: MaskedConfigEntry[] = []): Promise<void> {
  await act(async () => {
    root.render(
      <EnvironmentVariablesSection
        applicationId="app-1"
        vendorDefaults={vendorDefaults}
        onValuesSaved={() => {}}
      />,
    );
  });
  // Flush the fetch effect.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function showAll(): Promise<void> {
  await click(byTestId('environment-variables-filter-all'));
}

const groupIds = (): (string | null)[] =>
  Array.from(document.querySelectorAll('[data-testid^="environment-variables-group-"]')).map((el) =>
    el.getAttribute('data-testid'),
  );

describe('Environment variables section', () => {
  it('shows the summary counts and lists unresolved required rows first', async () => {
    await renderSection();
    await showAll();

    const summary = byTestId('environment-variables-summary')?.textContent ?? '';
    expect(summary).toContain('2 need');
    expect(summary).toContain('decision');
    expect(summary).toContain('managed by Deployz');

    const rows = Array.from(document.querySelectorAll('[data-testid^="environment-variable-row-"]')).map((el) =>
      el.getAttribute('data-testid'),
    );
    // DATABASE_URL and API_KEY (needs-decision) come before INTERNAL_SECRET (ready).
    expect(rows.indexOf('environment-variable-row-DATABASE_URL')).toBeLessThan(
      rows.indexOf('environment-variable-row-INTERNAL_SECRET'),
    );
    expect(rows.indexOf('environment-variable-row-API_KEY')).toBeLessThan(
      rows.indexOf('environment-variable-row-INTERNAL_SECRET'),
    );
  });

  it('opens on the vendor and customer variables, and All shows every group in order', async () => {
    await renderSection();

    expect(byTestId('environment-variables-filter-inputs')?.getAttribute('aria-pressed')).toBe('true');
    expect(groupIds()).toEqual(['environment-variables-group-attention']);
    expect(byTestId('environment-variable-row-LOG_LEVEL')).toBeNull();
    expect(byTestId('environment-variables-filter-attention')?.textContent).toBe('Needs input2');

    await showAll();
    expect(groupIds()).toEqual([
      'environment-variables-group-attention',
      'environment-variables-group-deployz',
      'environment-variables-group-optional',
    ]);
    expect(byTestId('environment-variable-row-LOG_LEVEL')).not.toBeNull();
    expect(byTestId('environment-variable-row-NEXT_PUBLIC_ANALYTICS_ID')).not.toBeNull();
    expect(byTestId('environment-variable-value-INTERNAL_SECRET')?.textContent).toBe('Set by Deployz at install');
    expect(byTestId('environment-variable-row-DATABASE_URL')?.textContent).toContain('Needs a decision');
  });

  it('filters to Managed and Optional, and keeps edits made under another filter', async () => {
    await renderSection();
    await click(byTestId('environment-variable-edit-DATABASE_URL'));
    await click(byTestId('environment-variable-DATABASE_URL-provider'));
    await click(
      Array.from(document.querySelectorAll('[data-slot="select-item"]')).find((el) => el.textContent === 'Optional / not needed') ??
        null,
    );

    await click(byTestId('environment-variables-filter-managed'));
    expect(groupIds()).toEqual(['environment-variables-group-deployz']);
    await click(byTestId('environment-variables-filter-optional'));
    expect(groupIds()).toEqual(['environment-variables-group-optional']);

    // The hidden row's draft is still saved.
    const saveButton = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Save changes');
    await click(saveButton ?? null);
    const [, settings] = mocks.saveEnvironmentSettings.mock.calls[0] as [string, { key: string; provider: string }[]];
    expect(settings.find((setting) => setting.key === 'DATABASE_URL')?.provider).toBe('none');
  });

  it('searches variable names across the selected filter', async () => {
    await renderSection();
    await showAll();
    const search = document.querySelector('input[aria-label="Search variables"]');
    await setValue(search, 'log');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    expect(Array.from(document.querySelectorAll('[data-testid^="environment-variable-row-"]')).map((el) => el.getAttribute('data-testid'))).toEqual([
      'environment-variable-row-LOG_LEVEL',
    ]);

    await setValue(search, 'nothing-matches');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(byTestId('environment-variables-no-matches')?.textContent).toContain('No variables match.');
  });

  it('renders a long list one page at a time', async () => {
    mocks.fetchEnvironmentSettings.mockResolvedValue(
      response({
        variables: Array.from({ length: 120 }, (_, index) => ({
          key: `VAR_${String(index).padStart(3, '0')}`,
          required: true,
          secret: index % 2 === 0,
          source: ['read in app.py'],
        })),
        deployzKeys: [],
      }),
    );
    await renderSection();

    const rows = () => document.querySelectorAll('[data-testid^="environment-variable-row-"]').length;
    expect(rows()).toBe(50);
    expect(byTestId('environment-variables-show-more')?.textContent).toBe('Show 50 more');
    await click(byTestId('environment-variables-show-more'));
    expect(rows()).toBe(100);
    await click(byTestId('environment-variables-show-more'));
    expect(rows()).toBe(120);
    expect(byTestId('environment-variables-show-more')).toBeNull();
    // A secret's value is never rendered, only its state.
    expect(document.body.textContent).not.toContain('••');
  });

  it('bulk-marks selected rows optional and saves them with provider none', async () => {
    await renderSection();

    const checkbox = byTestId('environment-variable-row-DATABASE_URL')?.querySelector('input[type="checkbox"]');
    await click(checkbox ?? null);
    await click(byTestId('environment-variables-bulk-optional'));

    const saveButton = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Save changes');
    await click(saveButton ?? null);

    expect(mocks.saveEnvironmentSettings).toHaveBeenCalledTimes(1);
    const [, settings] = mocks.saveEnvironmentSettings.mock.calls[0] as [
      string,
      { key: string; provider: string; required: boolean }[],
    ];
    const saved = settings.find((s) => s.key === 'DATABASE_URL');
    expect(saved?.provider).toBe('none');
    expect(saved?.required).toBe(false);
  });

  it('accepts every suggested decision at once and saves them on Save changes', async () => {
    await renderSection();

    const accept = byTestId('environment-variables-accept-suggestions');
    expect(accept?.textContent).toContain('Accept 2 suggested decisions');
    await click(accept);
    expect(byTestId('environment-variables-accept-suggestions')).toBeNull();

    const saveButton = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Save changes');
    await click(saveButton ?? null);

    const [, settings] = mocks.saveEnvironmentSettings.mock.calls[0] as [
      string,
      { key: string; provider: string }[],
    ];
    expect(settings.find((s) => s.key === 'DATABASE_URL')?.provider).toBe('vendor');
    expect(settings.find((s) => s.key === 'API_KEY')).toBeDefined();
  });

  it('flags a saved decision the latest analysis no longer finds and clears it with one click', async () => {
    mocks.fetchEnvironmentSettings.mockResolvedValue(
      response({
        settings: [
          { key: 'GONE_KEY', stage: 'runtime', required: true, secret: false, provider: 'vendor' },
          { key: 'DONE_KEY', stage: 'runtime', required: false, secret: false, provider: 'none' },
        ],
      }),
    );
    await renderSection();

    const stale = byTestId('environment-variables-stale');
    expect(stale?.textContent).toContain('GONE_KEY');
    expect(stale?.textContent).toContain('Variables not found in the latest analysis');
    expect(stale?.textContent).toContain('Variables you added can stay.');
    expect(stale?.textContent).not.toContain('DONE_KEY');

    await click(byTestId('environment-variables-stale-GONE_KEY'));
    expect(byTestId('environment-variables-stale')).toBeNull();

    const saveButton = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Save changes');
    await click(saveButton ?? null);
    const [, settings] = mocks.saveEnvironmentSettings.mock.calls[0] as [
      string,
      { key: string; provider: string; required: boolean }[],
    ];
    const cleared = settings.find((s) => s.key === 'GONE_KEY');
    expect(cleared?.provider).toBe('none');
    expect(cleared?.required).toBe(false);
  });

  it('never triggers analysis and saves settings before values', async () => {
    await renderSection();

    const checkbox = byTestId('environment-variable-row-DATABASE_URL')?.querySelector('input[type="checkbox"]');
    await click(checkbox ?? null);
    await click(byTestId('environment-variables-bulk-optional'));

    const saveButton = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Save changes');
    await click(saveButton ?? null);

    expect(mocks.saveEnvironmentSettings.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.saveConfig.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('saves the suggested decision with a value entered on an undecided row', async () => {
    await renderSection();
    // The re-read after the value save reports what the server now has.
    mocks.fetchEnvironmentSettings.mockImplementation(async () =>
      response({
        settings: mocks.saveEnvironmentSettings.mock.calls[0]?.[1] ?? null,
        vendorValueKeys: ['DATABASE_URL'],
      }),
    );

    await click(byTestId('environment-variable-edit-DATABASE_URL'));
    await setValue(document.getElementById('env-value-DATABASE_URL'), 'https://cdn.example.com');
    const saveButton = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Save changes');
    await click(saveButton ?? null);

    const [, settings] = mocks.saveEnvironmentSettings.mock.calls[0] as [string, { key: string; provider: string }[]];
    expect(settings.find((s) => s.key === 'DATABASE_URL')?.provider).toBe('vendor');
    expect(mocks.saveConfig).toHaveBeenCalledWith(
      'app-1',
      null,
      [{ key: 'DATABASE_URL', value: 'https://cdn.example.com', isSecret: false }],
      [],
    );
    expect(byTestId('environment-variables-summary')?.textContent).toContain('1 needs a decision');
    expect(byTestId('environment-variable-row-DATABASE_URL')?.textContent).toContain('Ready');
    expect(document.body.querySelector('[role="status"]')?.textContent).toBe('Saved.');
  });

  it('disables the customer provider option for a build-stage variable', async () => {
    await renderSection();
    await showAll();
    await click(byTestId('environment-variable-edit-NEXT_PUBLIC_ANALYTICS_ID'));

    const trigger = byTestId('environment-variable-NEXT_PUBLIC_ANALYTICS_ID-provider');
    await click(trigger);
    const customerItem = Array.from(document.querySelectorAll('[data-slot="select-item"]')).find(
      (el) => el.textContent === 'Set by customer',
    );
    expect(customerItem?.getAttribute('data-disabled')).not.toBeNull();
  });

  it('disables the Deployz provider option for a key Deployz cannot provide', async () => {
    await renderSection();
    await click(byTestId('environment-variable-edit-DATABASE_URL'));

    const trigger = byTestId('environment-variable-DATABASE_URL-provider');
    await click(trigger);
    const deployzItem = Array.from(document.querySelectorAll('[data-slot="select-item"]')).find(
      (el) => el.textContent === 'Managed by Deployz',
    );
    expect(deployzItem?.getAttribute('data-disabled')).not.toBeNull();
  });

  it('offers the managed values of the application resources when Managed by Deployz is chosen', async () => {
    mocks.fetchEnvironmentSettings.mockResolvedValue(
      response({ provisioned: { database: true, cache: false, storage: false } }),
    );
    await renderSection();
    await click(byTestId('environment-variable-edit-DATABASE_URL'));
    await click(byTestId('environment-variable-DATABASE_URL-provider'));
    await click(
      Array.from(document.querySelectorAll('[data-slot="select-item"]')).find(
        (el) => el.textContent === 'Managed by Deployz',
      ) ?? null,
    );

    const valueTrigger = byTestId('environment-variable-DATABASE_URL-binding');
    expect(valueTrigger?.textContent).toBe('Database URL');
    await click(valueTrigger);
    const labels = Array.from(document.querySelectorAll('[data-slot="select-item"]')).map((el) => el.textContent);
    expect(labels).toEqual([
      'Database URL',
      'Database host',
      'Database port',
      'Database name',
      'Database user',
      'Database password',
      'JDBC URL',
    ]);
    await click(
      Array.from(document.querySelectorAll('[data-slot="select-item"]')).find((el) => el.textContent === 'JDBC URL') ??
        null,
    );
    await click(saveButton());

    const [, settings] = mocks.saveEnvironmentSettings.mock.calls[0] as [string, { key: string; binding?: unknown }[]];
    expect(settings.find((s) => s.key === 'DATABASE_URL')?.binding).toEqual({ resource: 'database', kind: 'jdbc_url' });
  });

  it('shows no value select for a key Deployz already provides', async () => {
    mocks.fetchEnvironmentSettings.mockResolvedValue(
      response({ provisioned: { database: true, cache: false, storage: false } }),
    );
    await renderSection();
    await showAll();
    await click(byTestId('environment-variable-edit-INTERNAL_SECRET'));
    expect(byTestId('environment-variable-INTERNAL_SECRET-binding')).toBeNull();
  });

  it('adds a managed value for a name analysis did not detect', async () => {
    mocks.fetchEnvironmentSettings.mockResolvedValue(
      response({ provisioned: { database: true, cache: true, storage: false } }),
    );
    await renderSection();
    await click(byTestId('environment-variables-add-managed'));
    await setValue(document.getElementById('environment-new-0'), 'GF_DATABASE_URL');
    await click(saveButton());

    const [, settings] = mocks.saveEnvironmentSettings.mock.calls[0] as [string, unknown[]];
    expect(settings).toContainEqual({
      key: 'GF_DATABASE_URL',
      stage: 'runtime',
      required: false,
      secret: false,
      provider: 'deployz',
      binding: { resource: 'database', kind: 'url' },
    });
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });

  it('hides Add managed value when the application has no managed resource', async () => {
    await renderSection();
    expect(byTestId('environment-variables-add-managed')).toBeNull();
  });

  it('shows the vendor runtime-secret warning for a vendor-provided runtime secret', async () => {
    const withSetting = response({
      settings: [
        { key: 'API_KEY', stage: 'runtime', required: true, secret: true, provider: 'vendor' },
      ],
    });
    mocks.fetchEnvironmentSettings.mockResolvedValue(withSetting);
    await renderSection();

    await click(byTestId('environment-variable-row-API_KEY')?.querySelector('[data-testid^="environment-variable-edit-"]') ?? null);
    expect(byTestId('environment-variable-runtime-warning-API_KEY')).not.toBeNull();
  });

  it('shows a label and key in the customer field preview', async () => {
    const withSetting = response({
      settings: [{ key: 'API_KEY', stage: 'runtime', required: true, secret: true, provider: 'customer', label: 'API key' }],
    });
    mocks.fetchEnvironmentSettings.mockResolvedValue(withSetting);
    await renderSection();

    await click(byTestId('environment-variable-row-API_KEY')?.querySelector('[data-testid^="environment-variable-edit-"]') ?? null);
    const preview = byTestId('environment-variable-customer-preview-API_KEY');
    expect(preview?.textContent).toContain('API key');
    expect(preview?.textContent).toContain('API_KEY');
  });

  it('shows a re-enter warning for a vendor secret flagged needsReentry', async () => {
    const withSetting = response({
      settings: [{ key: 'API_KEY', stage: 'runtime', required: true, secret: true, provider: 'vendor' }],
    });
    mocks.fetchEnvironmentSettings.mockResolvedValue(withSetting);
    await renderSection([{ key: 'API_KEY', isSecret: true, value: null, needsReentry: true }]);

    await click(byTestId('environment-variable-row-API_KEY')?.querySelector('[data-testid^="environment-variable-edit-"]') ?? null);
    expect(byTestId('environment-variable-reentry-API_KEY')).not.toBeNull();
  });
});

function saveButton(): Element | null {
  return Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Save changes') ?? null;
}

describe('Custom values in the same table', () => {
  const CUSTOM: MaskedConfigEntry[] = [
    { key: 'LOG_FORMAT', isSecret: false, value: 'json' },
    { key: 'SMTP_PASSWORD', isSecret: true, value: null },
  ];

  it('lists saved defaults no variable covers as vendor rows, never showing a secret', async () => {
    await renderSection(CUSTOM);

    expect(byTestId('environment-variables-group-vendor')?.textContent).toContain('Set by vendor · 2');
    expect(byTestId('environment-custom-row-LOG_FORMAT')?.textContent).toContain('json');
    expect(byTestId('environment-custom-row-SMTP_PASSWORD')?.textContent).toContain('Secret saved');
  });

  it('saves an edited custom value in the vendor scope without touching the variable decisions', async () => {
    await renderSection(CUSTOM);

    await click(byTestId('environment-custom-row-LOG_FORMAT')?.querySelector('button') ?? null);
    await setValue(document.getElementById('env-custom-LOG_FORMAT'), 'text');
    await click(saveButton());

    expect(mocks.saveEnvironmentSettings).not.toHaveBeenCalled();
    expect(mocks.saveConfig).toHaveBeenCalledWith('app-1', null, [{ key: 'LOG_FORMAT', value: 'text', isSecret: false }], []);
  });

  it('stages a removal until Save', async () => {
    await renderSection(CUSTOM);

    const remove = Array.from(byTestId('environment-custom-row-SMTP_PASSWORD')?.querySelectorAll('button') ?? []).find(
      (b) => b.textContent === 'Remove',
    );
    await click(remove ?? null);
    expect(byTestId('environment-custom-row-SMTP_PASSWORD')?.textContent).toContain('Removing');
    expect(mocks.saveConfig).not.toHaveBeenCalled();
    await click(saveButton());

    expect(mocks.saveConfig).toHaveBeenCalledWith('app-1', null, [], ['SMTP_PASSWORD']);
  });

  it('checks a new value’s name and a new secret’s value before saving anything', async () => {
    await renderSection();

    await click(byTestId('environment-variables-add-value'));
    await click(saveButton());
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe('Give every new value a name.');

    await setValue(document.getElementById('environment-new-0'), 'DATABASE_URL');
    await click(saveButton());
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      'DATABASE_URL already exists. Edit the existing one instead.',
    );

    await setValue(document.getElementById('environment-new-0'), 'SENTRY_DSN');
    await click(byTestId('environment-variables-add-secret'));
    await setValue(document.getElementById('environment-new-1'), 'SMTP_TOKEN');
    await click(saveButton());
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe('Enter a value for SMTP_TOKEN.');
    expect(mocks.saveConfig).not.toHaveBeenCalled();

    await setValue(document.getElementById('environment-new-1-value'), 'token-value');
    await click(saveButton());
    expect(mocks.saveConfig).toHaveBeenCalledWith(
      'app-1',
      null,
      [
        { key: 'SENTRY_DSN', value: '', isSecret: false },
        { key: 'SMTP_TOKEN', value: 'token-value', isSecret: true },
      ],
      [],
    );
  });

  it('still shows saved values when the variable list fails to load', async () => {
    mocks.fetchEnvironmentSettings.mockRejectedValue(new Error('boom'));
    await renderSection(CUSTOM);

    expect(byTestId('environment-variables-error')).not.toBeNull();
    expect(byTestId('environment-custom-row-LOG_FORMAT')).not.toBeNull();
    expect(byTestId('environment-variables-summary')).toBeNull();
  });
});

describe('Truthful save feedback', () => {
  async function enterValueOnUndecidedRow(): Promise<void> {
    await click(byTestId('environment-variable-edit-DATABASE_URL'));
    await setValue(document.getElementById('env-value-DATABASE_URL'), 'https://cdn.example.com');
  }

  it('says nothing was saved when the decisions fail, and never writes the values', async () => {
    mocks.saveEnvironmentSettings.mockRejectedValue(new Error('down'));
    await renderSection();
    await enterValueOnUndecidedRow();
    await click(saveButton());

    expect(mocks.saveConfig).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Nothing was saved.');
    expect(document.body.querySelector('[role="status"]')).toBeNull();
  });

  it('says the decisions were saved but the values were not when only the value write fails', async () => {
    mocks.saveConfig.mockRejectedValue(new Error('down'));
    await renderSection();
    await enterValueOnUndecidedRow();
    await click(saveButton());

    expect(byTestId('environment-variables-partial-save')?.textContent).toContain(
      'Decisions saved, values not.',
    );
    // The value stays, so saving again retries it.
    expect(document.body.textContent).toContain('Unsaved changes.');
    await click(saveButton());
    expect(mocks.saveConfig).toHaveBeenCalledTimes(2);
  });

  it('shows the server’s own problems when it rejects a decision', async () => {
    const { EnvironmentSettingsError } = await import('../src/lib/environment-settings');
    mocks.saveEnvironmentSettings.mockRejectedValue(
      new EnvironmentSettingsError('invalid', ['DATABASE_URL: a customer value cannot be used at build time.']),
    );
    await renderSection();
    await enterValueOnUndecidedRow();
    await click(saveButton());

    expect(document.body.textContent).toContain('DATABASE_URL: a customer value cannot be used at build time.');
    expect(document.body.querySelector('[role="status"]')).toBeNull();
  });
});
