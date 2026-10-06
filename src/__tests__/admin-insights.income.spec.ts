import { AdminInsightsController } from "../admin/admin-insights.controller";

describe("AdminInsightsController.income", () => {
  /** First call answers the first-income lookup, second the buckets. */
  function run(
    rows: any[],
    opts: { period?: string; currency?: string; first?: string | null; today?: string } = {},
  ) {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        { first: opts.first === undefined ? "2026-05-04" : opts.first, today: opts.today ?? "2026-10-06" },
      ])
      .mockResolvedValueOnce(rows);
    return {
      promise: new AdminInsightsController({ query } as any).income(opts.period, opts.currency),
      query,
    };
  }

  it("adds edge, bonds and duel fees into each bucket and the range total", async () => {
    const out = await run([
      { start: "2026-09-28", edge: 1000.5, bonds: 40, duels: 20 },
      { start: "2026-10-05", edge: 250.25, bonds: 0, duels: 10 },
    ]).promise;

    expect(out.buckets.map((b) => b.total)).toEqual([1060.5, 260.25]);
    expect(out.totals).toEqual({ edge: 1250.75, bonds: 40, duels: 30, total: 1320.75 });
  });

  it("defaults to all time in BTN, starting from the first income", async () => {
    const { promise, query } = run([]);
    const out = await promise;
    expect(out).toMatchObject({ period: "all", currency: "BTN", bucket: "week" });
    expect(query.mock.calls[1][1]).toEqual(["BTN", "week", "2026-05-04", true]);
  });

  it("switches all time to months once the span passes a year", async () => {
    const { promise, query } = run([], { first: "2025-09-01", today: "2026-10-06" });
    expect((await promise).bucket).toBe("month");
    expect(query.mock.calls[1][1][1]).toBe("month");
  });

  it("keeps week and month to their own unit, clipped to the first income", async () => {
    const week = run([], { period: "week" });
    await week.promise;
    expect(week.query.mock.calls[1][1]).toEqual(["BTN", "week", "2026-05-04", false]);

    const month = run([], { period: "month", first: "2024-01-01" });
    expect((await month.promise).bucket).toBe("month");
    expect(month.query.mock.calls[1][1]).toEqual(["BTN", "month", "2024-01-01", false]);
  });

  it("only accepts BTN or USDT, never summing the two", async () => {
    const usdt = run([], { currency: "USDT" });
    expect((await usdt.promise).currency).toBe("USDT");
    expect(usdt.query.mock.calls[0][1]).toEqual(["USDT"]);
    expect(usdt.query.mock.calls[1][1][0]).toBe("USDT");

    const junk = run([], { currency: "BTN' OR 1=1" });
    expect((await junk.promise).currency).toBe("BTN");
  });

  it("rounds to the currency's precision", async () => {
    const out = await run(
      [{ start: "2026-10-05", edge: 0.1234567, bonds: 0.0000001, duels: 0 }],
      { currency: "USDT" },
    ).promise;
    expect(out.buckets[0].edge).toBe(0.123457);
    expect(out.buckets[0].total).toBe(0.123457);
  });

  it("marks only the newest bucket as in progress and labels by period", async () => {
    const out = await run([
      { start: "2026-09-28", edge: 1, bonds: 0, duels: 0 },
      { start: "2026-10-05", edge: 0, bonds: 0, duels: 0 },
    ]).promise;
    expect(out.buckets.map((b) => b.partial)).toEqual([false, true]);
    expect(out.buckets[0].label).toMatch(/^Week of 28 Sept? 2026$/);
  });

  it("dedupes settlements, skips cancelled ones, and takes duel fees from revenue_distributions", async () => {
    const { promise, query } = run([]);
    await promise;
    const sql: string = query.mock.calls[1][0];
    expect(sql).toMatch(/DISTINCT ON \(s\."marketId"\)/);
    expect(sql).toMatch(/"cancelReason" IS NULL/);
    expect(sql).toMatch(/"houseAmount" - "houseForfeit"/);
    expect(sql).toMatch(/revenue_distributions rd[\s\S]*"challengeId" IS NOT NULL/);
    expect(sql).toMatch(/AT TIME ZONE 'UTC' AT TIME ZONE 'Asia\/Thimphu'/);
  });
});
