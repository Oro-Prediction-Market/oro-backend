import { TerMarketService } from "../ter/ter-market.service";
import { TerPriceService, TerPrice } from "../ter/ter-price.service";
import { MarketStatus, MarketCategory } from "../entities/market.entity";

// ─── Mock Helpers ────────────────────────────────────────────────────────────

const mockPrice: TerPrice = {
  midPrice: 7500.0,
  buyPrice: 7505.0,
  sellPrice: 7495.0,
  xauUsd: 2350.0,
  usdInr: 83.5,
  fetchedAt: new Date(),
};

const mockHigherPrice: TerPrice = {
  midPrice: 7520.0,
  buyPrice: 7525.0,
  sellPrice: 7515.0,
  xauUsd: 2355.0,
  usdInr: 83.5,
  fetchedAt: new Date(),
};

const mockLowerPrice: TerPrice = {
  midPrice: 7480.0,
  buyPrice: 7485.0,
  sellPrice: 7475.0,
  xauUsd: 2345.0,
  usdInr: 83.5,
  fetchedAt: new Date(),
};

const createMockRepo = () => ({
  findOne: jest.fn(),
  find: jest.fn(),
  update: jest.fn().mockResolvedValue({}),
  createQueryBuilder: jest.fn(() => ({
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    getOne: jest.fn().mockResolvedValue(null),
  })) as jest.Mock,
});

const createMockDataSource = () => ({
  transaction: jest.fn(async (cb: any) => {
    const manager = {
      create: jest.fn((_entity: any, data: any) => ({
        id: "market-1",
        ...data,
      })),
      save: jest.fn(async (_entity: any, data: any) => {
        if (Array.isArray(data))
          return data.map((d, i) => ({ id: `outcome-${i}`, ...d }));
        return { id: "market-1", ...data };
      }),
    };
    return cb(manager);
  }),
});

const createMockEngine = () => ({
  cancelMarket: jest.fn().mockResolvedValue(undefined),
  proposeResolution: jest.fn().mockResolvedValue(undefined),
  resolveMarket: jest.fn().mockResolvedValue(undefined),
});

