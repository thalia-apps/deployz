// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerMocks = vi.hoisted(() => ({ replace: vi.fn() }));
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
  routerMocks.replace.mockReset();
  document.cookie = 'dz-link-token=; Max-Age=0';
  window.history.replaceState(null, '', PATH);
});

afterEach(() => {
  container.remove();
});

describe('LinkTokenGate', () => {
  it('moves the fragment secret into a cookie and replaces the URL without the fragment', async () => {
    window.history.replaceState(null, '', `${PATH}#fragment-secret`);

    await mount();

    expect(document.cookie).toContain('dz-link-token=fragment-secret');
    expect(routerMocks.replace).toHaveBeenCalledExactlyOnceWith(PATH);
    expect(container.textContent).toBe('');
  });

  it('shows the fallback when the URL carries no secret', async () => {
    await mount();

    expect(routerMocks.replace).not.toHaveBeenCalled();
    expect(container.textContent).toBe('Open the full link.');
  });

  it('shows the fallback and only replaces the URL when the secret is the one the server already has', async () => {
    window.history.replaceState(null, '', `${PATH}#fragment-secret`);

    await mount('fragment-secret');

    expect(routerMocks.replace).toHaveBeenCalledExactlyOnceWith(PATH);
    expect(container.textContent).toBe('Open the full link.');
  });
});
