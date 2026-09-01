/**
 * markets.service.spec.ts
 *
 * Tests the `attachSignal` behaviour of MarketsService — specifically:
 *
 *   SOFT-HIDE CONTRACT
 *   The backend always returns `reputationSignal` and `intelligenceProb`
 *   on outcome objects when the signal is computable, and returns `null`
 *   for both when the market does not yet have ≥ 3 unique bettors.
 *
 *   The frontend is responsible for gating display (hasBet flag).
 *   The backend is responsible for gating computation (≥ 3 unique bettors).
 *
 *   These tests verify the backend's side of the contract:
 *   - null signal when totalPool = 0 (no bets at all)
 *   - null signal when fewer than 3 unique bettors
 *   - non-null signal when ≥ 3 unique bettors exist
 *   - intelligenceProb is null when no weighted share data exists
 *   - intelligenceProb is computed and non-null when weighted shares exist
 *   - signal values sum to 1.0 across all outcomes
 *   - reputationSignal matches computeMarketSignal output per outcome
 */

import { MarketsService } from "../markets/markets.service";
import { ReputationService } from "../markets/reputation.service";
import { LMSRService } from "../markets/lmsr.service";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeOutcome(id: string, totalBetAmount = 0) {
  return {
    id,
    label: id,
    totalBetAmount,
    currentOdds: 0,
    lmsrProbability: 0.5,
    isWinner: false,
  };
}

function makeMarket(overrides: any = {}) {
  return {
    id: "m1",
    title: "Test",
    status: "open",
    totalPool: 0,
    houseEdgePct: 8,
    liquidityParam: 1000,
    category: "sports",
    outcomes: [makeOutcome("o1"), makeOutcome("o2")],
    ...overrides,
  };
}

/**
 * Build a MarketsService whose reputationService is fully mocked.
 * `signalMap`    — the per-outcomeId signal returned by computeMarketSignal
 * `weightedShares` — per-outcomeId effective share returned by computeReputationWeightedShares
 */
function makeService({
  signalMap = {} as Record<string, number>,
  weightedShares = {} as Record<string, number>,
  market = null as any,
} = {}) {
  const mockMarketRepo = {
    findOne: jest.fn().mockResolvedValue(market),
  };

  const mockReputationService = {
    computeMarketSignal: jest.fn().mockResolvedValue(signalMap),
    computeSignalConfidence: jest.fn().mockResolvedValue({
      participantCount: 3,
      reputationDepth: 0.5,
      maturityScore: 0.5,
      composite: 0.5,
    }),
    computeReputationWeightedShares: jest
      .fn()
      .mockResolvedValue(weightedShares),
  };

  const mockRedis = {
    getJson: jest.fn().mockResolvedValue(null), // no cache hit
    setJsonEx: jest.fn().mockResolvedValue(undefined),
  };

  const svc = new MarketsService(
    mockMarketRepo as any,
    null as any, // outcomeRepo
    null as any, // disputeRepo
    null as any, // userRepo
    // marketBookRepo / outcomeBookRepo — the market payload now carries its
    // currency books and each outcome's pool per currency, so a client can
    // tell a USDT market from a BTN-only one and quote the right odds.
    { find: jest.fn().mockResolvedValue([]) } as any,
    { find: jest.fn().mockResolvedValue([]) } as any,
    null as any, // engine
    new LMSRService(),
    null as any, // dataSource
    mockRedis as any,
    mockReputationService as any,
    { postToChannel: jest.fn().mockResolvedValue(undefined) } as any, // TelegramSimpleService
  );

  return { svc, mockReputationService };
}

// ─── attachSignal: null when totalPool = 0 ───────────────────────────────────

describe("MarketsService.attachSignal — no bets", () => {
  it("leaves reputationSignal and intelligenceProb as undefined when totalPool is 0", async () => {
    const market = makeMarket({ totalPool: 0 });
    const { svc } = makeService({ market });

    // findOne returns the market; attachSignal is called internally
    const result = await svc.findOne("m1");

    // totalPool = 0 → attachSignal returns early, nothing attached
    expect((result.outcomes[0] as any).reputationSignal).toBeUndefined();
    expect((result.outcomes[0] as any).intelligenceProb).toBeUndefined();
  });
});

// ─── attachSignal: null signal when < 3 unique bettors ───────────────────────

