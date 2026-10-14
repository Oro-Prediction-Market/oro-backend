import { WeeklyReportJob } from "../jobs/weekly-report.job";

/** The report is totals only; it no longer lists the week's settled markets. */
describe("WeeklyReportJob — no settled-markets list", () => {
  const job = () => new WeeklyReportJob({} as any, {} as any, {} as any) as any;
  const message = () =>
    job().buildMessage(new Date("2026-10-05T03:00:00Z"), new Date("2026-10-12T03:00:00Z"), {
      growth: { newUsers: 10, byProvider: { telegram: 10 }, viaReferral: 2, activePlayers: 50 },
      revenue: { house: 1000, volume: 10000, settled: 27, topMarket: null },
      moneyFlow: { deposits: { sum: 5000, count: 20 }, withdrawals: { sum: 2000, count: 5 } },
      gameplay: {
        placed: { count: 700, sum: 40000 },
        settled: { count: 780, sum: 52000, earlierCount: 300, earlierSum: 21000 },
        refunded: { count: 4, sum: 400 },
        inEscrowThisWeek: { count: 200, sum: 9000 },
        marketsCreated: { sports: 30 },
        resolved: { completed: 27, cancelled: 3, refunded: 300 },
      },
      escrow: { sum: 9000, markets: 12, positions: 200 },
      winners: { winners: 300, grossPrize: 50000, netPayout: 45000, payoutsSent: 300 },
    }) as string;

  it("ends with the winners totals, with no per-market list", () => {
    const out = message();
    expect(out).not.toContain("Settled This Week (");
    expect(out.trimEnd().endsWith("Payout Completion: 300/300")).toBe(true);
  });

  it("no longer queries the settled markets", () => {
    expect(job().fetchSettledMarkets).toBeUndefined();
    expect(job().buildSettledSection).toBeUndefined();
  });
});

/**
 * Placed and settled run on different clocks — placed by when the bet went
 * in, settled by when its market settled — so a week can settle more than it
 * took in. The report used to print settled as a sub-line of placed, and a
 * week with 718 placed and 786 settled read as a bookkeeping error.
 */
describe("WeeklyReportJob — predictions lines", () => {
  const nu = (n: number) =>
    `Nu. ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const lines = (over: Record<string, unknown> = {}) =>
    (new WeeklyReportJob({} as any, {} as any, {} as any) as any).buildPredictionLines(
      {
        placed: { count: 718, sum: 40000 },
        settled: { count: 786, sum: 52000, earlierCount: 300, earlierSum: 21000 },
        refunded: { count: 4, sum: 400 },
        inEscrowThisWeek: { count: 232, sum: 9000 },
        ...over,
      },
      nu,
    ) as string;

  it("does not print settled as a sub-line of placed", () => {
    expect(lines()).not.toMatch(/^\s+↳ Settled/m);
    expect(lines()).toMatch(/^Settled This Week: 786 \(Nu\. 52,000\.00\)$/m);
  });

  it("splits settled into bets placed this week and in earlier weeks", () => {
    const out = lines();
    expect(out).toContain("↳ Placed this week: 486 (Nu. 31,000.00)");
    expect(out).toContain("↳ Placed in earlier weeks: 300 (Nu. 21,000.00)");
  });

  it("says what settled counts and which currency", () => {
    expect(lines()).toMatch(/BTN only/);
    expect(lines()).toMatch(/whenever it was placed/);
  });

  it("keeps still-open as a sub-line of placed, since it is a subset of it", () => {
    expect(lines()).toMatch(/^Placed This Week: 718.*\n\s+↳ Still open: 232/m);
  });
});
