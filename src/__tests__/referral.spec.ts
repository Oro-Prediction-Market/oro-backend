/**
 * Tests for referral bonus logic inside ParimutuelEngine.
 *
 * Covers:
 *  1. Bonus formula constants (math)
 *  2. creditReferralBonusIfEligible — the actual trigger:
 *     - credits referrer on referred user's first bet
 *     - idempotent: does not double-credit on second bet
 *     - skipped when user has no referrer
 *     - skipped when referralBonusTriggered is already true
 *     - correct amount for various bet sizes
 *  3. Referral code parsing in onboard.service (referredByUserId attribution)
 */
import { ParimutuelEngine } from "../markets/parimutuel.engine";
import { TransactionType } from "../entities/transaction.entity";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeDataSource({
  bettor,
  referrer,
  referrerBalance = 500,
  updateAffected = 1,
}: {
  bettor?: any;
  referrer?: any;
  referrerBalance?: number;
  updateAffected?: number;
} = {}) {
  const qb: any = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue({ balance: referrerBalance }),
  };

  const txRepo = {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    save: jest.fn().mockResolvedValue({}),
    create: jest.fn().mockImplementation((_e: any, d: any) => d ?? _e),
    findOne: jest.fn().mockResolvedValue(null),
    count: jest.fn().mockResolvedValue(0),
  };

  const userRepo = {
    findOne: jest.fn()
      .mockResolvedValueOnce(bettor ?? null)
      .mockResolvedValueOnce(referrer ?? null),
    update: jest.fn().mockResolvedValue({ affected: updateAffected }),
  };

  const em = {
    getRepository: jest.fn().mockImplementation((entity: any) => {
      // Distinguish by entity name duck-typing
      return entity?.name === "Transaction" || entity === txRepo
        ? txRepo
        : userRepo;
    }),
    save: jest.fn().mockResolvedValue({}),
    create: jest.fn().mockImplementation((_e: any, d: any) => d ?? _e),
  };

  const ds = {
    getRepository: jest.fn().mockImplementation(() => userRepo),
    transaction: jest.fn().mockImplementation((cb: Function) => cb(em)),
    _txRepo: txRepo,
    _userRepo: userRepo,
    _em: em,
  };

  return ds;
}

/** Build a minimal ParimutuelEngine with only dataSource wired (enough for referral tests). */
function makeEngine(ds: any): ParimutuelEngine {
  const noop = {} as any;
  const redis = { del: jest.fn().mockResolvedValue(undefined) } as any;
  const sse = { emit: jest.fn() } as any;
  const engine = new ParimutuelEngine(
    noop,  // marketRepo
    noop,  // outcomeRepo
    noop,  // betRepo
    noop,  // paymentRepo
    noop,  // transactionRepo
    noop,  // settlementRepo
    noop,  // disputeRepo
    ds,    // dataSource
    noop,  // lmsrService
    redis, // redis
    noop,  // reputationService
    noop,  // telegramSimple
    noop,  // dkGateway
    noop,  // configService
    noop,  // streakService
    noop,  // challengesService
    noop,  // marketsGateway
    sse,   // sse
    noop,  // revenueDistributionService
    ({ create: async () => {} }) as any, // userNotifications
    ({ addBulk: async () => [] }) as any, // notificationQueue
  );
  return engine;
}

// Expose the private method for direct testing
function callCreditReferral(
  engine: ParimutuelEngine,
  bettorUserId: string,
  betAmount: number,
): Promise<void> {
  return (engine as any).creditReferralBonusIfEligible(bettorUserId, betAmount, 8);
}

// ── 1. Formula constants ───────────────────────────────────────────────────────

