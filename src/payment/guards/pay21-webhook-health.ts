import type { RedisService } from "../../redis/redis.service";

/**
 * Counting 21Pay webhook deliveries we refused.
 *
 * A delivery that fails verification is rejected in Pay21WebhookGuard before
 * anything records it — so `crypto_webhook_events` only ever holds accepted
 * deliveries, and a page reading that table alone would look perfectly
 * healthy while every single delivery bounced. A misnamed webhook secret
 * produces exactly that: the deploy workflow once renamed it from
 * TWENTYONE_PAY_WEBHOOK_SECRET while the code still read the old name.
 *
 * The keys live here so the guard that writes them and the admin view that
 * reads them cannot drift apart.
 */
const dayKey = (d: Date) =>
  `oro:pay21:webhook-rejected:${d.toISOString().slice(0, 10)}`;
const LAST_KEY = "oro:pay21:webhook-last-rejected";

/** Keep a little over a week of daily counters. */
const DAY_TTL_SEC = 9 * 24 * 3600;
const LAST_TTL_SEC = 30 * 24 * 3600;

/**
 * Record one rejection. Best-effort by construction: it must never be able to
 * change whether a webhook is accepted, so every failure is swallowed.
 */
export async function recordWebhookRejection(
  redis: RedisService | undefined,
  now = new Date(),
): Promise<void> {
  const client = redis?.redis;
  if (!client) return;
  try {
    const key = dayKey(now);
    const n = await client.incr(key);
    if (n === 1) await client.expire(key, DAY_TTL_SEC);
    await client.set(LAST_KEY, now.toISOString(), "EX", LAST_TTL_SEC);
  } catch {
    /* observability only */
  }
}

export async function readWebhookRejections(
  redis: RedisService | undefined,
  now = new Date(),
): Promise<{ today: number; last7Days: number; lastRejectedAt: string | null }> {
  const client = redis?.redis;
  if (!client) return { today: 0, last7Days: 0, lastRejectedAt: null };
  try {
    const keys = Array.from({ length: 7 }, (_, i) =>
      dayKey(new Date(now.getTime() - i * 24 * 3600 * 1000)),
    );
    const [counts, last] = await Promise.all([
      client.mget(...keys),
      client.get(LAST_KEY),
    ]);
    const nums = counts.map((c) => Number(c ?? 0));
    return {
      today: nums[0] ?? 0,
      last7Days: nums.reduce((a, b) => a + b, 0),
      lastRejectedAt: last ?? null,
    };
  } catch {
    return { today: 0, last7Days: 0, lastRejectedAt: null };
  }
}
