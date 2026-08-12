/**
 * Tests for StreakService — bet-streak tracking, day-7 boost, and bonus crediting.
 */
import { StreakService, STREAK_BONUS_DAY, STREAK_BONUS_MULT } from "../users/streak.service";
import { TransactionType } from "../entities/transaction.entity";

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayUtc() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function twoDaysAgoUtc() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 2);
  return d.toISOString().slice(0, 10);
}

function makeUserRepo(user: any = null) {
  return {
    findOne: jest.fn().mockResolvedValue(user),
    update: jest.fn().mockResolvedValue(undefined),
  };
}

function makeTransactionRepo() {
  const qb: any = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue({ balance: 500 }),
  };
  return { createQueryBuilder: jest.fn().mockReturnValue(qb) };
}

function makeDataSource(txResult?: any, userRepo?: any) {
  const txRepo = makeTransactionRepo();
  const em = {
    // updateStreak reads/writes User inside the transaction; route it to the
    // same userRepo the test set up so its findOne/update mocks are observed.
    getRepository: jest.fn().mockImplementation((entity: any) => {
      if (userRepo && entity && entity.name === "User") return userRepo;
      return txRepo;
    }),
    save: jest.fn().mockResolvedValue(txResult ?? {}),
    create: jest.fn().mockImplementation((_e: any, d: any) => d),
  };
  return {
    transaction: jest.fn().mockImplementation((cb: Function) => cb(em)),
    _em: em,
  };
}

function makeService(userRepo: any, txRepo?: any, dataSource?: any) {
  const sseMock = { emit: jest.fn() } as any;
  return new StreakService(
    userRepo,
    txRepo ?? makeTransactionRepo(),
    dataSource ?? makeDataSource(undefined, userRepo),
    sseMock,
  );
}

// ── updateStreak ──────────────────────────────────────────────────────────────

describe("StreakService.updateStreak", () => {
  it("returns streak=1 when user not found", async () => {
    const svc = makeService(makeUserRepo(null));
    const result = await svc.updateStreak("u1");
    expect(result).toEqual({ newStreak: 1, boostActive: false, dayInCycle: 1 });
  });

  it("sets streak=1 on first ever bet (no lastDate)", async () => {
    const user = { id: "u1", betStreakCount: 0, betStreakLastAt: null, streakBoostUsed: false };
    const userRepo = makeUserRepo(user);
    const svc = makeService(userRepo);

    const result = await svc.updateStreak("u1");

    expect(result.newStreak).toBe(1);
    expect(result.boostActive).toBe(false);
    expect(result.dayInCycle).toBe(1);
    expect(userRepo.update).toHaveBeenCalledWith("u1", expect.objectContaining({ betStreakCount: 1 }));
  });

  it("does not change streak when user already bet today", async () => {
    const user = { id: "u1", betStreakCount: 3, betStreakLastAt: todayUtc(), streakBoostUsed: false };
    const userRepo = makeUserRepo(user);
    const svc = makeService(userRepo);

    const result = await svc.updateStreak("u1");

    expect(result.newStreak).toBe(3);
    expect(userRepo.update).not.toHaveBeenCalled();
  });

  it("increments streak on consecutive day", async () => {
    const user = { id: "u1", betStreakCount: 4, betStreakLastAt: yesterdayUtc(), streakBoostUsed: false };
    const userRepo = makeUserRepo(user);
    const svc = makeService(userRepo);

    const result = await svc.updateStreak("u1");

    expect(result.newStreak).toBe(5);
    expect(result.dayInCycle).toBe(5);
    expect(result.boostActive).toBe(false);
    expect(userRepo.update).toHaveBeenCalledWith("u1", expect.objectContaining({ betStreakCount: 5 }));
  });

  it("resets streak to 1 when there is a gap (missed a day)", async () => {
    const user = { id: "u1", betStreakCount: 5, betStreakLastAt: twoDaysAgoUtc(), streakBoostUsed: false };
    const userRepo = makeUserRepo(user);
    const svc = makeService(userRepo);

    const result = await svc.updateStreak("u1");

    expect(result.newStreak).toBe(1);
    expect(result.dayInCycle).toBe(1);
    expect(result.boostActive).toBe(false);
  });

  it("activates boost on day 7 (first time) when consecutive and not already used", async () => {
    // betStreakCount = 6 → after increment = 7 → day 7 → boost fires
    const user = { id: "u1", betStreakCount: 6, betStreakLastAt: yesterdayUtc(), streakBoostUsed: false };
    const userRepo = makeUserRepo(user);
    const svc = makeService(userRepo);

    const result = await svc.updateStreak("u1");

    expect(result.newStreak).toBe(7);
    expect(result.dayInCycle).toBe(7);
    expect(result.boostActive).toBe(true);
    // streakBoostUsed should be set to true
    expect(userRepo.update).toHaveBeenCalledWith("u1", expect.objectContaining({ streakBoostUsed: true }));
  });

  it("does NOT activate boost on day 7 if boost already used", async () => {
    const user = { id: "u1", betStreakCount: 6, betStreakLastAt: yesterdayUtc(), streakBoostUsed: true };
    const userRepo = makeUserRepo(user);
    const svc = makeService(userRepo);

    const result = await svc.updateStreak("u1");

    expect(result.newStreak).toBe(7);
    expect(result.boostActive).toBe(false);
  });

  it("resets streakBoostUsed at start of new cycle (streak mod STREAK_BONUS_DAY === 1)", async () => {
    // After 7-day cycle, day 8 → newStreak=8, (8-1)%7=0 → dayInCycle=1, resets boost flag
    const user = { id: "u1", betStreakCount: 7, betStreakLastAt: yesterdayUtc(), streakBoostUsed: true };
    const userRepo = makeUserRepo(user);
    const svc = makeService(userRepo);

    const result = await svc.updateStreak("u1");

    expect(result.newStreak).toBe(8);
    expect(result.dayInCycle).toBe(1);
    expect(result.boostActive).toBe(false);
    expect(userRepo.update).toHaveBeenCalledWith("u1", expect.objectContaining({ streakBoostUsed: false }));
  });
});

