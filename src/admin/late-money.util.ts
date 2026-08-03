/**
 * Late-money statistics — REAL aggregation, no synthetic/random data.
 *
 * "Late money" = wagers arriving in the final window before a market closes,
 * which can signal informed/insider betting. The admin monitor must show the
 * true share of bets (by count AND by amount) that landed in that window, so
 * operators act on facts, not a demo.
 *
 * This file is a pure function so the math is unit-tested without a database;
 * the controller supplies the aggregated row.
 */

export interface LateMoneyAgg {
  /** Total positions ever placed on the market. */
  totalBets: number;
  /** Total BTN staked across all positions. */
  totalAmount: number;
  /** Positions whose createdAt falls inside the final window. */
  windowBets: number;
  /** BTN staked inside the final window. */
  windowAmount: number;
}

export interface LateMoneyStats {
  marketId: string;
  status: string;
  windowMinutes: number;
  closesAt: string | null;
  timeUntilCloseMs: number | null;
  totalBets: number;
  totalAmount: number;
  finalWindowBets: number;
  finalWindowAmount: number;
  percentageByCount: number;
  percentageByAmount: number;
  /** True when the window's share of MONEY meets the alert threshold. */
  detected: boolean;
  alertThresholdPct: number;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function buildLateMoneyStats(
  agg: LateMoneyAgg,
  o: {
    marketId: string;
    status: string;
    windowMinutes: number;
    closesAt: Date | null;
    now: number;
    alertThresholdPct: number;
  },
): LateMoneyStats {
  const totalBets = Math.max(0, Math.trunc(agg.totalBets));
  const totalAmount = Math.max(0, agg.totalAmount);
  const finalWindowBets = Math.max(0, Math.trunc(agg.windowBets));
  const finalWindowAmount = Math.max(0, agg.windowAmount);

  const percentageByCount =
    totalBets > 0 ? round1((finalWindowBets / totalBets) * 100) : 0;
  const percentageByAmount =
    totalAmount > 0 ? round1((finalWindowAmount / totalAmount) * 100) : 0;

  return {
    marketId: o.marketId,
    status: o.status,
    windowMinutes: o.windowMinutes,
    closesAt: o.closesAt ? o.closesAt.toISOString() : null,
    timeUntilCloseMs: o.closesAt ? o.closesAt.getTime() - o.now : null,
    totalBets,
    totalAmount: round1(totalAmount),
    finalWindowBets,
    finalWindowAmount: round1(finalWindowAmount),
    percentageByCount,
    percentageByAmount,
    // Only a market that actually has bets can trip the alert.
    detected: totalBets > 0 && percentageByAmount >= o.alertThresholdPct,
    alertThresholdPct: o.alertThresholdPct,
  };
}
