import { BadRequestException, NotFoundException } from "@nestjs/common";
import { DKBankPaymentService } from "../payment/dkbank-payment.service";
import {
  PaymentStatus,
  PaymentMethod,
  PaymentType,
} from "../entities/payment.entity";
import { OtpStatus } from "../entities/payment-otp.entity";
import { TransactionType } from "../entities/transaction.entity";

// ─── Mock factories ───────────────────────────────────────────────────────────

function makeUser(overrides: any = {}) {
  return {
    id: "user-1",
    telegramId: "99999",
    firstName: "Test",
    dkCid: "11000000001",
    dkAccountNumber: "ACC001",
    dkAccountName: "Test User",
    ...overrides,
  };
}

function makePayment(overrides: any = {}) {
  const { metadata: metaOverride, ...rest } = overrides;
  return {
    id: "payment-1",
    userId: "user-1",
    status: PaymentStatus.PENDING,
    amount: 100,
    currency: "BTN",
    method: PaymentMethod.DK_BANK,
    type: PaymentType.DEPOSIT,
    // DK session stored by initiatePayment (account_auth); confirmPayment reads
    // these to run the debit. Merge so tests can override individual keys.
    metadata: {
      bfsTxnId: "BFS-TXN-001",
      stanNumber: "100001",
      txDatetime: "2026-01-01 00:00:00",
      otpExpiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      customerAccountNumber: "ACC001",
      customerAccountName: "Test User",
      ...(metaOverride ?? {}),
    },
    ...rest,
  };
}

function makeWithdrawalPayment(overrides: any = {}) {
  const { metadata: metaOverride, ...rest } = overrides;
  return makePayment({
    id: "withdrawal-1",
    type: PaymentType.WITHDRAWAL,
    amount: 200,
    // confirmWithdrawal pushes funds to the account stored on the payment.
    metadata: {
      dkAccountNumber: "ACC001",
      dkAccountName: "Test User",
      ...(metaOverride ?? {}),
    },
    ...rest,
  });
}

function makeOtpRecord(overrides: any = {}) {
  return {
    id: "otp-1",
    paymentId: "payment-1",
    userId: "user-1",
    status: OtpStatus.PENDING,
    failedAttempts: 0,
    ...overrides,
  };
}

function makeUserRepo(user: any = makeUser()) {
  return {
    findOne: jest.fn().mockResolvedValue(user),
    create: jest.fn().mockImplementation((d: any) => d),
    save: jest.fn().mockImplementation((d: any) => Promise.resolve(d)),
  };
}

function makePaymentRepo(payment: any = makePayment()) {
  // initiatePayment sums the user's deposits today via a query builder.
  const qb: any = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue({ todayTotal: "0" }),
  };
  return {
    findOne: jest.fn().mockResolvedValue(payment),
    create: jest.fn().mockImplementation((d: any) => d),
    save: jest.fn().mockImplementation((d: any) => Promise.resolve(d)),
    find: jest.fn().mockResolvedValue([]),
    // confirmPayment atomically flips PENDING→PROCESSING via update().
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    _qb: qb,
  };
}

function makeOtpRepo(record: any = makeOtpRecord()) {
  return {
    findOne: jest.fn().mockResolvedValue(record),
    create: jest.fn().mockImplementation((d: any) => d),
    save: jest.fn().mockImplementation((d: any) => Promise.resolve(d)),
  };
}

function makeLinkedBankAccount(user: any = makeUser(), overrides: any = {}) {
  if (!user?.dkCid || !user?.dkAccountNumber) return null;
  return {
    id: "linked-bank-account-1",
    userId: user.id,
    cid: user.dkCid,
    accountNumber: user.dkAccountNumber,
    accountName: user.dkAccountName,
    bankPhone: "17000001",
    isVerified: true,
    isDefault: true,
    ...overrides,
  };
}

function makeLinkedBankAccountRepo(account: any) {
  return {
    findOne: jest.fn().mockResolvedValue(account),
  };
}

function makeBhutanAppNotificationService() {
  return { sendNotification: jest.fn().mockResolvedValue(undefined) };
}

function makeAuthMethodRepo(authMethod: any = null) {
  return {
    findOne: jest.fn().mockResolvedValue(authMethod),
  };
}

function makeRedis(otpSession: any = { otp: "123456", userId: "user-1" }) {
  return {
    getJson: jest.fn().mockResolvedValue(otpSession),
    setJsonEx: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
    rateLimit: jest.fn().mockResolvedValue({ allowed: true }),
  };
}

function makeDkGateway(
  account: any = {
    accountNumber: "ACC001",
    accountName: "Test",
    phoneNumber: "17000001",
  },
) {
  return {
    lookupAccountByCID: jest.fn().mockResolvedValue(account),
    checkTransactionStatus: jest.fn(),
    verifyWebhookSignature: jest.fn().mockReturnValue(true),
    clientInquiry: jest.fn(),
    generateStanNumber: jest.fn().mockReturnValue("123456"),
    /** Simulates DK account_auth — returns bfsTxnId for debit_request */
    authorizeTransaction: jest.fn().mockResolvedValue({
      bfsTxnId: "BFS-TXN-001",
      stanNumber: "123456",
      txDatetime: new Date().toISOString(),
    }),
    /** Simulates DK debit_request — pulls money from user account → merchant vault */
    executeTransactionWithOtp: jest.fn().mockResolvedValue({
      txnStatusId: "TXN-STATUS-001",
      raw: {},
    }),
    /** Simulates merchant-to-user credit transfer (vault → user DK account) */
    transferToAccount: jest.fn().mockResolvedValue({
      txnId: "DK-TXN-W001",
      status: "SUCCESS",
      statusDesc: "Transfer completed",
    }),
    /** Liveness probe — DK reachable by default (the pre-debit guard passes). */
    isReachable: jest.fn().mockResolvedValue(true),
  };
}

