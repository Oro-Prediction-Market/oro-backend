import { createHmac, generateKeyPairSync } from "crypto";
import * as jwt from "jsonwebtoken";
import { UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { AuthService } from "../auth/auth.service";
import { AuthProvider } from "../entities/auth-method.entity";
import { TransactionType } from "../entities/transaction.entity";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BOT_TOKEN = "1234567890:AABBCCDDEEFFGGHHIIJJKKLLMMNNOOPPQQRR";

/** Build a valid, freshly-signed Telegram initData string. */
function buildValidInitData(
  overrides: {
    id?: number;
    first_name?: string;
    username?: string;
    auth_date?: number;
  } = {},
): string {
  const id = overrides.id ?? 99999;
  const first_name = overrides.first_name ?? "Test";
  const username = overrides.username ?? "testuser";
  const auth_date = overrides.auth_date ?? Math.floor(Date.now() / 1000);

  const user = JSON.stringify({ id, first_name, username });
  const params = new URLSearchParams({
    user,
    auth_date: String(auth_date),
    query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
  });

  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();
  const hash = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");
  params.set("hash", hash);

  return params.toString();
}

// ─── Mocks ────────────────────────────────────────────────────────────────────

function makeUserRepo(user: any = null) {
  const qb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  return {
    findOneBy: jest.fn().mockResolvedValue(user),
    findOne: jest.fn().mockResolvedValue(user),
    create: jest.fn().mockImplementation((data: any) => data),
    save: jest
      .fn()
      .mockImplementation((u: any) => Promise.resolve({ id: "user-1", ...u })),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
  };
}

function makeAuthMethodRepo(method: any = null) {
  return {
    findOne: jest.fn().mockResolvedValue(method),
    create: jest.fn().mockImplementation((data: any) => data),
    save: jest.fn().mockImplementation((m: any) => Promise.resolve(m)),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
}

function makeTransactionRepo() {
  return {
    create: jest.fn().mockImplementation((data: any) => data),
    save: jest.fn().mockResolvedValue({}),
  };
}

function makeJwtService() {
  return {
    sign: jest.fn().mockReturnValue("mock-jwt-token"),
  } as unknown as JwtService;
}

function makeDkGateway(account: any = null) {
  return {
    lookupAccountByCID: jest.fn().mockResolvedValue(
      account ?? {
        accountNumber: "ACC001",
        accountName: "Test User",
        phoneNumber: "17000001",
      },
    ),
  };
}

function makeTelegramVerification() {
  return {
    storeDKPhoneHash: jest.fn().mockResolvedValue(undefined),
    hashPhone: jest.fn().mockReturnValue("hashed-phone"),
  };
}

function makeAuditService() {
  return {
    log: jest.fn().mockResolvedValue(undefined),
  };
}

function makeMarketRepo() {
  return {
    createQueryBuilder: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    }),
  };
}

function makePositionRepo() {
  return {
    createQueryBuilder: jest.fn().mockReturnValue({
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    }),
  };
}

function makeTelegramSimple() {
  return {
    sendMessage: jest.fn().mockResolvedValue(undefined),
    getUserProfilePhotoUrl: jest.fn().mockResolvedValue(null),
    isEphemeralPhotoUrl: jest.fn(
      (url?: string | null) => !!url && /api\.telegram\.org\/file\/bot/i.test(url),
    ),
  };
}

function makeAuditLogRepo() {
  return {
    create: jest.fn().mockImplementation((data: any) => data),
    save: jest.fn().mockResolvedValue({}),
  };
}

function makeRedis() {
  return {
    get: jest.fn().mockResolvedValue(null),
    setEx: jest.fn().mockResolvedValue(undefined),
    redis: {
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(undefined),
    },
  };
}

// ─── validateTelegramInitData ─────────────────────────────────────────────────

