import { SettlementCorrectionService } from "../admin/settlement-correction.service";

/**
 * Re-settling a market after payout. The data is market 560589 as it stood:
 * settled Draw, really Coventry. The figures it must produce are the ones
 * paid by hand in September — tn7 690, karma_cheng and bikashsarkey 172.50.
 *
 * The SQL, locking and ledger rewrite run against a real Postgres separately;
 * this pins the plan.
 */
describe("SettlementCorrectionService.plan", () => {
  const M = "m-560589";
  const O = { cov: "o-cov", draw: "o-draw", forest: "o-forest" };

  function positions() {
    const rows: any[] = [];
    const add = (u: string, o: string, amount: number, won: boolean, payout = 0) =>
      rows.push({
        id: `p${rows.length}`, userId: u, outcomeId: o, amount: String(amount),
        payout: String(payout), status: won ? "won" : "lost", currency: "BTN",
        isBonusFunded: false, streakBoostArmed: false,
      });
    add("tn7", O.cov, 100, false); add("tn7", O.cov, 100, false);
    add("karma", O.cov, 50, false); add("bikash", O.cov, 50, false);
    for (let i = 0; i < 5; i++) add(`d${i}`, O.draw, 50, true, 207);
    for (let i = 0; i < 6; i++) add(`f${i}`, O.forest, 100, false);
    return rows;
  }

  function build(over: {
    positions?: any[];
    disputes?: number;
    duels?: number;
    status?: string;
    balances?: Record<string, number>;
    distribution?: any;
  } = {}) {
    const pos = over.positions ?? positions();
    const route = (sql: string): any[] => {
      if (sql.includes("FROM markets WHERE id")) {
        return [{ id: M, title: "Forest v Coventry", status: over.status ?? "settled", resolvedOutcomeId: O.draw }];
      }
      if (sql.includes("FROM outcomes")) {
        return [
          { id: O.cov, label: "Coventry City FC" },
          { id: O.draw, label: "Draw" },
          { id: O.forest, label: "Nottingham Forest FC" },
        ];
      }
      if (sql.includes("FROM settlements s")) {
        return [{
          id: "s1", currency: "BTN", winningOutcomeId: O.draw, totalPool: "1150",
          totalPaidOut: "1035", houseAmount: "115", houseForfeit: "0", cancelReason: null,
          settledAt: "2026-09-19T13:36:00.063Z", houseEdgePct: "10",
        }];
      }
      if (sql.includes("FROM disputes")) return [{ disputes: over.disputes ?? 0 }];
      if (sql.includes("FROM challenges")) return [{ duels: over.duels ?? 0 }];
      // Before the positions route: this query has a positions subquery.
      if (sql.includes("t.type IN ('bet_payout', 'streak_bonus')")) {
        return pos.filter((p) => p.status === "won").map((p) => ({ positionId: p.id, type: "bet_payout", currency: "BTN", amount: p.payout }));
      }
      if (sql.includes("FROM positions WHERE")) return pos;
      if (sql.includes("FROM revenue_distributions")) return over.distribution ? [over.distribution] : [];
      if (sql.includes("GROUP BY \"userId\", currency")) {
        const ids = [...new Set(pos.map((p) => p.userId))];
        return ids.map((u) => ({ userId: u, currency: "BTN", balance: String(over.balances?.[u] ?? 1000) }));
      }
      if (sql.includes("FROM users WHERE id = ANY")) {
        return [...new Set(pos.map((p) => p.userId))].map((u) => ({ id: u, username: u, firstName: null }));
      }
      throw new Error(`unrouted SQL: ${sql.slice(0, 80)}`);
    };
    const em: any = { query: jest.fn(async (sql: string) => route(sql)) };
    const svc = new SettlementCorrectionService({ manager: em } as any);
    return { svc, em };
  }

  it("pays the right side exactly what September's fix paid", async () => {
    const { svc } = build();
    const plan = await svc.preview(M, O.cov);

    expect(plan.blocks).toEqual([]);
    const by = (u: string) => plan.users.find((x) => x.userId === u)!;
    expect(by("tn7").newPayout).toBe(690);
    expect(by("karma").newPayout).toBe(172.5);
    expect(by("bikash").newPayout).toBe(172.5);
    expect(by("d0").wrongPayout).toBe(207);
  });

  it("restates the book: clawback costs the house nothing, keeping costs it the right side's payout", async () => {
    const { svc } = build();
    const [book] = (await svc.preview(M, O.cov)).books;
    expect(book.paidOut).toEqual({ clawback: 1035, keep: 2070 });
    expect(book.house).toEqual({ clawback: 115, keep: -920 });
    // The invariant every settlement keeps.
    expect(book.paidOut.keep + book.house.keep).toBe(book.totalPool);
  });

  it("names anyone clawback would overdraw", async () => {
    const { svc } = build({ balances: { d2: 100 } });
    const plan = await svc.preview(M, O.cov);
    expect(plan.clawbackWouldOverdraw).toEqual(["@d2"]);
    expect(plan.users.find((u) => u.userId === "d2")!.after).toEqual({ clawback: -107, keep: 100 });
  });

  it.each([
    [{ disputes: 2 }, /dispute/],
    [{ duels: 1 }, /duel/],
    [{ status: "resolving" }, /not settled/],
  ])("refuses %o", async (over, why) => {
    const { svc } = build(over as any);
    const plan = await svc.preview(M, O.cov);
    expect(plan.blocks.join(" ")).toMatch(why);
  });

  it("refuses bonus-funded bets", async () => {
    const pos = positions();
    pos[0].isBonusFunded = true;
    const plan = await build({ positions: pos }).svc.preview(M, O.cov);
    expect(plan.blocks.join(" ")).toMatch(/bonus/);
  });

  it("refuses a streak-boosted winning bet on either side", async () => {
    const pos = positions();
    pos[0].streakBoostArmed = true;
    const plan = await build({ positions: pos }).svc.preview(M, O.cov);
    expect(plan.blocks.join(" ")).toMatch(/streak/);
  });

  it("refuses the result it already has", async () => {
    const plan = await build().svc.preview(M, O.draw);
    expect(plan.blocks.join(" ")).toMatch(/already settled as Draw/);
  });

  it("refuses a market already corrected with the wrong side kept", async () => {
    const pos = positions();
    pos[0].status = "won";
    pos[0].payout = "345";
    const plan = await build({ positions: pos }).svc.preview(M, O.forest);
    expect(plan.blocks.join(" ")).toMatch(/already corrected once/);
  });

  it("refuses while a revenue transfer is at the bank, and warns about a completed one", async () => {
    const inFlight = await build({
      distribution: { id: "d", status: "pending", amount: "115", pendingTransferRef: "REF" },
    }).svc.preview(M, O.cov);
    expect(inFlight.blocks.join(" ")).toMatch(/at the bank/);

    const done = await build({
      distribution: { id: "d", status: "completed", amount: "115", pendingTransferRef: null },
    }).svc.preview(M, O.cov);
    expect(done.blocks).toEqual([]);
    expect(done.warnings.join(" ")).toMatch(/already transferred/);
  });

  it("fingerprints the state, so a changed market is caught at apply", async () => {
    const a = await build().svc.preview(M, O.cov);
    const pos = positions();
    pos[5].payout = "206";
    const b = await build({ positions: pos }).svc.preview(M, O.cov);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(b.fingerprint).not.toBe(a.fingerprint);
  });
});

