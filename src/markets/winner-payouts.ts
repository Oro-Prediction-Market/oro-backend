import { roundMoney } from "../shared/utils/money.util";

/**
 * The multiple a winner is guaranteed, when the pool can fund it.
 *
 * Mirrored on the clients in `shared/payout.ts`. Changing it here without
 * changing it there makes every quoted payout wrong.
 */
export const PAYOUT_FLOOR_MULTIPLE = 1.05;

/**
 * What each winner is paid, and how much of the house edge had to be given up.
 *
 * Extracted because this arithmetic was implemented twice — in the settlement
 * engine and, separately, in `reconciliation.service.ts`, which recomputes
 * expected payouts to detect discrepancies. The two had already drifted: the
 * reconciler applied the 1.05x floor but not the pro-rata scale-down, so on a
 * market concentrated enough to need scaling it would have flagged *every*
 * winning position as a MISMATCH. A checker that reimplements the thing it is
 * checking eventually disagrees with it; now there is one implementation.
 *
 * Three bands, by how much of the pool the winning side holds:
 *
 *  1. Floor not binding — plain parimutuel, each winner takes their pro-rata
 *     share of the post-rake pool, and the house keeps its full edge.
 *  2. Floor binding but affordable — each winner gets exactly 1.05x their
 *     stake, funded by giving up as much of the edge as it takes. The house
 *     keeps whatever is left, which may be the full edge, part of it, or none.
 *  3. Floor unaffordable even at a zero edge — payouts scale down so the total
 *     never exceeds the money actually in the pool. The 1.05 cancels out and
 *     each winner receives `stake × totalPool / winnerPool`, which is strictly
 *     more than their stake as long as some money sits on the losing side (the
 *     engine's thin-pool guard refunds when none does). Being right never pays
 *     less than being wrong.
 *
 * Note `maxBudget` is `totalPool`, not `totalPool + forfeitedBonds`: forfeited
 * dispute bonds are not pool money and never fund winners.
 */
export function computeWinnerPayouts(args: {
  /** Winning stakes, in the order the caller wants payouts back. */
  stakes: number[];
  /** The pool net of the configured house edge. */
  payoutPool: number;
  /** The whole pool — the ceiling on what winners can be paid. */
  totalPool: number;
  currency: string;
}): { payouts: number[]; scale: number; total: number } {
  const { stakes, payoutPool, totalPool, currency } = args;
  const winnerPool = stakes.reduce((sum, s) => sum + s, 0);

  if (winnerPool <= 0) return { payouts: stakes.map(() => 0), scale: 1, total: 0 };

  const desired = stakes.map((stake) =>
    Math.max(
      roundMoney(payoutPool * (stake / winnerPool), currency),
      roundMoney(stake * PAYOUT_FLOOR_MULTIPLE, currency),
    ),
  );
  const desiredTotal = desired.reduce((sum, d) => sum + d, 0);

  // Only scale when even a fully waived edge cannot cover the floor.
  const scale = desiredTotal > totalPool ? totalPool / desiredTotal : 1;

  const payouts = desired.map((d) => roundMoney(d * scale, currency));
  return {
    payouts,
    scale,
    total: payouts.reduce((sum, p) => sum + p, 0),
  };
}