describe("AuthService.validateTelegramInitData", () => {
  let service: AuthService;

  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
    service = new AuthService(
      makeUserRepo() as any,
      makeAuthMethodRepo() as any,
      makeTransactionRepo() as any,
      makeMarketRepo() as any,
      makePositionRepo() as any,
      makeJwtService(),
      makeDkGateway() as any,
      makeTelegramVerification() as any,
      makeTelegramSimple() as any,
      makeAuditService() as any,
      makeAuditLogRepo() as any,
      makeRedis() as any,
      { sendSms: jest.fn().mockResolvedValue(true) } as any,
    );
  });

  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it("accepts valid freshly-signed initData", () => {
    const initData = buildValidInitData({ id: 12345 });
    const result = service.validateTelegramInitData(initData);
    expect(result.id).toBe(12345);
    expect(result.first_name).toBe("Test");
  });

  it("throws when hash is missing", () => {
    const params = new URLSearchParams({
      user: '{"id":1}',
      auth_date: "9999999999",
    });
    expect(() => service.validateTelegramInitData(params.toString())).toThrow(
      UnauthorizedException,
    );
  });

  it("throws on tampered initData (wrong hash)", () => {
    const initData = buildValidInitData({ id: 12345 });
    const tampered = initData.replace(/hash=[^&]+/, "hash=deadbeef00000000");
    expect(() => service.validateTelegramInitData(tampered)).toThrow(
      UnauthorizedException,
    );
  });

  it("throws when initData is older than 24 hours", () => {
    const staleAuthDate = Math.floor(Date.now() / 1000) - 86401;
    const initData = buildValidInitData({ auth_date: staleAuthDate });
    expect(() => service.validateTelegramInitData(initData)).toThrow(
      UnauthorizedException,
    );
  });

  it("throws when auth_date is in the future (beyond clock-skew tolerance)", () => {
    // A validly-signed token dated well in the future must be rejected — its
    // negative "age" must not sneak past the max-age freshness check.
    const futureAuthDate = Math.floor(Date.now() / 1000) + 3600; // +1h
    const initData = buildValidInitData({ auth_date: futureAuthDate });
    expect(() => service.validateTelegramInitData(initData)).toThrow(
      UnauthorizedException,
    );
  });

  it("accepts a slightly-future auth_date within the clock-skew tolerance", () => {
    // A minute of clock drift between servers must NOT reject a real login.
    const skewedAuthDate = Math.floor(Date.now() / 1000) + 60; // +1min
    const initData = buildValidInitData({
      id: 4242,
      auth_date: skewedAuthDate,
    });
    const result = service.validateTelegramInitData(initData);
    expect(result.id).toBe(4242);
  });

  it("throws when TELEGRAM_BOT_TOKEN is not set", () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    expect(() =>
      service.validateTelegramInitData("hash=abc&auth_date=1"),
    ).toThrow(UnauthorizedException);
  });
});

// ─── loginWithTelegram ────────────────────────────────────────────────────────

describe("AuthService.loginWithTelegram", () => {
  let service: AuthService;
  let userRepo: ReturnType<typeof makeUserRepo>;
  let authMethodRepo: ReturnType<typeof makeAuthMethodRepo>;

  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
    process.env.NODE_ENV = "test";

    userRepo = makeUserRepo();
    authMethodRepo = makeAuthMethodRepo();

    service = new AuthService(
      userRepo as any,
      authMethodRepo as any,
      makeTransactionRepo() as any,
      makeMarketRepo() as any,
      makePositionRepo() as any,
      makeJwtService(),
      makeDkGateway() as any,
      makeTelegramVerification() as any,
      makeTelegramSimple() as any,
      makeAuditService() as any,
      makeAuditLogRepo() as any,
      makeRedis() as any,
      { sendSms: jest.fn().mockResolvedValue(true) } as any,
    );
  });

  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it("returns pre-KYC response for a brand-new Telegram user", async () => {
    authMethodRepo.findOne.mockResolvedValue(null);
    userRepo.findOneBy.mockResolvedValue(null);

    const initData = buildValidInitData({ id: 99999, username: "newbie" });
    const result = await service.loginWithTelegram(initData);

    expect(result.token).toBeTruthy();
    expect(result.isNewUser).toBe(true);
    expect(result.requiresKYC).toBe(true);
    expect(result.user).toBeNull();
    expect(result.telegramProfile).toMatchObject({ telegramId: "99999" });
  });

  it("updates profile on subsequent login", async () => {
    const existingUser = {
      id: "user-1",
      telegramId: "99999",
      isAdmin: false,
      firstName: "Old",
    };
    const existingMethod = {
      user: existingUser,
      userId: "user-1",
      id: "method-1",
    };

    authMethodRepo.findOne.mockResolvedValue(existingMethod);
    userRepo.findOneBy.mockResolvedValue(existingUser);

    const initData = buildValidInitData({ id: 99999, first_name: "Updated" });
    const result = await service.loginWithTelegram(initData);

    expect(userRepo.update).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ firstName: "Updated" }),
    );
    expect(result.token).toBe("mock-jwt-token");
  });

  it("returns token without sensitive fields", async () => {
    const user = {
      id: "user-1",
      isAdmin: false,
      dkPhoneHash: "secret-hash",
      telegramPhoneHash: "secret-tg-hash",
      phoneNumber: "17000001",
    };
    const method = { user, userId: "user-1", id: "m-1" };

    authMethodRepo.findOne.mockResolvedValue(method);
    userRepo.findOneBy.mockResolvedValue(user);

    const initData = buildValidInitData({ id: 99999 });
    const result = await service.loginWithTelegram(initData);

    expect(result.user).not.toHaveProperty("dkPhoneHash");
    expect(result.user).not.toHaveProperty("telegramPhoneHash");
    expect(result.user).not.toHaveProperty("phoneNumber");
  });

  it("returns pre-KYC token for a brand-new Telegram user without creating DB records", async () => {
    authMethodRepo.findOne.mockResolvedValue(null);
    userRepo.findOneBy.mockResolvedValue(null);

    const initData = buildValidInitData({ id: 77777 });
    const result = await service.loginWithTelegram(initData);

    expect(result.isNewUser).toBe(true);
    expect(result.requiresKYC).toBe(true);
    expect(result.user).toBeNull();
    // Free credit is granted during registration in OnboardService, not here
    expect(result.token).toBeTruthy();
  });
});

