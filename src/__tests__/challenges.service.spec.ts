import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ChallengesService } from "../challenges/challenges.service";
import {
  Challenge,
  ChallengeStatus,
  CardType,
} from "../entities/challenge.entity";
import { PositionStatus } from "../entities/position.entity";
import { MarketStatus } from "../entities/market.entity";

// ── Factories ────────────────────────────────────────────────────────────────

const MARKET_CLOSES_AT = new Date(Date.now() + 6 * 60 * 60 * 1000); // 6h from now

function makeMarket(overrides: any = {}) {
  return {
    id: "market-1",
    title: "Will it rain?",
    status: MarketStatus.OPEN,
    closesAt: MARKET_CLOSES_AT,
    ...overrides,
  };
}

function makePosition(overrides: any = {}) {
  return {
    id: "pos-1",
    userId: "user-1",
    marketId: "market-1",
    status: PositionStatus.PENDING,
    ...overrides,
  };
}

function makeChallenge(overrides: any = {}): Challenge {
  return {
    id: "challenge-1",
    creatorId: "user-1",
    marketId: "market-1",
    outcomeId: "outcome-1",
    status: ChallengeStatus.OPEN,
    participantCount: 0,
    wagerAmount: 0,
    joinerId: null,
    winnerId: null,
    settledAt: null,
    equippedCard: null,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    createdAt: new Date(),
    ...overrides,
  } as Challenge;
}

function makeUser(overrides: any = {}) {
  return {
    id: "user-1",
    cardInventory: { doubleDown: 0, shield: 0, ghost: 0 },
    ...overrides,
  };
}

// ── Mock repo/service builders ────────────────────────────────────────────────

function makeChallengeRepo(
  challenge: Challenge | null = makeChallenge(),
  winCount = 0,
) {
  return {
    findOne: jest.fn().mockResolvedValue(challenge),
    find: jest.fn().mockResolvedValue(challenge ? [challenge] : []),
    count: jest.fn().mockResolvedValue(winCount),
    create: jest.fn().mockImplementation((d: any) => ({ ...d })),
    save: jest.fn().mockImplementation((d: any) => Promise.resolve(d)),
    createQueryBuilder: jest.fn().mockReturnValue({
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(challenge ? [challenge] : []),
    }),
  };
}

function makeMarketRepo(market: any = makeMarket()) {
  return { findOne: jest.fn().mockResolvedValue(market) };
}

function makePositionRepo(position: any = makePosition(), totalCount = 10) {
  return {
    count: jest.fn().mockResolvedValue(totalCount),
    findOne: jest.fn().mockResolvedValue(position),
  };
}

/** DataSource mock — routes User vs Transaction repos by entity class name */
function makeDataSource(user: any = makeUser()) {
  const txRepo = {
    createQueryBuilder: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ balance: "1000" }),
    }),
    create: jest.fn().mockImplementation((d: any) => d),
    save: jest.fn().mockResolvedValue({}),
  };
  const userRepo = {
    findOne: jest.fn().mockResolvedValue(user),
    save: jest.fn().mockImplementation((d: any) => Promise.resolve(d)),
  };
  const getRepository = jest.fn().mockImplementation((entity: any) => {
    if (entity?.name === "User") return userRepo;
    return txRepo;
  });
  return { getRepository, txRepo, userRepo };
}

function makeService(
  overrides: {
    challengeRepo?: any;
    marketRepo?: any;
    positionRepo?: any;
    dataSource?: any;
  } = {},
) {
  const challengeRepo = overrides.challengeRepo ?? makeChallengeRepo();
  const marketRepo = overrides.marketRepo ?? makeMarketRepo();
  const positionRepo = overrides.positionRepo ?? makePositionRepo();
  const dataSource = overrides.dataSource ?? makeDataSource();

  const sseMock = { emit: jest.fn() } as any;
  const revenueDistMock = { recordDuelDistribution: jest.fn().mockResolvedValue(null) } as any;
  const service = new ChallengesService(
    challengeRepo as any,
    positionRepo as any,
    marketRepo as any,
    dataSource as any,
    sseMock,
    revenueDistMock,
  );

  return { service, challengeRepo, marketRepo, positionRepo, dataSource };
}