// ── getStreakInfo ─────────────────────────────────────────────────────────────

describe("StreakService.getStreakInfo", () => {
  it("returns zero state when user not found", async () => {
    const svc = makeService(makeUserRepo(null));
    const result = await svc.getStreakInfo("u1");
    expect(result).toEqual({ betStreakCount: 0, dayInCycle: 0, nextBoostInDays: 7, boostReady: false });
  });

  it("returns correct dayInCycle and nextBoostInDays for streak of 3", async () => {
    const user = { betStreakCount: 3, betStreakLastAt: todayUtc(), streakBoostUsed: false };
    const svc = makeService(makeUserRepo(user));

    const result = await svc.getStreakInfo("u1");

    expect(result.betStreakCount).toBe(3);
    expect(result.dayInCycle).toBe(3);
    expect(result.nextBoostInDays).toBe(4); // 7 - 3
    expect(result.boostReady).toBe(false);
  });

  it("returns boostReady=true when on day 7, bet today, and boost not yet used", async () => {
    const user = { betStreakCount: 7, betStreakLastAt: todayUtc(), streakBoostUsed: false };
    const svc = makeService(makeUserRepo(user));

    const result = await svc.getStreakInfo("u1");

    expect(result.dayInCycle).toBe(7);
    expect(result.boostReady).toBe(true);
    expect(result.nextBoostInDays).toBe(0);
  });

  it("returns boostReady=false when on day 7 but boost already used", async () => {
    const user = { betStreakCount: 7, betStreakLastAt: todayUtc(), streakBoostUsed: true };
    const svc = makeService(makeUserRepo(user));

    const result = await svc.getStreakInfo("u1");

    expect(result.boostReady).toBe(false);
  });

  it("returns boostReady=false when on day 7 but not bet today", async () => {
    const user = { betStreakCount: 7, betStreakLastAt: yesterdayUtc(), streakBoostUsed: false };
    const svc = makeService(makeUserRepo(user));

    const result = await svc.getStreakInfo("u1");

    expect(result.boostReady).toBe(false);
  });

  it("still reports the streak when the last bet was yesterday (not yet missed)", async () => {
    const user = { betStreakCount: 4, betStreakLastAt: yesterdayUtc(), streakBoostUsed: false };
    const svc = makeService(makeUserRepo(user));

    const result = await svc.getStreakInfo("u1");

    expect(result.betStreakCount).toBe(4);
  });

  it("hides the streak (reports 0) once a full day is missed", async () => {
    // Stored count is stale — user hasn't bet since two days ago, so the streak
    // is broken even though betStreakCount hasn't been reset in the DB yet.
    const user = { betStreakCount: 5, betStreakLastAt: twoDaysAgoUtc(), streakBoostUsed: false };
    const svc = makeService(makeUserRepo(user));

    const result = await svc.getStreakInfo("u1");

    expect(result.betStreakCount).toBe(0);
    expect(result.dayInCycle).toBe(0);
    expect(result.boostReady).toBe(false);
  });
});

// ── creditStreakBonus ─────────────────────────────────────────────────────────

describe("StreakService.creditStreakBonus", () => {
  it("does nothing when bonusAmount is 0", async () => {
    const ds = makeDataSource();
    const svc = makeService(makeUserRepo(), makeTransactionRepo(), ds);

    await svc.creditStreakBonus("u1", "pos-1", 0);

    expect(ds.transaction).not.toHaveBeenCalled();
  });

  it("does nothing when bonusAmount is negative", async () => {
    const ds = makeDataSource();
    const svc = makeService(makeUserRepo(), makeTransactionRepo(), ds);

    await svc.creditStreakBonus("u1", "pos-1", -5);

    expect(ds.transaction).not.toHaveBeenCalled();
  });

  it("creates a POSITION_PAYOUT transaction with the correct bonus amount", async () => {
    const ds = makeDataSource();
    const em = ds._em;
    em.getRepository().createQueryBuilder().getRawOne.mockResolvedValue({ balance: 300 });

    const svc = makeService(makeUserRepo(), makeTransactionRepo(), ds);

    await svc.creditStreakBonus("u1", "pos-1", 60);

    expect(ds.transaction).toHaveBeenCalled();
    expect(em.save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: TransactionType.POSITION_PAYOUT,
        amount: 60,
        balanceBefore: 300,
        balanceAfter: 360,
        userId: "u1",
        positionId: "pos-1",
      }),
    );
  });

  it("calculates correct balanceAfter from current balance", async () => {
    const ds = makeDataSource();
    const em = ds._em;
    em.getRepository().createQueryBuilder().getRawOne.mockResolvedValue({ balance: 1000 });

    const svc = makeService(makeUserRepo(), makeTransactionRepo(), ds);

    await svc.creditStreakBonus("u1", "pos-2", 200);

    expect(em.save).toHaveBeenCalledWith(
      expect.objectContaining({
        balanceBefore: 1000,
        balanceAfter: 1200,
      }),
    );
  });
});
