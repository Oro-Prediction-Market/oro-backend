import { DataSource } from "typeorm";
import { Broadcaster } from "typeorm/subscriber/Broadcaster";
import { AdminController } from "../admin/admin.controller";
import { DEFAULT_HOUSE_EDGE_PCT } from "../markets/fee.constants";

/**
 * The "not on the standard edge" filter on Market Management, through REAL
 * TypeORM query building (skip/take plus a join pages through a DISTINCT
 * wrapper, which a mocked repository would never exercise).
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
  ctrl.dataSource = ds;
  ctrl.marketsService = { attachBooksTo: async () => undefined };
  return { ctrl, sqls };
}

const list = (ctrl: any, edge?: string) =>
  ctrl.listMarkets("2", "20", undefined, undefined, "btc,ter", undefined, undefined, undefined, edge);

describe("AdminController.listMarkets — edge filter", () => {
  it("pages without throwing when filtering on the edge", async () => {
    const { ctrl } = await harness();
    await expect(list(ctrl, "nonstandard")).resolves.toMatchObject({ page: 2 });
  });

  it("checks the market row and every book against the standard edge", async () => {
    const { ctrl, sqls } = await harness();
    await list(ctrl, "nonstandard");
    const q = sqls.find((s) => s.sql.includes("market_books eb"))!;
    expect(q.sql).toMatch(/"market"\."houseEdgePct" <> \$\d+/);
    expect(q.sql).toMatch(/eb\."houseEdgePct" <> \$\d+/);
    expect(q.params).toContain(DEFAULT_HOUSE_EDGE_PCT);
  });

  it("still leaves out the BTC and TER rounds", async () => {
    const { ctrl, sqls } = await harness();
    await list(ctrl, "nonstandard");
    const q = sqls.find((s) => s.sql.includes("market_books eb"))!;
    expect(q.params).toEqual(expect.arrayContaining(["btc", "ter"]));
  });

  it("adds nothing when the filter is off", async () => {
    const { ctrl, sqls } = await harness();
    await list(ctrl);
    expect(sqls.some((s) => s.sql.includes("market_books eb"))).toBe(false);
  });
});
