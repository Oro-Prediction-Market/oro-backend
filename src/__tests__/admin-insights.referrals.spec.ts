import {
  AdminInsightsController,
  referralBonusFor,
} from "../admin/admin-insights.controller";

describe("referralBonusFor", () => {
  it("is Nu 25 plus 5% of the first bet, capped at Nu 75", () => {
    expect(referralBonusFor(100)).toBe(30);
    expect(referralBonusFor(33)).toBe(26.65);
    expect(referralBonusFor(1000)).toBe(75);
    expect(referralBonusFor(5000)).toBe(75);
  });
});

describe("AdminInsightsController.referrals", () => {
  function build(paid: any[], counts: any[], referrers: any[]) {
    const query = jest
      .fn()
      .mockResolvedValueOnce(paid)
      .mockResolvedValueOnce(counts)
      .mockResolvedValueOnce(referrers);
    return { ctrl: new AdminInsightsController({ query } as any), query };
  }

  it("totals per currency and counts signups, conversions and referrers", async () => {
    const { ctrl } = build(
      [
        { currency: "BTN", total: "1234.5", payouts: "40" },
        { currency: "USDT", total: "3", payouts: "1" },
      ],
      [{ referredUsers: "120", converted: "40", referrers: "25" }],
      [],
    );
    const out = await ctrl.referrals();
    expect(out.summary).toEqual({
      paid: [
        {
          currency: "BTN",
          total: 1234.5,
          payouts: 40,
          firstPaidAt: null,
          lastPaidAt: null,
        },
        {
          currency: "USDT",
          total: 3,
          payouts: 1,
          firstPaidAt: null,
          lastPaidAt: null,
        },
      ],
      referredUsers: 120,
      converted: 40,
      referrers: 25,
    });
  });

  it("lists referrers with numbers, not strings", async () => {
    const { ctrl } = build(
      [],
      [{}],
      [
        {
          userId: "r1",
          username: "dorji",
          firstName: null,
          lastName: null,
          referredCount: "12",
          convertedCount: "5",
          earned: "151.25",
          lastReferredAt: null,
        },
      ],
    );
    const out = await ctrl.referrals();
    expect(out.referrers).toEqual([
      {
        userId: "r1",
        username: "dorji",
        firstName: null,
        lastName: null,
        referredCount: 12,
        convertedCount: 5,
        earned: 151.25,
        lastReferredAt: null,
      },
    ]);
    expect(out.summary.referredUsers).toBe(0);
  });

  it("clamps the limit and passes it to the query", async () => {
    for (const [raw, want] of [
      [undefined, 100],
      ["5", 5],
      ["99999", 500],
      ["-1", 100],
      ["abc", 100],
    ] as const) {
      const { ctrl, query } = build([], [{}], []);
      const out = await ctrl.referrals(raw);
      expect(out.limit).toBe(want);
      expect(query.mock.calls[2][1]).toEqual([
        ["referral_bonus", "referral_prize"],
        want,
      ]);
    }
  });

  it("reads only name fields from users", async () => {
    const { ctrl, query } = build([], [{}], []);
    await ctrl.referrals();
    const sql = query.mock.calls.map((c: any[]) => c[0]).join("\n");
    expect(sql).not.toMatch(/\bcid\b|phone|email/i);
  });
});

describe("AdminInsightsController.referralsOf", () => {
  function build(friends: any[], earned: any[]) {
    const query = jest
      .fn()
      .mockResolvedValueOnce(friends)
      .mockResolvedValueOnce(earned);
    return { ctrl: new AdminInsightsController({ query } as any), query };
  }

  it("recomputes the bonus only for friends who converted", async () => {
    const { ctrl, query } = build(
      [
        {
          userId: "f1",
          username: "pema",
          converted: true,
          firstBetAmount: "100",
          firstBetAt: "2026-10-01",
        },
        {
          userId: "f2",
          username: null,
          converted: true,
          firstBetAmount: "2000",
        },
        {
          userId: "f3",
          username: null,
          converted: false,
          firstBetAmount: null,
        },
      ],
      [{ earned: "105" }],
    );
    const out = await ctrl.referralsOf("r1");
    expect(out.earned).toBe(105);
    expect(
      out.friends.map((f: any) => [f.userId, f.firstBetAmount, f.bonus]),
    ).toEqual([
      ["f1", 100, 30],
      ["f2", 2000, 75],
      ["f3", null, null],
    ]);
    expect(query.mock.calls[0][1]).toEqual(["r1"]);
    expect(query.mock.calls[0][0]).not.toMatch(/\bcid\b|phone|email/i);
  });
});
