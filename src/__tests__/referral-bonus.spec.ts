/**
 * Integration test for the referral bonus credit flow.
 *
 * Verifies: when a referred user places their FIRST bet, the referrer receives
 * a REFERRAL_BONUS transaction of (Nu 25 flat + 5% of bet, capped at Nu 75),
 * and the referred user's `referralBonusTriggered` flag is set to true so the
 * bonus never fires twice.
 */

import { ParimutuelEngine } from "../markets/parimutuel.engine";
import { TransactionType } from "../entities/transaction.entity";

// ─── Shared test constants ────────────────────────────────────────────────────
const REFERRER_ID = "referrer-uuid-001";
const BETTOR_ID = "bettor-uuid-002";

// ─── DataSource mock factory ──────────────────────────────────────────────────

function makeDs(opts: {
  bettorReferredBy: string | null;
  bonusAlreadyTriggered: boolean;
  referrerBalance: number;
  /** Simulate the race being lost: DB update returns affected=0 even though the
   *  outer pre-transaction read saw referralBonusTriggered=false. */
  simulateRaceLost?: boolean;
}) {
  const savedTx: any[] = [];
  const updatedUsers: Record<string, any> = {};

  const txRepo = {
    createQueryBuilder: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ balance: opts.referrerBalance }),
    }),
    create: jest.fn((data: any) => data),
    save: jest.fn(async (data: any) => {
      savedTx.push(data);
      return data;
    }),
  };

  const userRepo = {
    findOne: jest.fn(({ where }: any) => {
      if (where.id === BETTOR_ID) {
        return Promise.resolve({
          id: BETTOR_ID,
          referredByUserId: opts.bettorReferredBy,
          referralBonusTriggered: opts.bonusAlreadyTriggered,
        });
      }
      if (where.id === REFERRER_ID) {
        return Promise.resolve({ id: REFERRER_ID });
      }
      return Promise.resolve(null);
    }),
    // Engine now passes an object WHERE clause: { id, referralBonusTriggered: false }
    // We extract the userId from it and return a proper UpdateResult shape.
    update: jest.fn(async (whereOrId: any, patch: any) => {
      const userId =
        typeof whereOrId === "string" ? whereOrId : whereOrId.id;
      const affected = opts.simulateRaceLost ? 0 : 1;
      if (affected) updatedUsers[userId] = patch;
      return { affected };
    }),
  };

  // em.getRepository: call 1 → txRepo, call 2 → userRepo (mirrors engine code)
  let emCallCount = 0;
  const emMock = {
    getRepository: jest.fn(() => {
      emCallCount++;
      return emCallCount === 1 ? txRepo : (userRepo as any);
    }),
  };

  const ds = {
    getRepository: jest.fn(() => userRepo as any),
    transaction: jest.fn(async (cb: (em: any) => Promise<void>) => cb(emMock)),
    query: jest.fn(),
  };

  return { ds, savedTx, updatedUsers, txRepo, userRepo };
}

