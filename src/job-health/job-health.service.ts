import { Injectable, Logger, Optional } from "@nestjs/common";
import { RedisService } from "../redis/redis.service";

/**
 * The scheduled jobs whose silent failure costs money or breaks a promise.
 *
 * Not every cron — the 15-minute probability sampler failing costs nobody
 * anything. These are the ones where "it quietly stopped" means a prize not
 * paid, a deposit not credited, a withdrawal stuck, or revenue unbooked.
 *
 * `staleAfterMs` is how long without a successful run before it is worth a
 * human's attention. Generous on purpose: several replicas share these behind
 * locks, so any single replica legitimately skips most ticks.
 */
export const JOBS = {
  "season-rollover": {
    label: "Monthly season rollover & prizes",
    schedule: "00:05 on the 1st",
    staleAfterMs: 32 * 24 * 3600_000,
  },
  "weekly-report": {
    label: "Weekly admin report",
    schedule: "Mondays 09:00 (Bhutan)",
    staleAfterMs: 8 * 24 * 3600_000,
  },
  "auto-resolve": {
    label: "Settle expired objection windows",
    schedule: "every 5 min",
    staleAfterMs: 20 * 60_000,
  },
  "revenue-reconcile": {
    label: "Book missing revenue",
    schedule: "every 10 min",
    staleAfterMs: 40 * 60_000,
  },
  "revenue-pending-transfers": {
    label: "Resolve pending DK revenue transfers",
    schedule: "every 5 min",
    staleAfterMs: 20 * 60_000,
  },
  "dk-withdrawal-reconciler": {
    label: "Reconcile stuck DK withdrawals",
    schedule: "every 5 min",
    staleAfterMs: 20 * 60_000,
  },
  "usdt-deposit-poller": {
    label: "USDT deposit poller (webhook fallback)",
    schedule: "every minute",
    staleAfterMs: 5 * 60_000,
  },
  "usdt-withdrawal-poller": {
    label: "USDT withdrawal poller",
    schedule: "every minute",
    staleAfterMs: 5 * 60_000,
  },
  "settlement-audit": {
    label: "Re-check last 7 days of results",
    schedule: "daily 09:30 (Bhutan)",
    staleAfterMs: 26 * 3600_000,
  },
  "ter-rounds": {
    label: "TER round settlement",
    schedule: "every 3 s",
    staleAfterMs: 2 * 60_000,
  },
  "btc-rounds": {
    label: "BTC round settlement",
    schedule: "every 3 s",
    staleAfterMs: 2 * 60_000,
  },
} as const;

export type JobKey = keyof typeof JOBS;

export type JobStatus = "ok" | "failing" | "stale" | "disabled" | "never";

export interface JobHealthRow {
  key: JobKey;
  label: string;
  schedule: string;
  status: JobStatus;
  lastOkAt: string | null;
  lastFailAt: string | null;
  lastError: string | null;
  lastSkipAt: string | null;
  lastSkipReason: string | null;
}

const KEY = (job: JobKey) => `oro:jobhealth:${job}`;
/** Outlives the longest interval (monthly) with room to spare. */
const TTL_SEC = 45 * 24 * 3600;
/**
 * A healthy job writes at most this often per replica. The TER and BTC loops
 * run every three seconds; recording each tick would be a Redis write every
 * three seconds for no extra information.
 */
const OK_WRITE_INTERVAL_MS = 30_000;

/**
 * Records when each important job last succeeded, failed, or stood down.
 *
 * Instrumentation only. Every write is fire-and-forget and swallows its own
 * errors: a Redis hiccup must never slow, fail, or change the outcome of the
 * job being observed. `track` rethrows the job's own error unchanged, so a
 * wrapped job behaves exactly as it did unwrapped.
 *
 * Stored as a Redis hash per job, one field per fact, so two replicas
 * recording at once cannot overwrite each other's fields.
 */
@Injectable()
export class JobHealthService {
  private readonly logger = new Logger(JobHealthService.name);
  private readonly lastWrite = new Map<JobKey, number>();
  private readonly lastStatus = new Map<JobKey, "ok" | "fail" | "skip">();

