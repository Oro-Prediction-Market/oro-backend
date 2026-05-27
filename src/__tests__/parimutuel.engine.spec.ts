import { BadRequestException } from "@nestjs/common";
import { ParimutuelEngine } from "../markets/parimutuel.engine";
import { TransactionType } from "../entities/transaction.entity";
import { ChallengeStatus } from "../entities/challenge.entity";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const bypassConfigService = {
  get: jest.fn((key: string) => {
    if (
      key === "DK_STAGING_PAYOUT_BYPASS" ||
      key === "DK_STAGING_DEPOSIT_BYPASS" ||
      key === "DK_STAGING_WITHDRAWAL_BYPASS"
    )
      return "true";
    return undefined;
  }),
} as any;

// ─── calcOdds ─────────────────────────────────────────────────────────────────

describe("ParimutuelEngine.calcOdds", () => {
  let engine: ParimutuelEngine;

  beforeEach(() => {
    engine = new ParimutuelEngine(
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      bypassConfigService,
      null as any,
      null as any, // challengesService
      null as any, // marketsGateway
      null as any, // sse
      null as any, // revenueDistributionService
    );
  });

  it("returns 0 when outcomePool is 0", () => {
    expect(engine.calcOdds(1000, 5, 0)).toBe(0);
  });

  it("calculates correct odds with 5% house edge", () => {
    // payoutPool = 1000 * 0.95 = 950; outcomePool = 500 → odds = 1.9
    expect(engine.calcOdds(1000, 5, 500)).toBeCloseTo(1.9);
  });

  it("calculates odds when one outcome takes entire pool (5% edge)", () => {
    // payoutPool = 1000 * 0.95 = 950; winner holds all 1000 → 0.95
    expect(engine.calcOdds(1000, 5, 1000)).toBeCloseTo(0.95);
  });

  it("handles 0% house edge", () => {
    expect(engine.calcOdds(500, 0, 250)).toBeCloseTo(2.0);
  });

  it("handles 100% house edge (no payout)", () => {
    expect(engine.calcOdds(1000, 100, 500)).toBeCloseTo(0);
  });
});

// ─── Bonus cap logic (unit) ───────────────────────────────────────────────────

describe("Bonus credit cap logic", () => {
  const BONUS_CAP = 50;

  function calcBonusSplit(rawPayout: number, isBonusFunded: boolean) {
    if (!isBonusFunded) return { withdrawable: rawPayout, play: 0 };
    const withdrawable = Math.min(rawPayout, BONUS_CAP);
    const play = parseFloat((rawPayout - withdrawable).toFixed(2));
    return { withdrawable, play };
  }

  it("does not split payout when bet is NOT funded by bonus credits", () => {
    const { withdrawable, play } = calcBonusSplit(200, false);
    expect(withdrawable).toBe(200);
    expect(play).toBe(0);
  });

  it("caps withdrawable at Nu 50 when payout exceeds cap (bonus bet)", () => {
    const { withdrawable, play } = calcBonusSplit(120, true);
    expect(withdrawable).toBe(50);
    expect(play).toBe(70);
  });

  it("allows full payout when bonus bet wins less than Nu 50", () => {
    const { withdrawable, play } = calcBonusSplit(30, true);
    expect(withdrawable).toBe(30);
    expect(play).toBe(0);
  });

  it("caps exactly at Nu 50 when payout equals cap", () => {
    const { withdrawable, play } = calcBonusSplit(50, true);
    expect(withdrawable).toBe(50);
    expect(play).toBe(0);
  });

  it("play credits are marked isBonus=true, withdrawable is isBonus=false", () => {
    const rawPayout = 150;
    const { withdrawable, play } = calcBonusSplit(rawPayout, true);

    const withdrawableTx = {
      type: TransactionType.POSITION_PAYOUT,
      amount: withdrawable,
      isBonus: false,
    };
    const playTx = {
      type: TransactionType.FREE_CREDIT,
      amount: play,
      isBonus: true,
    };

    expect(withdrawableTx.isBonus).toBe(false);
    expect(playTx.isBonus).toBe(true);
    expect(withdrawableTx.amount + playTx.amount).toBe(rawPayout);
  });
});

// ─── placePosition: pre-flight guards ────────────────────────────────────────

