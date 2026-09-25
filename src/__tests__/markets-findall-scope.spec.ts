/**
 * markets-findall-scope.spec.ts
 *
 * `findAll` serves every market list in both apps. Measured before the "live"
 * scope existed: 10.8MB and 4,474 markets, of which 23 were actually running —
 * a finished market is never deleted, so the list grows forever while the part
 * anyone renders stays roughly constant. On mobile data that payload was the
 * load time of every hub and feed.
 *
 * Two properties matter enough to pin down:
 *
 *   1. "live" excludes RESOLVED and SETTLED. If someone widens this list back,
 *      the payload silently returns to its old size and nothing else fails.
 *   2. The default still returns finished markets. Roughly 29 callers rely on
 *      it — "Previous" tabs, history, search — and quietly truncating them
 *      would make settled markets vanish from screens that must show them.
 */

import { MarketsService } from "../markets/markets.service";
import { LMSRService } from "../markets/lmsr.service";
import { MarketStatus } from "../entities/market.entity";

function makeService() {
  // Records what findAll asked the database for.
  const captured: { statuses?: MarketStatus[] } = {};

  // Annotated because `where` returns `qb` from inside its own initializer.
  const qb: any = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn((_sql: string, params: { activeStatuses: MarketStatus[] }) => {
      captured.statuses = params.activeStatuses;
      return qb;
    }),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
  };

  const redis = {
    getJson: jest.fn().mockResolvedValue(null), // always a cache miss
    setJsonEx: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
  };

  const svc = new MarketsService(
    { createQueryBuilder: jest.fn().mockReturnValue(qb) } as any,
    null as any, // outcomeRepo
    null as any, // disputeRepo
    null as any, // userRepo
    { find: jest.fn().mockResolvedValue([]) } as any, // marketBookRepo
    { find: jest.fn().mockResolvedValue([]) } as any, // outcomeBookRepo
    null as any, // engine
    new LMSRService(),
    null as any, // dataSource
    redis as any,
    {} as any, // reputationService — unused, no markets come back
    { postToChannel: jest.fn() } as any,
  );

  return { svc, captured, redis };
}

describe("MarketsService.findAll — scope", () => {
  it('omits resolved and settled markets when scope is "live"', async () => {
    const { svc, captured } = makeService();
    await svc.findAll(undefined, "live");

    expect(captured.statuses).toEqual([
      MarketStatus.UPCOMING,
      MarketStatus.OPEN,
      MarketStatus.CLOSED,
      MarketStatus.RESOLVING,
    ]);
    // The whole point: these are ~99% of the table.
    expect(captured.statuses).not.toContain(MarketStatus.RESOLVED);
    expect(captured.statuses).not.toContain(MarketStatus.SETTLED);
  });

  it("still returns finished markets by default", async () => {
    // The existing callers were never migrated wholesale — a default that
    // dropped these would empty every "Previous" tab at once.
    const { svc, captured } = makeService();
    await svc.findAll();

    expect(captured.statuses).toContain(MarketStatus.RESOLVED);
    expect(captured.statuses).toContain(MarketStatus.SETTLED);
    expect(captured.statuses).toContain(MarketStatus.OPEN);
  });

  it("caches the two scopes under different keys", async () => {
    // Sharing a key would serve the trimmed list to a caller that needs
    // history, or the 10MB one to a caller that asked to avoid it.
    const a = makeService();
    await a.svc.findAll();
    const b = makeService();
    await b.svc.findAll(undefined, "live");

    const keyOf = (s: ReturnType<typeof makeService>) =>
      s.redis.setJsonEx.mock.calls[0][0];
    expect(keyOf(a)).not.toEqual(keyOf(b));
    expect(keyOf(b)).toContain("live");
  });

  it("keeps the search term and the scope independent", async () => {
    const plain = makeService();
    await plain.svc.findAll("cup");
    const live = makeService();
    await live.svc.findAll("cup", "live");

    expect(plain.redis.setJsonEx.mock.calls[0][0]).not.toEqual(
      live.redis.setJsonEx.mock.calls[0][0],
    );
    expect(live.captured.statuses).not.toContain(MarketStatus.SETTLED);
  });
});