// ── Tests: create() ───────────────────────────────────────────────────────────

describe("ChallengesService.create()", () => {
  it("creates a challenge when all conditions are met", async () => {
    const challengeRepo = makeChallengeRepo();
    // duplicate check returns null (no existing challenge)
    challengeRepo.findOne.mockResolvedValueOnce(null);
    challengeRepo.save.mockImplementation((d: any) => Promise.resolve(d));

    const { service } = makeService({ challengeRepo });
    const result = await service.create("user-1", "market-1", "outcome-1");

    expect(challengeRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        creatorId: "user-1",
        marketId: "market-1",
        outcomeId: "outcome-1",
        status: ChallengeStatus.OPEN,
        participantCount: 0,
      }),
    );
    expect(challengeRepo.save).toHaveBeenCalled();
    expect(result.creatorId).toBe("user-1");
  });

  it("throws BadRequestException when user has fewer than 5 predictions", async () => {
    const { service } = makeService({
      positionRepo: makePositionRepo(makePosition(), 3),
    });
    await expect(
      service.create("user-1", "market-1", "outcome-1"),
    ).rejects.toThrow(BadRequestException);
  });

  it("allows creation when user has exactly 5 predictions (boundary)", async () => {
    const challengeRepo = makeChallengeRepo();
    challengeRepo.findOne.mockResolvedValueOnce(null);
    challengeRepo.save.mockImplementation((d: any) => Promise.resolve(d));

    const { service } = makeService({
      challengeRepo,
      positionRepo: makePositionRepo(makePosition(), 5),
    });
    await expect(
      service.create("user-1", "market-1", "outcome-1"),
    ).resolves.toBeDefined();
  });

  it("throws NotFoundException when market not found", async () => {
    const { service } = makeService({ marketRepo: makeMarketRepo(null) });
    await expect(
      service.create("user-1", "market-1", "outcome-1"),
    ).rejects.toThrow(NotFoundException);
  });

  it("throws BadRequestException when market is closed", async () => {
    const { service } = makeService({
      marketRepo: makeMarketRepo(makeMarket({ status: MarketStatus.CLOSED })),
    });
    await expect(
      service.create("user-1", "market-1", "outcome-1"),
    ).rejects.toThrow(BadRequestException);
  });

  it("throws BadRequestException when user has no active position on market", async () => {
    const { service } = makeService({
      positionRepo: makePositionRepo(null),
    });
    await expect(
      service.create("user-1", "market-1", "outcome-1"),
    ).rejects.toThrow(BadRequestException);
  });

  it("throws BadRequestException when duplicate open challenge exists", async () => {
    const challengeRepo = makeChallengeRepo();
    // duplicate check finds an existing challenge
    challengeRepo.findOne.mockResolvedValue(makeChallenge());

    const { service } = makeService({ challengeRepo });
    await expect(
      service.create("user-1", "market-1", "outcome-1"),
    ).rejects.toThrow(BadRequestException);
  });

  it("sets expiresAt to market closesAt", async () => {
    const challengeRepo = makeChallengeRepo();
    challengeRepo.findOne.mockResolvedValueOnce(null);
    challengeRepo.save.mockImplementation((d: any) => Promise.resolve(d));

    const { service } = makeService({
      challengeRepo,
      positionRepo: makePositionRepo(makePosition(), 10),
    });
    const result = await service.create("user-1", "market-1", "outcome-1");

    expect(result.expiresAt.getTime()).toBe(MARKET_CLOSES_AT.getTime());
  });

  it("deducts wager from creator balance when wagerAmount > 0", async () => {
    const challengeRepo = makeChallengeRepo();
    challengeRepo.findOne.mockResolvedValueOnce(null);
    challengeRepo.save.mockImplementation((d: any) => Promise.resolve(d));

    const dataSource = makeDataSource();
    const { service } = makeService({ challengeRepo, dataSource });
    await service.create("user-1", "market-1", "outcome-1", 50);

    // getRepository(Transaction).save should have been called for the debit
    expect(dataSource.getRepository().save).toHaveBeenCalled();
  });
});

// ── Tests: join() ─────────────────────────────────────────────────────────────

