import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";
import { Repository, DataSource, LessThan } from "typeorm";
import { Season, SeasonStatus } from "../entities/season.entity";
import { User } from "../entities/user.entity";
import { Transaction, TransactionType } from "../entities/transaction.entity";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";

// Reference values used to calculate the consecutive season bonus.
// No prize is given for a single season finish — credits only unlock
// when a user places top-3 in back-to-back seasons.
const SEASON_PRIZES: Record<number, number> = { 1: 100, 2: 50, 3: 25 };

@Injectable()
export class SeasonService {
  private readonly logger = new Logger(SeasonService.name);

  constructor(
    @InjectRepository(Season) private seasonRepo: Repository<Season>,
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectDataSource() private dataSource: DataSource,
    private readonly telegram: TelegramSimpleService,
  ) {}

  /** Run every Monday at 00:05 UTC to close the previous week and open the next. */
  @Cron("5 0 * * 1")
  async rolloverSeason(): Promise<void> {
    this.logger.log("Rolling over weekly season…");
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
    // ISO week: Monday = start of week
    const startOfWeek = new Date(now);
    const day = startOfWeek.getUTCDay(); // 0=Sun
    const diff = day === 0 ? -6 : 1 - day; // Monday
    startOfWeek.setUTCDate(startOfWeek.getUTCDate() + diff);
    startOfWeek.setUTCHours(0, 0, 0, 0);

    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setUTCDate(endOfWeek.getUTCDate() + 7);

    // Get ISO week number
    const jan4 = new Date(Date.UTC(startOfWeek.getUTCFullYear(), 0, 4));
    const weekNumber =
      Math.ceil(
        ((startOfWeek.getTime() - jan4.getTime()) / 86400000 + jan4.getUTCDay() + 1) / 7,
      );

    const existing = await this.seasonRepo.findOne({
      where: { year: startOfWeek.getUTCFullYear(), weekNumber },
    });
    if (existing) return existing;

    const season = this.seasonRepo.create({
      weekNumber,
      year: startOfWeek.getUTCFullYear(),
      startsAt: startOfWeek,
      endsAt: endOfWeek,
      status: SeasonStatus.ACTIVE,
    });
    const saved = await this.seasonRepo.save(season);
    this.logger.log(`Season opened: week ${weekNumber}/${startOfWeek.getUTCFullYear()}`);
    return saved;
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
    const { weekNumber, year } = currentSeason;
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
      const currentPrizeRef = SEASON_PRIZES[rank];
      if (!currentPrizeRef) continue;

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
            `${medals[i]} <b>Week ${weekNumber} — you finished #${rank}!</b>\n\n` +
            `Great prediction this week. Place top 3 again next week to unlock your consecutive bonus. Keep it going!`;
          await this.telegram.sendMessage(chatId, msg).catch((err: Error) =>
            this.logger.warn(`Season DM failed for user ${user.id}: ${err.message}`),
          );
        }
        continue;
      }

      // Consecutive finish — credit the average of both weeks' reference prizes
      const prevPrizeRef = SEASON_PRIZES[prevRankEntry.rank] ?? 0;
      const bonus = Math.round((currentPrizeRef + prevPrizeRef) / 2);

      const bonusNote = `🔥 Consecutive season bonus — Week ${prevSeason!.weekNumber}/${prevSeason!.year} → Week ${weekNumber}/${year}`;
      await this.dataSource.transaction(async (em) => {
        const alreadyCredited = await em.getRepository(Transaction).count({
          where: { userId: user.id, type: TransactionType.FREE_CREDIT, note: bonusNote },
        });
        if (alreadyCredited > 0) {
          this.logger.warn(`Consecutive bonus already credited for user ${user.id} — skipping`);
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
            amount: bonus,
            balanceBefore: Number(rawBefore),
            balanceAfter: Number(rawBefore) + bonus,
            userId: user.id,
            isBonus: true,
            note: bonusNote,
          }),
        );

        await em
          .createQueryBuilder()
          .update(User)
          .set({
            bonusBalance: () => `"bonusBalance" + ${bonus}`,
            bonusRealPayoutRemaining: () => `GREATEST("bonusRealPayoutRemaining", 50)`,
          })
          .where("id = :userId", { userId: user.id })
          .execute();

        this.logger.log(
          `Consecutive bonus: Nu ${bonus} → user ${user.id} (prev #${prevRankEntry.rank} + curr #${rank})`,
        );
      });

      // DM the winner
      if (user.telegramId) {
        const chatId = Number(user.telegramId);
        const msg =
          `${medals[i]} 🔥 <b>Back-to-back top 3!</b>\n\n` +
          `You placed #${prevRankEntry.rank} last week and #${rank} this week — ` +
          `that earns you <b>Nu ${bonus}</b> in play credits ` +
          `(average of Nu ${prevPrizeRef} + Nu ${currentPrizeRef}).\n\n` +
          `Credits are in your Oro wallet. Can you make it three in a row?`;

        await this.telegram.sendMessage(chatId, msg).catch((err: Error) =>
          this.logger.warn(`Season DM failed for user ${user.id}: ${err.message}`),
        );
      }
    }
  }
}
