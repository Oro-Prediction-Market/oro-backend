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

export interface HistoryPoint {
  capturedAt: Date;
  probability: number;
  totalPool: number;
}

export interface OutcomeHistory {
  outcomeId: string;
  label: string;
  points: HistoryPoint[];
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

      // A market is written as a whole or not at all: a curve where one outcome
      // has a point and its sibling does not cannot be read as a distribution.
      const moved = outcomes.some((o) => {
        const prev = latest.get(`${market.id}:${o.id}`);
        return (
          prev === undefined ||
          Math.abs(Number(o.lmsrProbability) - prev) >= MOVE_EPSILON
        );
      });
      if (!moved) continue;

      for (const o of outcomes) {
        rows.push({
          marketId: market.id,
          outcomeId: o.id,
          probability: Number(o.lmsrProbability),
          totalPool: Number(market.totalPool ?? 0),
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
  ): Promise<Map<string, number>> {
    const rows = await this.snapshotRepo.query(
      `SELECT DISTINCT ON ("marketId", "outcomeId")
              "marketId", "outcomeId", "probability"
         FROM "market_probability_snapshots"
        WHERE "marketId" = ANY($1)
        ORDER BY "marketId", "outcomeId", "capturedAt" DESC`,
      [marketIds],
    );
    const out = new Map<string, number>();
    for (const r of rows as {
      marketId: string;
      outcomeId: string;
      probability: string;
    }[]) {
      out.set(`${r.marketId}:${r.outcomeId}`, Number(r.probability));
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

    const byOutcome = new Map<string, HistoryPoint[]>();
    for (const s of snapshots) {
      const list = byOutcome.get(s.outcomeId) ?? [];
      list.push({
        capturedAt: s.capturedAt,
        probability: Number(s.probability),
        totalPool: Number(s.totalPool),
      });
      byOutcome.set(s.outcomeId, list);
    }

    const now = new Date();
    return (market.outcomes ?? [])
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((o) => {
        const points = byOutcome.get(o.id) ?? [];
        const live = Number(o.lmsrProbability);
        const last = points[points.length - 1];
        // Append the live value unless the last stored point already is it.
        if (!last || Math.abs(last.probability - live) >= MOVE_EPSILON) {
          points.push({
            capturedAt: now,
            probability: live,
            totalPool: Number(market.totalPool ?? 0),
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
