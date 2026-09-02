import { CryptoSettlementService } from "../payment/crypto-settlement.service";
import { CryptoIntentStatus } from "../entities/crypto-payment-intent.entity";
import { TransactionType } from "../entities/transaction.entity";
import { PaymentMethod } from "../entities/payment.entity";

function build(intent: any) {
  const saved: { entity: string; value: any }[] = [];
  const updates: any[] = [];

  const em: any = {
    createQueryBuilder: jest.fn().mockReturnValue({
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(intent),
      // ledgerBalance() goes through the same builder in these mocks.
      select: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ balance: "100" }),
    }),
    getRepository: jest.fn().mockReturnValue({
      createQueryBuilder: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ balance: "100" }),
      }),
    }),
    create: jest.fn().mockImplementation((_e: any, d: any) => ({ ...d })),
    save: jest.fn().mockImplementation((entity: any, d: any) => {
      const name = entity?.name ?? "unknown";
      const row = { id: `${name}-1`, ...d };
      saved.push({ entity: name, value: row });
      return Promise.resolve(row);
    }),
    update: jest.fn().mockImplementation((entity: any, where: any, patch: any) => {
      updates.push({ entity: entity?.name, where, patch });
      return Promise.resolve(undefined);
    }),
  };
  const ds: any = { transaction: (cb: Function) => cb(em) };
  const userNotifRepo = { create: (e: any) => e, save: async () => undefined };
  return {
    service: new CryptoSettlementService(ds, userNotifRepo as any),
    saved,
    updates,
  };
}

const baseIntent = {
  id: "local-1",
  userId: "u1",
  pay21IntentId: "pay21-1",
  network: "tron",
  amountUsdt: 10,
  detectedAmountUsdt: null,
  creditedAt: null,
  status: CryptoIntentStatus.AWAITING_DEPOSIT,
  txHash: null,
  blockNumber: null,
  failureReason: null,
};

const confirmed = {
  pay21IntentId: "pay21-1",
  status: "confirmed",
  detectedAmountBaseUnits: "9500000", // 9.5 USDT
  txHash: "0xabc",
};

describe("CryptoSettlementService — crediting", () => {
  it("credits the detected amount in USDT", async () => {
    const { service, saved } = build({ ...baseIntent });
    const out = await service.settle(confirmed);

    expect(out.credited).toBe(true);
    const payment = saved.find((r) => r.entity === "Payment")!.value;
    const tx = saved.find((r) => r.entity === "Transaction")!.value;

    expect(payment.method).toBe(PaymentMethod.USDT);
    expect(payment.currency).toBe("USDT");
    expect(Number(payment.amount)).toBe(9.5);
    expect(tx.currency).toBe("USDT");
    expect(Number(tx.amount)).toBe(9.5);
    expect(tx.type).toBe(TransactionType.DEPOSIT);
  });

  it("credits what arrived, not what was asked for", async () => {
    // The intent expected 10; 9.5 landed. Crediting the expectation is how a
    // ledger drifts from what is actually on chain.
    const { service, saved } = build({ ...baseIntent, amountUsdt: 10 });
    await service.settle({ ...confirmed, status: "confirmed_partial" });
    const tx = saved.find((r) => r.entity === "Transaction")!.value;
    expect(Number(tx.amount)).toBe(9.5);
  });

  it("keys the payment on the intent id, not the tx hash", async () => {
    // The intent id is stable across detected, confirmed, partial and top-up;
    // a hash is per transfer. The unique constraint on it is what gives
    // exactly-once at the database layer.
    const { service, saved } = build({ ...baseIntent });
    await service.settle(confirmed);
    const payment = saved.find((r) => r.entity === "Payment")!.value;
    expect(payment.externalPaymentId).toBe("pay21-1");
  });

  it("credits an overpayment in full", async () => {
    const { service, saved } = build({ ...baseIntent });
    await service.settle({
      ...confirmed,
      status: "confirmed_overpaid",
      detectedAmountBaseUnits: "12000000",
    });
    const tx = saved.find((r) => r.entity === "Transaction")!.value;
    // Overpayment is real money received; silently pocketing it is theft.
    expect(Number(tx.amount)).toBe(12);
  });
});