describe("SettlementCorrectionService.apply", () => {
  it("refuses before writing anything when the plan is blocked", async () => {
    const em: any = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes("FOR UPDATE")) return [{ id: "m" }];
        return [];
      }),
      save: jest.fn(),
    };
    const ds: any = { transaction: jest.fn((fn: any) => fn(em)) };
    const svc = new SettlementCorrectionService(ds);
    jest.spyOn(svc, "plan").mockResolvedValue({ blocks: ["It has 1 dispute(s)."] } as any);

    await expect(
      svc.apply({ marketId: "m", toOutcomeId: "o", mode: "keep", note: "x", fingerprint: "f" }, "admin"),
    ).rejects.toThrow(/dispute/);
    const writes = em.query.mock.calls.filter((c: any[]) => /^\s*(UPDATE|DELETE|INSERT)\b/.test(c[0]));
    expect(writes).toEqual([]);
    expect(em.save).not.toHaveBeenCalled();
  });

  it("refuses clawback that would overdraw, even with a matching fingerprint", async () => {
    const em: any = { query: jest.fn(async () => [{ id: "m" }]), save: jest.fn() };
    const ds: any = { transaction: jest.fn((fn: any) => fn(em)) };
    const svc = new SettlementCorrectionService(ds);
    jest.spyOn(svc, "plan").mockResolvedValue({
      blocks: [],
      fingerprint: "f",
      clawbackWouldOverdraw: ["@jame"],
    } as any);

    await expect(
      svc.apply({ marketId: "m", toOutcomeId: "o", mode: "clawback", note: "x", fingerprint: "f" }, "admin"),
    ).rejects.toThrow(/overdraw @jame/);
    expect(em.save).not.toHaveBeenCalled();
  });
});
