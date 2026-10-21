// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Application } from '../src/lib/applications';
import type { ApplicationReadiness } from '../src/lib/readiness';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The migration setting edits the application's migration choice: a command,
// or "No separate migration". Existing deployments use it on their next
// release deployment, so the dialog says so instead of the generic copy.

const mocks = vi.hoisted(() => ({ updateApplication: vi.fn() }));

vi.mock('@/lib/applications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/applications')>();
  return { ...actual, updateApplication: mocks.updateApplication };
});

import { EditDialog } from '../src/app/dashboard/applications/[id]/readiness-components';

const application: Application = {
  id: 'app-1',
  organizationId: 'org-1',
  name: 'Acme API',
  githubInstallationId: 'inst-1',
  repoFullName: 'acme/api',
  repoUrl: 'https://github.com/acme/api',
  defaultBranch: 'main',
  containerPort: 3000,
  healthPath: '/health',
  migrationCommand: null,
  workerCommand: null,
  databaseRequired: true,
  storageRequired: false,
  redisRequired: false,
  defaultSizeProfile: 'small',
  minimumSizeProfile: 'small',
  analysisStatus: 'COMPLETE',
  compatibilityStatus: 'NEEDS_ATTENTION',
  compatibilityReason: null,
  detectedMetadata: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

let root: Root;

function renderDialog(app: Application, readiness: ApplicationReadiness): Promise<void> {
  return act(async () => {
    root.render(
      <EditDialog field="migrationCommand" application={app} readiness={readiness} onClose={() => {}} onSaved={() => {}} />,
    );
  });
}

const readiness = { requirements: null } as unknown as ApplicationReadiness;

beforeEach(async () => {
  mocks.updateApplication.mockReset().mockResolvedValue(application);
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await renderDialog(application, readiness);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
});

function saveButton(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((button) => button.textContent === 'Save');
}

describe('migration EditDialog', () => {
  it('explains that existing deployments use the edit on their next release deployment', () => {
    expect(document.body.textContent).toContain('An existing deployment uses it on its next release deployment');
  });

  it('says a command cannot be added later and must be safe to run more than once', () => {
    expect(document.body.textContent).toContain('created without a migration step');
    expect(document.body.textContent).toContain('safe to run more than once');
  });

  it('shows no reset when the vendor never set the migration command', () => {
    expect(document.querySelector('[data-testid="edit-reset-migrationCommand"]')).toBeNull();
  });

  it('needs a command or "No separate migration" before it saves', async () => {
    expect(saveButton()?.disabled).toBe(true);
    await act(async () => {
      document.querySelector<HTMLButtonElement>('#edit-no-migration')?.click();
    });
    expect(document.querySelector<HTMLInputElement>('#edit-field-migrationCommand')?.disabled).toBe(true);
    await act(async () => {
      saveButton()?.click();
    });
    expect(mocks.updateApplication).toHaveBeenCalledWith('app-1', { migrationCommand: null });
  });

  it('saves a command the vendor enters', async () => {
    const input = document.querySelector<HTMLInputElement>('#edit-field-migrationCommand')!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setValue.call(input, 'node scripts/migrate.js');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      saveButton()?.click();
    });
    expect(mocks.updateApplication).toHaveBeenCalledWith('app-1', { migrationCommand: 'node scripts/migrate.js' });
  });

  it('keeps the choice when status polling replaces the application and readiness', async () => {
    await act(async () => {
      document.querySelector<HTMLButtonElement>('#edit-no-migration')?.click();
    });
    await renderDialog({ ...application }, { ...readiness });
    expect(document.querySelector('#edit-no-migration')?.getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector<HTMLInputElement>('#edit-field-migrationCommand')?.disabled).toBe(true);
    await act(async () => {
      saveButton()?.click();
    });
    expect(mocks.updateApplication).toHaveBeenCalledWith('app-1', { migrationCommand: null });
  });

  it('keeps a typed command when status polling replaces the application and readiness', async () => {
    const input = document.querySelector<HTMLInputElement>('#edit-field-migrationCommand')!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setValue.call(input, 'node scripts/migrate.js');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await renderDialog({ ...application }, { ...readiness });
    expect(document.querySelector<HTMLInputElement>('#edit-field-migrationCommand')?.value).toBe('node scripts/migrate.js');
  });

  it('reopens with "No separate migration" on after the vendor saved it', async () => {
    const skipped = { ...application, detectedMetadata: { vendorOverrides: ['migrationCommand'] } };
    await act(async () => root.unmount());
    root = createRoot(document.body.appendChild(document.createElement('div')));
    await renderDialog(skipped, readiness);
    expect(document.querySelector('#edit-no-migration')?.getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector<HTMLInputElement>('#edit-field-migrationCommand')?.disabled).toBe(true);
    expect(saveButton()?.disabled).toBe(false);
  });

  it('resets an overridden command to detected without turning migrations off', async () => {
    const overridden = {
      ...application,
      migrationCommand: 'node scripts/migrate.js',
      detectedMetadata: { vendorOverrides: ['migrationCommand'] },
    };
    await act(async () => root.unmount());
    root = createRoot(document.body.appendChild(document.createElement('div')));
    await renderDialog(overridden, readiness);
    const reset = document.querySelector<HTMLButtonElement>('[data-testid="edit-reset-migrationCommand"]');
    expect(reset).not.toBeNull();
    await act(async () => {
      reset?.click();
    });
    expect(mocks.updateApplication).toHaveBeenCalledWith('app-1', { resetMigrationCommand: true });
  });

  it('reopens with the switch off when the migration command was never set by the vendor', () => {
    expect(document.querySelector('#edit-no-migration')?.getAttribute('aria-checked')).toBe('false');
  });
});