describe("MarketsService.attachSignal — fewer than 3 unique bettors", () => {
  it("sets reputationSignal to null when computeMarketSignal returns {}", async () => {
    // computeMarketSignal returns {} when < 3 unique bettors
    const market = makeMarket({
      totalPool: 200,
      outcomes: [makeOutcome("o1", 100), makeOutcome("o2", 100)],
    });
    const { svc } = makeService({
      market,
      signalMap: {}, // ← service returns empty = fewer than 3 bettors
      weightedShares: {},
    });

    const result = await svc.findOne("m1");

    // Both outcomes should have null signal — the market cannot be trusted yet
    expect((result.outcomes[0] as any).reputationSignal).toBeNull();
    expect((result.outcomes[1] as any).reputationSignal).toBeNull();
  });

  it("sets intelligenceProb to null when no weighted share data exists", async () => {
    const market = makeMarket({
      totalPool: 200,
      outcomes: [makeOutcome("o1", 100), makeOutcome("o2", 100)],
    });
    const { svc } = makeService({
      market,
      signalMap: {},
      weightedShares: {}, // ← no weighted data → intelligenceProb = null
    });

    const result = await svc.findOne("m1");

    expect((result.outcomes[0] as any).intelligenceProb).toBeNull();
    expect((result.outcomes[1] as any).intelligenceProb).toBeNull();
  });
});

// ─── attachSignal: signal present when ≥ 3 unique bettors ────────────────────

describe("MarketsService.attachSignal — signal revealed with ≥ 3 unique bettors", () => {
  it("attaches reputationSignal to each outcome matching computeMarketSignal output", async () => {
    const market = makeMarket({
      totalPool: 300,
      outcomes: [makeOutcome("o1", 200), makeOutcome("o2", 100)],
    });
    // 3 unique bettors → computeMarketSignal returns a real signal
    const signalMap = { o1: 0.65, o2: 0.35 };
    const { svc } = makeService({ market, signalMap, weightedShares: {} });

    const result = await svc.findOne("m1");

    expect((result.outcomes[0] as any).reputationSignal).toBeCloseTo(0.65, 4);
    expect((result.outcomes[1] as any).reputationSignal).toBeCloseTo(0.35, 4);
  });

  it("reputationSignal values sum to 1.0 across all outcomes", async () => {
    const market = makeMarket({
      totalPool: 300,
      outcomes: [makeOutcome("o1", 200), makeOutcome("o2", 100)],
    });
    const signalMap = { o1: 0.65, o2: 0.35 };
    const { svc } = makeService({ market, signalMap, weightedShares: {} });

    const result = await svc.findOne("m1");
    const sum =
      ((result.outcomes[0] as any).reputationSignal ?? 0) +
      ((result.outcomes[1] as any).reputationSignal ?? 0);
    expect(sum).toBeCloseTo(1.0, 3);
  });

  it("attaches non-null intelligenceProb when weighted shares exist", async () => {
    const market = makeMarket({
      totalPool: 300,
      outcomes: [makeOutcome("o1", 200), makeOutcome("o2", 100)],
    });
    // Weighted shares: o1 gets more weight (high-rep bettors on o1)
    const weightedShares = { o1: 400, o2: 100 };
    const { svc } = makeService({
      market,
      signalMap: { o1: 0.7, o2: 0.3 },
      weightedShares,
    });

    const result = await svc.findOne("m1");

    // Both outcomes should have a computed intelligenceProb
    expect((result.outcomes[0] as any).intelligenceProb).not.toBeNull();
    expect((result.outcomes[1] as any).intelligenceProb).not.toBeNull();
    // intelligenceProb values must sum to ~1
    const sum =
      ((result.outcomes[0] as any).intelligenceProb ?? 0) +
      ((result.outcomes[1] as any).intelligenceProb ?? 0);
    expect(sum).toBeCloseTo(1.0, 3);
  });

  it("intelligenceProb favours the outcome with more reputation-weighted shares", async () => {
    const market = makeMarket({
      totalPool: 300,
      outcomes: [makeOutcome("o1", 200), makeOutcome("o2", 100)],
    });
    // o1 has 4× more weighted shares → should have higher intelligenceProb
    const weightedShares = { o1: 800, o2: 200 };
    const { svc } = makeService({
      market,
      signalMap: { o1: 0.8, o2: 0.2 },
      weightedShares,
    });

    const result = await svc.findOne("m1");

    const prob0 = (result.outcomes[0] as any).intelligenceProb;
    const prob1 = (result.outcomes[1] as any).intelligenceProb;
    expect(prob0).toBeGreaterThan(prob1);
  });

  it("signalMeta is attached to the market when signal is computed", async () => {
    const market = makeMarket({
      totalPool: 300,
      outcomes: [makeOutcome("o1", 200), makeOutcome("o2", 100)],
    });
    const { svc } = makeService({
      market,
      signalMap: { o1: 0.6, o2: 0.4 },
      weightedShares: { o1: 300, o2: 150 },
    });

    const result = await svc.findOne("m1");

    expect((result as any).signalMeta).toBeDefined();
    expect((result as any).signalMeta.participantCount).toBeGreaterThanOrEqual(
      0,
    );
    expect((result as any).signalMeta.composite).toBeGreaterThanOrEqual(0);
  });
});

