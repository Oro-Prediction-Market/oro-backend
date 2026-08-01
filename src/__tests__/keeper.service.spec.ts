/**
 * Tests for KeeperService — market auto-open, auto-close, auto-settle,
 * outcome resolution, log management, and admin controls.
 */
import { KeeperService } from "../markets/keeper.service";
import { MarketStatus } from "../entities/market.entity";

// ── Helpers ───────────────────────────────────────────────────────────────────

function pastDate() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - 5);
  return d.toISOString();
}

function futureDate() {
  const d = new Date();
  d.setHours(d.getHours() + 2);
  return d.toISOString();
}

function makeMarket(overrides: any = {}) {
  return {
    id: "market-1",
    title: "Will X happen?",
    status: MarketStatus.OPEN,
    opensAt: null,
    closesAt: null,
    disputeDeadlineAt: null,
    proposedOutcomeId: null,
    externalMatchId: null,
    externalMarketType: null,
    outcomes: [],
    ...overrides,
  };
}

function makeMarketsService() {
  return {
    transition: jest.fn().mockResolvedValue(undefined),
    resolve: jest.fn().mockResolvedValue(undefined),
    proposeResolution: jest.fn().mockResolvedValue(undefined),
  };
}

function makeTelegram() {
  return {
    sendMessage: jest.fn().mockResolvedValue(undefined),
    sendMessageWithButtons: jest.fn().mockResolvedValue(undefined),
    registerProposeKey: jest.fn().mockResolvedValue(42),
    resolveProposeKey: jest.fn().mockResolvedValue({ marketId: "m1", outcomeId: "o1" }),
  };
}

function makeConfig(values: Record<string, string> = {}) {
  return {
    get: jest.fn().mockImplementation((key: string) => values[key] ?? undefined),
  };
}

function makeMarketRepo(markets: any[] = []) {
  return {
    find: jest.fn().mockResolvedValue(markets),
    createQueryBuilder: jest.fn().mockReturnValue({
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    }),
  };
}

function makeService(overrides: {
  marketsService?: any;
  telegram?: any;
  config?: any;
  redis?: any;
  marketRepo?: any;
  disputeRepo?: any;
  epl?: any;
  ucl?: any;
} = {}) {
  const marketsService = overrides.marketsService ?? makeMarketsService();
  const telegram = overrides.telegram ?? makeTelegram();
  const config = overrides.config ?? makeConfig();
  const redis =
    overrides.redis ?? {
      // acquireLock returns a token so withClusterLock runs the cron body in tests
      acquireLock: jest.fn().mockResolvedValue("test-lock-token"),
      releaseLock: jest.fn().mockResolvedValue(undefined),
    };
  const marketRepo = overrides.marketRepo ?? makeMarketRepo();
  // Dispute repo — defaults to zero objections so auto-settle proceeds unless a
  // test overrides count to simulate a disputed market.
  const disputeRepo =
    overrides.disputeRepo ?? { count: jest.fn().mockResolvedValue(0) };
  const epl =
    overrides.epl ?? {
      getSeasonInfo: jest
        .fn()
        .mockResolvedValue({ started: false, seasonStart: null, maxPlayed: 0 }),
      getStats: jest.fn().mockResolvedValue({
        goals: [],
        assists: [],
        yellow: [],
        red: [],
      }),
      getUpcomingFixtures: jest.fn().mockResolvedValue([]),
    };
  // UCL service mock — off-season/no fixtures by default so its crons are no-ops
  // in tests that don't exercise UCL.
  const ucl =
    overrides.ucl ?? {
      getSeasonInfo: jest
        .fn()
        .mockResolvedValue({ started: false, seasonStart: null, maxPlayed: 0 }),
      getStats: jest.fn().mockResolvedValue({
        goals: [],
        assists: [],
        yellow: [],
        red: [],
      }),
      getUpcomingFixtures: jest.fn().mockResolvedValue([]),
      getUpcomingKnockoutTies: jest.fn().mockResolvedValue([]),
      getBracket: jest.fn().mockResolvedValue({ hasData: false, decided: false, rounds: [] }),
    };

  const svc = new KeeperService(
    marketsService,
    telegram,
    config,
    redis as any,
    marketRepo as any,
    disputeRepo as any,
    epl as any,
    ucl as any,
  );
  return { svc, marketsService, telegram, config, redis, marketRepo, disputeRepo, epl, ucl };
}

// ── setActive / getStatus ─────────────────────────────────────────────────────

