import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";
import { Repository, DataSource, LessThan } from "typeorm";
import { Season, SeasonStatus } from "../entities/season.entity";
import { User } from "../entities/user.entity";
import { Transaction, TransactionType } from "../entities/transaction.entity";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";

// Real-money prizes for back-to-back top-3 finishes.
// No prize for a single month finish — only consecutive months unlock the reward.
const SEASON_PRIZES: Record<number, number> = { 1: 150, 2: 100, 3: 50 };

@Injectable()
export class SeasonService {
  private readonly logger = new Logger(SeasonService.name);

  constructor(
    @InjectRepository(Season) private seasonRepo: Repository<Season>,
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectDataSource() private dataSource: DataSource,
    private readonly telegram: TelegramSimpleService,
  ) {}

  /** Run on the 1st of each month at 00:05 UTC to close the previous month and open the next. */
  @Cron("5 0 1 * *")
  async rolloverSeason(): Promise<void> {
    this.logger.log("Rolling over monthly season…");
    await this.closeActiveSeason();
    await this.openNewSeason();
  }

  async closeActiveSeason(): Promise<void> {
    const active = await this.seasonRepo.findOne({
      where: { status: SeasonStatus.ACTIVE },
    });
    if (!active) return;

    // Snapshot top-10 leaderboard at close time
    const top10 = await this.userRepo
      .createQueryBuilder("u")
      .select([
        "u.id",
        "u.firstName",
        "u.lastName",
        "u.username",
        "u.telegramId",
        "u.reputationScore",
        "u.reputationTier",
        "u.totalPredictions",
        "u.correctPredictions",
      ])
      .where("u.totalPredictions > 0")
      .orderBy("u.reputationScore", "DESC", "NULLS LAST")
      .addOrderBy("u.correctPredictions", "DESC")
      .limit(10)
      .getMany();

    const snapshot = top10.map((u, i) => ({
      rank: i + 1,
      userId: u.id,
      firstName: u.firstName,
      username: u.username,
      reputationScore: u.reputationScore,
      reputationTier: u.reputationTier,
      winRate:
        u.totalPredictions > 0
          ? Math.round((u.correctPredictions / u.totalPredictions) * 100)
          : 0,
    }));

    await this.seasonRepo.update(active.id, {
      status: SeasonStatus.CLOSED,
      winnersSnapshot: snapshot as any,
    });

    this.logger.log(`Season ${active.id} closed with ${snapshot.length} winners`);

    // Credit top-3 prizes and send DMs (fire-and-forget so rollover isn't blocked)
    this.creditSeasonPrizes(top10.slice(0, 3), active).catch(
      (err: Error) => this.logger.error(`Season prize crediting failed: ${err.message}`),
    );
  }

  async openNewSeason(): Promise<Season> {
    const now = new Date();
    const year = now.getUTCFullYear();
    const monthNumber = now.getUTCMonth() + 1; // 1–12

    const startsAt = new Date(Date.UTC(year, monthNumber - 1, 1));
    const endsAt = new Date(Date.UTC(year, monthNumber, 1)); // first of next month

    const existing = await this.seasonRepo.findOne({
      where: { year, weekNumber: monthNumber },
    });
    if (existing) return existing;

    const season = this.seasonRepo.create({
      weekNumber: monthNumber,
      year,
      startsAt,
      endsAt,
      status: SeasonStatus.ACTIVE,
    });
    const saved = await this.seasonRepo.save(season);
    this.logger.log(`Season opened: ${this.monthLabel(monthNumber, year)}`);
    return saved;
  }

  private monthLabel(monthNumber: number, year: number): string {
    return new Date(Date.UTC(year, monthNumber - 1, 1)).toLocaleString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  }

  async getCurrentSeason(): Promise<Season | null> {
    return this.seasonRepo.findOne({ where: { status: SeasonStatus.ACTIVE } });
  }