// ─── attachSignal: outcome with no signal entry gets null ─────────────────────

describe("MarketsService.attachSignal — partial signal map", () => {
  it("outcomes missing from signalMap get null reputationSignal (not undefined)", async () => {
    const market = makeMarket({
      totalPool: 300,
      outcomes: [
        makeOutcome("o1", 200),
        makeOutcome("o2", 100),
        makeOutcome("o3", 0),
      ],
    });
    // Only o1 and o2 appear in the signal — o3 is missing
    const signalMap = { o1: 0.55, o2: 0.45 };
    const { svc } = makeService({ market, signalMap, weightedShares: {} });

    const result = await svc.findOne("m1");

    expect((result.outcomes[0] as any).reputationSignal).toBeCloseTo(0.55, 4);
    expect((result.outcomes[1] as any).reputationSignal).toBeCloseTo(0.45, 4);
    // o3 not in signalMap → should be null, not undefined
    expect((result.outcomes[2] as any).reputationSignal).toBeNull();
  });
});

// ─── Channel auto-posts ───────────────────────────────────────────────────────

describe("MarketsService channel auto-posts", () => {
  function makeServiceWithTelegram() {
    const mockTelegram = {
      postToChannel: jest.fn().mockResolvedValue(undefined),
    };
    const market = makeMarket({
      totalPool: 0,
      outcomes: [makeOutcome("o1"), makeOutcome("o2")],
    });
    const mockMarketRepo = {
      create: jest.fn((d: any) => d),
      save: jest.fn((d: any) => Promise.resolve({ id: "m1", ...d })),
      findOne: jest.fn().mockResolvedValue(market),
    };
    const mockReputationService = {
      computeMarketSignal: jest.fn().mockResolvedValue({}),
      computeSignalConfidence: jest.fn().mockResolvedValue({
        participantCount: 0,
        reputationDepth: 0,
        maturityScore: 0,
        composite: 0,
      }),
      computeReputationWeightedShares: jest.fn().mockResolvedValue({}),
    };
    const mockRedis = {
      getJson: jest.fn().mockResolvedValue(null),
      setJsonEx: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };
    const mockOutcomeRepo = { create: jest.fn((d: any) => d), save: jest.fn() };
    const svc = new MarketsService(
      mockMarketRepo as any,
      mockOutcomeRepo as any,
      null as any, // disputeRepo
      null as any, // userRepo
      { find: jest.fn().mockResolvedValue([]) } as any,
      { find: jest.fn().mockResolvedValue([]) } as any /* outcomeBookRepo */, // marketBookRepo
      null as any, // engine
      new LMSRService(),
      null as any, // dataSource
      mockRedis as any,
      mockReputationService as any,
      mockTelegram as any);
    return { svc, mockTelegram };
  }

  it("posts to channel after resolve() is called", async () => {
    const { svc, mockTelegram } = makeServiceWithTelegram();
    // engine.resolveMarket is null, so we stub resolve via the service's own findOne path
    (svc as any).engine = {
      resolveMarket: jest.fn().mockResolvedValue({ id: "s1" }),
    };

    await svc.resolve("m1", "o1");

    // Give the non-blocking postToChannel promise a tick to settle
    await new Promise((r) => setTimeout(r, 0));
    expect(mockTelegram.postToChannel).toHaveBeenCalledWith(
      expect.stringContaining("Test"), // market title
    );
  });
});

