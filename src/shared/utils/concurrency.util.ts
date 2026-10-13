/**
 * Runs `fn` over `items` with at most `limit` calls in flight, results in
 * input order — Promise.all with a cap.
 *
 * Use it wherever a request fans out one DB query (or several) per row. The
 * pool is 15 connections per pod; an uncapped Promise.all over thousands of
 * rows queues every query at once, and a bet or payment on the same pod then
 * waits behind them for a connection.
 *
 * Rejects with the first error, like Promise.all; workers stop taking new
 * items once one has failed.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

/** Positive integer from an env value, else the fallback. */
export function envLimit(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