describe("ChallengesService.join()", () => {
  it("increments participantCount and transitions OPEN → ACTIVE", async () => {
    const challenge = makeChallenge({
      status: ChallengeStatus.OPEN,
      participantCount: 0,
    });
    const challengeRepo = makeChallengeRepo(challenge);
    challengeRepo.save.mockImplementation((d: any) => Promise.resolve(d));

    const { service } = makeService({ challengeRepo });
    const result = await service.join("challenge-1", "user-2");

    expect(result.participantCount).toBe(1);
    expect(result.status).toBe(ChallengeStatus.ACTIVE);
    expect(result.joinerId).toBe("user-2");
  });

  it("throws BadRequestException when challenge is already ACTIVE (not open)", async () => {
    const challenge = makeChallenge({
      status: ChallengeStatus.ACTIVE,
      participantCount: 1,
    });
    const { service } = makeService({
      challengeRepo: makeChallengeRepo(challenge),
    });
    await expect(service.join("challenge-1", "user-3")).rejects.toThrow(
      BadRequestException,
    );
  });

  it("throws NotFoundException when challenge not found", async () => {
    const { service } = makeService({ challengeRepo: makeChallengeRepo(null) });
    await expect(service.join("challenge-1", "user-2")).rejects.toThrow(
      NotFoundException,
    );
  });

  it("throws BadRequestException when challenge is EXPIRED", async () => {
    const challenge = makeChallenge({ status: ChallengeStatus.EXPIRED });
    const { service } = makeService({
      challengeRepo: makeChallengeRepo(challenge),
    });
    await expect(service.join("challenge-1", "user-2")).rejects.toThrow(
      BadRequestException,
    );
  });

  it("throws BadRequestException when challenge expiresAt is in the past", async () => {
    const challenge = makeChallenge({
      status: ChallengeStatus.OPEN,
      expiresAt: new Date(Date.now() - 1000),
    });
    const { service } = makeService({
      challengeRepo: makeChallengeRepo(challenge),
    });
    await expect(service.join("challenge-1", "user-2")).rejects.toThrow(
      BadRequestException,
    );
  });

  it("throws BadRequestException when creator tries to join their own challenge", async () => {
    const challenge = makeChallenge({ creatorId: "user-1" });
    const { service } = makeService({
      challengeRepo: makeChallengeRepo(challenge),
    });
    await expect(service.join("challenge-1", "user-1")).rejects.toThrow(
      BadRequestException,
    );
  });
});

// ── Tests: findForUser() ──────────────────────────────────────────────────────

describe("ChallengesService.findForUser()", () => {
  it("returns active challenges for a user", async () => {
    const challenge = makeChallenge();
    const challengeRepo = makeChallengeRepo(challenge);

    const { service } = makeService({ challengeRepo });
    const results = await service.findForUser("user-1");

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("challenge-1");
  });

  it("returns empty array when no challenges exist", async () => {
    const challengeRepo = makeChallengeRepo(null);
    challengeRepo.createQueryBuilder().getMany.mockResolvedValue([]);

    const { service } = makeService({ challengeRepo });
    const results = await service.findForUser("user-1");

    expect(results).toHaveLength(0);
  });
});

// ── Tests: expireStale() ──────────────────────────────────────────────────────

