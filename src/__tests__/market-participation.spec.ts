import {
  buildParticipation,
  attachParticipationTo,
} from "../admin/market-participation";

describe("market participation: how many people, and where", () => {
  it("counts people and bets per market", () => {
    const map = buildParticipation(
      [{ marketId: "m1", bettors: 3, bets: 7, currency: "BTN" }],
      [],
    );
    expect(map.get("m1")).toEqual({
      bettorCount: 3,
      betCount: 7,
      byOutcome: {},
      poolCurrency: "BTN",
    });
  });

  it("counts people per outcome", () => {
    const map = buildParticipation(
      [{ marketId: "m1", bettors: 3, bets: 7, currency: "BTN" }],
      [
        { marketId: "m1", outcomeId: "o1", bettors: 2 },
        { marketId: "m1", outcomeId: "o2", bettors: 2 },
      ],
    );
    expect(map.get("m1")!.byOutcome).toEqual({ o1: 2, o2: 2 });
  });

  it("keeps the market total below the per-outcome sum when people hedge", () => {
    // The shape of the live World Cup market: 441 people, 982 outcome slots.
    // Both numbers are correct; adding the column up is what is wrong.
    const map = buildParticipation(
      [{ marketId: "m1", bettors: 3, bets: 9, currency: "BTN" }],
      [
        { marketId: "m1", outcomeId: "o1", bettors: 3 },
        { marketId: "m1", outcomeId: "o2", bettors: 2 },
      ],
    );
    const p = map.get("m1")!;
    expect(p.bettorCount).toBe(3);
    expect(Object.values(p.byOutcome).reduce((a, b) => a + b, 0)).toBe(5);
  });

  it("reads Postgres count strings as numbers", () => {
    // node-postgres hands back bigint-ish columns as strings unless cast.
    const map = buildParticipation(
      [{ marketId: "m1", bettors: "12", bets: "40", currency: "USDT" }],
      [{ marketId: "m1", outcomeId: "o1", bettors: "12" }],
    );
    expect(map.get("m1")!.bettorCount).toBe(12);
    expect(map.get("m1")!.betCount).toBe(40);
    expect(map.get("m1")!.byOutcome.o1).toBe(12);
  });

  it("falls back to BTN when no position has set a currency", () => {
    const map = buildParticipation(
      [{ marketId: "m1", bettors: 0, bets: 0, currency: null }],
      [],
    );
    expect(map.get("m1")!.poolCurrency).toBe("BTN");
  });

  it("keeps outcome counts for a market the market aggregate missed", () => {
    const map = buildParticipation(
      [],
      [{ marketId: "m1", outcomeId: "o1", bettors: 4 }],
    );
    expect(map.get("m1")).toEqual({
      bettorCount: 0,
      betCount: 0,
      byOutcome: { o1: 4 },
      poolCurrency: "BTN",
    });
  });

  describe("attachParticipationTo", () => {
    type TestOutcome = { id: string; bettorCount?: number };
    type TestMarket = {
      id: string;
      outcomes?: TestOutcome[];
      bettorCount?: number;
      betCount?: number;
      poolCurrency?: string;
    };

    const dsWith = (marketRows: unknown[], outcomeRows: unknown[]) =>
      ({
        query: jest
          .fn()
          .mockResolvedValueOnce(marketRows)
          .mockResolvedValueOnce(outcomeRows),
      }) as never;

    it("writes counts onto the market and each outcome", async () => {
      const markets: TestMarket[] = [
        { id: "m1", outcomes: [{ id: "o1" }, { id: "o2" }] },
      ];
      await attachParticipationTo(
        dsWith(
          [{ marketId: "m1", bettors: 5, bets: 11, currency: "BTN" }],
          [{ marketId: "m1", outcomeId: "o1", bettors: 4 }],
        ),
        markets,
      );
      expect(markets[0].bettorCount).toBe(5);
      expect(markets[0].betCount).toBe(11);
      expect(markets[0].poolCurrency).toBe("BTN");
      // o2 has no row at all — it must read 0, not undefined, so the client
      // never has to tell "nobody bet" apart from "not loaded".
      expect(markets[0].outcomes!.map((o) => o.bettorCount)).toEqual([4, 0]);
    });

    it("zeroes a market with no bets rather than leaving it undefined", async () => {
      const markets: TestMarket[] = [{ id: "m1", outcomes: [{ id: "o1" }] }];
      await attachParticipationTo(dsWith([], []), markets);
      expect(markets[0].bettorCount).toBe(0);
      expect(markets[0].betCount).toBe(0);
      expect(markets[0].outcomes![0].bettorCount).toBe(0);
    });

    it("does not query at all for an empty page", async () => {
      const ds = { query: jest.fn() };
      await attachParticipationTo(ds as never, []);
      expect(ds.query).not.toHaveBeenCalled();
    });

    it("survives a market whose outcomes were not joined in", async () => {
      const markets: TestMarket[] = [{ id: "m1" }];
      await attachParticipationTo(
        dsWith([{ marketId: "m1", bettors: 2, bets: 2, currency: "BTN" }], []),
        markets,
      );
      expect(markets[0].bettorCount).toBe(2);
    });
  });
});