// ─── createGroup: political grouped multi-binary markets ────────────────────

describe("MarketsService.createGroup — grouped Yes/No candidate markets", () => {
  function makeCreateService() {
    const savedMarkets: any[] = [];
    let nextId = 1;
    const mockMarketRepo = {
      create: jest.fn((d: any) => d),
      save: jest.fn((d: any) => {
        const saved = { id: `m${nextId++}`, ...d };
        savedMarkets.push(saved);
        return Promise.resolve(saved);
      }),
      findOne: jest.fn(({ where: { id } }: any) =>
        Promise.resolve(savedMarkets.find((m) => m.id === id) ?? null),
      ),
    };
    const mockReputationService = {
      computeMarketSignal: jest.fn().mockResolvedValue({}),
      computeSignalConfidence: jest.fn().mockResolvedValue({
        participantCount: 0,
        reputationDepth: 0,
        maturityScore: 0,
        composite: 0,
      }),
      computeReputationWeightedShares: jest.fn().mockResolvedValue({}),
    };
    const mockRedis = {
      getJson: jest.fn().mockResolvedValue(null),
      setJsonEx: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };
    const mockOutcomeRepo = { create: jest.fn((d: any) => d), save: jest.fn() };
    const svc = new MarketsService(
      mockMarketRepo as any,
      mockOutcomeRepo as any,
      null as any, // disputeRepo
      null as any, // userRepo
      { find: jest.fn().mockResolvedValue([]) } as any,
      { find: jest.fn().mockResolvedValue([]) } as any /* outcomeBookRepo */, // marketBookRepo
      null as any, // engine
      new LMSRService(),
      null as any, // dataSource
      mockRedis as any,
      mockReputationService as any,
      { postToChannel: jest.fn().mockResolvedValue(undefined) } as any);
    return { svc, savedMarkets };
  }

  const groupDto = {
    title: "Who will win the 2026 election?",
    description: "National election winner",
    closesAt: "2026-12-31T00:00:00.000Z",
    houseEdgePct: 5,
    liquidityParam: 1000,
    candidates: [
      { name: "Sonam", imageUrl: "https://img/sonam.png" },
      { name: "Tenzin", imageUrl: null },
    ],
  } as any;

  it("creates one Yes/No child market per candidate", async () => {
    const { svc } = makeCreateService();
    const markets = await svc.createGroup(groupDto);
    expect(markets).toHaveLength(2);
    for (const m of markets) {
      expect(m.outcomes.map((o: any) => o.label)).toEqual(["Yes", "No"]);
    }
  });

  it("links all children with one shared groupId + groupTitle", async () => {
    const { svc } = makeCreateService();
    const markets = await svc.createGroup(groupDto);
    expect(markets[0].groupId).toBeTruthy();
    expect(markets[1].groupId).toBe(markets[0].groupId);
    expect(markets.map((m) => m.groupTitle)).toEqual([
      groupDto.title,
      groupDto.title,
    ]);
  });

  it("titles each child with the event + candidate and stores the candidate in metadata", async () => {
    const { svc } = makeCreateService();
    const markets = await svc.createGroup(groupDto);
    expect(markets[0].title).toBe("Who will win the 2026 election? — Sonam");
    expect(markets[1].title).toBe("Who will win the 2026 election? — Tenzin");
    expect(markets[0].metadata).toEqual({ candidate: "Sonam" });
    expect(markets[1].metadata).toEqual({ candidate: "Tenzin" });
  });

  it("defaults category to political and uses candidate image with event-image fallback", async () => {
    const { svc } = makeCreateService();
    const markets = await svc.createGroup({
      ...groupDto,
      imageUrl: "https://img/event.png",
    });
    expect(markets.map((m) => m.category)).toEqual(["political", "political"]);
    expect(markets[0].imageUrl).toBe("https://img/sonam.png");
    expect(markets[1].imageUrl).toBe("https://img/event.png");
  });
});

// ─── updateGroup: edit a whole grouped event at once ────────────────────────

