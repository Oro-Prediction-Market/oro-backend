import {
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { CryptoHdWalletService } from "../payment/crypto-hd-wallet.service";
import { PaymentMethod } from "../entities/payment.entity";
import { TransactionType } from "../entities/transaction.entity";
import { KycStatus } from "../entities/user.entity";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ADDR = "TA42skAPdMZKPw2xdCt6jVQ1iPEpobSgcQ";

interface World {
  users: Record<string, any>;
  /** `${network}|${address}` → owner row */
  addresses: Record<string, any>;
  invoiceIntents: Set<string>;
}

function build(world: Partial<World> = {}, config: Record<string, string> = {}) {
  const w: World = {
    users: { [USER]: { id: USER, kycStatus: KycStatus.APPROVED } },
    addresses: { [`tron|${ADDR}`]: { userId: USER, network: "tron", address: ADDR } },
    invoiceIntents: new Set(),
    ...world,
  };

  const seenIntents = new Set<string>();
  const hdRows: any[] = [];
  const saved: { entity: string; value: any }[] = [];
  const updates: any[] = [];

  const em: any = {
    findOne: jest.fn(async (entity: any, opts: any) => {
      const where = opts.where;
      switch (entity.name) {
        case "CryptoPaymentIntent":
          return w.invoiceIntents.has(where.pay21IntentId)
            ? { pay21IntentId: where.pay21IntentId }
            : null;
        case "User":
          return w.users[where.id] ?? null;
        case "CryptoDepositAddress":
          return w.addresses[`${where.network}|${where.address}`] ?? null;
        default:
          throw new Error(`unexpected findOne(${entity.name})`);
      }
    }),
    // INSERT … ON CONFLICT (pay21IntentId) DO NOTHING RETURNING id
    createQueryBuilder: jest.fn(() => {
      let values: any;
      const b: any = {
        insert: () => b,
        into: () => b,
        values: (v: any) => ((values = v), b),
        orIgnore: () => b,
        returning: () => b,
        execute: async () => {
          if (seenIntents.has(values.pay21IntentId)) return { raw: [] };
          seenIntents.add(values.pay21IntentId);
          hdRows.push(values);
          return { raw: [{ id: `hd-${hdRows.length}` }] };
        },
      };
      return b;
    }),
    // ledgerBalance()
    getRepository: jest.fn(() => ({
      createQueryBuilder: () => ({
        select: function () { return this; },
        where: function () { return this; },
        getRawOne: async () => ({ balance: "5" }),
      }),
    })),
    create: jest.fn((_e: any, d: any) => ({ ...d })),
    save: jest.fn(async (entity: any, d: any) => {
      const row = { id: `${entity.name}-${saved.length + 1}`, ...d };
      saved.push({ entity: entity.name, value: row });
      return row;
    }),
    update: jest.fn(async (entity: any, where: any, patch: any) => {
      updates.push({ entity: entity.name, where, patch });
    }),
  };

  const ds: any = { transaction: (cb: Function) => cb(em) };
  const notifs: any[] = [];
  const userNotifRepo: any = {
    create: (e: any) => e,
    save: async (e: any) => notifs.push(e),
  };
  const cfg: any = { get: (k: string, d?: string) => config[k] ?? d };

  const redis = { del: jest.fn(async (..._k: string[]) => undefined) };
  const sse = { emit: jest.fn() };
  const service = new CryptoHdWalletService(
    ds,
    {} as any,
    {} as any,
    {} as any,
    userNotifRepo,
    {} as any,
    cfg,
    redis as any,
    sse as any,
  );
  return { service, saved, updates, hdRows, notifs, redis, sse };
}

const credited = (over: Record<string, any> = {}) =>
  CryptoHdWalletService.parseCreditedEvent({
    tenant_id: "t",
    intent_id: "8f716410-9844-4ce9-a41c-c5aec7996cf0",
    end_user_id: USER,
    network: "tron",
    amount: "1000000",
    fee: "0",
    net_amount: "1000000",
    tx_hash: "aefacc37",
    deposit_address: ADDR,
    credited_at: "2026-09-28T13:32:44Z",
    reason: "",
    ...over,
  })!;

describe("CryptoHdWalletService.parseCreditedEvent", () => {
  it("returns null for an invoice payment (no end_user_id)", () => {
    expect(
      CryptoHdWalletService.parseCreditedEvent({ intent_id: "x", amount: "1" }),
    ).toBeNull();
    expect(
      CryptoHdWalletService.parseCreditedEvent({ end_user_id: "", amount: "1" }),
    ).toBeNull();
  });

  it("reads the contract's fields", () => {
    const e = credited();
    expect(e.intentId).toBe("8f716410-9844-4ce9-a41c-c5aec7996cf0");
    expect(e.endUserId).toBe(USER);
    expect(e.amountBaseUnits).toBe("1000000");
    expect(e.depositAddress).toBe(ADDR);
  });
});

describe("CryptoHdWalletService.credit", () => {
  it("credits amount (not net_amount) in USDT, once, keyed on intent_id", async () => {
    const { service, saved, updates } = build();
    const out = await service.credit(
      credited({ amount: "25500000", fee: "500000", net_amount: "25000000" }),
    );

    expect(out).toEqual({ handled: true, credited: true });
    const payment = saved.find((r) => r.entity === "Payment")!.value;
    const tx = saved.find((r) => r.entity === "Transaction")!.value;
    expect(payment.method).toBe(PaymentMethod.USDT);
    expect(payment.currency).toBe("USDT");
    expect(payment.externalPaymentId).toBe("8f716410-9844-4ce9-a41c-c5aec7996cf0");
    expect(Number(payment.amount)).toBe(25.5);
    expect(tx.type).toBe(TransactionType.DEPOSIT);
    expect(tx.currency).toBe("USDT");
    expect(tx.amount).toBe(25.5);
    expect(tx.balanceAfter).toBe(30.5);
    expect(tx.isBonus).toBe(false);

    const mark = updates.find((u) => u.entity === "CryptoHdDeposit");
    expect(mark.patch.creditedAt).toBeInstanceOf(Date);
    expect(mark.patch.paymentId).toBe(payment.id);
  });

  it("converts base units exactly", async () => {
    const { service, saved } = build();
    await service.credit(credited({ amount: "1" }));
    expect(saved.find((r) => r.entity === "Transaction")!.value.amount).toBe(
      0.000001,
    );
  });

  it("a redelivered event credits once", async () => {
    const { service, saved } = build();
    await service.credit(credited());
    const again = await service.credit(credited());

    expect(again).toEqual({ handled: true, credited: false, reason: "duplicate" });
    expect(saved.filter((r) => r.entity === "Transaction")).toHaveLength(1);
  });

  it("concurrent duplicates credit once", async () => {
    const { service, saved } = build();
    const results = await Promise.all([
      service.credit(credited()),
      service.credit(credited()),
    ]);
    expect(results.filter((r) => r.credited)).toHaveLength(1);
    expect(saved.filter((r) => r.entity === "Transaction")).toHaveLength(1);
  });

  it("a second deposit to the same address (new intent_id) is credited separately", async () => {
    const { service, saved } = build();
    await service.credit(credited());
    const second = await service.credit(
      credited({ intent_id: "0b0e3f7c-1111-4ce9-a41c-c5aec7996cf0" }),
    );
    expect(second.credited).toBe(true);
    expect(saved.filter((r) => r.entity === "Transaction")).toHaveLength(2);
  });

  it("does not credit an unknown customer, but records it for review", async () => {
    const { service, saved, hdRows } = build({ users: {} });
    const out = await service.credit(credited());

    expect(out).toEqual({
      handled: false,
      credited: false,
      reason: "unknown_customer",
    });
    expect(saved).toHaveLength(0);
    expect(hdRows[0]).toMatchObject({
      userId: null,
      needsReview: true,
      reviewReason: "unknown_customer",
    });
  });

  it("does not credit when the address belongs to someone else", async () => {
    const { service, saved, hdRows } = build({
      users: {
        [USER]: { id: USER },
        [OTHER]: { id: OTHER },
      },
    });
    const out = await service.credit(credited({ end_user_id: OTHER }));

    expect(out.reason).toBe("address_mismatch");
    expect(out.credited).toBe(false);
    expect(saved).toHaveLength(0);
    expect(hdRows[0].needsReview).toBe(true);
  });

  it("credits when the address is not in our table but the customer is", async () => {
    const { service } = build({ addresses: {} });
    expect((await service.credit(credited())).credited).toBe(true);
  });

  it("never touches the database for an end_user_id that is not a uuid", async () => {
    const { service, saved, hdRows } = build();
    const out = await service.credit(credited({ end_user_id: "player-42" }));
    expect(out.reason).toBe("unknown_customer");
    expect(hdRows).toHaveLength(0);
    expect(saved).toHaveLength(0);
  });

  it.each([
    ["missing", undefined],
    ["zero", "0"],
    ["decimal", "1.5"],
    ["negative", "-1000000"],
    ["float-ish", "1e6"],
  ])("refuses a %s amount", async (_label, amount) => {
    const { service, saved } = build();
    const out = await service.credit(credited({ amount }));
    expect(out).toMatchObject({ credited: false, reason: "invalid_amount" });
    expect(saved).toHaveLength(0);
  });

  it("leaves an intent the invoice flow owns to the invoice flow", async () => {
    const { service, saved } = build({
      invoiceIntents: new Set(["8f716410-9844-4ce9-a41c-c5aec7996cf0"]),
    });
    const out = await service.credit(credited());
    expect(out.reason).toBe("invoice_intent");
    expect(saved).toHaveLength(0);
  });

  it("credits an over-limit deposit and flags it for review", async () => {
    const { service, hdRows } = build({}, { USDT_MAX_DEPOSIT: "1000" });
    const out = await service.credit(credited({ amount: "1500000000" }));

    expect(out.credited).toBe(true);
    expect(hdRows[0]).toMatchObject({
      needsReview: true,
      reviewReason: "over_max_deposit",
    });
  });

  it("refreshes the wallet balance after crediting, and not on a duplicate", async () => {
    const { service, redis, sse } = build();
    await service.credit(credited());
    await service.credit(credited());
    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledWith(`oro:cache:balance:${USER}`);
    expect(sse.emit).toHaveBeenCalledTimes(1);
    expect(sse.emit).toHaveBeenCalledWith(
      USER,
      "balance:updated",
      expect.objectContaining({ currency: "USDT" }),
    );
  });

  it("notifies the user after crediting, and not on a duplicate", async () => {
    const { service, notifs } = build();
    await service.credit(credited());
    await service.credit(credited());
    await new Promise((r) => setImmediate(r));
    expect(notifs).toHaveLength(1);
    expect(notifs[0].userId).toBe(USER);
  });
});

describe("CryptoHdWalletService.getDepositAddress", () => {
  function withRepos(opts: {
    stored?: any;
    user?: any;
    remote?: any;
    enabled?: boolean;
  }) {
    const rows: any[] = opts.stored ? [opts.stored] : [];
    const addressRepo: any = {
      findOneBy: jest.fn(async () => rows[0] ?? null),
      createQueryBuilder: () => {
        let v: any;
        const b: any = {
          insert: () => b,
          into: () => b,
          values: (x: any) => ((v = x), b),
          orIgnore: () => b,
          execute: async () => {
            if (!rows.length) rows.push({ ...v, createdAt: new Date() });
          },
        };
        return b;
      },
    };
    const client: any = {
      enabled: opts.enabled ?? true,
      isNetworkEnabled: () => true,
      getOrCreateCustomerDepositAddress: jest.fn(async () => opts.remote),
    };
    const userRepo: any = { findOneBy: async () => opts.user ?? null };
    const service = new CryptoHdWalletService(
      {} as any,
      addressRepo,
      {} as any,
      userRepo,
      {} as any,
      client,
      { get: () => undefined } as any,
      {} as any,
      {} as any,
    );
    return { service, client };
  }

  it("returns the stored address without calling 21 Pay", async () => {
    const { service, client } = withRepos({
      stored: { network: "tron", address: ADDR, createdAt: new Date() },
    });
    const view = await service.getDepositAddress(USER, "tron");
    expect(view.depositAddress).toBe(ADDR);
    expect(client.getOrCreateCustomerDepositAddress).not.toHaveBeenCalled();
  });

  it("asks 21 Pay once, with our user id as end_user_id, and stores it", async () => {
    const { service, client } = withRepos({
      user: { id: USER, kycStatus: KycStatus.APPROVED },
      remote: { end_user_id: USER, network: "tron", deposit_address: ADDR },
    });
    const view = await service.getDepositAddress(USER, "tron");
    expect(view.depositAddress).toBe(ADDR);
    expect(client.getOrCreateCustomerDepositAddress).toHaveBeenCalledWith({
      endUserId: USER,
      network: "tron",
    });
  });

  it("refuses an unverified account before calling 21 Pay", async () => {
    const { service, client } = withRepos({
      user: { id: USER, kycStatus: KycStatus.PENDING, dkAccountNumber: null },
    });
    await expect(service.getDepositAddress(USER, "tron")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(client.getOrCreateCustomerDepositAddress).not.toHaveBeenCalled();
  });

  it("refuses a network without permanent addresses", async () => {
    const { service } = withRepos({});
    await expect(
      service.getDepositAddress(USER, "arbitrum"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