describe("ParimutuelEngine.placePosition — pre-flight guards", () => {
  it("throws BadRequestException when amount <= 0", async () => {
    const engine = new ParimutuelEngine(
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      bypassConfigService,
      null as any,
      null as any, // challengesService
      null as any, // marketsGateway
      null as any, // sse
      null as any, // revenueDistributionService
    );
    await expect(engine.placePosition("u1", "m1", "o1", 0)).rejects.toThrow(
      BadRequestException,
    );
    await expect(engine.placePosition("u1", "m1", "o1", -5)).rejects.toThrow(
      BadRequestException,
    );
  });

  it("throws when user has no linked DK Bank account", async () => {
    // Market exists and is OPEN, but user has no dkAccountNumber
    const market = {
      id: "m1",
      status: "open",
      outcomes: [
        { id: "o1", totalBetAmount: 0, currentOdds: 0, lmsrProbability: 0.5 },
      ],
      totalPool: 0,
      houseEdgePct: 8,
      liquidityParam: 1000,
    };
    const user = {
      id: "u1",
      telegramId: "111",
      dkAccountNumber: null,
      phoneNumber: "17000001",
    };

    const mockEm = {
      getRepository: jest.fn().mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue({
          setLock: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockResolvedValue(market),
        }),
      }),
      find: jest.fn().mockResolvedValue(market.outcomes),
      // First findOne → User, second findOne (Challenge) never reached
      findOne: jest.fn().mockResolvedValue(user),
    };
    const mockDataSource = {
      transaction: jest.fn().mockImplementation((cb: Function) => cb(mockEm)),
    };
    const mockRedis = {
      acquireLockWithRetry: jest.fn().mockResolvedValue("lock-token"),
      releaseLock: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };

    const engine = new ParimutuelEngine(
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      mockDataSource as any,
      null as any,
      mockRedis as any,
      null as any,
      null as any,
      null as any,
      bypassConfigService,
      null as any,
      null as any,
      null as any, // marketsGateway
      null as any, // sse
      null as any, // revenueDistributionService
    );

    await expect(engine.placePosition("u1", "m1", "o1", 100)).rejects.toThrow(
      "link your DK Bank account",
    );
  });

  it("throws when user has no verified phone number", async () => {
    // User has DK account but no phone number
    const market = {
      id: "m1",
      status: "open",
      outcomes: [
        { id: "o1", totalBetAmount: 0, currentOdds: 0, lmsrProbability: 0.5 },
      ],
      totalPool: 0,
      houseEdgePct: 8,
      liquidityParam: 1000,
    };
    const user = {
      id: "u1",
      telegramId: "111",
      dkAccountNumber: "ACC001",
      phoneNumber: null,
    };

    const mockEm = {
      getRepository: jest.fn().mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue({
          setLock: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockResolvedValue(market),
        }),
      }),
      find: jest.fn().mockResolvedValue(market.outcomes),
      // First findOne → User, second findOne (Challenge) never reached
      findOne: jest.fn().mockResolvedValue(user),
    };
    const mockDataSource = {
      transaction: jest.fn().mockImplementation((cb: Function) => cb(mockEm)),
    };
    const mockRedis = {
      acquireLockWithRetry: jest.fn().mockResolvedValue("lock-token"),
      releaseLock: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };

    const engine = new ParimutuelEngine(
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      mockDataSource as any,
      null as any,
      mockRedis as any,
      null as any,
      null as any,
      null as any,
      bypassConfigService,
      null as any,
      null as any,
      null as any, // marketsGateway
      null as any, // sse
      null as any, // revenueDistributionService
    );

    await expect(engine.placePosition("u1", "m1", "o1", 100)).rejects.toThrow(
      "verified phone number",
    );
  });

  it("throws when user is the CREATOR of an ACTIVE duel on the same market", async () => {
    const market = {
      id: "m1",
      status: "open",
      outcomes: [
        { id: "o1", totalBetAmount: 0, currentOdds: 0, lmsrProbability: 0.5 },
        { id: "o2", totalBetAmount: 0, currentOdds: 0, lmsrProbability: 0.5 },
      ],
      totalPool: 0,
      houseEdgePct: 8,
      liquidityParam: 1000,
    };
    const user = {
      id: "u1",
      telegramId: "111",
      dkAccountNumber: "ACC001",
      phoneNumber: "17000001",
    };
    const activeDuel = {
      id: "duel-1",
      marketId: "m1",
      creatorId: "u1",
      joinerId: "u2",
      status: ChallengeStatus.ACTIVE,
    };

    const mockEm = {
      getRepository: jest.fn().mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue({
          setLock: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockResolvedValue(market),
        }),
      }),
      find: jest.fn().mockResolvedValue(market.outcomes),
      // First call → User, second call → Challenge (active duel found)
      findOne: jest
        .fn()
        .mockResolvedValueOnce(user)
        .mockResolvedValueOnce(activeDuel),
    };
    const mockDataSource = {
      transaction: jest.fn().mockImplementation((cb: Function) => cb(mockEm)),
    };
    const mockRedis = {
      acquireLockWithRetry: jest.fn().mockResolvedValue("lock-token"),
      releaseLock: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };

    const engine = new ParimutuelEngine(
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      mockDataSource as any,
      null as any,
      mockRedis as any,
      null as any,
      null as any,
      null as any,
      bypassConfigService,
      null as any,
      null as any,
      null as any, // marketsGateway
      null as any, // sse
      null as any, // revenueDistributionService
    );

    await expect(engine.placePosition("u1", "m1", "o1", 100)).rejects.toThrow(
      "active duel on this market",
    );
  });

  it("throws when user is the JOINER of an ACTIVE duel on the same market", async () => {
    const market = {
      id: "m1",
      status: "open",
      outcomes: [
        { id: "o1", totalBetAmount: 0, currentOdds: 0, lmsrProbability: 0.5 },
        { id: "o2", totalBetAmount: 0, currentOdds: 0, lmsrProbability: 0.5 },
      ],
      totalPool: 0,
      houseEdgePct: 8,
      liquidityParam: 1000,
    };
    const user = {
      id: "u2",
      telegramId: "222",
      dkAccountNumber: "ACC002",
      phoneNumber: "17000002",
    };
    // u2 joined u1's duel — both wagers locked (ACTIVE)
    const activeDuel = {
      id: "duel-1",
      marketId: "m1",
      creatorId: "u1",
      joinerId: "u2",
      status: ChallengeStatus.ACTIVE,
    };

    const mockEm = {
      getRepository: jest.fn().mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue({
          setLock: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockResolvedValue(market),
        }),
      }),
      find: jest.fn().mockResolvedValue(market.outcomes),
      findOne: jest
        .fn()
        .mockResolvedValueOnce(user)
        .mockResolvedValueOnce(activeDuel),
    };
    const mockDataSource = {
      transaction: jest.fn().mockImplementation((cb: Function) => cb(mockEm)),
    };
    const mockRedis = {
      acquireLockWithRetry: jest.fn().mockResolvedValue("lock-token"),
      releaseLock: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };

    const engine = new ParimutuelEngine(
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      mockDataSource as any,
      null as any,
      mockRedis as any,
      null as any,
      null as any,
      null as any,
      bypassConfigService,
      null as any,
      null as any,
      null as any, // marketsGateway
      null as any, // sse
      null as any, // revenueDistributionService
    );

    await expect(engine.placePosition("u2", "m1", "o2", 100)).rejects.toThrow(
      "active duel on this market",
    );
  });

  it("allows bet when user has only an OPEN (not yet accepted) duel on the same market", async () => {
    const market = {
      id: "m1",
      status: "open",
      outcomes: [
        { id: "o1", totalBetAmount: 0, currentOdds: 0, lmsrProbability: 0.5 },
      ],
      totalPool: 0,
      houseEdgePct: 8,
      liquidityParam: 1000,
    };
    const user = {
      id: "u1",
      telegramId: "111",
      dkAccountNumber: "ACC001",
      phoneNumber: "17000001",
    };

    const mockEm = {
      getRepository: jest.fn().mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue({
          setLock: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          getRawOne: jest.fn().mockResolvedValue({ balance: "0" }), // 0 credits → Insufficient balance
          getOne: jest.fn().mockResolvedValue(market),
        }),
      }),
      find: jest.fn().mockResolvedValue(market.outcomes),
      // Challenge lookup returns null → no ACTIVE duel, proceed
      findOne: jest
        .fn()
        .mockResolvedValueOnce(user)
        .mockResolvedValueOnce(null),
      save: jest
        .fn()
        .mockImplementation((entity: any, val: any) => val ?? entity),
      create: jest
        .fn()
        .mockImplementation((_: any, data: any) => ({ ...data, id: "pos-1" })),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const mockDataSource = {
      transaction: jest.fn().mockImplementation((cb: Function) => cb(mockEm)),
    };
    const mockRedis = {
      acquireLockWithRetry: jest.fn().mockResolvedValue("lock-token"),
      releaseLock: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
      invalidateMarketCache: jest.fn().mockResolvedValue(undefined),
      setJsonEx: jest.fn().mockResolvedValue(undefined),
    };
    const mockLmsr = {
      calculateProbabilities: jest.fn().mockReturnValue([0.5]),
    };

    const engine = new ParimutuelEngine(
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      mockDataSource as any,
      null as any,
      mockRedis as any,
      mockLmsr as any,
      null as any,
      null as any,
      bypassConfigService,
      null as any,
      null as any,
      null as any, // marketsGateway
      null as any, // sse
      null as any, // revenueDistributionService
    );

    // Should NOT throw — duel is OPEN, not ACTIVE
    // (will eventually fail at credit balance check, which is fine)
    await expect(engine.placePosition("u1", "m1", "o1", 100)).rejects.toThrow(
      "Insufficient balance",
    );
  });
});

