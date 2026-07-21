import { BadRequestException } from "@nestjs/common";
import { ParimutuelEngine } from "../markets/parimutuel.engine";
import { MarketStatus } from "../entities/market.entity";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const bypassConfigService = {
  get: jest.fn(() => undefined),
} as any;

function makeEngine(marketRepo: any) {
  return new ParimutuelEngine(
    marketRepo,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    bypassConfigService,
    null as any,
    null as any, // challengesService
    null as any, // marketsGateway
    null as any, // sse
    null as any, // revenueDistributionService
    ({ addBulk: async () => [] }) as any, // notificationQueue
  );
}

function makeMarket(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: "m1",
    title: "QF-1: Team A vs Team B",
    subcategory: "wc-match",
    status: MarketStatus.CLOSED,
    proposedOutcomeId: null,
    disputeDeadlineAt: null,
    closesAt: new Date(Date.now() - 60 * 60 * 1000), // closed an hour ago
    ...overrides,
  };
}

function makeMarketRepo(market: any) {
  return {
    findOneBy: jest.fn(async () => market),
    save: jest.fn(async (m: any) => m),
  };
}

const future = () => new Date(Date.now() + 60 * 60 * 1000);

// ─── reopenMarket ────────────────────────────────────────────────────────────

describe("ParimutuelEngine.reopenMarket", () => {
  it("reopens a CLOSED wc- market with a future closesAt", async () => {
    const market = makeMarket();
    const repo = makeMarketRepo(market);
    const engine = makeEngine(repo);

    const newClosesAt = future();
    const result = await engine.reopenMarket("m1", newClosesAt);

    expect(result.status).toBe(MarketStatus.OPEN);
    expect(result.closesAt).toBe(newClosesAt);
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it("clears stale proposal state on reopen", async () => {
    const market = makeMarket({
      // Simulate leftover fields from an aborted flow — status still CLOSED
      // but proposal columns dirty. proposedOutcomeId set → rejected, so test
      // only the deadline here.
      disputeDeadlineAt: new Date(),
    });
    const repo = makeMarketRepo(market);
    const engine = makeEngine(repo);

    const result = await engine.reopenMarket("m1", future());
    expect(result.proposedOutcomeId).toBeNull();
    expect(result.disputeDeadlineAt).toBeNull();
  });

  it("rejects non-World-Cup markets (subcategory not wc-*)", async () => {
    const repo = makeMarketRepo(makeMarket({ subcategory: "bpl-match" }));
    const engine = makeEngine(repo);

    await expect(engine.reopenMarket("m1", future())).rejects.toThrow(
      /Only World Cup hub markets/,
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it("rejects markets with no subcategory", async () => {
    const repo = makeMarketRepo(makeMarket({ subcategory: null }));
    const engine = makeEngine(repo);

    await expect(engine.reopenMarket("m1", future())).rejects.toThrow(
      BadRequestException,
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it.each([
    MarketStatus.UPCOMING,
    MarketStatus.OPEN,
    MarketStatus.RESOLVING,
    MarketStatus.RESOLVED,
    MarketStatus.SETTLED,
    MarketStatus.CANCELLED,
  ])("rejects reopen from %s status", async (status) => {
    const repo = makeMarketRepo(makeMarket({ status }));
    const engine = makeEngine(repo);

    await expect(engine.reopenMarket("m1", future())).rejects.toThrow(
      /Only a Closed market can be reopened/,
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it("rejects reopen when a resolution has been proposed", async () => {
    const repo = makeMarketRepo(makeMarket({ proposedOutcomeId: "o1" }));
    const engine = makeEngine(repo);

    await expect(engine.reopenMarket("m1", future())).rejects.toThrow(
      /proposed resolution/,
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it("rejects a past closesAt (keeper would immediately re-close)", async () => {
    const repo = makeMarketRepo(makeMarket());
    const engine = makeEngine(repo);

    await expect(
      engine.reopenMarket("m1", new Date(Date.now() - 1000)),
    ).rejects.toThrow(/must be in the future/);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it("rejects an invalid date", async () => {
    const repo = makeMarketRepo(makeMarket());
    const engine = makeEngine(repo);

    await expect(
      engine.reopenMarket("m1", new Date("not-a-date")),
    ).rejects.toThrow(/valid date/);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it("rejects an unknown market", async () => {
    const repo = {
      findOneBy: jest.fn(async () => null),
      save: jest.fn(),
    };
    const engine = makeEngine(repo);

    await expect(engine.reopenMarket("nope", future())).rejects.toThrow(
      /Market not found/,
    );
    expect(repo.save).not.toHaveBeenCalled();
  });
});