// ─── Referral link attribution ────────────────────────────────────────────────

describe("AuthService.loginWithTelegram — referral attribution", () => {
  let service: AuthService;
  let userRepo: ReturnType<typeof makeUserRepo>;
  let authMethodRepo: ReturnType<typeof makeAuthMethodRepo>;

  const REFERRER_TELEGRAM_ID = "111111111";
  const REFERRER_UUID = "referrer-uuid-001";
  const NEW_USER_TELEGRAM_ID = 222222222;

  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
    process.env.NODE_ENV = "test";

    userRepo = makeUserRepo();
    authMethodRepo = makeAuthMethodRepo();

    const savedUser = { id: "new-user-uuid", isAdmin: false };

    // Default: no existing auth method, no existing user row
    authMethodRepo.findOne.mockResolvedValue(null);
    userRepo.save.mockResolvedValue(savedUser);

    // findOneBy is called twice in the new-user path:
    //   1. { telegramId } — check existing user → null
    //   2. { id }         — freshUser re-fetch   → savedUser
    userRepo.findOneBy.mockImplementation(async (where: any) => {
      if (where?.telegramId !== undefined) return null;
      return savedUser;
    });

    // findOne: return referrer when queried by their telegramId, null otherwise
    userRepo.findOne.mockImplementation(({ where }: any) => {
      if (where?.telegramId === REFERRER_TELEGRAM_ID) {
        return Promise.resolve({ id: REFERRER_UUID });
      }
      return Promise.resolve(null);
    });

    service = new AuthService(
      userRepo as any,
      authMethodRepo as any,
      makeTransactionRepo() as any,
      makeMarketRepo() as any,
      makePositionRepo() as any,
      makeJwtService(),
      makeDkGateway() as any,
      makeTelegramVerification() as any,
      makeTelegramSimple() as any,
      makeAuditService() as any,
      makeAuditLogRepo() as any,
      makeRedis() as any,
      { sendSms: jest.fn().mockResolvedValue(true) } as any,
    );
  });

  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it("returns pre-KYC response with referral code preserved for a new user", async () => {
    const initData = buildValidInitData({ id: NEW_USER_TELEGRAM_ID });
    const result = await service.loginWithTelegram(initData, `ref_${REFERRER_TELEGRAM_ID}`);

    expect(result.isNewUser).toBe(true);
    expect(result.requiresKYC).toBe(true);
    // referralCode is forwarded to OnboardService.registerTelegramUser for attribution
    expect(result.referralCode).toBe(`ref_${REFERRER_TELEGRAM_ID}`);
  });

  it("returns pre-KYC response preserving ChallengeAFriend referral code including _m_ suffix", async () => {
    const initData = buildValidInitData({ id: NEW_USER_TELEGRAM_ID });
    const result = await service.loginWithTelegram(
      initData,
      `ref_${REFERRER_TELEGRAM_ID}_m_some-market-uuid`,
    );

    expect(result.isNewUser).toBe(true);
    // Full referral code is preserved so OnboardService can strip and attribute correctly
    expect(result.referralCode).toBe(`ref_${REFERRER_TELEGRAM_ID}_m_some-market-uuid`);
  });

  it("returns pre-KYC response for self-referral (deferred self-referral check is in OnboardService)", async () => {
    const initData = buildValidInitData({ id: Number(REFERRER_TELEGRAM_ID) });
    const result = await service.loginWithTelegram(initData, `ref_${REFERRER_TELEGRAM_ID}`);

    expect(result.isNewUser).toBe(true);
    expect(result.requiresKYC).toBe(true);
  });

  it("does NOT overwrite referredByUserId on a returning user who already has a referrer", async () => {
    const existingUser = {
      id: "existing-user-uuid",
      telegramId: String(NEW_USER_TELEGRAM_ID),
      referredByUserId: "original-referrer-uuid", // already set
      isAdmin: false,
    };
    const existingMethod = { user: existingUser, userId: existingUser.id, id: "m-1" };
    authMethodRepo.findOne.mockResolvedValue(existingMethod);
    userRepo.findOne.mockImplementation(({ where }: any) => {
      if (where?.telegramId === REFERRER_TELEGRAM_ID) return Promise.resolve({ id: REFERRER_UUID });
      if (where?.id === existingUser.id) return Promise.resolve(existingUser);
      return Promise.resolve(null);
    });
    // Returning-user path: findOneBy called once for freshUser re-fetch
    userRepo.findOneBy.mockImplementation(async () => existingUser);

    const initData = buildValidInitData({ id: NEW_USER_TELEGRAM_ID });
    await service.loginWithTelegram(initData, `ref_${REFERRER_TELEGRAM_ID}`);

    // update should NOT include referredByUserId
    const updateCall = userRepo.update.mock.calls[0];
    expect(updateCall[1]).not.toHaveProperty("referredByUserId");
  });

  it("returns pre-KYC response even when the referral code points to a non-existent user", async () => {
    userRepo.findOne.mockResolvedValue(null); // referrer not found
    const initData = buildValidInitData({ id: NEW_USER_TELEGRAM_ID });
    const result = await service.loginWithTelegram(initData, "ref_999999999");

    expect(result.isNewUser).toBe(true);
    // Referrer validation happens in OnboardService.registerTelegramUser
    expect(result.referralCode).toBe("ref_999999999");
  });
});

