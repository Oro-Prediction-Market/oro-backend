export const NOTIFICATION_QUEUE = "notifications";

export const JobName = {
  PAYMENT_SUCCESS: "payment.success",
  MARKET_SETTLED: "market.settled",
  BET_RESULT: "bet.result",
  STREAK_MILESTONE: "streak.milestone",
  DAILY_CREDIT: "daily.credit",
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
