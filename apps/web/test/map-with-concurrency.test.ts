import { describe, expect, it } from 'vitest';

import { mapWithConcurrency } from '../src/lib/map-with-concurrency';

describe('mapWithConcurrency', () => {
  it('never runs more than the limit at once and keeps result order', async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapWithConcurrency(Array.from({ length: 13 }, (_, i) => i), 4, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return n * 2;
    });
    expect(peak).toBe(4);
    expect(results).toEqual(Array.from({ length: 13 }, (_, i) => i * 2));
  });

  it('handles an empty list and a limit larger than the list', async () => {
    expect(await mapWithConcurrency([], 4, async (n: number) => n)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 10, async (n) => n + 1)).toEqual([2, 3]);
  });
});
