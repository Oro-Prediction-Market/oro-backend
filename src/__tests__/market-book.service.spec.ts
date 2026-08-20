import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { MarketBookService } from "../markets/market-book.service";
import { MarketStatus } from "../entities/market.entity";

const MARKET = {
  id: "m1",
  status: MarketStatus.OPEN,
  externalSource: null,
  outcomes: [{ id: "o1" }, { id: "o2" }],
};

function build(opts: { market?: any; existing?: any; positions?: number } = {}) {
  const saved: any[] = [];
  const updates: any[] = [];
  const em: any = {
    create: jest.fn().mockImplementation((_e: any, d: any) => ({ id: "bk1", ...d })),
    save: jest.fn().mockImplementation((_e: any, d: any) => {
      saved.push(d);
      return Promise.resolve(d);
    }),
    query: jest.fn().mockResolvedValue([]),
    find: jest.fn().mockResolvedValue(
      (opts.market ?? MARKET).outcomes.map((o: any) => ({
        outcomeId: o.id,
        currency: "USDT",
      })),
    ),
  };
  const bookRepo: any = {
    findOneBy: jest.fn().mockResolvedValue(opts.existing ?? null),
    find: jest.fn().mockResolvedValue(opts.existing ? [opts.existing] : []),
    update: jest.fn().mockImplementation((where: any, patch: any) => {
      updates.push({ where, patch });
      return Promise.resolve(undefined);
    }),
  };
  const marketRepo: any = {
    findOne: jest.fn().mockResolvedValue(
      opts.market === undefined ? MARKET : opts.market,
    ),
  };
  const positionRepo: any = {
    count: jest.fn().mockResolvedValue(opts.positions ?? 0),
  };
  const ds: any = { transaction: (cb: Function) => cb(em) };
  return {
    service: new MarketBookService(bookRepo, marketRepo, positionRepo, ds),
    saved,
    updates,
    bookRepo,
    em,
  };
}

const TERMS = { currency: "USDT", houseEdgePct: 8, minStake: 1 };

describe("MarketBookService.openBook", () => {
  it("opens a USDT book with the terms an admin chose", async () => {
    // Not derivable from the market: the cut and the minimum are decisions.
    const { service, saved } = build();
    const book = await service.openBook("m1", TERMS);

    expect(book.currency).toBe("USDT");
    expect(book.houseEdgePct).toBe("8");
    expect(book.minStake).toBe("1");
    expect(saved[0].totalPool).toBe(0);
    expect(saved[0].isEnabled).toBe(true);
  });

  it("creates one outcome row per outcome, in the same transaction", async () => {
    // A book without them cannot compute odds, and settlement would divide by
    // a winning-side total that is not there. Both must land with the book or
    // neither should.
    const { service, em } = build();
    await service.openBook("m1", TERMS);

    const upserts = em.query.mock.calls.filter(([sql]: any[]) =>
      /INSERT INTO "outcome_books"/.test(sql),
    );
    expect(upserts).toHaveLength(MARKET.outcomes.length);
    // Each names an outcome of this market and the book's currency.
    const outcomeIds = upserts.map(([, params]: any[]) => params[0]).sort();
    expect(outcomeIds).toEqual(["o1", "o2"]);
    expect(upserts.every(([, p]: any[]) => p[1] === "USDT")).toBe(true);
  });

  it("refuses a second book in the same currency", async () => {
    const { service } = build({ existing: { id: "bk1", currency: "USDT" } });
    await expect(service.openBook("m1", TERMS)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("refuses an unsupported currency", async () => {
    const { service } = build();
    for (const currency of ["EUR", "TON", ""]) {
      await expect(
        service.openBook("m1", { ...TERMS, currency }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it("refuses a market that has already resolved", async () => {
    // The pool would have nothing to stake into and settlement has passed it.
    for (const status of [MarketStatus.SETTLED, MarketStatus.RESOLVED]) {
      const { service } = build({ market: { ...MARKET, status } });
      await expect(service.openBook("m1", TERMS)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
  });

  it("refuses a market with no outcomes", async () => {
    const { service } = build({ market: { ...MARKET, outcomes: [] } });
    await expect(service.openBook("m1", TERMS)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("404s on an unknown market", async () => {
    const { service } = build({ market: null });
    await expect(service.openBook("nope", TERMS)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("validates the terms", async () => {
    const { service } = build();
    const bad = [
      { houseEdgePct: -1, minStake: 1 },
      { houseEdgePct: 80, minStake: 1 },
      { houseEdgePct: 8, minStake: 0 },
      { houseEdgePct: 8, minStake: -5 },
    ];
    for (const t of bad) {
      await expect(
        service.openBook("m1", { currency: "USDT", ...t }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});

describe("MarketBookService.updateTerms", () => {
  const book = {
    id: "bk1",
    marketId: "m1",
    currency: "USDT",
    houseEdgePct: 8,
    minStake: 1,
    totalPool: 0,
    status: "open",
    isEnabled: true,
  };

  it("changes terms while the book is untouched", async () => {
    const { service, updates } = build({ existing: book, positions: 0 });
    await service.updateTerms("bk1", { houseEdgePct: 6 });
    expect(updates[0].patch.houseEdgePct).toBe(6);
  });

  it("refuses once anyone has staked", async () => {
    // Somebody who bet at an 8% cut agreed to an 8% cut. Moving it afterwards
    // changes the payout they were quoted.
    const { service, updates } = build({ existing: book, positions: 3 });
    await expect(
      service.updateTerms("bk1", { houseEdgePct: 2 }),
    ).rejects.toThrow(/already has stakes/);
    expect(updates).toHaveLength(0);
  });
});

describe("MarketBookService.setEnabled", () => {
  const book = {
    id: "bk1",
    marketId: "m1",
    currency: "USDT",
    houseEdgePct: 8,
    minStake: 1,
    totalPool: 100,
    status: "open",
    isEnabled: true,
  };

  it("closes a book to new stakes without touching the pool", async () => {
    // Allowed even with stakes present: if a chain goes down mid-market you
    // want to stop new money without disturbing what is already in.
    const { service, updates } = build({ existing: book, positions: 5 });
    await service.setEnabled("bk1", false);
    expect(updates[0].patch.isEnabled).toBe(false);
  });

  it("404s on an unknown book", async () => {
    const { service } = build({ existing: null });
    await expect(service.setEnabled("nope", false)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