describe("CryptoSettlementService — what must never credit", () => {
  const noCredit = async (status: string, intentPatch: any = {}) => {
    const { service, saved } = build({ ...baseIntent, ...intentPatch });
    const out = await service.settle({ ...confirmed, status });
    return { out, credited: saved.some((r) => r.entity === "Transaction") };
  };

  it("does not credit `accepted` — a soft threshold, not finality", async () => {
    const { out, credited } = await noCredit("accepted");
    expect(credited).toBe(false);
    expect(out.reason).toContain("accepted");
  });

  it("does not credit `completed_via_topup` — the child carries the money", async () => {
    // Parent-only signalling. Crediting here pays twice: once against the
    // child that actually settled, once against this.
    const { out, credited } = await noCredit("completed_via_topup");
    expect(credited).toBe(false);
    expect(out.reason).toBe("topup_parent");
  });

  it("does not credit detected, confirming, expired or failed", async () => {
    for (const s of ["detected", "confirming", "expired", "failed"]) {
      const { credited } = await noCredit(s);
      expect({ s, credited }).toEqual({ s, credited: false });
    }
  });

  it("credits once when the same event is delivered twice", async () => {
    const { out, credited } = await noCredit("confirmed", {
      creditedAt: new Date(),
    });
    expect(credited).toBe(false);
    expect(out.reason).toBe("already_credited");
  });

  it("refuses to credit a crediting status with no detected amount", async () => {
    const { service, saved } = build({ ...baseIntent });
    const out = await service.settle({
      pay21IntentId: "pay21-1",
      status: "confirmed",
      detectedAmountBaseUnits: null,
    });
    expect(out.credited).toBe(false);
    expect(out.reason).toBe("no_detected_amount");
    expect(saved.some((r) => r.entity === "Transaction")).toBe(false);
  });
});

describe("CryptoSettlementService — unknown input", () => {
  it("does not throw on an event for an intent we never created", async () => {
    // Retrying will not conjure the row, so a 5xx would burn 21Pay's whole
    // backoff and terminally fail a delivery we can never accept.
    const { service } = build(null);
    const out = await service.settle(confirmed);
    expect(out).toEqual({
      handled: false,
      credited: false,
      reason: "unknown_intent",
    });
  });

  it("records but does not act on a status it does not recognise", async () => {
    const { service, saved } = build({ ...baseIntent });
    const out = await service.settle({ ...confirmed, status: "teleported" });
    expect(out.reason).toBe("unknown_status");
    expect(saved).toHaveLength(0);
  });
});

describe("CryptoSettlementService.reverse — reorg clawback", () => {
  it("writes a compensating debit and clears the credit", async () => {
    const { service, saved, updates } = build({
      ...baseIntent,
      status: CryptoIntentStatus.CONFIRMED,
      creditedAt: new Date(),
      detectedAmountUsdt: 9.5,
    });

    const out = await service.reverse("pay21-1", "chain reorg");
    expect(out.reason).toBe("reversed");

    const tx = saved.find((r) => r.entity === "Transaction")!.value;
    expect(Number(tx.amount)).toBe(-9.5);
    expect(tx.currency).toBe("USDT");

    const patch = updates.find((u) => u.entity === "CryptoPaymentIntent")!.patch;
    expect(patch.status).toBe(CryptoIntentStatus.FAILED);
    expect(patch.creditedAt).toBeNull();
  });

  it("lets the reversal drive the balance negative", async () => {
    // Deliberate. 21Pay's own clawback drives our tenant balance negative when
    // the money is already gone; pretending otherwise would leave us funding
    // it. A negative balance blocks staking and withdrawal, which is correct
    // and needs an ops path rather than a silent write-off.
    const { service, saved } = build({
      ...baseIntent,
      status: CryptoIntentStatus.CONFIRMED,
      creditedAt: new Date(),
      detectedAmountUsdt: 500, // more than the mocked balance of 100
    });
    await service.reverse("pay21-1", "chain reorg");
    const tx = saved.find((r) => r.entity === "Transaction")!.value;
    expect(Number(tx.balanceAfter)).toBe(-400);
  });

  it("does nothing for an intent that was never credited", async () => {
    const { service, saved } = build({ ...baseIntent, creditedAt: null });
    const out = await service.reverse("pay21-1", "chain reorg");
    expect(out.reason).toBe("not_credited");
    expect(saved).toHaveLength(0);
  });
});
