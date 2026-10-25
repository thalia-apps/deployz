// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

const { OrganizationForm } = await import('../src/components/organization-form');

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function submit(status: number, body: unknown): Promise<void> {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));
  await act(async () => {
    root.render(<OrganizationForm organization={{ id: 'org-1', name: 'Old' } as never} />);
  });
  await act(async () => {
    container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

describe('OrganizationForm', () => {
  it('refreshes the server-rendered page after the name is saved', async () => {
    await submit(200, { id: 'org-1', name: 'New' });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it('does not refresh when the save fails', async () => {
    await submit(400, { error: { code: 'VALIDATION_ERROR', message: 'bad' } });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