describe("MarketsService.updateGroup — group-wide edits", () => {
  function makeUpdateService() {
    const base = {
      groupId: "g1",
      groupTitle: "Who will win?",
      status: "upcoming",
      category: "political",
      liquidityParam: 1000,
      houseEdgePct: 10,
    };
    const store: any[] = [
      {
        ...base,
        id: "m1",
        title: "Who will win? — Sonam",
        imageUrl: null,
        metadata: { candidate: "Sonam" },
      },
      {
        ...base,
        id: "m2",
        title: "Who will win? — Tenzin",
        imageUrl: null,
        metadata: { candidate: "Tenzin" },
      },
    ];
    let nextId = 3;
    const mockMarketRepo = {
      find: jest.fn(({ where: { groupId } }: any) =>
        Promise.resolve(store.filter((m) => m.groupId === groupId)),
      ),
      create: jest.fn((d: any) => d),
      save: jest.fn((d: any) => {
        if (!d.id) {
          d.id = `m${nextId++}`;
          store.push(d);
        }
        return Promise.resolve(d);
      }),
      findOne: jest.fn(({ where: { id } }: any) =>
        Promise.resolve(store.find((m) => m.id === id) ?? null),
      ),
      update: jest.fn(() => Promise.resolve({})),
    };
    const mockRedis = {
      getJson: jest.fn().mockResolvedValue(null),
      setJsonEx: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new MarketsService(
      mockMarketRepo as any,
      { create: jest.fn((d: any) => d), save: jest.fn() } as any,
      null as any, // disputeRepo
      null as any, // userRepo
      { find: jest.fn().mockResolvedValue([]) } as any,
      { find: jest.fn().mockResolvedValue([]) } as any /* outcomeBookRepo */, // marketBookRepo
      null as any, // engine
      new LMSRService(),
      null as any,
      mockRedis as any,
      {} as any,
      { postToChannel: jest.fn() } as any);
    return { svc, store };
  }

  it("fans a shared field (houseEdgePct) out to every candidate", async () => {
    const { svc } = makeUpdateService();
    const markets = await svc.updateGroup("g1", { houseEdgePct: 8 } as any);
    expect(markets.map((m) => m.houseEdgePct)).toEqual([8, 8]);
  });

  it("renaming the umbrella title rewrites every sibling's title prefix", async () => {
    const { svc } = makeUpdateService();
    const markets = await svc.updateGroup("g1", {
      title: "Who becomes PM?",
    } as any);
    expect(markets.map((m) => m.groupTitle)).toEqual([
      "Who becomes PM?",
      "Who becomes PM?",
    ]);
    expect(markets.map((m) => m.title)).toEqual([
      "Who becomes PM? — Sonam",
      "Who becomes PM? — Tenzin",
    ]);
  });

  it("applies a per-candidate image without touching siblings", async () => {
    const { svc } = makeUpdateService();
    const markets = await svc.updateGroup("g1", {
      candidates: [{ id: "m2", imageUrl: "https://img/tenzin.png" }],
    } as any);
    expect(markets.find((m) => m.id === "m1")!.imageUrl).toBeNull();
    expect(markets.find((m) => m.id === "m2")!.imageUrl).toBe(
      "https://img/tenzin.png",
    );
  });

  it("renaming a candidate updates its title suffix and metadata", async () => {
    const { svc } = makeUpdateService();
    const markets = await svc.updateGroup("g1", {
      candidates: [{ id: "m1", name: "Sonam Wangchuk" }],
    } as any);
    const m1 = markets.find((m) => m.id === "m1")!;
    expect(m1.title).toBe("Who will win? — Sonam Wangchuk");
    expect(m1.metadata).toEqual({ candidate: "Sonam Wangchuk" });
  });

  it("throws when the group has no markets", async () => {
    const { svc } = makeUpdateService();
    await expect(svc.updateGroup("nope", {} as any)).rejects.toThrow();
  });

  it("adds a brand-new candidate (no id) as a fresh Yes/No sibling", async () => {
    const { svc } = makeUpdateService();
    const markets = await svc.updateGroup("g1", {
      candidates: [{ name: "Karma" }],
    } as any);
    expect(markets).toHaveLength(3);
    const added = markets.find((m) => m.metadata?.candidate === "Karma");
    expect(added).toBeTruthy();
    expect(added!.title).toBe("Who will win? — Karma");
    expect(added!.groupId).toBe("g1");
    expect(added!.outcomes.map((o: any) => o.label)).toEqual(["Yes", "No"]);
  });

  it("ignores blank new-candidate rows (no id and no name)", async () => {
    const { svc } = makeUpdateService();
    const markets = await svc.updateGroup("g1", {
      candidates: [{ name: "   " }, {}],
    } as any);
    expect(markets).toHaveLength(2);
  });
});

// ─── create: category assignment ─────────────────────────────────────────────

describe("MarketsService.create — category assignment", () => {
  function makeCreateService() {
    const mockMarketRepo = {
      create: jest.fn((d: any) => d),
      save: jest.fn((d: any) => Promise.resolve({ id: "m1", ...d })),
      findOne: jest.fn(({ where: { id } }: any) =>
        Promise.resolve({ id, outcomes: [] }),
      ),
    };
    const mockRedis = {
      getJson: jest.fn().mockResolvedValue(null),
      setJsonEx: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new MarketsService(
      mockMarketRepo as any,
      { create: jest.fn((d: any) => d), save: jest.fn() } as any,
      null as any,
      null as any,
      { find: jest.fn().mockResolvedValue([]) } as any /* marketBookRepo */,
      { find: jest.fn().mockResolvedValue([]) } as any /* outcomeBookRepo */,
      null as any,
      new LMSRService(),
      null as any,
      mockRedis as any,
      {
        computeMarketSignal: jest.fn().mockResolvedValue({}),
        computeSignalConfidence: jest.fn().mockResolvedValue({
          participantCount: 0,
          reputationDepth: 0,
          maturityScore: 0,
          composite: 0,
        }),
        computeReputationWeightedShares: jest.fn().mockResolvedValue({}),
      } as any,
      { postToChannel: jest.fn().mockResolvedValue(undefined) } as any);
    return { svc, mockMarketRepo };
  }

  const baseDto = {
    title: "T",
    outcomes: [{ label: "Yes" }, { label: "No" }],
  } as any;

  it("persists the category the admin picked", async () => {
    const { svc, mockMarketRepo } = makeCreateService();
    await svc.create({ ...baseDto, category: "political" });
    expect(mockMarketRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ category: "political" }),
    );
  });

  it("falls back to 'other' for unknown or missing categories", async () => {
    const { svc, mockMarketRepo } = makeCreateService();
    await svc.create({ ...baseDto, category: "not-a-category" });
    await svc.create(baseDto);
    expect(mockMarketRepo.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ category: "other" }),
    );
    expect(mockMarketRepo.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ category: "other" }),
    );
  });
});

