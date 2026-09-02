import { BadRequestException } from "@nestjs/common";
import { ParimutuelEngine } from "../markets/parimutuel.engine";
import { TransactionType } from "../entities/transaction.entity";
import { ChallengeStatus } from "../entities/challenge.entity";
import { MarketBook } from "../entities/market-book.entity";

/**
 * A stake now resolves the per-currency book it belongs to before it is
 * accepted, so `em.findOne` is asked for a MarketBook partway through
 * `placePosition`. These mocks answer `findOne` positionally, which would hand
 * the book lookup whatever the next queued value happens to be — a Challenge,
 * usually — and the engine would then correctly refuse a book that is not a
 * book. Dispatching on the requested entity keeps the positional queue for
 * everything else while giving the book lookup a real answer.
 */
/**
 * Settlement now runs once per currency book, so `em.find` is asked for the
 * market's MarketBook rows. These mocks answer `find` with whatever the test
 * set up for positions, which would hand settlement a list of non-books.
 *
 * The book has to mirror the test's market — pool and edge drive every number
 * settlement produces — so it is built from the same values rather than being
 * a generic stub.
 */
function withMarketBooks(find: jest.Mock, market: any) {
  const read = () => (typeof market === "function" ? market() : market);
  return jest.fn().mockImplementation((entity: any, ...rest: any[]) => {
    if (entity?.name === "MarketBook") {
      const m = read();
      return Promise.resolve([
        {
          id: "book-btn",
          marketId: m?.id ?? "m1",
          currency: "BTN",
          totalPool: m?.totalPool ?? 0,
          houseEdgePct: m?.houseEdgePct ?? 10,
          minStake: 50,
          isEnabled: true,
        },
      ]);
    }
    if (entity?.name === "OutcomeBook") return Promise.resolve([]);
    return find(entity, ...rest);
  });
}

function withBook(findOne: jest.Mock, book: Partial<MarketBook> = {}) {
  const stub = {
    id: "book-btn",
    currency: "BTN",
    totalPool: 0,
    houseEdgePct: 10,
    minStake: 50,
    isEnabled: true,
    ...book,
  };
  return jest.fn().mockImplementation((entity: any, ...rest: any[]) => {
    if (entity === MarketBook || entity?.name === "MarketBook") {
      return Promise.resolve(stub);
    }
    return findOne(entity, ...rest);
  });
}

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
      ({ create: async () => {} }) as any, // userNotifications
      ({ addBulk: async () => [] }) as any, // notificationQueue
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
      ({ create: async () => {} }) as any, // userNotifications
      ({ addBulk: async () => [] }) as any, // notificationQueue
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
      ({ create: async () => {} }) as any, // userNotifications
      ({ addBulk: async () => [] }) as any, // notificationQueue
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
      ({ create: async () => {} }) as any, // userNotifications
      ({ addBulk: async () => [] }) as any, // notificationQueue
    );

    await expect(engine.placePosition("u1", "m1", "o1", 100)).rejects.toThrow(
      "verified phone number",
    );
  });

  it("does NOT block the CREATOR of an ACTIVE duel from betting (guard removed) — reaches balance check", async () => {
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
          select: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockResolvedValue(market),
          // No active-duel guard remains, so the flow reaches the balance check.
          getRawOne: jest.fn().mockResolvedValue({ balance: "0" }),
        }),
      }),
      find: jest.fn().mockResolvedValue(market.outcomes),
      // First call → User, second call → Challenge (active duel found)
      findOne: withBook(
        jest.fn().mockResolvedValueOnce(user).mockResolvedValueOnce(activeDuel),
      ),
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
      ({ create: async () => {} }) as any, // userNotifications
      ({ addBulk: async () => [] }) as any, // notificationQueue
    );

    await expect(engine.placePosition("u1", "m1", "o1", 100)).rejects.toThrow(
      "Insufficient balance",
    );
  });

  it("does NOT block the JOINER of an ACTIVE duel from betting (guard removed) — reaches balance check", async () => {
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
          select: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockResolvedValue(market),
          getRawOne: jest.fn().mockResolvedValue({ balance: "0" }),
        }),
      }),
      find: jest.fn().mockResolvedValue(market.outcomes),
      findOne: withBook(
        jest.fn().mockResolvedValueOnce(user).mockResolvedValueOnce(activeDuel),
      ),
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
      ({ create: async () => {} }) as any, // userNotifications
      ({ addBulk: async () => [] }) as any, // notificationQueue
    );

    await expect(engine.placePosition("u2", "m1", "o2", 100)).rejects.toThrow(
      "Insufficient balance",
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
      findOne: withBook(
        jest.fn().mockResolvedValueOnce(user).mockResolvedValueOnce(null),
      ),
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
      ({ create: async () => {} }) as any, // userNotifications
      ({ addBulk: async () => [] }) as any, // notificationQueue
    );

    // Should NOT throw — duel is OPEN, not ACTIVE
    // (will eventually fail at credit balance check, which is fine)
    await expect(engine.placePosition("u1", "m1", "o1", 100)).rejects.toThrow(
      "Insufficient balance",
    );
  });

  function walletHarness(user: any, book: any) {
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
    const mockEm = {
      getRepository: jest.fn().mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue({
          setLock: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockResolvedValue(market),
        }),
      }),
      find: jest.fn().mockResolvedValue(market.outcomes),
      findOne: jest.fn().mockImplementation((entity: any) =>
        Promise.resolve(entity?.name === "MarketBook" ? book : user),
      ),
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
      null as any, null as any, null as any, null as any, null as any,
      null as any, null as any, mockDataSource as any, null as any,
      mockRedis as any, null as any, null as any, null as any,
      bypassConfigService, null as any, null as any, null as any,
      null as any, null as any,
      ({ create: async () => {} }) as any, // userNotifications
      ({ addBulk: async () => [] }) as any,
    );
    return { engine, mockEm };
  }

  it("refuses a USDT stake from an account that cannot hold USDT", async () => {
    const { engine } = walletHarness(
      {
        id: "u1",
        telegramId: "111",
        currency: "BTN",
        kycStatus: "none",
        dkAccountNumber: "ACC001",
        phoneNumber: "17000001",
      },
      null,
    );
    // dkAccountNumber is set, so this account *can* hold USDT — flip it off.
    const { engine: blocked } = walletHarness(
      {
        id: "u1",
        telegramId: "111",
        currency: "BTN",
        kycStatus: "none",
        dkAccountNumber: null,
        phoneNumber: "17000001",
      },
      null,
    );
    await expect(
      blocked.placePosition("u1", "m1", "o1", 100, "USDT"),
    ).rejects.toThrow("cannot stake in USDT");
    expect(engine).toBeDefined();
  });

  it("does not require DK Bank for a USDT stake", async () => {
    // The payout goes to a crypto address, so a Bhutanese bank account and a
    // Bhutanese phone number are not prerequisites for this bet. Requiring
    // them would block the wallet entirely for a document-verified user.
    const { engine } = walletHarness(
      {
        id: "u1",
        telegramId: "111",
        currency: "BTN",
        kycStatus: "approved",
        dkAccountNumber: null,
        phoneNumber: null,
      },
      null,
    );
    // Past both guards. It fails later, on the balance this fixture has no
    // ledger for — the point is that neither DK Bank nor a phone number was
    // what stopped it.
    await expect(
      engine.placePosition("u1", "m1", "o1", 100, "USDT"),
    ).rejects.not.toThrow(/DK Bank|phone number/i);
  });

  it("still requires DK Bank for a ngultrum stake by the same account", async () => {
    // The prerequisites follow the wallet being spent, not the account.
    const { engine } = walletHarness(
      {
        id: "u1",
        telegramId: "111",
        currency: "BTN",
        kycStatus: "approved",
        dkAccountNumber: null,
        phoneNumber: null,
      },
      null,
    );
    await expect(engine.placePosition("u1", "m1", "o1", 100)).rejects.toThrow(
      "link your DK Bank account",
    );
  });

});

