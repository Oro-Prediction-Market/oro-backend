import { AdminInsightsController } from "../admin/admin-insights.controller";

describe("AdminInsightsController.signups", () => {
  function run(rows: any[], period?: string, count?: string) {
    const query = jest.fn().mockResolvedValue(rows);
    return {
      promise: new AdminInsightsController({ query } as any).signups(period, count),
      query,
    };
  }

  it("folds provider rows into one bucket each, with a provider split", async () => {
    const out = await run([
      { start: "2026-09-21", provider: "telegram", count: 7 },
      { start: "2026-09-21", provider: "bhutanapp", count: 3 },
      { start: "2026-09-21", provider: "google", count: 4 },
      { start: "2026-09-28", provider: "telegram", count: 2 },
    ]).promise;

    expect(out.buckets).toHaveLength(2);
    expect(out.buckets[0]).toMatchObject({
      start: "2026-09-21",
      signups: 14,
      byProvider: { telegram: 7, bhutanapp: 3, google: 4 },
    });
    expect(out.total).toBe(16);
  });

  /** generate_series yields empty weeks as a null-provider row with count 0. */
  it("keeps an empty bucket as zero rather than dropping it", async () => {
    const out = await run([
      { start: "2026-09-14", provider: null, count: 0 },
      { start: "2026-09-21", provider: "telegram", count: 5 },
    ]).promise;
    expect(out.buckets.map((b) => [b.start, b.signups])).toEqual([
      ["2026-09-14", 0],
      ["2026-09-21", 5],
    ]);
    expect(out.buckets[0].byProvider).toEqual({});
  });

  it("files users with no auth method under unknown, still counted", async () => {
    const out = await run([{ start: "2026-09-21", provider: null, count: 2 }]).promise;
    expect(out.buckets[0]).toMatchObject({ signups: 2, byProvider: { unknown: 2 } });
  });

  it("marks only the newest bucket as in progress", async () => {
    const out = await run([
      { start: "2026-09-21", provider: "telegram", count: 1 },
      { start: "2026-09-28", provider: "telegram", count: 1 },
    ]).promise;
    expect(out.buckets.map((b) => b.partial)).toEqual([false, true]);
  });

  it("labels weeks by their Monday and months by name", async () => {
    const week = await run([{ start: "2026-09-28", provider: "google", count: 1 }]).promise;
    // ICU abbreviates September as "Sep" or "Sept" depending on the Node build.
    expect(week.buckets[0].label).toMatch(/^Week of 28 Sept? 2026$/);
    const month = await run([{ start: "2026-09-01", provider: "google", count: 1 }], "month").promise;
    expect(month.buckets[0].label).toBe("September 2026");
  });

  it("whitelists the period and clamps the count", async () => {
    const a = run([], "'; drop table users; --", "999");
    await a.promise;
    expect(a.query.mock.calls[0][1]).toEqual(["week", 52]);

    const b = run([], "month", "999");
    await b.promise;
    expect(b.query.mock.calls[0][1]).toEqual(["month", 24]);

    const c = run([], undefined, undefined);
    await c.promise;
    expect(c.query.mock.calls[0][1]).toEqual(["week", 12]);
  });

  /** The bug this guards: one cast instead of two puts signups in the wrong week. */
  it("double-casts the zoneless createdAt but single-casts now()", async () => {
    const r = run([]);
    await r.promise;
    const sql: string = r.query.mock.calls[0][0];
    expect(sql).toContain(`u."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Thimphu'`);
    expect(sql).not.toContain(`now() AT TIME ZONE 'UTC'`);
  });
});
