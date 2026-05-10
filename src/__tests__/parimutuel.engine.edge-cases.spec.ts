import { ParimutuelEngine } from "../markets/parimutuel.engine";
import { TransactionType } from "../entities/transaction.entity";
import { PositionStatus } from "../entities/position.entity";
import { MarketStatus } from "../entities/market.entity";

// ─── Mock factories ───────────────────────────────────────────────────────────

function makeEm(positions: any[]) {
  const saved: Array<[any, any]> = [];
  return {
    find: jest.fn().mockResolvedValue(positions),
    findOne: jest.fn().mockImplementation((_Entity: any, opts: any) => {
      const id = opts?.where?.id;
      return Promise.resolve(
        id
          ? { id, telegramId: "111", bonusBalance: "0", bonusRealPayoutRemaining: "0" }
          : null,
      );
    }),
    save: jest.fn().mockImplementation((_Entity: any, data: any) => {
      saved.push([_Entity, data]);
      return Promise.resolve(data);
    }),
    create: jest.fn().mockImplementation((_E: any, data: any) => ({ ...data })),
    update: jest.fn().mockResolvedValue({}),
    getRepository: jest.fn().mockReturnValue({
      createQueryBuilder: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ balance: "100" }),
      }),
    }),
    _saved: saved,
  };
}