// ─── loginWithDKBank ──────────────────────────────────────────────────────────

describe("AuthService.loginWithDKBank", () => {
  let service: AuthService;
  let userRepo: ReturnType<typeof makeUserRepo>;
  let authMethodRepo: ReturnType<typeof makeAuthMethodRepo>;
  let dkGateway: ReturnType<typeof makeDkGateway>;
  let telegramVerification: ReturnType<typeof makeTelegramVerification>;

  const dkAccount = {
    accountNumber: "ACC001",
    accountName: "Dorji Wangchuk",
    phoneNumber: "17000001",
  };

  beforeEach(() => {
    jest.spyOn(bcrypt, "compare").mockResolvedValue(true as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    process.env.NODE_ENV = "test";
    userRepo = makeUserRepo();
    authMethodRepo = makeAuthMethodRepo();
    dkGateway = makeDkGateway(dkAccount);
    telegramVerification = makeTelegramVerification();

    service = new AuthService(
      userRepo as any,
      authMethodRepo as any,
      makeTransactionRepo() as any,
      makeMarketRepo() as any,
      makePositionRepo() as any,
      makeJwtService(),
      dkGateway as any,
      telegramVerification as any,
      makeTelegramSimple() as any,
      makeAuditService() as any,
      makeAuditLogRepo() as any,
      makeRedis() as any,
      { sendSms: jest.fn().mockResolvedValue(true) } as any,
    );
  });

  it("creates a new user for an unknown CID", async () => {
    authMethodRepo.findOne.mockResolvedValue(null);
    userRepo.findOneBy.mockResolvedValue(null);
    userRepo.save.mockResolvedValue({
      id: "new-dk-user",
      dkCid: "11000000001",
      isAdmin: false,
    });
    userRepo.findOneBy.mockResolvedValue({ id: "new-dk-user", isAdmin: false, pwaPasswordHash: "hashed" });

    const result = await service.loginWithDKBank("11000000001", undefined, "test-password");

    expect(result.token).toBe("mock-jwt-token");
    expect(result.dkAccount).not.toHaveProperty("phoneNumber");
    expect(result.user).not.toHaveProperty("phoneNumber");
  });

  it("merges DK data into existing Telegram user when callerUserId is provided", async () => {
    const telegramUser = { id: "tg-user-1", isAdmin: false, dkCid: null };
    userRepo.findOneBy.mockResolvedValue(telegramUser);
    authMethodRepo.findOne.mockResolvedValue(null);
    userRepo.findOneBy.mockResolvedValue({
      id: "tg-user-1",
      isAdmin: false,
      dkCid: "11000000001",
    });

    const result = await service.loginWithDKBank("11000000001", "tg-user-1");

    expect(userRepo.update).toHaveBeenCalledWith(
      "tg-user-1",
      expect.objectContaining({ dkCid: "11000000001" }),
    );
    expect(telegramVerification.storeDKPhoneHash).toHaveBeenCalledWith(
      "tg-user-1",
      dkAccount.phoneNumber,
    );
    expect(result.token).toBe("mock-jwt-token");
  });

  it("strips phoneNumber from dkAccount in response", async () => {
    authMethodRepo.findOne.mockResolvedValue(null);
    userRepo.findOneBy.mockResolvedValue(null);
    userRepo.save.mockResolvedValue({ id: "u1", isAdmin: false });
    userRepo.findOneBy.mockResolvedValue({ id: "u1", isAdmin: false, pwaPasswordHash: "hashed" });

    const result = await service.loginWithDKBank("11000000001", undefined, "test-password");

    expect(result.dkAccount).not.toHaveProperty("phoneNumber");
  });

  it("uses existing auth method for a returning user", async () => {
    const existingUser = { id: "u-existing", isAdmin: false, pwaPasswordHash: "hashed" };
    authMethodRepo.findOne.mockResolvedValue({
      userId: "u-existing",
      user: existingUser,
    });
    userRepo.update.mockResolvedValue({ affected: 1 });
    userRepo.findOneBy.mockResolvedValue(existingUser);

    const result = await service.loginWithDKBank("11000000001", undefined, "test-password");

    expect(result.token).toBe("mock-jwt-token");
    expect(userRepo.update).toHaveBeenCalledWith(
      "u-existing",
      expect.objectContaining({ dkCid: "11000000001" }),
    );
  });

  it("does NOT grant Nu 20 free credit for a brand-new DK user (welcome credit disabled)", async () => {
    const txRepo = makeTransactionRepo();
    process.env.NODE_ENV = "test";

    service = new AuthService(
      userRepo as any,
      authMethodRepo as any,
      txRepo as any,
      makeMarketRepo() as any,
      makePositionRepo() as any,
      makeJwtService(),
      dkGateway as any,
      telegramVerification as any,
      makeTelegramSimple() as any,
      makeAuditService() as any,
      makeAuditLogRepo() as any,
      makeRedis() as any,
      { sendSms: jest.fn().mockResolvedValue(true) } as any,
    );

    authMethodRepo.findOne.mockResolvedValue(null);
    // loginWithDKBank runs 4 findOneBy lookups (dkCid, accountNumber,
    // telegramPhoneHash, dkPhoneHash) before reaching the brand-new-user path
    userRepo.findOneBy
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: "new-dk-user", isAdmin: false, pwaPasswordHash: "hashed" });
    userRepo.save.mockResolvedValue({ id: "new-dk-user", isAdmin: false });

    await service.loginWithDKBank("11000000001", undefined, "test-password");

    expect(txRepo.save).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: TransactionType.FREE_CREDIT,
      }),
    );
  });

  it("does NOT grant dev seed credits to a new DK user in test environment", async () => {
    const txRepo = makeTransactionRepo();
    process.env.NODE_ENV = "test";

    service = new AuthService(
      userRepo as any,
      authMethodRepo as any,
      txRepo as any,
      makeMarketRepo() as any,
      makePositionRepo() as any,
      makeJwtService(),
      dkGateway as any,
      telegramVerification as any,
      makeTelegramSimple() as any,
      makeAuditService() as any,
      makeAuditLogRepo() as any,
      makeRedis() as any,
      { sendSms: jest.fn().mockResolvedValue(true) } as any,
    );

    authMethodRepo.findOne.mockResolvedValue(null);
    userRepo.findOneBy
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: "new-dk-user", isAdmin: false, pwaPasswordHash: "hashed" });
    userRepo.save.mockResolvedValue({ id: "new-dk-user", isAdmin: false });

    await service.loginWithDKBank("11000000001", undefined, "test-password");

    expect(txRepo.save).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: TransactionType.DEPOSIT }),
    );
  });

  it("seeds 1000 starter credits for a new DK user in development environment", async () => {
    const txRepo = makeTransactionRepo();
    process.env.NODE_ENV = "development";

    service = new AuthService(
      userRepo as any,
      authMethodRepo as any,
      txRepo as any,
      makeMarketRepo() as any,
      makePositionRepo() as any,
      makeJwtService(),
      dkGateway as any,
      telegramVerification as any,
      makeTelegramSimple() as any,
      makeAuditService() as any,
      makeAuditLogRepo() as any,
      makeRedis() as any,
      { sendSms: jest.fn().mockResolvedValue(true) } as any,
    );

    authMethodRepo.findOne.mockResolvedValue(null);
    userRepo.findOneBy
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: "new-dk-user", isAdmin: false, pwaPasswordHash: "hashed" });
    userRepo.save.mockResolvedValue({ id: "new-dk-user", isAdmin: false });

    await service.loginWithDKBank("11000000001", undefined, "test-password");

    expect(txRepo.save).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: TransactionType.FREE_CREDIT,
      }),
    );
    expect(txRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: TransactionType.DEPOSIT,
        amount: 1000,
        balanceBefore: 0,
        balanceAfter: 1000,
      }),
    );

    process.env.NODE_ENV = "test";
  });
});

