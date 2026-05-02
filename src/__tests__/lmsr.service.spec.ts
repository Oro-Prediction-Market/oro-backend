/**
 * Tests for LMSRService — probability calculations, cost function, and odds.
 * All functions are pure math with no DB dependencies.
 */
import { LMSRService } from "../markets/lmsr.service";

function makeOutcome(totalBetAmount: number): any {
  return { totalBetAmount };
}

const svc = new LMSRService();

// ── calculateProbabilities ────────────────────────────────────────────────────

describe("LMSRService.calculateProbabilities", () => {
  it("returns empty array for no outcomes", () => {
    expect(svc.calculateProbabilities([])).toEqual([]);
  });

  it("returns [1.0] for a single outcome (all bet on one)", () => {
    const result = svc.calculateProbabilities([makeOutcome(500)]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeCloseTo(1.0, 5);
  });

  it("returns equal probabilities for two outcomes with equal bets", () => {
    const outcomes = [makeOutcome(1000), makeOutcome(1000)];
    const result = svc.calculateProbabilities(outcomes);
    expect(result).toHaveLength(2);
    expect(result[0]).toBeCloseTo(0.5, 4);
    expect(result[1]).toBeCloseTo(0.5, 4);
  });

  it("returns equal probabilities for three outcomes with equal bets", () => {
    const outcomes = [makeOutcome(500), makeOutcome(500), makeOutcome(500)];
    const result = svc.calculateProbabilities(outcomes);
    expect(result[0]).toBeCloseTo(1 / 3, 4);
    expect(result[1]).toBeCloseTo(1 / 3, 4);
    expect(result[2]).toBeCloseTo(1 / 3, 4);
  });

  it("probabilities always sum to 1.0", () => {
    const outcomes = [makeOutcome(200), makeOutcome(500), makeOutcome(1300)];
    const result = svc.calculateProbabilities(outcomes);
    const sum = result.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 6);
  });

  it("higher bet amount → higher probability", () => {
    const outcomes = [makeOutcome(100), makeOutcome(900)];
    const result = svc.calculateProbabilities(outcomes);
    expect(result[1]).toBeGreaterThan(result[0]);
  });

  it("outcome with zero bets gets lower probability than outcome with bets", () => {
    const outcomes = [makeOutcome(0), makeOutcome(1000)];
    const result = svc.calculateProbabilities(outcomes);
    expect(result[1]).toBeGreaterThan(result[0]);
  });

  it("all-zero bets returns equal probabilities", () => {
    const outcomes = [makeOutcome(0), makeOutcome(0)];
    const result = svc.calculateProbabilities(outcomes);
    expect(result[0]).toBeCloseTo(0.5, 4);
    expect(result[1]).toBeCloseTo(0.5, 4);
  });

  it("uses liquidityParam to control sharpness of probabilities", () => {
    // Lower b → more extreme probabilities
    const outcomes = [makeOutcome(200), makeOutcome(800)];
    const lowB = svc.calculateProbabilities(outcomes, 100);
    const highB = svc.calculateProbabilities(outcomes, 10000);
    // With low b, heavy favorite should have higher probability than with high b
    expect(lowB[1]).toBeGreaterThan(highB[1]);
  });
});

// ── calculateCost ─────────────────────────────────────────────────────────────

describe("LMSRService.calculateCost", () => {
  it("returns 0 cost when no additional bets are placed", () => {
    const outcomes = [makeOutcome(500), makeOutcome(500)];
    const cost = svc.calculateCost(outcomes, [0, 0]);
    expect(cost).toBeCloseTo(0, 6);
  });

  it("returns positive cost when adding bets to an outcome", () => {
    const outcomes = [makeOutcome(500), makeOutcome(500)];
    const cost = svc.calculateCost(outcomes, [100, 0]);
    expect(cost).toBeGreaterThan(0);
  });

  it("cost increases as bet size increases", () => {
    const outcomes = [makeOutcome(500), makeOutcome(500)];
    const smallCost = svc.calculateCost(outcomes, [50, 0]);
    const largeCost = svc.calculateCost(outcomes, [500, 0]);
    expect(largeCost).toBeGreaterThan(smallCost);
  });

  it("handles missing additionalBets entries (defaults to 0)", () => {
    const outcomes = [makeOutcome(500), makeOutcome(500)];
    // Only provide bet for first outcome
    const cost = svc.calculateCost(outcomes, [100]);
    expect(cost).toBeGreaterThan(0);
  });
});

