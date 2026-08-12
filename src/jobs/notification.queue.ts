export const NOTIFICATION_QUEUE = "notifications";

export const JobName = {
  PAYMENT_SUCCESS: "payment.success",
  MARKET_SETTLED: "market.settled",
  BET_RESULT: "bet.result",
  STREAK_MILESTONE: "streak.milestone",
  DAILY_CREDIT: "daily.credit",
  SETTLEMENT_NOTIFY: "settlement.notify",
  BHUTANAPP_NOTIFY: "bhutanapp.notify",
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
