import { buildLateMoneyStats } from "../admin/late-money.util";

describe("buildLateMoneyStats — real late-money math (no random data)", () => {
  const base = {
    marketId: "m1",
    status: "open",
    windowMinutes: 1,
    closesAt: new Date("2026-08-03T12:00:00.000Z"),
    now: new Date("2026-08-03T11:59:30.000Z").getTime(), // 30s before close
    alertThresholdPct: 40,
  };

  it("computes count and amount percentages from real aggregates", () => {
    const s = buildLateMoneyStats(
      { totalBets: 20, totalAmount: 1000, windowBets: 6, windowAmount: 600 },
      base,
    );
    expect(s.percentageByCount).toBe(30); // 6/20
    expect(s.percentageByAmount).toBe(60); // 600/1000
    expect(s.finalWindowBets).toBe(6);
    expect(s.finalWindowAmount).toBe(600);
    expect(s.timeUntilCloseMs).toBe(30000);
  });

  it("flags detected when the MONEY share meets the threshold", () => {
    const hot = buildLateMoneyStats(
      { totalBets: 10, totalAmount: 1000, windowBets: 2, windowAmount: 500 },
      base,
    );
    expect(hot.percentageByAmount).toBe(50);
    expect(hot.detected).toBe(true); // 50% ≥ 40%, even though only 20% by count

    const calm = buildLateMoneyStats(
      { totalBets: 10, totalAmount: 1000, windowBets: 2, windowAmount: 100 },
      base,
    );
    expect(calm.percentageByAmount).toBe(10);
    expect(calm.detected).toBe(false);
  });

  it("never divides by zero and never flags an empty market", () => {
    const empty = buildLateMoneyStats(
      { totalBets: 0, totalAmount: 0, windowBets: 0, windowAmount: 0 },
      base,
    );
    expect(empty.percentageByCount).toBe(0);
    expect(empty.percentageByAmount).toBe(0);
    expect(empty.detected).toBe(false);
  });

  it("returns null timing when the market has no close time", () => {
    const s = buildLateMoneyStats(
      { totalBets: 5, totalAmount: 100, windowBets: 0, windowAmount: 0 },
      { ...base, closesAt: null },
    );
    expect(s.closesAt).toBeNull();
    expect(s.timeUntilCloseMs).toBeNull();
  });
});
