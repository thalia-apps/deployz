// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = () => {};
// jsdom implements neither pointer capture nor its queries; Radix Select
// calls them while handling pointer events inside the dialog portal.
Element.prototype.hasPointerCapture = () => false as never;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

const mocks = vi.hoisted(() => ({
  fetchApplications: vi.fn(),
  fetchRegions: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('../src/lib/applications', () => ({
  fetchApplications: mocks.fetchApplications,
}));
vi.mock('../src/lib/regions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/regions')>();
  return { ...actual, fetchRegions: mocks.fetchRegions };
});
vi.mock('../src/lib/api-url', () => ({
  apiUrl: 'http://api.test',
}));

const { InvitationDialog } = await import('../src/components/invitation-form');

const TOKEN = 'a'.repeat(64);

const cleanups: Array<() => void> = [];

async function renderDialog(): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(
      <InvitationDialog
        customerId="cus-1"
        open
        onOpenChange={() => {}}
        onCreated={() => {}}
      />,
    );
  });
  cleanups.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });
  return container;
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

/** Full pointer sequence — Radix Select opens on pointerdown, not click. */
async function press(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true }));
  });
}

/** Opens the Radix application select and picks the option containing `label`. */
async function selectApplication(label: string): Promise<void> {
  const trigger = document.querySelector('[data-slot="select-trigger"]') as HTMLElement;
  await press(trigger);
  const option = Array.from(document.querySelectorAll('[role="option"]')).find((item) =>
    (item.textContent ?? '').includes(label),
  ) as HTMLElement;
  if (!option) throw new Error(`option "${label}" not found`);
  await press(option);
}

beforeEach(() => {
  mocks.fetchApplications.mockReset().mockResolvedValue([
    { id: 'app-1', name: 'Acme App', defaultSizeProfile: 'small', minimumSizeProfile: 'small' },
    { id: 'app-2', name: 'Second App', defaultSizeProfile: 'medium', minimumSizeProfile: 'medium' },
  ]);
  mocks.fetchRegions.mockReset().mockResolvedValue([{ value: 'us-east-1', label: 'US East (N. Virginia)' }]);
  mocks.fetch.mockReset().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ id: '33333333-3333-3333-3333-333333333333', token: TOKEN }),
  });
  vi.stubGlobal('fetch', mocks.fetch);
});

afterEach(() => {
  while (cleanups.length) {
    cleanups.pop()?.();
  }
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

/** The dialog's form portals to document.body, so buttons are queried there. */
function submitButton(): HTMLButtonElement {
  return Array.from(document.body.querySelectorAll('button')).find(
    (button) => button.type === 'submit',
  ) as HTMLButtonElement;
}

describe('InvitationDialog', () => {
  it('renders the optional recommendation with its helper copy and disables submit until an application is chosen', async () => {
    await renderDialog();

    expect(document.body.textContent).toContain('Create invitation');
    expect(document.body.textContent).toContain('Recommended AWS region');
    expect(document.body.textContent).toContain('No recommendation');
    expect(document.body.textContent).toContain(
      'Your customer will make the final Region selection before deployment.',
    );

    expect(submitButton().disabled).toBe(true);

    await selectApplication('Acme App');
    expect(submitButton().disabled).toBe(false);
  });

  it('points the Application and Region labels at their select triggers', async () => {
    await renderDialog();

    for (const text of ['Application', 'Recommended AWS region']) {
      const label = Array.from(document.body.querySelectorAll('label')).find((l) =>
        l.textContent?.startsWith(text),
      ) as HTMLLabelElement;
      expect(document.getElementById(label.htmlFor)?.getAttribute('role')).toBe('combobox');
    }
  });

  it('posts the invitation body and reveals one URL that carries the one-time token', async () => {
    await renderDialog();
    await selectApplication('Acme App');

    await act(async () => {
      click(submitButton());
    });

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api.test/api/customers/cus-1/invitations');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ applicationId: 'app-1', recommendedSizeProfile: 'small' });

    expect(document.body.textContent).toContain('Invitation created');
    // An input's value is not part of textContent — read the field itself.
    const linkInput = document.getElementById('invitation-link') as HTMLInputElement;
    expect(linkInput.value).toContain(`#${TOKEN}`);
    expect(document.body.textContent).toContain('The token is shown only once');
  });

  it('preselects the application default size, limits the choices to the minimum, and sends the chosen size', async () => {
    await renderDialog();
    await selectApplication('Second App');

    const sizeTrigger = document.querySelectorAll('[data-slot="select-trigger"]')[1] as HTMLElement;
    expect(sizeTrigger.textContent).toContain('Medium');
    await press(sizeTrigger);
    const options = Array.from(document.querySelectorAll('[role="option"]'));
    expect(options.map((option) => option.textContent)).toEqual([
      'Medium (1 vCPU · 2 GiB)',
      'Large (2 vCPU · 4 GiB)',
    ]);
    await press(options[1] as Element);

    await act(async () => {
      click(submitButton());
    });

    const [, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ applicationId: 'app-2', recommendedSizeProfile: 'large' });
  });

  it('shows the server error message when creation fails', async () => {
    mocks.fetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: { message: 'Application not found.' } }),
    });
    await renderDialog();
    await selectApplication('Acme App');

    await act(async () => {
      click(submitButton());
    });

    // A non-Api error maps to the generic fallback copy.
    expect(document.body.textContent).toContain('Something went wrong. Try again in a moment.');
  });
});
