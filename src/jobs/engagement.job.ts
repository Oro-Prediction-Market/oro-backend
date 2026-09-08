import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { Repository, DataSource, In, Not, IsNull, MoreThan } from "typeorm";
import { User } from "../entities/user.entity";
import { Transaction, TransactionType } from "../entities/transaction.entity";
import { Challenge, ChallengeStatus } from "../entities/challenge.entity";
import { Market, MarketStatus } from "../entities/market.entity";
import { Position } from "../entities/position.entity";
import { AuthMethod, AuthProvider } from "../entities/auth-method.entity";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";
import { RedisService } from "../redis/redis.service";
import { UserNotificationService } from "../users/user-notification.service";
import {
  NOTIFICATION_QUEUE,
  JobName,
  BhutanAppNotifyJobData,
} from "./notification.queue";
import { ledgerBalanceForAccount } from "../shared/utils/ledger.util";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Which win-back ladder a user is on.
 *
 * `no_first_call` is anchored on `createdAt` and `lapsed` on `lastActiveAt`, because
 * `lastActiveAt` is only written when a position is placed — it stays null
 * forever for a user who never bet, so that cohort cannot be found by activity
 * date at all.
 */
type Cohort = "no_first_call" | "lapsed";

/** One nudge, rendered once and fanned out to every channel the user has. */
interface Nudge {
  /** Bell/push headline. Short, and carries the hook on its own. */
  title: string;
  /** Telegram HTML body. The plain-text push/in-app body is derived from it. */
  html: string;
}

/**
 * Facts shared by every message in a run, loaded once.
 *
 * A live market title turns "you haven't made a prediction" into an actual open
 * question, which is the whole point — a concrete question the reader already
 * has an opinion about pulls far harder than a reminder that they owe us an
 * action. `predictorCount` is a real count; social proof that is invented is
 * both a lie and, once noticed, the reason nobody trusts the next message.
 */
interface NudgeContext {
  marketTitle: string | null;
  predictorCount: number;
}

/** Telegram HTML → plain text, for push and in-app bodies (neither renders markup). */
const toPlain = (html: string): string => html.replace(/<[^>]+>/g, "").trim();

@Injectable()
export class EngagementJob {
  private readonly logger = new Logger(EngagementJob.name);

  constructor(
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectRepository(Challenge) private challengeRepo: Repository<Challenge>,
    @InjectRepository(Market) private marketRepo: Repository<Market>,
    @InjectRepository(AuthMethod) private authRepo: Repository<AuthMethod>,
    @InjectDataSource() private dataSource: DataSource,
    private readonly telegram: TelegramSimpleService,
    private readonly redis: RedisService,
    private readonly userNotifications: UserNotificationService,
    @InjectQueue(NOTIFICATION_QUEUE) private notificationQueue: Queue,
  ) {}

  /** Days-quiet ladder for users who have never placed a prediction. */
  private static readonly FIRST_CALL_MILESTONES = [7, 3, 1];

  /** Days-quiet ladder for users who predicted before and then went quiet. */
  private static readonly LAPSED_MILESTONES = [30, 14, 7, 3];

  /**
   * Users messaged per milestone per run. A backlog drains over several days
   * rather than firing thousands of DMs at once — which is both a Telegram rate
   * limit and a fast route to bot reports.
   */
  private static readonly MAX_PER_MILESTONE_PER_RUN = 200;

  /**
   * Anchors older than this are never messaged. Someone who signed up or last
   * predicted months ago is not won back by a DM, and messaging them reads as
   * spam. This is also what bounds the one-time backfill when the ladder first
   * ships against a table full of long-cold accounts.
   */
  private static readonly STALE_HORIZON_DAYS = 90;

