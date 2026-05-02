import { ReputationService } from "../markets/reputation.service";
import { PositionStatus } from "../entities/position.entity";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeUser(overrides: any = {}) {
  return {
    id: "u1",
    reputationScore: null,
    reputationTier: "rookie",
    totalPredictions: 0,
    correctPredictions: 0,
    categoryScores: null,
    telegramStreak: 0,
    ...overrides,
  };
}

function makeBet(overrides: any = {}) {
  return {
    id: "b1",
    userId: "u1",
    marketId: "m1",
    outcomeId: "o1",
    amount: 100,
    status: PositionStatus.WON,
    market: { category: "sports" },
    ...overrides,
  };
}

/**
 * Build a ReputationService with mocked repos.
 *
 * @param user       - the user row recalculateForUser will load
 * @param allBets    - ALL resolved bets for that user across all markets
 * @param marketBets - bets for recalculateForMarket (status WON/LOST only)
 */
function makeService(user: any, allBets: any[], marketBets: any[] = allBets) {
  const mockUserRepo = {
    findOneBy: jest.fn().mockResolvedValue(user),
    update: jest.fn().mockResolvedValue(undefined),
  };

  // recalculateForMarket uses betRepo.find({ where: [{ marketId, status: WON }, { marketId, status: LOST }] })
  // recalculateForUser  uses betRepo.createQueryBuilder(...)
  const mockBetRepo = {
    find: jest.fn().mockResolvedValue(marketBets),
    createQueryBuilder: jest.fn().mockReturnValue({
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(allBets),
    }),
  };

  const mockMarketRepo = {
    findOneBy: jest.fn().mockResolvedValue({ id: "m1", category: "sports" }),
  };

  const svc = new ReputationService(
    mockUserRepo as any,
    mockBetRepo as any,
    mockMarketRepo as any,
  );

  return { svc, mockUserRepo, mockBetRepo };
}

// ─── adjustedScore (pure maths) ───────────────────────────────────────────────

describe("ReputationService.adjustedScore", () => {
  const svc = new ReputationService(null as any, null as any, null as any);

  it("returns 0.5 when total is 0", () => {
    expect(svc.adjustedScore(0, 0)).toBe(0.5);
  });

  it("pulls toward 0.5 when prediction count is low", () => {
    // 1 correct out of 1 → raw = 1.0, confidence = 1/30 ≈ 0.033 → score ≈ 0.517
    const score = svc.adjustedScore(1, 1);
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThan(0.55);
  });

  it("reaches full signal at CONFIDENCE_THRESHOLD (30 predictions)", () => {
    // 30/30 correct → raw = 1.0, confidence = 1.0 → score = 1.0
    expect(svc.adjustedScore(30, 30)).toBeCloseTo(1.0);
  });

  it("caps confidence at 1.0 beyond threshold", () => {
    // 80/100 correct → raw = 0.8, confidence = 1.0 → score = 0.8
    expect(svc.adjustedScore(80, 100)).toBeCloseTo(0.8);
  });
});

// ─── calcTier ─────────────────────────────────────────────────────────────────

describe("ReputationService.calcTier", () => {
  const svc = new ReputationService(null as any, null as any, null as any);

  it("rookie when total < 10", () => {
    expect(svc.calcTier(5, 5)).toBe("rookie");
    expect(svc.calcTier(0, 0)).toBe("rookie");
  });

  it("sharpshooter when 10–49 predictions regardless of accuracy", () => {
    expect(svc.calcTier(10, 2)).toBe("sharpshooter");
    expect(svc.calcTier(49, 49)).toBe("sharpshooter");
  });

  it("hot_hand when 50+ predictions and accuracy >= 65%", () => {
    expect(svc.calcTier(50, 33)).toBe("hot_hand"); // 33/50 = 66%
  });

  it("still sharpshooter when 50+ predictions but accuracy < 65%", () => {
    expect(svc.calcTier(50, 30)).toBe("sharpshooter"); // 30/50 = 60%
  });

  it("legend when 100+ predictions and accuracy >= 75%", () => {
    expect(svc.calcTier(100, 80)).toBe("legend"); // 80%
  });

  it("hot_hand (not legend) when 100+ predictions but accuracy < 75%", () => {
    expect(svc.calcTier(100, 70)).toBe("hot_hand"); // 70%
  });
});

// ─── recalculateForUser: multiple bets on same market = ONE prediction ────────