describe("ParimutuelEngine referral bonus constants", () => {
  it("flat bonus is Nu 25", () => {
    expect(ParimutuelEngine.REFERRAL_FLAT_BONUS).toBe(25);
  });

  it("bet pct is 5%", () => {
    expect(ParimutuelEngine.REFERRAL_BET_PCT).toBeCloseTo(0.05);
  });

  it("cap is Nu 75", () => {
    expect(ParimutuelEngine.REFERRAL_CAP).toBe(75);
  });

  it("small bet Nu 20: flat(25) + 5%(20)=1 → 26", () => {
    const pct = Math.round(20 * ParimutuelEngine.REFERRAL_BET_PCT * 100) / 100;
    const bonus = Math.min(ParimutuelEngine.REFERRAL_FLAT_BONUS + pct, ParimutuelEngine.REFERRAL_CAP);
    expect(bonus).toBe(26);
  });

  it("medium bet Nu 100: flat(25) + 5%(100)=5 → 30", () => {
    const pct = Math.round(100 * ParimutuelEngine.REFERRAL_BET_PCT * 100) / 100;
    const bonus = Math.min(ParimutuelEngine.REFERRAL_FLAT_BONUS + pct, ParimutuelEngine.REFERRAL_CAP);
    expect(bonus).toBe(30);
  });

  it("large bet Nu 500: flat(25) + 5%(500)=25 → 50", () => {
    const pct = Math.round(500 * ParimutuelEngine.REFERRAL_BET_PCT * 100) / 100;
    const bonus = Math.min(ParimutuelEngine.REFERRAL_FLAT_BONUS + pct, ParimutuelEngine.REFERRAL_CAP);
    expect(bonus).toBe(50);
  });

  it("very large bet Nu 1000: flat(25) + 5%(1000)=50 → 75 (capped)", () => {
    const pct = Math.round(1000 * ParimutuelEngine.REFERRAL_BET_PCT * 100) / 100;
    const bonus = Math.min(ParimutuelEngine.REFERRAL_FLAT_BONUS + pct, ParimutuelEngine.REFERRAL_CAP);
    expect(bonus).toBe(75);
  });

  it("huge bet Nu 5000: still capped at 75", () => {
    const pct = Math.round(5000 * ParimutuelEngine.REFERRAL_BET_PCT * 100) / 100;
    const bonus = Math.min(ParimutuelEngine.REFERRAL_FLAT_BONUS + pct, ParimutuelEngine.REFERRAL_CAP);
    expect(bonus).toBe(75);
  });
});

// ── 2. creditReferralBonusIfEligible trigger ──────────────────────────────────

