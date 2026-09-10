import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, In } from "typeorm";
import { MarketProbabilitySnapshot } from "../entities/market-probability-snapshot.entity";
import { Market, MarketStatus } from "../entities/market.entity";
import { RedisService } from "../redis/redis.service";

/** Smallest move worth recording, in probability points (0.5pp). */
const MOVE_EPSILON = 0.005;

/** Snapshots for markets settled longer ago than this are pruned. */
const RETAIN_SETTLED_DAYS = 365;

/**
 * Laplace prior for the ngultrum book, matching `smoothingPrior("BTN")` in the
 * apps. Snapshots mirror the BTN book only, so this is the only prior in play.
 */
const BTN_SMOOTHING_PRIOR = 1000;

/**
 * The probability the apps actually display: this outcome's Laplace-smoothed
 * share of the pool.
 *
 * Kept identical to `calcProb` in the frontends. The stored `probability` is
 * the LMSR value, which saturates on a lopsided book — on a real market it
 * reads 37% where the outcome row beside it prints 47% — so a chart drawn from
 * it would contradict the page it sits on. Falls back to the LMSR value when
 * the pool is empty (there, the softmax is the honest starting split) or when
 * the point predates the outcomePool column.
 */
export function smoothedShare(
  outcomePool: number | null,
  totalPool: number,
  outcomeCount: number,
  fallback: number,
): number {
  if (outcomePool == null || !Number.isFinite(outcomePool)) return fallback;
  if (!(totalPool > 0)) return fallback;
  const n = outcomeCount || 1;
  return (
    (outcomePool + BTN_SMOOTHING_PRIOR / n) / (totalPool + BTN_SMOOTHING_PRIOR)
  );
}

export interface HistoryPoint {
  capturedAt: Date;
  probability: number;
  totalPool: number;
  /** This outcome's own pool. NULL on rows written before the column existed. */
  outcomePool: number | null;
  /** What to plot — the smoothed share, or `probability` when unknowable. */
  share: number;
}

export interface OutcomeHistory {
  outcomeId: string;
  label: string;
  points: HistoryPoint[];
}

/** The most recent stored point per outcome, used as the movement baseline. */
interface LatestPoint {
  probability: number;
  totalPool: number;
  outcomePool: number | null;
}

export interface Mover {
  marketId: string;
  title: string;
  category: string;
  outcomeId: string;
  outcomeLabel: string;
  /** Probability at the start of the window, 0–1. */
  from: number;
  /** Probability now, 0–1. */
  to: number;
  /** Signed change in probability points (0.13 = +13pp). */
  delta: number;
  totalPool: number;
}

@Injectable()
export class ProbabilityHistoryService {
  private readonly logger = new Logger(ProbabilityHistoryService.name);

  constructor(
    @InjectRepository(MarketProbabilitySnapshot)
    private readonly snapshotRepo: Repository<MarketProbabilitySnapshot>,
    @InjectRepository(Market)
    private readonly marketRepo: Repository<Market>,
    private readonly redis: RedisService,
  ) {}

  /**
   * Sample every open market's probabilities.
   *
   * Runs every 15 minutes — fine enough that a market moving on news shows a
   * visible step, coarse enough that a year of history stays small. Only
   * markets that actually moved are written, so the table is a record of
   * movement rather than a log of the cron running.
   */
  @Cron("*/15 * * * *")
  async sampleOpenMarkets(): Promise<void> {
    const lock = await this.redis.acquireLock("cron:probability-sample", 300);
    if (!lock) return;
    try {
      await this.sample();
    } catch (err: any) {
      this.logger.error(`[Probability] sample failed: ${err.message}`);
    } finally {
      await this.redis.releaseLock("cron:probability-sample", lock);
    }
  }

