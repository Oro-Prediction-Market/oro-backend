/**
 * DKWithdrawalReconciler — which status route a stuck withdrawal is resolved by.
 *
 * DK's new core system answers an initiate call with `0001` and a
 * `payment_number`, and the legacy `/v1/transaction/status` route cannot say
 * anything about those transfers — it crashed outright on 21 Sep 2026, which is
 * why four withdrawals sat in PROCESSING with nothing able to settle them.
 *
 * The handle a payment carries picks the route, so old rows keep reconciling
 * exactly as they did and new-core rows stop needing a human.
 */
import { DKWithdrawalReconciler } from "../payment/dk-withdrawal.reconciler";
import { PaymentStatus } from "../entities/payment.entity";
import { TransactionType } from "../entities/transaction.entity";

const USER_ACCOUNT = "110000000001";

function makePayment(overrides: any = {}) {
  return {
    id: "pay-1",
    userId: "user-1",
    amount: 200,
    status: PaymentStatus.PROCESSING,
    externalPaymentId: null,
    dkTxnStatusId: null,
    metadata: { dkAccountNumber: USER_ACCOUNT },
    ...overrides,
  };
}

function makeReconciler(payment: any) {
  const paymentRepo: any = {
    find: jest.fn(),
    update: jest.fn(),
    findOne: jest.fn().mockResolvedValue(payment),
  };
  const dkGateway: any = {
    checkTransactionStatus: jest.fn(),
    checkTransferStatus: jest.fn(),
  };
  const redis: any = { del: jest.fn() };
  const sse: any = { emit: jest.fn() };
  const userNotifRepo: any = {
    create: jest.fn((x: any) => x),
    save: jest.fn().mockResolvedValue({}),
  };
  const em: any = {
    getRepository: jest.fn(() => ({
      createQueryBuilder: jest.fn(() => ({
        setLock: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(payment),
        getRawOne: jest.fn().mockResolvedValue({ balance: 500 }),
      })),
    })),
    update: jest.fn(),
    save: jest.fn(async (_e: any, o: any) => o ?? _e),
    create: jest.fn((_e: any, o: any) => o),
  };
  const dataSource: any = {
    transaction: jest.fn(async (cb: any) => cb(em)),
  };
  const reconciler = new DKWithdrawalReconciler(
    dataSource,
    paymentRepo,
    dkGateway,
    redis,
    sse,
    userNotifRepo,
  );
  return { reconciler, paymentRepo, dkGateway, em, userNotifRepo, redis };
}

const reconcile = (r: any, p: any) => (r as any).reconcileOne(p);

describe("DKWithdrawalReconciler — route selection", () => {
  it("resolves a new-core payment through the intra-transaction status route", async () => {
    const payment = makePayment({
      metadata: { dkAccountNumber: USER_ACCOUNT, dkTransfer: { paymentNumber: "PN-123" } },
    });
    const { reconciler, dkGateway } = makeReconciler(payment);
    dkGateway.checkTransferStatus.mockResolvedValue({
      verdict: "pending",
      status: "validating",
      settledAt: null,
      responseCode: "0001",
    });

    await reconcile(reconciler, payment);

    expect(dkGateway.checkTransferStatus).toHaveBeenCalledWith({
      referenceNo: "PN-123",
      beneAccountNumber: USER_ACCOUNT,
    });
    expect(dkGateway.checkTransactionStatus).not.toHaveBeenCalled();
  });

  // The legacy route hardcodes the merchant vault as bene_account_number. For a
  // payout the credited account is the user's, so asking about the vault is
  // asking about the wrong side of the transfer.
  it("scopes the lookup to the user's account, never the merchant vault", async () => {
    const payment = makePayment({
      metadata: { dkAccountNumber: USER_ACCOUNT, dkTransfer: { paymentNumber: "PN-123" } },
    });
    const { reconciler, dkGateway } = makeReconciler(payment);
    dkGateway.checkTransferStatus.mockResolvedValue({
      verdict: "pending",
      responseCode: "0001",
    });

    await reconcile(reconciler, payment);

    const arg = dkGateway.checkTransferStatus.mock.calls[0][0];
    expect(arg.beneAccountNumber).toBe(USER_ACCOUNT);
  });

  it("keeps using the legacy route for a payment with only a legacy handle", async () => {
    const payment = makePayment({ externalPaymentId: "DK-OLD-1" });
    const { reconciler, dkGateway } = makeReconciler(payment);
    dkGateway.checkTransactionStatus.mockResolvedValue({ status: "PENDING" });

    await reconcile(reconciler, payment);

    expect(dkGateway.checkTransactionStatus).toHaveBeenCalledWith("DK-OLD-1");
    expect(dkGateway.checkTransferStatus).not.toHaveBeenCalled();
  });

  it("falls back to the legacy route when the destination account is unknown", async () => {
    const payment = makePayment({
      externalPaymentId: "DK-OLD-1",
      metadata: { dkTransfer: { paymentNumber: "PN-123" } },
    });
    const { reconciler, dkGateway } = makeReconciler(payment);
    dkGateway.checkTransactionStatus.mockResolvedValue({ status: "PENDING" });

    await reconcile(reconciler, payment);

    expect(dkGateway.checkTransferStatus).not.toHaveBeenCalled();
  });
});