describe("ChallengesService.expireStale()", () => {
  it("expires stale open challenges and returns count", async () => {
    const stale = [
      makeChallenge({ id: "c1", expiresAt: new Date(Date.now() - 1000) }),
      makeChallenge({ id: "c2", expiresAt: new Date(Date.now() - 2000) }),
    ];
    const challengeRepo = makeChallengeRepo();
    challengeRepo.find.mockResolvedValue(stale);
    challengeRepo.save.mockImplementation((d: any) => Promise.resolve(d));

    const { service } = makeService({ challengeRepo });
    const count = await service.expireStale();

    expect(count).toBe(2);
    expect(challengeRepo.save).toHaveBeenCalledTimes(2);
  });

  it("returns 0 when no stale challenges exist", async () => {
    // All challenges have future expiresAt — none should be expired
    const fresh = [
      makeChallenge({ id: "c1", expiresAt: new Date(Date.now() + 9999999) }),
    ];
    const challengeRepo = makeChallengeRepo();
    challengeRepo.find.mockResolvedValue(fresh);

    const { service } = makeService({ challengeRepo });
    const count = await service.expireStale();

    expect(count).toBe(0);
    expect(challengeRepo.save).not.toHaveBeenCalled();
  });

  it("refunds creator wager when challenge expires with wager > 0", async () => {
    const stale = makeChallenge({
      expiresAt: new Date(Date.now() - 1000),
      wagerAmount: 50,
    });
    const challengeRepo = makeChallengeRepo();
    challengeRepo.find.mockResolvedValue([stale]);
    challengeRepo.save.mockImplementation((d: any) => Promise.resolve(d));

    const dataSource = makeDataSource();
    const { service } = makeService({ challengeRepo, dataSource });
    await service.expireStale();

    // credit() was called → txRepo.save was called
    expect(dataSource.txRepo.save).toHaveBeenCalled();
  });
});

// ── Tests: Power Cards ────────────────────────────────────────────────────────