// ─── submitDispute: one contest per book ─────────────────────────────────────
//
// The window, the proposal and the admin's final call are market-wide; the
// money is per book. A participant bonds in their own account's currency,
// against defenders in that same currency, and is paid from their forfeited
// bonds. Nothing crosses books — no exchange rate exists anywhere in this
// system, and inventing one for a forfeit split would be inventing one for
// real money.
//
// The regression these cover: the lock row used to omit `currency` entirely, so
// a USDT account passed the (unfiltered) position check, had its bond sized
// against a USDT balance and was then debited in BTN.

describe("MarketsService.submitDispute — per-book contests", () => {
  function makeDisputeService(opts: {
    userCurrency: string;
    /** Currency of the caller's live position. Defaults to their account's. */
    positionCurrency?: string;
    /** Book rows that exist for this market, by currency. */
    books?: Record<string, { id: string; disputeBondAmount: number | null }>;
    /** Existing contest entries in the caller's book. */
    existingInBook?: number;
    balance?: number;
  }) {
    const {
      userCurrency,
      positionCurrency = opts.userCurrency,
      books = {
        BTN: { id: "book-btn", disputeBondAmount: null },
        USDT: { id: "book-usdt", disputeBondAmount: null },
      },
      existingInBook = 0,
      balance = 500,
    } = opts;

    const market = {
      id: "m1",
      title: "Test market",
      status: "resolving",
      totalPool: 300,
      houseEdgePct: 8,
      // Wide open, so a rejection can only come from the rule under test.
      disputeDeadlineAt: new Date(Date.now() + 60 * 60 * 1000),
      outcomes: [makeOutcome("o1"), makeOutcome("o2")],
    };

    const savedTransactions: any[] = [];
    const savedDisputes: any[] = [];
    const bookUpdates: any[] = [];
    let countedWhere: any = null;

    const repoFor = (entity: any) => {
      const name = entity?.name;
      if (name === "MarketBook") {
        return {
          createQueryBuilder: jest.fn().mockReturnValue({
            setLock: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            getOne: jest
              .fn()
              .mockImplementation(async () =>
                books[userCurrency]
                  ? { currency: userCurrency, ...books[userCurrency] }
                  : null,
              ),
          }),
          update: jest.fn().mockImplementation(async (crit: any, patch: any) => {
            bookUpdates.push({ crit, patch });
          }),
        };
      }
      if (name === "Dispute") {
        return {
          count: jest.fn().mockImplementation(async (args: any) => {
            countedWhere = args?.where;
            return existingInBook;
          }),
          create: jest.fn().mockImplementation((d: any) => ({ ...d })),
          save: jest.fn().mockImplementation(async (d: any) => {
            savedDisputes.push(d);
            return d;
          }),
        };
      }
      // Transaction: both the ledger balance read and the lock row write.
      return {
        create: jest.fn().mockImplementation((d: any) => ({ ...d })),
        save: jest.fn().mockImplementation(async (d: any) => {
          savedTransactions.push(d);
          return d;
        }),
        createQueryBuilder: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getRawOne: jest.fn().mockResolvedValue({ balance }),
        }),
      };
    };

    const mockEm = { getRepository: jest.fn(repoFor) };

    const mockDataSource = {
      getRepository: jest.fn().mockReturnValue({
        // Honours the currency filter, which is the point: a stake in another
        // book is not exposure to this book's payout.
        findOne: jest.fn().mockImplementation(async (args: any) => {
          if (args?.where?.currency && args.where.currency !== positionCurrency)
            return null;
          return {
            id: "pos1",
            userId: "u1",
            marketId: "m1",
            status: "pending",
            currency: positionCurrency,
          };
        }),
      }),
      transaction: jest.fn().mockImplementation((cb: Function) => cb(mockEm)),
    };

    const svc = new MarketsService(
      { findOne: jest.fn().mockResolvedValue(market) } as any,
      null as any, // outcomeRepo
      { findOne: jest.fn().mockResolvedValue(null) } as any, // disputeRepo
      { findOne: jest.fn().mockResolvedValue({ id: "u1", currency: userCurrency }) } as any,
      {
        findOne: jest.fn().mockImplementation(async (args: any) => {
          const ccy = args?.where?.currency;
          return books[ccy] ? { currency: ccy, ...books[ccy] } : null;
        }),
        find: jest.fn().mockResolvedValue([]),
      } as any, // marketBookRepo
      { find: jest.fn().mockResolvedValue([]) } as any, // outcomeBookRepo
      null as any, // engine
      new LMSRService(),
      mockDataSource as any,
      {
        getJson: jest.fn().mockResolvedValue(null),
        setJsonEx: jest.fn().mockResolvedValue(undefined),
        del: jest.fn().mockResolvedValue(undefined),
      } as any,
      {
        computeMarketSignal: jest.fn().mockResolvedValue({}),
        computeSignalConfidence: jest.fn().mockResolvedValue({
          participantCount: 0,
          reputationDepth: 0,
          maturityScore: 0,
          composite: 0,
        }),
        computeReputationWeightedShares: jest.fn().mockResolvedValue({}),
      } as any,
      { postToChannel: jest.fn().mockResolvedValue(undefined) } as any,
    );

    return {
      svc,
      savedTransactions,
      savedDisputes,
      bookUpdates,
      countedWhere: () => countedWhere,
    };
  }

  it("bonds a BTN account in BTN, at the Nu 10 floor", async () => {
    const { svc, savedTransactions, savedDisputes, bookUpdates } =
      makeDisputeService({ userCurrency: "BTN" });

    const result = await svc.submitDispute("u1", "m1", {
      reason: "wrong outcome",
    } as any);

    expect(savedTransactions).toHaveLength(1);
    expect(savedTransactions[0].currency).toBe("BTN");
    expect(savedTransactions[0].amount).toBe(-10);
    expect(savedDisputes[0].currency).toBe("BTN");
    expect(savedDisputes[0].bondAmount).toBe(10);
    // The agreed bond is stamped on the BOOK, not the market — that is what a
    // later participant matches against.
    expect(bookUpdates).toEqual([
      { crit: { id: "book-btn" }, patch: { disputeBondAmount: 10 } },
    ]);
    expect(result.bondNote).toContain("Nu 10");
  });

  it("bonds a USDT account in USDT, at the 0.5 floor, against the USDT book", async () => {
    const { svc, savedTransactions, savedDisputes, bookUpdates } =
      makeDisputeService({ userCurrency: "USDT" });

    const result = await svc.submitDispute("u1", "m1", {
      reason: "wrong outcome",
    } as any);

    // The regression: this row used to land as −10 BTN.
    expect(savedTransactions).toHaveLength(1);
    expect(savedTransactions[0].currency).toBe("USDT");
    expect(savedTransactions[0].amount).toBe(-0.5);
    expect(savedDisputes[0].currency).toBe("USDT");
    expect(savedDisputes[0].bondAmount).toBe(0.5);
    expect(bookUpdates).toEqual([
      { crit: { id: "book-usdt" }, patch: { disputeBondAmount: 0.5 } },
    ]);
    // Quoted in the currency actually charged, not "Nu 0.5".
    expect(result.bondNote).toContain("0.5 USDT");
  });

  it("counts existing entries per book, so each book has its own first objector", async () => {
    const { svc, countedWhere } = makeDisputeService({ userCurrency: "USDT" });

    await svc.submitDispute("u1", "m1", { reason: "wrong outcome" } as any);

    // Without the currency scope, a BTN objection would make a USDT bettor a
    // "later participant" of a contest that does not exist in their book.
    expect(countedWhere()).toEqual({ marketId: "m1", currency: "USDT" });
  });

  it("makes a later participant match the bond recorded on their own book", async () => {
    const { svc, savedTransactions } = makeDisputeService({
      userCurrency: "USDT",
      existingInBook: 1,
      books: {
        BTN: { id: "book-btn", disputeBondAmount: 500 },
        USDT: { id: "book-usdt", disputeBondAmount: 2.5 },
      },
    });

    await svc.submitDispute("u1", "m1", {
      reason: "defending",
      side: "support",
    } as any);

    // 2.5 from the USDT book — not 500 from BTN, and not the 0.5 floor.
    expect(savedTransactions[0].amount).toBe(-2.5);
    expect(savedTransactions[0].currency).toBe("USDT");
  });

  it("rejects a bond that does not match the book's agreed amount", async () => {
    const { svc } = makeDisputeService({
      userCurrency: "USDT",
      existingInBook: 1,
      books: { USDT: { id: "book-usdt", disputeBondAmount: 2.5 } },
    });

    await expect(
      svc.submitDispute("u1", "m1", {
        reason: "defending",
        side: "support",
        bondAmount: 2.4,
      } as any),
    ).rejects.toThrow(/fixed at 2.5 USDT/);
  });

  it("requires a position in the book being contested", async () => {
    // Account settles in USDT but the only live stake is ngultrum.
    const { svc } = makeDisputeService({
      userCurrency: "USDT",
      positionCurrency: "BTN",
    });

    await expect(
      svc.submitDispute("u1", "m1", { reason: "wrong outcome" } as any),
    ).rejects.toThrow(/active USDT position/);
  });

  it("refuses a currency with no configured bond floor, and moves no money", async () => {
    const { svc, savedTransactions, savedDisputes } = makeDisputeService({
      userCurrency: "EUR",
    });

    await expect(
      svc.submitDispute("u1", "m1", { reason: "wrong outcome" } as any),
    ).rejects.toThrow(/not open for EUR accounts yet/);

    expect(savedTransactions).toHaveLength(0);
    expect(savedDisputes).toHaveLength(0);
  });

  it("refuses when the market has no book in the caller's currency", async () => {
    const { svc, savedTransactions } = makeDisputeService({
      userCurrency: "USDT",
      books: { BTN: { id: "book-btn", disputeBondAmount: null } },
    });

    await expect(
      svc.submitDispute("u1", "m1", { reason: "wrong outcome" } as any),
    ).rejects.toThrow(/no USDT book/);

    expect(savedTransactions).toHaveLength(0);
  });

  it("sizes the bond against the caller's own ledger, refusing when short", async () => {
    const { svc } = makeDisputeService({
      userCurrency: "USDT",
      existingInBook: 1,
      books: { USDT: { id: "book-usdt", disputeBondAmount: 2.5 } },
      balance: 1,
    });

    await expect(
      svc.submitDispute("u1", "m1", {
        reason: "defending",
        side: "support",
      } as any),
    ).rejects.toThrow(/at least 2.5 USDT[\s\S]*balance is 1 USDT/);
  });
});
