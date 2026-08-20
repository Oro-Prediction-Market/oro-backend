import { BankLinkService } from "../payment/bank-link.service";

// SEC-PAY-001 regression suite.
//
// Bank linking is the only place where CID ownership is proven: DK Bank tells us
// which phone is registered to the CID, and we send an OTP there. Our KYC
// position with GMC rests on that OTP actually happening, so these tests exist
// to make sure no caller-controlled input can ever short-circuit it again.

const CID = "11000000001";
const OTHER_CID = "11000000002";

function makeAccount(overrides: any = {}) {
  return {
    id: "lba-1",
    userId: "user-1",
    cid: CID,
    accountNumber: "ACC001",
    accountName: "Test User",
    bankPhone: "17123456",
    isVerified: false,
    isDefault: false,
    verifiedAt: null,
    linkAttempts: 0,
    ...overrides,
  };
}

function makeHarness(opts: { existingAccount?: any; cidConflict?: any } = {}) {
  const saved: any[] = [];

  const lbaRepo: any = {
    findOne: jest.fn(async ({ where }: any) => {
      // The CID-conflict probe asks for { cid, isVerified: true }
      if (where?.isVerified === true && where?.cid) {
        return opts.cidConflict ?? null;
      }
      return opts.existingAccount ?? null;
    }),
    create: jest.fn((data: any) => makeAccount(data)),
    save: jest.fn(async (a: any) => {
      saved.push({ ...a });
      return a;
    }),
    createQueryBuilder: jest.fn(() => {
      const qb: any = {
        update: () => qb,
        set: () => qb,
        where: () => qb,
        execute: jest.fn(async () => undefined),
      };
      return qb;
    }),
  };

  const userRepo: any = {
    update: jest.fn(async () => undefined),
    findOne: jest.fn(async () => ({ telegramId: "99999", firstName: "Test" })),
  };

  const dkGateway: any = {
    lookupAccountByCID: jest.fn(async () => ({
      accountNumber: "ACC001",
      accountName: "Test User",
      phoneNumber: "17123456",
    })),
  };

  const redisStore = new Map<string, any>();
  const redis: any = {
    setJsonEx: jest.fn(async (k: string, _ttl: number, v: any) => {
      redisStore.set(k, v);
    }),
    getJson: jest.fn(async (k: string) => redisStore.get(k) ?? null),
    del: jest.fn(async (k: string) => {
      redisStore.delete(k);
    }),
  };

  const smsService: any = { sendOtp: jest.fn(async () => true) };
  const telegramSimple: any = { sendMessage: jest.fn(async () => undefined) };

  const service = new BankLinkService(
    lbaRepo,
    userRepo,
    dkGateway,
    redis,
    smsService,
    telegramSimple,
    // The service gained a seventh dependency and this call was never
    // updated. It compiled nowhere: `npm run build` exits 2, so the Docker
    // image could not be built at all.
    { requestVerification: jest.fn() } as any,
  );

  return {
    service,
    lbaRepo,
    userRepo,
    dkGateway,
    redis,
    redisStore,
    smsService,
    telegramSimple,
    saved,
  };
}

