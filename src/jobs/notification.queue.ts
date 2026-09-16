export const NOTIFICATION_QUEUE = "notifications";

export const JobName = {
  PAYMENT_SUCCESS: "payment.success",
  MARKET_SETTLED: "market.settled",
  BET_RESULT: "bet.result",
  STREAK_MILESTONE: "streak.milestone",
  DAILY_CREDIT: "daily.credit",
  SETTLEMENT_NOTIFY: "settlement.notify",
  BHUTANAPP_NOTIFY: "bhutanapp.notify",
  ANNOUNCEMENT_DM: "announcement.dm",
  ANNOUNCEMENT_FINALIZE: "announcement.finalize",
} as const;

export interface PaymentSuccessJobData {
  userId: string;
  paymentId: string;
  amount: number;
  currency: string;
}

export interface MarketSettledJobData {
  marketId: string;
  marketTitle: string;
  winningOutcomeLabel: string;
}

export interface BetResultJobData {
  userId: string;
  positionId: string;
  marketTitle: string;
  outcomeLabel: string;
  status: "WON" | "LOST" | "REFUNDED";
  payout?: number;
}

export interface StreakMilestoneJobData {
  userId: string;
  telegramId: string;
  streakCount: number;
  dayInCycle: number;
  boostActive: boolean;
}

export interface DailyCreditJobData {
  userId: string;
  telegramId: string;
  creditAmount: number;
}

/**
 * One job per user per settled market.
 * The processor sends the DM at ≤25/s so we never hit Telegram's rate limit.
 */
export interface SettlementNotifyJobData {
  telegramChatId: number;
  message: string;
}

/**
 * Push notification for a PWA / BhutanApp user (no Telegram chat). Delivered via
 * the BhutanApp notification service. Used for settlement win/lose results and
 * any other user-facing alerts for non-Telegram users.
 */
export interface BhutanAppNotifyJobData {
  externalUserId: string;
  title: string;
  body: string;
}

/**
 * One DM of an admin broadcast.
 *
 * Enqueued with `priority: 10` so it yields to settlement and payment DMs: the
 * 25/s limiter is shared by the whole queue, so 2,199 announcement jobs would
 * otherwise sit in front of any market settling in the next ~88 seconds.
 */
export interface AnnouncementDmJobData {
  announcementId: string;
  telegramChatId: number;
  message: string;
}

/**
 * Written once after the DMs drain: folds the Redis counters onto the row so
 * the admin history survives the counters expiring.
 */
export interface AnnouncementFinalizeJobData {
  announcementId: string;
  /** Chat id of the admin who sent it, for the summary DM. */
  adminChatId: number | null;
}
