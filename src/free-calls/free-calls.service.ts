import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";
import { Cron } from "@nestjs/schedule";
import { Repository, DataSource, In } from "typeorm";
import { FreeCall, FreeCallStatus } from "../entities/free-call.entity";
import { Market, MarketStatus } from "../entities/market.entity";
import { Position } from "../entities/position.entity";
import { User } from "../entities/user.entity";
import { RedisService } from "../redis/redis.service";

const PG_UNIQUE_VIOLATION = "23505";

/** Minimum scored calls before someone appears on the accuracy leaderboard. */
const LEADERBOARD_MIN_CALLS = 5;

export interface FreeCallLeaderboardEntry {
  rank: number;
  userId: string;
  name: string;
  calls: number;
  correct: number;
  accuracy: number;
  /** Lower is better. */
  brierScore: number;
}

@Injectable()
export class FreeCallsService {
  private readonly logger = new Logger(FreeCallsService.name);

  constructor(
    @InjectRepository(FreeCall)
    private readonly callRepo: Repository<FreeCall>,
    @InjectRepository(Market)
    private readonly marketRepo: Repository<Market>,
    @InjectRepository(Position)
    private readonly positionRepo: Repository<Position>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redis: RedisService,
  ) {}

  /**
   * Record a no-stake call on an open market.
   *
   * Deliberately narrow: one call per market, only while the market is open,
   * and never alongside a staked position on the same market. The last rule is
   * what keeps the record honest — a user who has money on an outcome would
   * otherwise be able to log a free call on the other side and harvest a clean
   * accuracy score either way.
   */
  async call(
    userId: string,
    marketId: string,
    outcomeId: string,
  ): Promise<{ id: string; probabilityAtCall: number }> {
    const market = await this.marketRepo.findOne({
      where: { id: marketId },
      relations: ["outcomes"],
    });
    if (!market) throw new NotFoundException("Market not found");
    if (market.status !== MarketStatus.OPEN) {
      throw new BadRequestException("This market is not open for calls");
    }

    const outcome = (market.outcomes ?? []).find((o) => o.id === outcomeId);
    if (!outcome) {
      throw new BadRequestException("That outcome is not on this market");
    }
    if (outcome.isEliminated) {
      throw new BadRequestException("That outcome is eliminated");
    }

    const staked = await this.positionRepo.count({
      where: { userId, marketId },
    });
    if (staked > 0) {
      throw new BadRequestException(
        "You already have a prediction staked on this market",
      );
    }

    // Captured now and never updated — it is the Brier input.
    const probabilityAtCall = Number(outcome.lmsrProbability);

    try {
      const row = await this.callRepo.save(
        this.callRepo.create({
          userId,
          marketId,
          outcomeId,
          probabilityAtCall,
          status: FreeCallStatus.PENDING,
        }),
      );
      return { id: row.id, probabilityAtCall };
    } catch (err: any) {
      if (err?.code === PG_UNIQUE_VIOLATION) {
        throw new BadRequestException("You have already called this market");
      }
      throw err;
    }
  }