// ─── loginWithBhutanApp — identity binding ────────────────────────────────────

describe("AuthService.loginWithBhutanApp — identity binding", () => {
  let service: AuthService;
  let privateKey: string;

  beforeEach(() => {
    const keys = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    privateKey = keys.privateKey;
    process.env.BHUTANAPP_JWT_PUBLIC_KEY = keys.publicKey;
    service = new AuthService(
      makeUserRepo() as any,
      makeAuthMethodRepo() as any,
      makeTransactionRepo() as any,
      makeMarketRepo() as any,
      makePositionRepo() as any,
      makeJwtService(),
      makeDkGateway() as any,
      makeTelegramVerification() as any,
      makeTelegramSimple() as any,
      makeAuditService() as any,
      makeAuditLogRepo() as any,
      makeRedis() as any,
      { sendSms: jest.fn().mockResolvedValue(true) } as any,
    );
  });

  afterEach(() => {
    delete process.env.BHUTANAPP_JWT_PUBLIC_KEY;
    delete process.env.BHUTANAPP_JWT_ISSUER;
    delete process.env.BHUTANAPP_JWT_AUDIENCE;
  });

  const sign = (payload: object) =>
    jwt.sign(payload, privateKey, { algorithm: "RS256" });

  it("rejects a validly-signed token whose audience does not match when enforcement is configured", async () => {
    process.env.BHUTANAPP_JWT_ISSUER = "bhutanapp";
    process.env.BHUTANAPP_JWT_AUDIENCE = "oro";
    // Correctly signed by BhutanApp's key, but minted for a DIFFERENT service.
    const token = sign({
      sub: "11000000001",
      iss: "bhutanapp",
      aud: "some-other-app",
    });
    await expect(
      service.loginWithBhutanApp({
        token,
        externalUserId: "11000000001",
        fullName: "X",
      }),
    ).rejects.toThrow(/Invalid or expired BhutanApp token/);
  });

  it("rejects a validly-signed token from an unexpected issuer when enforcement is configured", async () => {
    process.env.BHUTANAPP_JWT_ISSUER = "bhutanapp";
    process.env.BHUTANAPP_JWT_AUDIENCE = "oro";
    const token = sign({
      sub: "11000000001",
      iss: "not-bhutanapp",
      aud: "oro",
    });
    await expect(
      service.loginWithBhutanApp({
        token,
        externalUserId: "11000000001",
        fullName: "X",
      }),
    ).rejects.toThrow(/Invalid or expired BhutanApp token/);
  });
});