describe("KeeperService.setActive / getStatus", () => {
  it("starts active by default", () => {
    const { svc } = makeService();
    expect(svc.getStatus().isActive).toBe(true);
  });

  it("setActive(false) pauses the keeper", () => {
    const { svc } = makeService();
    svc.setActive(false);
    expect(svc.getStatus().isActive).toBe(false);
  });

  it("setActive(true) resumes the keeper", () => {
    const { svc } = makeService();
    svc.setActive(false);
    svc.setActive(true);
    expect(svc.getStatus().isActive).toBe(true);
  });

  it("getStatus includes logs from setActive calls", () => {
    const { svc } = makeService();
    svc.setActive(false);
    const status = svc.getStatus();
    expect(status.logs.some((l: any) => l.msg.includes("paused"))).toBe(true);
  });

  it("getStatus returns null for lastRunAt before any cron run", () => {
    const { svc } = makeService();
    expect(svc.getStatus().lastRunAt).toBeNull();
  });

  it("getStatus stats start at zero", () => {
    const { svc } = makeService();
    const { stats } = svc.getStatus();
    expect(stats.marketsClosedToday).toBe(0);
    expect(stats.disputeWindowsOpened).toBe(0);
    expect(stats.marketsAutoSettled).toBe(0);
  });
});

// ── triggerJob ────────────────────────────────────────────────────────────────

describe("KeeperService.triggerJob", () => {
  it("triggers expiry job", async () => {
    const marketRepo = makeMarketRepo([]);
    const { svc } = makeService({ marketRepo });

    await svc.triggerJob("expiry");

    expect(marketRepo.find).toHaveBeenCalled();
  });

  it("triggers dispute job", async () => {
    const marketRepo = makeMarketRepo([]);
    const { svc } = makeService({ marketRepo });

    await svc.triggerJob("dispute");

    expect(marketRepo.find).toHaveBeenCalled();
  });

  it("triggers liquidity job (no-op, just logs)", async () => {
    const { svc } = makeService();
    await expect(svc.triggerJob("liquidity")).resolves.not.toThrow();
    const logs = svc.getStatus().logs;
    expect(logs.some((l: any) => l.msg.includes("Liquidity Bot"))).toBe(true);
  });
});

// ── handleMarketExpirations ───────────────────────────────────────────────────