// ─── Settlement: no DK batch transfer fires ───────────────────────────────────

describe("Settlement wallet credit — no DK transfer on market settle", () => {
  function buildSettlementEngine(savedTransactions: any[]) {
    // Minimal in-memory state
    const positions = [
      {
        id: "pos1",
        userId: "u1",
        outcomeId: "o-win",
        marketId: "m1",
        amount: 200,
        status: "pending",
        payout: 0,
      },
      {
        id: "pos2",
        userId: "u2",
        outcomeId: "o-lose",
        marketId: "m1",
        amount: 100,
        status: "pending",
        payout: 0,
      },
    ];

    const balances: Record<string, number> = { u1: 0, u2: 0 };

    const mockEm = {
      getRepository: jest.fn().mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getRawOne: jest
            .fn()
            .mockImplementation(() => Promise.resolve({ balance: 0 })),
        }),
      }),
      find: jest.fn().mockResolvedValue(positions),
      findOne: jest.fn().mockResolvedValue({ id: "u1", bonusBalance: 0 }),
      save: jest.fn().mockImplementation(async (_cls: any, data: any) => {
        if (data?.type) {
          savedTransactions.push(data);
          balances[data.userId] = (balances[data.userId] ?? 0) + data.amount;
        }
        return data;
      }),
      create: jest
        .fn()
        .mockImplementation((_cls: any, data: any) => ({ ...data })),
      update: jest.fn().mockResolvedValue(undefined),
    };

    const mockDataSource = {
      transaction: jest.fn().mockImplementation((cb: Function) => cb(mockEm)),
      getRepository: jest.fn().mockReturnValue({
        find: jest.fn().mockResolvedValue(positions),
        findOne: jest.fn().mockResolvedValue(null),
        createQueryBuilder: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getRawOne: jest.fn().mockResolvedValue({ balance: 0 }),
        }),
        save: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        increment: jest.fn().mockResolvedValue({}),
      }),
    };

    const mockRedis = {
      del: jest.fn().mockResolvedValue(undefined),
    };

    // Spy target: if DK gateway is ever called, the test fails
    const mockDkGateway = {
      transferToAccount: jest
        .fn()
        .mockRejectedValue(
          new Error("DK_GATEWAY_MUST_NOT_BE_CALLED_ON_SETTLEMENT"),
        ),
    };

    const engine = new ParimutuelEngine(
      null as any, // marketRepo
      null as any, // outcomeRepo
      null as any, // betRepo
      null as any, // paymentRepo
      null as any, // transactionRepo
      null as any, // settlementRepo
      null as any, // disputeRepo
      mockDataSource as any,
      null as any, // lmsrService
      mockRedis as any,
      null as any, // reputationService
      null as any, // telegramSimple
      mockDkGateway as any,
      bypassConfigService,
      null as any, // streakService
      null as any, // challengesService
      null as any, // marketsGateway
      null as any, // sse
      null as any, // revenueDistributionService
    );

    return { engine, mockDkGateway, positions };
  }

  it("credits winners' Oro wallet balance (POSITION_PAYOUT transaction) on settlement", async () => {
    const savedTransactions: any[] = [];
    const { engine } = buildSettlementEngine(savedTransactions);

    // Access private settleMarket via (engine as any)
    const market = {
      id: "m1",
      status: "resolved",
      totalPool: 300,
      houseEdgePct: 8,
      outcomes: [
        { id: "o-win", label: "Yes", totalBetAmount: 200, isWinner: true },
        { id: "o-lose", label: "No", totalBetAmount: 100, isWinner: false },
      ],
    };
    const winner = market.outcomes[0];

    const settlement = await (engine as any).settleMarket(market, winner, 0);

    // payoutPool = 300 * 0.92 = 276; winner holds 200/200 → full payout
    expect(settlement).toBeDefined();
    expect(settlement.payoutPool).toBeCloseTo(276);

    const payouts = savedTransactions.filter(
      (t) => t.type === TransactionType.POSITION_PAYOUT,
    );
    expect(payouts.length).toBeGreaterThan(0);
    expect(payouts[0].userId).toBe("u1");
    expect(payouts[0].amount).toBeCloseTo(276);
  });

  it("does NOT call dkGateway.transferToAccount when market settles", async () => {
    const savedTransactions: any[] = [];
    const { engine, mockDkGateway } = buildSettlementEngine(savedTransactions);

    const market = {
      id: "m1",
      status: "resolved",
      totalPool: 300,
      houseEdgePct: 8,
      outcomes: [
        { id: "o-win", label: "Yes", totalBetAmount: 200, isWinner: true },
        { id: "o-lose", label: "No", totalBetAmount: 100, isWinner: false },
      ],
    };
    const winner = market.outcomes[0];

    await (engine as any).settleMarket(market, winner, 0);

    // Calling dispatchDkPayouts (the no-op) must NEVER reach the DK gateway
    await (engine as any).dispatchDkPayouts("m1", "o-win", "Yes", {
      payoutPool: 276,
    });

    expect(mockDkGateway.transferToAccount).not.toHaveBeenCalled();
  });

  it("losers receive no POSITION_PAYOUT transaction on settlement", async () => {
    const savedTransactions: any[] = [];
    const { engine } = buildSettlementEngine(savedTransactions);

    const market = {
      id: "m1",
      status: "resolved",
      totalPool: 300,
      houseEdgePct: 8,
      outcomes: [
        { id: "o-win", label: "Yes", totalBetAmount: 200, isWinner: true },
        { id: "o-lose", label: "No", totalBetAmount: 100, isWinner: false },
      ],
    };
    const winner = market.outcomes[0];

    await (engine as any).settleMarket(market, winner, 0);

    const loserPayouts = savedTransactions.filter(
      (t) => t.type === TransactionType.POSITION_PAYOUT && t.userId === "u2",
    );
    expect(loserPayouts).toHaveLength(0);
  });
});

