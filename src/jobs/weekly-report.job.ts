import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { User } from "../entities/user.entity";
import { Settlement } from "../entities/settlement.entity";
import { Position, PositionStatus } from "../entities/position.entity";
import { Market } from "../entities/market.entity";
import { Transaction, TransactionType } from "../entities/transaction.entity";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";
import { RedisService } from "../redis/redis.service";

interface ProviderCounts {
  [provider: string]: number;
}

interface CategoryCounts {
  [category: string]: number;
}

@Injectable()
export class WeeklyReportJob {
  private readonly logger = new Logger(WeeklyReportJob.name);

  constructor(
    @InjectDataSource() private dataSource: DataSource,
    private readonly telegram: TelegramSimpleService,
    private readonly redis: RedisService,
  ) {}

  /** Every Monday at 3:00 AM UTC (9:00 AM Bhutan time) */
  @Cron("0 3 * * 1")
  async sendWeeklyReport(): Promise<void> {
    // Single-leader guard: the app runs multiple instances, each with its own
    // scheduler, so without this every instance would send the report. The lock
    // key is week-specific and intentionally NOT released — the first instance
    // to win sends, the rest skip, and the key expires before next Monday.
    const weekKey = new Date().toISOString().slice(0, 10); // Monday's UTC date
    const lock = await this.redis.acquireLock(
      `cron:weekly-report:${weekKey}`,
      6 * 3600,
    );
    if (!lock) {
      this.logger.log(
        "[WeeklyReport] Another instance already holds the lock — skipping",
      );
      return;
    }

    try {
      await this._sendWeeklyReport();
    } catch (err: any) {
      this.logger.error(`[WeeklyReport] Unhandled error: ${err.message}`, err.stack);
    }
  }

  private async _sendWeeklyReport(): Promise<void> {
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setUTCDate(now.getUTCDate() - 7);
    weekStart.setUTCHours(0, 0, 0, 0);
    const weekEnd = new Date(now);
    weekEnd.setUTCHours(0, 0, 0, 0);

    const [growth, revenue, moneyFlow, gameplay, escrow, winners] =
      await Promise.all([
        this.fetchGrowth(weekStart, weekEnd),
        this.fetchRevenue(weekStart, weekEnd),
        this.fetchMoneyFlow(weekStart, weekEnd),
        this.fetchGameplay(weekStart, weekEnd),
        this.fetchEscrow(),
        this.fetchWinners(weekStart, weekEnd),
      ]);

    const message = this.buildMessage(weekStart, weekEnd, {
      growth,
      revenue,
      moneyFlow,
      gameplay,
      escrow,
      winners,
    });

    // Send to every admin with a linked Telegram account
    const admins = await this.dataSource.getRepository(User).find({
      where: { isAdmin: true },
      select: ["id", "telegramId", "firstName"],
    });

    const eligible = admins.filter((a) => !!a.telegramId);
    if (eligible.length === 0) {
      this.logger.warn("[WeeklyReport] No admin with telegramId found — skipping");
      return;
    }

    for (const admin of eligible) {
      try {
        await this.telegram.sendMessage(Number(admin.telegramId), message);
        this.logger.log(`[WeeklyReport] Sent to admin ${admin.id}`);
      } catch (err: any) {
        this.logger.error(`[WeeklyReport] Failed for admin ${admin.id}: ${err.message}`);
      }
    }
  }

  // ── Data fetchers ─────────────────────────────────────────────────────────

  private async fetchGrowth(
    from: Date,
    to: Date,
  ): Promise<{
    newUsers: number;
    byProvider: ProviderCounts;
    viaReferral: number;
    activePlayers: number;
  }> {
    const [totalRow, byProviderRows, referralRow, activeRow] =
      await Promise.all([
        this.dataSource
          .getRepository(User)
          .createQueryBuilder("u")
          .where("u.createdAt >= :from AND u.createdAt < :to", { from, to })
          .getCount(),
        this.dataSource.query(
          `SELECT provider, COUNT(*)::int AS count FROM (
             SELECT DISTINCT ON (u.id) u.id, am.provider
             FROM users u
             JOIN auth_methods am ON am."userId" = u.id
             WHERE u."createdAt" >= $1 AND u."createdAt" < $2
             ORDER BY u.id, am."createdAt" ASC
           ) t
           GROUP BY provider`,
          [from, to],
        ),
        this.dataSource
          .getRepository(User)
          .createQueryBuilder("u")
          .where("u.createdAt >= :from AND u.createdAt < :to", { from, to })
          .andWhere("u.referredByUserId IS NOT NULL")
          .getCount(),
        this.dataSource
          .getRepository(Position)
          .createQueryBuilder("p")
          .select("COUNT(DISTINCT p.userId)", "count")
          .where("p.placedAt >= :from AND p.placedAt < :to", { from, to })
          .getRawOne<{ count: string }>(),
      ]);

    const byProvider: ProviderCounts = {};
    for (const row of byProviderRows as { provider: string; count: number }[]) {
      byProvider[row.provider] = row.count;
    }

    return {
      newUsers: totalRow,
      byProvider,
      viaReferral: referralRow,
      activePlayers: Number(activeRow?.count ?? 0),
    };
  }

