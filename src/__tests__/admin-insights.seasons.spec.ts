import { AdminInsightsController } from "../admin/admin-insights.controller";

/**
 * The seasons view must say exactly what season.service believes it paid.
 *
 * Prize crediting is fire-and-forget and per-winner, so a month can be partly
 * paid with nothing but a log line to show for it. This view keys "paid" on
 * the same transaction note the service uses as its idempotency key, so the
 * two cannot disagree.
 */
describe("AdminInsightsController.seasons", () => {
  const snap = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      rank: i + 1,
      userId: `u${i + 1}`,
      username: `user${i + 1}`,
      winRate: 60,
      volume: 1000,
    }));

  function build(seasons: any[], prizes: any[]) {
    const query = jest
      .fn()
      .mockResolvedValueOnce(seasons)
      .mockResolvedValueOnce(prizes);
    return {
      ctrl: new AdminInsightsController({ query } as any),
      query,
    };
  }

  const september = (over: Record<string, unknown> = {}) => ({
    id: "s9",
    month: 9,
    year: 2026,
    status: "closed",
    startsAt: new Date(),
    endsAt: new Date(),
    winnersSnapshot: snap(10),
    ...over,
  });

  it("marks a podium place paid only when its exact prize note exists", async () => {
    const { ctrl } = build(
      [september()],
      [
        { userId: "u1", amount: "700", note: "🥇 Season prize — September 2026 #1", createdAt: new Date() },
        { userId: "u2", amount: "500", note: "🥈 Season prize — September 2026 #2", createdAt: new Date() },
      ],
    );

    const res = await ctrl.seasons();
    const podium = res.seasons[0].podium;

    expect(podium.map((p) => [p.rank, p.paid])).toEqual([
      [1, true],
      [2, true],
      // The partial-payment case — the one that used to be invisible.
      [3, false],
    ]);
    expect(podium[0].paidAmount).toBe(700);
  });

  it("does not credit a prize paid to someone else for the same rank", async () => {
    const { ctrl } = build(
      [september()],
      [{ userId: "someone-else", amount: "700", note: "🥇 Season prize — September 2026 #1", createdAt: new Date() }],
    );
    const res = await ctrl.seasons();
    expect(res.seasons[0].podium[0].paid).toBe(false);
  });

  it("does not confuse one month's prize for another's", async () => {
    const { ctrl } = build(
      [september()],
      [{ userId: "u1", amount: "700", note: "🥇 Season prize — August 2026 #1", createdAt: new Date() }],
    );
    const res = await ctrl.seasons();
    expect(res.seasons[0].podium[0].paid).toBe(false);
  });

  /** Fewer than three qualifiers closes the season and pays nobody, by design. */
  it("reports a thin month as not paying out, rather than as unpaid", async () => {
    const { ctrl } = build([september({ winnersSnapshot: snap(2) })], []);
    const res = await ctrl.seasons();
    expect(res.seasons[0].paysOut).toBe(false);
    expect(res.seasons[0].qualifiers).toBe(2);
  });

  it("does not expect a payout from the season still running", async () => {
    const { ctrl } = build([september({ status: "active", winnersSnapshot: null })], []);
    const res = await ctrl.seasons();
    expect(res.seasons[0].paysOut).toBe(false);
    expect(res.seasons[0].podium).toEqual([]);
  });

  it("skips the prize query entirely when there are no seasons", async () => {
    const { ctrl, query } = build([], []);
    const res = await ctrl.seasons();
    expect(res.seasons).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