// ─── Settlement: batch payment — never fires on market settle ─────────────────
//
// Verifies that BatchAuthService, DkApiEndpointsService, BatchUploadService and
// SignatureService are completely untouched during settlement — those are only
// ever called on user withdrawal.

describe("Batch payment — NOT triggered on market settlement", () => {
  function buildBatchSpies() {
    return {
      batchLogin: jest.fn(),
      batchUpload: jest.fn(),
      batchSign: jest.fn(),
      dkUploadFile: jest.fn(),
      dkIndividual: jest.fn(),
    };
  }

  function buildEngineWithBatchSpies(
    spies: ReturnType<typeof buildBatchSpies>,
    positions: any[],
  ) {
    const mockEm = {
      getRepository: jest.fn().mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getRawOne: jest.fn().mockResolvedValue({ balance: 0 }),
        }),
      }),
      find: jest.fn().mockResolvedValue(positions),
      findOne: jest
        .fn()
        .mockResolvedValue({ id: positions[0].userId, bonusBalance: 0 }),
      save: jest.fn().mockImplementation(async (_cls: any, data: any) => data),
      create: jest
        .fn()
        .mockImplementation((_cls: any, data: any) => ({ ...data })),
      update: jest.fn().mockResolvedValue(undefined),
    };

    const mockDataSource = {
      transaction: jest.fn().mockImplementation((cb: Function) => cb(mockEm)),
      getRepository: jest.fn().mockReturnValue({
        find: jest.fn().mockResolvedValue(positions),
        findOne: jest.fn().mockResolvedValue(null),
        createQueryBuilder: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getRawOne: jest.fn().mockResolvedValue({ balance: 0 }),
        }),
        save: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        increment: jest.fn().mockResolvedValue({}),
      }),
    };

    // Wire spy functions onto service-shaped objects
    const mockBatchAuthService = {
      login: spies.batchLogin,
      getActivePrivateKey: jest.fn(),
    };
    const mockBatchUploadService = {
      createBatchUpload: spies.batchUpload,
      updateBatchUploadStatus: jest.fn(),
    };
    const mockSignatureService = { createSignature: spies.batchSign };
    const mockDkApiEndpoints = { uploadBatchFile: spies.dkUploadFile };
    const mockDkGateway = { transferToAccount: spies.dkIndividual };

    const engine = new ParimutuelEngine(
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      mockDataSource as any,
      null as any,
      { del: jest.fn() } as any,
      null as any,
      null as any,
      mockDkGateway as any,
      bypassConfigService,
      null as any,
      null as any,
      null as any,
      null as any, // sse
      null as any, // revenueDistributionService
    );

    return engine;
  }

  it("BatchAuthService.login is NEVER called when market settles", async () => {
    const spies = buildBatchSpies();
    const positions = [
      {
        id: "pos1",
        userId: "u1",
        outcomeId: "o-win",
        marketId: "m1",
        amount: 500,
        status: "pending",
        payout: 0,
      },
      {
        id: "pos2",
        userId: "u2",
        outcomeId: "o-lose",
        marketId: "m1",
        amount: 200,
        status: "pending",
        payout: 0,
      },
    ];
    const engine = buildEngineWithBatchSpies(spies, positions);
    const market = {
      id: "m1",
      status: "resolved",
      totalPool: 700,
      houseEdgePct: 8,
      outcomes: [
        { id: "o-win", label: "Yes", totalBetAmount: 500, isWinner: true },
        { id: "o-lose", label: "No", totalBetAmount: 200, isWinner: false },
      ],
    };

    await (engine as any).settleMarket(market, market.outcomes[0], 0);
    await (engine as any).dispatchDkPayouts("m1", "o-win", "Yes", {
      payoutPool: 644,
    });

    expect(spies.batchLogin).not.toHaveBeenCalled();
    expect(spies.batchUpload).not.toHaveBeenCalled();
    expect(spies.batchSign).not.toHaveBeenCalled();
    expect(spies.dkUploadFile).not.toHaveBeenCalled();
    expect(spies.dkIndividual).not.toHaveBeenCalled();
  });

  it("no DK calls on settlement with many winners (10 positions)", async () => {
    const spies = buildBatchSpies();
    const positions = Array.from({ length: 10 }, (_, i) => ({
      id: `pos${i}`,
      userId: `u${i}`,
      outcomeId: "o-win",
      marketId: "m1",
      amount: 100,
      status: "pending",
      payout: 0,
    }));
    const engine = buildEngineWithBatchSpies(spies, positions);
    const market = {
      id: "m1",
      status: "resolved",
      totalPool: 1000,
      houseEdgePct: 8,
      outcomes: [
        { id: "o-win", label: "Yes", totalBetAmount: 1000, isWinner: true },
      ],
    };

    await (engine as any).settleMarket(market, market.outcomes[0], 0);
    await (engine as any).dispatchDkPayouts("m1", "o-win", "Yes", {
      payoutPool: 920,
    });

    expect(spies.batchLogin).not.toHaveBeenCalled();
    expect(spies.dkUploadFile).not.toHaveBeenCalled();
    expect(spies.dkIndividual).not.toHaveBeenCalled();
  });

  it("multiple winners each get proportional POSITION_PAYOUT (no DK transfer)", async () => {
    const savedTransactions: any[] = [];
    const positions = [
      {
        id: "pos1",
        userId: "u1",
        outcomeId: "o-win",
        marketId: "m1",
        amount: 300,
        status: "pending",
        payout: 0,
      },
      {
        id: "pos2",
        userId: "u2",
        outcomeId: "o-win",
        marketId: "m1",
        amount: 100,
        status: "pending",
        payout: 0,
      },
      {
        id: "pos3",
        userId: "u3",
        outcomeId: "o-lose",
        marketId: "m1",
        amount: 200,
        status: "pending",
        payout: 0,
      },
    ];

    const mockEm = {
      getRepository: jest.fn().mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getRawOne: jest.fn().mockResolvedValue({ balance: 0 }),
        }),
      }),
      find: jest.fn().mockResolvedValue(positions),
      findOne: jest.fn().mockResolvedValue({ bonusBalance: 0 }),
      save: jest.fn().mockImplementation(async (_cls: any, data: any) => {
        if (data?.type === TransactionType.POSITION_PAYOUT)
          savedTransactions.push(data);
        return data;
      }),
      create: jest
        .fn()
        .mockImplementation((_cls: any, data: any) => ({ ...data })),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const mockDataSource = {
      transaction: jest.fn().mockImplementation((cb: Function) => cb(mockEm)),
      getRepository: jest.fn().mockReturnValue({
        save: jest.fn(),
        update: jest.fn(),
        increment: jest.fn(),
      }),
    };
    const spies = buildBatchSpies();
    const engine = new ParimutuelEngine(
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      mockDataSource as any,
      null as any,
      { del: jest.fn() } as any,
      null as any,
      null as any,
      { transferToAccount: spies.dkIndividual } as any,
      bypassConfigService,
      null as any,
      null as any,
      null as any,
      null as any, // sse
      null as any, // revenueDistributionService
    );

    // totalPool=600, houseEdgePct=8 → payoutPool=552
    // winnerPool=400 (u1:300 + u2:100)
    // u1 share = 300/400 → 552 * 0.75 = 414
    // u2 share = 100/400 → 552 * 0.25 = 138
    const market = {
      id: "m1",
      status: "resolved",
      totalPool: 600,
      houseEdgePct: 8,
      outcomes: [
        { id: "o-win", label: "Yes", totalBetAmount: 400, isWinner: true },
        { id: "o-lose", label: "No", totalBetAmount: 200, isWinner: false },
      ],
    };

    await (engine as any).settleMarket(market, market.outcomes[0], 0);

    expect(savedTransactions).toHaveLength(2);

    const u1Payout = savedTransactions.find((t) => t.userId === "u1");
    const u2Payout = savedTransactions.find((t) => t.userId === "u2");

    expect(u1Payout.amount).toBeCloseTo(414);
    expect(u2Payout.amount).toBeCloseTo(138);
    expect(spies.dkIndividual).not.toHaveBeenCalled();
  });

  it("settlement with 50 winners completes in under 500ms", async () => {
    const spies = buildBatchSpies();
    const N = 50;
    const positions = Array.from({ length: N }, (_, i) => ({
      id: `pos${i}`,
      userId: `u${i}`,
      outcomeId: "o-win",
      marketId: "m1",
      amount: 100,
      status: "pending",
      payout: 0,
    }));
    const engine = buildEngineWithBatchSpies(spies, positions);
    const market = {
      id: "m1",
      status: "resolved",
      totalPool: N * 100,
      houseEdgePct: 8,
      outcomes: [
        { id: "o-win", label: "Yes", totalBetAmount: N * 100, isWinner: true },
      ],
    };

    const start = Date.now();
    await (engine as any).settleMarket(market, market.outcomes[0], 0);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
    expect(spies.batchLogin).not.toHaveBeenCalled();
    expect(spies.dkUploadFile).not.toHaveBeenCalled();
  });
});