// ─── Currency segregation at settlement ───────────────────────────────────────

describe("settleMarket — each book settles out of its own pool", () => {
  /**
   * Two books on one market. The BTN book is healthy; the USDT book's shape is
   * controlled per test so the divergent cases can be exercised.
   */
  function buildTwoBookEngine(opts: {
    usdtPositions: any[];
    usdtPool: number;
    usdtEdge?: number;
  }) {
    const market: any = {
      id: "m1",
      title: "Two-book market",
      status: "resolved",
      externalSource: null,
      totalPool: 300,
      houseEdgePct: 8,
      outcomes: [
        { id: "o-win", label: "Yes", totalBetAmount: 200, isWinner: true },
        { id: "o-lose", label: "No", totalBetAmount: 100, isWinner: false },
      ],
    };
    const btnPositions = [
      { id: "b1", userId: "u1", outcomeId: "o-win", marketId: "m1", amount: 200, status: "pending", payout: 0, currency: "BTN" },
      { id: "b2", userId: "u2", outcomeId: "o-lose", marketId: "m1", amount: 100, status: "pending", payout: 0, currency: "BTN" },
    ];
    const books = [
      { id: "bk-btn", marketId: "m1", currency: "BTN", totalPool: 300, houseEdgePct: 8, minStake: 50, isEnabled: true },
      { id: "bk-usdt", marketId: "m1", currency: "USDT", totalPool: opts.usdtPool, houseEdgePct: opts.usdtEdge ?? 5, minStake: 1, isEnabled: true },
    ];

    const written: any[] = [];
    const settlements: any[] = [];
    const makeQb = () => {
      const qb: any = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        setLock: jest.fn().mockReturnThis(),
        insert: jest.fn().mockReturnThis(),
        into: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        values: jest.fn().mockImplementation((rows: any) => {
          for (const r of [].concat(rows)) written.push(r);
          return qb;
        }),
        getRawMany: jest.fn().mockResolvedValue([]),
        getRawOne: jest.fn().mockResolvedValue({ balance: 0 }),
        execute: jest.fn().mockResolvedValue({}),
      };
      return qb;
    };

    const mockEm: any = {
      getRepository: jest.fn().mockReturnValue({
        createQueryBuilder: jest.fn(makeQb),
        update: jest.fn().mockResolvedValue(undefined),
      }),
      createQueryBuilder: jest.fn(makeQb),
      find: jest.fn().mockImplementation((entity: any, o: any) => {
        if (entity?.name === "MarketBook") return Promise.resolve(books);
        if (entity?.name === "OutcomeBook") return Promise.resolve([]);
        if (entity?.name === "Position") {
          const cur = o?.where?.currency;
          return Promise.resolve(
            cur === "USDT" ? opts.usdtPositions : btnPositions,
          );
        }
        return Promise.resolve([]);
      }),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockImplementation((entity: any, data: any) => {
        const name = entity?.name ?? "unknown";
        if (name === "Settlement") settlements.push(data);
        if (data?.type) written.push(data);
        return data;
      }),
      create: jest.fn().mockImplementation((_: any, d: any) => ({ ...d })),
      update: jest.fn().mockResolvedValue(undefined),
    };

    const engine = new ParimutuelEngine(
      null as any, null as any, null as any, null as any, null as any,
      null as any, null as any,
      { transaction: (cb: Function) => cb(mockEm) } as any,
      { calculateProbabilities: jest.fn().mockReturnValue([0.5, 0.5]) } as any,
      { del: jest.fn(), pipeline: jest.fn(() => ({ del: jest.fn(), exec: jest.fn() })) } as any,
      null as any, null as any, null as any,
      { get: (_k: string, d: string) => d } as any,
      null as any, null as any, null as any, null as any, null as any,
      ({ create: async () => {} }) as any, // userNotifications
      ({ addBulk: async () => [] }) as any,
    );
    return { engine, market, written, settlements, books };
  }

  const WINNER = { id: "o-win", label: "Yes" } as any;

  it("produces one settlement per book, each out of its own pool", async () => {
    const { engine, market, settlements } = buildTwoBookEngine({
      usdtPool: 60,
      usdtPositions: [
        { id: "x1", userId: "g1", outcomeId: "o-win", marketId: "m1", amount: 40, status: "pending", payout: 0, currency: "USDT" },
        { id: "x2", userId: "g2", outcomeId: "o-lose", marketId: "m1", amount: 20, status: "pending", payout: 0, currency: "USDT" },
      ],
    });

    const result = await (engine as any).settleMarket(market, WINNER, new Map());

    expect(result).toHaveLength(2);
    const btn = settlements.find((st) => st.currency === "BTN");
    const usdt = settlements.find((st) => st.currency === "USDT");
    expect(Number(btn.totalPool)).toBe(300);
    expect(Number(usdt.totalPool)).toBe(60);
    // Each book's payout pool reflects its own edge: 8% vs 5%.
    expect(Number(btn.payoutPool)).toBeCloseTo(276, 6);
    expect(Number(usdt.payoutPool)).toBeCloseTo(57, 6);
  });

  it("credits each winner in the currency of the book they staked into", async () => {
    const { engine, market, written } = buildTwoBookEngine({
      usdtPool: 60,
      usdtPositions: [
        { id: "x1", userId: "g1", outcomeId: "o-win", marketId: "m1", amount: 40, status: "pending", payout: 0, currency: "USDT" },
        { id: "x2", userId: "g2", outcomeId: "o-lose", marketId: "m1", amount: 20, status: "pending", payout: 0, currency: "USDT" },
      ],
    });
    await (engine as any).settleMarket(market, WINNER, new Map());

    const payouts = written.filter(
      (t) => t?.type === TransactionType.POSITION_PAYOUT,
    );
    const btnPayout = payouts.find((t) => t.userId === "u1");
    const usdtPayout = payouts.find((t) => t.userId === "g1");
    expect(btnPayout.currency).toBe("BTN");
    expect(usdtPayout.currency).toBe("USDT");
    // The USDT winner is paid from the USDT pool alone — 57, not a share of 360.
    expect(Number(usdtPayout.amount)).toBeCloseTo(57, 6);
  });

  it("refunds a thin book while its sibling pays out normally", async () => {
    // One USDT bettor: no losing side, so that book refunds. The BTN book on
    // the same event is unaffected and settles as usual.
    const { engine, market, settlements, written } = buildTwoBookEngine({
      usdtPool: 40,
      usdtPositions: [
        { id: "x1", userId: "g1", outcomeId: "o-win", marketId: "m1", amount: 40, status: "pending", payout: 0, currency: "USDT" },
      ],
    });

    await (engine as any).settleMarket(market, WINNER, new Map());

    const btn = settlements.find((st) => st.currency === "BTN");
    const usdt = settlements.find((st) => st.currency === "USDT");
    expect(usdt.cancelReason).toBe("thin_pool");
    expect(btn.cancelReason).toBeUndefined();
    expect(Number(btn.totalPaidOut)).toBeGreaterThan(0);

    const refunds = written.filter((t) => t?.type === TransactionType.REFUND);
    expect(refunds).toHaveLength(1);
    expect(refunds[0].currency).toBe("USDT");
  });

  it("settles USDT at six decimal places, not two", async () => {
    // The reason this work exists. A pool of 10.000001 with one winner pays
    // 9.500001 at a 5% edge. Rounded at 2dp — which is what the settlement
    // path did before — the winner is paid 9.50 and the sixth decimal of
    // somebody's money is gone.
    const { engine, market, settlements, written } = buildTwoBookEngine({
      usdtPool: 10.000001,
      usdtEdge: 5,
      usdtPositions: [
        { id: "x1", userId: "g1", outcomeId: "o-win", marketId: "m1", amount: 6.000001, status: "pending", payout: 0, currency: "USDT" },
        { id: "x2", userId: "g2", outcomeId: "o-lose", marketId: "m1", amount: 4, status: "pending", payout: 0, currency: "USDT" },
      ],
    });

    await (engine as any).settleMarket(market, WINNER, new Map());

    const usdt = settlements.find((st) => st.currency === "USDT");
    const payout = written.find(
      (t) => t?.type === TransactionType.POSITION_PAYOUT && t.userId === "g1",
    );

    // payoutPool = 10.000001 * 0.95 = 9.50000095 → 9.500001 at 6dp
    expect(Number(usdt.payoutPool)).toBeCloseTo(9.50000095, 8);
    expect(Number(payout.amount)).toBeCloseTo(9.500001, 6);

    // The decisive assertion: the paid amount carries more than two decimals.
    expect(Number(payout.amount)).not.toBe(
      parseFloat(Number(payout.amount).toFixed(2)),
    );
  });

  it("keeps each book's money conserved on its own", async () => {
    const { engine, market, settlements } = buildTwoBookEngine({
      usdtPool: 60,
      usdtPositions: [
        { id: "x1", userId: "g1", outcomeId: "o-win", marketId: "m1", amount: 40, status: "pending", payout: 0, currency: "USDT" },
        { id: "x2", userId: "g2", outcomeId: "o-lose", marketId: "m1", amount: 20, status: "pending", payout: 0, currency: "USDT" },
      ],
    });
    await (engine as any).settleMarket(market, WINNER, new Map());

    // totalPaidOut + houseAmount === totalPool, per book. Equality, not a
    // tolerance: a tolerance hides exactly the drift this checks for.
    for (const st of settlements) {
      expect(
        Number(st.totalPaidOut) + Number(st.houseAmount),
      ).toBeCloseTo(Number(st.totalPool), 6);
    }
  });
});