  async sample(): Promise<number> {
    const markets = await this.marketRepo.find({
      where: { status: In([MarketStatus.OPEN, MarketStatus.CLOSED]) },
      relations: ["outcomes"],
    });
    if (markets.length === 0) return 0;

    const marketIds = markets.map((m) => m.id);
    const latest = await this.latestByOutcome(marketIds);

    const rows: Partial<MarketProbabilitySnapshot>[] = [];
    for (const market of markets) {
      const outcomes = market.outcomes ?? [];
      if (outcomes.length === 0) continue;

      const marketPool = Number(market.totalPool ?? 0) || 0;

      // A market is written as a whole or not at all: a curve where one outcome
      // has a point and its sibling does not cannot be read as a distribution.
      //
      // Movement is measured on BOTH the LMSR value and the smoothed share,
      // because they move at very different speeds and we plot the latter.
      // LMSR saturates on a lopsided book: with pools of 5000/200, a Nu 500
      // stake on the favourite moves the displayed share 0.84pp but LMSR only
      // 0.32pp — under the threshold, so the old gate wrote nothing and the
      // chart flatlined through exactly the movement it exists to show.
      const moved = outcomes.some((o) => {
        const prev = latest.get(`${market.id}:${o.id}`);
        if (prev === undefined) return true;

        const live = Number(o.lmsrProbability);
        if (Math.abs(live - prev.probability) >= MOVE_EPSILON) return true;

        // "Either side unknown" counts as unchanged, so legacy rows with no
        // outcomePool don't force a write on every tick forever.
        if (prev.outcomePool === null) return false;
        const pool = Number(o.totalBetAmount ?? 0) || 0;
        const n = outcomes.length;
        return (
          Math.abs(
            smoothedShare(pool, marketPool, n, live) -
              smoothedShare(prev.outcomePool, prev.totalPool, n, prev.probability),
          ) >= MOVE_EPSILON
        );
      });
      if (!moved) continue;

      for (const o of outcomes) {
        rows.push({
          marketId: market.id,
          outcomeId: o.id,
          probability: Number(o.lmsrProbability),
          totalPool: marketPool,
          // `?? 0` guards a relation loaded without the column: a bare
          // Number(undefined) is NaN, which Postgres rejects on insert.
          outcomePool: Number(o.totalBetAmount ?? 0) || 0,
        });
      }
    }

    if (rows.length === 0) return 0;

    // Chunked so a busy sample never builds a single oversized INSERT.
    for (let i = 0; i < rows.length; i += 500) {
      await this.snapshotRepo.insert(rows.slice(i, i + 500));
    }

    this.logger.log(
      `[Probability] captured ${rows.length} point(s) across ` +
        `${new Set(rows.map((r) => r.marketId)).size} moved market(s)`,
    );
    return rows.length;
  }

  /** Latest recorded probability per outcome, keyed `${marketId}:${outcomeId}`. */
  private async latestByOutcome(
    marketIds: string[],
  ): Promise<Map<string, LatestPoint>> {
    const rows = await this.snapshotRepo.query(
      `SELECT DISTINCT ON ("marketId", "outcomeId")
              "marketId", "outcomeId", "probability", "totalPool", "outcomePool"
         FROM "market_probability_snapshots"
        WHERE "marketId" = ANY($1)
        ORDER BY "marketId", "outcomeId", "capturedAt" DESC`,
      [marketIds],
    );
    const out = new Map<string, LatestPoint>();
    for (const r of rows as {
      marketId: string;
      outcomeId: string;
      probability: string;
      totalPool: string | null;
      outcomePool: string | null;
    }[]) {
      // `== null` on purpose: a legacy row reads NULL, and a caller that never
      // selected the column reads undefined. Both mean "unknown" — letting
      // undefined through would make Number() produce NaN, and a NaN share
      // compares unequal to everything, so every market would look moved.
      out.set(`${r.marketId}:${r.outcomeId}`, {
        probability: Number(r.probability),
        totalPool: Number(r.totalPool ?? 0) || 0,
        outcomePool: r.outcomePool == null ? null : Number(r.outcomePool),
      });
    }
    return out;
  }

