// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerMocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => routerMocks }));

const { LinkTokenGate } = await import('../src/components/link-token-gate');

const PATH = '/install/11111111-1111-1111-1111-111111111111';

let container: HTMLDivElement;

async function mount(current?: string): Promise<void> {
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <LinkTokenGate
        path={PATH}
        {...(current === undefined ? {} : { current })}
        fallback={<p>Open the full link.</p>}
      />,
    );
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  routerMocks.refresh.mockReset();
  document.cookie = 'dz-link-token=; Max-Age=0';
  window.history.replaceState(null, '', PATH);
});

afterEach(() => {
  container.remove();
});

describe('LinkTokenGate', () => {
  it('moves the fragment secret into a cookie, clears the URL and refreshes the server page', async () => {
    window.history.replaceState(null, '', `${PATH}#fragment-secret`);

    await mount();

    expect(document.cookie).toContain('dz-link-token=fragment-secret');
    expect(window.location.hash).toBe('');
    expect(routerMocks.refresh).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('');
  });

  it('shows the fallback when the URL carries no secret', async () => {
    await mount();

    expect(routerMocks.refresh).not.toHaveBeenCalled();
    expect(container.textContent).toBe('Open the full link.');
  });

  it('shows the fallback and does not refresh when the secret is the one the server already has', async () => {
    window.history.replaceState(null, '', `${PATH}#fragment-secret`);

    await mount('fragment-secret');

    expect(window.location.hash).toBe('');
    expect(routerMocks.refresh).not.toHaveBeenCalled();
    expect(container.textContent).toBe('Open the full link.');
  });
});