describe("creditReferralBonusIfEligible", () => {
  it("credits referrer on referred user's first bet (Nu 100 bet → Nu 30 bonus)", async () => {
    const bettor = {
      id: "bettor-1",
      referredByUserId: "referrer-1",
      referralBonusTriggered: false,
    };
    const referrer = { id: "referrer-1" };

    const ds = makeDataSource({ bettor, referrer, referrerBalance: 500 });
    const engine = makeEngine(ds);

    await callCreditReferral(engine, "bettor-1", 100);

    // Transaction should have been committed inside dataSource.transaction
    expect(ds.transaction).toHaveBeenCalledTimes(1);

    // txRepo.save is called with txRepo.create({...}) result — check that
    const savedTx = ds._txRepo.save.mock.calls[0]?.[0];
    expect(savedTx).toMatchObject({
      type: TransactionType.REFERRAL_BONUS,
      amount: 30,         // Nu 25 + 5% of 100 = 30
      userId: "referrer-1",
      isBonus: false,     // referral bonus IS withdrawable
    });
  });

  it("marks referralBonusTriggered=true on the bettor", async () => {
    const bettor = {
      id: "bettor-1",
      referredByUserId: "referrer-1",
      referralBonusTriggered: false,
    };
    const referrer = { id: "referrer-1" };

    const ds = makeDataSource({ bettor, referrer });
    const engine = makeEngine(ds);

    await callCreditReferral(engine, "bettor-1", 100);

    // The conditional update that sets referralBonusTriggered=true
    const updateCall = ds._userRepo.update.mock.calls[0];
    expect(updateCall[0]).toMatchObject({ id: "bettor-1", referralBonusTriggered: false });
    expect(updateCall[1]).toMatchObject({ referralBonusTriggered: true });
  });

  it("does nothing when bettor has no referrer", async () => {
    const bettor = {
      id: "bettor-2",
      referredByUserId: null,
      referralBonusTriggered: false,
    };

    const ds = makeDataSource({ bettor });
    const engine = makeEngine(ds);

    await callCreditReferral(engine, "bettor-2", 200);

    expect(ds.transaction).not.toHaveBeenCalled();
  });

  it("does nothing when referralBonusTriggered is already true (idempotency)", async () => {
    const bettor = {
      id: "bettor-3",
      referredByUserId: "referrer-1",
      referralBonusTriggered: true, // already fired
    };

    const ds = makeDataSource({ bettor });
    const engine = makeEngine(ds);

    await callCreditReferral(engine, "bettor-3", 200);

    expect(ds.transaction).not.toHaveBeenCalled();
  });

  it("does nothing when the referrer user no longer exists in DB", async () => {
    const bettor = {
      id: "bettor-4",
      referredByUserId: "ghost-referrer",
      referralBonusTriggered: false,
    };

    const ds = makeDataSource({ bettor, referrer: null });
    const engine = makeEngine(ds);

    await callCreditReferral(engine, "bettor-4", 200);

    expect(ds.transaction).not.toHaveBeenCalled();
  });

  it("does not double-credit when atomic update sees affected=0 (concurrent race)", async () => {
    const bettor = {
      id: "bettor-5",
      referredByUserId: "referrer-1",
      referralBonusTriggered: false,
    };
    const referrer = { id: "referrer-1" };

    // Simulate a second concurrent call winning the DB update first
    const ds = makeDataSource({ bettor, referrer, updateAffected: 0 });
    const engine = makeEngine(ds);

    await callCreditReferral(engine, "bettor-5", 100);

    // Transaction was entered but save should NOT have been called
    expect(ds.transaction).toHaveBeenCalledTimes(1);
    expect(ds._em.save).not.toHaveBeenCalled();
  });

  it("caps bonus at Nu 75 for large bets", async () => {
    const bettor = {
      id: "bettor-6",
      referredByUserId: "referrer-1",
      referralBonusTriggered: false,
    };
    const referrer = { id: "referrer-1" };

    const ds = makeDataSource({ bettor, referrer, referrerBalance: 1000 });
    const engine = makeEngine(ds);

    await callCreditReferral(engine, "bettor-6", 5000); // 25 + 250 → capped at 75

    const savedTx = ds._txRepo.save.mock.calls[0]?.[0];
    expect(savedTx.amount).toBe(75);
  });

  it("balanceAfter = referrer balance before + bonus", async () => {
    const bettor = {
      id: "bettor-7",
      referredByUserId: "referrer-1",
      referralBonusTriggered: false,
    };
    const referrer = { id: "referrer-1" };

    const ds = makeDataSource({ bettor, referrer, referrerBalance: 200 });
    const engine = makeEngine(ds);

    await callCreditReferral(engine, "bettor-7", 100); // bonus = 30

    const savedTx = ds._txRepo.save.mock.calls[0]?.[0];
    expect(savedTx.balanceBefore).toBe(200);
    expect(savedTx.balanceAfter).toBe(230);
  });
});

// ── 3. Referral code parsing ───────────────────────────────────────────────────

describe("referral code parsing", () => {
  const REFERRER_TELEGRAM_ID = "987654321";

  function parseReferralCode(referralCode: string, actorTelegramId: string): string | null {
    // Mirrors the logic in both auth.service.ts and onboard.service.ts
    const raw = referralCode.startsWith("ref_")
      ? referralCode.slice(4)
      : referralCode;
    const refTelegramId = raw.split("_m_")[0];
    if (!refTelegramId || refTelegramId === actorTelegramId) return null;
    return refTelegramId;
  }

  it("parses ref_<telegramId> link format", () => {
    const code = `ref_${REFERRER_TELEGRAM_ID}`;
    expect(parseReferralCode(code, "111")).toBe(REFERRER_TELEGRAM_ID);
  });

  it("parses bare telegramId without ref_ prefix", () => {
    expect(parseReferralCode(REFERRER_TELEGRAM_ID, "111")).toBe(REFERRER_TELEGRAM_ID);
  });

  it("parses ref_<id>_m_<marketId> market-referral link format", () => {
    const code = `ref_${REFERRER_TELEGRAM_ID}_m_some-market-uuid`;
    expect(parseReferralCode(code, "111")).toBe(REFERRER_TELEGRAM_ID);
  });

  it("returns null when referrer telegramId equals actor (self-referral)", () => {
    const code = `ref_${REFERRER_TELEGRAM_ID}`;
    expect(parseReferralCode(code, REFERRER_TELEGRAM_ID)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseReferralCode("", "111")).toBeNull();
  });
});