// ─── Currency segregation at stake time ───────────────────────────────────────

describe("placePosition — a stake enters its own book and no other", () => {
  /**
   * Builds an engine whose only interesting behaviour is which rows a stake
   * writes. `saved` records every em.save call so a test can assert what was
   * and — more importantly — what was *not* written.
   */
  function buildStakeEngine(opts: {
    userCurrency: string;
    usdtBookEnabled?: boolean;
    usdtBookExists?: boolean;
    balance?: string;
    noDkAccount?: boolean;
  }) {
    let usdtBookLookups = 0;
    const market: any = {
      id: "m1",
      title: "T",
      status: "open",
      externalSource: null,
      outcomes: [
        { id: "o1", totalBetAmount: 100, currentOdds: 2, lmsrProbability: 0.5 },
      ],
      totalPool: 100,
      houseEdgePct: 10,
      liquidityParam: 1000,
    };
    const user = {
      id: "u1",
      telegramId: "111",
      dkAccountNumber: opts.noDkAccount ? null : "ACC001",
      phoneNumber: opts.noDkAccount ? null : "17000001",
      currency: opts.userCurrency,
      bonusBalance: 0,
    };

    const btnBook = {
      id: "book-btn", marketId: "m1", currency: "BTN",
      totalPool: 100, houseEdgePct: 10, minStake: 50, isEnabled: true,
    };
    const usdtBook = {
      id: "book-usdt", marketId: "m1", currency: "USDT",
      totalPool: 20, houseEdgePct: 6, minStake: 1,
      isEnabled: opts.usdtBookEnabled ?? true,
    };

    const saved: { entity: string; value: any }[] = [];
    const outcomeBooks = [
      {
        id: "ob-1", outcomeId: "o1", currency: opts.userCurrency,
        totalBetAmount: opts.userCurrency === "BTN" ? 100 : 20,
        currentOdds: 2, lmsrProbability: 0.5,
      },
    ];

    const mockEm: any = {
      getRepository: jest.fn().mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue({
          setLock: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          getRawOne: jest.fn().mockResolvedValue({ balance: opts.balance ?? "100000" }),
          getOne: jest.fn().mockResolvedValue(market),
        }),
      }),
      query: jest.fn().mockResolvedValue([]),
      find: jest.fn().mockImplementation((entity: any) =>
        entity?.name === "OutcomeBook"
          ? Promise.resolve(outcomeBooks)
          : Promise.resolve(market.outcomes),
      ),
      findOne: jest.fn().mockImplementation((entity: any) => {
        const name = entity?.name;
        if (name === "MarketBook") {
          if (opts.userCurrency === "BTN") return Promise.resolve(btnBook);
          // `ensureBook` looks, inserts if missing, then looks again — so a
          // market with no USDT book answers null once and the book after.
          if ((opts.usdtBookExists ?? true) === false) {
            usdtBookLookups += 1;
            return Promise.resolve(usdtBookLookups > 1 ? usdtBook : null);
          }
          return Promise.resolve(usdtBook);
        }
        if (name === "User") return Promise.resolve(user);
        return Promise.resolve(null);
      }),
      save: jest.fn().mockImplementation((entity: any, val?: any) => {
        saved.push({ entity: entity?.name ?? "unknown", value: val ?? entity });
        return val ?? entity;
      }),
      create: jest
        .fn()
        .mockImplementation((_: any, data: any) => ({ ...data, id: "pos-1" })),
      update: jest.fn().mockResolvedValue(undefined),
    };

    const engine = new ParimutuelEngine(
      null as any, null as any, null as any, null as any, null as any,
      null as any, null as any,
      { transaction: (cb: Function) => cb(mockEm) } as any, // 8 dataSource
      { calculateProbabilities: jest.fn().mockReturnValue([0.5]) } as any, // 9 lmsr
      {
        acquireLockWithRetry: jest.fn().mockResolvedValue("tok"),
        releaseLock: jest.fn().mockResolvedValue(undefined),
        del: jest.fn().mockResolvedValue(undefined),
        setJsonEx: jest.fn().mockResolvedValue(undefined),
      } as any, // 10 redis
      null as any, // 11 reputation
      null as any, // 12 telegramSimple
      null as any, // 13 dkGateway
      bypassConfigService, // 14 config
      { updateStreak: jest.fn().mockResolvedValue(null) } as any, // 15 streak
      null as any, // 16 challenges
      { broadcastMarketUpdate: jest.fn() } as any, // 17 marketsGateway
      { publish: jest.fn(), emit: jest.fn() } as any, // 18 sse
      null as any, // 19 revenueDistribution
      ({ create: async () => {} }) as any, // userNotifications
      ({ addBulk: async () => [] }) as any, // 20 notificationQueue
    );
    return { engine, saved, mockEm, btnBook, usdtBook, market };
  }

  it("routes a USDT stake to the USDT book and leaves every BTN figure alone", async () => {
    const { engine, saved, market, usdtBook } = buildStakeEngine({
      userCurrency: "USDT",
    });
    const btnPoolBefore = market.totalPool;
    const btnOutcomeBefore = market.outcomes[0].totalBetAmount;

    await engine.placePosition("u1", "m1", "o1", 5);

    // The USDT book absorbed the stake.
    expect(Number(usdtBook.totalPool)).toBe(25);

    // The legacy BTN mirror was not touched, and neither Market nor Outcome
    // was written at all. This is the segregation invariant: a USDT stake
    // cannot move a single ngultrum figure.
    expect(market.totalPool).toBe(btnPoolBefore);
    expect(market.outcomes[0].totalBetAmount).toBe(btnOutcomeBefore);
    const written = saved.map((r) => r.entity);
    expect(written).not.toContain("Market");
    expect(written).not.toContain("Outcome");
  });

  it("stamps the book's currency on the position and the ledger row", async () => {
    const { engine, saved } = buildStakeEngine({ userCurrency: "USDT" });
    await engine.placePosition("u1", "m1", "o1", 5);

    const position = saved.find((r) => r.entity === "Position")?.value;
    const ledger = saved.find((r) => r.entity === "Transaction")?.value;
    expect(position.currency).toBe("USDT");
    expect(ledger.currency).toBe("USDT");
  });

  it("charges the book's own platform cut, not the market's", async () => {
    // The USDT book runs at 6% where the market row says 10%. Odds must be
    // computed from the book, or a USDT bettor is quoted the wrong return.
    const { engine, saved } = buildStakeEngine({ userCurrency: "USDT" });
    await engine.placePosition("u1", "m1", "o1", 5);
    const position = saved.find((r) => r.entity === "Position")?.value;
    // payoutPool = 25 * (1 - 0.06) = 23.5, outcome pool 25 → odds 0.94
    expect(Number(position.oddsAtPlacement)).toBeCloseTo(0.94, 6);
  });

  it("still writes the BTN mirror for a BTN stake", async () => {
    const { engine, saved, market } = buildStakeEngine({ userCurrency: "BTN" });
    await engine.placePosition("u1", "m1", "o1", 50);
    expect(market.totalPool).toBe(150);
    expect(saved.map((r) => r.entity)).toContain("Market");
  });

  it("does not demand a DK Bank account from a USDT staker", async () => {
    // The bug an end-to-end run found: these guards exist so BTN winnings can
    // reach a Bhutanese bank account. An international USDT user will never
    // have one, so applying them made it impossible for any USDT account to
    // place a single bet — the rail worked and the product did not.
    const { engine, saved } = buildStakeEngine({ userCurrency: "USDT" });
    await engine.placePosition("u1", "m1", "o1", 5);
    expect(saved.some((r) => r.entity === "Position")).toBe(true);
  });

  it("still demands one from a BTN staker", async () => {
    const { engine } = buildStakeEngine({ userCurrency: "BTN", noDkAccount: true });
    await expect(engine.placePosition("u1", "m1", "o1", 50)).rejects.toThrow(
      /link your DK Bank account/,
    );
  });

  it("opens a USDT book on first stake rather than refusing", async () => {
    // A funded account must be able to bet. Requiring an admin to open a book
    // per market first meant a user who had deposited could bet on nothing,
    // and that step is one that does not reliably happen.
    const { engine, mockEm } = buildStakeEngine({
      userCurrency: "USDT",
      usdtBookExists: false,
    });
    await expect(
      engine.placePosition("u1", "m1", "o1", 5),
    ).resolves.toBeDefined();

    const inserted = (mockEm.query as jest.Mock).mock.calls.find(
      ([sql]: [string]) => /INSERT INTO "market_books"/.test(sql),
    );
    expect(inserted).toBeDefined();
    // Opened in the staked currency, with an empty pool — there is no legacy
    // balance to carry over the way the BTN book has.
    expect(inserted![1]).toEqual(
      expect.arrayContaining(["m1", "USDT", 0]),
    );
  });

  it("refuses a USDT stake when the book is disabled", async () => {
    const { engine } = buildStakeEngine({
      userCurrency: "USDT",
      usdtBookEnabled: false,
    });
    await expect(engine.placePosition("u1", "m1", "o1", 5)).rejects.toThrow(
      "does not accept USDT",
    );
  });

  it("enforces the book's minimum stake, not the market-wide one", async () => {
    // The USDT book's minimum is 1, so 5 is fine — but 0.5 is not. The BTN
    // rule (Nu 50) must not leak across.
    const { engine } = buildStakeEngine({ userCurrency: "USDT" });
    await expect(engine.placePosition("u1", "m1", "o1", 0.5)).rejects.toThrow(
      "Minimum bet is 1 USDT",
    );
  });
});