describe("ChallengesService — Power Cards", () => {
  // ── getCardInventory ──────────────────────────────────────────────────────

  it("getCardInventory returns user's card inventory", async () => {
    const inv = { doubleDown: 2, shield: 1, ghost: 0 };
    const dataSource = makeDataSource(makeUser({ cardInventory: inv }));
    const { service } = makeService({ dataSource });

    const result = await service.getCardInventory("user-1");
    expect(result).toEqual(inv);
  });

  it("getCardInventory returns zeros when cardInventory is null", async () => {
    const dataSource = makeDataSource(makeUser({ cardInventory: null }));
    const { service } = makeService({ dataSource });

    const result = await service.getCardInventory("user-1");
    expect(result).toEqual({ doubleDown: 0, shield: 0, ghost: 0 });
  });

  it("getCardInventory throws NotFoundException when user not found", async () => {
    const dataSource = makeDataSource(null);
    // userRepo.findOne returns null
    dataSource.userRepo.findOne.mockResolvedValue(null);
    const { service } = makeService({ dataSource });

    await expect(service.getCardInventory("ghost-user")).rejects.toThrow(
      NotFoundException,
    );
  });

  // ── create with equippedCard ──────────────────────────────────────────────

  it("create with equippedCard consumes one card from inventory", async () => {
    const challengeRepo = makeChallengeRepo();
    challengeRepo.findOne.mockResolvedValueOnce(null); // no duplicate

    const user = makeUser({
      cardInventory: { doubleDown: 1, shield: 0, ghost: 0 },
    });
    const dataSource = makeDataSource(user);

    const { service } = makeService({ challengeRepo, dataSource });
    await service.create(
      "user-1",
      "market-1",
      "outcome-1",
      0,
      CardType.DOUBLE_DOWN,
    );

    // userRepo.save called with decremented count
    const savedUser = dataSource.userRepo.save.mock.calls[0][0];
    expect(savedUser.cardInventory.doubleDown).toBe(0);
  });

  it("does not consume card when wager debit fails (insufficient balance)", async () => {
    const challengeRepo = makeChallengeRepo();
    challengeRepo.findOne.mockResolvedValueOnce(null);

    const user = makeUser({
      cardInventory: { doubleDown: 1, shield: 0, ghost: 0 },
    });
    const dataSource = makeDataSource(user);
    // Simulate balance too low — getBalance returns 10, wager is 100
    dataSource.txRepo.createQueryBuilder().getRawOne.mockResolvedValue({ balance: "10" });

    const { service } = makeService({ challengeRepo, dataSource });
    await expect(
      service.create("user-1", "market-1", "outcome-1", 100, CardType.DOUBLE_DOWN),
    ).rejects.toThrow(BadRequestException);

    // userRepo.save should NOT have been called — card inventory untouched
    expect(dataSource.userRepo.save).not.toHaveBeenCalled();
  });

  it("create with equippedCard throws BadRequestException when inventory is 0", async () => {
    const challengeRepo = makeChallengeRepo();
    challengeRepo.findOne.mockResolvedValueOnce(null);

    const user = makeUser({
      cardInventory: { doubleDown: 0, shield: 0, ghost: 0 },
    });
    const dataSource = makeDataSource(user);

    const { service } = makeService({ challengeRepo, dataSource });
    await expect(
      service.create(
        "user-1",
        "market-1",
        "outcome-1",
        0,
        CardType.DOUBLE_DOWN,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("create sets equippedCard on the challenge", async () => {
    const challengeRepo = makeChallengeRepo();
    challengeRepo.findOne.mockResolvedValueOnce(null);

    const user = makeUser({
      cardInventory: { doubleDown: 0, shield: 1, ghost: 0 },
    });
    const dataSource = makeDataSource(user);

    const { service } = makeService({ challengeRepo, dataSource });
    await service.create("user-1", "market-1", "outcome-1", 0, CardType.SHIELD);

    const created = challengeRepo.create.mock.calls[0][0];
    expect(created.equippedCard).toBe(CardType.SHIELD);
  });

  // ── settleByMarket: Double Down fee waiver ────────────────────────────────

  it("settleByMarket with Double Down equipped pays out full 2× pot (no fee)", async () => {
    const challenge = makeChallenge({
      status: ChallengeStatus.ACTIVE,
      joinerId: "user-2",
      outcomeId: "outcome-1",
      wagerAmount: 100,
      equippedCard: CardType.DOUBLE_DOWN,
    });
    const challengeRepo = makeChallengeRepo(challenge);
    challengeRepo.find.mockResolvedValue([challenge]);
    // win count for awardMilestoneCards — return non-milestone value to skip award
    challengeRepo.count.mockResolvedValue(1);

    const dataSource = makeDataSource();
    const { service } = makeService({ challengeRepo, dataSource });
    await service.settleByMarket("market-1", "outcome-1"); // creator wins

    const creditCalls = dataSource.txRepo.save.mock.calls;
    // Find the payout transaction (amount > 0)
    const payout = creditCalls
      .map((c: any[]) => c[0])
      .find((tx: any) => tx.amount > 0);
    // Full pot = 100 * 2 = 200 — no fee
    expect(payout.amount).toBe(200);
  });

  it("settleByMarket without Double Down takes 10% platform fee", async () => {
    const challenge = makeChallenge({
      status: ChallengeStatus.ACTIVE,
      joinerId: "user-2",
      outcomeId: "outcome-1",
      wagerAmount: 100,
      equippedCard: null,
    });
    const challengeRepo = makeChallengeRepo(challenge);
    challengeRepo.find.mockResolvedValue([challenge]);
    challengeRepo.count.mockResolvedValue(1);

    const dataSource = makeDataSource();
    const { service } = makeService({ challengeRepo, dataSource });
    await service.settleByMarket("market-1", "outcome-1");

    const creditCalls = dataSource.txRepo.save.mock.calls;
    const payout = creditCalls
      .map((c: any[]) => c[0])
      .find((tx: any) => tx.amount > 0);
    // 200 * 0.9 = 180
    expect(payout.amount).toBe(180);
  });

  // ── awardMilestoneCards (via settleByMarket) ──────────────────────────────

  it("awards doubleDown card at 3rd win", async () => {
    const challenge = makeChallenge({
      status: ChallengeStatus.ACTIVE,
      joinerId: "user-2",
      outcomeId: "outcome-1",
      wagerAmount: 0,
    });
    const challengeRepo = makeChallengeRepo(challenge);
    challengeRepo.find.mockResolvedValue([challenge]);
    // count returns 3 → this is the 3rd win
    challengeRepo.count.mockResolvedValue(3);

    const user = makeUser({
      cardInventory: { doubleDown: 0, shield: 0, ghost: 0 },
    });
    const dataSource = makeDataSource(user);

    const { service } = makeService({ challengeRepo, dataSource });
    await service.settleByMarket("market-1", "outcome-1");

    const savedUser = dataSource.userRepo.save.mock.calls[0][0];
    expect(savedUser.cardInventory.doubleDown).toBe(1);
  });

  it("awards shield card at 7th win", async () => {
    const challenge = makeChallenge({
      status: ChallengeStatus.ACTIVE,
      joinerId: "user-2",
      outcomeId: "outcome-1",
      wagerAmount: 0,
    });
    const challengeRepo = makeChallengeRepo(challenge);
    challengeRepo.find.mockResolvedValue([challenge]);
    challengeRepo.count.mockResolvedValue(7);

    const user = makeUser({
      cardInventory: { doubleDown: 0, shield: 0, ghost: 0 },
    });
    const dataSource = makeDataSource(user);

    const { service } = makeService({ challengeRepo, dataSource });
    await service.settleByMarket("market-1", "outcome-1");

    const savedUser = dataSource.userRepo.save.mock.calls[0][0];
    expect(savedUser.cardInventory.shield).toBe(1);
  });

  it("awards ghost card at 15th win", async () => {
    const challenge = makeChallenge({
      status: ChallengeStatus.ACTIVE,
      joinerId: "user-2",
      outcomeId: "outcome-1",
      wagerAmount: 0,
    });
    const challengeRepo = makeChallengeRepo(challenge);
    challengeRepo.find.mockResolvedValue([challenge]);
    challengeRepo.count.mockResolvedValue(15);

    const user = makeUser({
      cardInventory: { doubleDown: 0, shield: 0, ghost: 0 },
    });
    const dataSource = makeDataSource(user);

    const { service } = makeService({ challengeRepo, dataSource });
    await service.settleByMarket("market-1", "outcome-1");

    const savedUser = dataSource.userRepo.save.mock.calls[0][0];
    expect(savedUser.cardInventory.ghost).toBe(1);
  });

  it("awards a random card every 10 wins after 15 (e.g. win #25)", async () => {
    const challenge = makeChallenge({
      status: ChallengeStatus.ACTIVE,
      joinerId: "user-2",
      outcomeId: "outcome-1",
      wagerAmount: 0,
    });
    const challengeRepo = makeChallengeRepo(challenge);
    challengeRepo.find.mockResolvedValue([challenge]);
    challengeRepo.count.mockResolvedValue(25);

    const user = makeUser({
      cardInventory: { doubleDown: 0, shield: 0, ghost: 0 },
    });
    const dataSource = makeDataSource(user);

    const { service } = makeService({ challengeRepo, dataSource });
    await service.settleByMarket("market-1", "outcome-1");

    const savedUser = dataSource.userRepo.save.mock.calls[0][0];
    const totalCards =
      savedUser.cardInventory.doubleDown +
      savedUser.cardInventory.shield +
      savedUser.cardInventory.ghost;
    expect(totalCards).toBe(1);
  });

  // ── hasShieldActive ───────────────────────────────────────────────────────

  it("hasShieldActive returns true when creator has ACTIVE Shield duel on market", async () => {
    const challenge = makeChallenge({
      status: ChallengeStatus.ACTIVE,
      equippedCard: CardType.SHIELD,
      creatorId: "user-1",
      marketId: "market-1",
    });
    const challengeRepo = makeChallengeRepo(challenge);
    challengeRepo.findOne.mockResolvedValue(challenge);

    const { service } = makeService({ challengeRepo });
    const result = await service.hasShieldActive("user-1", "market-1");
    expect(result).toBe(true);
  });

  it("hasShieldActive returns false when no matching Shield duel exists", async () => {
    const challengeRepo = makeChallengeRepo(null);
    challengeRepo.findOne.mockResolvedValue(null);

    const { service } = makeService({ challengeRepo });
    const result = await service.hasShieldActive("user-1", "market-1");
    expect(result).toBe(false);
  });

  it("does not award a card at non-milestone wins (e.g. win #5)", async () => {
    const challenge = makeChallenge({
      status: ChallengeStatus.ACTIVE,
      joinerId: "user-2",
      outcomeId: "outcome-1",
      wagerAmount: 0,
    });
    const challengeRepo = makeChallengeRepo(challenge);
    challengeRepo.find.mockResolvedValue([challenge]);
    challengeRepo.count.mockResolvedValue(5);

    const dataSource = makeDataSource();
    const { service } = makeService({ challengeRepo, dataSource });
    await service.settleByMarket("market-1", "outcome-1");

    expect(dataSource.userRepo.save).not.toHaveBeenCalled();
  });
});
