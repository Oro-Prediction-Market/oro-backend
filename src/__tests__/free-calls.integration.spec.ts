import { ParimutuelEngine } from "../markets/parimutuel.engine";
import { FreeCallsService } from "../free-calls/free-calls.service";
import { FreeCallStatus } from "../entities/free-call.entity";
import { MarketStatus } from "../entities/market.entity";

/**
 * The wiring, not the arithmetic.
 *
 * free-calls.spec covers the scoring maths. These cover the joins that make it
 * actually happen in production: settlement invoking the scorer, and the
 * reconcile cron catching the markets settlement never reaches.
 */
describe("free calls — settlement wiring", () => {
  function buildEngine(freeCalls: any) {
    const engine = new ParimutuelEngine(
      null as any, // marketRepo
      null as any, // outcomeRepo
      { find: jest.fn().mockResolvedValue([]) } as any, // betRepo
      null as any, // paymentRepo
      null as any, // transactionRepo
      null as any, // settlementRepo
      null as any, // disputeRepo
      {
        getRepository: () => ({ findBy: jest.fn().mockResolvedValue([]) }),
      } as any, // dataSource
      null as any, // lmsrService
      null as any, // redis
      {
        recalculateForMarket: jest.fn().mockResolvedValue(undefined),
        recordContrarianOutcome: jest.fn().mockResolvedValue(undefined),
      } as any, // reputationService
      null as any, // telegramSimple
      null as any, // dkGateway
      { get: jest.fn() } as any, // configService
      null as any, // streakService
      null as any, // challengesService
      null as any, // marketsGateway
      null as any, // sse
      null as any, // revenueDistributionService
      { create: jest.fn().mockResolvedValue(undefined) } as any, // userNotifications
      { addBulk: jest.fn().mockResolvedValue([]) } as any, // notificationQueue
      freeCalls as any, // freeCallsService
    );
    return engine;
  }

  const market = { id: "m1", title: "Q", category: "sports" } as any;
  const winner = { id: "o2", label: "No" } as any;

  it("scores free calls against the winning outcome when a market settles", async () => {
    const freeCalls = {
      resolveForMarket: jest.fn().mockResolvedValue(3),
    };
    const engine = buildEngine(freeCalls);

    // The method is fire-and-forget in production and continues past our hook
    // into notification work these mocks do not satisfy; the hook itself is
    // what is under test.
    await (engine as any)
      .sendSettlementNotifications(market, winner, { id: "s1" })
      .catch(() => undefined);

    expect(freeCalls.resolveForMarket).toHaveBeenCalledTimes(1);
    expect(freeCalls.resolveForMarket).toHaveBeenCalledWith("m1", "o2");
  });

  it("does not let a free-call scoring failure break settlement notifications", async () => {
    const freeCalls = {
      resolveForMarket: jest
        .fn()
        .mockRejectedValue(new Error("free-call table is on fire")),
    };
    const engine = buildEngine(freeCalls);
    const logged: string[] = [];
    (engine as any).logger = {
      log: () => {},
      warn: () => {},
      debug: () => {},
      error: (m: string) => logged.push(m),
    };

    // Must not reject with the free-call error — it is caught and logged.
    await (engine as any)
      .sendSettlementNotifications(market, winner, { id: "s1" })
      .catch((err: Error) => {
        expect(err.message).not.toContain("free-call table is on fire");
      });

    expect(
      logged.some((m) => m.includes("free-call table is on fire")),
    ).toBe(true);
  });
});