  private async fetchRevenue(from: Date, to: Date) {
    const row =
      (await this.dataSource
        .getRepository(Settlement)
        .createQueryBuilder("s")
        .select("COALESCE(SUM(s.houseAmount), 0)", "house")
        .addSelect("COALESCE(SUM(s.totalPool), 0)", "volume")
        .addSelect("COUNT(*)", "settled")
        .where("s.settledAt >= :from AND s.settledAt < :to", { from, to })
        .andWhere("s.cancelReason IS NULL")
        .getRawOne<{ house: string; volume: string; settled: string }>()) ?? {
        house: "0",
        volume: "0",
        settled: "0",
      };

    // Top market by pool this week
    const top = await this.dataSource
      .getRepository(Market)
      .createQueryBuilder("m")
      .leftJoin(Settlement, "s", "s.marketId = m.id")
      .addSelect("m.title", "title")
      .addSelect("m.totalPool", "pool")
      .where("s.settledAt >= :from AND s.settledAt < :to", { from, to })
      .andWhere("s.cancelReason IS NULL")
      .orderBy("m.totalPool", "DESC")
      .limit(1)
      .getRawOne<{ title: string; pool: string }>();

    return {
      house: Number(row.house),
      volume: Number(row.volume),
      settled: Number(row.settled),
      topMarket: top ? { title: top.title, pool: Number(top.pool) } : null,
    };
  }

  /**
   * Ledger movements, BTN book only — mixing it with the USDT book would fold
   * two different currencies into one number (see `Transaction.currency`).
   */
  private async fetchMoneyFlow(from: Date, to: Date) {
    const sums = async (type: TransactionType) => {
      const row = await this.dataSource
        .getRepository(Transaction)
        .createQueryBuilder("t")
        .select("COALESCE(SUM(ABS(t.amount)), 0)", "sum")
        .addSelect("COUNT(*)", "count")
        .where("t.type = :type", { type })
        .andWhere("t.currency = :currency", { currency: "BTN" })
        .andWhere("t.createdAt >= :from AND t.createdAt < :to", { from, to })
        .getRawOne<{ sum: string; count: string }>();
      return { sum: Number(row?.sum ?? 0), count: Number(row?.count ?? 0) };
    };

    const [deposits, withdrawals] = await Promise.all([
      sums(TransactionType.DEPOSIT),
      sums(TransactionType.WITHDRAWAL),
    ]);

    return { deposits, withdrawals };
  }

