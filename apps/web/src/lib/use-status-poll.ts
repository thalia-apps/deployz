'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// Shared polling loop for the derived deployment status. The backend is the
// only source of lifecycle truth, so the client's whole job is: fetch on a
// cadence, keep the LAST GOOD value through transient failures (a blip in
// connectivity is not a deployment failure), and be honest about staleness.

const MAX_BACKOFF_MS = 30_000;
/** Failures tolerated before the UI admits updates are unavailable — one
 * dropped request is routine; three in a row is an outage worth showing. */
const FAILURES_BEFORE_STALE = 3;

export interface StatusPoll<T> {
  /** Last successfully fetched value; survives fetch failures. */
  data: T | null;
  /** True only when the initial fetch has never succeeded. */
  loading: boolean;
  /** True after repeated consecutive failures — show "updates unavailable". */
  stale: boolean;
  /** Refetch immediately (used by retry buttons). Resolves once the fetch
   * has settled, whether it succeeded or failed. */
  refresh: () => Promise<void>;
  /** Date.now() of the last SUCCESSFUL fetch, or null until the first client
   * fetch completes — never backdated to `initialData`/server-render time,
   * since that value was never actually checked from this browser. */
  checkedAt: number | null;
}

export function useStatusPoll<T>(options: {
  fetcher: () => Promise<T>;
  /** Base cadence while the value can still change on its own. */
  intervalMs: number;
  /** Cadence once `isTerminal(data)` — slower, because terminal states can
   * still change through outside action (retry, health loss). `null` means
   * stop polling entirely once terminal: no timer is armed, though the
   * existing visibility-change refresh (and any manual `refresh()`) still
   * runs and resumes the loop if it returns a non-terminal value. */
  terminalIntervalMs: number | null;
  isTerminal: (data: T) => boolean;
  /** Set false to pause the loop entirely (e.g. nothing to poll yet). */
  enabled?: boolean;
  /** Server-rendered value to show before the first client fetch lands —
   * avoids a loading flash on pages that already fetched it server-side. */
  initialData?: T | null;
}): StatusPoll<T> {
  const { fetcher, intervalMs, terminalIntervalMs, isTerminal, enabled = true, initialData = null } = options;
  const [data, setData] = useState<T | null>(initialData);
  const [loading, setLoading] = useState(initialData === null);
  const [stale, setStale] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  // Mutable loop state lives in refs: the timer callback must see current
  // values without re-arming effects on every tick.
  const failures = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const latest = useRef({ fetcher, intervalMs, terminalIntervalMs, isTerminal, enabled });
  latest.current = { fetcher, intervalMs, terminalIntervalMs, isTerminal, enabled };
  const dataRef = useRef<T | null>(initialData);

  const tick = useCallback(async () => {
    if (!latest.current.enabled || inFlight.current) return;
    // A hidden tab does not repeat polls; the visibilitychange listener below
    // resumes the loop. So a background tab never keeps a customer session
    // alive. The first fetch still runs, so a page opened in the background
    // has data.
    if (document.visibilityState === 'hidden' && dataRef.current !== null) return;
    inFlight.current = true;
    try {
      const next = await latest.current.fetcher();
      dataRef.current = next;
      failures.current = 0;
      setData(next);
      setStale(false);
      setLoading(false);
      setCheckedAt(Date.now());
    } catch {
      // Keep the last confirmed value on screen; only surface staleness after
      // repeated failures, and never invent a lifecycle change client-side.
      failures.current += 1;
      if (failures.current >= FAILURES_BEFORE_STALE) setStale(true);
      setLoading(false);
    } finally {
      inFlight.current = false;
      schedule();
    }
  }, []);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!latest.current.enabled) return;
    const { terminalIntervalMs: slow, intervalMs: base, isTerminal: terminal } = latest.current;
    const settled = dataRef.current !== null && terminal(dataRef.current);
    // Terminal with no slow cadence configured: arm no timer. The loop only
    // resumes through the visibility-change refresh (or a manual refresh())
    // below, whose own `finally` re-enters this function and re-evaluates
    // `settled` against the fresh data.
    if (settled && slow === null) return;
    // Exponential backoff while failing, capped — a down API gets polled
    // gently, then normal cadence resumes on the first success.
    const backoff = failures.current > 0 ? Math.min(base * 2 ** failures.current, MAX_BACKOFF_MS) : 0;
    const delay = Math.max(settled ? (slow as number) : base, backoff);
    timer.current = setTimeout(() => void tick(), delay);
  }, [tick]);

  const refresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    return tick();
  }, [tick]);

  useEffect(() => {
    if (!enabled) return;
    void tick();
    // Returning to the tab refreshes immediately: the user is looking again,
    // and the next scheduled tick could be a slow terminal interval away.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [enabled, tick, refresh]);

  return { data, loading, stale, refresh, checkedAt };
}