describe("ReputationService.recalculateForUser — multiple bets same market", () => {
  it("counts a user who placed 3 bets on the SAME market as 1 prediction (deduplication)", async () => {
    // User placed 3 bets on market-1 — same market, same outcome.
    // One market = one prediction decision, so totalPredictions = 1, correctPredictions = 1.
    const user = makeUser();

    const allBets = [
      makeBet({
        id: "b1",
        status: PositionStatus.WON,
        marketId: "m1",
        outcomeId: "o1",
      }),
      makeBet({
        id: "b2",
        status: PositionStatus.WON,
        marketId: "m1",
        outcomeId: "o1",
      }),
      makeBet({
        id: "b3",
        status: PositionStatus.WON,
        marketId: "m1",
        outcomeId: "o1",
      }),
    ];

    const { svc, mockUserRepo } = makeService(user, allBets);
    await svc.recalculateForUser("u1");

    const [, updatePayload] = mockUserRepo.update.mock.calls[0];
    // Deduplicated to 1 market → 1 prediction, 1 correct
    expect(updatePayload.totalPredictions).toBe(1);
    expect(updatePayload.correctPredictions).toBe(1);
    expect(updatePayload.reputationScore).toBeGreaterThan(0.5);
  });

  it("a user with bets on 2 different markets (1 WON, 1 LOST) has 50% raw accuracy", async () => {
    const user = makeUser();
    const allBets = [
      makeBet({ id: "b1", status: PositionStatus.WON, marketId: "m1" }),
      makeBet({ id: "b2", status: PositionStatus.LOST, marketId: "m2" }),
    ];

    const { svc, mockUserRepo } = makeService(user, allBets);
    await svc.recalculateForUser("u1");

    const [, updatePayload] = mockUserRepo.update.mock.calls[0];
    expect(updatePayload.totalPredictions).toBe(2);
    expect(updatePayload.correctPredictions).toBe(1);
    // raw = 0.5, very low confidence → score ≈ 0.5
    expect(updatePayload.reputationScore).toBeCloseTo(0.5, 1);
  });

  it("3 bets on the same market where user switched outcome — last bet outcome decides WON/LOST", async () => {
    // User bet YES, then NO, then YES again on the same market.
    // Last bet (YES, WON) is the canonical prediction. Result: 1 prediction, 1 correct.
    const user = makeUser();
    const allBets = [
      makeBet({
        id: "b1",
        status: PositionStatus.LOST,
        marketId: "m1",
        outcomeId: "o-NO",
      }),
      makeBet({
        id: "b2",
        status: PositionStatus.LOST,
        marketId: "m1",
        outcomeId: "o-YES",
      }),
      makeBet({
        id: "b3",
        status: PositionStatus.WON,
        marketId: "m1",
        outcomeId: "o-YES",
      }),
    ];

    const { svc, mockUserRepo } = makeService(user, allBets);
    await svc.recalculateForUser("u1");

    const [, updatePayload] = mockUserRepo.update.mock.calls[0];
    expect(updatePayload.totalPredictions).toBe(1);
    expect(updatePayload.correctPredictions).toBe(1);
  });
});

// ─── computeMarketSignal: multiple bets by same user count as ONE vote ────────

