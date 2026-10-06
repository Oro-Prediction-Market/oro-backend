import { AdminInsightsController } from "../admin/admin-insights.controller";

describe("AdminInsightsController.categoryRevenue", () => {
  function run(settled: any[], live: any[] = [], args: (string | undefined)[] = []) {
    const query = jest.fn().mockResolvedValueOnce(settled).mockResolvedValueOnce(live);
    const ctrl = new AdminInsightsController({ query } as any);
    return {
      promise: ctrl.categoryRevenue(args[0], args[1], args[2]),
      query,
    };
  }

  const row = (over: Record<string, unknown>) => ({
    category: "sports", subcategory: "epl-match",
    settled: 10, refunded: 0, pool: "10000", refundedPool: "0",
    edge: "1000", bonds: "0", paidOut: "9000", ...over,
  });

  it("nests subcategories under their category and totals them", async () => {
    const out = await run([
      row({ subcategory: "epl-match", pool: "10000", edge: "1000" }),
      row({ subcategory: "ucl-match", pool: "4000", edge: "400" }),
      row({ category: "economy", subcategory: "btc", pool: "500", edge: "50" }),
    ]).promise;

    expect(out.categories.map((c) => c.category)).toEqual(["sports", "economy"]);
    const sports = out.categories[0];
    expect(sports).toMatchObject({ pool: 14000, edge: 1400, edgePct: 10 });
    expect(sports.subcategories.map((s) => s.subcategory)).toEqual(["epl-match", "ucl-match"]);
    expect(out.totals).toMatchObject({ pool: 14500, edge: 1450 });
  });

  /** The SQL subtracts forfeits; the edge % must read the configured edge. */
  it("keeps forfeited bonds out of the edge and out of edge %", async () => {
    const out = await run([row({ pool: "900", edge: "90", bonds: "10" })]).promise;
    const sub = out.categories[0].subcategories[0];
    expect(sub).toMatchObject({ edge: 90, bonds: 10, edgePct: 10 });
  });

  it("computes edge as houseAmount minus houseForfeit, on non-cancelled settlements", async () => {
    const r = run([]);
    await r.promise;
    const sql: string = r.query.mock.calls[0][0];
    expect(sql).toContain(`SUM(s."houseAmount" - s."houseForfeit")`);
    expect(sql).toMatch(/AS edge/);
  });

  it("reports a refunded pool separately from the pool that was played", async () => {
    const out = await run([row({ settled: 2, refunded: 3, pool: "800", refundedPool: "1200" })]).promise;
    expect(out.categories[0]).toMatchObject({ settled: 2, refunded: 3, pool: 800, refundedPool: 1200 });
  });

  it("merges the live pool into the same category rows", async () => {
    const out = await run(
      [row({ subcategory: "epl-match" })],
      [
        { category: "sports", subcategory: "epl-match", markets: 4, pool: "2500" },
        { category: "sports", subcategory: "unl-match", markets: 9, pool: "7000" },
      ],
    ).promise;
    const sports = out.categories[0];
    expect(sports).toMatchObject({ livePool: 9500, liveMarkets: 13 });
    // A subcategory with only live money still appears.
    expect(sports.subcategories.find((s) => s.subcategory === "unl-match")).toMatchObject({
      pool: 0, livePool: 7000, edgePct: null,
    });
  });

  it("asks for one currency only, BTN by default", async () => {
    const a = run([]);
    await a.promise;
    expect(a.query.mock.calls[0][1][0]).toBe("BTN");
    expect(a.query.mock.calls[1][1]).toEqual(["BTN"]);

    const b = run([], [], [undefined, undefined, "USDT"]);
    await b.promise;
    expect(b.query.mock.calls[0][1][0]).toBe("USDT");

    const c = run([], [], [undefined, undefined, "BTN,USDT"]);
    await c.promise;
    expect(c.query.mock.calls[0][1][0]).toBe("BTN");
  });

  it("accepts Bhutan calendar days only, and either bound alone", async () => {
    const a = run([], [], ["2026-09-01", undefined]);
    await a.promise;
    expect(a.query.mock.calls[0][1]).toEqual(["BTN", "2026-09-01", null]);

    const b = run([], [], ["not-a-date", "2026-09-30; drop"]);
    await b.promise;
    expect(b.query.mock.calls[0][1]).toEqual(["BTN", null, null]);
  });

  it("makes the upper bound inclusive of its whole day", async () => {
    const r = run([]);
    await r.promise;
    expect(r.query.mock.calls[0][0]).toContain("< $3::date + 1");
  });
});