describe("KeeperService.handleMarketExpirations", () => {
  it("does nothing when keeper is paused", async () => {
    const marketsService = makeMarketsService();
    const marketRepo = makeMarketRepo([]);
    const { svc } = makeService({ marketsService, marketRepo });
    svc.setActive(false);

    await svc.handleMarketExpirations();

    expect(marketsService.transition).not.toHaveBeenCalled();
  });

  it("auto-opens UPCOMING market whose opensAt has passed", async () => {
    const upcomingMarket = makeMarket({
      id: "m1",
      title: "Test Market",
      status: MarketStatus.UPCOMING,
      opensAt: pastDate(),
    });
    const marketsService = makeMarketsService();
    const marketRepo = makeMarketRepo([upcomingMarket]);
    // Return upcoming for first find(), empty for second (no open markets)
    marketRepo.find
      .mockResolvedValueOnce([upcomingMarket]) // UPCOMING markets
      .mockResolvedValueOnce([]);               // OPEN markets
    const { svc } = makeService({ marketsService, marketRepo });

    await svc.handleMarketExpirations();

    expect(marketsService.transition).toHaveBeenCalledWith("m1", MarketStatus.OPEN);
  });

  it("does NOT open UPCOMING market without opensAt", async () => {
    const upcomingMarket = makeMarket({
      status: MarketStatus.UPCOMING,
      opensAt: null, // no date set
    });
    const marketsService = makeMarketsService();
    const marketRepo = makeMarketRepo([]);
    marketRepo.find
      .mockResolvedValueOnce([upcomingMarket])
      .mockResolvedValueOnce([]);
    const { svc } = makeService({ marketsService, marketRepo });

    await svc.handleMarketExpirations();

    expect(marketsService.transition).not.toHaveBeenCalled();
  });

  it("does NOT open UPCOMING market whose opensAt is in the future", async () => {
    const upcomingMarket = makeMarket({
      status: MarketStatus.UPCOMING,
      opensAt: futureDate(),
    });
    const marketsService = makeMarketsService();
    const marketRepo = makeMarketRepo([]);
    marketRepo.find
      .mockResolvedValueOnce([upcomingMarket])
      .mockResolvedValueOnce([]);
    const { svc } = makeService({ marketsService, marketRepo });

    await svc.handleMarketExpirations();

    expect(marketsService.transition).not.toHaveBeenCalled();
  });

  it("auto-closes OPEN market whose closesAt has passed", async () => {
    const openMarket = makeMarket({
      id: "m2",
      title: "Expired Market",
      status: MarketStatus.OPEN,
      closesAt: pastDate(),
      outcomes: [{ id: "o1", label: "Yes" }],
    });
    const marketsService = makeMarketsService();
    const marketRepo = makeMarketRepo([]);
    marketRepo.find
      .mockResolvedValueOnce([])         // UPCOMING
      .mockResolvedValueOnce([openMarket]); // OPEN
    const config = makeConfig({ ADMIN_TELEGRAM_ID: "12345" });
    const telegram = makeTelegram();
    const { svc } = makeService({ marketsService, marketRepo, config, telegram });

    await svc.handleMarketExpirations();

    expect(marketsService.transition).toHaveBeenCalledWith("m2", MarketStatus.CLOSED);
  });

  it("does NOT close OPEN market without closesAt", async () => {
    const openMarket = makeMarket({
      status: MarketStatus.OPEN,
      closesAt: null,
      outcomes: [],
    });
    const marketsService = makeMarketsService();
    const marketRepo = makeMarketRepo([]);
    marketRepo.find
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([openMarket]);
    const { svc } = makeService({ marketsService, marketRepo });

    await svc.handleMarketExpirations();

    expect(marketsService.transition).not.toHaveBeenCalled();
  });

  it("does NOT close a market that was just opened in the same tick", async () => {
    const market = makeMarket({
      id: "m3",
      title: "Same-tick Market",
      status: MarketStatus.UPCOMING,
      opensAt: pastDate(),
      closesAt: pastDate(), // closesAt also in the past
      outcomes: [],
    });
    const marketsService = makeMarketsService();
    const marketRepo = makeMarketRepo([]);
    // First find() returns the upcoming market, second returns an OPEN version
    marketRepo.find
      .mockResolvedValueOnce([market])
      .mockResolvedValueOnce([{ ...market, status: MarketStatus.OPEN }]);
    // transition returns without error — market is now "open"
    marketsService.transition.mockResolvedValue(undefined);
    const { svc } = makeService({ marketsService, marketRepo });

    await svc.handleMarketExpirations();

    // transition called once (to OPEN), NOT a second time (to CLOSED)
    expect(marketsService.transition).toHaveBeenCalledTimes(1);
    expect(marketsService.transition).toHaveBeenCalledWith("m3", MarketStatus.OPEN);
  });

  it("logs error and continues when market open fails", async () => {
    const market = makeMarket({
      status: MarketStatus.UPCOMING,
      opensAt: pastDate(),
    });
    const marketsService = makeMarketsService();
    marketsService.transition.mockRejectedValue(new Error("DB error"));
    const marketRepo = makeMarketRepo([]);
    marketRepo.find
      .mockResolvedValueOnce([market])
      .mockResolvedValueOnce([]);
    const { svc } = makeService({ marketsService, marketRepo });

    await expect(svc.handleMarketExpirations()).resolves.not.toThrow();
    const logs = svc.getStatus().logs;
    expect(logs.some((l: any) => l.type === "error")).toBe(true);
  });

  it("increments marketsClosedToday counter when market is closed", async () => {
    const openMarket = makeMarket({
      closesAt: pastDate(),
      outcomes: [{ id: "o1", label: "Yes" }],
    });
    const marketRepo = makeMarketRepo([]);
    marketRepo.find
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([openMarket]);
    const config = makeConfig({ ADMIN_TELEGRAM_ID: "123" });
    const { svc } = makeService({ marketRepo, config });

    await svc.handleMarketExpirations();

    expect(svc.getStatus().stats.marketsClosedToday).toBe(1);
  });
});

// ── handleDisputeWindowExpiry ─────────────────────────────────────────────────

