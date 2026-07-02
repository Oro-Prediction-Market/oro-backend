import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";
import { Repository, DataSource, LessThan } from "typeorm";
import { Season, SeasonStatus } from "../entities/season.entity";
import { User } from "../entities/user.entity";
import { Transaction, TransactionType } from "../entities/transaction.entity";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";
import { RedisService } from "../redis/redis.service";

// Real-money prizes paid every month to the top-3 finishers.
// #1 → Nu 700, #2 → Nu 500, #3 → Nu 350
const SEASON_PRIZES: Record<number, number> = { 1: 700, 2: 500, 3: 350 };

// ── Season leaderboard scoring ──────────────────────────────────────────────
// Ranking blends prediction skill with volume so the board rewards
// players who are both accurate AND active — not pure luck on a tiny sample.
//
//   score = SKILL_WEIGHT * winRate + VOLUME_WEIGHT * volNorm
//
// winRate is 0..1 (wins / resolved picks). volNorm is the user's volume
// log-compressed and normalized to the top qualifier (0..1), so a whale can't
// run away with the board — doubling an already-large stake barely moves it.
// Only real-money (non-bonus) resolved picks count toward volume.
// Tune the weights here; they must sum to 1.
const SEASON_MIN_PICKS = 15;
const SEASON_SKILL_WEIGHT = 0.6;
const SEASON_VOLUME_WEIGHT = 0.4;

@Injectable()
export class SeasonService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SeasonService.name);

  constructor(
    @InjectRepository(Season) private seasonRepo: Repository<Season>,
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectDataSource() private dataSource: DataSource,
    private readonly telegram: TelegramSimpleService,
    private readonly redis: RedisService,
  ) {}

  /** Self-heal: if the cron missed a rollover (e.g. pod down on the 1st), catch up on startup. */
  async onApplicationBootstrap(): Promise<void> {
    const overdue = await this.seasonRepo.findOne({
      where: { status: SeasonStatus.ACTIVE, endsAt: LessThan(new Date()) },
    });
    if (overdue) {
      this.logger.warn(`Season ${overdue.id} past its endsAt — running missed rollover`);
      await this.closeActiveSeason();
      await this.openNewSeason();
    } else {
      // Ensure a season exists for the current month even if none is active yet
      await this.openNewSeason();
    }
  }

  /** Run on the 1st of each month at 00:05 UTC to close the previous month and open the next. */
  @Cron("5 0 1 * *")
  async rolloverSeason(): Promise<void> {
    // Single-leader guard: the app runs multiple replicas, each with its own
    // scheduler. Without this, every replica would close the season AND credit
    // top-3 prizes — risking duplicate payouts. The lock key is month-specific
    // and intentionally NOT released: the first replica to win runs the rollover,
    // the rest skip, and the key expires long before next month's tick.
    const monthKey = new Date().toISOString().slice(0, 7); // "YYYY-MM"
    const lock = await this.redis.acquireLock(
      `cron:season-rollover:${monthKey}`,
      6 * 3600,
    );
    if (!lock) {
      this.logger.log(
        "[Season] Another replica already holds the rollover lock — skipping",
      );
      return;
    }

    this.logger.log("Rolling over monthly season…");
    await this.closeActiveSeason();
    await this.openNewSeason();
  }

  async closeActiveSeason(): Promise<void> {
    const active = await this.seasonRepo.findOne({
      where: { status: SeasonStatus.ACTIVE },
    });
    if (!active) return;

    // Pull every qualifier (≥ SEASON_MIN_PICKS resolved picks this season) with
    // its wins and real-money volume, then rank by the blended skill+volume
    // score in JS (volume normalization needs the cohort's max, so we can't just
    // ORDER BY in SQL). Use getRawAndEntities so aggregates ride alongside the
    // User entities we later hand to prize crediting.
    const { entities: qualifierUsers, raw: qualifierRaw } = await this.userRepo
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
      ])
      .addSelect("COUNT(p.id)", "seasonTotal")
      .addSelect(
        `SUM(CASE WHEN p.status = 'won' THEN 1 ELSE 0 END)`,
        "seasonWins",
      )
      // Real-money volume only — bonus-funded (free-credit) bets are excluded so
      // the board can't be inflated with free stakes.
      .addSelect(
        `COALESCE(SUM(CASE WHEN p."isBonusFunded" = false THEN p.amount ELSE 0 END), 0)`,
        "seasonVolume",
      )
      .groupBy("u.id")
      .having("COUNT(p.id) >= :minPicks", { minPicks: SEASON_MIN_PICKS })
      .getRawAndEntities();

    // Zip entities with their aggregates and derive win rate + volume.
    const rows = qualifierUsers.map((user, i) => {
      const raw = qualifierRaw[i];
      const total = Number(raw?.seasonTotal ?? 0);
      const wins = Number(raw?.seasonWins ?? 0);
      const volume = Number(raw?.seasonVolume ?? 0);
      return { user, total, wins, volume, winRate: total > 0 ? wins / total : 0 };
    });

    // Log-compress + normalize volume to the top qualifier, then blend.
    const maxVolume = rows.reduce((m, r) => Math.max(m, r.volume), 0);
    const scored = rows
      .map((r) => ({
        ...r,
        score:
          SEASON_SKILL_WEIGHT * r.winRate +
          SEASON_VOLUME_WEIGHT *
            (maxVolume > 0 ? Math.log1p(r.volume) / Math.log1p(maxVolume) : 0),
      }))
      // Rank by blended score; break ties on raw win rate, then volume.
      .sort(
        (a, b) =>
          b.score - a.score || b.winRate - a.winRate || b.volume - a.volume,
      );

    const top10 = scored.slice(0, 10);

    const snapshot = top10.map((r, i) => ({
      rank: i + 1,
      userId: r.user.id,
      firstName: r.user.firstName,
      username: r.user.username,
      reputationScore: r.user.reputationScore,
      reputationTier: r.user.reputationTier,
      winRate: r.total > 0 ? Math.round(r.winRate * 100) : 0,
      volume: Math.round(r.volume),
      score: Math.round(r.score * 10000) / 10000,
    }));
    await this.seasonRepo.update(active.id, {
      status: SeasonStatus.CLOSED,
      winnersSnapshot: snapshot as any,
    });

    this.logger.log(
      `Season ${active.id} closed with ${snapshot.length} winners`,
    );

    // Credit top-3 prizes and send DMs (fire-and-forget so rollover isn't blocked)
    this.creditSeasonPrizes(
      top10.slice(0, 3).map((r) => r.user),
      active,
    ).catch((err: Error) =>
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
