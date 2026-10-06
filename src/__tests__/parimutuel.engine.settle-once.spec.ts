import { ParimutuelEngine } from "../markets/parimutuel.engine";
import { MarketStatus } from "../entities/market.entity";
import { Settlement } from "../entities/settlement.entity";
import { MarketBook } from "../entities/market-book.entity";

/**
 * Two resolvers settling the same market at once each paid every winner —
 * France vs Italy was paid three times on 3 Oct 2026. settleMarket now takes
 * the market row lock first and pays nothing when a settlement already exists.
 * The real-Postgres race is in src/__it__/settle-race.it.ts; this pins the
 * guard so it cannot be removed quietly.
 */
describe("ParimutuelEngine.settleMarket — settles a market once", () => {
  function build(prior: boolean) {
    const sql: string[] = [];
    const existing = [{ id: "s1", marketId: "m1", currency: "BTN" }];
    const em: any = {
      query: jest.fn(async (q: string) => {
        sql.push(q.replace(/\s+/g, " ").trim());
        if (/FROM settlements/.test(q)) return prior ? [{ settled: 1 }] : [];
        return [];
      }),
      find: jest.fn(async (Entity: any) => {
        if (Entity === Settlement) return existing;
        if (Entity === MarketBook) throw new Error("must not read books once settled");
        return [];
      }),
    };
    const args: any[] = Array(23).fill(null);
    args[7] = { transaction: (cb: (e: any) => any) => cb(em) }; // dataSource
    const engine = new (ParimutuelEngine as any)(...args) as ParimutuelEngine;
    return { engine, em, sql, existing };
  }

  const market: any = { id: "m1", title: "France vs Italy", status: MarketStatus.RESOLVED };
  const winner: any = { id: "o-draw", label: "Draw" };

  it("locks the market row before anything else", async () => {
    const { engine, sql } = build(true);
    await (engine as any).settleMarket(market, winner, new Map(), new Map(), {});
    expect(sql[0]).toBe("SELECT id FROM markets WHERE id = $1 FOR UPDATE");
  });

  it("pays nothing when another resolver already settled, and says so", async () => {
    const { engine, em, existing } = build(true);
    const run: { alreadySettled?: boolean } = {};
    const out = await (engine as any).settleMarket(market, winner, new Map(), new Map(), run);

    expect(run.alreadySettled).toBe(true);
    expect(out).toBe(existing);
    expect(em.find).not.toHaveBeenCalledWith(MarketBook, expect.anything());
  });

  it("puts a market knocked back to RESOLVED by the late resolver back to SETTLED", async () => {
    const { engine, em } = build(true);
    await (engine as any).settleMarket(market, winner, new Map(), new Map(), {});
    expect(em.query).toHaveBeenCalledWith(
      "UPDATE markets SET status = $2 WHERE id = $1 AND status <> $2",
      ["m1", MarketStatus.SETTLED],
    );
  });

  it("goes on to settle the books when nothing was settled yet", async () => {
    const { engine, em } = build(false);
    // The first book read is where a real settlement starts.
    await expect(
      (engine as any).settleMarket(market, winner, new Map(), new Map(), {}),
    ).rejects.toThrow("must not read books once settled");
    expect(em.find).toHaveBeenCalledWith(MarketBook, expect.anything());
  });
});