describe("KeeperService.handleDisputeWindowExpiry", () => {
  it("does nothing when keeper is paused", async () => {
    const marketsService = makeMarketsService();
    const marketRepo = makeMarketRepo([]);
    const { svc } = makeService({ marketsService, marketRepo });
    svc.setActive(false);

    await svc.handleDisputeWindowExpiry();

    expect(marketsService.resolve).not.toHaveBeenCalled();
  });

  it("auto-settles RESOLVING market whose dispute window has expired", async () => {
    const market = makeMarket({
      id: "m4",
      title: "Resolving Market",
      status: MarketStatus.RESOLVING,
      disputeDeadlineAt: pastDate(),
      proposedOutcomeId: "o1",
      outcomes: [{ id: "o1", label: "Yes" }],
    });
    const marketsService = makeMarketsService();
    const marketRepo = makeMarketRepo([market]);
    const config = makeConfig({ ADMIN_TELEGRAM_ID: "123" });
    const { svc } = makeService({ marketsService, marketRepo, config });

    await svc.handleDisputeWindowExpiry();

    expect(marketsService.resolve).toHaveBeenCalledWith("m4", "o1");
    expect(svc.getStatus().stats.marketsAutoSettled).toBe(1);
  });

  it("does NOT auto-settle a market with objections — leaves it for admin review", async () => {
    // Window expired, proposal set — but a bettor has objected. The keeper must
    // NOT uphold the proposal / forfeit the bond; it leaves the market RESOLVING.
    const market = makeMarket({
      id: "m5",
      title: "Disputed Market",
      status: MarketStatus.RESOLVING,
      disputeDeadlineAt: pastDate(),
      proposedOutcomeId: "o1",
      outcomes: [{ id: "o1", label: "Yes" }],
    });
    const marketsService = makeMarketsService();
    const marketRepo = makeMarketRepo([market]);
    const disputeRepo = { count: jest.fn().mockResolvedValue(1) }; // 1 objection
    const { svc } = makeService({ marketsService, marketRepo, disputeRepo });

    await svc.handleDisputeWindowExpiry();

    expect(disputeRepo.count).toHaveBeenCalledWith({
      where: { marketId: "m5" },
    });
    expect(marketsService.resolve).not.toHaveBeenCalled();
    expect(svc.getStatus().stats.marketsAutoSettled).toBe(0);
  });

  it("skips RESOLVING market whose dispute window is still open", async () => {
    const market = makeMarket({
      status: MarketStatus.RESOLVING,
      disputeDeadlineAt: futureDate(),
      proposedOutcomeId: "o1",
      outcomes: [],
    });
    const marketsService = makeMarketsService();
    const marketRepo = makeMarketRepo([market]);
    const { svc } = makeService({ marketsService, marketRepo });

    await svc.handleDisputeWindowExpiry();

    expect(marketsService.resolve).not.toHaveBeenCalled();
  });

  it("skips RESOLVING market without proposedOutcomeId", async () => {
    const market = makeMarket({
      status: MarketStatus.RESOLVING,
      disputeDeadlineAt: pastDate(),
      proposedOutcomeId: null,
      outcomes: [],
    });
    const marketsService = makeMarketsService();
    const marketRepo = makeMarketRepo([market]);
    const { svc } = makeService({ marketsService, marketRepo });

    await svc.handleDisputeWindowExpiry();

    expect(marketsService.resolve).not.toHaveBeenCalled();
  });

  it("skips RESOLVING market without disputeDeadlineAt", async () => {
    const market = makeMarket({
      status: MarketStatus.RESOLVING,
      disputeDeadlineAt: null,
      proposedOutcomeId: "o1",
      outcomes: [],
    });
    const marketsService = makeMarketsService();
    const marketRepo = makeMarketRepo([market]);
    const { svc } = makeService({ marketsService, marketRepo });

    await svc.handleDisputeWindowExpiry();

    expect(marketsService.resolve).not.toHaveBeenCalled();
  });

  it("logs error and continues when resolve throws", async () => {
    const market = makeMarket({
      status: MarketStatus.RESOLVING,
      disputeDeadlineAt: pastDate(),
      proposedOutcomeId: "o1",
      outcomes: [{ id: "o1", label: "Yes" }],
    });
    const marketsService = makeMarketsService();
    marketsService.resolve.mockRejectedValue(new Error("Settlement failed"));
    const marketRepo = makeMarketRepo([market]);
    const { svc } = makeService({ marketsService, marketRepo });

    await expect(svc.handleDisputeWindowExpiry()).resolves.not.toThrow();
    const logs = svc.getStatus().logs;
    expect(logs.some((l: any) => l.type === "error")).toBe(true);
  });
});

// ── resetDailyCounters ────────────────────────────────────────────────────────

describe("KeeperService.resetDailyCounters", () => {
  it("resets all daily counters to zero", async () => {
    const market = makeMarket({
      closesAt: pastDate(),
      outcomes: [{ id: "o1", label: "Yes" }],
    });
    const marketRepo = makeMarketRepo([]);
    marketRepo.find
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([market]);
    const config = makeConfig({ ADMIN_TELEGRAM_ID: "123" });
    const { svc } = makeService({ marketRepo, config });

    // Increment counter
    await svc.handleMarketExpirations();
    expect(svc.getStatus().stats.marketsClosedToday).toBe(1);

    // Reset
    svc.resetDailyCounters();
    expect(svc.getStatus().stats.marketsClosedToday).toBe(0);
    expect(svc.getStatus().stats.marketsAutoSettled).toBe(0);
    expect(svc.getStatus().stats.disputeWindowsOpened).toBe(0);
  });
});

// ── log buffer ────────────────────────────────────────────────────────────────