  /**
   * Oro has no per-market creation fee (the only fee is the house edge taken
   * at settlement, already reported under Revenue) and no TIMED/SIZED/CREATOR
   * market types — those lines from the template are replaced with a
   * created-by-category breakdown, the closest real analogue in Oro's schema.
   */
  private async fetchGameplay(from: Date, to: Date) {
    const placedRow = await this.dataSource
      .getRepository(Position)
      .createQueryBuilder("p")
      .select("COUNT(*)", "count")
      .addSelect("COALESCE(SUM(p.amount), 0)", "sum")
      .where("p.placedAt >= :from AND p.placedAt < :to", { from, to })
      .getRawOne<{ count: string; sum: string }>();

    const settledRow = await this.dataSource
      .getRepository(Position)
      .createQueryBuilder("p")
      .innerJoin(Settlement, "s", "s.marketId = p.marketId")
      .select("COUNT(*)", "count")
      .addSelect("COALESCE(SUM(p.amount), 0)", "sum")
      .where("s.settledAt >= :from AND s.settledAt < :to", { from, to })
      .andWhere("s.cancelReason IS NULL")
      .andWhere("p.status IN (:...statuses)", {
        statuses: [PositionStatus.WON, PositionStatus.LOST],
      })
      .getRawOne<{ count: string; sum: string }>();

    const refundRow = await this.dataSource
      .getRepository(Transaction)
      .createQueryBuilder("t")
      .select("COUNT(*)", "count")
      .addSelect("COALESCE(SUM(ABS(t.amount)), 0)", "sum")
      .where("t.type = :type", { type: TransactionType.REFUND })
      .andWhere("t.currency = :currency", { currency: "BTN" })
      .andWhere("t.createdAt >= :from AND t.createdAt < :to", { from, to })
      .getRawOne<{ count: string; sum: string }>();

    const escrowThisWeekRow = await this.dataSource
      .getRepository(Position)
      .createQueryBuilder("p")
      .select("COUNT(*)", "count")
      .addSelect("COALESCE(SUM(p.amount), 0)", "sum")
      .where("p.status = :status", { status: PositionStatus.PENDING })
      .andWhere("p.placedAt >= :from AND p.placedAt < :to", { from, to })
      .getRawOne<{ count: string; sum: string }>();

    const marketsCreatedRows = await this.dataSource
      .getRepository(Market)
      .createQueryBuilder("m")
      .select("m.category", "category")
      .addSelect("COUNT(*)", "count")
      .where("m.createdAt >= :from AND m.createdAt < :to", { from, to })
      .groupBy("m.category")
      .getRawMany<{ category: string; count: string }>();

    const marketsCreated: CategoryCounts = {};
    for (const row of marketsCreatedRows) {
      marketsCreated[row.category] = Number(row.count);
    }

    // Cancelled settlements always carry totalPaidOut = 0 — a cancelled
    // market's stakes are returned per-position via refundPositions, not
    // recorded on the settlement row — so the refunded amount has to be
    // summed from the refunded positions themselves.
    const resolvedRow = await this.dataSource
      .getRepository(Settlement)
      .createQueryBuilder("s")
      .leftJoin(
        Position,
        "p",
        "p.marketId = s.marketId AND p.status = :refundedStatus",
        { refundedStatus: PositionStatus.REFUNDED },
      )
      .select("COUNT(DISTINCT s.id) FILTER (WHERE s.cancelReason IS NULL)", "completed")
      .addSelect(
        "COUNT(DISTINCT s.id) FILTER (WHERE s.cancelReason IS NOT NULL)",
        "cancelled",
      )
      .addSelect(
        "COALESCE(SUM(p.amount) FILTER (WHERE s.cancelReason IS NOT NULL), 0)",
        "refunded",
      )
      .where("s.settledAt >= :from AND s.settledAt < :to", { from, to })
      .getRawOne<{ completed: string; cancelled: string; refunded: string }>();

    return {
      placed: { count: Number(placedRow?.count ?? 0), sum: Number(placedRow?.sum ?? 0) },
      settled: { count: Number(settledRow?.count ?? 0), sum: Number(settledRow?.sum ?? 0) },
      refunded: { count: Number(refundRow?.count ?? 0), sum: Number(refundRow?.sum ?? 0) },
      inEscrowThisWeek: {
        count: Number(escrowThisWeekRow?.count ?? 0),
        sum: Number(escrowThisWeekRow?.sum ?? 0),
      },
      marketsCreated,
      resolved: {
        completed: Number(resolvedRow?.completed ?? 0),
        cancelled: Number(resolvedRow?.cancelled ?? 0),
        refunded: Number(resolvedRow?.refunded ?? 0),
      },
    };
  }

  /** All-time open exposure — how much is sitting in markets that haven't settled yet. */
  private async fetchEscrow() {
    const row = await this.dataSource
      .getRepository(Position)
      .createQueryBuilder("p")
      .select("COUNT(*)", "positions")
      .addSelect("COUNT(DISTINCT p.marketId)", "markets")
      .addSelect("COALESCE(SUM(p.amount), 0)", "sum")
      .where("p.status = :status", { status: PositionStatus.PENDING })
      .getRawOne<{ positions: string; markets: string; sum: string }>();

    return {
      sum: Number(row?.sum ?? 0),
      positions: Number(row?.positions ?? 0),
      markets: Number(row?.markets ?? 0),
    };
  }

  private async fetchWinners(from: Date, to: Date) {
    const wonRow = await this.dataSource
      .getRepository(Position)
      .createQueryBuilder("p")
      .innerJoin(Settlement, "s", "s.marketId = p.marketId")
      .select("COUNT(*)", "count")
      .addSelect("COALESCE(SUM(p.payout), 0)", "gross")
      .where("s.settledAt >= :from AND s.settledAt < :to", { from, to })
      .andWhere("s.cancelReason IS NULL")
      .andWhere("p.status = :status", { status: PositionStatus.WON })
      .getRawOne<{ count: string; gross: string }>();

    const payoutRow = await this.dataSource
      .getRepository(Transaction)
      .createQueryBuilder("t")
      .select("COUNT(*)", "count")
      .addSelect("COALESCE(SUM(ABS(t.amount)), 0)", "sum")
      .where("t.type = :type", { type: TransactionType.POSITION_PAYOUT })
      .andWhere("t.currency = :currency", { currency: "BTN" })
      .andWhere("t.createdAt >= :from AND t.createdAt < :to", { from, to })
      .getRawOne<{ count: string; sum: string }>();

    return {
      winners: Number(wonRow?.count ?? 0),
      grossPrize: Number(wonRow?.gross ?? 0),
      netPayout: Number(payoutRow?.sum ?? 0),
      payoutsSent: Number(payoutRow?.count ?? 0),
    };
  }