function makeDataSource(overrides: any = {}) {
  const em = {
    getRepository: jest.fn().mockReturnValue({
      createQueryBuilder: jest.fn().mockReturnValue({
        setLock: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(makePayment()),
        getRawOne: jest.fn().mockResolvedValue({ balance: 500 }),
      }),
      findOne: jest
        .fn()
        .mockResolvedValue({ id: "user-1", referredByUserId: null }),
    }),
    save: jest.fn().mockImplementation((_e: any, d: any) => Promise.resolve(d)),
    create: jest.fn().mockImplementation((_e: any, d: any) => d),
    // Restamping the debit note on a confirmed payout goes through em.update().
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    findOne: jest.fn().mockResolvedValue({ id: "user-1", bonusBalance: 0 }),
    ...overrides,
  };
  return {
    transaction: jest.fn().mockImplementation((cb: Function) => cb(em)),
    _em: em,
  };
}

function makeTelegramService() {
  return { sendMessage: jest.fn().mockResolvedValue(undefined) };
}

function makeTelegramVerification() {
  return { verifyPaymentIdentity: jest.fn().mockResolvedValue(undefined) };
}

function makeConfigService(overrides: Record<string, string> = {}) {
  const defaults: Record<string, string> = {
    DK_BASE_URL: "http://dk.example.com",
    // Default: staging bypasses ON so existing tests don't hit real DK calls
    DK_STAGING_DEPOSIT_BYPASS: "true",
    DK_STAGING_WITHDRAWAL_BYPASS: "true",
    NODE_ENV: "test",
    ...overrides,
  };
  return {
    get: jest
      .fn()
      .mockImplementation((key: string) => defaults[key] ?? undefined),
  };
}

/** ConfigService that disables all bypasses — simulates production environment */
function makeProductionConfigService() {
  return makeConfigService({
    DK_STAGING_DEPOSIT_BYPASS: "false",
    DK_STAGING_WITHDRAWAL_BYPASS: "false",
    NODE_ENV: "production",
  });
}

function makeService(
  overrides: {
    user?: any;
    payment?: any;
    otp?: any;
    redis?: any;
    dkGateway?: any;
    dataSource?: any;
    telegramVerification?: any;
    configService?: any;
    linkedBankAccount?: any;
    bhutanAppNotification?: any;
    authMethod?: any;
  } = {},
) {
  const userValue = "user" in overrides ? overrides.user : makeUser();
  const userRepo = makeUserRepo(userValue);
  const paymentRepo = makePaymentRepo(
    "payment" in overrides ? overrides.payment : makePayment(),
  );
  const otpRepo = makeOtpRepo(
    "otp" in overrides ? overrides.otp : makeOtpRecord(),
  );
  const lbaRepo = makeLinkedBankAccountRepo(
    "linkedBankAccount" in overrides
      ? overrides.linkedBankAccount
      : makeLinkedBankAccount(userValue),
  );
  const redis = overrides.redis ?? makeRedis();
  const dkGateway = overrides.dkGateway ?? makeDkGateway();
  const dataSource = overrides.dataSource ?? makeDataSource();
  const telegramVerification =
    overrides.telegramVerification ?? makeTelegramVerification();
  const configService = overrides.configService ?? makeConfigService();
  const bhutanAppNotification =
    overrides.bhutanAppNotification ?? makeBhutanAppNotificationService();
  const authMethodRepo = makeAuthMethodRepo(overrides.authMethod ?? null);

  const service = new DKBankPaymentService(
    dataSource as any,
    dkGateway as any,
    configService as any,
    redis as any,
    makeTelegramService() as any,
    userRepo as any,
    lbaRepo as any,
    paymentRepo as any,
    otpRepo as any,
    { emit: jest.fn(), broadcast: jest.fn(), forUser: jest.fn() } as any,
    bhutanAppNotification as any,
    authMethodRepo as any,
  );

  return {
    service,
    userRepo,
    lbaRepo,
    paymentRepo,
    otpRepo,
    redis,
    dkGateway,
    dataSource,
    configService,
    telegramVerification,
    bhutanAppNotification,
    authMethodRepo,
  };
}

// ─── initiatePayment ──────────────────────────────────────────────────────────

