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
} from "./notification.queue";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";

@Processor(NOTIFICATION_QUEUE)
export class NotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(private readonly telegram: TelegramSimpleService) {
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
        const icon = data.status === "WON" ? "You won" : data.status === "LOST" ? "Better luck next time" : "Refunded";
        const payoutLine = data.payout ? `\nPayout: <b>Nu ${data.payout}</b>` : "";
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
        this.logger.log(`[daily.credit] user=${data.userId} credit=${data.creditAmount}`);
        await this.telegram.sendMessage(
          Number(data.telegramId),
          `Your daily free credit of <b>Nu ${data.creditAmount}</b> has been added. Open Oro to predict!`,
        );
        break;
      }

      default:
        this.logger.warn(`Unknown job name: ${job.name}`);
    }
  }
}