describe("DKWithdrawalReconciler — applying a new-core verdict", () => {
  it("marks a settled transfer SUCCESS without refunding", async () => {
    const payment = makePayment({
      metadata: { dkAccountNumber: USER_ACCOUNT, dkTransfer: { paymentNumber: "PN-123" } },
    });
    const { reconciler, dkGateway, em } = makeReconciler(payment);
    dkGateway.checkTransferStatus.mockResolvedValue({
      verdict: "success",
      status: "settled",
      settledAt: "2026-09-22T10:00:00Z",
      responseCode: "0000",
    });

    await reconcile(reconciler, payment);

    expect(payment.status).toBe(PaymentStatus.SUCCESS);
    const refund = em.save.mock.calls
      .map((c: any[]) => c[1])
      .find((d: any) => d?.type === TransactionType.REFUND);
    expect(refund).toBeUndefined();
  });

  it("refunds a refused transfer", async () => {
    const payment = makePayment({
      metadata: { dkAccountNumber: USER_ACCOUNT, dkTransfer: { paymentNumber: "PN-123" } },
    });
    const { reconciler, dkGateway, em } = makeReconciler(payment);
    dkGateway.checkTransferStatus.mockResolvedValue({
      verdict: "failed",
      status: "rejected",
      settledAt: null,
      responseCode: "0000",
      statusDesc: "Beneficiary account closed",
    });

    await reconcile(reconciler, payment);

    expect(payment.status).toBe(PaymentStatus.FAILED);
    const refund = em.save.mock.calls
      .map((c: any[]) => c[1])
      .find((d: any) => d?.type === TransactionType.REFUND);
    expect(refund).toBeDefined();
    expect(refund.amount).toBe(200);
  });

  it("leaves a pending transfer untouched and refunds nothing", async () => {
    const payment = makePayment({
      metadata: { dkAccountNumber: USER_ACCOUNT, dkTransfer: { paymentNumber: "PN-123" } },
    });
    const { reconciler, dkGateway, em } = makeReconciler(payment);
    dkGateway.checkTransferStatus.mockResolvedValue({
      verdict: "pending",
      status: "validating",
      settledAt: null,
      responseCode: "0001",
    });

    await reconcile(reconciler, payment);

    expect(payment.status).toBe(PaymentStatus.PROCESSING);
    expect(em.save).not.toHaveBeenCalled();
  });
});

/**
 * Timing. The new rail settles in seconds and its status endpoint answers
 * immediately, so making a user wait ten minutes for the first check — and
 * another thirty for the next — is latency we choose rather than latency DK
 * imposes. Legacy rows keep the old, slower cadence.
 */
