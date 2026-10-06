import { AdminInsightsController } from "../admin/admin-insights.controller";

describe("AdminInsightsController.disputes", () => {
  const caseRow = (over: Record<string, unknown> = {}) => ({
    marketId: "m1", latest: new Date(), open: false,
    title: "Arsenal vs Spurs", subcategory: "epl-match", marketStatus: "settled",
    disputeDeadlineAt: null, windowMinutes: 60,
    proposedOutcomeId: "o-ars", proposedLabel: "Arsenal",
    winningOutcomeId: "o-spurs", finalLabel: "Spurs",
    overturned: true, totalCases: 1, ...over,
  });
  const entry = (over: Record<string, unknown> = {}) => ({
    id: "d1", marketId: "m1", userId: "u1", username: "tashi", firstName: "Tashi",
    side: "object", reason: "Spurs won 2-1, the stream showed it",
    bondAmount: "10", currency: "BTN", bondStatus: "rewarded",
    upheld: true, rewardAmount: "5", createdAt: new Date(), ...over,
  });

  function run(cases: any[], entries: any[], q: (string | undefined)[] = []) {
    const query = jest.fn()
      .mockResolvedValueOnce(cases)
      .mockResolvedValueOnce(entries)
      .mockResolvedValueOnce([{ totalCases: 3, openCases: 1, totalDisputes: 7, overturnedCases: 1 }])
      .mockResolvedValueOnce([{ currency: "BTN", locked: "20", forfeited: "10", rewards: "5" }]);
    const ctrl = new AdminInsightsController({ query } as any);
    return { promise: ctrl.disputes(...(q as [any, any, any, any, any, any, any])), query };
  }

  it("groups a market's objections and defences into one case", async () => {
    const out = await run([caseRow()], [
      entry(),
      entry({ id: "d2", userId: "u2", side: "support", reason: "Arsenal won", upheld: false, bondStatus: "forfeited", rewardAmount: "0" }),
    ]).promise;

    expect(out.cases).toHaveLength(1);
    const c = out.cases[0];
    expect(c).toMatchObject({ proposed: "Arsenal", final: "Spurs", overturned: true, objectors: 1, supporters: 1 });
    expect(c.entries.map((e) => [e.side, e.reason])).toEqual([
      ["object", "Spurs won 2-1, the stream showed it"],
      ["support", "Arsenal won"],
    ]);
  });

  it("reports a case as neither overturned nor stood until it settles", async () => {
    const out = await run([caseRow({ winningOutcomeId: null, finalLabel: null, overturned: false, open: true })], [entry()]).promise;
    expect(out.cases[0]).toMatchObject({ overturned: null, final: null, open: true });
  });

  /** The old endpoint sent whole User entities to the browser. */
  it("returns users as named columns only, never the entity", async () => {
    const { promise, query } = run([caseRow()], [entry()]);
    const out = await promise;
    const sql: string = query.mock.calls[1][0];
    expect(sql).toContain(`u.username, u."firstName"`);
    expect(sql).not.toMatch(/u\.\*/);
    expect(Object.keys(out.cases[0].entries[0]).sort()).toEqual(
      ["bondAmount", "bondStatus", "createdAt", "currency", "id", "name", "reason", "rewardAmount", "side", "upheld", "userId"].sort(),
    );
  });

  it("skips the entries query when no case matches", async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ totalCases: 0, openCases: 0, totalDisputes: 0, overturnedCases: 0 }])
      .mockResolvedValueOnce([]);
    const out = await new AdminInsightsController({ query } as any).disputes();
    expect(out.cases).toEqual([]);
    expect(query).toHaveBeenCalledTimes(3);
  });

  /** The old tab ignored a date filter unless both ends were set. */
  it("accepts either date bound on its own", async () => {
    const a = run([], [], [undefined, undefined, "2026-09-01", undefined]);
    await a.promise.catch(() => undefined);
    expect(a.query.mock.calls[0][1].slice(0, 2)).toEqual(["2026-09-01", null]);

    const b = run([], [], [undefined, undefined, undefined, "2026-09-30"]);
    await b.promise.catch(() => undefined);
    expect(b.query.mock.calls[0][1].slice(0, 2)).toEqual([null, "2026-09-30"]);
  });

  it("escapes the market search so it cannot wildcard-scan", async () => {
    const r = run([], [], [undefined, undefined, undefined, undefined, "50%_off\\"]);
    await r.promise.catch(() => undefined);
    expect(r.query.mock.calls[0][1][2]).toBe("%50\\%\\_off\\\\%");
  });

  it("whitelists status and verdict, and pages", async () => {
    const r = run([], [], ["'; drop", "nonsense", undefined, undefined, undefined, "3", "500"]);
    await r.promise.catch(() => undefined);
    const p = r.query.mock.calls[0][1];
    expect(p.slice(3)).toEqual(["all", "all", 100, 200]);
  });

  it("reports money per currency, never summed across books", async () => {
    const out = await run([caseRow()], [entry()]).promise;
    expect(out.stats.byCurrency).toEqual([{ currency: "BTN", locked: 20, forfeited: 10, rewards: 5 }]);
    expect(out.stats).toMatchObject({ openCases: 1, overturnedCases: 1 });
  });
});
