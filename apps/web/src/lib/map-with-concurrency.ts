/**
 * Maps `items` with at most `limit` calls in flight, keeping the result order.
 * The API runs on a Lambda account with a small concurrency quota: a page that
 * fires one request per row (readiness per application) must not open them all
 * at once, or the excess are throttled and the browser sees a bare network
 * failure instead of a status.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, worker));
  return results;
}
