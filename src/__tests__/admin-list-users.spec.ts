import { DataSource } from "typeorm";
import { Broadcaster } from "typeorm/subscriber/Broadcaster";
import { AdminController } from "../admin/admin.controller";
import { User } from "../entities/user.entity";

/**
 * listUsers runs through REAL TypeORM query building here, with a query runner
 * that records SQL instead of sending it.
 *
 * A mocked repository would have hidden the bug these exist for: with
 * skip/take plus joins, TypeORM pages through a DISTINCT wrapper and splits
 * each ORDER BY key on its first "." to find a join alias. Ordering by an
 * expression like `COALESCE(u.betStreakCount, 0)` therefore threw
 * `"COALESCE(u" alias was not found` before any SQL ran — sorting users by name
 * or streak returned an error in production. Only real query building shows it.
 */
async function harness() {
  const ds = new DataSource({
    type: "postgres",
    entities: [__dirname + "/../entities/*.entity.ts"],
  });
  await (ds as any).buildMetadatas();
  const sqls: { sql: string; params: unknown[] }[] = [];
  const runner: any = {
    connection: ds,
    isReleased: false,
    isTransactionActive: false,
    data: {},
    query: async (sql: string, params: unknown[] = [], structured?: boolean) => {
      sqls.push({ sql, params });
      return structured ? { records: [{ cnt: "0" }], raw: [] } : [];
    },
    release: async () => undefined,
  };
  runner.manager = ds.createEntityManager(runner);
  runner.broadcaster = new Broadcaster(runner);
  (ds as any).createQueryRunner = () => runner;

  const ctrl: any = Object.create(AdminController.prototype);
  ctrl.userRepo = ds.getRepository(User);
  return { ctrl, sqls };
}

describe("AdminController.listUsers — sorting", () => {
  for (const sortField of ["joined", "name", "streak"]) {
    it(`sorts by ${sortField} without throwing`, async () => {
      const { ctrl } = await harness();
      await expect(
        ctrl.listUsers({ sortField, sortDir: "desc", page: 2, limit: 20 }),
      ).resolves.toMatchObject({ page: 2, limit: 20 });
    });
  }

  it("orders by the selected alias, with u.id breaking ties", async () => {
    const { ctrl, sqls } = await harness();
    await ctrl.listUsers({ sortField: "streak", sortDir: "asc" });
    const paged = sqls.map((s) => s.sql).find((q) => q.includes("distinctAlias"));
    expect(paged).toMatch(/ORDER BY "distinctAlias"\."sort_streak" ASC/);
    expect(paged).toMatch(/"distinctAlias"\."u_id" ASC/);
  });
});

describe("AdminController.listUsers — betting P&L", () => {
  const run = async (q: Record<string, unknown>) => {
    const { ctrl, sqls } = await harness();
    await ctrl.listUsers({ sortDir: "desc", ...q });
    // The paged query carries every WHERE; take the first that joins pnl.
    return sqls.find((s) => s.sql.includes(`"pnl"`) || s.sql.includes(" pnl "))!;
  };

  it("joins settled, real-money bets only", async () => {
    const { sql } = await run({});
    expect(sql).toContain("status IN ('won', 'lost')");
    expect(sql).toContain(`"isBonusFunded" = false`);
  });

  it("measures BTN by default and USDT only for USDT accounts — never both", async () => {
    expect((await run({})).params).toContain("BTN");
    const usdt = await run({ currency: "USDT" });
    expect(usdt.params).toContain("USDT");
    expect(usdt.params).not.toContain("BTN");
  });

  it.each([
    ["profitable", "pnl.profit > 0"],
    ["losing", "pnl.profit < 0"],
    ["even", "pnl.settled > 0 AND pnl.profit = 0"],
    ["none", `pnl."userId" IS NULL`],
  ])("filters %s users", async (profit, where) => {
    expect((await run({ profit })).sql).toContain(where);
  });

  it("binds min and max profit as parameters", async () => {
    const { sql, params } = await run({ minProfit: -500, maxProfit: 2000 });
    expect(sql).toContain("COALESCE(pnl.profit, 0) >=");
    expect(sql).toContain("COALESCE(pnl.profit, 0) <=");
    expect(params).toEqual(expect.arrayContaining([-500, 2000]));
  });

  it("sorts by profit through the paginated path without throwing", async () => {
    const { ctrl, sqls } = await harness();
    await expect(
      ctrl.listUsers({ sortField: "profit", sortDir: "desc", page: 3, limit: 20 }),
    ).resolves.toMatchObject({ page: 3 });
    const paged = sqls.map((s) => s.sql).find((q) => q.includes("distinctAlias"));
    expect(paged).toMatch(/ORDER BY "distinctAlias"\."pnl_profit" DESC/);
  });
});