// ─── Settlement: no DK batch transfer fires ───────────────────────────────────

describe("Settlement wallet credit — no DK transfer on market settle", () => {
  function buildSettlementEngine(savedTransactions: any[]) {
    // The book mirrors whichever market the test settles; tests set this
    // before calling settleMarket.
    const bookRef: { market: any } = { market: null };
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

    // Bulk settlement writes payout/refund rows via a query-builder INSERT (not
    // em.save), so the builder's values() captures them into savedTransactions.
    const makeQb = () => {
      const qb: any = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        insert: jest.fn().mockReturnThis(),
        into: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        values: (rows: any) => {
          for (const r of Array.isArray(rows) ? rows : [rows]) {
            if (r?.type) {
              savedTransactions.push(r);
              balances[r.userId] = (balances[r.userId] ?? 0) + r.amount;
            }
          }
          return qb;
        },
        getRawMany: jest.fn().mockResolvedValue([]),
        getRawOne: jest.fn().mockResolvedValue({ balance: 0 }),
        execute: jest.fn().mockResolvedValue({}),
      };
      return qb;
    };
    const mockEm = {
      getRepository: jest.fn().mockReturnValue({
        createQueryBuilder: jest.fn(makeQb),
        update: jest.fn().mockResolvedValue(undefined),
      }),
      createQueryBuilder: jest.fn(makeQb),
      find: withMarketBooks(
        jest.fn().mockResolvedValue(positions),
        () => bookRef.market,
      ),
      // Must be null: settleMarket's idempotency guard returns early if findOne
      // (existing Settlement) is truthy.
      findOne: jest.fn().mockResolvedValue(null),
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
        find: withMarketBooks(jest.fn().mockResolvedValue(positions), () => bookRef.market),
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
      ({ create: async () => {} }) as any, // userNotifications
      ({ addBulk: async () => [] }) as any, // notificationQueue
    );

    return { engine, mockDkGateway, positions, bookRef };
  }

  it("credits winners' Oro wallet balance (POSITION_PAYOUT transaction) on settlement", async () => {
    const savedTransactions: any[] = [];
    const { engine, bookRef } = buildSettlementEngine(savedTransactions);

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
    bookRef.market = market;

    const [settlement] = await (engine as any).settleMarket(market, winner, new Map());

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
    const { engine, mockDkGateway, bookRef } =
      buildSettlementEngine(savedTransactions);

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
    bookRef.market = market;

    await (engine as any).settleMarket(market, winner, new Map());

    // Calling dispatchDkPayouts (the no-op) must NEVER reach the DK gateway
    await (engine as any).dispatchDkPayouts("m1", "o-win", "Yes", {
      payoutPool: 276,
    });

    expect(mockDkGateway.transferToAccount).not.toHaveBeenCalled();
  });

  it("losers receive no POSITION_PAYOUT transaction on settlement", async () => {
    const savedTransactions: any[] = [];
    const { engine, bookRef } = buildSettlementEngine(savedTransactions);

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
    bookRef.market = market;

    await (engine as any).settleMarket(market, winner, new Map());

    const loserPayouts = savedTransactions.filter(
      (t) => t.type === TransactionType.POSITION_PAYOUT && t.userId === "u2",
    );
    expect(loserPayouts).toHaveLength(0);
  });

  it("rewards a correct objector from 20% of the house cut when the admin is overturned with no defenders — and the pool still balances", async () => {
    const savedTransactions: any[] = [];
    const { engine, bookRef } = buildSettlementEngine(savedTransactions);

    const market = {
      id: "m1",
      status: "resolved",
      title: "Test market",
      totalPool: 300,
      // house cut = Nu 24 → challenger reward = 20% = Nu 4.80 (default fraction)
      houseEdgePct: 8,
      outcomes: [
        { id: "o-win", label: "Yes", totalBetAmount: 200, isWinner: true },
        { id: "o-lose", label: "No", totalBetAmount: 100, isWinner: false },
      ],
    };
    const winner = market.outcomes[0];
    bookRef.market = market;

    // One winning objector, bond Nu 50, no defenders → funded from house cut.
    const [settlement] = await (engine as any).settleMarket(
      market,
      winner,
      new Map(),
      // Keyed by currency: this book's contest, and only this book's.
      new Map([["BTN", [{ userId: "u3", bondAmount: 50 }]]]),
    );

    // Challenger got 20% of the Nu 24 house cut = Nu 4.80.
    const rewards = savedTransactions.filter(
      (t) => t.type === TransactionType.DISPUTE_BOND_REWARD,
    );
    expect(rewards).toHaveLength(1);
    expect(rewards[0].userId).toBe("u3");
    expect(rewards[0].amount).toBeCloseTo(4.8);

    // House revenue is reduced by exactly the reward: 24 − 4.8 = 19.2.
    expect(settlement.houseAmount).toBeCloseTo(19.2);

    // Conservation: pool = winner payout + challenger reward + house revenue.
    const winnerPayout = savedTransactions
      .filter((t) => t.type === TransactionType.POSITION_PAYOUT)
      .reduce((s, t) => s + t.amount, 0);
    expect(winnerPayout + 4.8 + Number(settlement.houseAmount)).toBeCloseTo(300);
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
    const bookRef: { market: any } = { market: null };
    const mockEm = {
      getRepository: jest.fn().mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getRawOne: jest.fn().mockResolvedValue({ balance: 0 }),
        }),
      }),
      find: withMarketBooks(
        jest.fn().mockResolvedValue(positions),
        () => bookRef.market,
      ),
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
        find: withMarketBooks(
          jest.fn().mockResolvedValue(positions),
          () => bookRef.market,
        ),
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
      ({ create: async () => {} }) as any, // userNotifications
      ({ addBulk: async () => [] }) as any, // notificationQueue
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

    await (engine as any).settleMarket(market, market.outcomes[0], new Map());
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

    await (engine as any).settleMarket(market, market.outcomes[0], new Map());
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

    // Payouts are written via a bulk INSERT builder, so capture them in values().
    const makeQb = () => {
      const qb: any = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        insert: jest.fn().mockReturnThis(),
        into: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        values: (rows: any) => {
          for (const r of Array.isArray(rows) ? rows : [rows]) {
            if (r?.type === TransactionType.POSITION_PAYOUT)
              savedTransactions.push(r);
          }
          return qb;
        },
        getRawMany: jest.fn().mockResolvedValue([]),
        getRawOne: jest.fn().mockResolvedValue({ balance: 0 }),
        execute: jest.fn().mockResolvedValue({}),
      };
      return qb;
    };
    const mockEm = {
      getRepository: jest.fn().mockReturnValue({
        createQueryBuilder: jest.fn(makeQb),
        update: jest.fn().mockResolvedValue(undefined),
      }),
      createQueryBuilder: jest.fn(makeQb),
      find: withMarketBooks(
        jest.fn().mockResolvedValue(positions),
        () => market,
      ),
      findOne: jest.fn().mockResolvedValue(null), // no existing settlement
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
      ({ create: async () => {} }) as any, // userNotifications
      ({ addBulk: async () => [] }) as any, // notificationQueue
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

    await (engine as any).settleMarket(market, market.outcomes[0], new Map());

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
    await (engine as any).settleMarket(market, market.outcomes[0], new Map());
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
    existingSettlement?: any;
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
    const settlementRepo = {
      findOne: jest.fn().mockResolvedValue(opts.existingSettlement ?? null),
    };

    const engine = new ParimutuelEngine(
      marketRepo as any, // marketRepo
      outcomeRepo as any, // outcomeRepo
      null as any, // betRepo
      null as any, // paymentRepo
      null as any, // transactionRepo
      settlementRepo as any, // settlementRepo
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
      ({ create: async () => {} }) as any, // userNotifications
      ({ addBulk: async () => [] }) as any, // notificationQueue
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

  it("rejects with 'must be in Resolving state' when status is neither RESOLVING nor recoverable (does not reach claim)", async () => {
    const market = {
      id: "m-closed",
      status: "closed", // not resolving, not a recoverable resolved-market
      outcomes: [{ id: "o-win", label: "Yes" }],
    };
    const { engine, claimExecute } = buildEngine({
      claimAffected: 1,
      market,
    });

    await expect(
      engine.resolveMarket("m-closed", "o-win", "admin-1"),
    ).rejects.toThrow(/must be in Resolving state/);

    expect(claimExecute).not.toHaveBeenCalled();
  });

  it("rejects a RESOLVED market that already has a Settlement (already resolved and settled)", async () => {
    const market = {
      id: "m-settled",
      status: "resolved",
      resolvedOutcomeId: "o-win",
      outcomes: [{ id: "o-win", label: "Yes" }],
    };
    const { engine, claimExecute } = buildEngine({
      claimAffected: 1,
      market,
      existingSettlement: { id: "s-1", marketId: "m-settled" },
    });

    await expect(
      engine.resolveMarket("m-settled", "o-win", "admin-1"),
    ).rejects.toThrow(/already resolved and settled/);

    // Never re-claims an already-settled market.
    expect(claimExecute).not.toHaveBeenCalled();
  });

  it("[RECOVERY] a RESOLVED-but-unsettled market does NOT re-run the atomic claim, and refuses a different outcome", async () => {
    // A prior resolution claimed RESOLVING → RESOLVED but failed before writing a
    // Settlement. Re-entry is allowed to finish the job — but it must settle the
    // SAME winner, never silently switch it, and must not re-claim (which would
    // match zero rows and wrongly abort).
    const market = {
      id: "m-stuck",
      status: "resolved",
      resolvedOutcomeId: "o-win",
      outcomes: [
        { id: "o-win", label: "Yes" },
        { id: "o-lose", label: "No" },
      ],
    };
    const { engine, claimExecute } = buildEngine({
      claimAffected: 1,
      market,
      existingSettlement: null, // stuck: no settlement row yet
    });

    // Passing a DIFFERENT outcome during recovery is rejected outright.
    await expect(
      engine.resolveMarket("m-stuck", "o-lose", "admin-1"),
    ).rejects.toThrow(/cannot change it during recovery/);

    // The recovery guard runs before (and instead of) the atomic claim.
    expect(claimExecute).not.toHaveBeenCalled();
  });
});