describe("BankLinkService — OTP cannot be bypassed (SEC-PAY-001)", () => {
  it("always requires OTP and sends it to the DK-registered phone", async () => {
    const h = makeHarness();

    const result = await h.service.linkBankAccount("user-1", CID);

    expect(result.requiresOtp).toBe(true);
    expect(h.smsService.sendOtp).toHaveBeenCalledTimes(1);
    expect(h.redis.setJsonEx).toHaveBeenCalledWith(
      "bank_link_otp:user-1",
      expect.any(Number),
      expect.objectContaining({ otp: expect.any(String) }),
    );
  });

  it("ignores a legacy skipOtp argument from a stale caller", async () => {
    const h = makeHarness();

    // Simulates an old client / old call site still passing the removed flag.
    const result = await (h.service.linkBankAccount as any)(
      "user-1",
      CID,
      undefined,
      true,
    );

    expect(result.requiresOtp).toBe(true);
    expect(h.smsService.sendOtp).toHaveBeenCalledTimes(1);
    // Nothing was marked verified.
    expect(h.saved.every((a) => a.isVerified === false)).toBe(true);
    expect(h.saved.every((a) => a.verifiedAt == null)).toBe(true);
  });

  it("leaves the account unverified until the OTP is answered", async () => {
    const h = makeHarness();

    await h.service.linkBankAccount("user-1", CID);

    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].isVerified).toBe(false);
    expect(h.saved[0].isDefault).toBe(false);
  });

  it("does not stamp dkCid / dkAccountNumber on the user before verification", async () => {
    const h = makeHarness();

    await h.service.linkBankAccount("user-1", CID);

    // user.dkCid is read as proof of identity by the payment, reputation and AML
    // paths — it must not be written from an unproven link attempt.
    const dkWrites = h.userRepo.update.mock.calls.filter(
      (c: any[]) =>
        c[1] &&
        ("dkCid" in c[1] || "dkAccountNumber" in c[1] || "dkCid" in c[1]),
    );
    expect(dkWrites).toHaveLength(0);
  });

  it("rejects a CID already verified by another user", async () => {
    const h = makeHarness({
      cidConflict: { id: "lba-9", userId: "someone-else" },
    });

    await expect(h.service.linkBankAccount("user-1", CID)).rejects.toThrow(
      /already linked to another account/i,
    );
    expect(h.smsService.sendOtp).not.toHaveBeenCalled();
  });

  it("drops verification when re-linking an already-verified account", async () => {
    const existing = makeAccount({ isVerified: true, verifiedAt: new Date() });
    const h = makeHarness({ existingAccount: existing });

    await h.service.linkBankAccount("user-1", CID);

    expect(h.saved[0].isVerified).toBe(false);
    expect(h.saved[0].verifiedAt).toBeNull();
  });
});

describe("BankLinkService.verifyBankLink", () => {
  async function linkedHarness() {
    const h = makeHarness({ existingAccount: makeAccount() });
    await h.service.linkBankAccount("user-1", CID);
    const session = h.redisStore.get("bank_link_otp:user-1");
    return { h, otp: session.otp as string };
  }

  it("verifies the account and syncs DK fields on a correct OTP", async () => {
    const { h, otp } = await linkedHarness();

    const account = await h.service.verifyBankLink("user-1", otp);

    expect(account.isVerified).toBe(true);
    expect(account.verifiedAt).toBeInstanceOf(Date);
    expect(h.userRepo.update).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        dkCid: CID,
        dkAccountNumber: "ACC001",
        dkLinkVerifiedAt: expect.any(Date),
      }),
    );
  });

  it("rejects a wrong OTP without verifying", async () => {
    const { h, otp } = await linkedHarness();
    const wrong = otp === "000000" ? "111111" : "000000";

    await expect(h.service.verifyBankLink("user-1", wrong)).rejects.toThrow(
      /Invalid code/i,
    );
    expect(
      h.userRepo.update.mock.calls.some((c: any[]) => c[1]?.dkLinkVerifiedAt),
    ).toBe(false);
  });

  it("locks out after the attempt limit", async () => {
    const { h, otp } = await linkedHarness();
    const wrong = otp === "000000" ? "111111" : "000000";

    await expect(h.service.verifyBankLink("user-1", wrong)).rejects.toThrow(
      /Invalid code/i,
    );
    await expect(h.service.verifyBankLink("user-1", wrong)).rejects.toThrow(
      /Invalid code/i,
    );
    await expect(h.service.verifyBankLink("user-1", wrong)).rejects.toThrow(
      /Too many incorrect attempts/i,
    );

    // Session is destroyed — the correct OTP no longer works either.
    await expect(h.service.verifyBankLink("user-1", otp)).rejects.toThrow(
      /expired or not found/i,
    );
  });

  it("rejects when no OTP session exists", async () => {
    const h = makeHarness();

    await expect(h.service.verifyBankLink("user-1", "123456")).rejects.toThrow(
      /expired or not found/i,
    );
  });

  it("requires a matching phone when one is supplied by onboarding", async () => {
    const h = makeHarness();

    await expect(
      h.service.linkBankAccount("user-1", OTHER_CID, "+97577999999"),
    ).rejects.toThrow(/Phone number mismatch/i);
    expect(h.smsService.sendOtp).not.toHaveBeenCalled();
  });
});
