import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";
import { Repository, DataSource } from "typeorm";
import { Season, SeasonStatus } from "../entities/season.entity";
import { User } from "../entities/user.entity";
import { Transaction, TransactionType } from "../entities/transaction.entity";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";

// Real-money prizes paid every month to the top-3 finishers.
// #1 → Nu 150, #2 → Nu 100, #3 → Nu 50
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

    // Snapshot top-10 leaderboard at close time — ranked by win rate within
    // this season's date range (min 3 predictions to qualify).
    const top10 = await this.userRepo
      .createQueryBuilder("u")
      .innerJoin(
        "positions",
        "p",
        `p."userId" = u.id AND p."placedAt" >= :startsAt AND p."placedAt" < :endsAt AND p.status IN ('won','lost')`,
        { startsAt: active.startsAt, endsAt: active.endsAt },
      )
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
      .addSelect("COUNT(p.id)", "seasonTotal")
      .addSelect(
        `SUM(CASE WHEN p.status = 'won' THEN 1 ELSE 0 END)`,
        "seasonWins",
      )
      .groupBy("u.id")
      .having("COUNT(p.id) >= 3")
      .orderBy(
        `SUM(CASE WHEN p.status = 'won' THEN 1 ELSE 0 END)::float / COUNT(p.id)`,
        "DESC",
      )
      .addOrderBy("COUNT(p.id)", "DESC")
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

    this.logger.log(
      `Season ${active.id} closed with ${snapshot.length} winners`,
    );

    // Credit top-3 prizes and send DMs (fire-and-forget so rollover isn't blocked)
    this.creditSeasonPrizes(top10.slice(0, 3), active).catch((err: Error) =>
      this.logger.error(`Season prize crediting failed: ${err.message}`),
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
    return new Date(Date.UTC(year, monthNumber - 1, 1)).toLocaleString(
      "en-US",
      {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      },
    );
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

    for (let i = 0; i < winners.length; i++) {
      const rank = i + 1;
      const prize = SEASON_PRIZES[rank];
      if (!prize) continue;

      const user = winners[i];
      const prizeNote = `${medals[i]} Season prize — ${currentMonthLabel} #${rank}`;

      await this.dataSource.transaction(async (em) => {
        // Idempotency guard — never double-credit the same rank in the same month
        const alreadyCredited = await em.getRepository(Transaction).count({
          where: {
            userId: user.id,
            type: TransactionType.SEASON_PRIZE,
            note: prizeNote,
          },
        });
        if (alreadyCredited > 0) {
          this.logger.warn(
            `Season prize already credited for user ${user.id} — skipping`,
          );
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
            type: TransactionType.SEASON_PRIZE,
            amount: prize,
            balanceBefore: Number(rawBefore),
            balanceAfter: Number(rawBefore) + prize,
            userId: user.id,
            isBonus: false,
            note: prizeNote,
          }),
        );

        this.logger.log(
          `Season prize: Nu ${prize} → user ${user.id} (#${rank} in ${currentMonthLabel})`,
        );
      });

      // DM the winner
      if (user.telegramId) {
        const chatId = Number(user.telegramId);
        const msg =
          `${medals[i]} <b>You finished #${rank} in ${currentMonthLabel}!</b>\n\n` +
          `<b>Nu ${prize}</b> has been added to your Oro wallet as a real-money prize.\n\n` +
          `You can withdraw it anytime. Keep predicting to defend your rank next month!`;

        await this.telegram
          .sendMessage(chatId, msg)
          .catch((err: Error) =>
            this.logger.warn(
              `Season DM failed for user ${user.id}: ${err.message}`,
            ),
          );
      }
    }
  }
}