  /**
   * One market's probability curve, per outcome, oldest point first.
   *
   * The current live probability is appended as a trailing point so a chart
   * always ends at what the market says right now, even if the last sample was
   * up to 15 minutes ago.
   */
  async getHistory(
    marketId: string,
    opts: { hours?: number } = {},
  ): Promise<OutcomeHistory[]> {
    const market = await this.marketRepo.findOne({
      where: { id: marketId },
      relations: ["outcomes"],
    });
    if (!market) return [];

    const hours = Math.min(Math.max(opts.hours ?? 24 * 30, 1), 24 * 365);
    const since = new Date(Date.now() - hours * 3600_000);

    const snapshots = await this.snapshotRepo
      .createQueryBuilder("s")
      .where("s.marketId = :marketId", { marketId })
      .andWhere("s.capturedAt >= :since", { since })
      .orderBy("s.capturedAt", "ASC")
      .getMany();

    const outcomeCount = (market.outcomes ?? []).length;

    const byOutcome = new Map<string, HistoryPoint[]>();
    for (const s of snapshots) {
      const list = byOutcome.get(s.outcomeId) ?? [];
      const probability = Number(s.probability);
      const totalPool = Number(s.totalPool);
      const outcomePool = s.outcomePool === null ? null : Number(s.outcomePool);
      list.push({
        capturedAt: s.capturedAt,
        probability,
        totalPool,
        outcomePool,
        share: smoothedShare(outcomePool, totalPool, outcomeCount, probability),
      });
      byOutcome.set(s.outcomeId, list);
    }

    const now = new Date();
    const marketPool = Number(market.totalPool ?? 0) || 0;
    return (market.outcomes ?? [])
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((o) => {
        const points = byOutcome.get(o.id) ?? [];
        const live = Number(o.lmsrProbability);
        const livePool = Number(o.totalBetAmount ?? 0) || 0;
        const liveShare = smoothedShare(
          livePool,
          marketPool,
          outcomeCount,
          live,
        );
        const last = points[points.length - 1];
        // Append the live value unless the last stored point already is it.
        // Compared on the share as well as the LMSR value, for the same reason
        // the sampler's gate is: this is often the only point a curve has, and
        // an LMSR-only comparison suppresses it while the displayed number has
        // visibly moved.
        if (
          !last ||
          Math.abs(last.probability - live) >= MOVE_EPSILON ||
          Math.abs(last.share - liveShare) >= MOVE_EPSILON
        ) {
          points.push({
            capturedAt: now,
            probability: live,
            totalPool: marketPool,
            outcomePool: livePool,
            share: liveShare,
          });
        }
        return { outcomeId: o.id, label: o.label, points };
      });
  }