describe("DKBankPaymentService.initiatePayment", () => {
  it("throws on non-positive amount", async () => {
    const { service } = makeService();
    await expect(
      service.initiatePayment("user-1", {
        amount: 0,
        cid: "11000000001",
        description: "test",
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      service.initiatePayment("user-1", {
        amount: -50,
        cid: "11000000001",
        description: "test",
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("throws when user has no linked DK account", async () => {
    const { service } = makeService({ user: makeUser({ dkCid: null }) });
    await expect(
      service.initiatePayment("user-1", {
        amount: 100,
        cid: "11000000001",
        description: "top-up",
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("throws when submitted CID does not match linked CID", async () => {
    const { service } = makeService({
      user: makeUser({ dkCid: "11000000001" }),
    });
    await expect(
      service.initiatePayment("user-1", {
        amount: 100,
        cid: "99900000000",
        description: "top-up",
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("throws when user is not found", async () => {
    const { service } = makeService({ user: null });
    await expect(
      service.initiatePayment("user-1", {
        amount: 100,
        cid: "11000000001",
        description: "top-up",
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it("returns otpRequired: true on success and records the OTP session", async () => {
    const { service, otpRepo } = makeService();
    const result = await service.initiatePayment("user-1", {
      amount: 200,
      cid: "11000000001",
      description: "test deposit",
    });

    expect(result.otpRequired).toBe(true);
    expect(result.status).toBe("pending");
    expect(result.amount).toBe(200);
    // OTP session persisted (account_auth → otpRepo.save)
    expect(otpRepo.save).toHaveBeenCalled();
  });
});

// ─── confirmPayment ───────────────────────────────────────────────────────────

describe("DKBankPaymentService.confirmPayment", () => {
  it("throws when payment is not found", async () => {
    const { service } = makeService({ payment: null });
    await expect(
      service.confirmPayment("user-1", "payment-1", "123456"),
    ).rejects.toThrow(NotFoundException);
  });

  it("throws when payment is already confirmed", async () => {
    const { service } = makeService({
      payment: makePayment({ status: PaymentStatus.SUCCESS }),
    });
    await expect(
      service.confirmPayment("user-1", "payment-1", "123456"),
    ).rejects.toThrow(BadRequestException);
  });

  it("throws when the OTP session has expired", async () => {
    // Expiry is enforced from the payment's stored otpExpiresAt.
    const payment = makePayment({
      metadata: { otpExpiresAt: new Date(Date.now() - 60_000).toISOString() },
    });
    const { service } = makeService({ payment });
    await expect(
      service.confirmPayment("user-1", "payment-1", "123456"),
    ).rejects.toThrow(BadRequestException);
  });

  it("throws and increments failedAttempts on wrong OTP", async () => {
    // The OTP is validated by DK's debit_request, so a wrong OTP surfaces as a
    // rejected debit (production mode; the staging bypass skips DK entirely).
    const otpRecord = makeOtpRecord({ failedAttempts: 0 });
    const otpRepo = makeOtpRepo(otpRecord);
    const dkGateway = makeDkGateway();
    dkGateway.executeTransactionWithOtp = jest
      .fn()
      .mockRejectedValue(new BadRequestException("Invalid OTP"));

    const { service } = makeService({
      otp: otpRecord,
      dkGateway,
      configService: makeProductionConfigService(),
    });
    // Re-bind otpRepo so we can inspect saves
    (service as any).otpRepo = otpRepo;

    await expect(
      service.confirmPayment("user-1", "payment-1", "000000"), // wrong OTP
    ).rejects.toThrow(BadRequestException);

    expect(otpRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ failedAttempts: 1 }),
    );
  });

  it("throws immediately when max OTP attempts is already reached", async () => {
    const otpRecord = makeOtpRecord({ failedAttempts: 5 });
    const { service } = makeService({ otp: otpRecord });
    await expect(
      service.confirmPayment("user-1", "payment-1", "123456"),
    ).rejects.toThrow(BadRequestException);
  });

  // ── STAGING bypass path ───────────────────────────────────────────────────

  it("[STAGING BYPASS] credits balance without calling DK account_auth or debit_request", async () => {
    const payment = makePayment({
      status: PaymentStatus.PENDING,
      metadata: {
        customerAccountNumber: "ACC001",
        customerAccountName: "Test",
      },
    });
    const paymentRepo = makePaymentRepo(payment);
    const redis = makeRedis({ otp: "123456", userId: "user-1" });
    const dkGateway = makeDkGateway();
    const dataSource = makeDataSource();
    const em = dataSource._em;
    em.getRepository.mockReturnValue({
      createQueryBuilder: jest.fn().mockReturnValue({
        setLock: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(payment),
        getRawOne: jest.fn().mockResolvedValue({ balance: 0 }),
      }),
      findOne: jest
        .fn()
        .mockResolvedValue({ id: "user-1", referredByUserId: null }),
    });

    // Default makeConfigService has DK_STAGING_DEPOSIT_BYPASS=true
    const { service } = makeService({ payment, redis, dkGateway, dataSource });
    (service as any).paymentRepo = paymentRepo;

    const result = await service.confirmPayment(
      "user-1",
      "payment-1",
      "123456",
    );

    expect(result.status).toBe("success");
    // DK calls must NOT have been made in staging bypass mode
    expect(dkGateway.authorizeTransaction).not.toHaveBeenCalled();
    expect(dkGateway.executeTransactionWithOtp).not.toHaveBeenCalled();
    // Balance was still credited
    expect(em.save).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ type: TransactionType.DEPOSIT }),
    );
  });

  // ── PRODUCTION path: real DK debit ───────────────────────────────────────

  it("[PRODUCTION] calls debit_request (with stored bfsTxnId) before crediting balance", async () => {
    const payment = makePayment({
      status: PaymentStatus.PENDING,
      metadata: {
        customerAccountNumber: "ACC001",
        customerAccountName: "Test User",
      },
      customerPhone: "17123456",
    });
    const paymentRepo = makePaymentRepo(payment);
    const redis = makeRedis({ otp: "123456", userId: "user-1" });
    const dkGateway = makeDkGateway();
    const dataSource = makeDataSource();
    const em = dataSource._em;
    em.getRepository.mockReturnValue({
      createQueryBuilder: jest.fn().mockReturnValue({
        setLock: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(payment),
        getRawOne: jest.fn().mockResolvedValue({ balance: 0 }),
      }),
      findOne: jest
        .fn()
        .mockResolvedValue({ id: "user-1", referredByUserId: null }),
    });

    const { service } = makeService({
      payment,
      redis,
      dkGateway,
      dataSource,
      configService: makeProductionConfigService(), // bypasses OFF
    });
    (service as any).paymentRepo = paymentRepo;

    const result = await service.confirmPayment(
      "user-1",
      "payment-1",
      "123456",
    );

    expect(result.status).toBe("success");

    // account_auth now happens at initiatePayment; confirm must NOT re-run it.
    expect(dkGateway.authorizeTransaction).not.toHaveBeenCalled();

    // debit_request is called with the bfsTxnId stored during initiate
    expect(dkGateway.executeTransactionWithOtp).toHaveBeenCalledWith(
      expect.objectContaining({
        bfsTxnId: "BFS-TXN-001",
        otp: "123456",
        amount: 100,
      }),
    );

    // oro balance was credited
    expect(em.save).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ type: TransactionType.DEPOSIT }),
    );
  });

  it("[PRODUCTION] initiatePayment marks payment FAILED and throws when account_auth fails", async () => {
    // account_auth runs during initiatePayment now — a failure there marks the
    // freshly-created payment FAILED and no OTP session / debit is started.
    const dkGateway = makeDkGateway();
    dkGateway.authorizeTransaction = jest
      .fn()
      .mockRejectedValue(new BadRequestException("Account not found"));

    const { service, paymentRepo } = makeService({
      dkGateway,
      configService: makeProductionConfigService(),
    });

    await expect(
      service.initiatePayment("user-1", {
        amount: 100,
        cid: "11000000001",
        description: "top-up",
      }),
    ).rejects.toThrow(BadRequestException);

    // Payment marked FAILED
    expect(paymentRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: PaymentStatus.FAILED }),
    );
    // debit_request must NOT have been called
    expect(dkGateway.executeTransactionWithOtp).not.toHaveBeenCalled();
  });

  it("[PRODUCTION] reverts the deposit to PENDING (retryable) on a failed OTP below the cap", async () => {
    // A rejected OTP must not kill the payment — the user is allowed up to
    // MAX_OTP_ATTEMPTS tries, so a sub-cap failure reverts to PENDING so a fresh
    // OTP can be submitted against the SAME payment.
    const payment = makePayment({
      status: PaymentStatus.PENDING,
      metadata: {
        customerAccountNumber: "ACC001",
        customerAccountName: "Test",
      },
    });
    const paymentRepo = makePaymentRepo(payment);
    const redis = makeRedis({ otp: "123456", userId: "user-1" });
    const dkGateway = makeDkGateway();
    dkGateway.executeTransactionWithOtp = jest
      .fn()
      .mockRejectedValue(new BadRequestException("Invalid OTP"));
    const otpRecord = makeOtpRecord({ failedAttempts: 0 });

    const { service, otpRepo } = makeService({
      payment,
      redis,
      dkGateway,
      otp: otpRecord,
      configService: makeProductionConfigService(),
    });
    (service as any).paymentRepo = paymentRepo;

    await expect(
      service.confirmPayment("user-1", "payment-1", "123456"),
    ).rejects.toThrow(BadRequestException);

    // Failure counted…
    expect(otpRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ failedAttempts: 1 }),
    );
    // …but the payment stays retryable (PENDING), NOT terminally FAILED.
    expect(paymentRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: PaymentStatus.PENDING }),
    );
    expect(paymentRepo.save).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: PaymentStatus.FAILED }),
    );
  });

  it("[PRODUCTION] marks the deposit FAILED once the OTP attempt cap is reached", async () => {
    const payment = makePayment({
      status: PaymentStatus.PENDING,
      metadata: {
        customerAccountNumber: "ACC001",
        customerAccountName: "Test",
      },
    });
    const paymentRepo = makePaymentRepo(payment);
    const redis = makeRedis({ otp: "123456", userId: "user-1" });
    const dkGateway = makeDkGateway();
    dkGateway.executeTransactionWithOtp = jest
      .fn()
      .mockRejectedValue(new BadRequestException("Invalid OTP"));
    // Already at 4 failures — this attempt is the 5th (== MAX_OTP_ATTEMPTS).
    const otpRecord = makeOtpRecord({ failedAttempts: 4 });

    const { service } = makeService({
      payment,
      redis,
      dkGateway,
      otp: otpRecord,
      configService: makeProductionConfigService(),
    });
    (service as any).paymentRepo = paymentRepo;

    await expect(
      service.confirmPayment("user-1", "payment-1", "123456"),
    ).rejects.toThrow(BadRequestException);

    // Only now — at the cap — is the payment terminally FAILED.
    expect(paymentRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: PaymentStatus.FAILED }),
    );
    // Balance must NOT have been credited
    const creditCall = (makeDataSource()._em.save as jest.Mock).mock?.calls
      ?.map((c: any[]) => c[1])
      ?.find((d: any) => d?.type === TransactionType.DEPOSIT);
    expect(creditCall).toBeUndefined();
  });

  it("credits balance and marks payment SUCCESS on correct OTP (staging bypass)", async () => {
    const payment = makePayment({ status: PaymentStatus.PENDING });
    const paymentRepo = makePaymentRepo(payment);
    const redis = makeRedis({ otp: "123456", userId: "user-1" });

    // applyDKStatusUpdate runs inside a transaction — mock it to track calls
    const dataSource = makeDataSource();
    const em = dataSource._em;

    // Payment repo in transaction should return PENDING payment (for pessimistic lock query)
    em.getRepository.mockReturnValue({
      createQueryBuilder: jest.fn().mockReturnValue({
        setLock: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(payment),
        getRawOne: jest.fn().mockResolvedValue({ balance: 0 }),
      }),
      findOne: jest
        .fn()
        .mockResolvedValue({ id: "user-1", referredByUserId: null }),
    });

    const { service } = makeService({ payment, redis, dataSource });
    // Bind the payment repo so findOne works for the outer lookup
    (service as any).paymentRepo = paymentRepo;

    const result = await service.confirmPayment(
      "user-1",
      "payment-1",
      "123456",
    );

    expect(result.status).toBe("success");
    expect(result.paymentId).toBe("payment-1");
    // Transaction saved a credit entry
    expect(em.save).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ type: TransactionType.DEPOSIT }),
    );
    // Balance cache invalidated after crediting
    expect(redis.del).toHaveBeenCalledWith("oro:cache:balance:user-1");
  });
});