  constructor(@Optional() private readonly redis?: RedisService) {}

  async track<T>(job: JobKey, fn: () => Promise<T>): Promise<T> {
    let result: T;
    try {
      result = await fn();
    } catch (err) {
      this.fail(job, err);
      throw err;
    }
    this.ok(job);
    return result;
  }

  ok(job: JobKey, now = Date.now()): void {
    const recentlyWritten = now - (this.lastWrite.get(job) ?? 0) < OK_WRITE_INTERVAL_MS;
    // Always write the first success after a failure or skip, so recovery
    // shows immediately rather than up to 30s late.
    if (recentlyWritten && this.lastStatus.get(job) === "ok") return;
    this.lastWrite.set(job, now);
    this.lastStatus.set(job, "ok");
    this.write(job, { lastOkAt: new Date(now).toISOString() });
  }

  fail(job: JobKey, err: unknown, now = Date.now()): void {
    this.lastStatus.set(job, "fail");
    const message = err instanceof Error ? err.message : String(err);
    this.write(job, {
      lastFailAt: new Date(now).toISOString(),
      lastError: message.slice(0, 500),
    });
  }

  /** The job deliberately did nothing — e.g. its feature is switched off. */
  skip(job: JobKey, reason: string, now = Date.now()): void {
    if (this.lastStatus.get(job) === "skip" && now - (this.lastWrite.get(job) ?? 0) < OK_WRITE_INTERVAL_MS) return;
    this.lastWrite.set(job, now);
    this.lastStatus.set(job, "skip");
    this.write(job, {
      lastSkipAt: new Date(now).toISOString(),
      lastSkipReason: reason.slice(0, 200),
    });
  }

  async snapshot(now = Date.now()): Promise<JobHealthRow[]> {
    const client = this.redis?.redis;
    const keys = Object.keys(JOBS) as JobKey[];
    const records = await Promise.all(
      keys.map(async (k) => {
        if (!client) return {} as Record<string, string>;
        try {
          return (await client.hgetall(KEY(k))) ?? {};
        } catch {
          return {} as Record<string, string>;
        }
      }),
    );

    return keys.map((key, i) => {
      const r = records[i];
      const spec = JOBS[key];
      const t = (iso?: string) => (iso ? Date.parse(iso) : 0);
      const okAt = t(r.lastOkAt);
      const failAt = t(r.lastFailAt);
      const skipAt = t(r.lastSkipAt);

      let status: JobStatus;
      if (failAt && failAt > okAt) status = "failing";
      else if (skipAt && skipAt > okAt && now - skipAt < spec.staleAfterMs)
        status = "disabled";
      else if (!okAt) status = "never";
      else if (now - okAt > spec.staleAfterMs) status = "stale";
      else status = "ok";

      return {
        key,
        label: spec.label,
        schedule: spec.schedule,
        status,
        lastOkAt: r.lastOkAt ?? null,
        lastFailAt: r.lastFailAt ?? null,
        lastError: r.lastError ?? null,
        lastSkipAt: r.lastSkipAt ?? null,
        lastSkipReason: r.lastSkipReason ?? null,
      };
    });
  }

  private write(job: JobKey, fields: Record<string, string>): void {
    const client = this.redis?.redis;
    if (!client) return;
    void (async () => {
      try {
        await client.hset(KEY(job), fields);
        await client.expire(KEY(job), TTL_SEC);
      } catch (err) {
        this.logger.debug(
          `[JobHealth] could not record ${job}: ${(err as Error).message}`,
        );
      }
    })();
  }
}

/**
 * Stand-in used when the service is not injected — unit tests that construct
 * a job directly. Runs the job and records nothing.
 */
export const NOOP_JOB_HEALTH = {
  track: <T>(_job: JobKey, fn: () => Promise<T>) => fn(),
  ok: () => undefined,
  fail: () => undefined,
  skip: () => undefined,
  snapshot: async () => [],
} as unknown as JobHealthService;