  /**
   * Biggest probability moves in the window — the "what changed" feed.
   *
   * One row per market (its largest-moving outcome), because a two-outcome
   * market moving 20pp one way is one story, not two.
   */
  async getMovers(
    opts: { hours?: number; limit?: number; minDelta?: number } = {},
  ): Promise<Mover[]> {
    const hours = Math.min(Math.max(opts.hours ?? 24, 1), 24 * 30);
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
    const minDelta = opts.minDelta ?? 0.05;
    const since = new Date(Date.now() - hours * 3600_000);

    // First and last point per outcome inside the window. Two DISTINCT ON
    // queries beat pulling every point back and reducing in memory.
    const [firstRows, lastRows] = await Promise.all([
      this.snapshotRepo.query(
        `SELECT DISTINCT ON ("marketId", "outcomeId")
                "marketId", "outcomeId", "probability"
           FROM "market_probability_snapshots"
          WHERE "capturedAt" >= $1
          ORDER BY "marketId", "outcomeId", "capturedAt" ASC`,
        [since],
      ),
      this.snapshotRepo.query(
        `SELECT DISTINCT ON ("marketId", "outcomeId")
                "marketId", "outcomeId", "probability", "totalPool"
           FROM "market_probability_snapshots"
          WHERE "capturedAt" >= $1
          ORDER BY "marketId", "outcomeId", "capturedAt" DESC`,
        [since],
      ),
    ]);

    type Row = {
      marketId: string;
      outcomeId: string;
      probability: string;
      totalPool?: string;
    };
    const firstByKey = new Map<string, number>();
    for (const r of firstRows as Row[]) {
      firstByKey.set(`${r.marketId}:${r.outcomeId}`, Number(r.probability));
    }

    // Largest absolute move per market.
    const best = new Map<string, Mover>();
    for (const r of lastRows as Row[]) {
      const key = `${r.marketId}:${r.outcomeId}`;
      const from = firstByKey.get(key);
      if (from === undefined) continue;
      const to = Number(r.probability);
      const delta = to - from;
      if (Math.abs(delta) < minDelta) continue;

      const existing = best.get(r.marketId);
      // Rounded before comparing: on a two-outcome market the two deltas are
      // equal and opposite, and raw float subtraction makes one of them
      // marginally larger by noise — which would let the reported direction of
      // a binary market flip at random between runs.
      if (existing && !this.beatsIncumbent(existing, delta, to)) continue;
      best.set(r.marketId, {
        marketId: r.marketId,
        title: "",
        category: "",
        outcomeId: r.outcomeId,
        outcomeLabel: "",
        from,
        to,
        delta,
        totalPool: Number(r.totalPool ?? 0),
      });
    }
    if (best.size === 0) return [];

    // Label them, and drop anything no longer worth showing (cancelled markets).
    const markets = await this.marketRepo.find({
      where: { id: In([...best.keys()]) },
      relations: ["outcomes"],
    });

    const out: Mover[] = [];
    for (const market of markets) {
      if (market.status === MarketStatus.CANCELLED) continue;
      const mover = best.get(market.id);
      if (!mover) continue;
      const outcome = (market.outcomes ?? []).find(
        (o) => o.id === mover.outcomeId,
      );
      out.push({
        ...mover,
        title: market.title,
        category: String(market.category),
        outcomeLabel: outcome?.label ?? "",
      });
    }

    return out
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, limit);
  }

  /**
   * Whether a candidate move should replace the market's current best.
   *
   * Bigger move wins. On a tie the upward move wins: "X rose to 70%" is how a
   * reader thinks about a binary market, not "not-X fell to 30%" — same fact,
   * and only one of them reads like news.
   */
  private beatsIncumbent(
    incumbent: Mover,
    delta: number,
    to: number,
  ): boolean {
    const a = Number(Math.abs(incumbent.delta).toFixed(6));
    const b = Number(Math.abs(delta).toFixed(6));
    if (b !== a) return b > a;
    if (delta > 0 !== incumbent.delta > 0) return delta > 0;
    return to > incumbent.to;
  }

  /**
   * Drop snapshots for markets settled or cancelled over a year ago. Resolved
   * history is the public record, so it is kept far longer than it is useful —
   * but not forever.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async pruneOldSnapshots(): Promise<void> {
    const lock = await this.redis.acquireLock("cron:probability-prune", 600);
    if (!lock) return;
    try {
      const cutoff = new Date(Date.now() - RETAIN_SETTLED_DAYS * 86400_000);
      const result = await this.snapshotRepo.query(
        `DELETE FROM "market_probability_snapshots" s
          USING "markets" m
          WHERE s."marketId" = m."id"
            AND m."status" IN ('settled', 'cancelled')
            AND m."updatedAt" < $1`,
        [cutoff],
      );
      const removed = Array.isArray(result) ? result[1] : undefined;
      if (removed) {
        this.logger.log(`[Probability] pruned ${removed} old snapshot(s)`);
      }
    } catch (err: any) {
      this.logger.error(`[Probability] prune failed: ${err.message}`);
    } finally {
      await this.redis.releaseLock("cron:probability-prune", lock);
    }
  }
}
