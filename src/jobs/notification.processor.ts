import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job } from "bullmq";
import {
  JobName,
  NOTIFICATION_QUEUE,
  PaymentSuccessJobData,
  MarketSettledJobData,
  BetResultJobData,
  StreakMilestoneJobData,
  DailyCreditJobData,
  SettlementNotifyJobData,
  BhutanAppNotifyJobData,
  AnnouncementDmJobData,
  AnnouncementFinalizeJobData,
} from "./notification.queue";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";
import { BhutanAppNotificationService } from "../shared/services/bhutanapp-notification.service";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Announcement } from "../entities/announcement.entity";
import { RedisService } from "../redis/redis.service";
import {
  isPermanentDeliveryFailure,
  readCounters,
  readErrorSamples,
  recordOutcome,
} from "../shared/utils/announcement-stats.util";

@Processor(NOTIFICATION_QUEUE, {
  // Drain jobs in parallel (was default 1 → hours of settlement-DM backlog at a
  // knockout). Reads the BULLMQ_CONCURRENCY configmap value.
  concurrency: parseInt(process.env.BULLMQ_CONCURRENCY ?? "12", 10),
  // Telegram allows ~30 msg/sec globally per bot.
  // Capping at 25 jobs/sec here keeps us safely under the limit
  // even when 100k settlement DMs are queued up.
  limiter: { max: 25, duration: 1000 },
})
export class NotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(
    private readonly telegram: TelegramSimpleService,
    private readonly bhutanApp: BhutanAppNotificationService,
    private readonly redis: RedisService,
    @InjectRepository(Announcement)
    private readonly announcementRepo: Repository<Announcement>,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case JobName.PAYMENT_SUCCESS: {
        const data = job.data as PaymentSuccessJobData;
        this.logger.log(
          `[payment.success] user=${data.userId} amount=${data.amount} ${data.currency}`,
        );
        // telegramId stored as string; Bot API needs a number chat_id
        const chatId = Number(data.userId); // userId here is telegramId for DM — override if needed
        await this.telegram.sendMessage(
          chatId,
          `Your deposit of <b>Nu ${data.amount}</b> is confirmed. Ready to predict!`,
        );
        break;
      }

      case JobName.MARKET_SETTLED: {
        const data = job.data as MarketSettledJobData;
        this.logger.log(
          `[market.settled] market=${data.marketId} winner="${data.winningOutcomeLabel}"`,
        );
        await this.telegram.postToChannel(
          `Market resolved: <b>${data.marketTitle}</b>\nWinner: <b>${data.winningOutcomeLabel}</b>`,
        );
        break;
      }

      case JobName.BET_RESULT: {
        const data = job.data as BetResultJobData;
        this.logger.log(
          `[bet.result] user=${data.userId} status=${data.status} payout=${data.payout ?? 0}`,
        );
        const icon =
          data.status === "WON"
            ? "You won"
            : data.status === "LOST"
              ? "Better luck next time"
              : "Refunded";
        const payoutLine = data.payout
          ? `\nPayout: <b>Nu ${data.payout}</b>`
          : "";
        await this.telegram.sendMessage(
          Number(data.userId),
          `${icon} — <b>${data.marketTitle}</b> (${data.outcomeLabel})${payoutLine}`,
        );
        break;
      }

      case JobName.STREAK_MILESTONE: {
        const data = job.data as StreakMilestoneJobData;
        this.logger.log(
          `[streak.milestone] user=${data.userId} streak=${data.streakCount} day=${data.dayInCycle} boost=${data.boostActive}`,
        );
        let msg: string;
        if (data.boostActive) {
          msg = `Day 7 streak bonus! Your next winning payout gets a <b>1.2x boost</b>. Keep it going!`;
        } else if (data.dayInCycle === 3) {
          msg = `3-day prediction streak! ${7 - data.dayInCycle} days until your bonus boost.`;
        } else {
          msg = `${data.streakCount}-day streak! Keep predicting daily to unlock the Day-7 boost.`;
        }
        await this.telegram.sendMessage(Number(data.telegramId), msg);
        break;
      }

      case JobName.DAILY_CREDIT: {
        const data = job.data as DailyCreditJobData;
        this.logger.log(
          `[daily.credit] user=${data.userId} credit=${data.creditAmount}`,
        );
        await this.telegram.sendMessage(
          Number(data.telegramId),
          `Your daily free credit of <b>Nu ${data.creditAmount}</b> has been added. Open Oro to predict!`,
        );
        break;
      }

      case JobName.SETTLEMENT_NOTIFY: {
        // Rate-limited 1-per-job: BullMQ limiter on the queue keeps this at ≤25/s
        const data = job.data as SettlementNotifyJobData;
        await this.telegram
          .sendMessage(data.telegramChatId, data.message)
          .catch(() => {});
        break;
      }

      case JobName.BHUTANAPP_NOTIFY: {
        // Push notification for a PWA / BhutanApp user. sendNotification never
        // throws — it returns false on any failure — so no try/catch needed.
        const data = job.data as BhutanAppNotifyJobData;
        await this.bhutanApp.sendNotification(
          data.externalUserId,
          data.title,
          data.body,
        );
        break;
      }

      case JobName.ANNOUNCEMENT_DM: {
        const data = job.data as AnnouncementDmJobData;
        // sendMessageChecked rather than sendMessage: a broadcast has to be able
        // to report "1,809 delivered, 31 failed", and sendMessage returns void
        // on every outcome.
        const res = await this.telegram.sendMessageChecked(
          data.telegramChatId,
          data.message,
        );

        if (res.ok) {
          await this.afterOutcome(job, data.announcementId, "sent");
          break;
        }

        if (isPermanentDeliveryFailure(res)) {
          // The user blocked the bot or never started it. Retrying spends the
          // shared rate limit that reachable users are queued behind.
          await this.afterOutcome(job, data.announcementId, "blocked", {
            code: res.code,
            description: res.description,
          });
          break;
        }

        // Retryable (429, 5xx, network). Throw so BullMQ backs off — but on the
        // final attempt record it instead, or the `done` counter never reaches
        // the total and the broadcast never finalises.
        const attempts = job.opts?.attempts ?? 1;
        if (job.attemptsMade + 1 >= attempts) {
          await this.afterOutcome(job, data.announcementId, "failed", {
            code: res.code,
            description: res.description,
          });
          break;
        }
        throw new Error(
          `announcement DM failed (code=${res.code ?? "?"}): ${res.description ?? "unknown"}`,
        );
      }

      case JobName.ANNOUNCEMENT_FINALIZE: {
        const data = job.data as AnnouncementFinalizeJobData;
        await this.finalizeAnnouncement(data.announcementId, data.adminChatId);
        break;
      }

      default:
        this.logger.warn(`Unknown job name: ${job.name}`);
    }
  }

  /**
   * Record one DM's terminal outcome, and finalise if it was the last.
   *
   * "Last one out turns off the lights": HINCRBY is atomic, so exactly one of
   * the concurrent jobs sees `done === total`. A delayed backstop job also
   * exists in case a worker dies mid-flight and that moment never arrives.
   */
  private async afterOutcome(
    job: Job,
    announcementId: string,
    field: "sent" | "blocked" | "failed",
    sample?: { code?: number; description?: string },
  ): Promise<void> {
    const data = job.data as AnnouncementDmJobData & {
      total?: number;
      adminChatId?: number | null;
    };
    const done = await recordOutcome(
      this.redis.redis,
      announcementId,
      field,
      sample,
    );
    if (data.total && done >= data.total) {
      await this.finalizeAnnouncement(announcementId, data.adminChatId ?? null);
    }
  }

  /**
   * Fold the Redis counters onto the row and tell the admin how it went.
   *
   * Idempotent by the same compare-and-swap the fan-out uses: only a row still
   * in `sending` is moved on, so the backstop job and the last DM racing each
   * other cannot both send the summary.
   */
  private async finalizeAnnouncement(
    announcementId: string,
    adminChatId: number | null,
  ): Promise<void> {
    const counters = await readCounters(this.redis.redis, announcementId);
    const samples = await readErrorSamples(this.redis.redis, announcementId);

    const byCode: Record<string, number> = {};
    for (const s of samples) {
      const k = String(s.code ?? "network");
      byCode[k] = (byCode[k] ?? 0) + 1;
    }

    const status =
      counters.failed > 0 ? "completed_with_failures" : "completed";

    // Criteria include the current status, so this is a compare-and-swap: only a
    // row still `sending` moves on. That is what stops the last DM and the
    // backstop job — which can run at the same moment — both sending a summary.
    const claimed = await this.announcementRepo.update(
      { id: announcementId, status: "sending" },
      {
        status,
        sentCount: counters.sent,
        blockedCount: counters.blocked,
        failedCount: counters.failed,
        // Cast: TypeORM's partial-update typing rejects a plain object for a
        // jsonb column — the same limitation noted on createOrRefresh in
        // user-notification.service.ts, which works around it with save().
        // Here the compare-and-swap needs update(), so the cast is the way out.
        failureSummary: { byCode, samples: samples.slice(0, 10) } as any,
        finishedAt: new Date(),
      },
    );

    if (claimed.affected !== 1) return; // already finalised by the other racer

    this.logger.log(
      `[announcement.finalize] ${announcementId} sent=${counters.sent} blocked=${counters.blocked} failed=${counters.failed}`,
    );

    if (adminChatId) {
      // The summary has to reach a human. A jsonb column nobody opens is not
      // how anyone finds out half a broadcast failed.
      const blockedNote = counters.blocked
        ? ` ${counters.blocked} could not be reached (blocked the bot or never started it).`
        : "";
      const failedNote = counters.failed
        ? ` <b>${counters.failed} genuinely failed.</b>`
        : "";
      await this.telegram.sendMessage(
        adminChatId,
        `Broadcast finished — <b>${counters.sent} delivered</b>.${blockedNote}${failedNote}`,
      );
    }
  }
}
