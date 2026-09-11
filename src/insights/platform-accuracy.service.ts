import { Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { RedisService } from "../redis/redis.service";

export interface AccuracyTrendPoint {
  /** Monday of the week, as YYYY-MM-DD. */
  week: string;
  marketCount: number;
  avgAccuracyPct: number;
}

export interface PlatformAccuracy {
  overallAccuracyPct: number;
  totalMarkets: number;
  trend: AccuracyTrendPoint[];
}

const CACHE_KEY = "oro:cache:platform-accuracy";
const CACHE_TTL_SECONDS = 300;

/**
 * How often the crowd is right.
 *
 * For each settled market, the share of the pool that sat on the outcome that
 * actually won. Averaged across markets it is the closest thing Oro has to a
 * public track record — and unlike a win rate it cannot be gamed by a single
 * lucky account, because it is a property of the market, not of a user.
 *
 * Lifted out of the admin controller so the admin page and the public page
 * cannot drift: both read this, and "the same stats" is true by construction
 * rather than by two copies of the same SQL staying in step.
 *
 * Nothing here is commercially sensitive — no revenue, no fees, no per-user
 * figures. It is the pool split on markets that have already finished.
 */
@Injectable()
export class PlatformAccuracyService {
  private readonly logger = new Logger(PlatformAccuracyService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redis: RedisService,
  ) {}

  async get(): Promise<PlatformAccuracy> {
    // Public route now, so it is worth not running two aggregates per hit. The
    // number moves only when a market settles; five minutes stale is nothing.
    try {
      const hit = await this.redis.getJson<PlatformAccuracy>(CACHE_KEY);
      if (hit) return hit;
    } catch (e) {
      this.logger.warn(`accuracy cache read failed: ${(e as Error).message}`);
    }

    const fresh = await this.compute();

    try {
      await this.redis.setJsonEx(CACHE_KEY, CACHE_TTL_SECONDS, fresh);
    } catch (e) {
      this.logger.warn(`accuracy cache write failed: ${(e as Error).message}`);
    }
    return fresh;
  }

  private async compute(): Promise<PlatformAccuracy> {
    // For each settled market (deduplicated), compute what fraction of the
    // total bet pool landed on the winning outcome. Average across all markets
    // gives the overall crowd accuracy; weekly grouping gives the trend line.
    //
    // NB the weekly buckets read `settlements.settledAt`, which is `timestamp
    // WITHOUT time zone` and was written in Bhutan local time until early
    // September 2026 and in UTC after it. A settlement within six hours of a
    // Monday boundary can therefore land in the neighbouring week. It moves no
    // market between buckets by more than one, and the overall figure — which
    // does not bucket at all — is unaffected.
    const rows = await this.dataSource.query(`
      WITH canonical AS (
        SELECT DISTINCT ON (s."marketId")
          s."marketId",
          s."winningOutcomeId",
          s."totalPool",
          s."settledAt"
        FROM settlements s
        INNER JOIN markets m ON m.id = s."marketId"
        WHERE s."cancelReason" IS NULL
          AND s."totalPool" > 0
        ORDER BY s."marketId", s."settledAt" ASC
      ),
      with_winner AS (
        SELECT
          c."marketId",
          c."settledAt",
          c."totalPool",
          o."totalBetAmount" AS "winnerPool"
        FROM canonical c
        INNER JOIN outcomes o
          ON o.id = c."winningOutcomeId"
          AND o."marketId" = c."marketId"
      )
      SELECT
        TO_CHAR(DATE_TRUNC('week', "settledAt"), 'YYYY-MM-DD') AS week,
        COUNT(*)::int AS "marketCount",
        ROUND(AVG("winnerPool"::numeric / "totalPool"::numeric) * 100, 1) AS "avgAccuracyPct"
      FROM with_winner
      GROUP BY DATE_TRUNC('week', "settledAt")
      ORDER BY DATE_TRUNC('week', "settledAt") ASC
    `);

    const overall = await this.dataSource.query(`
      WITH canonical AS (
        SELECT DISTINCT ON (s."marketId")
          s."winningOutcomeId",
          s."totalPool",
          s."marketId"
        FROM settlements s
        INNER JOIN markets m ON m.id = s."marketId"
        WHERE s."cancelReason" IS NULL
          AND s."totalPool" > 0
        ORDER BY s."marketId", s."settledAt" ASC
      )
      SELECT
        COUNT(*)::int AS "totalMarkets",
        ROUND(AVG(o."totalBetAmount"::numeric / c."totalPool"::numeric) * 100, 1) AS "overallAccuracyPct"
      FROM canonical c
      INNER JOIN outcomes o
        ON o.id = c."winningOutcomeId"
        AND o."marketId" = c."marketId"
    `);

    return {
      overallAccuracyPct: Number(overall[0]?.overallAccuracyPct ?? 0),
      totalMarkets: Number(overall[0]?.totalMarkets ?? 0),
      trend: rows.map((r: any) => ({
        week: r.week,
        marketCount: r.marketCount,
        avgAccuracyPct: Number(r.avgAccuracyPct),
      })),
    };
  }
}
