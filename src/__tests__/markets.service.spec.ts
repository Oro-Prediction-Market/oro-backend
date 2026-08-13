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
      null as any, // engine
      new LMSRService(),
      null as any, // dataSource
      mockRedis as any,
      mockReputationService as any,
      mockTelegram as any,
    );
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
      null as any, // engine
      new LMSRService(),
      null as any, // dataSource
      mockRedis as any,
      mockReputationService as any,
      { postToChannel: jest.fn().mockResolvedValue(undefined) } as any,
    );
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
    const store: any[] = [
      {
        id: "m1",
        groupId: "g1",
        groupTitle: "Who will win?",
        title: "Who will win? — Sonam",
        imageUrl: null,
        metadata: { candidate: "Sonam" },
      },
      {
        id: "m2",
        groupId: "g1",
        groupTitle: "Who will win?",
        title: "Who will win? — Tenzin",
        imageUrl: null,
        metadata: { candidate: "Tenzin" },
      },
    ];
    const mockMarketRepo = {
      find: jest.fn(({ where: { groupId } }: any) =>
        Promise.resolve(store.filter((m) => m.groupId === groupId)),
      ),
      save: jest.fn((d: any) => Promise.resolve(d)),
    };
    const mockRedis = {
      getJson: jest.fn().mockResolvedValue(null),
      setJsonEx: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new MarketsService(
      mockMarketRepo as any,
      { create: jest.fn(), save: jest.fn() } as any,
      null as any,
      null as any,
      null as any,
      new LMSRService(),
      null as any,
      mockRedis as any,
      {} as any,
      { postToChannel: jest.fn() } as any,
    );
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
      { postToChannel: jest.fn().mockResolvedValue(undefined) } as any,
    );
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