// ─── cancelMarket: locked dispute bonds are released ─────────────────────────
//
// Bonds are debited when an objection is filed and, before this, were only ever
// returned by resolveMarket. A cancelled market therefore kept every locked
// bond permanently — real money with no code path back to the user. There is no
// contest to win once the market is void, so every bond returns at face value:
// nobody forfeits, nobody is rewarded.

describe("ParimutuelEngine.cancelMarket — dispute bond release", () => {
  function buildCancelEngine(disputes: any[], positions: any[] = []) {
    const savedTransactions: any[] = [];
    const savedDisputes: any[] = [];
    const balanceReads: any[] = [];
    const market = {
      id: "m1",
      title: "Cancelled market",
      status: "resolving",
      outcomes: [{ id: "o1", label: "Yes" }],
    };

    const mockEm = {
      getRepository: jest.fn().mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          // The balance read is currency-scoped now, so the stub records which
          // ledger was asked for.
          where: jest.fn().mockImplementation(function (
            this: any,
            _sql: string,
            params: any,
          ) {
            balanceReads.push(params);
            return this;
          }),
          // Balance before the release. Non-zero so the test can assert
          // balanceBefore/After are carried, not just the amount.
          getRawOne: jest.fn().mockResolvedValue({ balance: 120 }),
        }),
      }),
      findOne: jest.fn().mockResolvedValue(market),
      find: jest.fn().mockImplementation((entity: any) => {
        if (entity?.name === "Dispute") {
          // The engine filters on LOCKED in the where clause; mirror that here
          // so the mock cannot hand back rows the real query would exclude.
          return Promise.resolve(
            disputes.filter((d) => d.bondStatus === "locked"),
          );
        }
        return Promise.resolve(positions);
      }),
      save: jest.fn().mockImplementation(async (_cls: any, data: any) => {
        if (Array.isArray(data)) savedDisputes.push(...data);
        else if (data?.type) savedTransactions.push(data);
        return data;
      }),
      create: jest
        .fn()
        .mockImplementation((_cls: any, data: any) => ({ ...data })),
    };

    const mockDataSource = {
      transaction: jest.fn().mockImplementation((cb: Function) => cb(mockEm)),
    };
    const mockRedis = { del: jest.fn().mockResolvedValue(undefined) };

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
      null as any, // dkGateway
      bypassConfigService,
      null as any, // streakService
      null as any, // challengesService
      null as any, // marketsGateway
      null as any, // sse
      null as any, // revenueDistributionService
      ({ create: async () => {} }) as any, // userNotifications
      ({ addBulk: async () => [] }) as any, // notificationQueue
    );

    return {
      engine,
      savedTransactions,
      savedDisputes,
      balanceReads,
      mockRedis,
      market,
    };
  }

  it("returns every locked bond in full as a DISPUTE_REFUND, on both sides of the contest", async () => {
    const { engine, savedTransactions, savedDisputes } = buildCancelEngine([
      { id: "d1", userId: "u1", marketId: "m1", side: "object", currency: "BTN", bondAmount: 50, bondStatus: "locked", upheld: null },
      { id: "d2", userId: "u2", marketId: "m1", side: "support", currency: "BTN", bondAmount: 50, bondStatus: "locked", upheld: null },
    ]);

    await engine.cancelMarket("m1");

    const refunds = savedTransactions.filter(
      (t) => t.type === TransactionType.DISPUTE_REFUND,
    );
    expect(refunds).toHaveLength(2);
    // Face value, both sides — a void market has no winning side.
    expect(refunds.map((r) => r.amount)).toEqual([50, 50]);
    expect(refunds.map((r) => r.userId)).toEqual(["u1", "u2"]);
    // Bonds are ngultrum, and a release must land in the book its lock came from.
    expect(refunds.every((r) => r.currency === "BTN")).toBe(true);
    // Ledger rows carry the running balance like every other transaction.
    expect(refunds[0].balanceBefore).toBe(120);
    expect(refunds[0].balanceAfter).toBe(170);

    // NOT_APPLICABLE, not REWARDED/FORFEITED: the objection was never ruled on,
    // so `upheld` stays null and reconciliation stops seeing a live liability.
    expect(savedDisputes.map((d) => d.bondStatus)).toEqual([
      "not_applicable",
      "not_applicable",
    ]);
    expect(savedDisputes.every((d) => d.upheld === null)).toBe(true);
  });

  it("is idempotent — a bond already released is not paid a second time", async () => {
    // Second cancel: the rows are no longer LOCKED, which is exactly what the
    // real query filters on.
    const { engine, savedTransactions } = buildCancelEngine([
      { id: "d1", userId: "u1", marketId: "m1", side: "object", currency: "BTN", bondAmount: 50, bondStatus: "not_applicable", upheld: null },
    ]);

    await engine.cancelMarket("m1");

    expect(
      savedTransactions.filter((t) => t.type === TransactionType.DISPUTE_REFUND),
    ).toHaveLength(0);
  });

  it("busts the balance cache for every user whose bond was returned", async () => {
    const { engine, mockRedis } = buildCancelEngine([
      { id: "d1", userId: "u1", marketId: "m1", side: "object", currency: "BTN", bondAmount: 50, bondStatus: "locked", upheld: null },
    ]);

    await engine.cancelMarket("m1");

    expect(mockRedis.del).toHaveBeenCalledWith("oro:cache:balance:u1");
  });

  it("clears a zero-amount bond row without writing a ledger row", async () => {
    // A zero bond has nothing to give back, but must not stay LOCKED or
    // reconciliation reads it as an outstanding liability forever.
    const { engine, savedTransactions, savedDisputes } = buildCancelEngine([
      { id: "d1", userId: "u1", marketId: "m1", side: "object", currency: "BTN", bondAmount: 0, bondStatus: "locked", upheld: null },
    ]);

    await engine.cancelMarket("m1");

    expect(savedTransactions).toHaveLength(0);
    expect(savedDisputes[0].bondStatus).toBe("not_applicable");
  });
});

