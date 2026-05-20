import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";
import { Repository, DataSource, Not, IsNull, MoreThan, Between, LessThan } from "typeorm";
import { User } from "../entities/user.entity";
import { Market, MarketStatus } from "../entities/market.entity";
import { Transaction, TransactionType } from "../entities/transaction.entity";
import { Challenge, ChallengeStatus } from "../entities/challenge.entity";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";

// Credits sent to lapsed users at each inactivity milestone
const REENGAGEMENT_CREDITS: Record<number, number> = {
  14: 15, // Nu 15 comeback credit
  30: 20, // Nu 20 "we miss you" credit
};

@Injectable()
export class EngagementJob {
  private readonly logger = new Logger(EngagementJob.name);

  constructor(
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectRepository(Market) private marketRepo: Repository<Market>,
    @InjectRepository(Transaction) private txRepo: Repository<Transaction>,
    @InjectRepository(Challenge) private challengeRepo: Repository<Challenge>,
    @InjectDataSource() private dataSource: DataSource,
    private readonly telegram: TelegramSimpleService,
  ) {}

  /**
   * Re-engagement cron — runs 3:00 AM UTC daily.
   * Finds users who went silent at exactly the 14 or 30-day mark.
   * Uses a 1-day window per milestone so each user is messaged exactly once.
   *
   * 14 days → Nu 15 comeback credit + DM
   * 30 days → Nu 20 "we miss you" credit + DM
   */
  @Cron("0 3 * * *")
  async reEngageLapsedUsers(): Promise<void> {
    await Promise.all([
      this.messageWindow(14),
      this.messageWindow(30),
    ]);
  }

  /**
   * Streak at-risk cron — runs 3:00 PM UTC daily (≈ 9 PM Bhutan time).
   * Warns users whose bet streak will break at midnight if they don't predict today.
   */
  @Cron("0 15 * * *")
  async warnStreakAtRisk(): Promise<void> {
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

    const topMarket = await this.marketRepo
      .createQueryBuilder("m")
      .where("m.status = :s", { s: MarketStatus.OPEN })
      .andWhere("m.totalPool > 0")
      .orderBy("m.totalPool", "DESC")
      .limit(1)
      .getOne();

    for (const user of users) {
      try {
        const chatId = Number(user.telegramChatId);
        if (!chatId) continue;

        const name = user.firstName?.trim() || "Predictor";
        const streak = user.betStreakCount;

        const msg = topMarket
          ? `${name}, your <b>${streak}-day streak</b> breaks at midnight. ` +
            `Open Oro and predict on <b>${topMarket.title}</b> to save it.`
          : `${name}, your <b>${streak}-day streak</b> breaks at midnight. ` +
            `One prediction keeps it alive — open Oro now.`;

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

    const windowEnd = new Date(now);
    windowEnd.setDate(windowEnd.getDate() - daysMissed);

    const windowStart = new Date(windowEnd);
    windowStart.setDate(windowStart.getDate() - 1);

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

    const creditAmount = REENGAGEMENT_CREDITS[daysMissed] ?? 0;

    for (const user of users) {
      try {
        const chatId = Number(user.telegramChatId);
        if (!chatId) continue;

        const name = user.firstName ?? "Predictor";
        const msg = this.buildMessage(name, daysMissed, creditAmount);

        if (creditAmount > 0) {
          // Dedup guard: skip if this user already received this milestone credit
          const alreadyCredited = await this.txRepo.findOne({
            where: {
              userId: user.id,
              type: TransactionType.FREE_CREDIT,
              note: `Re-engagement credit (${daysMissed}d inactive)`,
            },
            select: ["id"],
          });
          if (alreadyCredited) {
            this.logger.debug(
              `[ReEngagement] Skipping ${user.id} — already credited for ${daysMissed}d`,
            );
            continue;
          }

          await this.creditUser(
            user.id,
            creditAmount,
            `Re-engagement credit (${daysMissed}d inactive)`,
          );
        }

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
    creditAmount: number,
  ): string {
    if (daysMissed === 14) {
      return (
        `${name}, it's been 2 weeks. We've added <b>Nu ${creditAmount}</b> to your Oro wallet ` +
        `to get you back in the game. Your prediction record is still waiting.`
      );
    }

    return (
      `${name}, a month away from Oro. We've added <b>Nu ${creditAmount}</b> to your wallet — ` +
      `one prediction is all it takes to restart your journey.`
    );
  }

  private async creditUser(
    userId: string,
    amount: number,
    note: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const { balance: rawBefore } = await em
        .getRepository(Transaction)
        .createQueryBuilder("t")
        .select("COALESCE(SUM(t.amount), 0)", "balance")
        .where("t.userId = :userId", { userId })
        .getRawOne();

      const balanceBefore = Number(rawBefore);

      await em.save(
        em.create(Transaction, {
          type: TransactionType.FREE_CREDIT,
          amount,
          balanceBefore,
          balanceAfter: balanceBefore + amount,
          userId,
          isBonus: true,
          note,
        }),
      );

      await em
        .createQueryBuilder()
        .update(User)
        .set({
          bonusBalance: () => `"bonusBalance" + ${amount}`,
          bonusRealPayoutRemaining: () => `GREATEST("bonusRealPayoutRemaining", 50)`,
        })
        .where("id = :userId", { userId })
        .execute();
    });
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
      // Mark expired
      ch.status = ChallengeStatus.EXPIRED;
      ch.settledAt = now;

      // Refund wager if one was placed
      const wager = Number(ch.wagerAmount);
      if (wager > 0) {
        await this.dataSource.transaction(async (em) => {
          const { balance: rawBefore } = await em
            .getRepository(Transaction)
            .createQueryBuilder("t")
            .select("COALESCE(SUM(t.amount), 0)", "balance")
            .where("t.userId = :userId", { userId: ch.creatorId })
            .getRawOne();

          const balanceBefore = Number(rawBefore);

          await em.save(
            em.create(Transaction, {
              type: TransactionType.DUEL_WAGER,
              amount: wager,
              balanceBefore,
              balanceAfter: balanceBefore + wager,
              userId: ch.creatorId,
              note: `Duel expired refund — challenge ${ch.id}`,
            }),
          );
        });
      }

      await this.challengeRepo.save(ch);

      // DM the creator
      const creator = ch.creator;
      if (creator?.telegramId) {
        const chatId = Number(creator.telegramId);
        const name = creator.firstName?.trim() || "Predictor";
        const marketTitle = ch.market?.title ?? "your market";
        const refundLine = wager > 0 ? ` Your Nu ${wager} wager has been refunded.` : "";

        await this.telegram
          .sendMessage(
            chatId,
            `⏱ <b>Your duel expired with no challenger.</b>${refundLine}\n\n` +
            `<b>${marketTitle}</b> is still open — want to challenge someone else?`,
          )
          .catch((err: Error) =>
            this.logger.warn(`[DuelExpiry] DM failed for user ${ch.creatorId}: ${err.message}`),
          );
      }
    }

    this.logger.log(`[DuelExpiry] Processed ${stale.length} expired challenge(s)`);
  }
}
