import { ProbabilityHistoryService } from "../insights/probability-history.service";
import { MarketStatus } from "../entities/market.entity";

/**
 * The snapshot table is the public record of what the crowd thought and when.
 * Two properties matter: a market is captured as a whole distribution or not at
 * all, and an unchanged market writes nothing.
 */
describe("ProbabilityHistoryService", () => {
  function build(
    markets: any[],
    latestRows: any[] = [],
    moverRows: { first: any[]; last: any[] } = { first: [], last: [] },
  ) {
    const inserted: any[][] = [];
    const queries: string[] = [];

    const snapshotRepo: any = {
      insert: jest.fn(async (rows: any[]) => {
        inserted.push(rows);
      }),
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("ORDER BY") && sql.includes("capturedAt\" ASC")) {
          return moverRows.first;
        }
        if (sql.includes("capturedAt\" DESC")) {
          return sql.includes("totalPool") ? moverRows.last : latestRows;
        }
        return [];
      }),
      createQueryBuilder: () => {
        const qb: any = {
          where: () => qb,
          andWhere: () => qb,
          orderBy: () => qb,
          getMany: async () => [],
        };
        return qb;
      },
    };

    const marketRepo: any = {
      find: jest.fn(async () => markets),
      findOne: jest.fn(async ({ where }: any) =>
        markets.find((m) => m.id === where.id) ?? null,
      ),
    };
    const redis: any = {
      acquireLock: jest.fn().mockResolvedValue("t"),
      releaseLock: jest.fn().mockResolvedValue(undefined),
    };

    const svc = new ProbabilityHistoryService(snapshotRepo, marketRepo, redis);
    return { svc, inserted, snapshotRepo, marketRepo, redis };
  }

  const market = (id: string, probs: number[], pool = 1000) => ({
    id,
    title: `Question ${id}`,
    category: "sports",
    status: MarketStatus.OPEN,
    totalPool: pool,
    outcomes: probs.map((p, i) => ({
      id: `${id}-o${i}`,
      label: `Outcome ${i}`,
      lmsrProbability: p,
      sortOrder: i,
      isWinner: false,
    })),
  });

  it("captures every outcome of a market that has never been sampled", async () => {
    const { svc, inserted } = build([market("m1", [0.4, 0.6])]);

    const written = await svc.sample();

    expect(written).toBe(2);
    expect(inserted[0]).toHaveLength(2);
    expect(inserted[0].map((r) => r.probability)).toEqual([0.4, 0.6]);
    expect(inserted[0][0]).toMatchObject({ marketId: "m1", totalPool: 1000 });
  });

  it("writes nothing when no probability has moved beyond the epsilon", async () => {
    const { svc, inserted } = build(
      [market("m1", [0.4, 0.6])],
      [
        { marketId: "m1", outcomeId: "m1-o0", probability: "0.400000" },
        { marketId: "m1", outcomeId: "m1-o1", probability: "0.600000" },
      ],
    );

    expect(await svc.sample()).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it("writes the whole distribution when any single outcome moves", async () => {
    // o0 moved 10pp, o1 did not move at all — both must still be captured, or
    // the curve has a point on one line and a gap on the other.
    const { svc, inserted } = build(
      [market("m1", [0.5, 0.5])],
      [
        { marketId: "m1", outcomeId: "m1-o0", probability: "0.400000" },
        { marketId: "m1", outcomeId: "m1-o1", probability: "0.500000" },
      ],
    );

    expect(await svc.sample()).toBe(2);
    expect(inserted[0].map((r) => r.outcomeId)).toEqual(["m1-o0", "m1-o1"]);
  });

  it("ignores a move smaller than half a percentage point", async () => {
    const { svc } = build(
      [market("m1", [0.502, 0.498])],
      [
        { marketId: "m1", outcomeId: "m1-o0", probability: "0.500000" },
        { marketId: "m1", outcomeId: "m1-o1", probability: "0.500000" },
      ],
    );

    expect(await svc.sample()).toBe(0);
  });

  it("skips markets with no outcomes rather than writing an empty distribution", async () => {
    const { svc, inserted } = build([{ ...market("m1", []), outcomes: [] }]);

    expect(await svc.sample()).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it("appends the live probability so a curve always ends at the current number", async () => {
    const { svc } = build([market("m1", [0.73, 0.27])]);

    const history = await svc.getHistory("m1");

    expect(history).toHaveLength(2);
    expect(history[0].outcomeId).toBe("m1-o0");
    // No stored points in this fixture, so the only point is the live one.
    const points = history[0].points;
    expect(points[points.length - 1].probability).toBe(0.73);
  });

  it("reports one mover per market, the largest move, biggest first", async () => {
    const { svc } = build(
      [market("m1", [0.7, 0.3]), market("m2", [0.55, 0.45])],
      [],
      {
        first: [
          { marketId: "m1", outcomeId: "m1-o0", probability: "0.400000" },
          { marketId: "m1", outcomeId: "m1-o1", probability: "0.600000" },
          { marketId: "m2", outcomeId: "m2-o0", probability: "0.500000" },
        ],
        last: [
          {
            marketId: "m1",
            outcomeId: "m1-o0",
            probability: "0.700000",
            totalPool: "5000",
          },
          {
            marketId: "m1",
            outcomeId: "m1-o1",
            probability: "0.300000",
            totalPool: "5000",
          },
          {
            marketId: "m2",
            outcomeId: "m2-o0",
            probability: "0.550000",
            totalPool: "800",
          },
        ],
      },
    );

    const movers = await svc.getMovers({ hours: 24, minDelta: 0.05 });

    // m1 moved 30pp (both outcomes, one story); m2 moved 5pp.
    expect(movers).toHaveLength(2);
    expect(movers[0].marketId).toBe("m1");
    expect(movers[0].delta).toBeCloseTo(0.3, 5);
    expect(movers[0].title).toBe("Question m1");
    expect(movers[0].outcomeLabel).toBe("Outcome 0");
    expect(movers[1].marketId).toBe("m2");
  });

  it("drops moves below the reporting threshold", async () => {
    const { svc } = build([market("m1", [0.52, 0.48])], [], {
      first: [{ marketId: "m1", outcomeId: "m1-o0", probability: "0.500000" }],
      last: [
        {
          marketId: "m1",
          outcomeId: "m1-o0",
          probability: "0.520000",
          totalPool: "100",
        },
      ],
    });

    expect(await svc.getMovers({ minDelta: 0.05 })).toEqual([]);
  });

  it("does not sample when the cron lock is held", async () => {
    const { svc, redis, marketRepo } = build([market("m1", [0.4, 0.6])]);
    redis.acquireLock.mockResolvedValue(null);

    await svc.sampleOpenMarkets();

    expect(marketRepo.find).not.toHaveBeenCalled();
  });
});
