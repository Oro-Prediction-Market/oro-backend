import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { User } from "../entities/user.entity";
import { Settlement } from "../entities/settlement.entity";
import { Position } from "../entities/position.entity";
import { Market } from "../entities/market.entity";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";

@Injectable()
export class WeeklyReportJob {
  private readonly logger = new Logger(WeeklyReportJob.name);

  constructor(
    @InjectDataSource() private dataSource: DataSource,
    private readonly telegram: TelegramSimpleService,
  ) {}

  /** Every Monday at 3:00 AM UTC (9:00 AM Bhutan time) */
  @Cron("0 3 * * 1")
  async sendWeeklyReport(): Promise<void> {
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setUTCDate(now.getUTCDate() - 7);
    weekStart.setUTCHours(0, 0, 0, 0);
    const weekEnd = new Date(now);
    weekEnd.setUTCHours(0, 0, 0, 0);

    const [revenue, users, activity] = await Promise.all([
      this.fetchRevenue(weekStart, weekEnd),
      this.fetchUsers(weekStart, weekEnd),
      this.fetchActivity(weekStart, weekEnd),
    ]);

    const message = this.buildMessage(weekStart, weekEnd, revenue, users, activity);

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

  // ── Data fetchers ───────────────────────────────────────────────────────────

  private async fetchRevenue(from: Date, to: Date) {
    const row = await this.dataSource
      .getRepository(Settlement)
      .createQueryBuilder("s")
      .select("COALESCE(SUM(s.houseAmount), 0)", "house")
      .addSelect("COALESCE(SUM(s.totalPool), 0)", "volume")
      .addSelect("COUNT(*)", "settled")
      .where("s.createdAt >= :from AND s.createdAt < :to", { from, to })
      .andWhere("s.cancelReason IS NULL")
      .getRawOne<{ house: string; volume: string; settled: string }>() ?? { house: "0", volume: "0", settled: "0" };

    // Top market by pool this week
    const top = await this.dataSource
      .getRepository(Market)
      .createQueryBuilder("m")
      .leftJoin(Settlement, "s", "s.marketId = m.id")
      .addSelect("m.title", "title")
      .addSelect("m.totalPool", "pool")
      .where("s.createdAt >= :from AND s.createdAt < :to", { from, to })
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

  private async fetchUsers(from: Date, to: Date) {
    const userRepo = this.dataSource.getRepository(User);

    const [newUsers, dkLinked] = await Promise.all([
      userRepo
        .createQueryBuilder("u")
        .where("u.createdAt >= :from AND u.createdAt < :to", { from, to })
        .getCount(),
      userRepo
        .createQueryBuilder("u")
        .where("u.createdAt >= :from AND u.createdAt < :to", { from, to })
        .andWhere("u.dkAccountNumber IS NOT NULL")
        .getCount(),
    ]);

    // New users who placed at least one bet this week
    const firstBetRow = await this.dataSource
      .getRepository(Position)
      .createQueryBuilder("p")
      .select("COUNT(DISTINCT p.userId)", "count")
      .innerJoin(User, "u", "u.id = p.userId")
      .where("u.createdAt >= :from AND u.createdAt < :to", { from, to })
      .andWhere("p.placedAt >= :from AND p.placedAt < :to", { from, to })
      .getRawOne<{ count: string }>() ?? { count: "0" };

    return {
      newUsers,
      dkLinked,
      firstBet: Number(firstBetRow.count),
    };
  }

  private async fetchActivity(from: Date, to: Date) {
    const [betsRow, uniqueRow] = await Promise.all([
      this.dataSource
        .getRepository(Position)
        .createQueryBuilder("p")
        .select("COUNT(*)", "total")
        .where("p.placedAt >= :from AND p.placedAt < :to", { from, to })
        .getRawOne<{ total: string }>()
        .then((r) => r ?? { total: "0" }),
      this.dataSource
        .getRepository(Position)
        .createQueryBuilder("p")
        .select("COUNT(DISTINCT p.userId)", "unique")
        .where("p.placedAt >= :from AND p.placedAt < :to", { from, to })
        .getRawOne<{ unique: string }>()
        .then((r) => r ?? { unique: "0" }),
    ]);

    return {
      bets: Number(betsRow.total),
      uniqueBettors: Number(uniqueRow.unique),
    };
  }

  // ── Message builder ─────────────────────────────────────────────────────────

  private buildMessage(
    from: Date,
    to: Date,
    revenue: Awaited<ReturnType<typeof this.fetchRevenue>>,
    users: Awaited<ReturnType<typeof this.fetchUsers>>,
    activity: Awaited<ReturnType<typeof this.fetchActivity>>,
  ): string {
    const fmt = (d: Date) =>
      d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

    const nu = (n: number) => `Nu ${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
    const pct = (n: number, d: number) =>
      d > 0 ? ` <i>(${Math.round((n / d) * 100)}%)</i>` : "";

    const topLine = revenue.topMarket
      ? `\n🏆 Top market · <b>${nu(revenue.topMarket.pool)}</b> · <i>${revenue.topMarket.title}</i>`
      : "";

    return (
      `📊 <b>Oro Weekly Report</b>\n` +
      `<i>${fmt(from)} – ${fmt(to)}</i>\n\n` +
      `━━━━━━━━━━━━━━━━━━━\n\n` +
      `💰 <b>Revenue</b>\n` +
      `🏦 House collected · <b>${nu(revenue.house)}</b>\n` +
      `📈 Pool volume · <b>${nu(revenue.volume)}</b>\n` +
      `✅ Markets settled · <b>${revenue.settled}</b>` +
      topLine + `\n\n` +
      `━━━━━━━━━━━━━━━━━━━\n\n` +
      `👥 <b>Users</b>\n` +
      `🆕 New sign-ups · <b>${users.newUsers}</b>\n` +
      `🔗 DK Bank linked · <b>${users.dkLinked}</b>${pct(users.dkLinked, users.newUsers)}\n` +
      `🎯 Placed first bet · <b>${users.firstBet}</b>${pct(users.firstBet, users.newUsers)}\n\n` +
      `━━━━━━━━━━━━━━━━━━━\n\n` +
      `📣 <b>Activity</b>\n` +
      `🗳 Predictions placed · <b>${activity.bets}</b>\n` +
      `👤 Unique predictors · <b>${activity.uniqueBettors}</b>\n\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `📅 <i>Auto-report · Oro Keeper</i>`
    );
  }
}
