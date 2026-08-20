import { SegregationInvariantsService } from "../reconciliation/segregation-invariants.service";

/**
 * These assert the shape and the reporting contract. The SQL itself was
 * verified against a real Postgres by seeding a correct world (all seven
 * report zero), then breaking each invariant in turn and confirming each one —
 * and only that one — fired. A mocked DataSource cannot prove SQL correctness,
 * so it is not asked to.
 */
function build(rowsByQuery: (sql: string) => any[]) {
  const ds: any = {
    query: jest.fn().mockImplementation((sql: string) =>
      Promise.resolve(rowsByQuery(sql)),
    ),
  };
  return { service: new SegregationInvariantsService(ds), ds };
}

describe("SegregationInvariantsService", () => {
  it("reports ok when every check returns no rows", async () => {
    const { service } = build(() => []);
    const res = await service.runAll();

    expect(res.ok).toBe(true);
    expect(res.results).toHaveLength(7);
    expect(res.results.every((r) => r.violations === 0)).toBe(true);
  });

  it("covers every invariant the model names", async () => {
    const { service } = build(() => []);
    const keys = (await service.runAll()).results.map((r) => r.key).sort();
    expect(keys).toEqual([
      "book_totals_match_stakes",
      "currencies_are_holdable",
      "no_wallet_overdrawn",
      "outcome_books_complete",
      "positions_have_a_book",
      "settlements_balance_per_book",
      "settlements_have_a_book",
    ]);
  });

  it("fails overall when any single check finds a row", async () => {
    // There is no tolerance here on purpose: one crossed row means money may
    // have moved between the books, and the first sign of that is always a
    // small number.
    const { service } = build((sql) =>
      sql.includes("HAVING SUM(t.amount) < 0") ? [{ userId: "u1" }] : [],
    );
    const res = await service.runAll();

    expect(res.ok).toBe(false);
    const failing = res.results.filter((r) => r.violations > 0);
    expect(failing).toHaveLength(1);
    expect(failing[0].key).toBe("no_wallet_overdrawn");
  });

  it("bounds the sample it returns", async () => {
    // An alert payload should not become a data export.
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `row-${i}` }));
    const { service } = build(() => many);
    const res = await service.runAll();

    for (const r of res.results) {
      expect(r.sample.length).toBeLessThanOrEqual(10);
    }
  });

  it("gives every check a human-readable assertion", async () => {
    const { service } = build(() => []);
    for (const r of (await service.runAll()).results) {
      expect(typeof r.assertion).toBe("string");
      expect(r.assertion.length).toBeGreaterThan(20);
    }
  });
});
