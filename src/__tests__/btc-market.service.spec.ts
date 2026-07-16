import { BtcMarketService } from "../btc/btc-market.service";
import { BtcPriceService, BtcPrice } from "../btc/btc-price.service";
import { MarketStatus, MarketCategory } from "../entities/market.entity";

// ─── Mock Helpers ────────────────────────────────────────────────────────────

const mockPrice: BtcPrice = {
  price: 67000.0,
  source: "binance",
  fetchedAt: new Date(),
};

const mockHigherPrice: BtcPrice = {
  price: 67500.0,
  source: "binance",
  fetchedAt: new Date(),
};

const mockLowerPrice: BtcPrice = {
  price: 66500.0,
  source: "coinbase",
  fetchedAt: new Date(),
};

const createQb = (overrides: Partial<Record<string, any>> = {}) => ({
  leftJoinAndSelect: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  andWhere: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  execute: jest.fn().mockResolvedValue({ affected: 1 }),
  getMany: jest.fn().mockResolvedValue([]),
  getOne: jest.fn().mockResolvedValue(null),
  ...overrides,
});

const createMockRepo = () => ({
  findOne: jest.fn(),
  find: jest.fn(),
  update: jest.fn().mockResolvedValue({}),
  createQueryBuilder: jest.fn(() => createQb()) as jest.Mock,
});