function makeEngine(em: any, minUniqueBettors = 2) {
  const mockDataSource = {
    transaction: jest.fn().mockImplementation((cb: Function) => cb(em)),
  };
  const mockConfigService = {
    get: jest.fn().mockImplementation((key: string, def: string) => {
      if (key === "MIN_UNIQUE_BETTORS") return String(minUniqueBettors);
      // DK bypass flags (required by placePosition guards — not used in settleMarket)
      if (
        key === "DK_STAGING_PAYOUT_BYPASS" ||
        key === "DK_STAGING_DEPOSIT_BYPASS" ||
        key === "DK_STAGING_WITHDRAWAL_BYPASS"
      )
        return "true";
      return def;
    }),
    getOrThrow: jest.fn().mockReturnValue(""),
  };
  const mockTelegramSimple = {
    sendRefundNotification: jest.fn().mockResolvedValue(undefined),
    sendMessage: jest.fn().mockResolvedValue(undefined),
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
    null as any, // redis
    null as any, // reputationService
    mockTelegramSimple as any,
    null as any, // dkGateway
    mockConfigService as any,
    null as any, // streakService
    null as any, // challengesService
    null as any, // marketsGateway
    null as any, // sse
  );
  return { engine, telegramSimple: mockTelegramSimple, dataSource: mockDataSource };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const YES = { id: "o-yes", label: "YES", totalBetAmount: "200" };
const NO = { id: "o-no", label: "NO", totalBetAmount: "0" };

function mkMarket(totalPool = 200): any {
  return {
    id: "m1",
    title: "Test Market",
    status: MarketStatus.RESOLVING,
    totalPool: String(totalPool),
    houseEdgePct: "5",
    outcomes: [YES, NO],
  };
}

function mkPos(
  id: string,
  userId: string,
  outcomeId: string,
  amount = 100,
): any {
  return {
    id,
    userId,
    outcomeId,
    amount: String(amount),
    status: PositionStatus.PENDING,
    marketId: "m1",
  };
}

// ─── Thin-pool guard ──────────────────────────────────────────────────────────

describe("ParimutuelEngine — thin-pool guard (settleMarket)", () => {
  it("Scenario A: all bets on winning side → all REFUNDED, cancelReason=thin_pool, houseAmount=0", async () => {
    const positions = [mkPos("p1", "u1", "o-yes"), mkPos("p2", "u2", "o-yes")];
    const em = makeEm(positions);
    const { engine } = makeEngine(em);

    const settlement = await (engine as any).settleMarket(mkMarket(), YES, 0);

    const refundTxs = em._saved.filter(([, d]: any) => d?.type === TransactionType.REFUND);
    expect(refundTxs).toHaveLength(2);

    const lostPositions = em._saved.filter(([, d]: any) => d?.status === PositionStatus.LOST);
    expect(lostPositions).toHaveLength(0);

    expect(settlement.cancelReason).toBe("thin_pool");
    expect(settlement.houseAmount).toBe(0);
    expect(settlement.payoutPool).toBe(0);
    expect(settlement.totalPaidOut).toBe(0);
  });

  it("Scenario B: all bets on losing side → all REFUNDED, no LOST positions, no silent platform take", async () => {
    const positions = [mkPos("p1", "u1", "o-no"), mkPos("p2", "u2", "o-no")];
    const em = makeEm(positions);
    const { engine } = makeEngine(em);

    const settlement = await (engine as any).settleMarket(mkMarket(), YES, 0);

    const refundTxs = em._saved.filter(([, d]: any) => d?.type === TransactionType.REFUND);
    expect(refundTxs).toHaveLength(2);

    const lostPositions = em._saved.filter(([, d]: any) => d?.status === PositionStatus.LOST);
    expect(lostPositions).toHaveLength(0);

    // No POSITION_PAYOUT written — pool not silently kept as house revenue
    const payoutTxs = em._saved.filter(([, d]: any) => d?.type === TransactionType.POSITION_PAYOUT);
    expect(payoutTxs).toHaveLength(0);

    expect(settlement.cancelReason).toBe("thin_pool");
    expect(settlement.houseAmount).toBe(0);
  });

  it("single bettor on winning side → refunded, not paid out", async () => {
    const positions = [mkPos("p1", "u1", "o-yes")];
    const em = makeEm(positions);
    const { engine } = makeEngine(em);

    const settlement = await (engine as any).settleMarket(mkMarket(100), YES, 0);

    const refundTxs = em._saved.filter(([, d]: any) => d?.type === TransactionType.REFUND);
    expect(refundTxs).toHaveLength(1);
    expect(settlement.cancelReason).toBe("thin_pool");
  });

  it("should fully traverse lifecycle for empty market without errors or notifications", async () => {
    const em = makeEm([]);
    const { engine, telegramSimple } = makeEngine(em);

    const settlement = await (engine as any).settleMarket(mkMarket(0), YES, 0);

    // No DMs sent — nobody to notify
    expect(telegramSimple.sendRefundNotification).not.toHaveBeenCalled();

    // Settlement still written for audit trail
    expect(settlement.cancelReason).toBe("thin_pool");
    expect(settlement.totalPositions).toBe(0);
    expect(settlement.totalPaidOut).toBe(0);
  });

  it("refund Transaction carries full bet amount with zero fee deduction", async () => {
    const positions = [mkPos("p1", "u1", "o-yes", 150)];
    const em = makeEm(positions);
    const { engine } = makeEngine(em);

    await (engine as any).settleMarket(mkMarket(150), YES, 0);

    const refundTx = em._saved.find(
      ([, d]: any) => d?.type === TransactionType.REFUND,
    )?.[1];
    expect(refundTx).toBeDefined();
    expect(refundTx!.amount).toBe(150);
    // balanceAfter = balanceBefore + full stake (mocked balance = 100)
    expect(refundTx!.balanceAfter).toBe(250);
  });

  it("multi-entry single user: uniqueBettorIds uses Set semantics, guard fires at size < 2", async () => {
    // Same user places two bets — only counts as 1 unique bettor
    const positions = [
      mkPos("p1", "u1", "o-yes", 50),
      mkPos("p2", "u1", "o-yes", 50),
    ];
    const em = makeEm(positions);
    const { engine } = makeEngine(em);

    const settlement = await (engine as any).settleMarket(mkMarket(100), YES, 0);

    expect(settlement.cancelReason).toBe("thin_pool");

    const refundTxs = em._saved.filter(([, d]: any) => d?.type === TransactionType.REFUND);
    expect(refundTxs).toHaveLength(2); // both positions refunded
  });

  it("MIN_UNIQUE_BETTORS override: guard fires when bettor count < configured threshold", async () => {
    // Two distinct users — normally healthy, but threshold is set to 3
    const positions = [mkPos("p1", "u1", "o-yes"), mkPos("p2", "u2", "o-no")];
    const em = makeEm(positions);
    const { engine } = makeEngine(em, 3); // requires 3 unique bettors

    const settlement = await (engine as any).settleMarket(mkMarket(200), YES, 0);

    expect(settlement.cancelReason).toBe("thin_pool");
    const refundTxs = em._saved.filter(([, d]: any) => d?.type === TransactionType.REFUND);
    expect(refundTxs).toHaveLength(2);
  });

  it("TER 15-min market: single bettor on winning side refunded with thin_pool, no platform fee", async () => {
    const positions = [mkPos("p1", "u1", "o-yes", 100)];
    const em = makeEm(positions);
    const { engine, telegramSimple } = makeEngine(em);
    const market = { ...mkMarket(100), title: "TER 15m BTC/USD", externalSource: "ter" };

    const settlement = await (engine as any).settleMarket(market, YES, 0);

    expect(settlement.cancelReason).toBe("thin_pool");
    expect(settlement.totalPaidOut).toBe(0);
    expect(settlement.houseAmount).toBe(0);

    // Notification sent via sendRefundNotification, not raw sendMessage
    expect(telegramSimple.sendRefundNotification).toHaveBeenCalledWith(
      111,
      "TER 15m BTC/USD",
      100,
      "thin_pool",
    );
    expect(telegramSimple.sendMessage).not.toHaveBeenCalled();
  });
});

// ─── Happy-path regression ────────────────────────────────────────────────────

describe("ParimutuelEngine — healthy 50/50 pool (guard regression)", () => {
  it("guard does NOT fire: POSITION_PAYOUT written, loser marked LOST, no REFUND, no cancelReason", async () => {
    const positions = [
      mkPos("p1", "u1", "o-yes", 100), // winner
      mkPos("p2", "u2", "o-no", 100),  // loser
    ];
    const em = makeEm(positions);
    const { engine } = makeEngine(em);

    // totalBetAmount on winner outcome must reflect the actual winning-side pool
    const winner50 = { ...YES, totalBetAmount: "100" };
    const settlement = await (engine as any).settleMarket(mkMarket(200), winner50, 0);

    // Guard did NOT fire
    expect(settlement.cancelReason).toBeUndefined();

    // Winner paid out — payoutPool = 200 - 200*0.05 = 190
    const payoutTxs = em._saved.filter(
      ([, d]: any) => d?.type === TransactionType.POSITION_PAYOUT,
    );
    expect(payoutTxs).toHaveLength(1);
    expect(payoutTxs[0][1].amount).toBeCloseTo(190, 1);

    // No REFUND transactions
    const refundTxs = em._saved.filter(([, d]: any) => d?.type === TransactionType.REFUND);
    expect(refundTxs).toHaveLength(0);

    // Loser position set to LOST (not REFUNDED)
    expect(positions[1].status).toBe(PositionStatus.LOST);
  });
});

// ─── cancelMarket error propagation ──────────────────────────────────────────

describe("ParimutuelEngine.cancelMarket — error propagation", () => {
  it("propagates DB error thrown inside the transaction callback", async () => {
    const market = { id: "m1", status: MarketStatus.OPEN, outcomes: [] };
    const failingEm = {
      findOne: jest.fn().mockResolvedValue(market),
      save: jest.fn().mockRejectedValue(new Error("DB connection lost")),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation((_E: any, d: any) => d),
      getRepository: jest.fn().mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getRawOne: jest.fn().mockResolvedValue({ balance: "0" }),
        }),
      }),
    };
    const { engine } = makeEngine(failingEm);

    await expect(engine.cancelMarket("m1")).rejects.toThrow("DB connection lost");
  });
});