// ─── loginWithBhutanApp — userId anchoring (account-takeover fix) ──────────────
// The signed token carries only { userId, type, iat, exp }; the CID rides in the
// request body (username). These tests lock in that the body CID can never
// select or take over an account — resolution is anchored on the verified userId.

describe("AuthService.loginWithBhutanApp — userId anchoring", () => {
  let privateKey: string;

  const ATTACKER = "aaaaaaaa-0000-0000-0000-000000000001";
  const VICTIM_CID = "11000000009";

  beforeEach(() => {
    const keys = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    privateKey = keys.privateKey;
    process.env.BHUTANAPP_JWT_PUBLIC_KEY = keys.publicKey;
  });
  afterEach(() => {
    delete process.env.BHUTANAPP_JWT_PUBLIC_KEY;
  });

  const sign = (payload: object) =>
    jwt.sign(payload, privateKey, { algorithm: "RS256" });

  function userRepoFor(opts: { byId?: any; byCid?: any; byPhone?: any } = {}) {
    return {
      findOneBy: jest.fn().mockImplementation((where: any) => {
        if (where.id !== undefined) return Promise.resolve(opts.byId ?? null);
        if (where.dkCid !== undefined) return Promise.resolve(opts.byCid ?? null);
        if (where.telegramPhoneHash !== undefined)
          return Promise.resolve(opts.byPhone ?? null);
        if (where.dkPhoneHash !== undefined)
          return Promise.resolve(opts.byPhone ?? null);
        return Promise.resolve(null);
      }),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((d: any) => ({ id: "new-user", ...d })),
      save: jest
        .fn()
        .mockImplementation((u: any) =>
          Promise.resolve({ id: u.id ?? "new-user", ...u }),
        ),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      }),
    };
  }

  function authRepoFor(
    opts: { byProviderId?: any; byUserId?: any; legacy?: any } = {},
  ) {
    return {
      findOne: jest.fn().mockImplementation((arg: any) => {
        const where = arg?.where ?? arg ?? {};
        if (where.providerId !== undefined) {
          // Reflect a re-keyed legacy row so the idempotent ensure step finds it.
          if (opts.legacy && opts.legacy.providerId === where.providerId)
            return Promise.resolve(opts.legacy);
          return Promise.resolve(opts.byProviderId ?? null);
        }
        if (where.userId !== undefined)
          return Promise.resolve(opts.byUserId ?? null);
        return Promise.resolve(null);
      }),
      createQueryBuilder: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(opts.legacy ?? null),
      }),
      create: jest.fn().mockImplementation((d: any) => d),
      save: jest.fn().mockImplementation((m: any) => Promise.resolve(m)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
  }

  function redisWithStore() {
    const store = new Map<string, any>();
    return {
      _store: store,
      setJsonEx: jest.fn().mockImplementation((k: string, _t: number, v: any) => {
        store.set(k, v);
        return Promise.resolve();
      }),
      getJson: jest
        .fn()
        .mockImplementation((k: string) => Promise.resolve(store.get(k) ?? null)),
      del: jest.fn().mockImplementation((k: string) => {
        store.delete(k);
        return Promise.resolve();
      }),
      get: jest.fn().mockResolvedValue(null),
      setEx: jest.fn().mockResolvedValue(undefined),
      redis: {
        incr: jest.fn().mockResolvedValue(1),
        expire: jest.fn().mockResolvedValue(undefined),
      },
    };
  }

  function buildService(o: {
    userRepo: any;
    authRepo: any;
    redis?: any;
    sms?: any;
  }) {
    return new AuthService(
      o.userRepo,
      o.authRepo,
      makeTransactionRepo() as any,
      makeMarketRepo() as any,
      makePositionRepo() as any,
      makeJwtService(),
      makeDkGateway() as any,
      makeTelegramVerification() as any,
      makeTelegramSimple() as any,
      makeAuditService() as any,
      makeAuditLogRepo() as any,
      (o.redis ?? redisWithStore()) as any,
      (o.sms ?? {
        sendOtp: jest.fn().mockResolvedValue(true),
        sendSms: jest.fn(),
      }) as any,
    );
  }

  it("rejects when body externalUserId does not match the signed userId", async () => {
    const service = buildService({
      userRepo: userRepoFor(),
      authRepo: authRepoFor(),
    });
    const token = sign({ userId: ATTACKER, type: "ACCESS_TOKEN" });
    await expect(
      service.loginWithBhutanApp({
        token,
        externalUserId: "some-other-uuid",
        fullName: "X",
        username: VICTIM_CID,
      }),
    ).rejects.toThrow(/identity mismatch/i);
  });

  it("does NOT log an attacker into a victim's VERIFIED account — demands OTP", async () => {
    const victim = {
      id: "victim-1",
      dkCid: VICTIM_CID,
      telegramPhoneHash: "hashed-phone",
      dkPhoneHash: "hashed-phone", // verified: telegram == dk
    };
    const sms = { sendOtp: jest.fn().mockResolvedValue(true), sendSms: jest.fn() };
    const service = buildService({
      userRepo: userRepoFor({ byCid: victim, byId: victim }),
      authRepo: authRepoFor(),
      sms,
    });
    const token = sign({ userId: ATTACKER, type: "ACCESS_TOKEN" });
    const result: any = await service.loginWithBhutanApp({
      token,
      externalUserId: ATTACKER,
      fullName: "Attacker",
      username: VICTIM_CID, // victim's CID in the body
    });
    expect(result.requiresOtp).toBe(true);
    expect(result.token).toBeUndefined();
    expect(result.challengeId).toBeTruthy();
    expect(sms.sendOtp).toHaveBeenCalledTimes(1);
  });

  it("logs a returning user in by verified userId, ignoring the body CID", async () => {
    const user = { id: "user-1", dkCid: "11000000001", email: null };
    const service = buildService({
      userRepo: userRepoFor({ byId: user }),
      authRepo: authRepoFor({
        byProviderId: { userId: "user-1", providerId: ATTACKER },
      }),
    });
    const token = sign({ userId: ATTACKER, type: "ACCESS_TOKEN" });
    const result: any = await service.loginWithBhutanApp({
      token,
      externalUserId: ATTACKER,
      fullName: "User",
      username: VICTIM_CID, // different CID in body — must be ignored
    });
    expect(result.token).toBe("mock-jwt-token");
    expect(result.user.id).toBe("user-1");
  });

  it("migrates a pre-fix (CID-keyed) BhutanApp user via metadata.externalUserId, no OTP", async () => {
    const user = { id: "user-1", email: null };
    const legacy = {
      id: "am-1",
      userId: "user-1",
      providerId: "oldcid",
      metadata: { externalUserId: ATTACKER },
    };
    const authRepo = authRepoFor({ legacy });
    const service = buildService({
      userRepo: userRepoFor({ byId: user }),
      authRepo,
    });
    const token = sign({ userId: ATTACKER, type: "ACCESS_TOKEN" });
    const result: any = await service.loginWithBhutanApp({
      token,
      externalUserId: ATTACKER,
      fullName: "User",
      username: "11000000001",
    });
    expect(result.token).toBe("mock-jwt-token");
    expect(authRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: ATTACKER }),
    );
  });

  it("binds directly to an UNVERIFIED orphan account (no OTP)", async () => {
    const orphan = {
      id: "orphan-1",
      dkCid: VICTIM_CID,
      telegramPhoneHash: null,
      dkPhoneHash: null,
    };
    const service = buildService({
      userRepo: userRepoFor({ byCid: orphan, byId: orphan }),
      authRepo: authRepoFor(),
    });
    const token = sign({ userId: ATTACKER, type: "ACCESS_TOKEN" });
    const result: any = await service.loginWithBhutanApp({
      token,
      externalUserId: ATTACKER,
      fullName: "User",
      username: VICTIM_CID,
    });
    expect(result.token).toBe("mock-jwt-token");
    expect(result.requiresOtp).toBeUndefined();
  });

  it("creates a brand-new account when no candidate exists", async () => {
    const userRepo = userRepoFor();
    const service = buildService({ userRepo, authRepo: authRepoFor() });
    const token = sign({ userId: ATTACKER, type: "ACCESS_TOKEN" });
    const result: any = await service.loginWithBhutanApp({
      token,
      externalUserId: ATTACKER,
      fullName: "New User",
      username: "11000000002",
    });
    expect(result.token).toBe("mock-jwt-token");
    expect(userRepo.create).toHaveBeenCalled();
  });

  it("completes a protected merge only with the correct OTP", async () => {
    const victim = {
      id: "victim-1",
      dkCid: VICTIM_CID,
      telegramPhoneHash: "hashed-phone",
      dkPhoneHash: "hashed-phone",
    };
    const redis = redisWithStore();
    const authRepo = authRepoFor();
    const service = buildService({
      userRepo: userRepoFor({ byCid: victim, byId: victim }),
      authRepo,
      redis,
    });
    const token = sign({ userId: ATTACKER, type: "ACCESS_TOKEN" });
    const login: any = await service.loginWithBhutanApp({
      token,
      externalUserId: ATTACKER,
      fullName: "Legit cross-channel user",
      username: VICTIM_CID,
    });
    expect(login.requiresOtp).toBe(true);
    const session = redis._store.get(`bhutan_merge:${login.challengeId}`);
    expect(session).toBeTruthy();

    // Wrong OTP → rejected, no binding.
    await expect(
      service.verifyBhutanAppMerge(login.challengeId, "000000"),
    ).rejects.toThrow(/Invalid OTP/i);

    // Correct OTP → the verified userId is bound to the account.
    const ok: any = await service.verifyBhutanAppMerge(
      login.challengeId,
      session.otp,
    );
    expect(ok.token).toBe("mock-jwt-token");
    expect(authRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: ATTACKER, userId: "victim-1" }),
    );
  });
});