// ── probabilityToOdds ─────────────────────────────────────────────────────────

describe("LMSRService.probabilityToOdds", () => {
  it("returns 2.0x for 50% probability", () => {
    expect(svc.probabilityToOdds(0.5)).toBeCloseTo(2.0, 5);
  });

  it("returns 4.0x for 25% probability", () => {
    expect(svc.probabilityToOdds(0.25)).toBeCloseTo(4.0, 5);
  });

  it("returns 1.0x for 100% probability (certainty)", () => {
    expect(svc.probabilityToOdds(1.0)).toBeCloseTo(1.0, 5);
  });

  it("returns 0 for probability <= 0", () => {
    expect(svc.probabilityToOdds(0)).toBe(0);
    expect(svc.probabilityToOdds(-0.1)).toBe(0);
  });

  it("returns 0 for probability > 1", () => {
    expect(svc.probabilityToOdds(1.5)).toBe(0);
  });

  it("returns 10.0x for 10% probability", () => {
    expect(svc.probabilityToOdds(0.1)).toBeCloseTo(10.0, 5);
  });
});

// ── estimatePayout ────────────────────────────────────────────────────────────

describe("LMSRService.estimatePayout", () => {
  it("calculates payout with default 5% house edge", () => {
    // betAmount=100, prob=0.5 → odds=2 → gross=200 → net=200*(1-0.05)=190
    const result = svc.estimatePayout(100, 0.5);
    expect(result).toBeCloseTo(190, 2);
  });

  it("calculates payout with custom house edge", () => {
    // betAmount=100, prob=0.5 → odds=2 → gross=200 → net=200*(1-0.10)=180
    const result = svc.estimatePayout(100, 0.5, 10);
    expect(result).toBeCloseTo(180, 2);
  });

  it("returns 0 for invalid probability", () => {
    expect(svc.estimatePayout(100, 0)).toBe(0);
    expect(svc.estimatePayout(100, -0.5)).toBe(0);
  });

  it("payout is never negative", () => {
    const result = svc.estimatePayout(0, 0.5);
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it("higher bet amount → proportionally higher payout", () => {
    const small = svc.estimatePayout(100, 0.5);
    const large = svc.estimatePayout(200, 0.5);
    expect(large).toBeCloseTo(small * 2, 2);
  });
});

// ── calculateMaxLoss ──────────────────────────────────────────────────────────

describe("LMSRService.calculateMaxLoss", () => {
  it("returns 0 for 0 outcomes", () => {
    expect(svc.calculateMaxLoss(0, 1000)).toBe(0);
  });

  it("returns 0 for 1 outcome (ln(1)=0)", () => {
    expect(svc.calculateMaxLoss(1, 1000)).toBeCloseTo(0, 5);
  });

  it("returns b*ln(2) for 2 outcomes", () => {
    const result = svc.calculateMaxLoss(2, 1000);
    expect(result).toBeCloseTo(1000 * Math.log(2), 5);
  });

  it("max loss increases with more outcomes", () => {
    const twoOutcomes = svc.calculateMaxLoss(2, 1000);
    const threeOutcomes = svc.calculateMaxLoss(3, 1000);
    expect(threeOutcomes).toBeGreaterThan(twoOutcomes);
  });

  it("max loss scales linearly with liquidityParam", () => {
    const loss1000 = svc.calculateMaxLoss(4, 1000);
    const loss2000 = svc.calculateMaxLoss(4, 2000);
    expect(loss2000).toBeCloseTo(loss1000 * 2, 5);
  });
});