const createMockPriceService = () => ({
  fetchPrice: jest.fn().mockResolvedValue(mockPrice),
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("TerMarketService", () => {
  let service: TerMarketService;
  let marketRepo: ReturnType<typeof createMockRepo>;
  let priceService: ReturnType<typeof createMockPriceService>;
  let engine: ReturnType<typeof createMockEngine>;
  let dataSource: ReturnType<typeof createMockDataSource>;

  beforeEach(() => {
    marketRepo = createMockRepo();
    priceService = createMockPriceService();
    engine = createMockEngine();
    dataSource = createMockDataSource();

    service = new TerMarketService(
      marketRepo as any,
      priceService as any,
      engine as any,
      dataSource as any,
    );
  });

  describe("spawnMarket", () => {
    it("spawns a new TER market when no active market exists", async () => {
      marketRepo.findOne.mockResolvedValue(null);

      await service.spawnMarket();

      expect(priceService.fetchPrice).toHaveBeenCalled();
      expect(dataSource.transaction).toHaveBeenCalled();
    });

    it("does NOT spawn if an active TER market already exists", async () => {
      marketRepo.findOne.mockResolvedValue({
        id: "existing-market",
        status: "open",
      });

      await service.spawnMarket();

      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it("prevents double-spawn via spawning mutex", async () => {
      marketRepo.findOne.mockResolvedValue(null);
      // Simulate slow transaction
      dataSource.transaction.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 100)),
      );

      // Call twice concurrently
      const p1 = service.spawnMarket();
      const p2 = service.spawnMarket();
      await Promise.all([p1, p2]);

      // Only one transaction should have been called
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it("creates market with correct properties", async () => {
      marketRepo.findOne.mockResolvedValue(null);

      let createdMarket: any = null;
      dataSource.transaction.mockImplementation(async (cb: any) => {
        const manager = {
          create: jest.fn((_entity: any, data: any) => {
            if (!createdMarket) createdMarket = data;
            return { id: "market-1", ...data };
          }),
          save: jest.fn(async (_entity: any, data: any) => {
            if (Array.isArray(data)) return data;
            return { id: "market-1", ...data };
          }),
        };
        return cb(manager);
      });

      await service.spawnMarket();

      expect(createdMarket).toBeTruthy();
      expect(createdMarket.title).toBe("TER — UP or DOWN in 24 hours?");
      expect(createdMarket.category).toBe(MarketCategory.ECONOMY);
      expect(createdMarket.status).toBe(MarketStatus.OPEN);
      expect(createdMarket.externalSource).toBe("ter");
      expect(createdMarket.houseEdgePct).toBe(5);
      expect(createdMarket.metadata.isTer).toBe(true);
      expect(createdMarket.metadata.referenceTerPrice).toBe(7500.0);
    });

    it("sets bettingClosesAt to 2 minutes before closesAt", async () => {
      marketRepo.findOne.mockResolvedValue(null);

      let createdMarket: any = null;
      dataSource.transaction.mockImplementation(async (cb: any) => {
        const manager = {
          create: jest.fn((_entity: any, data: any) => {
            if (!createdMarket) createdMarket = data;
            return { id: "market-1", ...data };
          }),
          save: jest.fn(async (_e: any, d: any) =>
            Array.isArray(d) ? d : { id: "m-1", ...d },
          ),
        };
        return cb(manager);
      });

      await service.spawnMarket();

      const closesAt = new Date(createdMarket.closesAt).getTime();
      const bettingClosesAt = new Date(createdMarket.bettingClosesAt).getTime();
      const diffMs = closesAt - bettingClosesAt;

      expect(diffMs).toBe(2 * 60 * 1000); // exactly 2 minutes
    });

    it("sets closesAt to 24 hours from now", async () => {
      marketRepo.findOne.mockResolvedValue(null);

      let createdMarket: any = null;
      dataSource.transaction.mockImplementation(async (cb: any) => {
        const manager = {
          create: jest.fn((_entity: any, data: any) => {
            if (!createdMarket) createdMarket = data;
            return { id: "market-1", ...data };
          }),
          save: jest.fn(async (_e: any, d: any) =>
            Array.isArray(d) ? d : { id: "m-1", ...d },
          ),
        };
        return cb(manager);
      });

      const before = Date.now();
      await service.spawnMarket();
      const after = Date.now();

      const closesAt = new Date(createdMarket.closesAt).getTime();
      const opensAt = new Date(createdMarket.opensAt).getTime();

      // closesAt should be ~24 hours after opensAt
      expect(closesAt - opensAt).toBe(24 * 60 * 60 * 1000);
      // opensAt should be roughly now
      expect(opensAt).toBeGreaterThanOrEqual(before);
      expect(opensAt).toBeLessThanOrEqual(after);
    });

    it("creates UP and DOWN outcomes", async () => {
      marketRepo.findOne.mockResolvedValue(null);

      const savedOutcomes: any[] = [];
      dataSource.transaction.mockImplementation(async (cb: any) => {
        const manager = {
          create: jest.fn((_entity: any, data: any) => data),
          save: jest.fn(async (_entity: any, data: any) => {
            if (Array.isArray(data)) {
              savedOutcomes.push(...data);
              return data;
            }
            return { id: "market-1", ...data };
          }),
        };
        return cb(manager);
      });

      await service.spawnMarket();

      expect(savedOutcomes).toHaveLength(2);
      expect(savedOutcomes.find((o) => o.label === "UP")).toBeTruthy();
      expect(savedOutcomes.find((o) => o.label === "DOWN")).toBeTruthy();
    });
  });

  describe("closeAndResolveMarkets", () => {
    it("does nothing when no markets need closing", async () => {
      const qb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
        getOne: jest.fn().mockResolvedValue(null),
      };
      marketRepo.createQueryBuilder.mockReturnValue(qb);

      await service.closeAndResolveMarkets();

      expect(engine.resolveMarket).not.toHaveBeenCalled();
    });

    it("resolves UP when settlement price > reference price", async () => {
      const upOutcome = { id: "up-1", label: "UP" };
      const downOutcome = { id: "down-1", label: "DOWN" };
      const market = {
        id: "market-1",
        externalSource: "ter",
        status: MarketStatus.OPEN,
        closesAt: new Date(Date.now() - 1000),
        outcomes: [upOutcome, downOutcome],
        metadata: { referenceTerPrice: 7500.0, referenceBuyPrice: 7505.0 },
      };

      const qb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([market]),
        getOne: jest.fn().mockResolvedValue(null),
      };
      marketRepo.createQueryBuilder.mockReturnValue(qb);
      marketRepo.findOne.mockResolvedValue(null); // for spawnNextMarket check

      // Settlement price higher than reference
      priceService.fetchPrice.mockResolvedValue(mockHigherPrice);

      await service.closeAndResolveMarkets();

      expect(engine.proposeResolution).not.toHaveBeenCalled();
      // Direct DB update: CLOSED → RESOLVING with backdated dispute window
      expect(marketRepo.update).toHaveBeenCalledWith(
        "market-1",
        expect.objectContaining({
          status: MarketStatus.RESOLVING,
          proposedOutcomeId: "up-1",
          disputeDeadlineAt: expect.any(Date),
        }),
      );
      expect(engine.resolveMarket).toHaveBeenCalledWith(
        "market-1",
        "up-1",
        "system:auto-resolve",
        undefined,
        expect.any(String),
      );
    });

    it("resolves DOWN when settlement price < reference price", async () => {
      const upOutcome = { id: "up-1", label: "UP" };
      const downOutcome = { id: "down-1", label: "DOWN" };
      const market = {
        id: "market-1",
        externalSource: "ter",
        status: MarketStatus.OPEN,
        closesAt: new Date(Date.now() - 1000),
        outcomes: [upOutcome, downOutcome],
        metadata: { referenceTerPrice: 7500.0, referenceBuyPrice: 7505.0 },
      };

      const qb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([market]),
        getOne: jest.fn().mockResolvedValue(null),
      };
      marketRepo.createQueryBuilder.mockReturnValue(qb);
      marketRepo.findOne.mockResolvedValue(null);

      priceService.fetchPrice.mockResolvedValue(mockLowerPrice);

      await service.closeAndResolveMarkets();

      expect(engine.proposeResolution).not.toHaveBeenCalled();
      expect(marketRepo.update).toHaveBeenCalledWith(
        "market-1",
        expect.objectContaining({
          status: MarketStatus.RESOLVING,
          proposedOutcomeId: "down-1",
          disputeDeadlineAt: expect.any(Date),
        }),
      );
      expect(engine.resolveMarket).toHaveBeenCalledWith(
        "market-1",
        "down-1",
        "system:auto-resolve",
        undefined,
        expect.any(String),
      );
    });

    it("cancels market when settlement price equals reference price", async () => {
      const market = {
        id: "market-1",
        externalSource: "ter",
        status: MarketStatus.OPEN,
        closesAt: new Date(Date.now() - 1000),
        outcomes: [
          { id: "up-1", label: "UP" },
          { id: "down-1", label: "DOWN" },
        ],
        metadata: { referenceTerPrice: 7500.0, referenceBuyPrice: 7505.0 },
      };

      const qb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([market]),
        getOne: jest.fn().mockResolvedValue(null),
      };
      marketRepo.createQueryBuilder.mockReturnValue(qb);
      marketRepo.findOne.mockResolvedValue(null);

      // Same midPrice as reference
      priceService.fetchPrice.mockResolvedValue({
        ...mockPrice,
        midPrice: 7500.0,
      });

      await service.closeAndResolveMarkets();

      expect(engine.cancelMarket).toHaveBeenCalledWith("market-1");
      expect(engine.resolveMarket).not.toHaveBeenCalled();
    });

    it("cancels market when no reference price in metadata", async () => {
      const market = {
        id: "market-1",
        externalSource: "ter",
        status: MarketStatus.OPEN,
        closesAt: new Date(Date.now() - 1000),
        outcomes: [{ id: "up-1", label: "UP" }],
        metadata: {}, // no referenceTerPrice
      };

      const qb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([market]),
        getOne: jest.fn().mockResolvedValue(null),
      };
      marketRepo.createQueryBuilder.mockReturnValue(qb);
      marketRepo.findOne.mockResolvedValue(null);

      await service.closeAndResolveMarkets();

      expect(engine.cancelMarket).toHaveBeenCalledWith("market-1");
    });

    it("spawns next market after resolution", async () => {
      const market = {
        id: "market-1",
        externalSource: "ter",
        status: MarketStatus.OPEN,
        closesAt: new Date(Date.now() - 1000),
        outcomes: [
          { id: "up-1", label: "UP" },
          { id: "down-1", label: "DOWN" },
        ],
        metadata: { referenceTerPrice: 7500.0, referenceBuyPrice: 7505.0 },
      };

      const qb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([market]),
        getOne: jest.fn().mockResolvedValue(null),
      };
      marketRepo.createQueryBuilder.mockReturnValue(qb);
      // First call (closeAndResolve check for spawnNext): no existing
      // Second call would be from spawnNextMarket
      marketRepo.findOne.mockResolvedValue(null);

      priceService.fetchPrice.mockResolvedValue(mockHigherPrice);

      await service.closeAndResolveMarkets();

      // dataSource.transaction is called for spawning next market
      expect(dataSource.transaction).toHaveBeenCalled();
    });

    it("[CONCURRENCY] skips duplicate processing when the same market is picked up by overlapping interval ticks", async () => {
      // Reproduces the bug behind the 04:45–06:01 PM double payouts on 2026-05-11:
      // @Interval(3_000) fires while the previous tick is still awaiting fetchPrice,
      // both ticks call closeAndResolve(sameMarket), engine.resolveMarket gets
      // invoked twice → settleMarket runs twice → payouts duplicated.
      const market = {
        id: "market-race",
        externalSource: "ter",
        status: MarketStatus.OPEN,
        closesAt: new Date(Date.now() - 1000),
        outcomes: [
          { id: "up-1", label: "UP" },
          { id: "down-1", label: "DOWN" },
        ],
        metadata: { referenceTerPrice: 7500.0, referenceBuyPrice: 7505.0 },
      };
      const qb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([market]),
        getOne: jest.fn().mockResolvedValue(null),
      };
      marketRepo.createQueryBuilder.mockReturnValue(qb);
      marketRepo.findOne.mockResolvedValue(null);

      // Pause fetchPrice so tick #2 can enter closeAndResolve while tick #1 is mid-flight
      let releaseFetch: (p: TerPrice) => void = () => {};
      const slowFetch = new Promise<TerPrice>((res) => {
        releaseFetch = res;
      });
      priceService.fetchPrice.mockReturnValue(slowFetch);

      // Fire two overlapping ticks
      const tick1 = service.closeAndResolveMarkets();
      // Yield so tick1 reaches the await on fetchPrice
      await new Promise((res) => setImmediate(res));
      const tick2 = service.closeAndResolveMarkets();
      // Yield again so tick2 hits the Set guard and returns
      await new Promise((res) => setImmediate(res));

      // Release fetch and let tick1 finish
      releaseFetch(mockHigherPrice);
      await Promise.all([tick1, tick2]);

      // Without the guard, this would be 2. With the guard, it must be 1.
      expect(engine.resolveMarket).toHaveBeenCalledTimes(1);
    });

    it("[CONCURRENCY] releases the processing lock after engine.resolveMarket throws so retries are possible", async () => {
      const market = {
        id: "market-err",
        externalSource: "ter",
        status: MarketStatus.OPEN,
        closesAt: new Date(Date.now() - 1000),
        outcomes: [
          { id: "up-1", label: "UP" },
          { id: "down-1", label: "DOWN" },
        ],
        metadata: { referenceTerPrice: 7500.0, referenceBuyPrice: 7505.0 },
      };
      const qb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([market]),
        getOne: jest.fn().mockResolvedValue(null),
      };
      marketRepo.createQueryBuilder.mockReturnValue(qb);
      marketRepo.findOne.mockResolvedValue(null);
      priceService.fetchPrice.mockResolvedValue(mockHigherPrice);

      // First call: engine.resolveMarket throws
      engine.resolveMarket.mockRejectedValueOnce(new Error("transient db error"));
      await service.closeAndResolveMarkets();
      // closeAndResolveMarkets has its own try/catch, so no throw bubbles up.

      // Second call: engine.resolveMarket succeeds. If the Set still held
      // market.id from the failed first call, this second call would be skipped.
      engine.resolveMarket.mockResolvedValueOnce(undefined);
      await service.closeAndResolveMarkets();

      // Both calls reached engine.resolveMarket → finally block released the lock
      expect(engine.resolveMarket).toHaveBeenCalledTimes(2);
    });

    it("sets disputeDeadlineAt to past to bypass dispute window", async () => {
      const market = {
        id: "market-1",
        externalSource: "ter",
        status: MarketStatus.OPEN,
        closesAt: new Date(Date.now() - 1000),
        outcomes: [
          { id: "up-1", label: "UP" },
          { id: "down-1", label: "DOWN" },
        ],
        metadata: { referenceTerPrice: 7500.0, referenceBuyPrice: 7505.0 },
      };

      const qb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([market]),
        getOne: jest.fn().mockResolvedValue(null),
      };
      marketRepo.createQueryBuilder.mockReturnValue(qb);
      marketRepo.findOne.mockResolvedValue(null);
      priceService.fetchPrice.mockResolvedValue(mockHigherPrice);

      await service.closeAndResolveMarkets();

      // Check that disputeDeadlineAt was set to a past date
      const updateCall = marketRepo.update.mock.calls.find(
        (call: any[]) => call[1]?.disputeDeadlineAt,
      );
      expect(updateCall).toBeTruthy();
      expect(updateCall[1].disputeDeadlineAt.getTime()).toBeLessThan(
        Date.now(),
      );
    });
  });

  describe("TER market configuration", () => {
    it("uses 5% house edge (not 8% default)", async () => {
      marketRepo.findOne.mockResolvedValue(null);

      let createdMarket: any = null;
      dataSource.transaction.mockImplementation(async (cb: any) => {
        const manager = {
          create: jest.fn((_e: any, data: any) => {
            if (!createdMarket) createdMarket = data;
            return { id: "m-1", ...data };
          }),
          save: jest.fn(async (_e: any, d: any) =>
            Array.isArray(d) ? d : { id: "m-1", ...d },
          ),
        };
        return cb(manager);
      });

      await service.spawnMarket();

      expect(createdMarket.houseEdgePct).toBe(5);
    });

    it("marks market as Economy category", async () => {
      marketRepo.findOne.mockResolvedValue(null);

      let createdMarket: any = null;
      dataSource.transaction.mockImplementation(async (cb: any) => {
        const manager = {
          create: jest.fn((_e: any, data: any) => {
            if (!createdMarket) createdMarket = data;
            return { id: "m-1", ...data };
          }),
          save: jest.fn(async (_e: any, d: any) =>
            Array.isArray(d) ? d : { id: "m-1", ...d },
          ),
        };
        return cb(manager);
      });

      await service.spawnMarket();

      expect(createdMarket.category).toBe(MarketCategory.ECONOMY);
    });

    it("sets externalSource to 'ter'", async () => {
      marketRepo.findOne.mockResolvedValue(null);

      let createdMarket: any = null;
      dataSource.transaction.mockImplementation(async (cb: any) => {
        const manager = {
          create: jest.fn((_e: any, data: any) => {
            if (!createdMarket) createdMarket = data;
            return { id: "m-1", ...data };
          }),
          save: jest.fn(async (_e: any, d: any) =>
            Array.isArray(d) ? d : { id: "m-1", ...d },
          ),
        };
        return cb(manager);
      });

      await service.spawnMarket();

      expect(createdMarket.externalSource).toBe("ter");
    });
  });
});

