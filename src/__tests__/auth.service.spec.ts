import { createHmac } from "crypto";
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
  return {
    findOneBy: jest.fn().mockResolvedValue(user),
    findOne: jest.fn().mockResolvedValue(user),
    create: jest.fn().mockImplementation((data: any) => data),
    save: jest
      .fn()
      .mockImplementation((u: any) => Promise.resolve({ id: "user-1", ...u })),
    update: jest.fn().mockResolvedValue(undefined),
  };
}

function makeAuthMethodRepo(method: any = null) {
  return {
    findOne: jest.fn().mockResolvedValue(method),
    create: jest.fn().mockImplementation((data: any) => data),
    save: jest.fn().mockImplementation((m: any) => Promise.resolve(m)),
    update: jest.fn().mockResolvedValue(undefined),
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
    );
  });

  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it("creates a new user on first login", async () => {
    // No existing auth method, no existing user
    authMethodRepo.findOne.mockResolvedValue(null);
    userRepo.findOneBy.mockResolvedValue(null);
    userRepo.save.mockResolvedValue({
      id: "new-user",
      telegramId: "99999",
      isAdmin: false,
    });
    userRepo.findOneBy.mockResolvedValueOnce(null).mockResolvedValue({
      id: "new-user",
      telegramId: "99999",
      isAdmin: false,
    });

    const initData = buildValidInitData({ id: 99999, username: "newbie" });
    const result = await service.loginWithTelegram(initData);

    expect(result.token).toBe("mock-jwt-token");
    expect(result.user).not.toHaveProperty("dkPhoneHash");
    expect(result.user).not.toHaveProperty("telegramPhoneHash");
    expect(result.user).not.toHaveProperty("phoneNumber");
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

  it("grants Nu 20 free credit on first registration (all environments)", async () => {
    const txRepo = makeTransactionRepo();
    process.env.NODE_ENV = "test";

    service = new AuthService(
      userRepo as any,
      authMethodRepo as any,
      txRepo as any,
      makeMarketRepo() as any,
      makePositionRepo() as any,
      makeJwtService(),
      makeDkGateway() as any,
      makeTelegramVerification() as any,
      makeTelegramSimple() as any,
      makeAuditService() as any,
      makeAuditLogRepo() as any,
      makeRedis() as any,
    );

    authMethodRepo.findOne.mockResolvedValue(null);
    userRepo.findOneBy
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: "new-user", isAdmin: false });
    userRepo.save.mockResolvedValue({ id: "new-user", isAdmin: false });

    const initData = buildValidInitData({ id: 77777 });
    await service.loginWithTelegram(initData);

    expect(txRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: TransactionType.FREE_CREDIT,
        amount: 20,
        isBonus: true,
      }),
    );
  });

  it("does NOT grant dev seed credits in test environment", async () => {
    const txRepo = makeTransactionRepo();
    process.env.NODE_ENV = "test";

    service = new AuthService(
      userRepo as any,
      authMethodRepo as any,
      txRepo as any,
      makeMarketRepo() as any,
      makePositionRepo() as any,
      makeJwtService(),
      makeDkGateway() as any,
      makeTelegramVerification() as any,
      makeTelegramSimple() as any,
      makeAuditService() as any,
      makeAuditLogRepo() as any,
      makeRedis() as any,
    );

    authMethodRepo.findOne.mockResolvedValue(null);
    userRepo.findOneBy.mockResolvedValue(null);
    userRepo.save.mockResolvedValue({ id: "new-user", isAdmin: false });
    userRepo.findOneBy.mockResolvedValue({ id: "new-user", isAdmin: false });

    const initData = buildValidInitData({ id: 77777 });
    await service.loginWithTelegram(initData);

    expect(txRepo.save).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: TransactionType.DEPOSIT }),
    );
  });

  it("seeds 1000 extra credits in development environment on top of free credit", async () => {
    const txRepo = makeTransactionRepo();
    process.env.NODE_ENV = "development";

    service = new AuthService(
      userRepo as any,
      authMethodRepo as any,
      txRepo as any,
      makeMarketRepo() as any,
      makePositionRepo() as any,
      makeJwtService(),
      makeDkGateway() as any,
      makeTelegramVerification() as any,
      makeTelegramSimple() as any,
      makeAuditService() as any,
      makeAuditLogRepo() as any,
      makeRedis() as any,
    );

    authMethodRepo.findOne.mockResolvedValue(null);
    userRepo.findOneBy
      .mockResolvedValueOnce(null) // no existing user by telegramId
      .mockResolvedValue({ id: "new-user", isAdmin: false }); // freshUser lookup
    userRepo.save.mockResolvedValue({ id: "new-user", isAdmin: false });

    const initData = buildValidInitData({ id: 88888 });
    await service.loginWithTelegram(initData);

    // Free credit must fire first
    expect(txRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: TransactionType.FREE_CREDIT,
        amount: 20,
        isBonus: true,
      }),
    );
    // Dev seed on top
    expect(txRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: TransactionType.DEPOSIT,
        amount: 1000,
        balanceBefore: 20,
        balanceAfter: 1020,
      }),
    );

    process.env.NODE_ENV = "test";
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
    userRepo.update.mockResolvedValue(undefined);
    userRepo.findOneBy.mockResolvedValue(existingUser);

    const result = await service.loginWithDKBank("11000000001", undefined, "test-password");

    expect(result.token).toBe("mock-jwt-token");
    expect(userRepo.update).toHaveBeenCalledWith(
      "u-existing",
      expect.objectContaining({ dkCid: "11000000001" }),
    );
  });
});
