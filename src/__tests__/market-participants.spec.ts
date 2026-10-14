import {
  PARTICIPANTS_SQL,
  ParticipantRow,
  buildMarketParticipants,
  fetchMarketParticipants,
} from "../admin/market-participants";

const INTER = "o-inter";
const DRAW = "o-draw";
const BRUGGE = "o-brugge";
const outcomes = [
  { id: INTER, label: "FC Internazionale Milano", isWinner: false },
  { id: DRAW, label: "Draw", isWinner: false },
  { id: BRUGGE, label: "Club Brugge KV", isWinner: true },
];

function row(p: Partial<ParticipantRow>): ParticipantRow {
  return {
    userId: "u1",
    outcomeId: INTER,
    currency: "BTN",
    username: null,
    firstName: null,
    lastName: null,
    stake: "0",
    bets: "1",
    firstBetAt: "2026-10-12T08:00:00.000Z",
    lastBetAt: "2026-10-12T08:00:00.000Z",
    won: false,
    payout: null,
    refunded: null,
    bonusFunded: false,
    streakBonus: "0",
    ...p,
  };
}

describe("buildMarketParticipants", () => {
  it("lists each person once per outcome with their summed stake and bet count", () => {
    const out = buildMarketParticipants("m1", "settled", outcomes, [
      row({
        userId: "dorji",
        username: "dorji",
        stake: "300.000000000",
        bets: "3",
      }),
      row({ userId: "karma", username: "karma", stake: "100" }),
      row({
        userId: "tashi",
        outcomeId: BRUGGE,
        stake: "50",
        won: true,
        payout: "675",
      }),
    ]);
    const inter = out.outcomes.find((o) => o.outcomeId === INTER)!;
    expect(inter.people).toBe(2);
    expect(inter.totalStake).toBe("400.00");
    expect(inter.backers.map((b) => [b.userId, b.stake, b.bets])).toEqual([
      ["dorji", "300.00", 3],
      ["karma", "100.00", 1],
    ]);
  });

  it("shows every outcome, an empty block for one nobody backed", () => {
    const out = buildMarketParticipants("m1", "open", outcomes, [
      row({ stake: "10" }),
    ]);
    expect(out.outcomes.map((o) => [o.label, o.people])).toEqual([
      ["FC Internazionale Milano", 1],
      ["Draw", 0],
      ["Club Brugge KV", 0],
    ]);
    expect(out.outcomes[1]).toMatchObject({
      currency: "BTN",
      totalStake: "0.00",
      backers: [],
    });
  });

  it("lists a hedger under each outcome they backed, once in the totals", () => {
    const out = buildMarketParticipants("m1", "open", outcomes, [
      row({ userId: "pema", outcomeId: INTER, stake: "20" }),
      row({ userId: "pema", outcomeId: DRAW, stake: "30" }),
    ]);
    expect(out.outcomes[0].people).toBe(1);
    expect(out.outcomes[1].people).toBe(1);
    expect(out.totals.BTN).toMatchObject({
      people: 1,
      positions: 2,
      staked: "50.00",
    });
  });

  it("pays winners their payout plus streak bonus, largest first", () => {
    const out = buildMarketParticipants("m1", "settled", outcomes, [
      row({
        userId: "a",
        outcomeId: BRUGGE,
        stake: "50",
        won: true,
        payout: "675",
        streakBonus: "135",
      }),
      row({
        userId: "b",
        outcomeId: BRUGGE,
        stake: "10",
        won: true,
        payout: "900",
      }),
      row({ userId: "c", outcomeId: INTER, stake: "550" }),
    ]);
    expect(
      out.winners.map((w) => [w.userId, w.payout, w.streakBonus, w.totalPaid]),
    ).toEqual([
      ["b", "900.00", "0.00", "900.00"],
      ["a", "675.00", "135.00", "810.00"],
    ]);
    expect(out.winners[1].outcomeLabel).toBe("Club Brugge KV");
    expect(out.totals.BTN.paidOut).toBe("1710.00");
  });

  it("includes a person still marked won on a losing outcome after a keep-mode correction", () => {
    const out = buildMarketParticipants("m1", "settled", outcomes, [
      row({
        userId: "kept",
        outcomeId: INTER,
        stake: "100",
        won: true,
        payout: "120",
      }),
    ]);
    expect(out.winners).toEqual([
      expect.objectContaining({
        userId: "kept",
        outcomeLabel: "FC Internazionale Milano",
        totalPaid: "120.00",
      }),
    ]);
  });

  it("lists refunds and no winners for a refunded market", () => {
    const out = buildMarketParticipants("m1", "settled", outcomes, [
      row({ userId: "x", stake: "40", refunded: "40" }),
      row({ userId: "y", outcomeId: DRAW, stake: "25", refunded: "25" }),
    ]);
    expect(out.winners).toEqual([]);
    expect(out.refunds.map((r) => [r.userId, r.refunded])).toEqual([
      ["x", "40.00"],
      ["y", "25.00"],
    ]);
    expect(out.totals.BTN.refunded).toBe("65.00");
  });

  it("never adds BTN and USDT together", () => {
    const out = buildMarketParticipants("m1", "open", outcomes, [
      row({ userId: "n", stake: "100", currency: "BTN" }),
      row({ userId: "d", stake: "5", currency: "USDT" }),
    ]);
    const inter = out.outcomes.filter((o) => o.outcomeId === INTER);
    expect(inter.map((o) => [o.currency, o.totalStake])).toEqual([
      ["BTN", "100.00"],
      ["USDT", "5.00"],
    ]);
    expect(out.currencies).toEqual(["BTN", "USDT"]);
    expect(out.totals.BTN.staked).toBe("100.00");
    expect(out.totals.USDT.staked).toBe("5.00");
  });

  it("returns empty lists for a market with no positions", () => {
    const out = buildMarketParticipants("m1", "cancelled", outcomes, []);
    expect(out.winners).toEqual([]);
    expect(out.refunds).toEqual([]);
    expect(out.totals).toEqual({});
    expect(out.outcomes.every((o) => o.backers.length === 0)).toBe(true);
  });
});

describe("fetchMarketParticipants", () => {
  it("returns null for an unknown market without querying positions", async () => {
    const query = jest.fn().mockResolvedValueOnce([]);
    await expect(
      fetchMarketParticipants({ query } as any, "m1"),
    ).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("queries only this market's positions, grouped per person per outcome per currency", async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ id: "m1", status: "settled" }])
      .mockResolvedValueOnce(outcomes)
      .mockResolvedValueOnce([
        row({ outcomeId: BRUGGE, stake: "50", won: true, payout: "675" }),
      ]);
    const out = await fetchMarketParticipants({ query } as any, "m1");
    expect(out?.winners).toHaveLength(1);
    expect(query).toHaveBeenLastCalledWith(PARTICIPANTS_SQL, ["m1"]);
    expect(PARTICIPANTS_SQL).toMatch(/WHERE p\."marketId" = \$1/);
    expect(PARTICIPANTS_SQL).toMatch(
      /GROUP BY p\."userId", p\."outcomeId", p\.currency/,
    );
    expect(PARTICIPANTS_SQL).toMatch(/t\.type = 'streak_bonus'/);
  });

  it("selects only name fields from users — no CID, phone or email", () => {
    const fromUsers = PARTICIPANTS_SQL.match(/\bu\.("?\w+"?)/g) ?? [];
    expect(new Set(fromUsers)).toEqual(
      new Set(["u.id", "u.username", 'u."firstName"', 'u."lastName"']),
    );
  });
});
