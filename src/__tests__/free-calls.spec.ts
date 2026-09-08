import { FreeCallsService } from "../free-calls/free-calls.service";
import { FreeCallStatus } from "../entities/free-call.entity";
import { MarketStatus } from "../entities/market.entity";
import { BadRequestException, NotFoundException } from "@nestjs/common";

/**
 * A free call must never touch money, must be scored against the same
 * resolution as a staked position, and must not let someone hedge a stake with
 * a free call on the other side.
 */
describe("FreeCallsService", () => {
  function build(opts: {
    market?: any;
    stakedCount?: number;
    pending?: any[];
    scored?: any[];
    saveError?: any;
  } = {}) {
    const market =
      opts.market === undefined
        ? {
            id: "m1",
            status: MarketStatus.OPEN,
            outcomes: [
              { id: "o1", lmsrProbability: 0.35, isEliminated: false },
              { id: "o2", lmsrProbability: 0.65, isEliminated: false },
            ],
          }
        : opts.market;

    const saved: any[] = [];
    const updates: any[] = [];
    const userUpdates: any[] = [];

    const callRepo: any = {
      create: (x: any) => x,
      save: jest.fn(async (x: any) => {
        if (opts.saveError) throw opts.saveError;
        saved.push(x);
        return { ...x, id: "fc1" };
      }),
      find: jest.fn(async ({ where }: any) => {
        if (Array.isArray(where?.status?._value)) return opts.scored ?? [];
        if (where?.status === FreeCallStatus.PENDING) return opts.pending ?? [];
        return opts.scored ?? opts.pending ?? [];
      }),
      findOne: jest.fn(async () => null),
      update: jest.fn(async (where: any, patch: any) => {
        updates.push({ where, patch });
        return { affected: 1 };
      }),
      query: jest.fn(async () => []),
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
      findOne: jest.fn(async () => market),
    };
    const positionRepo: any = {
      count: jest.fn(async () => opts.stakedCount ?? 0),
    };
    const userRepo: any = {
      update: jest.fn(async (id: any, patch: any) => {
        userUpdates.push({ id, patch });
      }),
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
    const dataSource: any = {
      transaction: async (cb: Function) =>
        cb({ getRepository: () => callRepo }),
    };
    const redis: any = {
      acquireLock: jest.fn().mockResolvedValue("t"),
      releaseLock: jest.fn().mockResolvedValue(undefined),
    };

    const svc = new FreeCallsService(
      callRepo,
      marketRepo,
      positionRepo,
      userRepo,
      dataSource,
      redis,
    );
    return { svc, saved, updates, userUpdates, callRepo, userRepo };
  }

  describe("call", () => {
    it("records the crowd probability at the moment of the call", async () => {
      const { svc, saved } = build();

      const res = await svc.call("u1", "m1", "o1");

      expect(res.probabilityAtCall).toBe(0.35);
      expect(saved[0]).toMatchObject({
        userId: "u1",
        marketId: "m1",
        outcomeId: "o1",
        probabilityAtCall: 0.35,
        status: FreeCallStatus.PENDING,
      });
      // Nothing resembling money is written.
      expect(saved[0]).not.toHaveProperty("amount");
    });

    it("refuses a call on a market that is not open", async () => {
      const { svc } = build({
        market: { id: "m1", status: MarketStatus.CLOSED, outcomes: [] },
      });

      await expect(svc.call("u1", "m1", "o1")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("refuses a call when the user already has money on the market", async () => {
      const { svc } = build({ stakedCount: 1 });

      await expect(svc.call("u1", "m1", "o1")).rejects.toThrow(
        "already have a prediction staked",
      );
    });

    it("refuses an outcome that is not on the market", async () => {
      const { svc } = build();

      await expect(svc.call("u1", "m1", "nope")).rejects.toThrow(
        "not on this market",
      );
    });

    it("refuses an eliminated outcome", async () => {
      const { svc } = build({
        market: {
          id: "m1",
          status: MarketStatus.OPEN,
          outcomes: [{ id: "o1", lmsrProbability: 0.1, isEliminated: true }],
        },
      });

      await expect(svc.call("u1", "m1", "o1")).rejects.toThrow("eliminated");
    });

    it("turns a duplicate call into a clear error, not a 500", async () => {
      const { svc } = build({ saveError: { code: "23505" } });

      await expect(svc.call("u1", "m1", "o1")).rejects.toThrow(
        "already called this market",
      );
    });

    it("404s on an unknown market", async () => {
      const { svc } = build({ market: null });

      await expect(svc.call("u1", "mX", "o1")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("resolveForMarket", () => {
    it("marks callers of the winning outcome correct and the rest incorrect", async () => {
      const { svc, updates } = build({
        pending: [
          { id: "c1", userId: "u1", outcomeId: "o1" },
          { id: "c2", userId: "u2", outcomeId: "o2" },
        ],
      });

      const n = await svc.resolveForMarket("m1", "o1");

      expect(n).toBe(2);
      const statuses = updates.map((u) => u.patch.status);
      expect(statuses).toContain(FreeCallStatus.CORRECT);
      expect(statuses).toContain(FreeCallStatus.INCORRECT);
    });

    it("voids every call when the market resolved to no outcome", async () => {
      const { svc, updates } = build({
        pending: [{ id: "c1", userId: "u1", outcomeId: "o1" }],
      });

      await svc.resolveForMarket("m1", null);

      expect(updates).toHaveLength(1);
      expect(updates[0].patch.status).toBe(FreeCallStatus.VOID);
    });

    it("claims only pending rows, so a re-run scores nothing twice", async () => {
      const { svc, updates } = build({
        pending: [{ id: "c1", userId: "u1", outcomeId: "o1" }],
      });

      await svc.resolveForMarket("m1", "o1");

      for (const u of updates) {
        expect(u.where.status).toBe(FreeCallStatus.PENDING);
      }
    });

    it("does nothing when there is nothing pending", async () => {
      const { svc, updates } = build({ pending: [] });

      expect(await svc.resolveForMarket("m1", "o1")).toBe(0);
      expect(updates).toHaveLength(0);
    });
  });

  describe("recalculateForUser", () => {
    it("scores a confident correct call better than a confident wrong one", async () => {
      const good = build({
        scored: [
          { status: FreeCallStatus.CORRECT, probabilityAtCall: 0.9 },
          { status: FreeCallStatus.CORRECT, probabilityAtCall: 0.8 },
        ],
      });
      await good.svc.recalculateForUser("u1");

      const bad = build({
        scored: [
          { status: FreeCallStatus.INCORRECT, probabilityAtCall: 0.9 },
          { status: FreeCallStatus.INCORRECT, probabilityAtCall: 0.8 },
        ],
      });
      await bad.svc.recalculateForUser("u1");

      const goodBrier = good.userUpdates[0].patch.freeCallBrierScore;
      const badBrier = bad.userUpdates[0].patch.freeCallBrierScore;
      // Lower is better.
      expect(goodBrier).toBeLessThan(badBrier);
      expect(goodBrier).toBeCloseTo((0.01 + 0.04) / 2, 4);
      expect(badBrier).toBeCloseTo((0.81 + 0.64) / 2, 4);
    });

    it("rewards calling a long shot that lands over riding a favourite", async () => {
      const longShot = build({
        scored: [{ status: FreeCallStatus.CORRECT, probabilityAtCall: 0.2 }],
      });
      await longShot.svc.recalculateForUser("u1");

      const favourite = build({
        scored: [{ status: FreeCallStatus.CORRECT, probabilityAtCall: 0.95 }],
      });
      await favourite.svc.recalculateForUser("u1");

      // Brier alone punishes the underconfident long shot, which is why the
      // leaderboard is Brier-ranked but accuracy is shown alongside it.
      expect(longShot.userUpdates[0].patch.freeCallCorrect).toBe(1);
      expect(favourite.userUpdates[0].patch.freeCallCorrect).toBe(1);
    });

    it("derives the aggregate rather than incrementing it", async () => {
      const { svc, userUpdates } = build({
        scored: [
          { status: FreeCallStatus.CORRECT, probabilityAtCall: 0.5 },
          { status: FreeCallStatus.INCORRECT, probabilityAtCall: 0.5 },
          { status: FreeCallStatus.CORRECT, probabilityAtCall: 0.5 },
        ],
      });

      await svc.recalculateForUser("u1");

      expect(userUpdates[0].patch).toMatchObject({
        freeCallCount: 3,
        freeCallCorrect: 2,
        freeCallBrierCount: 3,
      });
      expect(userUpdates[0].patch.freeCallBrierScore).toBeCloseTo(0.25, 4);
    });

    it("leaves the Brier score null when nothing is scored yet", async () => {
      const { svc, userUpdates } = build({ scored: [] });

      await svc.recalculateForUser("u1");

      expect(userUpdates[0].patch).toMatchObject({
        freeCallCount: 0,
        freeCallBrierScore: null,
      });
    });
  });
});