describe("KeeperService log buffer", () => {
  it("getStatus logs are returned in reverse chronological order (newest first)", async () => {
    const { svc } = makeService();
    svc.setActive(false);
    svc.setActive(true);

    const logs = svc.getStatus().logs;
    // Most recent log should be first
    expect(logs[0].id).toBeGreaterThan(logs[1].id);
  });

  it("returns at most 100 logs from getStatus", async () => {
    const { svc } = makeService();
    // Trigger many logs by toggling active 60 times
    for (let i = 0; i < 60; i++) {
      svc.setActive(i % 2 === 0);
    }
    const logs = svc.getStatus().logs;
    expect(logs.length).toBeLessThanOrEqual(100);
  });
});

// ── resolveProposeKey ─────────────────────────────────────────────────────────

describe("KeeperService.resolveProposeKey", () => {
  it("delegates to telegram.resolveProposeKey", async () => {
    const telegram = makeTelegram();
    telegram.resolveProposeKey.mockResolvedValue({ marketId: "m1", outcomeId: "o2" });
    const { svc } = makeService({ telegram });

    const result = await svc.resolveProposeKey(42);

    expect(telegram.resolveProposeKey).toHaveBeenCalledWith(42);
    expect(result).toEqual({ marketId: "m1", outcomeId: "o2" });
  });
});

// ── resolveOutcome (via handleAutoProposal) ───────────────────────────────────

