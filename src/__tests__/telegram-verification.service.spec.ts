import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { TelegramVerificationService } from "../telegram/telegram-verification.service";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PHONE_HASH_SECRET = "test-secret";
const { createHmac } = require("crypto");

function hashPhone(phone: string): string {
  const normalised = phone.replace(/[\s\-\+]/g, "");
  return createHmac("sha256", PHONE_HASH_SECRET).update(normalised).digest("hex");
}

function makeUser(overrides: any = {}) {
  return {
    id: "user-1",
    telegramId: "99999",
    telegramChatId: null,
    telegramPhoneHash: null,
    telegramLinkedAt: null,
    dkCid: "11000000001",
    dkAccountNumber: "ACC001234567",
    dkAccountName: "Sonam Tenzin",
    dkPhoneHash: hashPhone("+97517123456"),
    dkLinkVerifiedAt: null,
    ...overrides,
  };
}

function makeUserRepo(user: any) {
  return {
    findOneBy: jest.fn().mockResolvedValue(user),
    update: jest.fn().mockResolvedValue(undefined),
  };
}

function makeService(userRepo: any): TelegramVerificationService {
  const configService = {
    getOrThrow: jest.fn().mockReturnValue(PHONE_HASH_SECRET),
  };
  return new TelegramVerificationService(
    userRepo as any,
    {} as any, // authMethodRepo
    {} as any, // betRepo
    {} as any, // transactionRepo
    {} as any, // paymentRepo
    configService as any,
    {} as any, // dkGateway
  );
}

// ─── verifyByAccountNumber ────────────────────────────────────────────────────

describe("TelegramVerificationService.verifyByAccountNumber", () => {
  it("sets dkLinkVerifiedAt and returns verified=true when account number matches", async () => {
    const user = makeUser({ dkAccountNumber: "ACC001234567" });
    const userRepo = makeUserRepo(user);
    const svc = makeService(userRepo);

    const result = await svc.verifyByAccountNumber("user-1", "ACC001234567", "99999");

    expect(result.verified).toBe(true);
    expect(userRepo.update).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ dkLinkVerifiedAt: expect.any(Date) }),
    );
  });

  it("trims whitespace and still matches", async () => {
    const user = makeUser({ dkAccountNumber: "ACC001234567" });
    const userRepo = makeUserRepo(user);
    const svc = makeService(userRepo);

    const result = await svc.verifyByAccountNumber("user-1", "  ACC001234567  ", "99999");
    expect(result.verified).toBe(true);
  });

  it("throws BadRequestException when account number does not match", async () => {
    const user = makeUser({ dkAccountNumber: "ACC001234567" });
    const userRepo = makeUserRepo(user);
    const svc = makeService(userRepo);

    await expect(
      svc.verifyByAccountNumber("user-1", "WRONGNUMBER", "99999"),
    ).rejects.toThrow(BadRequestException);
    expect(userRepo.update).not.toHaveBeenCalled();
  });

  it("throws BadRequestException when user has no dkAccountNumber linked", async () => {
    const user = makeUser({ dkAccountNumber: null });
    const userRepo = makeUserRepo(user);
    const svc = makeService(userRepo);

    await expect(
      svc.verifyByAccountNumber("user-1", "ACC001234567", "99999"),
    ).rejects.toThrow(BadRequestException);
  });

  it("throws BadRequestException when user not found", async () => {
    const userRepo = makeUserRepo(null);
    const svc = makeService(userRepo);

    await expect(
      svc.verifyByAccountNumber("user-1", "ACC001234567", "99999"),
    ).rejects.toThrow(BadRequestException);
  });

  it("binds telegramChatId when setting dkLinkVerifiedAt", async () => {
    const user = makeUser({ dkAccountNumber: "ACC001234567", telegramChatId: null });
    const userRepo = makeUserRepo(user);
    const svc = makeService(userRepo);

    await svc.verifyByAccountNumber("user-1", "ACC001234567", "99999");

    expect(userRepo.update).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ telegramChatId: "99999" }),
    );
  });
});

// ─── verifyPaymentIdentity ────────────────────────────────────────────────────