// ─── getPaymentStatus ─────────────────────────────────────────────────────────

describe("DKBankPaymentService.getPaymentStatus", () => {
  it("throws when payment not found", async () => {
    const { service } = makeService({ payment: null });
    await expect(
      service.getPaymentStatus("user-1", "payment-1"),
    ).rejects.toThrow(NotFoundException);
  });

  it("returns success status for a confirmed payment", async () => {
    const payment = makePayment({
      status: PaymentStatus.SUCCESS,
      confirmedAt: new Date("2024-01-01"),
    });
    const { service } = makeService({ payment });
    const result = await service.getPaymentStatus("user-1", "payment-1");
    expect(result.status).toBe("success");
    expect(result.confirmedAt).toBeDefined();
  });

  it("returns failed status with failure reason", async () => {
    const payment = makePayment({
      status: PaymentStatus.FAILED,
      failureReason: "DK Bank rejected",
    });
    const { service } = makeService({ payment });
    const result = await service.getPaymentStatus("user-1", "payment-1");
    expect(result.status).toBe("failed");
    expect(result.failureReason).toBe("DK Bank rejected");
  });

  it("returns pending status when no DK txn ID yet", async () => {
    const payment = makePayment({
      status: PaymentStatus.PENDING,
      dkTxnStatusId: null,
      externalPaymentId: null,
      // No account_auth yet → no bfsTxnId → still "pending" (not "otp_required")
      metadata: { bfsTxnId: null },
    });
    const { service } = makeService({ payment });
    const result = await service.getPaymentStatus("user-1", "payment-1");
    expect(result.status).toBe("pending");
  });
});

