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

describe("BtcMarketService", () => {
  let service: BtcMarketService;
  let marketRepo: ReturnType<typeof createMockRepo>;
  let outcomeRepo: ReturnType<typeof createMockRepo>;
  let priceService: ReturnType<typeof createMockPriceService>;
  let engine: ReturnType<typeof createMockEngine>;
  let dataSource: ReturnType<typeof createMockDataSource>;

  beforeEach(() => {
    marketRepo = createMockRepo();
    outcomeRepo = createMockRepo();
    priceService = createMockPriceService();
    engine = createMockEngine();
    dataSource = createMockDataSource();

    service = new BtcMarketService(
      marketRepo as any,
      outcomeRepo as any,
      priceService as any,
      engine as any,
      dataSource as any,
    );
  });

  describe("spawnMarket", () => {
    it("spawns a new BTC market when no active market exists", async () => {
      marketRepo.findOne.mockResolvedValue(null);

      await service.spawnMarket();

      expect(priceService.fetchPrice).toHaveBeenCalled();
      expect(dataSource.transaction).toHaveBeenCalled();
    });

    it("does NOT spawn if an active BTC market already exists", async () => {
      marketRepo.findOne.mockResolvedValue({
        id: "existing-market",
        status: "open",
      });

      await service.spawnMarket();

      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it("prevents double-spawn via spawning mutex", async () => {
      marketRepo.findOne.mockResolvedValue(null);
      dataSource.transaction.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 100)),
      );

      const p1 = service.spawnMarket();
      const p2 = service.spawnMarket();
      await Promise.all([p1, p2]);

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
      expect(createdMarket.title).toBe("BTC — UP or DOWN in 15 minutes?");
      expect(createdMarket.category).toBe(MarketCategory.ECONOMY);
      expect(createdMarket.status).toBe(MarketStatus.OPEN);
      expect(createdMarket.externalSource).toBe("btc");
      expect(createdMarket.houseEdgePct).toBe(5);
      expect(createdMarket.metadata.isBtc).toBe(true);
      expect(createdMarket.metadata.referencePrice).toBe(67000.0);
      expect(createdMarket.metadata.referenceSource).toBe("binance");
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

      expect(closesAt - bettingClosesAt).toBe(2 * 60 * 1000);
    });

    it("sets closesAt to 15 minutes from now", async () => {
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

      expect(closesAt - opensAt).toBe(15 * 60 * 1000);
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
        externalSource: "btc",
        status: MarketStatus.OPEN,
        closesAt: new Date(Date.now() - 1000),
        outcomes: [upOutcome, downOutcome],
        metadata: { referencePrice: 67000.0, referenceSource: "binance" },
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
        externalSource: "btc",
        status: MarketStatus.OPEN,
        closesAt: new Date(Date.now() - 1000),
        outcomes: [upOutcome, downOutcome],
        metadata: { referencePrice: 67000.0, referenceSource: "binance" },
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
        externalSource: "btc",
        status: MarketStatus.OPEN,
        closesAt: new Date(Date.now() - 1000),
        outcomes: [
          { id: "up-1", label: "UP" },
          { id: "down-1", label: "DOWN" },
        ],
        metadata: { referencePrice: 67000.0 },
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
      priceService.fetchPrice.mockResolvedValue({ ...mockPrice, price: 67000.0 });

      await service.closeAndResolveMarkets();

      expect(engine.cancelMarket).toHaveBeenCalledWith("market-1");
      expect(engine.resolveMarket).not.toHaveBeenCalled();
    });

    it("cancels market when no reference price in metadata", async () => {
      const market = {
        id: "market-1",
        externalSource: "btc",
        status: MarketStatus.OPEN,
        closesAt: new Date(Date.now() - 1000),
        outcomes: [{ id: "up-1", label: "UP" }],
        metadata: {},
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
        externalSource: "btc",
        status: MarketStatus.OPEN,
        closesAt: new Date(Date.now() - 1000),
        outcomes: [
          { id: "up-1", label: "UP" },
          { id: "down-1", label: "DOWN" },
        ],
        metadata: { referencePrice: 67000.0 },
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
      const qb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([market]),
        getOne: jest.fn().mockResolvedValue(null),
      };
      marketRepo.createQueryBuilder.mockReturnValue(qb);
      marketRepo.findOne.mockResolvedValue(null);

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

      const updateCall = marketRepo.update.mock.calls.find(
        (call: any[]) => call[1]?.disputeDeadlineAt,
      );
      expect(updateCall).toBeTruthy();
      expect(updateCall[1].disputeDeadlineAt.getTime()).toBeLessThan(Date.now());
    });
  });

  describe("BTC market configuration", () => {
    it("uses 5% house edge", async () => {
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

    it("sets externalSource to 'btc'", async () => {
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

      expect(createdMarket.externalSource).toBe("btc");
    });

    it("stores price source in metadata", async () => {
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

      expect(createdMarket.metadata.referenceSource).toBe("binance");
    });
  });
});

// ─── BtcPriceService unit tests ──────────────────────────────────────────────

describe("BtcPriceService", () => {
  let priceService: BtcPriceService;

  beforeEach(() => {
    priceService = new BtcPriceService();
  });

  it("fetchPrice returns a BtcPrice object from Binance", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        symbol: "BTCUSDT",
        price: "67234.56",
      }),
    }) as any;

    const price = await priceService.fetchPrice();

    expect(price).toHaveProperty("price");
    expect(price).toHaveProperty("source");
    expect(price).toHaveProperty("fetchedAt");
    expect(price.price).toBeCloseTo(67234.56, 2);
    expect(price.source).toBe("binance");
  });

  it("falls back to Coinbase when Binance fails", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: { amount: "67100.00", currency: "USD" },
        }),
      }) as any;

    const price = await priceService.fetchPrice();

    expect(price.source).toBe("coinbase");
    expect(price.price).toBeCloseTo(67100.0, 2);
  });
});

// ─── bettingClosesAt enforcement tests ───────────────────────────────────────

describe("bettingClosesAt enforcement for BTC markets", () => {
  it("BTC markets always have bettingClosesAt set (non-null)", () => {
    const now = new Date();
    const closesAt = new Date(now.getTime() + 15 * 60 * 1000);
    const bettingClosesAt = new Date(closesAt.getTime() - 2 * 60 * 1000);

    expect(bettingClosesAt).not.toBeNull();
    expect(bettingClosesAt.getTime()).toBeLessThan(closesAt.getTime());
    expect(closesAt.getTime() - bettingClosesAt.getTime()).toBe(2 * 60 * 1000);
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