describe("ReputationService.computeMarketSignal — deduplication", () => {
  /**
   * Build a service whose betRepo.createQueryBuilder returns
   * the provided rows (simulating the raw query result).
   */
  function makeSignalService(rows: any[]) {
    const mockBetRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        leftJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(rows),
      }),
    };
    return new ReputationService(null as any, mockBetRepo as any, null as any);
  }

  it("user with 3 bets on same outcome contributes only ONE vote to the signal", async () => {
    // u1 has reputationScore 0.9 and placed 3 bets on outcome-YES
    // u2 score 0.5 → outcome-NO
    // u3 score 0.5 → outcome-NO
    // Without deduplication: YES weight = 0.9+0.9+0.9=2.7, NO weight=1.0 → YES=73%
    // With deduplication:    YES weight = 0.9,           NO weight=1.0 → YES=47%
    const rows = [
      {
        userId: "u1",
        outcomeId: "outcome-YES",
        reputationScore: 0.9,
        categoryScores: null,
      },
      {
        userId: "u1",
        outcomeId: "outcome-YES",
        reputationScore: 0.9,
        categoryScores: null,
      },
      {
        userId: "u1",
        outcomeId: "outcome-YES",
        reputationScore: 0.9,
        categoryScores: null,
      },
      {
        userId: "u2",
        outcomeId: "outcome-NO",
        reputationScore: 0.5,
        categoryScores: null,
      },
      {
        userId: "u3",
        outcomeId: "outcome-NO",
        reputationScore: 0.5,
        categoryScores: null,
      },
    ];

    const svc = makeSignalService(rows);
    const signal = await svc.computeMarketSignal("m1", [
      "outcome-YES",
      "outcome-NO",
    ]);

    // With dedup: YES=0.9, NO=0.5+0.5=1.0 → total=1.9
    // YES signal = 0.9/1.9 ≈ 0.474 — below 50% despite u1 being high-rep
    expect(signal["outcome-YES"]).toBeCloseTo(0.9 / 1.9, 3);
    expect(signal["outcome-NO"]).toBeCloseTo(1.0 / 1.9, 3);

    // Signals sum to 1
    expect(signal["outcome-YES"] + signal["outcome-NO"]).toBeCloseTo(1.0, 3);
  });

  it("returns {} when fewer than 3 unique bettors even with many bets", async () => {
    // u1 placed 5 bets, u2 placed 3 bets — only 2 unique users → no signal
    const rows = [
      {
        userId: "u1",
        outcomeId: "o1",
        reputationScore: 0.8,
        categoryScores: null,
      },
      {
        userId: "u1",
        outcomeId: "o1",
        reputationScore: 0.8,
        categoryScores: null,
      },
      {
        userId: "u1",
        outcomeId: "o1",
        reputationScore: 0.8,
        categoryScores: null,
      },
      {
        userId: "u1",
        outcomeId: "o1",
        reputationScore: 0.8,
        categoryScores: null,
      },
      {
        userId: "u1",
        outcomeId: "o1",
        reputationScore: 0.8,
        categoryScores: null,
      },
      {
        userId: "u2",
        outcomeId: "o2",
        reputationScore: 0.6,
        categoryScores: null,
      },
      {
        userId: "u2",
        outcomeId: "o2",
        reputationScore: 0.6,
        categoryScores: null,
      },
      {
        userId: "u2",
        outcomeId: "o2",
        reputationScore: 0.6,
        categoryScores: null,
      },
    ];

    const svc = makeSignalService(rows);
    const signal = await svc.computeMarketSignal("m1", ["o1", "o2"]);
    expect(signal).toEqual({});
  });

  it("3 unique bettors each with multiple bets produce a valid signal", async () => {
    // u1 (rep 0.8) placed 3 bets on o1
    // u2 (rep 0.6) placed 2 bets on o1
    // u3 (rep 0.5) placed 1 bet  on o2
    // After dedup: o1 weight = 0.8+0.6=1.4, o2 weight=0.5 → total=1.9
    const rows = [
      {
        userId: "u1",
        outcomeId: "o1",
        reputationScore: 0.8,
        categoryScores: null,
      },
      {
        userId: "u1",
        outcomeId: "o1",
        reputationScore: 0.8,
        categoryScores: null,
      },
      {
        userId: "u1",
        outcomeId: "o1",
        reputationScore: 0.8,
        categoryScores: null,
      },
      {
        userId: "u2",
        outcomeId: "o1",
        reputationScore: 0.6,
        categoryScores: null,
      },
      {
        userId: "u2",
        outcomeId: "o1",
        reputationScore: 0.6,
        categoryScores: null,
      },
      {
        userId: "u3",
        outcomeId: "o2",
        reputationScore: 0.5,
        categoryScores: null,
      },
    ];

    const svc = makeSignalService(rows);
    const signal = await svc.computeMarketSignal("m1", ["o1", "o2"]);

    expect(signal["o1"]).toBeCloseTo(1.4 / 1.9, 3);
    expect(signal["o2"]).toBeCloseTo(0.5 / 1.9, 3);
    expect(signal["o1"] + signal["o2"]).toBeCloseTo(1.0, 3);
  });

  it("last bet position wins when user switches outcome across multiple bets", async () => {
    // u1 first bet o1, then bet o2 — final position is o2
    // u2 and u3 on o1 to reach 3 unique bettors
    const rows = [
      {
        userId: "u1",
        outcomeId: "o1",
        reputationScore: 0.8,
        categoryScores: null,
      },
      {
        userId: "u1",
        outcomeId: "o2",
        reputationScore: 0.8,
        categoryScores: null,
      }, // last bet
      {
        userId: "u2",
        outcomeId: "o1",
        reputationScore: 0.6,
        categoryScores: null,
      },
      {
        userId: "u3",
        outcomeId: "o1",
        reputationScore: 0.5,
        categoryScores: null,
      },
    ];

    const svc = makeSignalService(rows);
    const signal = await svc.computeMarketSignal("m1", ["o1", "o2"]);

    // u1 counted on o2 (last bet), u2+u3 on o1
    // o1 = 0.6+0.5=1.1, o2=0.8 → total=1.9
    expect(signal["o2"]).toBeCloseTo(0.8 / 1.9, 3);
    expect(signal["o1"]).toBeCloseTo(1.1 / 1.9, 3);
  });
});

