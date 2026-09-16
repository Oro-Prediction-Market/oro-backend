import type Redis from "ioredis";

/**
 * Live delivery counters for a broadcast in flight.
 *
 * These live in Redis rather than on the row because the alternative is 2,199
 * UPDATEs against one row, which would serialise the whole fan-out behind a
 * single row lock. The durable copy is folded onto the row once, at the end.
 *
 * Plain functions over an ioredis client rather than a service, so the admin
 * module and the jobs module can both use them without importing each other.
 */

/** Counters outlive a ~90s broadcast by a wide margin, then clean themselves up. */
const STATS_TTL_SECONDS = 7 * 24 * 60 * 60;

/** How many error samples to keep. Enough to see a pattern, not enough to bloat. */
const MAX_ERROR_SAMPLES = 50;

export type AnnouncementCounterField = "sent" | "blocked" | "failed" | "done";

export interface AnnouncementCounters {
  sent: number;
  blocked: number;
  failed: number;
  /** Terminal outcomes recorded. Equals sent + blocked + failed. */
  done: number;
}

export function statsKey(announcementId: string): string {
  return `oro:ann:${announcementId}:stats`;
}

export function errorsKey(announcementId: string): string {
  return `oro:ann:${announcementId}:errors`;
}

/**
 * Record one terminal delivery outcome and return the running `done` total.
 *
 * The returned count is what makes "last one out finalises" safe: HINCRBY is
 * atomic, so exactly one of 2,199 concurrent jobs sees `done === total`.
 */
export async function recordOutcome(
  redis: Redis,
  announcementId: string,
  field: Exclude<AnnouncementCounterField, "done">,
  sample?: { code?: number; description?: string },
): Promise<number> {
  const key = statsKey(announcementId);
  const pipe = redis.pipeline();
  pipe.hincrby(key, field, 1);
  pipe.hincrby(key, "done", 1);
  pipe.expire(key, STATS_TTL_SECONDS);
  if (sample) {
    pipe.lpush(errorsKey(announcementId), JSON.stringify(sample));
    pipe.ltrim(errorsKey(announcementId), 0, MAX_ERROR_SAMPLES - 1);
    pipe.expire(errorsKey(announcementId), STATS_TTL_SECONDS);
  }
  const res = await pipe.exec();
  // The second command is the `done` HINCRBY; ioredis returns [err, value] pairs.
  const done = res?.[1]?.[1];
  return typeof done === "number" ? done : 0;
}

export async function readCounters(
  redis: Redis,
  announcementId: string,
): Promise<AnnouncementCounters> {
  const h = await redis.hgetall(statsKey(announcementId));
  const n = (v: string | undefined) => (v ? parseInt(v, 10) || 0 : 0);
  return {
    sent: n(h?.sent),
    blocked: n(h?.blocked),
    failed: n(h?.failed),
    done: n(h?.done),
  };
}

export async function readErrorSamples(
  redis: Redis,
  announcementId: string,
): Promise<Array<{ code?: number; description?: string }>> {
  const raw = await redis.lrange(errorsKey(announcementId), 0, MAX_ERROR_SAMPLES - 1);
  return raw
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Telegram told us this user is unreachable and always will be.
 *
 * 403 is a blocked bot or a user who never pressed Start; 400 "chat not found"
 * is a deleted account. Retrying either burns the rate limit that the reachable
 * users are waiting on, so these are terminal — and they are counted apart from
 * real failures, because 5-20% of them is normal rather than a bug.
 */
export function isPermanentDeliveryFailure(r: {
  code?: number;
  description?: string;
}): boolean {
  if (r.code === 403) return true;
  if (r.code === 400 && /chat not found|user not found|chat_id is empty/i.test(r.description ?? ""))
    return true;
  return false;
}