describe("FreeCallsService.reconcilePendingCalls", () => {
  function build(opts: {
    stale?: { marketId: string }[];
    markets?: Record<string, any>;
    lock?: string | null;
  }) {
    const resolved: { marketId: string; winner: string | null }[] = [];

    const callRepo: any = {
      query: jest.fn(async () => opts.stale ?? []),
      find: jest.fn(async () => []),
      update: jest.fn(async () => ({ affected: 0 })),
      createQueryBuilder: () => {
        const qb: any = {
          select: () => qb,
          where: () => qb,
          andWhere: () => qb,
          orderBy: () => qb,
          addOrderBy: () => qb,
          take: () => qb,
          getMany: async () => [],
        };
        return qb;
      },
    };
    const marketRepo: any = {
      findOne: jest.fn(async ({ where }: any) => opts.markets?.[where.id] ?? null),
    };
    const redis: any = {
      acquireLock: jest
        .fn()
        .mockResolvedValue(opts.lock === undefined ? "t" : opts.lock),
      releaseLock: jest.fn().mockResolvedValue(undefined),
    };

    const svc = new FreeCallsService(
      callRepo,
      marketRepo,
      { count: jest.fn(async () => 0) } as any,
      { update: jest.fn(async () => undefined) } as any,
      { transaction: async (cb: Function) => cb({ getRepository: () => callRepo }) } as any,
      redis,
    );

    // Record what the reconcile pass decides, without re-testing scoring.
    jest
      .spyOn(svc, "resolveForMarket")
      .mockImplementation(async (marketId: string, winner: string | null) => {
        resolved.push({ marketId, winner });
        return 1;
      });

    return { svc, resolved, marketRepo, callRepo, redis };
  }

  const settled = (winnerId: string) => ({
    id: "m1",
    status: MarketStatus.SETTLED,
    outcomes: [
      { id: "o1", isWinner: false },
      { id: winnerId, isWinner: true },
    ],
  });

  it("scores a settled market's leftover calls against its winner", async () => {
    const { svc, resolved } = build({
      stale: [{ marketId: "m1" }],
      markets: { m1: settled("o2") },
    });

    await svc.reconcilePendingCalls();

    expect(resolved).toEqual([{ marketId: "m1", winner: "o2" }]);
  });

  it("voids calls on a cancelled market instead of marking anyone wrong", async () => {
    const { svc, resolved } = build({
      stale: [{ marketId: "m1" }],
      markets: {
        m1: {
          id: "m1",
          status: MarketStatus.CANCELLED,
          // A cancelled market can still carry a winner flag; it must be ignored.
          outcomes: [{ id: "o1", isWinner: true }],
        },
      },
    });

    await svc.reconcilePendingCalls();

    expect(resolved).toEqual([{ marketId: "m1", winner: null }]);
  });

  it("voids calls on a resolved market that somehow has no winner", async () => {
    const { svc, resolved } = build({
      stale: [{ marketId: "m1" }],
      markets: {
        m1: {
          id: "m1",
          status: MarketStatus.RESOLVED,
          outcomes: [{ id: "o1", isWinner: false }],
        },
      },
    });

    await svc.reconcilePendingCalls();

    expect(resolved).toEqual([{ marketId: "m1", winner: null }]);
  });

  it("keeps going when one market in the batch fails", async () => {
    const { svc, resolved } = build({
      stale: [{ marketId: "m1" }, { marketId: "m2" }],
      markets: { m1: settled("o2"), m2: { ...settled("o9"), id: "m2" } },
    });
    (svc.resolveForMarket as jest.Mock)
      .mockRejectedValueOnce(new Error("deadlock"))
      .mockImplementationOnce(async (marketId: string, winner: string | null) => {
        resolved.push({ marketId, winner });
        return 1;
      });

    await svc.reconcilePendingCalls();

    expect(resolved).toEqual([{ marketId: "m2", winner: "o9" }]);
  });

  it("skips a market row that has since disappeared", async () => {
    const { svc, resolved } = build({
      stale: [{ marketId: "gone" }],
      markets: {},
    });

    await svc.reconcilePendingCalls();

    expect(resolved).toEqual([]);
  });

  it("does nothing when nothing is pending", async () => {
    const { svc, marketRepo } = build({ stale: [] });

    await svc.reconcilePendingCalls();

    expect(marketRepo.findOne).not.toHaveBeenCalled();
  });

  it("does nothing when the cron lock is held", async () => {
    const { svc, callRepo } = build({ stale: [{ marketId: "m1" }], lock: null });

    await svc.reconcilePendingCalls();

    expect(callRepo.query).not.toHaveBeenCalled();
  });

  it("only ever claims pending rows on finished markets", async () => {
    const { svc, callRepo } = build({
      stale: [{ marketId: "m1" }],
      markets: { m1: settled("o2") },
    });

    await svc.reconcilePendingCalls();

    const sql = callRepo.query.mock.calls[0][0] as string;
    expect(sql).toContain("'pending'");
    expect(sql).toContain("'resolved', 'settled', 'cancelled'");
    // Bounded, so one bad batch cannot become an unbounded scan.
    expect(sql).toContain("LIMIT");
  });
});