// ─── handleWebhook ────────────────────────────────────────────────────────────

describe("DKBankPaymentService.handleWebhook", () => {
  it("throws on invalid webhook signature", async () => {
    const dkGateway = makeDkGateway();
    dkGateway.verifyWebhookSignature = jest.fn().mockReturnValue(false);
    const { service } = makeService({ dkGateway });

    await expect(
      service.handleWebhook({ inquiry_id: "abc" }, "bad-sig"),
    ).rejects.toThrow(BadRequestException);
  });

  it("returns ignored: true when payment is not found by inquiry ID", async () => {
    const paymentRepo = makePaymentRepo(null); // not found
    const { service } = makeService();
    (service as any).paymentRepo = paymentRepo;

    const result = await service.handleWebhook(
      { inquiry_id: "unknown-id" },
      "valid-sig",
    );
    expect(result).toMatchObject({ received: true, ignored: true });
  });

  it("throws when inquiry_id is missing from payload", async () => {
    const { service } = makeService();
    await expect(service.handleWebhook({}, "sig")).rejects.toThrow(
      BadRequestException,
    );
  });
});

// ─── Merchant Vault → User Account (Withdrawal / Transfer) ───────────────────
//
// The merchant account acts as a vault that holds all user credit balances.
// When a user requests a withdrawal, the flow is:
//
//   1. initiateWithdrawal  — validates balance, creates PENDING withdrawal payment,
//                            sends Telegram OTP
//   2. confirmWithdrawal   — validates OTP, debits in-app balance atomically,
//                            calls DK transferToAccount (vault → user DK account),
//                            marks payment SUCCESS
//
// Solvency invariant is maintained: the debit happens inside the same DB
// transaction as the DK transfer call so both succeed or both roll back.