// ─── Avatar link refresh (Telegram getFile links expire ~1h) ──────────────────

describe("AuthService.loginWithTelegram — avatar link refresh", () => {
  let service: AuthService;
  let userRepo: ReturnType<typeof makeUserRepo>;
  let authMethodRepo: ReturnType<typeof makeAuthMethodRepo>;
  let telegramSimple: ReturnType<typeof makeTelegramSimple>;

  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
    process.env.NODE_ENV = "test";
    userRepo = makeUserRepo();
    authMethodRepo = makeAuthMethodRepo();
    telegramSimple = makeTelegramSimple();
    service = new AuthService(
      userRepo as any,
      authMethodRepo as any,
      makeTransactionRepo() as any,
      makeMarketRepo() as any,
      makePositionRepo() as any,
      makeJwtService(),
      makeDkGateway() as any,
      makeTelegramVerification() as any,
      telegramSimple as any,
      makeAuditService() as any,
      makeAuditLogRepo() as any,
      makeRedis() as any,
      { sendSms: jest.fn().mockResolvedValue(true) } as any,
    );
  });

  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  const loginWith = (photoUrl: string) => {
    const existingUser = {
      id: "user-1",
      telegramId: "99999",
      isAdmin: false,
      photoUrl,
    };
    authMethodRepo.findOne.mockResolvedValue({
      user: existingUser,
      userId: "user-1",
      id: "m-1",
    });
    userRepo.findOneBy.mockResolvedValue(existingUser);
    return service.loginWithTelegram(buildValidInitData({ id: 99999 }));
  };

  it("refreshes a temporary Bot-API avatar link on login", async () => {
    telegramSimple.getUserProfilePhotoUrl.mockResolvedValue(
      "https://api.telegram.org/file/botX/photos/fresh.jpg",
    );
    await loginWith("https://api.telegram.org/file/botX/photos/old.jpg");
    expect(telegramSimple.getUserProfilePhotoUrl).toHaveBeenCalled();
    expect(userRepo.update).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        photoUrl: "https://api.telegram.org/file/botX/photos/fresh.jpg",
      }),
    );
  });

  it("keeps a long-lived t.me/i/userpic avatar without an API call", async () => {
    await loginWith("https://t.me/i/userpic/320/abcDEF.jpg");
    expect(telegramSimple.getUserProfilePhotoUrl).not.toHaveBeenCalled();
    const updateArg = userRepo.update.mock.calls[0]?.[1] ?? {};
    expect(updateArg).not.toHaveProperty("photoUrl");
  });

  it("keeps a telegram.me CDN avatar (does not treat it as temporary)", async () => {
    await loginWith("https://telegram.me/i/userpic/320/xyz.jpg");
    expect(telegramSimple.getUserProfilePhotoUrl).not.toHaveBeenCalled();
    const updateArg = userRepo.update.mock.calls[0]?.[1] ?? {};
    expect(updateArg).not.toHaveProperty("photoUrl");
  });
});