function makeEngine(ds: any) {
  const redis = { del: jest.fn(), get: jest.fn(), set: jest.fn() };
  const logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn() };
  const sse = { emit: jest.fn() };

  const engine = new ParimutuelEngine(
    null as any, // marketRepo
    null as any, // outcomeRepo
    null as any, // betRepo
    null as any, // paymentRepo
    null as any, // transactionRepo
    null as any, // settlementRepo
    null as any, // disputeRepo
    ds as any,   // dataSource ← 8th param
    null as any, // lmsrService
    null as any, // redis (overridden below)
    null as any, // reputationService
    null as any, // telegramSimple
    null as any, // dkGateway
    { get: jest.fn() } as any, // configService
    null as any, // streakService
    null as any, // challengesService
    null as any, // marketsGateway
    null as any, // sse (overridden below)
    null as any, // revenueDistributionService
    ({ addBulk: async () => [] }) as any, // notificationQueue
  );

  // Inject mocked redis, logger, and sse
  (engine as any).redis = redis;
  (engine as any).logger = logger;
  (engine as any).sse = sse;

  return { engine, redis, logger, sse };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("creditReferralBonusIfEligible", () => {
  it("credits the referrer on the referred user's first bet (Nu 100 → bonus Nu 30)", async () => {
    const { ds, savedTx, updatedUsers } = makeDs({
      bettorReferredBy: REFERRER_ID,
      bonusAlreadyTriggered: false,
      referrerBalance: 500,
    });
    const { engine } = makeEngine(ds);

    await (engine as any).creditReferralBonusIfEligible(BETTOR_ID, 100, 5);

    // Exactly one REFERRAL_BONUS transaction saved
    expect(savedTx).toHaveLength(1);
    expect(savedTx[0].type).toBe(TransactionType.REFERRAL_BONUS);

    // Nu 25 flat + 5% of 100 = Nu 5 → total Nu 30
    expect(savedTx[0].amount).toBe(30);
    expect(savedTx[0].userId).toBe(REFERRER_ID);
    expect(savedTx[0].balanceBefore).toBe(500);
    expect(savedTx[0].balanceAfter).toBe(530);

    // Referred user flagged so the bonus never fires again
    expect(updatedUsers[BETTOR_ID]).toEqual({ referralBonusTriggered: true });
  });

  it("caps bonus at Nu 75 for a large first bet (Nu 1500)", async () => {
    const { ds, savedTx } = makeDs({
      bettorReferredBy: REFERRER_ID,
      bonusAlreadyTriggered: false,
      referrerBalance: 0,
    });
    const { engine } = makeEngine(ds);

    await (engine as any).creditReferralBonusIfEligible(BETTOR_ID, 1500, 5);

    // Nu 25 flat + 5% of 1500 = Nu 75 + Nu 25 = Nu 100 → capped at Nu 75
    expect(savedTx[0].amount).toBe(75);
  });

  it("does NOT fire if bettor has no referrer (organic signup)", async () => {
    const { ds, savedTx } = makeDs({
      bettorReferredBy: null,
      bonusAlreadyTriggered: false,
      referrerBalance: 0,
    });
    const { engine } = makeEngine(ds);

    await (engine as any).creditReferralBonusIfEligible(BETTOR_ID, 100, 5);

    expect(savedTx).toHaveLength(0);
  });

  it("does NOT fire if referralBonusTriggered is already true (second bet)", async () => {
    const { ds, savedTx } = makeDs({
      bettorReferredBy: REFERRER_ID,
      bonusAlreadyTriggered: true,
      referrerBalance: 0,
    });
    const { engine } = makeEngine(ds);

    await (engine as any).creditReferralBonusIfEligible(BETTOR_ID, 200, 5);

    expect(savedTx).toHaveLength(0);
  });

  it("invalidates the referrer's balance cache after crediting", async () => {
    const { ds } = makeDs({
      bettorReferredBy: REFERRER_ID,
      bonusAlreadyTriggered: false,
      referrerBalance: 100,
    });
    const { engine, redis } = makeEngine(ds);

    await (engine as any).creditReferralBonusIfEligible(BETTOR_ID, 100, 5);

    expect(redis.del).toHaveBeenCalledWith(
      `oro:cache:balance:${REFERRER_ID}`,
    );
  });

  it("small bet (Nu 20): Nu 25 + Nu 1 = Nu 26", async () => {
    const { ds, savedTx } = makeDs({
      bettorReferredBy: REFERRER_ID,
      bonusAlreadyTriggered: false,
      referrerBalance: 0,
    });
    const { engine } = makeEngine(ds);

    await (engine as any).creditReferralBonusIfEligible(BETTOR_ID, 20, 5);

    expect(savedTx[0].amount).toBe(26);
  });

  it("race condition — concurrent second call loses DB race and does NOT double-credit", async () => {
    // Simulates two bets landing simultaneously: both pass the outer
    // referralBonusTriggered=false check, but only the first DB update succeeds.
    // The second sees affected=0 and must abort without saving any transaction.
    const { ds, savedTx } = makeDs({
      bettorReferredBy: REFERRER_ID,
      bonusAlreadyTriggered: false,
      referrerBalance: 500,
      simulateRaceLost: true,
    });
    const { engine } = makeEngine(ds);

    await (engine as any).creditReferralBonusIfEligible(BETTOR_ID, 100, 5);

    expect(savedTx).toHaveLength(0);
  });
});