// ─── calcContrarianBadge (pure maths) ─────────────────────────────────────────

describe("ReputationService.calcContrarianBadge", () => {
  const svc = new ReputationService(null as any, null as any, null as any);

  it("returns null when attempts < 3 regardless of wins", () => {
    expect(svc.calcContrarianBadge(0, 0)).toBeNull();
    expect(svc.calcContrarianBadge(2, 2)).toBeNull();
  });

  it("returns null when win-rate is below 55% with ≥ 3 attempts", () => {
    expect(svc.calcContrarianBadge(1, 3)).toBeNull(); // 33%
    expect(svc.calcContrarianBadge(2, 4)).toBeNull(); // 50%
    expect(svc.calcContrarianBadge(5, 10)).toBeNull(); // 50%
  });

  it("returns bronze when wins ≥ 3 AND win-rate ≥ 55%", () => {
    expect(svc.calcContrarianBadge(3, 3)).toBe("bronze"); // 100%
    expect(svc.calcContrarianBadge(3, 5)).toBe("bronze"); // 60%
    expect(svc.calcContrarianBadge(6, 10)).toBe("bronze"); // 60%, wins < 7
  });

  it("returns silver when wins ≥ 7 AND win-rate ≥ 55%", () => {
    expect(svc.calcContrarianBadge(7, 7)).toBe("silver"); // 100%
    expect(svc.calcContrarianBadge(8, 12)).toBe("silver"); // 67%
    expect(svc.calcContrarianBadge(14, 20)).toBe("silver"); // 70%, wins < 15
  });

  it("returns gold when wins ≥ 15 AND win-rate ≥ 55%", () => {
    expect(svc.calcContrarianBadge(15, 15)).toBe("gold"); // 100%
    expect(svc.calcContrarianBadge(20, 30)).toBe("gold"); // 67%
    expect(svc.calcContrarianBadge(15, 27)).toBe("gold"); // 55.6%
  });

  it("returns null for 15+ wins if win-rate < 55%", () => {
    expect(svc.calcContrarianBadge(15, 28)).toBeNull(); // 53.6%
  });

  it("win-rate exactly 55% qualifies (boundary inclusive)", () => {
    expect(svc.calcContrarianBadge(11, 20)).toBe("silver"); // 55%
  });
});

// ─── recordContrarianOutcome ──────────────────────────────────────────────────