describe("FreeCallsService.leaderboard", () => {
  function build(users: any[]) {
    const captured: { where: string[]; take: number | null } = {
      where: [],
      take: null,
    };
    const userRepo: any = {
      createQueryBuilder: () => {
        const qb: any = {
          select: () => qb,
          where: (w: string) => {
            captured.where.push(w);
            return qb;
          },
          andWhere: (w: string) => {
            captured.where.push(w);
            return qb;
          },
          orderBy: (f: string, d: string) => {
            captured.where.push(`ORDER ${f} ${d}`);
            return qb;
          },
          addOrderBy: () => qb,
          take: (n: number) => {
            captured.take = n;
            return qb;
          },
          getMany: async () => users,
        };
        return qb;
      },
      update: jest.fn(),
    };
    const svc = new FreeCallsService(
      { find: jest.fn(async () => []) } as any,
      {} as any,
      {} as any,
      userRepo,
      {} as any,
      { acquireLock: jest.fn(), releaseLock: jest.fn() } as any,
    );
    return { svc, captured };
  }

  it("ranks by Brier and derives accuracy per user", async () => {
    const { svc } = build([
      {
        id: "u1",
        firstName: "Karma",
        username: "karma",
        freeCallCount: 10,
        freeCallCorrect: 7,
        freeCallBrierScore: "0.1200",
      },
      {
        id: "u2",
        firstName: null,
        username: "sonam",
        freeCallCount: 8,
        freeCallCorrect: 4,
        freeCallBrierScore: "0.2400",
      },
    ]);

    const rows = await svc.leaderboard();

    expect(rows[0]).toEqual({
      rank: 1,
      userId: "u1",
      name: "Karma",
      calls: 10,
      correct: 7,
      accuracy: 0.7,
      brierScore: 0.12,
    });
    // Falls back to username when there is no first name.
    expect(rows[1].name).toBe("sonam");
    expect(rows[1].rank).toBe(2);
  });

  it("falls back to a neutral label when a user has no name at all", async () => {
    const { svc } = build([
      {
        id: "u1",
        firstName: "   ",
        username: null,
        freeCallCount: 5,
        freeCallCorrect: 1,
        freeCallBrierScore: "0.5000",
      },
    ]);

    const rows = await svc.leaderboard();

    expect(rows[0].name).toBe("Predictor");
  });

  it("requires a minimum number of calls and a real Brier score", async () => {
    const { svc, captured } = build([]);

    await svc.leaderboard();

    expect(captured.where.some((w) => w.includes("freeCallCount >= :min"))).toBe(
      true,
    );
    expect(
      captured.where.some((w) => w.includes("freeCallBrierScore IS NOT NULL")),
    ).toBe(true);
    // Lower Brier is better, so ascending.
    expect(
      captured.where.some((w) => w.includes("ORDER u.freeCallBrierScore ASC")),
    ).toBe(true);
  });

  it("clamps the page size", async () => {
    const { svc, captured } = build([]);

    await svc.leaderboard(5000);

    expect(captured.take).toBe(100);
  });
});
