import { UnlService } from "../unl/unl.service";
import { UnlFixtureStatus } from "../entities/unl-fixture.entity";
import { MarketStatus } from "../entities/market.entity";

/**
 * The Nations League settlement path.
 *
 * This competition has no provider, so there is nothing to check an admin's
 * typing against — which makes these the only guards between a typed score and
 * a payout. Three properties matter, and each has tests below:
 *
 *  1. **A missing score is missing, not nil-nil.** The September bug that
 *     settled Nottingham Forest v Coventry as a draw, kept out of this path.
 *  2. **The winner is chosen by outcome ID, never by name.** This competition
 *     fields Republic of Ireland AND Northern Ireland; the keeper's generic
 *     `resolveOutcome` falls back to two-directional substring matching, which
 *     would pick the wrong nation with complete confidence.
 *  3. **Entering a score does not propose anything.** That separation is what
 *     makes a typo free to fix.
 */

const FIXTURE = {
  id: "f1",
  season: "2026-27",
  groupKey: "I",
  homeTeamId: "t-roi",
  awayTeamId: "t-nir",
  kickoffAt: new Date("2026-10-09T18:45:00Z"),
  homeScore: null as number | null,
  awayScore: null as number | null,
  status: UnlFixtureStatus.SCHEDULED,
  marketId: "m1" as string | null,
  homeOutcomeId: "o-home" as string | null,
  drawOutcomeId: "o-draw" as string | null,
  awayOutcomeId: "o-away" as string | null,
  matchday: 3,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MARKET = {
  id: "m1",
  title: "Republic of Ireland vs Northern Ireland",
  status: MarketStatus.CLOSED,
  proposedOutcomeId: null as string | null,
  resolvedOutcomeId: null as string | null,
  totalPool: 0,
  outcomes: [
    { id: "o-home", label: "Republic of Ireland", sortOrder: 0 },
    { id: "o-draw", label: "Draw", sortOrder: 1 },
    { id: "o-away", label: "Northern Ireland", sortOrder: 2 },
  ],
};

function build(
  fixture: Partial<typeof FIXTURE> = {},
  market: Partial<typeof MARKET> | null = {},
) {
  const f = { ...FIXTURE, ...fixture };
  const m = market === null ? null : { ...MARKET, ...market };

  const fixtureRepo = {
    findOne: jest.fn().mockResolvedValue(f),
    save: jest.fn(async (x) => x),
    find: jest.fn().mockResolvedValue([f]),
    count: jest.fn().mockResolvedValue(0),
    delete: jest.fn().mockResolvedValue(undefined),
    create: jest.fn((x) => x),
    createQueryBuilder: jest.fn(),
  };
  // The two nations resolve separately, because the point of this fixture is
  // that their names overlap: "Northern Ireland" contains "Ireland", and
  // "Republic of Ireland" contains it too. A mock returning one team for both
  // would hide exactly the bug these tests exist to rule out.
  const TEAMS: Record<string, unknown> = {
    "t-roi": {
      id: "t-roi",
      name: "Republic of Ireland",
      groupKey: "I",
      season: "2026-27",
      flagUrl: null,
    },
    "t-nir": {
      id: "t-nir",
      name: "Northern Ireland",
      groupKey: "I",
      season: "2026-27",
      flagUrl: null,
    },
  };
  const teamRepo = {
    findOne: jest.fn(async (opts: any) => TEAMS[opts?.where?.id] ?? null),
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn(async (x) => x),
    create: jest.fn((x) => x),
    count: jest.fn().mockResolvedValue(0),
    createQueryBuilder: jest.fn(),
  };
  const qb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(null),
    getMany: jest.fn().mockResolvedValue([]),
  };
  const marketRepo = {
    findOne: jest.fn().mockResolvedValue(m),
    find: jest.fn().mockResolvedValue([]),
    createQueryBuilder: jest.fn(() => qb),
  };
  const marketsService = {
    create: jest.fn().mockResolvedValue(MARKET),
    update: jest.fn().mockResolvedValue(undefined),
    proposeResolution: jest.fn().mockResolvedValue(undefined),
  };
  const statOverrides = { list: jest.fn().mockResolvedValue([]), buildManualBoard: () => [] };
  const config = { get: jest.fn() };

  const svc = new UnlService(
    teamRepo as any,
    fixtureRepo as any,
    marketRepo as any,
    marketsService as any,
    statOverrides as any,
    config as any,
  );
  return { svc, fixtureRepo, teamRepo, marketRepo, marketsService, qb, fixture: f };
}

