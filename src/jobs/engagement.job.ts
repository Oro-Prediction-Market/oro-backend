import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";
import {
  Repository,
  DataSource,
  Not,
  IsNull,
  MoreThan,
  Between,
} from "typeorm";
import { User } from "../entities/user.entity";
import { Transaction, TransactionType } from "../entities/transaction.entity";
import { Challenge, ChallengeStatus } from "../entities/challenge.entity";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";
import { RedisService } from "../redis/redis.service";

@Injectable()
export class EngagementJob {
  private readonly logger = new Logger(EngagementJob.name);

  constructor(
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectRepository(Challenge) private challengeRepo: Repository<Challenge>,
    @InjectDataSource() private dataSource: DataSource,
    private readonly telegram: TelegramSimpleService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Re-engagement cron — runs 3:00 AM UTC daily.
   * Finds users who went silent at exactly the 14 or 30-day mark and sends a DM.
   * Uses a 1-day window per milestone so each user is messaged exactly once.
   */
  @Cron("0 3 * * *")
  async reEngageLapsedUsers(): Promise<void> {
    const lock = await this.redis.acquireLock("cron:reengagement", 300);
    if (!lock) return;
    try {
      await Promise.all([this.messageWindow(14), this.messageWindow(30)]);
    } finally {
      await this.redis.releaseLock("cron:reengagement", lock);
    }
  }

  /**
   * Streak at-risk cron — runs 3:00 PM UTC daily (≈ 9 PM Bhutan time).
   * Warns users whose bet streak will break at midnight if they don't predict today.
   */
  @Cron("0 15 * * *")
  async warnStreakAtRisk(): Promise<void> {
    const lock = await this.redis.acquireLock("cron:streak-at-risk", 300);
    if (!lock) return;
    try {
      await this._warnStreakAtRisk();
    } finally {
      await this.redis.releaseLock("cron:streak-at-risk", lock);
    }
  }

  private async _warnStreakAtRisk(): Promise<void> {
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10); // "YYYY-MM-DD"

    const users = await this.userRepo.find({
      where: {
        betStreakLastAt: yesterdayStr as any,
        betStreakCount: MoreThan(0),
        telegramChatId: Not(IsNull()),
      },
      select: ["id", "telegramChatId", "firstName", "betStreakCount"],
    });

    if (users.length === 0) return;

    this.logger.log(`[StreakAtRisk] Notifying ${users.length} users`);

    for (const user of users) {
      try {
        const chatId = Number(user.telegramChatId);
        if (!chatId) continue;

        const name = user.firstName?.trim() || "Predictor";
        const streak = user.betStreakCount;

        const msg =
          `${name}, your <b>${streak}-day streak</b> breaks at midnight. ` +
          `One prediction keeps it alive — open Oro when you are ready.`;

        await this.telegram.sendMessage(chatId, msg);
      } catch (err: any) {
        this.logger.error(
          `[StreakAtRisk] Failed for user ${user.id}: ${err.message}`,
        );
      }
    }
  }