describe("Merchant vault → user DK account (withdrawal flow)", () => {
  // ── initiateWithdrawal ────────────────────────────────────────────────────

  describe("initiateWithdrawal — pre-flight validation", () => {
    it("throws when amount is zero or negative", async () => {
      const { service } = makeService();
      await expect(
        (service as any).initiateWithdrawal("user-1", { amount: 0 }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        (service as any).initiateWithdrawal("user-1", { amount: -100 }),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws when user is not found", async () => {
      const { service } = makeService({ user: null });
      await expect(
        (service as any).initiateWithdrawal("user-1", { amount: 100 }),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws when user has no linked DK Bank account", async () => {
      const { service } = makeService({
        user: makeUser({ dkAccountNumber: null, dkCid: null }),
      });
      await expect(
        (service as any).initiateWithdrawal("user-1", { amount: 100 }),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws when in-app balance is insufficient for the requested amount", async () => {
      // User only has Nu 50 in credits but tries to withdraw Nu 500
      const dataSource = makeDataSource();
      dataSource._em.getRepository.mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getRawOne: jest.fn().mockResolvedValue({ balance: 50 }), // low balance
        }),
      });
      const { service } = makeService({ dataSource });
      await expect(
        (service as any).initiateWithdrawal("user-1", { amount: 500 }),
      ).rejects.toThrow(BadRequestException);
    });

    it("creates a PENDING withdrawal payment and sends a Telegram OTP on success", async () => {
      // User has Nu 1000 in credits, withdraws Nu 200
      const dataSource = makeDataSource();
      dataSource._em.getRepository.mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getRawOne: jest.fn().mockResolvedValue({ balance: 1000 }),
        }),
      });
      const paymentRepo = makePaymentRepo(makeWithdrawalPayment());
      const { service, redis } = makeService({ dataSource });
      (service as any).paymentRepo = paymentRepo;

      const result = await (service as any).initiateWithdrawal("user-1", {
        amount: 200,
      });

      expect(result.otpRequired).toBe(true);
      expect(result.status).toBe("pending");
      expect(result.amount).toBe(200);

      // Withdrawal payment record was persisted
      expect(paymentRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ type: PaymentType.WITHDRAWAL }),
      );
      // OTP stored in Redis for confirmation step
      expect(redis.setJsonEx).toHaveBeenCalled();
    });
  });

  // ── confirmWithdrawal ─────────────────────────────────────────────────────

  describe("confirmWithdrawal — OTP validation + vault transfer", () => {
    it("throws when the withdrawal payment record is not found", async () => {
      const { service } = makeService({ payment: null });
      await expect(
        (service as any).confirmWithdrawal("user-1", "withdrawal-1", "123456"),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws when the withdrawal is already processed (not PENDING)", async () => {
      const { service } = makeService({
        payment: makeWithdrawalPayment({ status: PaymentStatus.SUCCESS }),
      });
      await expect(
        (service as any).confirmWithdrawal("user-1", "withdrawal-1", "123456"),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws when the withdrawal OTP has expired in Redis", async () => {
      const redis = makeRedis(null); // expired — no session in Redis
      const { service } = makeService({
        payment: makeWithdrawalPayment(),
        redis,
      });
      await expect(
        (service as any).confirmWithdrawal("user-1", "withdrawal-1", "123456"),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws on wrong OTP and increments failedAttempts", async () => {
      const otpRecord = makeOtpRecord({
        paymentId: "withdrawal-1",
        failedAttempts: 0,
      });
      const otpRepo = makeOtpRepo(otpRecord);
      const redis = makeRedis({ otp: "999999", userId: "user-1" }); // correct is 999999

      const { service } = makeService({
        payment: makeWithdrawalPayment(),
        redis,
      });
      (service as any).otpRepo = otpRepo;

      await expect(
        (service as any).confirmWithdrawal("user-1", "withdrawal-1", "000000"),
      ).rejects.toThrow(BadRequestException);

      expect(otpRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ failedAttempts: 1 }),
      );
    });

    it("throws when max OTP attempts already reached (lockout)", async () => {
      const otpRecord = makeOtpRecord({
        paymentId: "withdrawal-1",
        failedAttempts: 5,
      });
      const { service } = makeService({
        payment: makeWithdrawalPayment(),
        otp: otpRecord,
      });
      await expect(
        (service as any).confirmWithdrawal("user-1", "withdrawal-1", "123456"),
      ).rejects.toThrow(BadRequestException);
    });

    it("debits in-app balance, calls vault transfer and marks payment SUCCESS on correct OTP", async () => {
      const withdrawal = makeWithdrawalPayment({
        status: PaymentStatus.PENDING,
      });
      const paymentRepo = makePaymentRepo(withdrawal);
      const redis = makeRedis({ otp: "123456", userId: "user-1" });
      const dkGateway = makeDkGateway();

      // Inside the DB transaction: balance = Nu 1000, withdrawal = Nu 200
      const dataSource = makeDataSource();
      const em = dataSource._em;
      em.getRepository.mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue({
          setLock: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockResolvedValue(withdrawal),
          getRawOne: jest.fn().mockResolvedValue({ balance: 1000 }),
        }),
      });

      const { service } = makeService({
        payment: withdrawal,
        redis,
        dkGateway,
        dataSource,
        configService: makeProductionConfigService(), // bypasses OFF → real DK transfer
      });
      (service as any).paymentRepo = paymentRepo;

      const result = await (service as any).confirmWithdrawal(
        "user-1",
        "withdrawal-1",
        "123456",
      );

      expect(result.status).toBe("success");

      // Ledger debit entry written (negative amount for withdrawal)
      expect(em.save).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          type: TransactionType.WITHDRAWAL,
          amount: -200,
        }),
      );

      // DK Gateway was called to push funds from merchant vault to user account
      expect(dkGateway.transferToAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          accountNumber: "ACC001",
          amount: 200,
        }),
      );

      // OTP Redis key cleaned up after use
      expect(redis.del).toHaveBeenCalledWith(
        expect.stringContaining("withdrawal-1"),
      );

      // The debit was written as "reserved" before the bank call; once DK
      // confirms, the same row is restamped so the user's history does not
      // keep reading "reserved" on a payout that completed.
      expect(dataSource._em.save).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ note: "DK Bank withdrawal reserved" }),
      );
      expect(dataSource._em.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          paymentId: "withdrawal-1",
          type: "withdrawal",
        }),
        { note: "DK Bank withdrawal confirmed" },
      );
    });

    it("rejects without debiting when DK is unreachable (pre-debit guard)", async () => {
      const withdrawal = makeWithdrawalPayment({ status: PaymentStatus.PENDING });
      const paymentRepo = makePaymentRepo(withdrawal);
      const redis = makeRedis({ otp: "123456", userId: "user-1" });
      // DK is in maintenance / offline → the liveness probe fails.
      const dkGateway = makeDkGateway();
      dkGateway.isReachable = jest.fn().mockResolvedValue(false);
      const dataSource = makeDataSource();

      const { service } = makeService({
        payment: withdrawal,
        redis,
        dkGateway,
        dataSource,
        configService: makeProductionConfigService(), // bypass OFF → guard runs
      });
      (service as any).paymentRepo = paymentRepo;

      await expect(
        (service as any).confirmWithdrawal("user-1", "withdrawal-1", "123456"),
      ).rejects.toThrow(/temporarily unavailable/i);

      // No debit was ever written, and DK was never asked to transfer.
      expect(dataSource._em.save).not.toHaveBeenCalled();
      expect(dkGateway.transferToAccount).not.toHaveBeenCalled();
    });

    it("does not restamp the debit note when the outcome is ambiguous", async () => {
      // Still in flight — "reserved" is exactly what it is, so it must stand.
      const withdrawal = makeWithdrawalPayment({
        status: PaymentStatus.PENDING,
      });
      const paymentRepo = makePaymentRepo(withdrawal);
      const redis = makeRedis({ otp: "123456", userId: "user-1" });
      const dkGateway = makeDkGateway();
      dkGateway.transferToAccount = jest
        .fn()
        .mockRejectedValue(new Error("DK Bank timeout"));

      const dataSource = makeDataSource();
      dataSource._em.getRepository.mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue({
          setLock: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockResolvedValue(withdrawal),
          getRawOne: jest.fn().mockResolvedValue({ balance: 1000 }),
        }),
      });

      const { service } = makeService({
        payment: withdrawal,
        redis,
        dkGateway,
        dataSource,
        configService: makeProductionConfigService(),
      });
      (service as any).paymentRepo = paymentRepo;

      await (service as any).confirmWithdrawal(
        "user-1",
        "withdrawal-1",
        "123456",
      );

      expect(dataSource._em.update).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: "withdrawal" }),
        { note: "DK Bank withdrawal confirmed" },
      );
    });

    it("leaves the withdrawal PROCESSING with the debit intact when the DK call is ambiguous (throws)", async () => {
      // DK Gateway THROWS (timeout/network) — we cannot know whether the bank
      // paid, so we must NOT reverse the debit and must NOT confirm. The reserved
      // debit stays put and the payment is left PROCESSING for reconciliation.
      const withdrawal = makeWithdrawalPayment({
        status: PaymentStatus.PENDING,
      });
      const paymentRepo = makePaymentRepo(withdrawal);
      const redis = makeRedis({ otp: "123456", userId: "user-1" });
      const dkGateway = makeDkGateway();
      dkGateway.transferToAccount = jest
        .fn()
        .mockRejectedValue(new Error("DK Bank timeout"));

      const dataSource = makeDataSource();
      const em = dataSource._em;
      em.getRepository.mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue({
          setLock: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockResolvedValue(withdrawal),
          getRawOne: jest.fn().mockResolvedValue({ balance: 1000 }),
        }),
      });

      const { service } = makeService({
        payment: withdrawal,
        redis,
        dkGateway,
        dataSource,
        configService: makeProductionConfigService(), // bypasses OFF → real DK transfer throws
      });
      (service as any).paymentRepo = paymentRepo;

      const result = await (service as any).confirmWithdrawal(
        "user-1",
        "withdrawal-1",
        "123456",
      );

      // Ambiguous → reported as processing (resolves, not rejects).
      expect(result.status).toBe("processing");

      // The debit WAS reserved before the bank call…
      const debit = em.save.mock.calls
        .map((c: any[]) => c[1])
        .find(
          (d: any) =>
            d?.type === TransactionType.WITHDRAWAL && d?.amount === -200,
        );
      expect(debit).toBeDefined();

      // …and was NOT reversed (no refund), because DK may have paid.
      const refund = em.save.mock.calls
        .map((c: any[]) => c[1])
        .find((d: any) => d?.type === TransactionType.REFUND);
      expect(refund).toBeUndefined();

      // Payment is left PROCESSING — never SUCCESS, never FAILED.
      expect(withdrawal.status).toBe(PaymentStatus.PROCESSING);
    });

    it("leaves the withdrawal PROCESSING (no refund) when DK RETURNS an ambiguous status", async () => {
      // DK replied cleanly (no throw) but with an indeterminate outcome — e.g.
      // code 2002 (timeout) / 2001 (no response), which the gateway surfaces as
      // status "AMBIGUOUS". The money may or may not have moved, so this must be
      // treated exactly like a thrown call: keep the debit, leave PROCESSING,
      // and NEVER refund (a refund on a transfer that settled would double-pay).
      const withdrawal = makeWithdrawalPayment({
        status: PaymentStatus.PENDING,
      });
      const paymentRepo = makePaymentRepo(withdrawal);
      const redis = makeRedis({ otp: "123456", userId: "user-1" });
      const dkGateway = makeDkGateway();
      dkGateway.transferToAccount = jest.fn().mockResolvedValue({
        txnId: null,
        status: "AMBIGUOUS",
        statusDesc: "Transfer status indeterminate",
      });

      const dataSource = makeDataSource();
      const em = dataSource._em;
      em.getRepository.mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue({
          setLock: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockResolvedValue(withdrawal),
          getRawOne: jest.fn().mockResolvedValue({ balance: 1000 }),
        }),
      });

      const { service } = makeService({
        payment: withdrawal,
        redis,
        dkGateway,
        dataSource,
        configService: makeProductionConfigService(), // bypasses OFF → real DK path
      });
      (service as any).paymentRepo = paymentRepo;

      const result = await (service as any).confirmWithdrawal(
        "user-1",
        "withdrawal-1",
        "123456",
      );

      // Ambiguous reply → processing, not failed.
      expect(result.status).toBe("processing");

      // Debit was reserved…
      const debit = em.save.mock.calls
        .map((c: any[]) => c[1])
        .find(
          (d: any) =>
            d?.type === TransactionType.WITHDRAWAL && d?.amount === -200,
        );
      expect(debit).toBeDefined();

      // …and was NOT reversed — critically, no refund on an ambiguous reply.
      const refund = em.save.mock.calls
        .map((c: any[]) => c[1])
        .find((d: any) => d?.type === TransactionType.REFUND);
      expect(refund).toBeUndefined();

      // Left PROCESSING for reconciliation — never SUCCESS, never FAILED.
      expect(withdrawal.status).toBe(PaymentStatus.PROCESSING);
    });
  });

  // ── Solvency invariant ────────────────────────────────────────────────────

  describe("solvency invariant during withdrawal", () => {
    it("does not allow withdrawal amount to exceed current in-app credit balance", async () => {
      // This test ensures the vault never sends more than the user holds in credits.
      // A user with Nu 150 credits must not be able to withdraw Nu 300.
      const withdrawal = makeWithdrawalPayment({ amount: 300 });
      const paymentRepo = makePaymentRepo(withdrawal);
      const redis = makeRedis({ otp: "123456", userId: "user-1" });

      const dataSource = makeDataSource();
      const em = dataSource._em;
      em.getRepository.mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue({
          setLock: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockResolvedValue(withdrawal),
          getRawOne: jest.fn().mockResolvedValue({ balance: 150 }), // only 150 credits
        }),
      });

      const { service } = makeService({
        payment: withdrawal,
        redis,
        dataSource,
      });
      (service as any).paymentRepo = paymentRepo;

      await expect(
        (service as any).confirmWithdrawal("user-1", "withdrawal-1", "123456"),
      ).rejects.toThrow(BadRequestException);
    });

    it("reserves then reverses the debit (net zero) and marks FAILED when DK returns a failure status", async () => {
      const withdrawal = makeWithdrawalPayment({
        status: PaymentStatus.PENDING,
      });
      const paymentRepo = makePaymentRepo(withdrawal);
      const redis = makeRedis({ otp: "123456", userId: "user-1" });
      const dkGateway = makeDkGateway();
      dkGateway.transferToAccount = jest.fn().mockResolvedValue({
        txnId: "DK-TXN-W002",
        status: "FAILED",
        statusDesc: "Recipient account inactive",
      });

      const dataSource = makeDataSource();
      const em = dataSource._em;
      em.getRepository.mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue({
          setLock: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockResolvedValue(withdrawal),
          getRawOne: jest.fn().mockResolvedValue({ balance: 1000 }),
        }),
      });

      const { service } = makeService({
        payment: withdrawal,
        redis,
        dkGateway,
        dataSource,
        configService: makeProductionConfigService(), // bypasses OFF → real DK transfer
      });
      (service as any).paymentRepo = paymentRepo;

      const result = await (service as any).confirmWithdrawal(
        "user-1",
        "withdrawal-1",
        "123456",
      );

      // Response must report failure
      expect(result.status).toBe("failed");

      // The debit was reserved up front…
      const debit = em.save.mock.calls
        .map((c: any[]) => c[1])
        .find(
          (d: any) =>
            d?.type === TransactionType.WITHDRAWAL && d?.amount === -200,
        );
      expect(debit).toBeDefined();

      // …then reversed with a REFUND (+200) so the net balance effect is zero.
      const refund = em.save.mock.calls
        .map((c: any[]) => c[1])
        .find(
          (d: any) => d?.type === TransactionType.REFUND && d?.amount === 200,
        );
      expect(refund).toBeDefined();

      // Payment entity marked FAILED with a reason.
      expect(withdrawal.status).toBe(PaymentStatus.FAILED);
      expect(withdrawal.failureReason).toEqual(
        expect.stringContaining("Recipient account inactive"),
      );
    });
  });
});
