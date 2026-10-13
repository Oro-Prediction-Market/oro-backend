import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { RedisService } from "../redis/redis.service";
import {
  BUCKET_EDGES_MS,
  Histogram,
  RouteSummary,
  emptyHistogram,
  merge,
  record,
  summarize,
} from "./latency-histogram";

/** Per-minute Redis hashes; kept a day so a deploy can be compared with the day before. */
const KEY_PREFIX = "oro:perf:";
const KEY_TTL_SEC = 24 * 60 * 60;
const FLUSH_MS = 60_000;
/** Routes logged per pod per minute — up to 16 pods, so keep the log readable. */
const LOG_TOP_ROUTES = 10;
/** Field separator inside a minute hash: route templates never contain a tab. */
const SEP = "\t";

/**
 * Adds counts to a minute hash and keeps a running max, in one round trip.
 * ARGV: ttl, then (field, increment) pairs; KEYS[1] the hash. Fields ending in
 * "\tmax" are max-merged instead of added.
 */
const FLUSH_SCRIPT = `
local ttl = tonumber(ARGV[1])
for i = 2, #ARGV, 2 do
  local field = ARGV[i]
  local v = tonumber(ARGV[i + 1])
  if string.sub(field, -4) == "\\tmax" then
    local cur = tonumber(redis.call("HGET", KEYS[1], field) or "0")
    if v > cur then redis.call("HSET", KEYS[1], field, v) end
  else
    redis.call("HINCRBY", KEYS[1], field, v)
  end
end
redis.call("EXPIRE", KEYS[1], ttl)
return 1
`;

export function minuteKey(at: Date): string {
  const iso = at.toISOString(); // 2026-10-13T09:41:12.000Z
  return `${KEY_PREFIX}${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}`;
}

/** Flattens histograms into (field, value) pairs for FLUSH_SCRIPT. */
export function toFlushArgs(byRoute: Map<string, Histogram>): string[] {
  const args: string[] = [];
  for (const [route, h] of byRoute) {
    h.buckets.forEach((n, i) => {
      if (n) args.push(`${route}${SEP}${i}`, String(n));
    });
    args.push(`${route}${SEP}sum`, String(Math.round(h.sumMs)));
    args.push(`${route}${SEP}max`, String(Math.round(h.maxMs)));
  }
  return args;
}

/** Rebuilds per-route histograms from minute hashes (HGETALL results). */
export function fromHashes(
  hashes: Array<Record<string, string> | null>,
): Map<string, Histogram> {
  const byRoute = new Map<string, Histogram>();
  for (const hash of hashes) {
    if (!hash) continue;
    const minute = new Map<string, Histogram>();
    for (const [field, raw] of Object.entries(hash)) {
      const cut = field.lastIndexOf(SEP);
      if (cut < 0) continue;
      const route = field.slice(0, cut);
      const part = field.slice(cut + 1);
      const v = Number(raw) || 0;
      let h = minute.get(route);
      if (!h) minute.set(route, (h = emptyHistogram()));
      if (part === "sum") h.sumMs = v;
      else if (part === "max") h.maxMs = v;
      else {
        const i = Number(part);
        if (Number.isInteger(i) && i >= 0 && i <= BUCKET_EDGES_MS.length) {
          h.buckets[i] = v;
          h.count += v;
        }
      }
    }
    for (const [route, h] of minute) {
      const into = byRoute.get(route);
      if (into) merge(into, h);
      else byRoute.set(route, h);
    }
  }
  return byRoute;
}

/**
 * Request latency per route, per pod, flushed once a minute: a log line per
 * route (n / p50 / p95 / p99 / max) plus the DB pool's state, and the same
 * counts added into Redis so GET /admin/perf can read every pod at once.
 *
 * Observation only — it never changes a response, and every Redis failure is
 * swallowed. PERF_TIMING=off turns it off.
 */
@Injectable()
export class PerfRecorderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("Perf");
  private current = new Map<string, Histogram>();
  private timer?: NodeJS.Timeout;
  readonly enabled: boolean;
  readonly slowRequestMs: number;

  constructor(
    config: ConfigService,
    private readonly redis: RedisService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    this.enabled = config.get<string>("PERF_TIMING", "on") !== "off";
    this.slowRequestMs = Number(config.get("SLOW_REQUEST_MS", 2000)) || 2000;
  }

  onModuleInit() {
    if (!this.enabled) return;
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  record(route: string, ms: number, status: number) {
    if (!this.enabled) return;
    let h = this.current.get(route);
    if (!h) this.current.set(route, (h = emptyHistogram()));
    record(h, ms);
    if (ms >= this.slowRequestMs) {
      this.logger.warn(
        `slow request ${route} ${Math.round(ms)}ms status=${status}`,
      );
    }
  }

  /** The pg pool behind TypeORM: waiting > 0 means requests queue for a connection. */
  poolStats(): { total: number; idle: number; waiting: number } | null {
    const pool = (this.dataSource?.driver as any)?.master;
    if (!pool || typeof pool.totalCount !== "number") return null;
    return {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    };
  }

  async flush(now = new Date()): Promise<void> {
    const batch = this.current;
    this.current = new Map();
    const pool = this.poolStats();
    if (pool) {
      this.logger.log(
        `pool total=${pool.total} idle=${pool.idle} waiting=${pool.waiting}`,
      );
    }
    if (batch.size === 0) return;
    // The slowest few per pod; Redis gets every route for GET /admin/perf.
    const slowest = [...batch]
      .map(([route, h]) => summarize(route, h))
      .sort((a, b) => b.p95Ms - a.p95Ms || b.count - a.count)
      .slice(0, LOG_TOP_ROUTES);
    for (const s of slowest) {
      this.logger.log(
        `${s.route} n=${s.count} p50=${s.p50Ms} p95=${s.p95Ms} p99=${s.p99Ms} max=${s.maxMs}`,
      );
    }
    try {
      // Counts belong to the minute that just ended.
      const key = minuteKey(new Date(now.getTime() - 1_000));
      await this.redis.redis.eval(
        FLUSH_SCRIPT,
        1,
        key,
        String(KEY_TTL_SEC),
        ...toFlushArgs(batch),
      );
    } catch {
      /* metrics are best-effort */
    }
  }

  /** Every pod's counts for the last `minutes`, merged per route, slowest p95 first. */
  async summary(minutes: number, now = new Date()): Promise<RouteSummary[]> {
    const span = Math.min(Math.max(Math.floor(minutes) || 60, 1), 24 * 60);
    const keys: string[] = [];
    for (let i = 1; i <= span; i++) {
      keys.push(minuteKey(new Date(now.getTime() - i * 60_000)));
    }
    let hashes: Array<Record<string, string> | null> = [];
    try {
      const pipe = this.redis.pipeline();
      for (const k of keys) pipe.hgetall(k);
      const res = (await pipe.exec()) ?? [];
      hashes = res.map(([err, v]) =>
        err ? null : (v as Record<string, string>),
      );
    } catch {
      hashes = [];
    }
    return [...fromHashes(hashes)]
      .map(([route, h]) => summarize(route, h))
      .sort((a, b) => b.p95Ms - a.p95Ms || b.count - a.count);
  }
}