  async getSeasonHistory(limit = 10): Promise<Season[]> {
    return this.seasonRepo.find({
      where: { status: SeasonStatus.CLOSED },
      order: { startsAt: "DESC" },
      take: limit,
    });
  }

  private async creditSeasonPrizes(
    winners: User[],
    currentSeason: Season,
  ): Promise<void> {
    const { weekNumber: monthNumber, year } = currentSeason;
    const currentMonthLabel = this.monthLabel(monthNumber, year);
    const medals = ["🥇", "🥈", "🥉"];

    // Find the season that closed immediately before this one
    const prevSeason = await this.seasonRepo.findOne({
      where: {
        status: SeasonStatus.CLOSED,
        startsAt: LessThan(currentSeason.startsAt),
      },
      order: { startsAt: "DESC" },
    });

    for (let i = 0; i < winners.length; i++) {
      const rank = i + 1;
      const prize = SEASON_PRIZES[rank];
      if (!prize) continue;

      const user = winners[i];

      // Only reward if the user also placed top-3 in the previous season
      const prevRankEntry = prevSeason?.winnersSnapshot?.find(
        (e) => e.userId === user.id && e.rank >= 1 && e.rank <= 3,
      );

      if (!prevRankEntry) {
        // First-time or non-consecutive finish — no credit, but DM to encourage them
        if (user.telegramId) {
          const chatId = Number(user.telegramId);
          const msg =
            `${medals[i]} <b>${currentMonthLabel} — you finished #${rank}!</b>\n\n` +
            `Great prediction this month. Place top 3 again next month to unlock your consecutive bonus. Keep it going!`;
          await this.telegram.sendMessage(chatId, msg).catch((err: Error) =>
            this.logger.warn(`Season DM failed for user ${user.id}: ${err.message}`),
          );
        }
        continue;
      }

      // Consecutive finish — credit the fixed real-money prize for their current rank
      const prevMonthLabel = this.monthLabel(prevSeason!.weekNumber, prevSeason!.year);

      const prizeNote = `🔥 Consecutive season prize — ${prevMonthLabel} → ${currentMonthLabel}`;
      await this.dataSource.transaction(async (em) => {
        const alreadyCredited = await em.getRepository(Transaction).count({
          where: { userId: user.id, type: TransactionType.FREE_CREDIT, note: prizeNote },
        });
        if (alreadyCredited > 0) {
          this.logger.warn(`Consecutive prize already credited for user ${user.id} — skipping`);
          return;
        }

        const { balance: rawBefore } = await em
          .getRepository(Transaction)
          .createQueryBuilder("t")
          .select("COALESCE(SUM(t.amount), 0)", "balance")
          .where("t.userId = :userId", { userId: user.id })
          .getRawOne();

        await em.save(
          em.create(Transaction, {
            type: TransactionType.FREE_CREDIT,
            amount: prize,
            balanceBefore: Number(rawBefore),
            balanceAfter: Number(rawBefore) + prize,
            userId: user.id,
            isBonus: false,
            note: prizeNote,
          }),
        );

        this.logger.log(
          `Consecutive prize: Nu ${prize} → user ${user.id} (prev #${prevRankEntry.rank} + curr #${rank})`,
        );
      });

      // DM the winner
      if (user.telegramId) {
        const chatId = Number(user.telegramId);
        const msg =
          `${medals[i]} 🔥 <b>Back-to-back top 3!</b>\n\n` +
          `You placed #${prevRankEntry.rank} in ${prevMonthLabel} and #${rank} in ${currentMonthLabel} — ` +
          `that earns you <b>Nu ${prize}</b> in real credits.\n\n` +
          `The prize is in your Oro wallet and can be withdrawn. Can you make it three months in a row?`;

        await this.telegram.sendMessage(chatId, msg).catch((err: Error) =>
          this.logger.warn(`Season DM failed for user ${user.id}: ${err.message}`),
        );
      }
    }
  }
}