  private async messageWindow(daysMissed: number): Promise<void> {
    const now = new Date();

    // Use calendar-day boundaries (UTC midnight) so each user falls into
    // exactly ONE day's window regardless of what time the cron fires.
    const windowStart = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - daysMissed - 1,
      ),
    );
    const windowEnd = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - daysMissed,
      ),
    );

    const users = await this.userRepo.find({
      where: {
        lastActiveAt: Between(windowStart, windowEnd),
        telegramChatId: Not(IsNull()),
        totalPredictions: MoreThan(0),
      },
      select: ["id", "telegramChatId", "firstName", "reputationTier"],
    });

    if (users.length === 0) return;

    this.logger.log(
      `[ReEngagement] ${daysMissed}d lapsed — messaging ${users.length} users`,
    );

    for (const user of users) {
      try {
        const chatId = Number(user.telegramChatId);
        if (!chatId) continue;

        const name = user.firstName ?? "Predictor";
        const msg = this.buildMessage(name, daysMissed, user.reputationTier ?? null);

        await this.telegram.sendMessage(chatId, msg);
      } catch (err: any) {
        this.logger.error(
          `[ReEngagement] Failed for user ${user.id}: ${err.message}`,
        );
      }
    }
  }

  private buildMessage(
    name: string,
    daysMissed: number,
    tier: string | null,
  ): string {
    const tierLabel: Record<string, string> = {
      legend: "Legend",
      hot_hand: "Hot Hand",
      sharpshooter: "Sharpshooter",
      rookie: "Rookie",
    };
    const tierName = tierLabel[tier ?? ""] ?? null;
    const marketLine = "\n\nOpen Oro whenever you want to make your next call.";

    if (daysMissed === 14) {
      const lines = [
        `${name}, the leaderboard has moved while you were gone.${tierName ? ` Your <b>${tierName}</b> rank is on the line.` : ""} Two weeks is long enough — come back and reclaim your spot.${marketLine}`,
        `${name}, we saved your seat. 👀 It's been 2 weeks and the markets haven't stopped. Your record is still there — one prediction to get back in the game.${marketLine}`,
        `${name}, other predictors are on a streak right now. You built your reputation here — don't let two quiet weeks undo it.${marketLine}`,
      ];
      return lines[Math.floor(Math.random() * lines.length)];
    }

    // 30 days
    const lines = [
      `${name}, a whole month. The markets kept moving, the leaderboard kept shifting${tierName ? `, and your <b>${tierName}</b> title is gathering dust` : ""}. One prediction is all it takes to remind everyone you're still here.${marketLine}`,
      `${name}, we missed your calls. 🎯 It's been 30 days — long enough that people have forgotten your name on the leaderboard. Time to change that.${marketLine}`,
      `${name}, your Oro account has been quiet for a month. The community is predicting without you. Come back and show them what you've got.${marketLine}`,
    ];
    return lines[Math.floor(Math.random() * lines.length)];
  }

  /**
   * Duel expiry cron — runs every hour at :05.
   * Finds open challenges past their expiresAt deadline, marks them EXPIRED,
   * refunds the wager, and DMs the creator so they know to re-challenge.
   */
  @Cron("5 * * * *")
  async expireAndNotifyStaleDuels(): Promise<void> {
    const now = new Date();

    const stale = await this.challengeRepo
      .createQueryBuilder("c")
      .leftJoinAndSelect("c.market", "m")
      .leftJoinAndSelect("c.creator", "u")
      .where("c.status = :status", { status: ChallengeStatus.OPEN })
      .andWhere("c.expiresAt < :now", { now })
      .getMany();

    if (stale.length === 0) return;

    this.logger.log(`[DuelExpiry] Expiring ${stale.length} stale challenge(s)`);

    for (const ch of stale) {
      const wager = Number(ch.wagerAmount);

      // Atomically mark expired and refund wager in one transaction.
      // The conditional UPDATE acts as the idempotency guard — if two cron pods
      // race, only the first UPDATE's affected=1 proceeds; the second sees 0 and skips.
      let claimed = false;
      await this.dataSource.transaction(async (em) => {
        const result = await em.getRepository(Challenge).update(
          { id: ch.id, status: ChallengeStatus.OPEN },
          { status: ChallengeStatus.EXPIRED, settledAt: now },
        );
        if (!result.affected) return;
        claimed = true;

        if (wager > 0) {
          const { balance: rawBefore } = await em
            .getRepository(Transaction)
            .createQueryBuilder("t")
            .select("COALESCE(SUM(t.amount), 0)", "balance")
            .where("t.userId = :userId", { userId: ch.creatorId })
            .getRawOne();

          await em.save(
            em.create(Transaction, {
              type: TransactionType.REFUND,
              amount: wager,
              balanceBefore: Number(rawBefore),
              balanceAfter: Number(rawBefore) + wager,
              userId: ch.creatorId,
              note: `Duel expired refund — challenge ${ch.id}`,
            }),
          );
        }
      });

      if (!claimed) continue;

      // DM the creator
      const creator = ch.creator;
      if (creator?.telegramId) {
        const chatId = Number(creator.telegramId);
        const name = creator.firstName?.trim() || "Predictor";
        const marketTitle = ch.market?.title ?? "your market";
        const refundLine =
          wager > 0 ? ` Your Nu ${wager} wager has been refunded.` : "";

        await this.telegram
          .sendMessage(
            chatId,
            `⏱ <b>Your duel expired with no challenger.</b>${refundLine}\n\n` +
              `<b>${marketTitle}</b> is still open — want to challenge someone else?`,
          )
          .catch((err: Error) =>
            this.logger.warn(
              `[DuelExpiry] DM failed for user ${ch.creatorId}: ${err.message}`,
            ),
          );
      }
    }

    this.logger.log(
      `[DuelExpiry] Processed ${stale.length} expired challenge(s)`,
    );
  }
}
