import { AdminInsightsController } from "../admin/admin-insights.controller";
import { DEFAULT_HOUSE_EDGE_PCT } from "../markets/fee.constants";

/**
 * Settlement charges the BOOK's edge, so a market can display the standard
 * edge on its own row while bettors are charged something else. That is the
 * case this view exists to surface.
 */
describe("AdminInsightsController.edgeExceptions", () => {
  const row = (over: Record<string, unknown>) => ({
    id: "m1",
    title: "Big match",
    status: "settled",
    subcategory: "epl-match",
    marketEdge: "10.00",
    createdAt: new Date(),
    currency: "BTN",
    bookEdge: "10.00",
    bookPool: "1000",
    ...over,
  });

  const run = (rows: any[]) => {
    const query = jest.fn().mockResolvedValue(rows);
    return {
      res: new AdminInsightsController({ query } as any).edgeExceptions(),
      query,
    };
  };

  it("filters on the standard edge from fee.constants, not a literal", async () => {
    const { res, query } = run([]);
    await res;
    expect(query.mock.calls[0][1]).toEqual([DEFAULT_HOUSE_EDGE_PCT]);
  });

  it("lists a market configured off-standard, with its book", async () => {
    const { res } = run([row({ marketEdge: "15.00", bookEdge: "15.00", bookPool: "11548" })]);
    const out = await res;
    expect(out.markets).toHaveLength(1);
    expect(out.markets[0]).toMatchObject({ marketEdge: 15, mismatch: false });
    expect(out.markets[0].books).toEqual([{ currency: "BTN", edge: 15, pool: 11548 }]);
  });

  /** The sneaky case: the row an admin reads is standard; the book is not. */
  it("flags a book charging a different edge from the one the market shows", async () => {
    const { res } = run([row({ marketEdge: "10.00", bookEdge: "15.00" })]);
    expect((await res).markets[0].mismatch).toBe(true);
  });

  it("groups one market's several books into one entry", async () => {
    const { res } = run([
      row({ marketEdge: "12.00", currency: "BTN", bookEdge: "12.00" }),
      row({ marketEdge: "12.00", currency: "USDT", bookEdge: "12.00" }),
    ]);
    const out = await res;
    expect(out.markets).toHaveLength(1);
    expect(out.markets[0].books.map((b) => b.currency)).toEqual(["BTN", "USDT"]);
  });

  it("handles a market with no book yet", async () => {
    const { res } = run([row({ marketEdge: "8.00", currency: null, bookEdge: null, bookPool: null })]);
    const out = await res;
    expect(out.markets[0].books).toEqual([]);
    expect(out.markets[0].mismatch).toBe(false);
  });
});