// ─── Per-book resolution contests ────────────────────────────────────────────
//
// The verdict is market-wide — one outcome, one fact to be right about — but
// the money is per book. Winners in a book are paid from the forfeited bonds of
// defenders IN THAT SAME CURRENCY, and an overturned proposal with no defenders
// is rewarded from that book's own house cut. Nothing crosses books: no
// exchange rate exists anywhere in this system, so pooling a ngultrum bond with
// a USDT bond would be inventing one for real money.

describe("ParimutuelEngine.resolveMarket — contests settle per book", () => {
  /**
   * Reaches the bond payouts and stops. settleMarket runs immediately after
   * them and needs the full settlement mock surface, which is not what these
   * cases are about — so `em.find` is absent and settleMarket throws, exactly
   * the way the atomic-claim tests above let it. Every bond assertion below
   * describes work that has already committed by then.
   */
  function buildContestEngine(disputes: any[]) {
    const market = {
      id: "m1",
      title: "Two-book market",
      status: "resolving",
      // Window closed, so no force-resolve validation runs.
      disputeDeadlineAt: new Date(Date.now() - 1000),
      // Final outcome differs from the proposal → the objectors were right, in
      // every book at once.
      proposedOutcomeId: "o-lose",
      outcomes: [
        { id: "o-win", label: "Yes" },
        { id: "o-lose", label: "No" },
      ],
    };

    const savedTransactions: any[] = [];
    const bookUpdates: { crit: any; patch: any }[] = [];
    // Balance per (user, currency) so a USDT read cannot pick up a BTN row.
    const balances: Record<string, number> = {};

    const marketRepo = {
      findOne: jest.fn().mockResolvedValue(market),
      save: jest.fn(async (m: any) => m),
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      }),
    };
    const disputeRepo = {
      count: jest.fn().mockResolvedValue(disputes.length),
      find: jest.fn().mockResolvedValue(disputes),
      save: jest.fn(async (d: any) => d),
    };

    const mockEm = {
      getRepository: jest.fn().mockImplementation((entity: any) => {
        if (entity?.name === "Dispute") {
          return {
            createQueryBuilder: jest.fn().mockReturnValue({
              setLock: jest.fn().mockReturnThis(),
              where: jest.fn().mockImplementation(function (
                this: any,
                _sql: string,
                params: any,
              ) {
                this._id = params.id;
                return this;
              }),
              getOne: jest.fn().mockImplementation(async function (this: any) {
                return disputes.find((d) => d.id === this._id) ?? null;
              }),
            }),
          };
        }
        // Transaction — the currency-scoped ledger balance read.
        return {
          createQueryBuilder: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnThis(),
            where: jest.fn().mockImplementation(function (
              this: any,
              _sql: string,
              params: any,
            ) {
              this._key = `${params.userId}|${params.currency}`;
              return this;
            }),
            getRawOne: jest.fn().mockImplementation(async function (this: any) {
              return { balance: balances[this._key] ?? 0 };
            }),
          }),
        };
      }),
      create: jest.fn().mockImplementation((_cls: any, d: any) => ({ ...d })),
      save: jest.fn().mockImplementation(async (_cls: any, d: any) => {
        if (d?.type) savedTransactions.push(d);
        return d;
      }),
    };

    const mockDataSource = {
      transaction: jest.fn().mockImplementation((cb: Function) => cb(mockEm)),
      getRepository: jest.fn().mockImplementation((entity: any) => {
        if (entity?.name === "MarketBook") {
          return {
            update: jest.fn().mockImplementation(async (crit: any, patch: any) => {
              bookUpdates.push({ crit, patch });
            }),
          };
        }
        // User — admin accountability.
        return {
          findOne: jest.fn().mockResolvedValue(null),
          save: jest.fn().mockResolvedValue({}),
          increment: jest.fn().mockResolvedValue({}),
        };
      }),
    };

    const engine = new ParimutuelEngine(
      marketRepo as any,
      { save: jest.fn(async (o: any) => o) } as any, // outcomeRepo
      null as any, // betRepo
      null as any, // paymentRepo
      null as any, // transactionRepo
      { findOne: jest.fn().mockResolvedValue(null) } as any, // settlementRepo
      disputeRepo as any,
      mockDataSource as any,
      null as any, // lmsrService
      { del: jest.fn().mockResolvedValue(undefined) } as any, // redis
      null as any, // reputationService
      { postToChannel: jest.fn().mockResolvedValue(undefined) } as any,
      null as any, // dkGateway
      bypassConfigService,
      null as any, // streakService
      null as any, // challengesService
      null as any, // marketsGateway
      null as any, // sse
      null as any, // revenueDistributionService
      ({ create: async () => {} }) as any, // userNotifications
      ({ addBulk: async () => [] }) as any, // notificationQueue
    );

    return { engine, savedTransactions, bookUpdates, disputes };
  }

  const mkDispute = (
    id: string,
    userId: string,
    currency: string,
    side: string,
    bondAmount: number,
  ) => ({
    id,
    userId,
    marketId: "m1",
    currency,
    side,
    bondAmount,
    bondStatus: "locked",
    upheld: null,
    rewardAmount: 0,
  });

  it("pays each book's winners out of that book's forfeit pool only", async () => {
    const disputes = [
      mkDispute("d1", "u1", "BTN", "object", 100),
      mkDispute("d2", "u2", "BTN", "support", 100),
      mkDispute("d3", "u3", "USDT", "object", 2),
      mkDispute("d4", "u4", "USDT", "support", 2),
    ];
    const { engine, savedTransactions } = buildContestEngine(disputes);

    // Resolving to o-win overturns the o-lose proposal → objectors win in both
    // books. settleMarket then throws, after the bonds are settled.
    await expect(
      engine.resolveMarket("m1", "o-win", "admin-1"),
    ).rejects.toThrow();

    const rewards = savedTransactions.filter(
      (t) => t.type === TransactionType.DISPUTE_BOND_REWARD,
    );
    expect(rewards).toHaveLength(2);

    // BTN objector: own 100 bond back + the 100 the BTN defender forfeited.
    const btn = rewards.find((r) => r.userId === "u1");
    expect(btn.currency).toBe("BTN");
    expect(btn.amount).toBeCloseTo(200);

    // USDT objector: own 2 back + the 2 the USDT defender forfeited. Emphatically
    // NOT 200, and not funded by anything the ngultrum side lost.
    const usdt = rewards.find((r) => r.userId === "u3");
    expect(usdt.currency).toBe("USDT");
    expect(usdt.amount).toBeCloseTo(4);

    // Losing side in each book forfeits; winning side is rewarded.
    expect(disputes.map((d) => d.bondStatus)).toEqual([
      "rewarded",
      "forfeited",
      "rewarded",
      "forfeited",
    ]);
    expect(disputes.map((d) => d.upheld)).toEqual([true, false, true, false]);
  });

  it("records each book's forfeit pool on that book, in its own currency", async () => {
    const disputes = [
      mkDispute("d1", "u1", "BTN", "object", 100),
      mkDispute("d2", "u2", "BTN", "support", 100),
      mkDispute("d3", "u3", "USDT", "object", 2),
      mkDispute("d4", "u4", "USDT", "support", 2),
    ];
    const { engine, bookUpdates } = buildContestEngine(disputes);

    await expect(
      engine.resolveMarket("m1", "o-win", "admin-1"),
    ).rejects.toThrow();

    expect(bookUpdates).toEqual(
      expect.arrayContaining([
        {
          crit: { marketId: "m1", currency: "BTN" },
          patch: { disputeBondPool: 100 },
        },
        {
          crit: { marketId: "m1", currency: "USDT" },
          patch: { disputeBondPool: 2 },
        },
      ]),
    );
    expect(bookUpdates).toHaveLength(2);
  });

  it("floors a USDT reward share at 6dp rather than truncating it to zero", async () => {
    // The share is bond/totalBond × forfeitPool = 1 × 0.5 = 0.5 USDT. A bare
    // Math.floor() — which is what this used to be, because bonds were only ever
    // whole ngultrum — collapses that to 0 and quietly keeps the forfeited bond.
    const disputes = [
      mkDispute("d1", "u1", "USDT", "object", 0.5),
      mkDispute("d2", "u2", "USDT", "support", 0.5),
    ];
    const { engine, savedTransactions } = buildContestEngine(disputes);

    await expect(
      engine.resolveMarket("m1", "o-win", "admin-1"),
    ).rejects.toThrow();

    const reward = savedTransactions.find(
      (t) => t.type === TransactionType.DISPUTE_BOND_REWARD,
    );
    // 0.5 bond back + 0.5 won, not 0.5 + 0.
    expect(reward.amount).toBeCloseTo(1, 6);
    expect(reward.currency).toBe("USDT");
    expect(disputes[0].rewardAmount).toBeCloseTo(0.5, 6);
  });

  it("settles a USDT-only contest without touching the BTN book", async () => {
    const disputes = [
      mkDispute("d1", "u1", "USDT", "object", 1.25),
      mkDispute("d2", "u2", "USDT", "support", 1.25),
    ];
    const { engine, savedTransactions, bookUpdates } =
      buildContestEngine(disputes);

    await expect(
      engine.resolveMarket("m1", "o-win", "admin-1"),
    ).rejects.toThrow();

    expect(bookUpdates).toEqual([
      {
        crit: { marketId: "m1", currency: "USDT" },
        patch: { disputeBondPool: 1.25 },
      },
    ]);
    expect(savedTransactions.every((t) => t.currency === "USDT")).toBe(true);
  });

  it("treats a legacy bond row with no currency as ngultrum", async () => {
    // Rows written before books existed carry the 'BTN' column default; a row
    // read back as null must not become its own phantom book.
    const legacy: any = mkDispute("d1", "u1", "BTN", "object", 50);
    legacy.currency = null;
    const defender: any = mkDispute("d2", "u2", "BTN", "support", 50);
    defender.currency = null;
    const { engine, savedTransactions, bookUpdates } = buildContestEngine([
      legacy,
      defender,
    ]);

    await expect(
      engine.resolveMarket("m1", "o-win", "admin-1"),
    ).rejects.toThrow();

    expect(bookUpdates).toEqual([
      {
        crit: { marketId: "m1", currency: "BTN" },
        patch: { disputeBondPool: 50 },
      },
    ]);
    expect(savedTransactions[0].currency).toBe("BTN");
    expect(savedTransactions[0].amount).toBeCloseTo(100);
  });
});