describe("KeeperService resolveOutcome logic", () => {
  beforeEach(() => {
    // Mock global fetch for football API calls
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("skips auto-proposal when no FOOTBALL_DATA_API_KEY configured", async () => {
    const config = makeConfig({}); // no FOOTBALL_DATA_API_KEY
    const { svc } = makeService({ config });

    await svc.handleAutoProposal();

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("skips auto-proposal when no closed fixture-linked markets exist", async () => {
    const config = makeConfig({ FOOTBALL_DATA_API_KEY: "test-key" });
    const marketRepo = makeMarketRepo([]);
    marketRepo.createQueryBuilder.mockReturnValue({
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    });
    const { svc } = makeService({ config, marketRepo });

    await svc.handleAutoProposal();

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("proposes home team win for match-winner market when home wins", async () => {
    const config = makeConfig({ FOOTBALL_DATA_API_KEY: "key", ADMIN_TELEGRAM_ID: "123" });
    const outcomes = [
      { id: "o-home", label: "Manchester City" },
      { id: "o-draw", label: "Draw" },
      { id: "o-away", label: "Arsenal" },
    ];
    const market = makeMarket({
      id: "m5",
      status: MarketStatus.CLOSED,
      externalMatchId: 999,
      externalMarketType: "match-winner",
      proposedOutcomeId: null,
      outcomes,
    });
    const marketRepo = makeMarketRepo([]);
    marketRepo.createQueryBuilder.mockReturnValue({
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([market]),
    });

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "FINISHED",
        score: { fullTime: { home: 3, away: 1 } },
        homeTeam: { name: "Manchester City" },
        awayTeam: { name: "Arsenal" },
      }),
    });

    const marketsService = makeMarketsService();
    const telegram = makeTelegram();
    const { svc } = makeService({ config, marketRepo, marketsService, telegram });

    await svc.handleAutoProposal();

    expect(marketsService.proposeResolution).toHaveBeenCalledWith("m5", "o-home");
  });

  it("proposes Draw for match-winner market when scores are equal", async () => {
    const config = makeConfig({ FOOTBALL_DATA_API_KEY: "key", ADMIN_TELEGRAM_ID: "123" });
    const outcomes = [
      { id: "o-home", label: "TeamA" },
      { id: "o-draw", label: "Draw" },
      { id: "o-away", label: "TeamB" },
    ];
    const market = makeMarket({
      id: "m6",
      externalMatchId: 888,
      externalMarketType: "match-winner",
      proposedOutcomeId: null,
      outcomes,
    });
    const marketRepo = makeMarketRepo([]);
    marketRepo.createQueryBuilder.mockReturnValue({
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([market]),
    });

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "FINISHED",
        score: { fullTime: { home: 1, away: 1 } },
        homeTeam: { name: "TeamA" },
        awayTeam: { name: "TeamB" },
      }),
    });

    const marketsService = makeMarketsService();
    const { svc } = makeService({ config, marketRepo, marketsService });

    await svc.handleAutoProposal();

    expect(marketsService.proposeResolution).toHaveBeenCalledWith("m6", "o-draw");
  });

  it("proposes Over 2.5 for over-under market when total goals > 2.5", async () => {
    const config = makeConfig({ FOOTBALL_DATA_API_KEY: "key", ADMIN_TELEGRAM_ID: "123" });
    const outcomes = [
      { id: "o-over", label: "Over 2.5" },
      { id: "o-under", label: "Under 2.5" },
    ];
    const market = makeMarket({
      id: "m7",
      externalMatchId: 777,
      externalMarketType: "over-under",
      proposedOutcomeId: null,
      outcomes,
    });
    const marketRepo = makeMarketRepo([]);
    marketRepo.createQueryBuilder.mockReturnValue({
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([market]),
    });

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "FINISHED",
        score: { fullTime: { home: 2, away: 2 } }, // 4 total > 2.5
        homeTeam: { name: "A" },
        awayTeam: { name: "B" },
      }),
    });

    const marketsService = makeMarketsService();
    const { svc } = makeService({ config, marketRepo, marketsService });

    await svc.handleAutoProposal();

    expect(marketsService.proposeResolution).toHaveBeenCalledWith("m7", "o-over");
  });

  it("proposes Under 2.5 for over-under market when total goals <= 2.5", async () => {
    const config = makeConfig({ FOOTBALL_DATA_API_KEY: "key", ADMIN_TELEGRAM_ID: "123" });
    const outcomes = [
      { id: "o-over", label: "Over 2.5" },
      { id: "o-under", label: "Under 2.5" },
    ];
    const market = makeMarket({
      id: "m8",
      externalMatchId: 666,
      externalMarketType: "over-under",
      proposedOutcomeId: null,
      outcomes,
    });
    const marketRepo = makeMarketRepo([]);
    marketRepo.createQueryBuilder.mockReturnValue({
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([market]),
    });

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "FINISHED",
        score: { fullTime: { home: 1, away: 1 } }, // 2 total < 2.5
        homeTeam: { name: "A" },
        awayTeam: { name: "B" },
      }),
    });

    const marketsService = makeMarketsService();
    const { svc } = makeService({ config, marketRepo, marketsService });

    await svc.handleAutoProposal();

    expect(marketsService.proposeResolution).toHaveBeenCalledWith("m8", "o-under");
  });

  it("skips market when match is not finished yet", async () => {
    const config = makeConfig({ FOOTBALL_DATA_API_KEY: "key" });
    const market = makeMarket({
      externalMatchId: 555,
      externalMarketType: "match-winner",
      proposedOutcomeId: null,
      outcomes: [],
    });
    const marketRepo = makeMarketRepo([]);
    marketRepo.createQueryBuilder.mockReturnValue({
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([market]),
    });

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ status: "IN_PLAY", score: { fullTime: { home: 1, away: 0 } }, homeTeam: { name: "A" }, awayTeam: { name: "B" } }),
    });

    const marketsService = makeMarketsService();
    const { svc } = makeService({ config, marketRepo, marketsService });

    await svc.handleAutoProposal();

    expect(marketsService.proposeResolution).not.toHaveBeenCalled();
  });

  it("logs warning and continues when football API returns non-200", async () => {
    const config = makeConfig({ FOOTBALL_DATA_API_KEY: "key" });
    const market = makeMarket({
      externalMatchId: 444,
      externalMarketType: "match-winner",
      proposedOutcomeId: null,
      outcomes: [],
    });
    const marketRepo = makeMarketRepo([]);
    marketRepo.createQueryBuilder.mockReturnValue({
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([market]),
    });

    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 429 });

    const marketsService = makeMarketsService();
    const { svc } = makeService({ config, marketRepo, marketsService });

    await expect(svc.handleAutoProposal()).resolves.not.toThrow();
    expect(marketsService.proposeResolution).not.toHaveBeenCalled();
  });

  it("uses partial label matching for team names", async () => {
    const config = makeConfig({ FOOTBALL_DATA_API_KEY: "key", ADMIN_TELEGRAM_ID: "123" });
    const outcomes = [
      { id: "o-home", label: "Manchester" }, // prefix substring of "Manchester City"
      { id: "o-draw", label: "Draw" },
      { id: "o-away", label: "Arsenal" },
    ];
    const market = makeMarket({
      id: "m9",
      externalMatchId: 333,
      externalMarketType: "match-winner",
      proposedOutcomeId: null,
      outcomes,
    });
    const marketRepo = makeMarketRepo([]);
    marketRepo.createQueryBuilder.mockReturnValue({
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([market]),
    });

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "FINISHED",
        score: { fullTime: { home: 2, away: 0 } },
        homeTeam: { name: "Manchester City" }, // API returns full name
        awayTeam: { name: "Arsenal" },
      }),
    });

    const marketsService = makeMarketsService();
    const { svc } = makeService({ config, marketRepo, marketsService });

    await svc.handleAutoProposal();

    // "Man City" is contained in "Manchester City" → partial match
    expect(marketsService.proposeResolution).toHaveBeenCalledWith("m9", "o-home");
  });
});

// ── concurrent lock guard ─────────────────────────────────────────────────────

