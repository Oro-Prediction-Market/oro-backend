import { AdminController } from "../admin/admin.controller";

/**
 * users."createdAt" is a zoneless timestamp that already holds Bhutan
 * wall-clock time (the connection's session timezone is Asia/Thimphu). It was
 * double-cast as if it held UTC, which moved every signup six hours later: an
 * 8 pm signup showed on the next day's bar, and "today" counted yesterday
 * evening. Confirmed against prod on 2026-10-15.
 */
describe("AdminController.userGrowth — Bhutan days", () => {
  async function sqlFor(days: string) {
    const query = jest.fn().mockResolvedValue([]);
    const ctrl = Object.create(AdminController.prototype) as any;
    ctrl.dataSource = { query };
    await ctrl.userGrowth(days);
    return query.mock.calls.map((c: any[]) => c[0] as string);
  }

  it("reads createdAt as Bhutan time, never as UTC", async () => {
    for (const days of ["7", "30", "0"]) {
      const [totals, perDay] = await sqlFor(days);
      for (const sql of [totals, perDay]) {
        expect(sql).toContain(`DATE(("createdAt"))`);
        expect(sql).not.toMatch(/"createdAt" AT TIME ZONE/);
      }
    }
  });

  it("still converts now(), which carries a zone, with a single cast", async () => {
    const [totals] = await sqlFor("30");
    expect(totals).toContain(`DATE((NOW() AT TIME ZONE 'Asia/Thimphu'))`);
  });
});