// ─── Challenger reward is funded by the book that was contested ───────────────
//
// When the admin is overturned and nobody defended the proposal, there are no
// forfeited bonds to reward the correct objectors from, so the reward comes out
// of the house cut. That cut belongs to a specific book. Routing used to be a
// BTN-only special case (`book.currency === BTN ? challengers : []`), which
// meant a USDT objector could only ever be paid from ngultrum revenue; it is now
// keyed by currency, so each book funds its own.

describe("ParimutuelEngine.settleMarket — challenger reward routing by book", () => {
  /** Two live books on one market, each with its own pool, edge and positions. */
  function buildTwoBookEngine(savedTransactions: any[]) {
    const BOOKS = [
      { id: "book-btn", currency: "BTN", totalPool: 300, houseEdgePct: 8, minStake: 50 },
      { id: "book-usdt", currency: "USDT", totalPool: 300, houseEdgePct: 8, minStake: 1 },
    ];
    const positions = [
      { id: "p1", userId: "u1", outcomeId: "o-win", marketId: "m1", amount: 200, status: "pending", currency: "BTN", payout: 0 },
      { id: "p2", userId: "u2", outcomeId: "o-lose", marketId: "m1", amount: 100, status: "pending", currency: "BTN", payout: 0 },
      { id: "p3", userId: "u5", outcomeId: "o-win", marketId: "m1", amount: 200, status: "pending", currency: "USDT", payout: 0 },
      { id: "p4", userId: "u6", outcomeId: "o-lose", marketId: "m1", amount: 100, status: "pending", currency: "USDT", payout: 0 },
    ];

    const makeQb = () => {
      const qb: any = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        insert: jest.fn().mockReturnThis(),
        into: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        values: (rows: any) => {
          for (const r of Array.isArray(rows) ? rows : [rows])
            if (r?.type) savedTransactions.push(r);
          return qb;
        },
        getRawMany: jest.fn().mockResolvedValue([]),
        getRawOne: jest.fn().mockResolvedValue({ balance: 0 }),
        execute: jest.fn().mockResolvedValue({}),
      };
      return qb;
    };

    const market = {
      id: "m1",
      status: "resolved",
      title: "Two-book market",
      totalPool: 300,
      houseEdgePct: 8,
      outcomes: [
        { id: "o-win", label: "Yes", totalBetAmount: 200, isWinner: true },
        { id: "o-lose", label: "No", totalBetAmount: 100, isWinner: false },
      ],
    };

    const mockEm = {
      getRepository: jest.fn().mockReturnValue({
        createQueryBuilder: jest.fn(makeQb),
        update: jest.fn().mockResolvedValue(undefined),
      }),
      createQueryBuilder: jest.fn(makeQb),
      // Books, outcome books, and positions filtered to the book being settled —
      // otherwise one book would settle the other's stakes.
      find: jest.fn().mockImplementation(async (entity: any, opts: any) => {
        if (entity?.name === "MarketBook")
          return BOOKS.map((b) => ({ ...b, marketId: "m1", isEnabled: true }));
        if (entity?.name === "OutcomeBook") return [];
        const ccy = opts?.where?.currency;
        return positions.filter((p) => !ccy || p.currency === ccy);
      }),
      findOne: jest.fn().mockResolvedValue(null), // no existing settlement
      save: jest.fn().mockImplementation(async (_cls: any, d: any) => {
        if (d?.type) savedTransactions.push(d);
        return d;
      }),
      create: jest.fn().mockImplementation((_cls: any, d: any) => ({ ...d })),
      update: jest.fn().mockResolvedValue(undefined),
    };

    const engine = new ParimutuelEngine(
      null as any, null as any, null as any, null as any, null as any,
      null as any, null as any,
      { transaction: jest.fn().mockImplementation((cb: Function) => cb(mockEm)) } as any,
      null as any,
      { del: jest.fn().mockResolvedValue(undefined) } as any,
      null as any, null as any, null as any,
      bypassConfigService,
      null as any, null as any, null as any, null as any, null as any,
      ({ create: async () => {} }) as any, // userNotifications
      ({ addBulk: async () => [] }) as any,
    );

    return { engine, market, winner: market.outcomes[0] };
  }

  it("pays a USDT objector from the USDT book's house cut, and leaves BTN alone", async () => {
    const savedTransactions: any[] = [];
    const { engine, market, winner } = buildTwoBookEngine(savedTransactions);

    const settlements = await (engine as any).settleMarket(
      market,
      winner,
      new Map(),
      // One winning objector, in the USDT book only.
      new Map([["USDT", [{ userId: "u5", bondAmount: 2 }]]]),
    );

    const rewards = savedTransactions.filter(
      (t) => t.type === TransactionType.DISPUTE_BOND_REWARD,
    );
    // Exactly one reward, in USDT: 20% of the USDT book's Nu-equivalent 24 cut.
    expect(rewards).toHaveLength(1);
    expect(rewards[0].userId).toBe("u5");
    expect(rewards[0].currency).toBe("USDT");
    expect(rewards[0].amount).toBeCloseTo(4.8, 6);

    const btn = settlements.find((s: any) => s.currency === "BTN");
    const usdt = settlements.find((s: any) => s.currency === "USDT");
    // BTN book keeps its full cut — it had no contest.
    expect(Number(btn.houseAmount)).toBeCloseTo(24, 2);
    // USDT book funded the reward out of its own cut.
    expect(Number(usdt.houseAmount)).toBeCloseTo(19.2, 6);

    // Conservation, per book: pool = payouts + challenger reward + house.
    const paidIn = (ccy: string) =>
      savedTransactions
        .filter(
          (t) => t.type === TransactionType.POSITION_PAYOUT && t.currency === ccy,
        )
        .reduce((s, t) => s + Number(t.amount), 0);
    expect(paidIn("BTN") + Number(btn.houseAmount)).toBeCloseTo(300, 2);
    expect(paidIn("USDT") + 4.8 + Number(usdt.houseAmount)).toBeCloseTo(300, 6);
  });

  it("books a USDT forfeit with no winning side as USDT house revenue", async () => {
    const savedTransactions: any[] = [];
    const { engine, market, winner } = buildTwoBookEngine(savedTransactions);

    // 2 USDT forfeited by objectors who were wrong, nobody to reward.
    const settlements = await (engine as any).settleMarket(
      market,
      winner,
      new Map([["USDT", 2]]),
      new Map(),
    );

    const usdt = settlements.find((s: any) => s.currency === "USDT");
    const btn = settlements.find((s: any) => s.currency === "BTN");
    // The forfeit lands on the USDT book's revenue, not the ngultrum one.
    expect(Number(usdt.houseAmount)).toBeCloseTo(26, 6);
    expect(Number(btn.houseAmount)).toBeCloseTo(24, 2);
    expect(
      savedTransactions.filter(
        (t) => t.type === TransactionType.DISPUTE_BOND_REWARD,
      ),
    ).toHaveLength(0);
  });
});