describe("KeeperService concurrency guards", () => {
  it("skips expiry job if a previous run is still in progress", async () => {
    const marketsService = makeMarketsService();
    // Make the first call hang forever
    let resolveFirst: () => void;
    const firstCallPromise = new Promise<void>((res) => { resolveFirst = res; });
    marketsService.transition.mockReturnValueOnce(firstCallPromise);

    const upcomingMarket = makeMarket({
      status: MarketStatus.UPCOMING,
      opensAt: pastDate(),
    });
    const marketRepo = makeMarketRepo([]);
    marketRepo.find
      .mockResolvedValueOnce([upcomingMarket])
      .mockResolvedValueOnce([]);

    const { svc } = makeService({ marketsService, marketRepo });

    // Start first run (will hang on transition)
    const first = svc.handleMarketExpirations();
    // Immediately start second run — should be skipped due to lock
    const second = svc.handleMarketExpirations();

    resolveFirst!();
    await Promise.all([first, second]);

    // transition should only have been called once (second run was skipped)
    expect(marketsService.transition).toHaveBeenCalledTimes(1);
  });
});

// ── EPL auto stat-market creation ──────────────────────────────────────────────
describe("KeeperService — EPL auto stat markets", () => {
  const board = () => [
    { player: "Player A", club: "C", clubBadge: "", face: "faceA", faceBackup: "", value: 5 },
    { player: "Player B", club: "C", clubBadge: "", face: "faceB", faceBackup: "", value: 4 },
  ];
  const liveEpl = (over: any = {}) => ({
    getSeasonInfo: jest
      .fn()
      .mockResolvedValue({ started: true, seasonStart: "2026-08-15", maxPlayed: 5 }),
    getStats: jest.fn().mockResolvedValue({
      updatedAt: "x",
      goals: board(),
      assists: board(),
      yellow: board(),
      red: board(),
    }),
    ...over,
  });
  const redisWith = (flag: any = null) => ({
    acquireLock: jest.fn().mockResolvedValue("tok"),
    releaseLock: jest.fn().mockResolvedValue(undefined),
    getJson: jest.fn().mockResolvedValue(flag),
    setJsonEx: jest.fn().mockResolvedValue(undefined),
  });
  const marketsWith = () => ({
    ...makeMarketsService(),
    create: jest
      .fn()
      .mockImplementation((dto: any) => Promise.resolve({ id: `m-${dto.subcategory}`, title: dto.title })),
  });
  const repoWith = (existing: any = null) => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(existing),
    createQueryBuilder: jest.fn(),
  });

  it("creates all 4 markets, sets the once-per-season flag, and notifies admin when the season is live", async () => {
    const marketsService = marketsWith();
    const redis = redisWith(null);
    const marketRepo = repoWith(null);
    const telegram = makeTelegram();
    const config = makeConfig({ ADMIN_TELEGRAM_ID: "999" });
    const { svc } = makeService({
      marketsService,
      redis,
      marketRepo,
      telegram,
      config,
      epl: liveEpl(),
    });

    await svc.handleEplSeasonAutoMarkets();

    expect(marketsService.create).toHaveBeenCalledTimes(4);
    const subs = marketsService.create.mock.calls.map((c: any[]) => c[0].subcategory).sort();
    expect(subs).toEqual([
      "epl-assists",
      "epl-redcards",
      "epl-topscorer",
      "epl-yellowcards",
    ]);
    // flag keyed by season year so it re-arms next season
    expect(redis.setJsonEx).toHaveBeenCalledWith(
      "oro:epl:auto-markets:2026",
      expect.any(Number),
      expect.objectContaining({ done: true }),
    );
    expect(telegram.sendMessage).toHaveBeenCalledWith(999, expect.stringContaining("season is underway"));
  });

  it("does nothing during the off-season", async () => {
    const marketsService = marketsWith();
    const { svc } = makeService({
      marketsService,
      redis: redisWith(null),
      marketRepo: repoWith(null),
      epl: liveEpl({
        getSeasonInfo: jest.fn().mockResolvedValue({ started: false, seasonStart: null, maxPlayed: 0 }),
      }),
    });
    await svc.handleEplSeasonAutoMarkets();
    expect(marketsService.create).not.toHaveBeenCalled();
  });

  it("waits until the maturity gate (min gameweeks) is met", async () => {
    const marketsService = marketsWith();
    const redis = redisWith(null);
    const { svc } = makeService({
      marketsService,
      redis,
      marketRepo: repoWith(null),
      epl: liveEpl({
        getSeasonInfo: jest.fn().mockResolvedValue({ started: true, seasonStart: "2026-08-15", maxPlayed: 1 }),
      }),
    });
    await svc.handleEplSeasonAutoMarkets();
    expect(marketsService.create).not.toHaveBeenCalled();
    // did NOT set the flag → will retry on a later day
    expect(redis.setJsonEx).not.toHaveBeenCalled();
  });

  it("runs only once per season (flag already set)", async () => {
    const marketsService = marketsWith();
    const { svc } = makeService({
      marketsService,
      redis: redisWith({ done: true }),
      marketRepo: repoWith(null),
      epl: liveEpl(),
    });
    await svc.handleEplSeasonAutoMarkets();
    expect(marketsService.create).not.toHaveBeenCalled();
  });

  it("skips a stat that already has an active market", async () => {
    const marketsService = marketsWith();
    const marketRepo = repoWith(null);
    // First stat (goals) already has a market; the rest do not.
    marketRepo.findOne
      .mockResolvedValueOnce({ id: "existing" })
      .mockResolvedValue(null);
    const { svc } = makeService({
      marketsService,
      redis: redisWith(null),
      marketRepo,
      telegram: makeTelegram(),
      config: makeConfig({ ADMIN_TELEGRAM_ID: "1" }),
      epl: liveEpl(),
    });
    await svc.handleEplSeasonAutoMarkets();
    expect(marketsService.create).toHaveBeenCalledTimes(3);
  });
});