describe("UnlService — choosing the winner", () => {
  it("returns the stored ID, never a name", () => {
    const { svc } = build();
    // The three ids come off the fixture row. Nothing in this path reads a
    // label, which is the only reason "Republic of Ireland" and "Northern
    // Ireland" can safely be in the same market.
    expect(svc.outcomeIdForScore({ ...FIXTURE, homeScore: 2, awayScore: 1 } as any)).toBe("o-home");
    expect(svc.outcomeIdForScore({ ...FIXTURE, homeScore: 0, awayScore: 3 } as any)).toBe("o-away");
    expect(svc.outcomeIdForScore({ ...FIXTURE, homeScore: 1, awayScore: 1 } as any)).toBe("o-draw");
  });

  it("counts a real nil-nil as a draw", () => {
    const { svc } = build();
    expect(svc.outcomeIdForScore({ ...FIXTURE, homeScore: 0, awayScore: 0 } as any)).toBe("o-draw");
  });

  it("returns nothing at all when a score is missing", () => {
    const { svc } = build();
    // THE September bug. A `?? 0` here would make both of these a draw.
    expect(svc.outcomeIdForScore({ ...FIXTURE, homeScore: null, awayScore: null } as any)).toBeNull();
    expect(svc.outcomeIdForScore({ ...FIXTURE, homeScore: 2, awayScore: null } as any)).toBeNull();
    expect(svc.outcomeIdForScore({ ...FIXTURE, homeScore: null, awayScore: 2 } as any)).toBeNull();
  });
});

describe("UnlService.setScore", () => {
  it("never proposes, however complete the score is", async () => {
    const { svc, marketsService } = build();
    await svc.setScore("f1", { homeScore: 3, awayScore: 0 });
    // The whole reason a typo is free to fix.
    expect(marketsService.proposeResolution).not.toHaveBeenCalled();
    expect(marketsService.create).not.toHaveBeenCalled();
  });

  it("refuses a half-entered scoreline", async () => {
    const { svc } = build();
    await expect(svc.setScore("f1", { homeScore: 2, awayScore: null })).rejects.toThrow(
      /both scores or neither/i,
    );
  });

  it("stores a real nil-nil rather than treating it as blank", async () => {
    const { svc, fixtureRepo } = build();
    await svc.setScore("f1", { homeScore: 0, awayScore: 0 });
    const saved = fixtureRepo.save.mock.calls[0][0];
    expect(saved.homeScore).toBe(0);
    expect(saved.awayScore).toBe(0);
    expect(saved.status).toBe(UnlFixtureStatus.FINISHED);
  });

  it("refuses a score that is not a whole number", async () => {
    const { svc } = build();
    await expect(svc.setScore("f1", { homeScore: 1.5, awayScore: 0 })).rejects.toThrow();
    await expect(
      svc.setScore("f1", { homeScore: "2" as any, awayScore: 0 }),
    ).rejects.toThrow();
    await expect(svc.setScore("f1", { homeScore: -1, awayScore: 0 })).rejects.toThrow();
  });

  it("refuses to mark a fixture finished with no score", async () => {
    const { svc } = build();
    await expect(
      svc.setScore("f1", { homeScore: null, awayScore: null, status: "finished" }),
    ).rejects.toThrow(/needs a score/i);
  });

  it("clears the score for a postponed fixture", async () => {
    const { svc, fixtureRepo } = build({ homeScore: 1, awayScore: 0 });
    await svc.setScore("f1", { homeScore: null, awayScore: null, status: "postponed" });
    const saved = fixtureRepo.save.mock.calls[0][0];
    expect(saved.homeScore).toBeNull();
    expect(saved.awayScore).toBeNull();
  });

  describe("when the market has already settled", () => {
    it("warns when the corrected score disagrees with what was paid out", async () => {
      // Settled as the home win; the score now says away won.
      const { svc } = build(
        {},
        { status: MarketStatus.SETTLED, resolvedOutcomeId: "o-home" },
      );
      const { warning } = await svc.setScore("f1", { homeScore: 0, awayScore: 2 });
      expect(warning).toMatch(/Northern Ireland/);
      expect(warning).toMatch(/cannot be re-resolved/i);
    });

    it("stays quiet when the score still agrees", async () => {
      const { svc } = build(
        {},
        { status: MarketStatus.SETTLED, resolvedOutcomeId: "o-home" },
      );
      const { warning } = await svc.setScore("f1", { homeScore: 2, awayScore: 0 });
      expect(warning).toBeNull();
    });

    it("leaves the settled market completely alone either way", async () => {
      const { svc, marketsService } = build(
        {},
        { status: MarketStatus.SETTLED, resolvedOutcomeId: "o-home" },
      );
      await svc.setScore("f1", { homeScore: 0, awayScore: 2 });
      // SETTLED is terminal. Correcting it needs a human and direct SQL — the
      // one thing this must not do is pretend it fixed something.
      expect(marketsService.proposeResolution).not.toHaveBeenCalled();
      expect(marketsService.update).not.toHaveBeenCalled();
    });
  });
});