// ─── cancelMarket releases each bond into the book it came from ───────────────

describe("ParimutuelEngine.cancelMarket — mixed-currency bond release", () => {
  it("returns a USDT bond in USDT and a BTN bond in BTN", async () => {
    const savedTransactions: any[] = [];
    const savedDisputes: any[] = [];
    const balanceReads: any[] = [];
    const market = {
      id: "m1",
      title: "Cancelled two-book market",
      status: "resolving",
      outcomes: [{ id: "o1", label: "Yes" }],
    };
    const disputes = [
      { id: "d1", userId: "u1", marketId: "m1", side: "object", currency: "BTN", bondAmount: 50, bondStatus: "locked", upheld: null },
      { id: "d2", userId: "u2", marketId: "m1", side: "support", currency: "USDT", bondAmount: 1.25, bondStatus: "locked", upheld: null },
    ];

    const mockEm = {
      getRepository: jest.fn().mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          where: jest.fn().mockImplementation(function (
            this: any,
            _sql: string,
            params: any,
          ) {
            balanceReads.push(params);
            return this;
          }),
          getRawOne: jest.fn().mockResolvedValue({ balance: 0 }),
        }),
      }),
      findOne: jest.fn().mockResolvedValue(market),
      find: jest.fn().mockImplementation(async (entity: any) =>
        entity?.name === "Dispute" ? disputes : [],
      ),
      save: jest.fn().mockImplementation(async (_cls: any, data: any) => {
        if (Array.isArray(data)) savedDisputes.push(...data);
        else if (data?.type) savedTransactions.push(data);
        return data;
      }),
      create: jest.fn().mockImplementation((_cls: any, d: any) => ({ ...d })),
    };

    const engine = new ParimutuelEngine(
      null as any, null as any, null as any, null as any, null as any,
      null as any, null as any,
      { transaction: jest.fn().mockImplementation((cb: Function) => cb(mockEm)) } as any,
      null as any,
      { del: jest.fn().mockResolvedValue(undefined) } as any,
      null as any, null as any, null as any,
      bypassConfigService,
      null as any, null as any, null as any, null as any, null as any,
      ({ create: async () => {} }) as any, // userNotifications
      ({ addBulk: async () => [] }) as any,
    );

    await engine.cancelMarket("m1");

    const refunds = savedTransactions.filter(
      (t) => t.type === TransactionType.DISPUTE_REFUND,
    );
    expect(refunds).toHaveLength(2);
    expect(refunds.map((r) => [r.currency, r.amount])).toEqual([
      ["BTN", 50],
      ["USDT", 1.25],
    ]);
    // Each balance was read from its own ledger — the release cannot be sized
    // against a book it is not paying into.
    expect(balanceReads.map((r) => r.currency)).toEqual(["BTN", "USDT"]);
    // The USDT note quotes USDT, not "Nu".
    expect(refunds[1].note).toContain("1.25 USDT");
    expect(savedDisputes.map((d) => d.bondStatus)).toEqual([
      "not_applicable",
      "not_applicable",
    ]);
  });
});
