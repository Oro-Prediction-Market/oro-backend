import { AdminInsightsController } from "../admin/admin-insights.controller";

describe("AdminInsightsController.attention", () => {
  const row = {
    usdtWithdrawals: 2, dkStuck: 1, disputes: 0, awaitingResult: 4,
    stuckSettling: 0, revenueCount: 3, revenueBtn: "512.50", kyc: 5,
    usdtUncredited: 0, depCount: 7, depSum: "2712", wdCount: 3, wdSum: "1500",
  };

  function build(jobs: any[] = []) {
    const query = jest.fn().mockResolvedValue([row]);
    const jobHealth = { snapshot: jest.fn().mockResolvedValue(jobs) };
    return {
      ctrl: new AdminInsightsController({ query } as any, undefined, undefined, jobHealth as any),
      query,
    };
  }

  it("names the page that handles every item", async () => {
    const out = await build().ctrl.attention();
    for (const item of out.items) expect(item.page).toEqual(expect.any(String));
  });

  it("carries counts through, and the BTN amount for pending revenue", async () => {
    const out = await build().ctrl.attention();
    const by = Object.fromEntries(out.items.map((i) => [i.key, i]));
    expect(by.usdtWithdrawals.count).toBe(2);
    expect(by.dkStuck.count).toBe(1);
    expect(by.revenue).toMatchObject({ count: 3, amountBtn: 512.5 });
  });

  it("counts failing and stopped jobs, but not ones switched off or not yet run", async () => {
    const out = await build([
      { status: "failing" }, { status: "stale" }, { status: "disabled" },
      { status: "never" }, { status: "ok" },
    ]).ctrl.attention();
    expect(out.items.find((i) => i.key === "jobProblems")!.count).toBe(2);
  });

  it("marks stuck money as urgent and ordinary queues as not", async () => {
    const out = await build().ctrl.attention();
    const by = Object.fromEntries(out.items.map((i) => [i.key, i.urgent]));
    expect(by.usdtUncredited && by.dkStuck && by.stuckSettling).toBe(true);
    expect(by.kyc || by.disputes).toBe(false);
  });

  it("reports today's BTN deposits and withdrawals", async () => {
    const out = await build().ctrl.attention();
    expect(out.today).toEqual({
      deposits: { count: 7, sumBtn: 2712 },
      withdrawals: { count: 3, sumBtn: 1500 },
    });
  });

  /** TER/BTC settle themselves; counting them would make the queue never empty. */
  it("excludes self-resolving price markets from the market queues", async () => {
    const { ctrl, query } = build();
    await ctrl.attention();
    const sql: string = query.mock.calls[0][0];
    expect(sql.match(/NOT IN \('ter', 'btc'\)/g)).toHaveLength(2);
  });
});