describe("DKWithdrawalReconciler — how soon a row is asked about", () => {
  const MINUTE = 60 * 1000;

  it("sweeps rows old enough for the new rail, not just the legacy grace", async () => {
    const { reconciler, paymentRepo } = makeReconciler(makePayment());
    paymentRepo.find.mockResolvedValue([]);

    await reconciler.reconcileStuckWithdrawals();

    const cutoff = paymentRepo.find.mock.calls[0][0].where.createdAt.value;
    const ageMs = Date.now() - new Date(cutoff).getTime();
    expect(ageMs).toBeLessThan(5 * MINUTE);
  });

  it("still lets a legacy row settle for ten minutes before asking", async () => {
    const payment = makePayment({
      externalPaymentId: "DK-OLD-1",
      createdAt: new Date(Date.now() - 4 * MINUTE),
    });
    const { reconciler, dkGateway } = makeReconciler(payment);

    await reconcile(reconciler, payment);

    expect(dkGateway.checkTransactionStatus).not.toHaveBeenCalled();
  });

  it("asks about a new-core row as soon as it is swept", async () => {
    const payment = makePayment({
      createdAt: new Date(Date.now() - 4 * MINUTE),
      metadata: { dkAccountNumber: USER_ACCOUNT, dkTransfer: { paymentNumber: "PN-123" } },
    });
    const { reconciler, dkGateway } = makeReconciler(payment);
    dkGateway.checkTransferStatus.mockResolvedValue({
      verdict: "pending",
      responseCode: "0001",
    });

    await reconcile(reconciler, payment);

    expect(dkGateway.checkTransferStatus).toHaveBeenCalled();
  });

  it("re-asks a new-core row minutes later, not half an hour later", async () => {
    const payment = makePayment({
      createdAt: new Date(Date.now() - 30 * MINUTE),
      metadata: {
        dkAccountNumber: USER_ACCOUNT,
        dkTransfer: { paymentNumber: "PN-123" },
        dkReconcileCheckedAt: Date.now() - 6 * MINUTE,
      },
    });
    const { reconciler, dkGateway } = makeReconciler(payment);
    dkGateway.checkTransferStatus.mockResolvedValue({
      verdict: "pending",
      responseCode: "0001",
    });

    await reconcile(reconciler, payment);

    expect(dkGateway.checkTransferStatus).toHaveBeenCalled();
  });

  it("does not hammer a new-core row that was just checked", async () => {
    const payment = makePayment({
      createdAt: new Date(Date.now() - 30 * MINUTE),
      metadata: {
        dkAccountNumber: USER_ACCOUNT,
        dkTransfer: { paymentNumber: "PN-123" },
        dkReconcileCheckedAt: Date.now() - 30 * 1000,
      },
    });
    const { reconciler, dkGateway } = makeReconciler(payment);

    await reconcile(reconciler, payment);

    expect(dkGateway.checkTransferStatus).not.toHaveBeenCalled();
  });

  it("keeps the thirty-minute recheck for a legacy row", async () => {
    const payment = makePayment({
      externalPaymentId: "DK-OLD-1",
      createdAt: new Date(Date.now() - 60 * MINUTE),
      metadata: {
        dkAccountNumber: USER_ACCOUNT,
        dkReconcileCheckedAt: Date.now() - 6 * MINUTE,
      },
    });
    const { reconciler, dkGateway } = makeReconciler(payment);

    await reconcile(reconciler, payment);

    expect(dkGateway.checkTransactionStatus).not.toHaveBeenCalled();
  });
});

/**
 * Closing a stuck withdrawal by hand, from DK's statement.
 *
 * In September four users' money sat in PROCESSING for four days and was
 * returned with SQL. This runs the reconciler's own finalise instead, so a
 * manual close goes through the same locks and writes the same rows.
 */