  /**
   * Re-engagement cron — runs 3:00 AM UTC daily.
   *
   * Walks both win-back ladders and DMs each user at most once per milestone.
   *
   * The no-first-call cohort is the point of this job: the previous query filtered
   * `totalPredictions > 0`, so a user who signed up and never placed a bet — the
   * cohort that churns hardest — was never messaged at any milestone, ever. It
   * also started at day 14, by which point a first-week drop-off is long gone.
   *
   * Milestones run longest-quiet-first so a user with a backlog (a fresh deploy,
   * or a cron that missed several days) gets the single most relevant message
   * instead of a burst of every milestone they passed.
   */
  @Cron("0 3 * * *")
  async reEngageLapsedUsers(): Promise<void> {
    const lock = await this.redis.acquireLock("cron:reengagement", 300);
    if (!lock) return;
    try {
      // Sequential, not Promise.all: each pass must observe the stage stamps
      // written by the pass above it, or a user gets claimed at two milestones
      // in the same run.
      const ctx = await this.loadNudgeContext();
      for (const days of EngagementJob.FIRST_CALL_MILESTONES) {
        await this.runMilestone("no_first_call", days, ctx);
      }
      for (const days of EngagementJob.LAPSED_MILESTONES) {
        await this.runMilestone("lapsed", days, ctx);
      }
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

  /**
   * Facts every message in this run shares. One query pair, not one per user.
   */
  private async loadNudgeContext(): Promise<NudgeContext> {
    const market = await this.marketRepo
      .createQueryBuilder("m")
      .select(["m.id", "m.title"])
      .where("m.status = :status", { status: MarketStatus.OPEN })
      .orderBy("m.totalPool", "DESC")
      .limit(1)
      .getOne()
      .catch(() => null);

    if (!market) return { marketTitle: null, predictorCount: 0 };

    const predictorCount = await this.dataSource
      .getRepository(Position)
      .createQueryBuilder("p")
      .select("COUNT(DISTINCT p.userId)", "c")
      .where("p.marketId = :id", { id: market.id })
      .getRawOne<{ c: string }>()
      .then((r) => Number(r?.c ?? 0))
      .catch(() => 0);

    return { marketTitle: market.title ?? null, predictorCount };
  }

  /**
   * One milestone pass for one cohort: find everyone quiet that long who has not
   * been messaged at this rung yet, claim them, and nudge them on every channel
   * their account has.
   */
  private async runMilestone(
    cohort: Cohort,
    daysQuiet: number,
    ctx: NudgeContext,
  ): Promise<void> {
    const now = Date.now();
    const cutoff = new Date(now - daysQuiet * DAY_MS);
    const horizon = new Date(now - EngagementJob.STALE_HORIZON_DAYS * DAY_MS);
    const anchor = cohort === "no_first_call" ? "u.createdAt" : "u.lastActiveAt";

    const qb = this.userRepo
      .createQueryBuilder("u")
      .select(["u.id", "u.telegramChatId", "u.firstName", "u.reputationTier"])
      // Stage guard: null means nothing sent since they were last active, and a
      // lower value means they have climbed the ladder but not this far. Either
      // way they are still owed this rung — so a run that never happened is
      // picked up by the next one instead of being lost with its date window.
      .where(
        "(u.reengagementStage IS NULL OR u.reengagementStage < :daysQuiet)",
        { daysQuiet },
      )
      .andWhere(`${anchor} IS NOT NULL`)
      .andWhere(`${anchor} <= :cutoff`, { cutoff })
      .andWhere(`${anchor} > :horizon`, { horizon })
      .orderBy(anchor, "DESC")
      .take(EngagementJob.MAX_PER_MILESTONE_PER_RUN);

    if (cohort === "no_first_call") {
      qb.andWhere("u.totalPredictions = 0");
    } else {
      qb.andWhere("u.totalPredictions > 0");
    }

    const candidates = await qb.getMany();
    if (candidates.length === 0) return;

    // Claim the batch before sending. The conditional UPDATE is the idempotency
    // guard: a re-run, or a second pod that somehow got past the lock, claims
    // nothing and sends nothing. RETURNING tells us exactly which rows we won,
    // so we only nudge those. A crash mid-send therefore drops a message rather
    // than duplicating one — the right trade for a win-back nudge.
    //
    // Every candidate is claimed, not just the Telegram-reachable ones: the
    // in-app bell below is a universal channel, so there is no longer such a
    // thing as an unreachable account.
    const claim = await this.userRepo
      .createQueryBuilder()
      .update(User)
      .set({ reengagementStage: daysQuiet })
      .whereInIds(candidates.map((u) => u.id))
      .andWhere(
        `("reengagementStage" IS NULL OR "reengagementStage" < :daysQuiet)`,
        { daysQuiet },
      )
      .returning(["id"])
      .execute();

    const claimedIds = new Set(
      ((claim.raw as { id: string }[] | undefined) ?? []).map((r) => r.id),
    );
    const targets = candidates.filter((u) => claimedIds.has(u.id));
    if (targets.length === 0) return;

    // Which of these have a BhutanApp (PWA) push channel — one batched query,
    // mirroring how settlement notifications pick their channel.
    const bhutanAuths = await this.authRepo
      .findBy({
        provider: AuthProvider.BHUTANAPP,
        userId: In(targets.map((u) => u.id)),
      })
      .catch(() => []);
    const externalIdByUser = new Map<string, string>();
    for (const am of bhutanAuths) {
      const ext = (am.metadata as any)?.externalUserId ?? am.providerId;
      if (ext) externalIdByUser.set(am.userId, String(ext));
    }

    const pushJobs: { name: string; data: BhutanAppNotifyJobData }[] = [];
    let dmCount = 0;

    for (const user of targets) {
      const name = user.firstName?.trim() || "Predictor";
      const nudge =
        cohort === "no_first_call"
          ? this.buildFirstCallNudge(name, daysQuiet, ctx)
          : this.buildLapsedNudge(
              name,
              daysQuiet,
              user.reputationTier ?? null,
              ctx,
            );
      const plain = toPlain(nudge.html);

      // Channel 1 — in-app bell. Universal: every account has one, which is how
      // a PWA user with no Telegram chat and no BhutanApp link gets nudged at
      // all. Never throws; a failed write just skips the popup.
      await this.userNotifications.create(user.id, {
        type: "reengagement",
        title: nudge.title,
        body: plain,
        metadata: { cohort, daysQuiet },
      });

      // Channel 2 — BhutanApp push for PWA accounts. Queued, so the processor's
      // rate limiter paces delivery.
      const externalUserId = externalIdByUser.get(user.id);
      if (externalUserId) {
        pushJobs.push({
          name: JobName.BHUTANAPP_NOTIFY,
          data: { externalUserId, title: nudge.title, body: plain },
        });
      }

      // Channel 3 — Telegram DM for TMA accounts.
      const chatId = Number(user.telegramChatId);
      if (chatId > 0) {
        try {
          await this.telegram.sendMessage(chatId, nudge.html);
          dmCount++;
        } catch (err: any) {
          this.logger.error(
            `[ReEngagement] DM failed for user ${user.id}: ${err.message}`,
          );
        }
      }
    }

    if (pushJobs.length) {
      await this.notificationQueue
        .addBulk(pushJobs)
        .catch((err: Error) =>
          this.logger.error(
            `[ReEngagement] push enqueue failed: ${err.message}`,
          ),
        );
    }

    this.logger.log(
      `[ReEngagement] ${cohort} ${daysQuiet}d — nudged ${targets.length} ` +
        `(in-app ${targets.length}, push ${pushJobs.length}, DM ${dmCount})`,
    );
  }

  /**
   * Copy for the cohort that has never made a call.
   *
   * Two rules shape all of it. It promises no free credit — the welcome grant is
   * disabled in both signup paths, and a nudge offering credit that never
   * arrives is worse than no nudge. And it never asks them to "make a
   * prediction" in the abstract: it puts a live market in front of them, because
   * an open question the reader already has a view on is what actually moves
   * someone, not a reminder that they owe the app an action.
   */
  private buildFirstCallNudge(
    name: string,
    daysQuiet: number,
    ctx: NudgeContext,
  ): Nudge {
    const { marketTitle, predictorCount } = ctx;
    // Only claim a crowd when there is one. Invented social proof is a lie, and
    // a transparent one the first time a reader opens the market.
    const crowd =
      predictorCount >= 3 ? ` ${predictorCount} people have taken a side.` : "";
    const market = marketTitle ? `\n\n<b>${marketTitle}</b>` : "";

    // Day 1 — unfinished action. They already did the hard part (signing up);
    // the message names the one step left rather than starting a new ask.
    if (daysQuiet <= 1) {
      return {
        title: "One step left",
        html: marketTitle
          ? `${name}, your account is ready — you just haven't called anything yet.${market} is open right now.${crowd}\n\nWhich way do you see it?`
          : `${name}, your account is ready — you just haven't called anything yet. The board is open whenever you are.`,
      };
    }

    // Day 3 — curiosity gap. The hook is the open question and the fact that
    // they already have an answer to it; the ask is only to say it out loud.
    if (daysQuiet <= 3) {
      return {
        title: "The board is open",
        html: marketTitle
          ? `${name}, you have an opinion on this one.${market}${crowd} You just haven't said which way yet.\n\nSay it before it closes.`
          : `${name}, markets are open on football, crypto and the weather. Pick the one you already have an opinion about.`,
      };
    }

    // Day 7 — last rung. Endowment framed forward: the blank record is the thing
    // to change, and everyone's was blank once. Low pressure, no further nudges.
    return {
      title: "Your record is still blank",
      html:
        `${name}, your record is still empty. Everyone on the leaderboard started exactly there — ` +
        `the only difference is one call.${market}\n\nNo pressure, and no more nudges from us.`,
    };
  }

  /** Copy for users who have a record and went quiet. */
  private buildLapsedNudge(
    name: string,
    daysMissed: number,
    tier: string | null,
    ctx: NudgeContext,
  ): Nudge {
    const tierLabel: Record<string, string> = {
      legend: "Legend",
      hot_hand: "Hot Hand",
      sharpshooter: "Sharpshooter",
      rookie: "Rookie",
    };
    const tierName = tierLabel[tier ?? ""] ?? null;
    const market = ctx.marketTitle ? `\n\n<b>${ctx.marketTitle}</b> is open.` : "";
    const marketLine = "\n\nOpen Oro whenever you want to make your next call.";

    // Day 3 — momentum cooling. Small, specific, and easy to reverse.
    if (daysMissed <= 3) {
      return {
        title: "Your streak has gone cold",
        html: `${name}, a few quiet days and the board has already moved.${market}\n\nOne call puts you back in it.`,
      };
    }

    // Day 7 — loss aversion on something they earned. A rank you built is a
    // stronger pull than a market you haven't seen.
    if (daysMissed <= 7) {
      return {
        title: "The board moved without you",
        html:
          `${name}, a week without a call.${tierName ? ` Your <b>${tierName}</b> standing doesn't defend itself.` : ""}` +
          `${market}${marketLine}`,
      };
    }

    if (daysMissed <= 14) {
      const lines = [
        `${name}, the leaderboard has moved while you were gone.${tierName ? ` Your <b>${tierName}</b> rank is on the line.` : ""} Two weeks is long enough — come back and reclaim your spot.${marketLine}`,
        `${name}, we saved your seat. 👀 It's been 2 weeks and the markets haven't stopped. Your record is still there — one call to get back in the game.${marketLine}`,
        `${name}, other predictors are on a streak right now. You built your reputation here — don't let two quiet weeks undo it.${marketLine}`,
      ];
      return {
        title: "Your rank is on the line",
        html: lines[Math.floor(Math.random() * lines.length)],
      };
    }

    // 30 days
    const lines = [
      `${name}, a whole month. The markets kept moving, the leaderboard kept shifting${tierName ? `, and your <b>${tierName}</b> title is gathering dust` : ""}. One call is all it takes to remind everyone you're still here.${marketLine}`,
      `${name}, we missed your calls. 🎯 It's been 30 days — long enough that people have forgotten your name on the leaderboard. Time to change that.${marketLine}`,
      `${name}, your Oro account has been quiet for a month. The community is predicting without you. Come back and show them what you've got.${marketLine}`,
    ];
    return {
      title: "A month of silence",
      html: lines[Math.floor(Math.random() * lines.length)],
    };
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
          const rawBefore = await ledgerBalanceForAccount(em, ch.creatorId);

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
