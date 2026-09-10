import {
  ProbabilityHistoryService,
  smoothedShare,
} from "../insights/probability-history.service";
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
    positionRows: any[] = [],
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
          // Both DESC queries are DISTINCT ON over the same table; tell them
          // apart by what they filter on, not by which columns they select.
          // Keying on a column name silently reroutes the moment either query
          // selects one more field.
          return sql.includes('"marketId" = ANY') ? latestRows : moverRows.last;
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

    // Bets, for the derived-curve tests. `query` returns the aggregated
    // (instant, outcome, amount) rows deriveHistory asks Postgres for.
    const positionRepo: any = {
      query: jest.fn(async () => positionRows),
    };

    const svc = new ProbabilityHistoryService(
      snapshotRepo,
      marketRepo,
      positionRepo,
      redis,
    );
    return { svc, inserted, snapshotRepo, marketRepo, positionRepo, redis };
  }

  const market = (
    id: string,
    probs: number[],
    pool = 1000,
    pools?: number[],
  ) => ({
    id,
    title: `Question ${id}`,
    category: "sports",
    status: MarketStatus.OPEN,
    totalPool: pool,
    outcomes: probs.map((p, i) => ({
      id: `${id}-o${i}`,
      label: `Outcome ${i}`,
      lmsrProbability: p,
      totalBetAmount: pools?.[i],
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

  // ── The share gate ────────────────────────────────────────────────────────
  //
  // LMSR saturates on a lopsided book, so it is the wrong thing to threshold
  // on: it barely twitches through moves that visibly change the number the
  // apps print. Movement is measured on the smoothed share as well.

  it("captures a move the displayed share makes but LMSR does not", async () => {
    // Pools 5000/200 → a Nu 500 stake on the favourite. LMSR goes .9918→.9951
    // (0.33pp, under the epsilon) while the share goes .887→.896 (0.84pp).
    // The old LMSR-only gate wrote nothing here and the curve flatlined.
    const { svc, inserted } = build(
      [market("m1", [0.9951, 0.0049], 5700, [5500, 200])],
      [
        {
          marketId: "m1",
          outcomeId: "m1-o0",
          probability: "0.991800",
          totalPool: "5200",
          outcomePool: "5000",
        },
        {
          marketId: "m1",
          outcomeId: "m1-o1",
          probability: "0.008200",
          totalPool: "5200",
          outcomePool: "200",
        },
      ],
    );

    expect(await svc.sample()).toBe(2);
    expect(inserted[0][0]).toMatchObject({ outcomePool: 5500 });
    expect(inserted[0][1]).toMatchObject({ outcomePool: 200 });
  });

  it("still writes nothing when neither the share nor LMSR moved", async () => {
    const { svc, inserted } = build(
      [market("m1", [0.4, 0.6], 1000, [400, 600])],
      [
        {
          marketId: "m1",
          outcomeId: "m1-o0",
          probability: "0.400000",
          totalPool: "1000",
          outcomePool: "400",
        },
        {
          marketId: "m1",
          outcomeId: "m1-o1",
          probability: "0.600000",
          totalPool: "1000",
          outcomePool: "600",
        },
      ],
    );

    expect(await svc.sample()).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it("treats a legacy row with no outcomePool as unchanged, not as moved", async () => {
    // Rows written before the column existed must not force a write on every
    // tick forever — that would turn the table into a log of the cron running.
    const { svc } = build(
      [market("m1", [0.4, 0.6], 1000, [400, 600])],
      [
        { marketId: "m1", outcomeId: "m1-o0", probability: "0.400000" },
        { marketId: "m1", outcomeId: "m1-o1", probability: "0.600000" },
      ],
    );

    expect(await svc.sample()).toBe(0);
  });

  it("writes a zero outcome pool as 0, never NaN", async () => {
    // An outcome relation loaded without the column would make a bare
    // Number(undefined) into NaN, which Postgres rejects on insert.
    const { svc, inserted } = build([market("m1", [0.5, 0.5])]);

    await svc.sample();

    for (const row of inserted[0]) {
      expect(row.outcomePool).toBe(0);
      expect(Number.isNaN(row.outcomePool)).toBe(false);
    }
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

  // ── The derived curve ─────────────────────────────────────────────────────
  //
  // The snapshot table holds 431 rows and 1,864 of the 1,877 markets that have
  // been bet on have no row in it, so the curve is replayed from the bets
  // instead. Pools only ever grow, so the pool behind any past instant is the
  // sum of the stakes placed up to it.

  const bet = (t: number, outcomeId: string, amt: number) => ({
    t: String(t),
    outcomeId,
    amt: String(amt),
  });

  /** A market whose createdAt is fixed so t0 is assertable. */
  const dated = (id: string, probs: number[], pool: number, created: number) => ({
    ...market(id, probs, pool),
    createdAt: new Date(created),
  });

  /**
   * The same, finished. Used wherever the assertion is about the replay itself:
   * an open market correctly gains a trailing point at `now`, which would make
   * every timestamp array unassertable.
   */
  const finished = (
    id: string,
    probs: number[],
    pool: number,
    created: number,
  ) => ({ ...dated(id, probs, pool, created), status: MarketStatus.SETTLED });

  it("opens the curve at the even split, not at today's probability", async () => {
    // smoothedShare() returns its fallback when the pool is empty, so routing
    // the seed through it would draw the market's CURRENT number at its
    // creation — a curve that starts by lying about the past.
    const { svc } = build(
      [dated("m1", [0.9, 0.1], 1000, 1_000)],
      [],
      { first: [], last: [] },
      [bet(5_000, "m1-o0", 900), bet(5_000, "m1-o1", 100)],
    );

    const series = await svc.deriveHistory("m1");

    expect(series[0].points[0]).toEqual({ t: 1_000, p: 0.5 });
    expect(series[1].points[0]).toEqual({ t: 1_000, p: 0.5 });
  });

  it("replays the pools so every instant sums to 100%", async () => {
    const { svc } = build(
      [finished("m1", [0.6, 0.4], 3000, 1_000)],
      [],
      { first: [], last: [] },
      [
        bet(2_000, "m1-o0", 1000),
        bet(3_000, "m1-o1", 500),
        bet(4_000, "m1-o0", 1500),
      ],
    );

    const series = await svc.deriveHistory("m1");

    // t0 plus one vertex per distinct instant.
    expect(series[0].points.map((p) => p.t)).toEqual([1_000, 2_000, 3_000, 4_000]);
    for (let i = 0; i < 4; i++) {
      const sum = series.reduce((a, s) => a + s.points[i].p, 0);
      expect(sum).toBeCloseTo(1, 6);
    }
    // After the first Nu 1000 on o0: (1000 + 500) / (1000 + 1000) = 0.75.
    expect(series.find((s) => s.outcomeId === "m1-o0")!.points[1].p).toBeCloseTo(
      0.75,
      6,
    );
  });

  it("treats stakes sharing an instant as one vertex", async () => {
    // Two bets in the same millisecond moved the same denominator; emitting a
    // point between them would draw a distribution that never existed.
    const { svc } = build(
      [finished("m1", [0.5, 0.5], 2000, 1_000)],
      [],
      { first: [], last: [] },
      [bet(9_000, "m1-o0", 1000), bet(9_000, "m1-o1", 1000)],
    );

    const series = await svc.deriveHistory("m1");

    expect(series[0].points.map((p) => p.t)).toEqual([1_000, 9_000]);
    expect(series[0].points[1].p).toBeCloseTo(0.5, 6);
  });

  it("returns nothing for a market nobody has bet on", async () => {
    const { svc } = build([dated("m1", [0.5, 0.5], 0, 1_000)]);

    expect(await svc.deriveHistory("m1")).toEqual([]);
  });

  it("does not drag a settled market's price across to today", async () => {
    const settled = {
      ...dated("m1", [0.5, 0.5], 2000, 1_000),
      status: MarketStatus.SETTLED,
    };
    const { svc } = build([settled], [], { first: [], last: [] }, [
      bet(9_000, "m1-o0", 2000),
    ]);

    const series = await svc.deriveHistory("m1");

    // Last point is the last bet, not `now`.
    expect(series[0].points[series[0].points.length - 1].t).toBe(9_000);
  });

  it("ends an open market on the live number", async () => {
    const { svc } = build(
      [dated("m1", [0.5, 0.5], 2000, 1_000)],
      [],
      { first: [], last: [] },
      [bet(9_000, "m1-o0", 2000)],
    );

    const series = await svc.deriveHistory("m1");
    const points = series[0].points;

    expect(points[points.length - 1].t).toBeGreaterThan(9_000);
  });

  it("keeps every outcome on one shared set of timestamps", async () => {
    // Each bet moves one numerator and every denominator, so the lines share
    // their vertices — and a tooltip reads them all at one instant.
    const { svc } = build(
      [dated("m1", [0.4, 0.6], 2500, 1_000)],
      [],
      { first: [], last: [] },
      [bet(2_000, "m1-o0", 1000), bet(3_000, "m1-o1", 1500)],
    );

    const series = await svc.deriveHistory("m1");
    const first = series[0].points.map((p) => p.t);
    for (const s of series) {
      expect(s.points.map((p) => p.t)).toEqual(first);
    }
  });

  it("caps a busy market without moving its endpoints", async () => {
    const bets = Array.from({ length: 600 }, (_, k) =>
      bet(10_000 + k * 1_000, k % 2 === 0 ? "m1-o0" : "m1-o1", 100),
    );
    const { svc } = build(
      [finished("m1", [0.5, 0.5], 60_000, 1_000)],
      [],
      { first: [], last: [] },
      bets,
    );

    const series = await svc.deriveHistory("m1");

    expect(series[0].points.length).toBeLessThanOrEqual(200);
    expect(series[0].points[0].t).toBe(1_000);
    // Still ends where the replay ended, and still shares one x-axis.
    expect(series[0].points.map((p) => p.t)).toEqual(
      series[1].points.map((p) => p.t),
    );
  });

  it("windows what it emits without restarting the pools", async () => {
    // Filtering the bets instead of the points would replay a market older
    // than the window from an empty pool and end it on the wrong number.
    const now = Date.now();
    const { svc } = build(
      [dated("m1", [0.5, 0.5], 2000, now - 100 * 3600_000)],
      [],
      { first: [], last: [] },
      [
        bet(now - 90 * 3600_000, "m1-o0", 1000),
        bet(now - 1 * 3600_000, "m1-o1", 1000),
      ],
    );

    const windowed = await svc.deriveHistory("m1", { hours: 24 });
    const full = await svc.deriveHistory("m1");

    // The old bet is outside the window but its money is not: both curves end
    // on the same value.
    const lastOf = (s: any[]) =>
      s[0].points[s[0].points.length - 1].p;
    expect(lastOf(windowed)).toBeCloseTo(lastOf(full), 6);
    expect(windowed[0].points.length).toBeLessThan(full[0].points.length);
  });

  it("does not sample when the cron lock is held", async () => {
    const { svc, redis, marketRepo } = build([market("m1", [0.4, 0.6])]);
    redis.acquireLock.mockResolvedValue(null);

    await svc.sampleOpenMarkets();

    expect(marketRepo.find).not.toHaveBeenCalled();
  });
});

/**
 * The number the chart plots must be the number the outcome row prints.
 *
 * `smoothedShare` is a third copy of a formula that also lives in each app's
 * `calcProb`. They cannot import from each other, so this test pins the shape:
 * if someone changes the prior here, or in a frontend, this is what should
 * fail. The figures come from a real market — pools 3675/4200 of 7875 — where
 * the stored LMSR reads 37.2% and every screen shows 47.0%.
 */
describe("smoothedShare", () => {
  const calcProbInTheApps = (pool: number, total: number, n: number) =>
    (pool + 1000 / n) / (total + 1000);

  it("reproduces what the apps display, not the stored LMSR", () => {
    expect(smoothedShare(3675, 7875, 2, 0.371684)).toBeCloseTo(
      calcProbInTheApps(3675, 7875, 2),
      12,
    );
    expect(smoothedShare(3675, 7875, 2, 0.371684)).toBeCloseTo(0.4704, 4);
    // The value it must NOT return.
    expect(smoothedShare(3675, 7875, 2, 0.371684)).not.toBeCloseTo(0.3717, 3);
  });

  it("falls back to the LMSR value when the pool is empty", () => {
    // An untouched book has no share to compute; softmax is the honest split.
    expect(smoothedShare(0, 0, 2, 0.5)).toBe(0.5);
  });

  it("falls back when the point predates the outcomePool column", () => {
    expect(smoothedShare(null, 7875, 2, 0.371684)).toBe(0.371684);
  });

  it("treats a zero pool as real, not as unknown", () => {
    // 0 is a legitimate outcome pool: nobody has backed it yet.
    expect(smoothedShare(0, 7875, 2, 0.371684)).toBeCloseTo(
      calcProbInTheApps(0, 7875, 2),
      12,
    );
  });
});
