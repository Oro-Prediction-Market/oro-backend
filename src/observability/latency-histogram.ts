/**
 * Fixed-bucket latency histograms, mergeable across pods and minutes.
 *
 * Fixed bucket edges (rather than per-pod percentiles) are what make the
 * numbers addable: each pod writes bucket counts to Redis, and the admin view
 * sums them before reading a percentile off the total. A percentile is
 * reported as the upper edge of the bucket it falls in — coarse, but the same
 * coarseness before and after a change, which is what the comparison needs.
 */

/** Upper edges in ms. The last bucket catches everything slower. */
export const BUCKET_EDGES_MS = [
  10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000,
] as const;

/** One past the last edge: requests slower than 10s. */
export const OVERFLOW_BUCKET = BUCKET_EDGES_MS.length;

export interface Histogram {
  /** Count per bucket, length BUCKET_EDGES_MS.length + 1. */
  buckets: number[];
  count: number;
  sumMs: number;
  maxMs: number;
}

export function emptyHistogram(): Histogram {
  return {
    buckets: new Array(BUCKET_EDGES_MS.length + 1).fill(0),
    count: 0,
    sumMs: 0,
    maxMs: 0,
  };
}

export function bucketFor(ms: number): number {
  for (let i = 0; i < BUCKET_EDGES_MS.length; i++) {
    if (ms <= BUCKET_EDGES_MS[i]) return i;
  }
  return OVERFLOW_BUCKET;
}

export function record(h: Histogram, ms: number): void {
  h.buckets[bucketFor(ms)]++;
  h.count++;
  h.sumMs += ms;
  if (ms > h.maxMs) h.maxMs = ms;
}

export function merge(into: Histogram, from: Histogram): void {
  for (let i = 0; i < into.buckets.length; i++) {
    into.buckets[i] += from.buckets[i] ?? 0;
  }
  into.count += from.count;
  into.sumMs += from.sumMs;
  if (from.maxMs > into.maxMs) into.maxMs = from.maxMs;
}

/**
 * The upper edge of the bucket holding the p-th percentile (0 < p <= 100).
 * Overflow reports the observed max when known, else Infinity.
 */
export function percentile(h: Histogram, p: number): number {
  if (h.count === 0) return 0;
  const rank = Math.ceil((p / 100) * h.count);
  let seen = 0;
  for (let i = 0; i < h.buckets.length; i++) {
    seen += h.buckets[i];
    if (seen >= rank) {
      if (i === OVERFLOW_BUCKET) return h.maxMs || Infinity;
      return BUCKET_EDGES_MS[i];
    }
  }
  return h.maxMs || Infinity;
}

export interface RouteSummary {
  route: string;
  count: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export function summarize(route: string, h: Histogram): RouteSummary {
  return {
    route,
    count: h.count,
    avgMs: h.count ? Math.round(h.sumMs / h.count) : 0,
    p50Ms: percentile(h, 50),
    p95Ms: percentile(h, 95),
    p99Ms: percentile(h, 99),
    maxMs: Math.round(h.maxMs),
  };
}