describe("ReputationService.recordContrarianOutcome", () => {
  function makeContrarianService(user: any) {
    const mockUserRepo = {
      findOneBy: jest.fn().mockResolvedValue(user),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new ReputationService(
      mockUserRepo as any,
      null as any,
      null as any,
    );
    return { svc, mockUserRepo };
  }

  it("does nothing when predictedProbability is null (no signal)", async () => {
    const user = makeUser({
      contrarianWins: 0,
      contrarianAttempts: 0,
      contrarianBadge: null,
    });
    const { svc, mockUserRepo } = makeContrarianService(user);
    await svc.recordContrarianOutcome("u1", null, true);
    expect(mockUserRepo.update).not.toHaveBeenCalled();
  });

  it("does nothing when predictedProbability >= 0.5 (consensus pick, not contrarian)", async () => {
    const user = makeUser({
      contrarianWins: 0,
      contrarianAttempts: 0,
      contrarianBadge: null,
    });
    const { svc, mockUserRepo } = makeContrarianService(user);
    await svc.recordContrarianOutcome("u1", 0.5, true);
    expect(mockUserRepo.update).not.toHaveBeenCalled();
    await svc.recordContrarianOutcome("u1", 0.8, true);
    expect(mockUserRepo.update).not.toHaveBeenCalled();
  });

  it("increments attempts but NOT wins on a contrarian LOSS", async () => {
    const user = makeUser({
      contrarianWins: 0,
      contrarianAttempts: 0,
      contrarianBadge: null,
    });
    const { svc, mockUserRepo } = makeContrarianService(user);
    await svc.recordContrarianOutcome("u1", 0.3, false);

    const [, payload] = mockUserRepo.update.mock.calls[0];
    expect(payload.contrarianAttempts).toBe(1);
    expect(payload.contrarianWins).toBe(0);
    expect(payload.contrarianBadge).toBeNull();
  });

  it("increments both attempts and wins on a contrarian WIN — earns bronze", async () => {
    const user = makeUser({
      contrarianWins: 2,
      contrarianAttempts: 3,
      contrarianBadge: null,
    });
    const { svc, mockUserRepo } = makeContrarianService(user);
    await svc.recordContrarianOutcome("u1", 0.2, true);

    const [, payload] = mockUserRepo.update.mock.calls[0];
    expect(payload.contrarianAttempts).toBe(4);
    expect(payload.contrarianWins).toBe(3);
    // 3/4 = 75% ≥ 55%, wins ≥ 3 → bronze
    expect(payload.contrarianBadge).toBe("bronze");
  });

  it("upgrades badge from bronze to silver when crossing 7-win threshold", async () => {
    const user = makeUser({
      contrarianWins: 6,
      contrarianAttempts: 8,
      contrarianBadge: "bronze",
    });
    const { svc, mockUserRepo } = makeContrarianService(user);
    await svc.recordContrarianOutcome("u1", 0.1, true);

    const [, payload] = mockUserRepo.update.mock.calls[0];
    expect(payload.contrarianWins).toBe(7);
    expect(payload.contrarianAttempts).toBe(9);
    // 7/9 ≈ 77.8% → silver
    expect(payload.contrarianBadge).toBe("silver");
  });

  it("upgrades badge from silver to gold when crossing 15-win threshold", async () => {
    const user = makeUser({
      contrarianWins: 14,
      contrarianAttempts: 18,
      contrarianBadge: "silver",
    });
    const { svc, mockUserRepo } = makeContrarianService(user);
    await svc.recordContrarianOutcome("u1", 0.25, true);

    const [, payload] = mockUserRepo.update.mock.calls[0];
    expect(payload.contrarianWins).toBe(15);
    expect(payload.contrarianAttempts).toBe(19);
    // 15/19 ≈ 78.9% → gold
    expect(payload.contrarianBadge).toBe("gold");
  });

  it("badge drops to null when win-rate falls below 55% after losses", async () => {
    // 3 wins / 5 attempts = 60% → bronze. One more loss → 3/6 = 50% < 55% → null
    const user = makeUser({
      contrarianWins: 3,
      contrarianAttempts: 5,
      contrarianBadge: "bronze",
    });
    const { svc, mockUserRepo } = makeContrarianService(user);
    await svc.recordContrarianOutcome("u1", 0.4, false);

    const [, payload] = mockUserRepo.update.mock.calls[0];
    expect(payload.contrarianAttempts).toBe(6);
    expect(payload.contrarianWins).toBe(3);
    // 3/6 = 50% < 55% → null
    expect(payload.contrarianBadge).toBeNull();
  });

  it("does nothing when user is not found in DB", async () => {
    const mockUserRepo = {
      findOneBy: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
    };
    const svc = new ReputationService(
      mockUserRepo as any,
      null as any,
      null as any,
    );
    await svc.recordContrarianOutcome("missing-user", 0.2, true);
    expect(mockUserRepo.update).not.toHaveBeenCalled();
  });

  it("handles fresh user with undefined contrarianWins/Attempts (new column)", async () => {
    const user = makeUser({
      contrarianWins: undefined,
      contrarianAttempts: undefined,
      contrarianBadge: null,
    });
    const { svc, mockUserRepo } = makeContrarianService(user);
    await svc.recordContrarianOutcome("u1", 0.3, true);

    const [, payload] = mockUserRepo.update.mock.calls[0];
    expect(payload.contrarianAttempts).toBe(1);
    expect(payload.contrarianWins).toBe(1);
    // 1 attempt < 3 → no badge yet
    expect(payload.contrarianBadge).toBeNull();
  });
});