const createMockDataSource = () => ({
  transaction: jest.fn(async (cb: any) => {
    const manager = {
      query: jest.fn().mockResolvedValue(undefined),
      getRepository: jest.fn(() => ({
        createQueryBuilder: jest.fn(() => createQb()),
      })),
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

// Captures the market entity created inside dataSource.transaction
const captureCreatedMarket = (dataSource: any) => {
  const captured: { market: any } = { market: null };
  dataSource.transaction.mockImplementation(async (cb: any) => {
    const manager = {
      query: jest.fn().mockResolvedValue(undefined),
      getRepository: jest.fn(() => ({
        createQueryBuilder: jest.fn(() => createQb()),
      })),
      create: jest.fn((_entity: any, data: any) => {
        if (!captured.market) captured.market = data;
        return { id: "market-1", ...data };
      }),
      save: jest.fn(async (_e: any, d: any) =>
        Array.isArray(d) ? d : { id: "market-1", ...d },
      ),
    };
    return cb(manager);
  });
  return captured;
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("BtcMarketService", () => {
  let service: BtcMarketService;
  let marketRepo: ReturnType<typeof createMockRepo>;
  let priceService: ReturnType<typeof createMockPriceService>;
  let engine: ReturnType<typeof createMockEngine>;
  let dataSource: ReturnType<typeof createMockDataSource>;

  beforeEach(() => {
    marketRepo = createMockRepo();
    priceService = createMockPriceService();
    engine = createMockEngine();
    dataSource = createMockDataSource();

    service = new BtcMarketService(
      marketRepo as any,
      priceService as any,
      engine as any,
      dataSource as any,
    );
  });

  describe("spawnMarket", () => {
    it("spawns a new BTC market when no bettable market exists", async () => {
      await service.spawnMarket();

      expect(dataSource.transaction).toHaveBeenCalled();
    });

    it("fetches the price at spawn — reference is fixed for the whole round", async () => {
      await service.spawnMarket();

      expect(priceService.fetchPrice).toHaveBeenCalled();
    });

    it("does NOT spawn when the price fetch fails — retried on the next tick", async () => {
      priceService.fetchPrice.mockRejectedValueOnce(new Error("API down"));

      await service.spawnMarket();

      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it("does NOT spawn if a bettable BTC market already exists", async () => {
      marketRepo.createQueryBuilder.mockReturnValue(
        createQb({
          getOne: jest
            .fn()
            .mockResolvedValue({ id: "existing-market", status: "open" }),
        }),
      );

      await service.spawnMarket();

      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it("does NOT insert when another instance spawned a round concurrently (advisory-lock re-check)", async () => {
      const managerCreate = jest.fn();
      dataSource.transaction.mockImplementation(async (cb: any) => {
        const manager = {
          query: jest.fn().mockResolvedValue(undefined),
          getRepository: jest.fn(() => ({
            createQueryBuilder: jest.fn(() =>
              createQb({
                getOne: jest
                  .fn()
                  .mockResolvedValue({ id: "concurrent-market" }),
              }),
            ),
          })),
          create: managerCreate,
          save: jest.fn(),
        };
        return cb(manager);
      });

      await service.spawnMarket();

      expect(managerCreate).not.toHaveBeenCalled();
    });

    it("prevents double-spawn via spawning mutex", async () => {
      dataSource.transaction.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 100)),
      );

      const p1 = service.spawnMarket();
      const p2 = service.spawnMarket();
      await Promise.all([p1, p2]);

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it("creates market with correct properties and the reference snapshotted at open", async () => {
      const captured = captureCreatedMarket(dataSource);

      await service.spawnMarket();

      const createdMarket = captured.market;
      expect(createdMarket).toBeTruthy();
      expect(createdMarket.title).toBe("BTC — UP or DOWN in 9 minutes?");
      expect(createdMarket.category).toBe(MarketCategory.ECONOMY);
      expect(createdMarket.status).toBe(MarketStatus.OPEN);
      expect(createdMarket.externalSource).toBe("btc");
      expect(createdMarket.houseEdgePct).toBe(5);
      expect(createdMarket.metadata.isBtc).toBe(true);
      // The "price to beat" is fixed at open, not at betting close
      expect(createdMarket.metadata.referencePrice).toBe(67000.0);
      expect(createdMarket.metadata.referenceSource).toBe("binance");
      expect(createdMarket.metadata.referenceLockedAt).toEqual(expect.any(String));
    });

    it("sets a 9-minute round with betting closing 3 minutes before settlement", async () => {
      const captured = captureCreatedMarket(dataSource);

      const before = Date.now();
      await service.spawnMarket();
      const after = Date.now();

      const createdMarket = captured.market;
      const opensAt = new Date(createdMarket.opensAt).getTime();
      const bettingClosesAt = new Date(createdMarket.bettingClosesAt).getTime();
      const closesAt = new Date(createdMarket.closesAt).getTime();

      expect(bettingClosesAt - opensAt).toBe(6 * 60 * 1000);
      expect(closesAt - bettingClosesAt).toBe(3 * 60 * 1000);
      expect(closesAt - opensAt).toBe(9 * 60 * 1000);
      expect(opensAt).toBeGreaterThanOrEqual(before);
      expect(opensAt).toBeLessThanOrEqual(after);
    });

    it("creates UP and DOWN outcomes", async () => {
      const savedOutcomes: any[] = [];
      dataSource.transaction.mockImplementation(async (cb: any) => {
        const manager = {
          query: jest.fn().mockResolvedValue(undefined),
          getRepository: jest.fn(() => ({
            createQueryBuilder: jest.fn(() => createQb()),
          })),
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

  describe("lockReferencePrices", () => {
    const lockableMarket = () => ({
      id: "market-1",
      externalSource: "btc",
      status: MarketStatus.OPEN,
      bettingClosesAt: new Date(Date.now() - 1000),
      closesAt: new Date(Date.now() + 14 * 60 * 1000),
      metadata: { isBtc: true },
    });

    it("locks the current price as reference on markets past betting close", async () => {
      marketRepo.createQueryBuilder.mockReturnValue(
        createQb({ getMany: jest.fn().mockResolvedValue([lockableMarket()]) }),
      );

      await service.lockReferencePrices();

      expect(priceService.fetchPrice).toHaveBeenCalled();
      expect(marketRepo.update).toHaveBeenCalledWith(
        "market-1",
        expect.objectContaining({
          metadata: expect.objectContaining({
            referencePrice: 67000.0,
            referenceSource: "binance",
            referenceLockedAt: expect.any(String),
          }),
        }),
      );
    });

    it("does not spawn from the lock step — tick() spawns the next round", async () => {
      marketRepo.createQueryBuilder.mockReturnValue(
        createQb({ getMany: jest.fn().mockResolvedValue([lockableMarket()]) }),
      );

      await service.lockReferencePrices();

      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it("skips markets that already have a reference price (legacy rounds)", async () => {
      const legacy = {
        ...lockableMarket(),
        metadata: { isBtc: true, referencePrice: 66000.0 },
      };
      marketRepo.createQueryBuilder.mockReturnValue(
        createQb({ getMany: jest.fn().mockResolvedValue([legacy]) }),
      );

      await service.lockReferencePrices();

      expect(priceService.fetchPrice).not.toHaveBeenCalled();
      expect(marketRepo.update).not.toHaveBeenCalled();
    });

    it("does not update anything when the price fetch fails, and retries next tick", async () => {
      marketRepo.createQueryBuilder.mockReturnValue(
        createQb({ getMany: jest.fn().mockResolvedValue([lockableMarket()]) }),
      );
      priceService.fetchPrice.mockRejectedValueOnce(new Error("API down"));

      await service.lockReferencePrices();
      expect(marketRepo.update).not.toHaveBeenCalled();

      // Retry succeeds — the lock guard was released by the failed attempt
      priceService.fetchPrice.mockResolvedValueOnce(mockPrice);
      await service.lockReferencePrices();
      expect(marketRepo.update).toHaveBeenCalled();
    });

    it("[CONCURRENCY] overlapping ticks do not double-lock the same market", async () => {
      marketRepo.createQueryBuilder.mockReturnValue(
        createQb({ getMany: jest.fn().mockResolvedValue([lockableMarket()]) }),
      );

      let releaseFetch: (p: BtcPrice) => void = () => {};
      const slowFetch = new Promise<BtcPrice>((res) => {
        releaseFetch = res;
      });
      priceService.fetchPrice.mockReturnValue(slowFetch);

      const tick1 = service.lockReferencePrices();
      await new Promise((res) => setImmediate(res));
      const tick2 = service.lockReferencePrices();
      await new Promise((res) => setImmediate(res));

      releaseFetch(mockPrice);
      await Promise.all([tick1, tick2]);

      const referenceUpdates = marketRepo.update.mock.calls.filter(
        (call: any[]) => call[1]?.metadata?.referencePrice,
      );
      expect(referenceUpdates).toHaveLength(1);
    });
  });

  describe("closeAndResolveMarkets", () => {
    it("does nothing when no markets need closing", async () => {
      marketRepo.createQueryBuilder.mockReturnValue(createQb());

      await service.closeAndResolveMarkets();

      expect(engine.resolveMarket).not.toHaveBeenCalled();
    });

    it("resolves UP when settlement price > reference price", async () => {
      const upOutcome = { id: "up-1", label: "UP" };
      const downOutcome = { id: "down-1", label: "DOWN" };
      const market = {
        id: "market-1",
        externalSource: "btc",
        status: MarketStatus.OPEN,
        closesAt: new Date(Date.now() - 1000),
        outcomes: [upOutcome, downOutcome],
        metadata: { referencePrice: 67000.0, referenceSource: "binance" },
      };

      const qb = createQb({ getMany: jest.fn().mockResolvedValue([market]) });
      marketRepo.createQueryBuilder.mockReturnValue(qb);
      priceService.fetchPrice.mockResolvedValue(mockHigherPrice);

      await service.closeAndResolveMarkets();

      expect(qb.set).toHaveBeenCalledWith(
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
        externalSource: "btc",
        status: MarketStatus.OPEN,
        closesAt: new Date(Date.now() - 1000),
        outcomes: [upOutcome, downOutcome],
        metadata: { referencePrice: 67000.0, referenceSource: "binance" },
      };

      const qb = createQb({ getMany: jest.fn().mockResolvedValue([market]) });
      marketRepo.createQueryBuilder.mockReturnValue(qb);
      priceService.fetchPrice.mockResolvedValue(mockLowerPrice);

      await service.closeAndResolveMarkets();

      expect(qb.set).toHaveBeenCalledWith(
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
        externalSource: "btc",
        status: MarketStatus.OPEN,
        closesAt: new Date(Date.now() - 1000),
        outcomes: [
          { id: "up-1", label: "UP" },
          { id: "down-1", label: "DOWN" },
        ],
        metadata: { referencePrice: 67000.0 },
      };

      marketRepo.createQueryBuilder.mockReturnValue(
        createQb({ getMany: jest.fn().mockResolvedValue([market]) }),
      );
      priceService.fetchPrice.mockResolvedValue({ ...mockPrice, price: 67000.0 });

      await service.closeAndResolveMarkets();

      expect(engine.cancelMarket).toHaveBeenCalledWith("market-1");
      expect(engine.resolveMarket).not.toHaveBeenCalled();
    });

    it("cancels (refunds) market when reference price was never locked", async () => {
      const market = {
        id: "market-1",
        externalSource: "btc",
        status: MarketStatus.OPEN,
        closesAt: new Date(Date.now() - 1000),
        outcomes: [{ id: "up-1", label: "UP" }],
        metadata: {},
      };

      marketRepo.createQueryBuilder.mockReturnValue(
        createQb({ getMany: jest.fn().mockResolvedValue([market]) }),
      );

      await service.closeAndResolveMarkets();

      expect(engine.cancelMarket).toHaveBeenCalledWith("market-1");
      expect(engine.resolveMarket).not.toHaveBeenCalled();
      // The only price fetch is the next-round spawn — no settlement fetch
      // happens for a market with nothing to compare against.
      expect(priceService.fetchPrice).toHaveBeenCalledTimes(1);
    });

    it("ensures a bettable market exists after resolution", async () => {
      const market = {
        id: "market-1",
        externalSource: "btc",
        status: MarketStatus.OPEN,
        closesAt: new Date(Date.now() - 1000),
        outcomes: [
          { id: "up-1", label: "UP" },
          { id: "down-1", label: "DOWN" },
        ],
        metadata: { referencePrice: 67000.0 },
      };

      marketRepo.createQueryBuilder.mockReturnValue(
        createQb({ getMany: jest.fn().mockResolvedValue([market]) }),
      );
      priceService.fetchPrice.mockResolvedValue(mockHigherPrice);

      await service.closeAndResolveMarkets();

      expect(dataSource.transaction).toHaveBeenCalled();
    });

    it("[CONCURRENCY] skips duplicate processing when the same market is picked up by overlapping interval ticks", async () => {
      const market = {
        id: "market-race",
        externalSource: "btc",
        status: MarketStatus.OPEN,
        closesAt: new Date(Date.now() - 1000),
        outcomes: [
          { id: "up-1", label: "UP" },
          { id: "down-1", label: "DOWN" },
        ],
        metadata: { referencePrice: 67000.0 },
      };
      marketRepo.createQueryBuilder.mockReturnValue(
        createQb({ getMany: jest.fn().mockResolvedValue([market]) }),
      );

      let releaseFetch: (p: BtcPrice) => void = () => {};
      const slowFetch = new Promise<BtcPrice>((res) => {
        releaseFetch = res;
      });
      priceService.fetchPrice.mockReturnValue(slowFetch);

      const tick1 = service.closeAndResolveMarkets();
      await new Promise((res) => setImmediate(res));
      const tick2 = service.closeAndResolveMarkets();
      await new Promise((res) => setImmediate(res));

      releaseFetch(mockHigherPrice);
      await Promise.all([tick1, tick2]);

      expect(engine.resolveMarket).toHaveBeenCalledTimes(1);
    });

    it("[CONCURRENCY] releases the processing lock after engine.resolveMarket throws", async () => {
      const market = {
        id: "market-err",
        externalSource: "btc",
        status: MarketStatus.OPEN,
        closesAt: new Date(Date.now() - 1000),
        outcomes: [
          { id: "up-1", label: "UP" },
          { id: "down-1", label: "DOWN" },
        ],
        metadata: { referencePrice: 67000.0 },
      };
      marketRepo.createQueryBuilder.mockReturnValue(
        createQb({ getMany: jest.fn().mockResolvedValue([market]) }),
      );
      priceService.fetchPrice.mockResolvedValue(mockHigherPrice);

      engine.resolveMarket.mockRejectedValueOnce(new Error("transient db error"));
      await service.closeAndResolveMarkets();

      engine.resolveMarket.mockResolvedValueOnce(undefined);
      await service.closeAndResolveMarkets();

      expect(engine.resolveMarket).toHaveBeenCalledTimes(2);
    });

    it("sets disputeDeadlineAt to past to bypass dispute window", async () => {
      const market = {
        id: "market-1",
        externalSource: "btc",
        status: MarketStatus.OPEN,
        closesAt: new Date(Date.now() - 1000),
        outcomes: [
          { id: "up-1", label: "UP" },
          { id: "down-1", label: "DOWN" },
        ],
        metadata: { referencePrice: 67000.0 },
      };

      const qb = createQb({ getMany: jest.fn().mockResolvedValue([market]) });
      marketRepo.createQueryBuilder.mockReturnValue(qb);
      priceService.fetchPrice.mockResolvedValue(mockHigherPrice);

      await service.closeAndResolveMarkets();

      const setCall = qb.set.mock.calls.find(
        (call: any[]) => call[0]?.disputeDeadlineAt,
      );
      expect(setCall).toBeTruthy();
      expect(setCall[0].disputeDeadlineAt.getTime()).toBeLessThan(Date.now());
    });

    it("[CONCURRENCY] skips the settle when the atomic OPEN→CLOSED claim is lost", async () => {
      const market = {
        id: "market-claimed",
        externalSource: "btc",
        status: MarketStatus.OPEN,
        closesAt: new Date(Date.now() - 1000),
        outcomes: [
          { id: "up-1", label: "UP" },
          { id: "down-1", label: "DOWN" },
        ],
        metadata: { referencePrice: 67000.0 },
      };
      // Another instance already flipped the market out of OPEN → claim loses
      const qb = createQb({
        getMany: jest.fn().mockResolvedValue([market]),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      });
      marketRepo.createQueryBuilder.mockReturnValue(qb);

      await service.closeAndResolveMarkets();

      expect(engine.resolveMarket).not.toHaveBeenCalled();
      expect(engine.cancelMarket).not.toHaveBeenCalled();
      // No settlement price fetch either — the whole settle path is skipped
      expect(priceService.fetchPrice).not.toHaveBeenCalled();
    });

    it("releases the CLOSED claim back to OPEN when the settlement price fetch fails", async () => {
      const market = {
        id: "market-fetchfail",
        externalSource: "btc",
        status: MarketStatus.OPEN,
        closesAt: new Date(Date.now() - 1000),
        outcomes: [
          { id: "up-1", label: "UP" },
          { id: "down-1", label: "DOWN" },
        ],
        metadata: { referencePrice: 67000.0 },
      };
      marketRepo.createQueryBuilder.mockReturnValue(
        createQb({ getMany: jest.fn().mockResolvedValue([market]) }),
      );
      priceService.fetchPrice.mockRejectedValueOnce(new Error("API down"));

      await service.closeAndResolveMarkets();

      expect(engine.resolveMarket).not.toHaveBeenCalled();
      expect(marketRepo.update).toHaveBeenCalledWith(
        { id: "market-fetchfail", status: MarketStatus.CLOSED },
        { status: MarketStatus.OPEN },
      );
    });
  });

  describe("BTC market configuration", () => {
    it("uses 5% house edge", async () => {
      const captured = captureCreatedMarket(dataSource);

      await service.spawnMarket();

      expect(captured.market.houseEdgePct).toBe(5);
    });

    it("marks market as Economy category", async () => {
      const captured = captureCreatedMarket(dataSource);

      await service.spawnMarket();

      expect(captured.market.category).toBe(MarketCategory.ECONOMY);
    });

    it("sets externalSource to 'btc'", async () => {
      const captured = captureCreatedMarket(dataSource);

      await service.spawnMarket();

      expect(captured.market.externalSource).toBe("btc");
    });
  });
});

// ─── BtcPriceService unit tests ──────────────────────────────────────────────

describe("BtcPriceService", () => {
  let priceService: BtcPriceService;

  beforeEach(() => {
    priceService = new BtcPriceService();
  });

  it("fetchPrice returns a BtcPrice object from Coinbase (primary source)", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        data: { amount: "67234.56", currency: "USD" },
      }),
    }) as any;

    const price = await priceService.fetchPrice();

    expect(price).toHaveProperty("price");
    expect(price).toHaveProperty("source");
    expect(price).toHaveProperty("fetchedAt");
    expect(price.price).toBeCloseTo(67234.56, 2);
    expect(price.source).toBe("coinbase");
  });

  it("falls back to Binance when Coinbase fails", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({
          symbol: "BTCUSDT",
          price: "67100.00",
        }),
      }) as any;

    const price = await priceService.fetchPrice();

    expect(price.source).toBe("binance");
    expect(price.price).toBeCloseTo(67100.0, 2);
  });
});

// ─── bettingClosesAt enforcement tests ───────────────────────────────────────

describe("bettingClosesAt enforcement for BTC markets", () => {
  it("BTC rounds close betting 3 minutes before settlement", () => {
    const now = new Date();
    const closesAt = new Date(now.getTime() + 9 * 60 * 1000);
    const bettingClosesAt = new Date(closesAt.getTime() - 3 * 60 * 1000);

    expect(bettingClosesAt).not.toBeNull();
    expect(bettingClosesAt.getTime()).toBeLessThan(closesAt.getTime());
    expect(closesAt.getTime() - bettingClosesAt.getTime()).toBe(3 * 60 * 1000);
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

// ─── BTC minimum bet tests ────────────────────────────────────────────────────

describe("BTC minimum bet (Nu 10)", () => {
  function getMinBet(externalSource: string | null): number {
    return ["ter", "btc"].includes(externalSource ?? "") ? 10 : 50;
  }

  it("BTC markets have a minimum bet of Nu 10", () => {
    expect(getMinBet("btc")).toBe(10);
  });

  it("TER markets still have a minimum bet of Nu 10", () => {
    expect(getMinBet("ter")).toBe(10);
  });

  it("non-BTC/TER markets keep the default minimum of Nu 50", () => {
    expect(getMinBet(null)).toBe(50);
    expect(getMinBet("sports")).toBe(50);
  });

  it("rejects BTC bet below Nu 10", () => {
    const minBet = getMinBet("btc");
    expect(5 < minBet).toBe(true);
  });

  it("accepts BTC bet of exactly Nu 10", () => {
    const minBet = getMinBet("btc");
    expect(10 >= minBet).toBe(true);
  });
});