describe("DKWithdrawalReconciler — manual close", () => {
  const dk = (over: any = {}) =>
    makePayment({ type: "withdrawal", method: "dkbank", ...over });
  const admin = { adminId: "admin-1", note: "Not on DK statement 20-24 Sep" };

  it("returns the money with a refund row when DK did not send it", async () => {
    const payment = dk();
    const { reconciler, em } = makeReconciler(payment);

    await expect(
      reconciler.resolveManually("pay-1", "not_sent", admin),
    ).resolves.toBe("failed");

    const refund = em.save.mock.calls.find(
      (c: any[]) => c[1]?.type === TransactionType.REFUND,
    )?.[1];
    expect(refund).toMatchObject({ amount: 200, paymentId: "pay-1", userId: "user-1" });
    expect(payment.status).toBe(PaymentStatus.FAILED);
  });

  it("keeps the customer-visible reason neutral and the admin's note in metadata", async () => {
    const payment = dk();
    const { reconciler } = makeReconciler(payment);

    await reconciler.resolveManually("pay-1", "not_sent", admin);

    expect(payment.failureReason).toBe(
      "Withdrawal could not be completed — funds returned to your wallet",
    );
    expect(payment.metadata.manualReconcile).toMatchObject({
      verdict: "not_sent",
      adminId: "admin-1",
      note: admin.note,
    });
  });

  it("lets the debit stand and writes no refund when DK did send it", async () => {
    const payment = dk();
    const { reconciler, em } = makeReconciler(payment);

    await expect(reconciler.resolveManually("pay-1", "sent", admin)).resolves.toBe(
      "success",
    );

    expect(
      em.save.mock.calls.some((c: any[]) => c[1]?.type === TransactionType.REFUND),
    ).toBe(false);
    expect(em.update).toHaveBeenCalledWith(
      expect.anything(),
      { paymentId: "pay-1", type: TransactionType.WITHDRAWAL },
      { note: "DK Bank withdrawal confirmed" },
    );
    expect(payment.status).toBe(PaymentStatus.SUCCESS);
  });

  it("sends the user nothing unless asked", async () => {
    const { reconciler, userNotifRepo } = makeReconciler(dk());
    await reconciler.resolveManually("pay-1", "not_sent", admin);
    expect(userNotifRepo.save).not.toHaveBeenCalled();
  });

  it("notifies when asked", async () => {
    const { reconciler, userNotifRepo } = makeReconciler(dk());
    await reconciler.resolveManually("pay-1", "sent", admin, true);
    expect(userNotifRepo.save).toHaveBeenCalledTimes(1);
  });

  it("still notifies on the automatic path", async () => {
    const payment = makePayment({ externalPaymentId: "DK-OLD-1" });
    const { reconciler, dkGateway, userNotifRepo } = makeReconciler(payment);
    dkGateway.checkTransactionStatus.mockResolvedValue({ status: "SUCCESS" });
    (payment as any).createdAt = new Date(Date.now() - 3600_000);

    await reconcile(reconciler, payment);

    expect(userNotifRepo.save).toHaveBeenCalledTimes(1);
  });

  it.each([PaymentStatus.SUCCESS, PaymentStatus.FAILED, PaymentStatus.PENDING])(
    "refuses a withdrawal that is %s",
    async (status) => {
      const { reconciler, em } = makeReconciler(dk({ status }));
      await expect(
        reconciler.resolveManually("pay-1", "not_sent", admin),
      ).rejects.toThrow(/only a processing withdrawal/);
      expect(em.save).not.toHaveBeenCalled();
    },
  );

  it("refuses anything that is not a DK withdrawal", async () => {
    const { reconciler } = makeReconciler(dk({ type: "deposit" }));
    await expect(
      reconciler.resolveManually("pay-1", "not_sent", admin),
    ).rejects.toThrow(/not found/);
  });

  it("still clears the cached balance when another path finalised first, as before", async () => {
    const payment = dk();
    const { reconciler, em, redis } = makeReconciler(payment);
    em.getRepository.mockImplementation(() => ({
      createQueryBuilder: () => ({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({ ...payment, status: PaymentStatus.SUCCESS }),
      }),
    }));
    await (reconciler as any).finalise(payment, "failed", { status: "FAILED" });
    expect(redis.del).toHaveBeenCalledWith("oro:cache:balance:user-1");
  });

  it("reports a close that lost the race to another admin", async () => {
    const payment = dk();
    const { reconciler, em } = makeReconciler(payment);
    // The pre-check saw PROCESSING; by the time the lock is taken it is not.
    em.getRepository.mockImplementation(() => ({
      createQueryBuilder: () => ({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest
          .fn()
          .mockResolvedValue({ ...payment, status: PaymentStatus.FAILED }),
      }),
    }));
    await expect(
      reconciler.resolveManually("pay-1", "not_sent", admin),
    ).rejects.toThrow(/closed by someone else/);
  });
});