// ── EPL auto fixture (match) markets ───────────────────────────────────────────
describe("KeeperService — EPL auto fixture markets", () => {
  const fixtures = () => [
    { id: 111, homeTeam: "Arsenal", awayTeam: "Chelsea", homeCrest: "aC", awayCrest: "cC", utcDate: "2026-08-15T14:00:00Z" },
    { id: 222, homeTeam: "Man City", awayTeam: "Liverpool", homeCrest: "mC", awayCrest: "lC", utcDate: "2026-08-16T15:30:00Z" },
  ];
  const marketsWith = () => ({
    ...makeMarketsService(),
    create: jest
      .fn()
      .mockImplementation((dto: any) => Promise.resolve({ id: `m-${dto.externalMatchId}`, title: dto.title })),
  });
  const repoWith = (existing: any = null) => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(existing),
    createQueryBuilder: jest.fn(),
  });
  const eplWith = (fx: any[]) => ({
    getSeasonInfo: jest.fn().mockResolvedValue({ started: true, seasonStart: "2026-08-15", maxPlayed: 0 }),
    getStats: jest.fn().mockResolvedValue({ goals: [], assists: [], yellow: [], red: [] }),
    getUpcomingFixtures: jest.fn().mockResolvedValue(fx),
  });

  it("creates one match-winner market per upcoming fixture, linked to the fixture id", async () => {
    const marketsService = marketsWith();
    const marketRepo = repoWith(null);
    const redis = {
      acquireLock: jest.fn().mockResolvedValue("tok"),
      releaseLock: jest.fn().mockResolvedValue(undefined),
    };
    const { svc } = makeService({ marketsService, marketRepo, redis, epl: eplWith(fixtures()) });

    await svc.handleEplFixtureMarkets();

    expect(marketsService.create).toHaveBeenCalledTimes(2);
    const first = marketsService.create.mock.calls[0][0];
    expect(first.title).toBe("Arsenal vs Chelsea");
    expect(first.externalMatchId).toBe(111);
    expect(first.externalMarketType).toBe("match-winner");
    expect(first.subcategory).toBe("epl-match");
    expect(first.outcomes.map((o: any) => o.label)).toEqual(["Arsenal", "Draw", "Chelsea"]);
    expect(first.closesAt).toBe("2026-08-15T14:00:00Z");
  });

  it("skips a fixture that already has a market (dedup by fixture id)", async () => {
    const marketsService = marketsWith();
    const marketRepo = repoWith(null);
    // First fixture already has a market; second does not.
    marketRepo.findOne.mockResolvedValueOnce({ id: "existing" }).mockResolvedValue(null);
    const redis = {
      acquireLock: jest.fn().mockResolvedValue("tok"),
      releaseLock: jest.fn().mockResolvedValue(undefined),
    };
    const { svc } = makeService({ marketsService, marketRepo, redis, epl: eplWith(fixtures()) });

    await svc.handleEplFixtureMarkets();
    expect(marketsService.create).toHaveBeenCalledTimes(1);
    expect(marketsService.create.mock.calls[0][0].externalMatchId).toBe(222);
  });

  it("creates nothing when there are no upcoming fixtures (off-season)", async () => {
    const marketsService = marketsWith();
    const redis = {
      acquireLock: jest.fn().mockResolvedValue("tok"),
      releaseLock: jest.fn().mockResolvedValue(undefined),
    };
    const { svc } = makeService({ marketsService, marketRepo: repoWith(null), redis, epl: eplWith([]) });

    await svc.handleEplFixtureMarkets();
    expect(marketsService.create).not.toHaveBeenCalled();
  });
});