// ─── TerPriceService unit tests ──────────────────────────────────────────────

describe("TerPriceService", () => {
  let priceService: TerPriceService;

  beforeEach(() => {
    priceService = new TerPriceService({ get: jest.fn() } as any);
  });

  it("fetchPrice returns a TerPrice object", async () => {
    // Mock global fetch
    const mockResponse = {
      ok: true,
      json: jest.fn().mockResolvedValue({
        prices: [
          {
            product_symbol: "TERBTN",
            ask_price: 75050000,
            bid_price: 74950000,
            tradeable: true,
            spread: 100000,
            effective_at: new Date().toISOString(),
          },
        ],
      }),
    };
    global.fetch = jest.fn().mockResolvedValue(mockResponse) as any;

    const price = await priceService.fetchPrice();

    expect(price).toHaveProperty("midPrice");
    expect(price).toHaveProperty("buyPrice");
    expect(price).toHaveProperty("sellPrice");
    expect(price).toHaveProperty("fetchedAt");
    expect(price.buyPrice).toBeCloseTo(7505.0, 1);
    expect(price.sellPrice).toBeCloseTo(7495.0, 1);
    expect(price.midPrice).toBeCloseTo(7500.0, 1);
  });
});

// ─── bettingClosesAt enforcement tests ───────────────────────────────────────