  /** This user's calls, newest first. */
  async listMine(userId: string, limit = 50): Promise<FreeCall[]> {
    return this.callRepo.find({
      where: { userId },
      relations: ["market", "outcome"],
      order: { calledAt: "DESC" },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }

  /** This user's pending call on a market, if any — drives the button state. */
  async findMineForMarket(
    userId: string,
    marketId: string,
  ): Promise<FreeCall | null> {
    return this.callRepo.findOne({ where: { userId, marketId } });
  }

  /**
   * Score every pending call on a settled market.
   *
   * Called from the settlement path alongside reputation recalculation, and
   * idempotent: only PENDING rows are claimed, so a re-run scores nothing
   * twice. A cancelled or refunded market voids its calls instead of marking
   * everyone wrong — the question was never answered.
   */
  async resolveForMarket(
    marketId: string,
    winningOutcomeId: string | null,
  ): Promise<number> {
    const pending = await this.callRepo.find({
      where: { marketId, status: FreeCallStatus.PENDING },
    });
    if (pending.length === 0) return 0;

    const now = new Date();

    if (!winningOutcomeId) {
      await this.callRepo.update(
        { marketId, status: FreeCallStatus.PENDING },
        { status: FreeCallStatus.VOID, resolvedAt: now },
      );
      this.logger.log(
        `[FreeCalls] voided ${pending.length} call(s) on unresolved market ${marketId}`,
      );
      return pending.length;
    }

    const correctIds = pending
      .filter((c) => c.outcomeId === winningOutcomeId)
      .map((c) => c.id);
    const incorrectIds = pending
      .filter((c) => c.outcomeId !== winningOutcomeId)
      .map((c) => c.id);

    await this.dataSource.transaction(async (em) => {
      if (correctIds.length) {
        await em
          .getRepository(FreeCall)
          .update(
            { id: In(correctIds), status: FreeCallStatus.PENDING },
            { status: FreeCallStatus.CORRECT, resolvedAt: now },
          );
      }
      if (incorrectIds.length) {
        await em
          .getRepository(FreeCall)
          .update(
            { id: In(incorrectIds), status: FreeCallStatus.PENDING },
            { status: FreeCallStatus.INCORRECT, resolvedAt: now },
          );
      }
    });

    // Recompute each caller's aggregates from canonical history.
    const userIds = [...new Set(pending.map((c) => c.userId))];
    for (const userId of userIds) {
      await this.recalculateForUser(userId).catch((err: Error) =>
        this.logger.error(
          `[FreeCalls] recalc failed for ${userId}: ${err.message}`,
        ),
      );
    }

    this.logger.log(
      `[FreeCalls] scored ${pending.length} call(s) on market ${marketId} ` +
        `(${correctIds.length} correct) across ${userIds.length} user(s)`,
    );
    return pending.length;
  }

  /**
   * Recompute one user's free-call record from their scored calls.
   *
   * Derived, never incremented — the same discipline the reputation service
   * uses, so a double-scored settlement or a manual correction cannot drift the
   * aggregate away from the rows it summarises.
   */
  async recalculateForUser(userId: string): Promise<void> {
    const scored = await this.callRepo.find({
      where: {
        userId,
        status: In([FreeCallStatus.CORRECT, FreeCallStatus.INCORRECT]),
      },
      select: ["status", "probabilityAtCall"],
    });

    const freeCallCount = scored.length;
    const freeCallCorrect = scored.filter(
      (c) => c.status === FreeCallStatus.CORRECT,
    ).length;

    let freeCallBrierScore: number | null = null;
    if (freeCallCount > 0) {
      const sum = scored.reduce((acc, c) => {
        const p = Number(c.probabilityAtCall);
        const actual = c.status === FreeCallStatus.CORRECT ? 1 : 0;
        return acc + Math.pow(p - actual, 2);
      }, 0);
      freeCallBrierScore = parseFloat((sum / freeCallCount).toFixed(4));
    }

    await this.userRepo.update(userId, {
      freeCallCount,
      freeCallCorrect,
      freeCallBrierScore,
      freeCallBrierCount: freeCallCount,
    });
  }

  /**
   * Accuracy leaderboard for free callers, best calibration first.
   *
   * Ranked on Brier score, not hit rate. Hit rate rewards only ever calling
   * heavy favourites; Brier rewards being right *and* being right about how
   * confident to be, which is the skill the platform is actually trying to
   * teach.
   */
  async leaderboard(limit = 25): Promise<FreeCallLeaderboardEntry[]> {
    const users = await this.userRepo
      .createQueryBuilder("u")
      .select([
        "u.id",
        "u.username",
        "u.firstName",
        "u.freeCallCount",
        "u.freeCallCorrect",
        "u.freeCallBrierScore",
      ])
      .where("u.freeCallCount >= :min", { min: LEADERBOARD_MIN_CALLS })
      .andWhere("u.freeCallBrierScore IS NOT NULL")
      .orderBy("u.freeCallBrierScore", "ASC")
      .addOrderBy("u.freeCallCount", "DESC")
      .take(Math.min(Math.max(limit, 1), 100))
      .getMany();

    return users.map((u, i) => ({
      rank: i + 1,
      userId: u.id,
      name: u.firstName?.trim() || u.username || "Predictor",
      calls: u.freeCallCount,
      correct: u.freeCallCorrect,
      accuracy: u.freeCallCount
        ? parseFloat((u.freeCallCorrect / u.freeCallCount).toFixed(4))
        : 0,
      brierScore: Number(u.freeCallBrierScore),
    }));
  }

  /**
   * Safety net: score any pending call whose market has already finished.
   *
   * The settlement path scores calls immediately, but it is not the only way a
   * market reaches a terminal state — a cancellation, a thin-pool refund, or a
   * settlement that failed partway all leave calls pending. Rather than hooking
   * every one of those paths and hoping none is ever added, this reconciles
   * against the markets table, which is the actual source of truth.
   *
   * A market with no winning outcome voids its calls: the question was never
   * answered, so nobody was wrong.
   */
  @Cron("*/10 * * * *")
  async reconcilePendingCalls(): Promise<void> {
    const lock = await this.redis.acquireLock("cron:free-calls-reconcile", 300);
    if (!lock) return;
    try {
      const rows: { marketId: string }[] = await this.callRepo.query(
        `SELECT DISTINCT f."marketId"
           FROM "free_calls" f
           JOIN "markets" m ON m."id" = f."marketId"
          WHERE f."status" = 'pending'
            AND m."status" IN ('resolved', 'settled', 'cancelled')
          LIMIT 200`,
      );
      if (rows.length === 0) return;

      for (const { marketId } of rows) {
        const market = await this.marketRepo.findOne({
          where: { id: marketId },
          relations: ["outcomes"],
        });
        if (!market) continue;

        const winner =
          market.status === MarketStatus.CANCELLED
            ? null
            : ((market.outcomes ?? []).find((o) => o.isWinner)?.id ?? null);

        await this.resolveForMarket(marketId, winner).catch((err: Error) =>
          this.logger.error(
            `[FreeCalls] reconcile failed for market ${marketId}: ${err.message}`,
          ),
        );
      }

      this.logger.log(
        `[FreeCalls] reconciled pending calls on ${rows.length} finished market(s)`,
      );
    } finally {
      await this.redis.releaseLock("cron:free-calls-reconcile", lock);
    }
  }
}
