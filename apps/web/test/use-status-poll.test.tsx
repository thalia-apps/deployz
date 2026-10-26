// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useStatusPoll } from '../src/lib/use-status-poll';

// react-dom/client's act() checks this flag before running; without it, every
// act() call warns even though the assertions below pass.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The shared polling loop backing every status card (install page, fleet
// list, deployment detail, infrastructure events). No component test can see
// its internals (the single timer ref, the in-flight guard), so this drives
// the hook directly through a bare harness component and fake timers.

function Harness(props: {
  fetcher: () => Promise<string>;
  intervalMs: number;
  terminalIntervalMs: number | null;
  isTerminal: (data: string) => boolean;
  enabled?: boolean;
}) {
  useStatusPoll(props);
  return null;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(props: Parameters<typeof Harness>[0]): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Harness {...props} />);
  });
}

function rerender(props: Parameters<typeof Harness>[0]): void {
  act(() => {
    root!.render(<Harness {...props} />);
  });
}

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
  }
  container?.remove();
  container = null;
  root = null;
  vi.useRealTimers();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

/** Flushes the microtask chain a fetcher's resolved promise needs to settle,
 *  under fake timers — advancing by 0ms still runs due microtasks. */
async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe('useStatusPoll', () => {
  it('fetches once on mount, then again every intervalMs', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue('a');
    mount({ fetcher, intervalMs: 5000, terminalIntervalMs: 60000, isTerminal: () => false });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('numeric terminalIntervalMs keeps polling, at the slower cadence, once terminal', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue('done');
    mount({ fetcher, intervalMs: 5000, terminalIntervalMs: 60000, isTerminal: () => true });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    // The base interval alone must not trigger another fetch once terminal.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // The slow terminal cadence does.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(55_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('terminalIntervalMs: null stops polling entirely once terminal — no further fetches as time advances', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue('done');
    mount({ fetcher, intervalMs: 5000, terminalIntervalMs: null, isTerminal: () => true });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('resumes polling after a visibility-change refresh returns a non-terminal value', async () => {
    vi.useFakeTimers();
    let terminal = true;
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(terminal ? 'done' : 'retrying'));
    mount({ fetcher, intervalMs: 5000, terminalIntervalMs: null, isTerminal: (data) => data === 'done' });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    // No timer armed while terminal.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // The customer retried: the next status the visibility refresh sees is
    // no longer terminal.
    terminal = false;
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Polling resumed at the normal cadence.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('clears its timer on unmount — no fetch fires after unmounting', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue('a');
    mount({ fetcher, intervalMs: 5000, terminalIntervalMs: 60000, isTerminal: () => false });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    act(() => {
      root!.unmount();
    });
    root = null;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('never runs two fetches at once — a slow fetch blocks the next tick until it settles', async () => {
    vi.useFakeTimers();
    let resolveFirst!: (value: string) => void;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => new Promise<string>((resolve) => (resolveFirst = resolve)))
      .mockResolvedValue('a');
    mount({ fetcher, intervalMs: 5000, terminalIntervalMs: 60000, isTerminal: () => false });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Time advances well past the interval while the first fetch is still
    // pending — no second fetch may start (inFlight guard, and no timer is
    // even scheduled until the in-flight one's `finally` runs).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    resolveFirst('a');
    await flush();
    // Now that the first fetch settled and scheduled the next tick, time can
    // advance to it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not duplicate the loop across a re-render with the same options identity pattern', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue('a');
    const props = { fetcher, intervalMs: 5000, terminalIntervalMs: 60000, isTerminal: () => false };
    mount(props);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    // A re-render (e.g. a parent state change) must not arm a second timer.
    rerender({ ...props });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('in a hidden tab, fetches once for first data, then waits for the tab to show', async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    const fetcher = vi.fn().mockResolvedValue('a');
    mount({ fetcher, intervalMs: 5000, terminalIntervalMs: 60000, isTerminal: () => false });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