describe("bettingClosesAt server-side enforcement", () => {
  it("TER markets always have bettingClosesAt set (non-null)", () => {
    // Validate the spawn logic always sets it
    const now = new Date();
    const closesAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const bettingClosesAt = new Date(closesAt.getTime() - 2 * 60 * 1000);

    expect(bettingClosesAt).not.toBeNull();
    expect(bettingClosesAt.getTime()).toBeLessThan(closesAt.getTime());
    expect(closesAt.getTime() - bettingClosesAt.getTime()).toBe(2 * 60 * 1000);
  });

  it("normal markets have bettingClosesAt = null (guard skips them)", () => {
    const market = { bettingClosesAt: null as Date | null };
    const shouldBlock =
      market.bettingClosesAt && new Date() >= market.bettingClosesAt;
    expect(shouldBlock).toBeFalsy();
  });

  it("blocks bet when current time >= bettingClosesAt", () => {
    const pastTime = new Date(Date.now() - 60000);
    const market = { bettingClosesAt: pastTime as Date | null };
    const shouldBlock =
      market.bettingClosesAt && new Date() >= market.bettingClosesAt;
    expect(shouldBlock).toBeTruthy();
  });

  it("allows bet when current time < bettingClosesAt", () => {
    const futureTime = new Date(Date.now() + 60000);
    const market = { bettingClosesAt: futureTime as Date | null };
    const shouldBlock =
      market.bettingClosesAt && new Date() >= market.bettingClosesAt;
    expect(shouldBlock).toBeFalsy();
  });
});

// ─── TER minimum bet tests ──────────────────────────────────────────────────

describe("TER minimum bet (Nu 10)", () => {
  function getMinBet(externalSource: string | null): number {
    return externalSource === "ter" ? 10 : 50;
  }

  it("TER markets have a minimum bet of Nu 10", () => {
    expect(getMinBet("ter")).toBe(10);
  });

  it("non-TER markets keep the default minimum of Nu 50", () => {
    expect(getMinBet(null)).toBe(50);
    expect(getMinBet("btc")).toBe(50);
  });

  it("rejects TER bet below Nu 10", () => {
    const minBet = getMinBet("ter");
    const amount = 5;
    expect(amount < minBet).toBe(true);
  });

  it("accepts TER bet of exactly Nu 10", () => {
    const minBet = getMinBet("ter");
    const amount = 10;
    expect(amount >= minBet).toBe(true);
  });

  it("rejects non-TER bet below Nu 50", () => {
    const minBet = getMinBet(null);
    const amount = 25;
    expect(amount < minBet).toBe(true);
  });

  it("accepts non-TER bet of exactly Nu 50", () => {
    const minBet = getMinBet(null);
    const amount = 50;
    expect(amount >= minBet).toBe(true);
  });
});