describe("UnlService.proposeFixtureResult", () => {
  it("proposes the stored outcome id for the score", async () => {
    const { svc, marketsService } = build({ homeScore: 0, awayScore: 2 });
    const res = await svc.proposeFixtureResult("f1", 60);

    expect(marketsService.proposeResolution).toHaveBeenCalledWith("m1", "o-away", 60);
    expect(res.outcomeId).toBe("o-away");
    expect(res.outcomeLabel).toBe("Northern Ireland");
  });

  it("refuses when no score has been entered", async () => {
    const { svc, marketsService } = build({ homeScore: null, awayScore: null });
    await expect(svc.proposeFixtureResult("f1")).rejects.toThrow(/score before proposing/i);
    expect(marketsService.proposeResolution).not.toHaveBeenCalled();
  });

  it("refuses when the fixture has no market", async () => {
    const { svc } = build({ marketId: null, homeScore: 1, awayScore: 0 });
    await expect(svc.proposeFixtureResult("f1")).rejects.toThrow(/no market/i);
  });

  it("refuses while betting is still open", async () => {
    const { svc, marketsService } = build(
      { homeScore: 1, awayScore: 0 },
      { status: MarketStatus.OPEN },
    );
    // proposeResolution would throw anyway; failing here gives the admin a
    // sentence they can act on instead of an engine error.
    await expect(svc.proposeFixtureResult("f1")).rejects.toThrow(/CLOSED/);
    expect(marketsService.proposeResolution).not.toHaveBeenCalled();
  });

  it("refuses when the stored outcome ids are missing", async () => {
    const { svc, marketsService } = build({
      homeScore: 1,
      awayScore: 0,
      homeOutcomeId: null,
      drawOutcomeId: null,
      awayOutcomeId: null,
    });
    // Without them the winner could only be found by name — the one thing
    // this design exists to avoid.
    await expect(svc.proposeFixtureResult("f1")).rejects.toThrow(/outcome ids/i);
    expect(marketsService.proposeResolution).not.toHaveBeenCalled();
  });
});

describe("UnlService.createMarketForFixture", () => {
  it("refuses a fixture that has already kicked off", async () => {
    const { svc, marketsService } = build({
      marketId: null,
      kickoffAt: new Date(Date.now() - 60_000),
    });
    await expect(svc.createMarketForFixture("f1")).rejects.toThrow(/already kicked off/i);
    expect(marketsService.create).not.toHaveBeenCalled();
  });

  it("re-links an orphaned market instead of building a second one", async () => {
    // The crash-in-between case: the market committed, the fixture row did
    // not get stamped. Building another would leave two markets on one match.
    const { svc, marketsService, qb, fixtureRepo } = build({
      marketId: null,
      kickoffAt: new Date(Date.now() + 86_400_000),
    });
    qb.getOne.mockResolvedValue(MARKET);

    await expect(svc.createMarketForFixture("f1")).rejects.toThrow(/already exists/i);
    expect(marketsService.create).not.toHaveBeenCalled();
    const saved = fixtureRepo.save.mock.calls[0][0];
    expect(saved.marketId).toBe("m1");
    expect(saved.homeOutcomeId).toBe("o-home");
    expect(saved.awayOutcomeId).toBe("o-away");
  });

  it("stamps all three outcome ids in home/draw/away order", async () => {
    const { svc, fixtureRepo } = build({
      marketId: null,
      kickoffAt: new Date(Date.now() + 86_400_000),
    });
    await svc.createMarketForFixture("f1");

    const saved = fixtureRepo.save.mock.calls[0][0];
    // Order matters: it is what makes the score comparison mean the right
    // thing without reading a single label.
    expect(saved.homeOutcomeId).toBe("o-home");
    expect(saved.drawOutcomeId).toBe("o-draw");
    expect(saved.awayOutcomeId).toBe("o-away");
  });

  it("creates the market with no externalMatchId", async () => {
    const { svc, marketsService } = build({
      marketId: null,
      kickoffAt: new Date(Date.now() + 86_400_000),
    });
    await svc.createMarketForFixture("f1");

    const dto = marketsService.create.mock.calls[0][0];
    // runAutoProposal selects on `externalMatchId IS NOT NULL`. An unset id is
    // what keeps these markets out of the football-data path entirely.
    expect(dto.externalMatchId).toBeUndefined();
    expect(dto.externalSource).toBe("unl-manual");
    expect(dto.unlFixtureId).toBe("f1");
    expect(dto.outcomes.map((o: any) => o.label)).toEqual([
      "Republic of Ireland",
      "Draw",
      "Northern Ireland",
    ]);
  });
});
