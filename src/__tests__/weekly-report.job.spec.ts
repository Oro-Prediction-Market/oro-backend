import { WeeklyReportJob } from "../jobs/weekly-report.job";

/**
 * The weekly report names the markets that settled, and has to stay sendable.
 *
 * Telegram rejects a sendMessage body past 4096 characters, so the unbounded
 * part of this message — one line per settled market — is the part that can
 * silently cost the whole report. A busy week settles over a hundred markets,
 * which is exactly the week you would most want it.
 */
describe("WeeklyReportJob — settled markets section", () => {
  const TELEGRAM_MAX = 4096;

  function job() {
    return new WeeklyReportJob({} as any, {} as any, {} as any);
  }

  const nu = (n: number) =>
    `Nu. ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const section = (rows: unknown[], used = 0) =>
    (job() as any).buildSettledSection(rows, nu, used) as string;

  const market = (over: Record<string, unknown> = {}) => ({
    title: "Arsenal vs Spurs",
    winner: "Arsenal",
    pool: "1500",
    paidOut: "1350",
    ...over,
  });

  it("names each settled market and what it settled as", () => {
    const out = section([
      market(),
      market({ title: "Man City vs Liverpool", winner: "Draw", pool: "800" }),
    ]);

    expect(out).toContain("Arsenal vs Spurs → Arsenal");
    expect(out).toContain("Man City vs Liverpool → Draw");
  });

  it("shows each market's pool", () => {
    expect(section([market({ pool: "2705" })])).toContain("Nu. 2,705.00");
  });

  it("counts the week's settlements in the heading", () => {
    expect(section([market(), market(), market()])).toContain(
      "Settled This Week (3)",
    );
  });

  it("says so plainly when nothing settled", () => {
    const out = section([]);
    expect(out).toContain("Nothing settled this week.");
    expect(out).not.toContain("…and");
  });

  /**
   * A settlement whose winning outcome row has gone missing still gets a line.
   * Dropping it would be the worst option available: the market would vanish
   * from the one place a human checks, for a reason that has nothing to do
   * with whether it paid out correctly.
   */
  it("still lists a market whose winning outcome cannot be resolved", () => {
    const out = section([market({ winner: null })]);
    expect(out).toContain("Arsenal vs Spurs");
    expect(out).not.toContain("→");
  });

  describe("when the list is too long for one message", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      market({ title: `Match number ${i}`, pool: String(5000 - i) }),
    );

    it("keeps the message inside Telegram's limit", () => {
      expect(section(many).length).toBeLessThanOrEqual(TELEGRAM_MAX);
    });

    it("leaves room for the rest of the report", () => {
      const used = 1200;
      expect(used + section(many, used).length).toBeLessThanOrEqual(TELEGRAM_MAX);
    });

    it("announces how many it left out", () => {
      const out = section(many);
      const m = /…and (\d+) more/.exec(out);
      expect(m).not.toBeNull();

      const omitted = Number(m![1]);
      const shown = (out.match(/^• /gm) ?? []).length;
      expect(shown + omitted).toBe(many.length);
    });

    /**
     * The query orders by pool descending, so trimming the tail drops the
     * smallest markets. The trim must not reorder or sample — the top of the
     * list is the part that matters and it has to survive intact.
     */
    it("keeps the biggest pools and cuts the smallest", () => {
      const out = section(many);
      expect(out).toContain("Match number 0");
      expect(out).not.toContain("Match number 199");
    });
  });

  it("shortens a very long market title rather than dropping the line", () => {
    const out = section([market({ title: "x".repeat(300) })]);
    expect(out).toContain("…");
    expect(out).toContain("→ Arsenal");
    expect(out.split("\n").every((l) => l.length < 120)).toBe(true);
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