describe("TelegramVerificationService.verifyPaymentIdentity", () => {
  it("passes for phone-match path (telegramPhoneHash === dkPhoneHash)", async () => {
    const hash = hashPhone("+97517123456");
    const user = makeUser({
      telegramChatId: "99999",
      telegramPhoneHash: hash,
      dkPhoneHash: hash,
      dkLinkVerifiedAt: null,
    });
    const userRepo = makeUserRepo(user);
    const svc = makeService(userRepo);

    await expect(svc.verifyPaymentIdentity("user-1")).resolves.toBeDefined();
  });

  it("passes for account-number path (dkLinkVerifiedAt set, phone mismatch)", async () => {
    const user = makeUser({
      telegramChatId: "99999",
      telegramPhoneHash: hashPhone("+1234567890"), // foreign number
      dkPhoneHash: hashPhone("+97517123456"),       // bhutan number
      dkLinkVerifiedAt: new Date(),
    });
    const userRepo = makeUserRepo(user);
    const svc = makeService(userRepo);

    await expect(svc.verifyPaymentIdentity("user-1")).resolves.toBeDefined();
  });

  it("throws when neither path is complete (no phone match, no dkLinkVerifiedAt)", async () => {
    const user = makeUser({
      telegramChatId: "99999",
      telegramPhoneHash: hashPhone("+1234567890"),
      dkPhoneHash: hashPhone("+97517123456"),
      dkLinkVerifiedAt: null,
    });
    const userRepo = makeUserRepo(user);
    const svc = makeService(userRepo);

    await expect(svc.verifyPaymentIdentity("user-1")).rejects.toThrow(UnauthorizedException);
  });

  it("throws when telegramChatId is missing even if phone hashes match", async () => {
    const hash = hashPhone("+97517123456");
    const user = makeUser({
      telegramChatId: null,
      telegramPhoneHash: hash,
      dkPhoneHash: hash,
      dkLinkVerifiedAt: null,
    });
    const userRepo = makeUserRepo(user);
    const svc = makeService(userRepo);

    await expect(svc.verifyPaymentIdentity("user-1")).rejects.toThrow(UnauthorizedException);
  });

  it("throws when telegramChatId is missing even if dkLinkVerifiedAt is set", async () => {
    const user = makeUser({
      telegramChatId: null,
      dkLinkVerifiedAt: new Date(),
    });
    const userRepo = makeUserRepo(user);
    const svc = makeService(userRepo);

    await expect(svc.verifyPaymentIdentity("user-1")).rejects.toThrow(UnauthorizedException);
  });

  it("throws on chat_id mismatch", async () => {
    const hash = hashPhone("+97517123456");
    const user = makeUser({
      telegramChatId: "99999",
      telegramPhoneHash: hash,
      dkPhoneHash: hash,
    });
    const userRepo = makeUserRepo(user);
    const svc = makeService(userRepo);

    await expect(
      svc.verifyPaymentIdentity("user-1", "DIFFERENT_CHAT_ID"),
    ).rejects.toThrow(UnauthorizedException);
  });
});

// ─── isPhoneVerified ──────────────────────────────────────────────────────────

describe("TelegramVerificationService.isPhoneVerified", () => {
  it("returns true for phone-match path", async () => {
    const hash = hashPhone("+97517123456");
    const user = makeUser({
      telegramChatId: "99999",
      telegramPhoneHash: hash,
      dkPhoneHash: hash,
      dkLinkVerifiedAt: null,
    });
    const svc = makeService(makeUserRepo(user));
    expect(await svc.isPhoneVerified("user-1")).toBe(true);
  });

  it("returns true for account-number path", async () => {
    const user = makeUser({
      telegramChatId: "99999",
      telegramPhoneHash: hashPhone("+1234567890"),
      dkPhoneHash: hashPhone("+97517123456"),
      dkLinkVerifiedAt: new Date(),
    });
    const svc = makeService(makeUserRepo(user));
    expect(await svc.isPhoneVerified("user-1")).toBe(true);
  });

  it("returns false when neither path is complete", async () => {
    const user = makeUser({
      telegramChatId: "99999",
      telegramPhoneHash: hashPhone("+1234567890"),
      dkPhoneHash: hashPhone("+97517123456"),
      dkLinkVerifiedAt: null,
    });
    const svc = makeService(makeUserRepo(user));
    expect(await svc.isPhoneVerified("user-1")).toBe(false);
  });

  it("returns false when telegramChatId is missing", async () => {
    const hash = hashPhone("+97517123456");
    const user = makeUser({
      telegramChatId: null,
      telegramPhoneHash: hash,
      dkPhoneHash: hash,
      dkLinkVerifiedAt: new Date(),
    });
    const svc = makeService(makeUserRepo(user));
    expect(await svc.isPhoneVerified("user-1")).toBe(false);
  });
});
