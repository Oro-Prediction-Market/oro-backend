import { Injectable } from "@nestjs/common";
import { Outcome } from "../entities/outcome.entity";

/**
 * LMSR (Logarithmic Market Scoring Rule) Service
 *
 * Provides probability calculations for better odds display
 * while maintaining parimutuel settlement mechanics.
 *
 * Reference: /docs/LMSR-Integration-Guide.md
 */
@Injectable()
export class LMSRService {
  /**
   * Calculate LMSR probabilities for outcomes
   * Based on outstanding bet amounts (treated as shares)
   *
   * Formula: p_i = exp(q_i / b) / Σ exp(q_j / b)
   * where q_i = totalBetAmount for outcome i
   *       b = liquidity parameter
   *
   * @param outcomes - Array of Outcome entities
   * @param liquidityParam - LMSR b parameter (default: 1000 BTN)
   * @returns Array of probabilities summing to 1.0
   */
  calculateProbabilities(
    outcomes: Outcome[],
    liquidityParam: number = 1000,
  ): number[] {
    if (outcomes.length === 0) return [];

    // Extract bet amounts as shares
    const shares = outcomes.map((o) => Number(o.totalBetAmount));

    // Numerical stability: use log-sum-exp trick to avoid overflow
    const maxShare = Math.max(...shares, 0);
    const expValues = shares.map((q) =>
      Math.exp((q - maxShare) / liquidityParam),
    );
    const totalExp = expValues.reduce((sum, exp) => sum + exp, 0);

    // Normalize to probabilities
    const probs = expValues.map((exp) => exp / totalExp);

    // Fix floating point errors - ensure probabilities sum to exactly 1.0
    const sum = probs.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1.0) > 0.0001) {
      probs[0] += 1.0 - sum;
    }

    return probs;
  }

  /**
   * Calculate cost of moving from current state to new state
   * Useful for what-if analysis and cost estimation
   *
   * Cost = C(q') - C(q)
   * where C(q) = b · ln(Σ exp(q_i/b))
   */
  calculateCost(
    outcomes: Outcome[],
    additionalBets: number[],
    liquidityParam: number = 1000,
  ): number {
    const currentShares = outcomes.map((o) => Number(o.totalBetAmount));
    const newShares = currentShares.map((s, i) => s + (additionalBets[i] || 0));

    const currentCost = this.costFunction(currentShares, liquidityParam);
    const newCost = this.costFunction(newShares, liquidityParam);

    return newCost - currentCost;
  }

  /**
   * LMSR cost function: C(q) = b · ln(Σ exp(q_i/b))
   * Uses log-sum-exp trick for numerical stability
   */
  private costFunction(shares: number[], liquidityParam: number): number {
    if (shares.length === 0) return 0;

    // Use log-sum-exp trick
    const maxShare = Math.max(...shares, 0);
    const scaled = shares.map((q) => (q - maxShare) / liquidityParam);
    const logSumExp =
      maxShare / liquidityParam +
      Math.log(scaled.reduce((sum, s) => sum + Math.exp(s), 0));

    return liquidityParam * logSumExp;
  }

  /**
   * Convert LMSR probability to decimal odds
   * e.g., 0.5 → 2.00x, 0.25 → 4.00x
   */
  probabilityToOdds(probability: number): number {
    if (probability <= 0 || probability > 1) return 0;
    return 1 / probability;
  }

  /**
   * Estimate potential payout using LMSR probabilities
   * Note: This is for display only - actual payout uses parimutuel formula
   *
   * @param betAmount - Amount being bet
   * @param currentProbability - Current LMSR probability
   * @param houseEdgePct - House edge percentage (default: 5%)
   */
  estimatePayout(
    betAmount: number,
    currentProbability: number,
    houseEdgePct: number = 5,
  ): number {
    const odds = this.probabilityToOdds(currentProbability);
    const grossPayout = betAmount * odds;
    const netPayout = grossPayout * (1 - houseEdgePct / 100);
    return Math.max(netPayout, 0);
  }

  /**
   * Calculate market maker's potential loss bound
   * Max loss ≈ b · ln(n) where n = number of outcomes
   */
  calculateMaxLoss(numOutcomes: number, liquidityParam: number): number {
    if (numOutcomes <= 0) return 0;
    return liquidityParam * Math.log(numOutcomes);
  }
}
