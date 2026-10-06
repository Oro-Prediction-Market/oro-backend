import {
  ADJUSTMENT_MAX,
  AdminAdjustmentsController,
  DEFAULT_USER_NOTE,
} from "../admin/admin-adjustments.controller";
import { TransactionType } from "../entities/transaction.entity";

/**
 * Admin credits and corrections. These pin the rules that have to hold before
 * money moves; the SQL and the locking are exercised against a real Postgres
 * separately.
 */
describe("AdminAdjustmentsController", () => {
  const USER = "11111111-1111-4111-8111-111111111111";
  const REQ = "22222222-2222-4222-8222-222222222222";

  function build(
    opts: { balance?: number; currency?: string; existing?: any; dkAccountNumber?: string | null } = {},
  ) {
    const saved: any[] = [];
    const userRow = {
      id: USER,
      username: "ryujin",
      firstName: null,
      currency: opts.currency ?? "BTN",
      kycStatus: null,
      dkAccountNumber: opts.dkAccountNumber ?? null,
    };
    // The wallet in the account's own currency holds `balance`; any other is empty.
    let asked = "";
    const qb: any = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn((_sql: string, params?: { currency?: string }) => {
        asked = params?.currency ?? asked;
        return qb;
      }),
      setLock: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(userRow),
      getRawOne: jest.fn(async () => ({
        balance: asked === userRow.currency ? String(opts.balance ?? 258.31) : "0",
      })),
    };
    const em: any = {
      getRepository: jest.fn(() => ({
        createQueryBuilder: jest.fn(() => qb),
        findOne: jest.fn().mockResolvedValue(userRow),
      })),
      create: jest.fn((_e: any, o: any) => o),
      save: jest.fn(async (_e: any, o: any) => {
        const row = { id: `row-${saved.length}`, createdAt: new Date(), ...o };
        saved.push(row);
        return row;
      }),
    };
    const ds: any = {
      manager: em,
      transaction: jest.fn((fn: any) => fn(em)),
      getRepository: jest.fn(() => ({ findOne: jest.fn().mockResolvedValue(opts.existing ?? null) })),
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const redis: any = { del: jest.fn().mockResolvedValue(0) };
    const sse: any = { emit: jest.fn() };
    return { ctl: new AdminAdjustmentsController(ds, audit as any, redis, sse), saved, audit, ds, redis, sse };
  }

  const req = { user: { userId: "admin-1" }, ip: "10.0.0.1" };
  const dto = (over: Record<string, unknown> = {}) =>
    ({
      requestId: REQ,
      userId: USER,
      currency: "BTN",
      amount: 700,
      reason: "withdrawal_return",
      note: "DK withdrawal 20 Sep not on statement",
      ...over,
    }) as any;

  it("writes an adjustment ledger row and its record together", async () => {
    const { ctl, saved, ds } = build();
    const r = await ctl.create(dto(), req);

    expect(ds.transaction).toHaveBeenCalledTimes(1);
    const [tx, record] = saved;
    expect(tx).toMatchObject({
      type: TransactionType.ADJUSTMENT,
      amount: 700,
      currency: "BTN",
      balanceBefore: 258.31,
      balanceAfter: 958.31,
      isBonus: false,
    });
    expect(record).toMatchObject({ transactionId: tx.id, requestId: REQ, adminId: "admin-1" });
    expect(r).toMatchObject({ amount: 700, balanceAfter: 958.31, duplicate: false });
  });

  it("keeps the internal reason off the row the customer sees", async () => {
    const { ctl, saved } = build();
    await ctl.create(dto(), req);
    expect(saved[0].note).toBe(DEFAULT_USER_NOTE.credit);
    expect(saved[1].note).toBe("DK withdrawal 20 Sep not on statement");
  });

  it("uses neutral wording for a debit, or the wording given", async () => {
    const a = build();
    await a.ctl.create(dto({ amount: -50, reason: "recover_overpayment" }), req);
    expect(a.saved[0].note).toBe(DEFAULT_USER_NOTE.debit);

    const b = build();
    await b.ctl.create(dto({ amount: -50, userNote: "Payout correction" }), req);
    expect(b.saved[0].note).toBe("Payout correction");
  });

  it("returns the earlier result for a repeated request instead of paying twice", async () => {
    const existing = {
      id: "adj-1", userId: USER, currency: "BTN", amount: "700", reason: "goodwill",
      note: "x", userNote: "Wallet credit", adminId: "admin-1", transactionId: "t1",
      balanceBefore: "258.31", balanceAfter: "958.31", createdAt: new Date(),
    };
    const { ctl, ds, audit } = build({ existing });
    const r = await ctl.create(dto(), req);
    expect(r).toMatchObject({ id: "adj-1", duplicate: true });
    expect(ds.transaction).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it.each([
    [{ amount: -300 }, /most that can be taken back is 258.31/],
    [{ amount: 10.005 }, /at most 2 decimal places/],
    [{ amount: 0 }, /non-zero/],
    [{ amount: ADJUSTMENT_MAX.BTN + 1 }, /limited to 50,000 BTN/],
    [{ currency: "USDT", amount: 1 }, /no USDT wallet/],
    [{ currency: "EUR" }, /BTN or USDT/],
  ])("refuses %o", async (over, message) => {
    const { ctl, saved } = build();
    await expect(ctl.create(dto(over), req)).rejects.toThrow(message);
    expect(saved).toHaveLength(0);
  });

  it("lets a DK-linked account receive USDT, since that link verifies it", async () => {
    const { ctl, saved } = build({ dkAccountNumber: "110012345678" });
    await ctl.create(dto({ currency: "USDT", amount: 5 }), req);
    expect(saved[0]).toMatchObject({ currency: "USDT", amount: 5 });
  });

  it("allows six decimal places in USDT", async () => {
    const { ctl, saved } = build({ currency: "USDT", balance: 0 });
    await ctl.create(dto({ currency: "USDT", amount: 1.234567 }), req);
    expect(saved[0]).toMatchObject({ amount: 1.234567, currency: "USDT" });
  });

  it("clears the cached balance, tells the open app, and audits", async () => {
    const { ctl, redis, sse, audit } = build();
    await ctl.create(dto(), req);
    expect(redis.del).toHaveBeenCalledWith(`oro:cache:balance:${USER}`);
    expect(sse.emit).toHaveBeenCalledWith(USER, "balance:updated", expect.any(Object));
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "balance.adjust",
        adminId: "admin-1",
        entityId: USER,
        after: expect.objectContaining({ amount: 700, reason: "withdrawal_return" }),
      }),
    );
  });

  it("previews without writing", async () => {
    const { ctl, saved, ds } = build();
    const p = await ctl.preview({ userId: USER, currency: "BTN", amount: 700 });
    expect(p).toMatchObject({ balance: 258.31, after: 958.31 });
    expect(ds.transaction).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });
});