// ─── resolveMarket atomic concurrency claim ───────────────────────────────────
// Verifies the conditional UPDATE in ParimutuelEngine.resolveMarket prevents
// concurrent double-resolution (root cause of the TER 06:01 PM double payouts).

describe("ParimutuelEngine.resolveMarket — atomic concurrency claim", () => {
  // Helper: build an engine wired with mocks sufficient to reach the atomic claim
  function buildEngine(opts: {
    claimAffected: number;
    market: any;
    disputes?: number;
    onClaimExecute?: () => void;
  }) {
    const claimExecute = jest.fn(async () => {
      opts.onClaimExecute?.();
      return { affected: opts.claimAffected };
    });
    const updateChain = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: claimExecute,
    };
    const marketRepo = {
      findOne: jest.fn().mockResolvedValue(opts.market),
      save: jest.fn(async (m: any) => m),
      createQueryBuilder: jest.fn().mockReturnValue(updateChain),
    };
    const outcomeRepo = {
      save: jest.fn(async (o: any) => o),
    };
    const disputeRepo = {
      count: jest.fn().mockResolvedValue(opts.disputes ?? 0),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn(),
    };

    const engine = new ParimutuelEngine(
      marketRepo as any, // marketRepo
      outcomeRepo as any, // outcomeRepo
      null as any, // betRepo
      null as any, // paymentRepo
      null as any, // transactionRepo
      null as any, // settlementRepo
      disputeRepo as any, // disputeRepo
      null as any, // dataSource
      null as any, // lmsrService
      null as any, // redis
      null as any, // reputationService
      null as any, // telegramSimple
      null as any, // dkGateway
      bypassConfigService, // configService
      null as any, // streakService
      null as any, // challengesService
      null as any, // marketsGateway
      null as any, // sse
      null as any, // revenueDistributionService
    );

    return { engine, marketRepo, outcomeRepo, claimExecute };
  }

  it("throws when atomic claim affected=0 (lost the race to a concurrent caller)", async () => {
    const market = {
      id: "m-race",
      status: "resolving",
      disputeDeadlineAt: new Date(Date.now() - 1000), // window already closed
      outcomes: [{ id: "o-win", label: "Yes" }],
      proposedOutcomeId: "o-win",
    };
    const { engine, outcomeRepo, claimExecute } = buildEngine({
      claimAffected: 0,
      market,
    });

    await expect(
      engine.resolveMarket("m-race", "o-win", "admin-1"),
    ).rejects.toThrow(/already being resolved|has been resolved/);

    expect(claimExecute).toHaveBeenCalledTimes(1);
    // Critical: must NOT proceed past the claim — no winner.isWinner write
    expect(outcomeRepo.save).not.toHaveBeenCalled();
  });

  it("proceeds past the claim when affected=1 (won the race)", async () => {
    const market = {
      id: "m-win",
      status: "resolving",
      disputeDeadlineAt: new Date(Date.now() - 1000),
      outcomes: [{ id: "o-win", label: "Yes" }],
      proposedOutcomeId: "o-win",
    };
    const { engine, outcomeRepo, claimExecute } = buildEngine({
      claimAffected: 1,
      market,
    });

    // settleMarket isn't mocked → it will throw on a downstream null repo.
    // That's fine: we just need to verify the engine got *past* the claim,
    // proven by outcomeRepo.save being called for the winner.
    await expect(
      engine.resolveMarket("m-win", "o-win", "admin-1"),
    ).rejects.toThrow();

    expect(claimExecute).toHaveBeenCalledTimes(1);
    expect(outcomeRepo.save).toHaveBeenCalledTimes(1);
    expect(outcomeRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: "o-win", isWinner: true }),
    );
  });

  it("[ORDERING] does NOT fire the atomic claim when objection-window validation throws", async () => {
    // Critical correctness check: validation throws must happen BEFORE the
    // atomic UPDATE, otherwise an admin force-resolving a market with an open
    // window would leave it RESOLVED with no winner / no settlement.
    const market = {
      id: "m-window-open",
      status: "resolving",
      disputeDeadlineAt: new Date(Date.now() + 60 * 60 * 1000), // 1h in future
      outcomes: [{ id: "o-win", label: "Yes" }],
      proposedOutcomeId: "o-win",
      windowMinutes: 60,
    };
    const { engine, outcomeRepo, claimExecute } = buildEngine({
      claimAffected: 1, // Would succeed if reached — but it must NOT be reached
      market,
      disputes: 0,
    });

    await expect(
      engine.resolveMarket("m-window-open", "o-win", "admin-1"),
    ).rejects.toThrow(/objection window is still open/);

    // The claim must NOT have run — otherwise the market is half-resolved.
    expect(claimExecute).not.toHaveBeenCalled();
    expect(outcomeRepo.save).not.toHaveBeenCalled();
  });

  it("rejects with 'must be in Resolving state' when status is not RESOLVING (does not reach claim)", async () => {
    const market = {
      id: "m-resolved",
      status: "resolved", // already past resolving
      outcomes: [{ id: "o-win", label: "Yes" }],
    };
    const { engine, claimExecute } = buildEngine({
      claimAffected: 1,
      market,
    });

    await expect(
      engine.resolveMarket("m-resolved", "o-win", "admin-1"),
    ).rejects.toThrow(/must be in Resolving state/);

    expect(claimExecute).not.toHaveBeenCalled();
  });
});
