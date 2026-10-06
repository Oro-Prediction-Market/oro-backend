import { AdminLedgerController } from "../admin/admin-ledger.controller";

/**
 * Ledger health: wallets that are overdrawn, or whose stored running balance
 * disagrees with the sum the app actually shows. The SQL is exercised against
 * a real Postgres separately; these pin the controller's contract.
 */
describe("AdminLedgerController", () => {
  function build(rows: any[] = [], updateResult: [unknown[], number] = [[], 0]) {
    const em = {
      query: jest.fn(async (sql: string, _params?: unknown[]) => {
        if (sql.includes("FOR UPDATE")) return [{ id: "u1" }];
        if (sql.includes("UPDATE transactions")) return updateResult;
        return [{ balance: "212.000000000" }];
      }),
    };
    const ds: any = {
      query: jest.fn().mockResolvedValue(rows),
      transaction: jest.fn((fn: any) => fn(em)),
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const redis: any = { del: jest.fn().mockResolvedValue(0) };
    return { ctl: new AdminLedgerController(ds, audit as any, redis), ds, em, audit, redis };
  }

  const row = (over: Record<string, unknown> = {}) => ({
    userId: "u1",
    currency: "BTN",
    balance: "212.000000000",
    shownBalance: "5.000000000",
    lastAt: "2026-09-10T04:00:00.000Z",
    rows: 4,
    overdrawn: false,
    staleHistory: true,
    username: "bob",
    firstName: null,
    ...over,
  });

  it("scopes every ledger sum by currency", async () => {
    const { ctl, ds } = build();
    await ctl.health();
    const sql: string = ds.query.mock.calls[0][0];
    expect(sql).toMatch(/GROUP BY t\."userId", t\.currency/);
    expect(sql).toMatch(/t\.currency = s\.currency/);
  });

  it("reports the gap between the real balance and the one shown in history", async () => {
    const { ctl } = build([row()]);
    const h = await ctl.health();
    expect(h.wallets[0]).toMatchObject({
      username: "bob",
      balance: 212,
      shownBalance: 5,
      difference: 207,
      staleHistory: true,
      overdrawn: false,
    });
    expect(h.staleHistory).toBe(1);
    expect(h.overdrawn).toBe(0);
  });

  it("counts every problem wallet even when the list is cut", async () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      row({ userId: `u${i}`, overdrawn: i < 3 }),
    );
    const { ctl } = build(many);
    const h = await ctl.health();
    expect(h.wallets).toHaveLength(200);
    expect(h.truncated).toBe(true);
    expect(h.staleHistory).toBe(250);
    expect(h.overdrawn).toBe(3);
  });

  describe("rebuild", () => {
    const req = { user: { userId: "admin-1" }, ip: "10.0.0.1" };

    it("refuses a currency that has no wallet", async () => {
      const { ctl, ds } = build();
      await expect(ctl.rebuild("u1", "EUR", req)).rejects.toThrow(/BTN or USDT/);
      expect(ds.transaction).not.toHaveBeenCalled();
    });

    it("locks the user before rewriting running balances", async () => {
      const { ctl, em } = build([], [[], 3]);
      await ctl.rebuild("u1", "BTN", req);
      const sqls = em.query.mock.calls.map((c: any[]) => c[0] as string);
      expect(sqls[0]).toMatch(/FOR UPDATE/);
      expect(sqls[1]).toMatch(/UPDATE transactions/);
    });

    it("only ever writes balanceBefore and balanceAfter, never an amount", async () => {
      const { ctl, em } = build([], [[], 3]);
      await ctl.rebuild("u1", "BTN", req);
      const update: string = em.query.mock.calls[1][0];
      const setClause = update.slice(update.indexOf("SET"), update.indexOf("FROM ordered"));
      expect(setClause).toMatch(/"balanceBefore"/);
      expect(setClause).toMatch(/"balanceAfter"/);
      expect(setClause).not.toMatch(/\bamount\b/);
      expect(em.query.mock.calls[1][1]).toEqual(["u1", "BTN"]);
    });

    it("reads the affected count from the driver's [rows, count] result", async () => {
      const { ctl } = build([], [[], 3]);
      expect(await ctl.rebuild("u1", "BTN", req)).toMatchObject({
        rowsUpdated: 3,
        balance: 212,
      });
    });

    it("records who rebuilt which wallet", async () => {
      const { ctl, audit } = build([], [[], 3]);
      await ctl.rebuild("u1", "USDT", req);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          adminId: "admin-1",
          action: "ledger.rebuild_running_balances",
          entityId: "u1",
          after: expect.objectContaining({ currency: "USDT", rowsUpdated: 3 }),
        }),
      );
    });
  });
});