  // ── Message builder ─────────────────────────────────────────────────────────

  private buildMessage(
    from: Date,
    to: Date,
    data: {
      growth: Awaited<ReturnType<WeeklyReportJob["fetchGrowth"]>>;
      revenue: Awaited<ReturnType<WeeklyReportJob["fetchRevenue"]>>;
      moneyFlow: Awaited<ReturnType<WeeklyReportJob["fetchMoneyFlow"]>>;
      gameplay: Awaited<ReturnType<WeeklyReportJob["fetchGameplay"]>>;
      escrow: Awaited<ReturnType<WeeklyReportJob["fetchEscrow"]>>;
      winners: Awaited<ReturnType<WeeklyReportJob["fetchWinners"]>>;
    },
  ): string {
    const { growth, revenue, moneyFlow, gameplay, escrow, winners } = data;
    const displayEnd = new Date(to.getTime() - 24 * 3600 * 1000);
    const fmt = (d: Date) =>
      d.toLocaleDateString("en-CA", { timeZone: "Asia/Thimphu" }); // YYYY-MM-DD

    const nu = (n: number) =>
      `Nu. ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const providerLine =
      Object.entries(growth.byProvider)
        .filter(([, count]) => count > 0)
        .map(([provider, count]) => `${provider[0].toUpperCase()}${provider.slice(1)}: ${count}`)
        .join(" | ") || "none";

    const categoryLine =
      Object.entries(gameplay.marketsCreated)
        .filter(([, count]) => count > 0)
        .map(([category, count]) => `${category[0].toUpperCase()}${category.slice(1)}: ${count}`)
        .join(" | ") || "none";

    const topLine = revenue.topMarket
      ? `\nTop market: ${nu(revenue.topMarket.pool)} — ${revenue.topMarket.title}`
      : "";

    return (
      `📅 Oro Weekly Report\n` +
      `${fmt(from)} to ${fmt(displayEnd)} | Asia/Thimphu\n\n` +
      `👥 Growth\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `New Users: ${growth.newUsers}\n` +
      `  ${providerLine}\n` +
      `  Via Referral: ${growth.viaReferral}\n` +
      `Active Players: ${growth.activePlayers}\n\n` +
      `💰 Revenue\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `Total Platform Fee: ${nu(revenue.house)} (${revenue.settled} settlements)\n` +
      `Pool Volume: ${nu(revenue.volume)}` +
      topLine + `\n\n` +
      `🏦 Money Flow\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📥 Deposits: ${nu(moneyFlow.deposits.sum)} (${moneyFlow.deposits.count} txns)\n` +
      `📤 Withdrawals: ${nu(moneyFlow.withdrawals.sum)} (${moneyFlow.withdrawals.count} txns)\n\n` +
      `🎫 Predictions\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `Predictions Placed: ${gameplay.placed.count} (${nu(gameplay.placed.sum)})\n` +
      `  ↳ Settled: ${nu(gameplay.settled.sum)} (${gameplay.settled.count})\n` +
      `  ↳ Refunded: ${nu(gameplay.refunded.sum)} (${gameplay.refunded.count})\n` +
      `  ↳ In escrow: ${nu(gameplay.inEscrowThisWeek.sum)} (${gameplay.inEscrowThisWeek.count})\n` +
      `Markets Created: ${categoryLine}\n` +
      `Markets Resolved: Completed ${gameplay.resolved.completed} | Cancelled ${gameplay.resolved.cancelled} (${nu(gameplay.resolved.refunded)} refunded)\n\n` +
      `🔒 Escrow\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `Held in Open Markets: ${nu(escrow.sum)} (all time)\n` +
      `  Across ${escrow.markets} markets | ${escrow.positions} entries\n` +
      `  This week's entries only: ${nu(gameplay.inEscrowThisWeek.sum)}\n\n` +
      `🏆 Winners\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `Winners: ${winners.winners}\n` +
      `Gross Prize: ${nu(winners.grossPrize)}\n` +
      `Net Payout: ${nu(winners.netPayout)}\n` +
      `Payout Completion: ${winners.payoutsSent}/${winners.winners}`
    );
  }
}
