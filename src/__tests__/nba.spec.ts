import { readFileSync } from "fs";
import { join } from "path";
import {
  ESPN_NBA_SOURCE,
  NbaGame,
  bhutanDate,
  espnDatesFor,
  nbaFinalResult,
  parseEspnGame,
} from "../nba/espn-nba.util";
import {
  NBA_MATCH_SUBCATEGORY,
  buildNbaMatchMarketDto,
  nbaWinnerOutcome,
  wantsNbaMarket,
} from "../nba/nba-markets";
import { NbaService, dayCacheTtlSec, parseStandings } from "../nba/nba.service";
import { NBA_FINAL_STABLE_MS, NbaJobsService } from "../nba/nba-jobs.service";
import { KeeperService } from "../markets/keeper.service";
import { MarketStatus } from "../entities/market.entity";
import { isFeedProposed } from "../markets/settlement-sources.util";
import { isCompetitionSubcategory } from "../markets/market-notify.util";

// Trimmed real ESPN responses; see the file's _note for what and when.
const fx = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "espn-nba.json"), "utf8"),
);
const scheduled = () =>
  fx.scheduled.map((e: any) => parseEspnGame(e)!) as NbaGame[];
const overtime = () => parseEspnGame(fx.overtime)!;
const summaryGame = () =>
  parseEspnGame(
    { ...fx.summary.header, date: fx.summary.header.competitions[0].date },
    true,
  )!;

/** Point global fetch at canned ESPN bodies, keyed by a URL substring. */
function mockEspn(routes: Record<string, any>) {
  global.fetch = jest.fn(async (url: string) => {
    const hit = Object.keys(routes).find((k) => String(url).includes(k));
    if (!hit || routes[hit] === null)
      return { ok: false, status: 503, json: async () => null };
    return { ok: true, status: 200, json: async () => routes[hit] };
  }) as any;
}

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    setEx: jest.fn(
      async (k: string, _t: number, v: string) => void store.set(k, v),
    ),
    acquireLock: jest.fn(async () => "tok"),
    releaseLock: jest.fn(async () => undefined),
  };
}

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  jest.restoreAllMocks();
});

describe("reading ESPN games", () => {
  it("parses a scheduled game: teams, tip-off, season type", () => {
    const [g] = scheduled();
    expect(g.home.name).toBe("Philadelphia 76ers");
    expect(g.away.abbr).toBe("CLE");
    expect(g.tipoff).toBe("2026-10-22T23:00:00.000Z");
    expect(g.seasonType).toBe(2);
    expect(g.state).toBe("pre");
    expect(g.home.score).toBe(0); // ESPN sends "0" before tip-off
    expect(nbaFinalResult(g)).toBeNull();
  });

  it("reads an overtime final as final, and an away win as away", () => {
    const g = overtime();
    expect(g.statusDetail).toBe("Final/OT");
    expect(nbaFinalResult(g)).toEqual({ winner: "away", home: 134, away: 137 });
  });

  it("reads a summary header the same way as a scoreboard event", () => {
    const g = summaryGame();
    expect(g.id).toBe("401869369");
    expect(g.tipoff).toBe("2026-04-20T23:00:00.000Z");
    expect(nbaFinalResult(g)).toEqual({ winner: "home", home: 115, away: 105 });
  });

  it("refuses to call a result from a half-written record", () => {
    const g = summaryGame();
    const variants: [string, Partial<NbaGame>][] = [
      ["not completed", { completed: false }],
      ["still in progress", { state: "in" }],
      ["postponed", { statusName: "STATUS_POSTPONED" }],
    ];
    for (const [, patch] of variants)
      expect(nbaFinalResult({ ...g, ...patch })).toBeNull();
    expect(
      nbaFinalResult({ ...g, home: { ...g.home, score: null } }),
    ).toBeNull();
    expect(
      nbaFinalResult({ ...g, home: { ...g.home, score: 105 } }),
    ).toBeNull(); // tie
    expect(
      nbaFinalResult({ ...g, away: { ...g.away, winner: true } }),
    ).toBeNull(); // two winners
    expect(
      nbaFinalResult({ ...g, home: { ...g.home, winner: false } }),
    ).toBeNull(); // no winner
    // Flag says away, score says home.
    expect(
      nbaFinalResult({
        ...g,
        home: { ...g.home, winner: false },
        away: { ...g.away, winner: true },
      }),
    ).toBeNull();
  });

  it("maps Bhutan dates to the ESPN days that can hold them", () => {
    // 7 PM US Eastern on 22 Oct is 5 AM on 23 Oct in Bhutan.
    expect(bhutanDate("2026-10-22T23:00:00Z")).toBe("2026-10-23");
    expect(espnDatesFor("2026-10-23", 2)).toEqual([
      "20261022",
      "20261023",
      "20261024",
    ]);
  });
});

describe("standings", () => {
  it("parses both conferences and orders by seed, not ESPN's order", () => {
    const st = parseStandings(fx.standings, 2026)!;
    expect(st.conferences.map((c) => c.name)).toEqual([
      "Eastern Conference",
      "Western Conference",
    ]);
    const east = st.conferences[0].table;
    expect(east.map((r) => r.seed)).toEqual(
      [...east.map((r) => r.seed)].sort((a, b) => a - b),
    );
    expect(east[0]).toMatchObject({ seed: 1, abbr: "DET" });
    expect(typeof east[0].w).toBe("number");
    expect(east[0].pct).toMatch(/^\.?\d/);
  });

  it("returns null for an empty or broken response", () => {
    expect(parseStandings(null, 2027)).toBeNull();
    expect(parseStandings({ children: [] }, 2027)).toBeNull();
  });
});

describe("cache lifetime of one ESPN day", () => {
  const now = Date.parse("2026-10-22T12:00:00Z");
  const g = (state: string, tipoff = "2026-10-23T00:00:00Z") =>
    ({ state, tipoff }) as NbaGame;
  it("is short while a game is live or about to start", () => {
    expect(dayCacheTtlSec([g("in")], now)).toBe(60);
    expect(dayCacheTtlSec([g("pre", "2026-10-22T12:30:00Z")], now)).toBe(60);
  });
  it("is long once every game is final, medium otherwise", () => {
    expect(dayCacheTtlSec([g("post"), g("post")], now)).toBe(6 * 3600);
    expect(dayCacheTtlSec([g("pre")], now)).toBe(15 * 60);
  });
});

describe("NbaService.getGames", () => {
  it("merges ESPN days, keeps only the asked Bhutan dates, and caches", async () => {
    mockEspn({
      "dates=20261022": { events: fx.scheduled },
      "dates=": { events: [] },
    });
    const redis = fakeRedis();
    const svc = new NbaService({ get: () => undefined } as any, redis as any);
    const games = await svc.getGames("2026-10-23", 1);
    expect(games.map((x) => x.id)).toEqual(fx.scheduled.map((e: any) => e.id));
    expect(redis.store.has("oro:nba:day:20261022")).toBe(true);
    // Asking for the 22nd (Bhutan) excludes these 23rd-Bhutan games.
    expect(await svc.getGames("2026-10-22", 1)).toEqual([]);
  });

  it("returns an empty list when ESPN is down, and caches nothing", async () => {
    mockEspn({});
    const redis = fakeRedis();
    const svc = new NbaService({ get: () => undefined } as any, redis as any);
    expect(await svc.getGames("2026-10-23", 1)).toEqual([]);
    expect(redis.store.size).toBe(0);
  });
});

describe("NBA market shape", () => {
  it("is home vs away, two outcomes, closes at tip-off, never uses externalMatchId", () => {
    const [g] = scheduled();
    const dto = buildNbaMatchMarketDto(g, new Date("2026-10-20T00:00:00Z"));
    expect(dto.title).toBe("Philadelphia 76ers vs Cleveland Cavaliers");
    expect(dto.subcategory).toBe(NBA_MATCH_SUBCATEGORY);
    expect(dto.externalSource).toBe(ESPN_NBA_SOURCE);
    expect(dto.externalMatchId).toBeUndefined();
    expect(dto.espnGameId).toBe(g.id);
    expect(dto.closesAt).toBe(g.tipoff);
    expect(dto.outcomes.map((o) => o.label)).toEqual([
      "Philadelphia 76ers",
      "Cleveland Cavaliers",
    ]);
    expect(dto.outcomes.some((o) => /draw/i.test(o.label))).toBe(false);
  });

  it("only wants markets for counted games that have not started", () => {
    const [g] = scheduled();
    const before = Date.parse("2026-10-20T00:00:00Z");
    expect(wantsNbaMarket(g, before)).toBe(true);
    expect(wantsNbaMarket({ ...g, seasonType: 1 }, before)).toBe(false); // preseason
    expect(wantsNbaMarket(g, Date.parse(g.tipoff) + 1)).toBe(false);
    expect(
      wantsNbaMarket({ ...g, statusName: "STATUS_POSTPONED" }, before),
    ).toBe(false);
  });

  it("picks the winner by exact team name and never guesses", () => {
    const g = summaryGame();
    const outcomes = [
      { id: "home", label: "Cleveland Cavaliers" },
      { id: "away", label: "Toronto Raptors" },
    ];
    expect(nbaWinnerOutcome(outcomes, g)?.id).toBe("home");
    expect(
      nbaWinnerOutcome([{ id: "x", label: "Cavs" }, outcomes[1]], g),
    ).toBeNull();
    expect(nbaWinnerOutcome(outcomes, { ...g, completed: false })).toBeNull();
  });

  it("is kept off the channel and out of the admin's close-time DMs", () => {
    expect(isCompetitionSubcategory("nba-match")).toBe(true);
    expect(isFeedProposed("espn-nba")).toBe(true);
    expect(isFeedProposed("football-data.org")).toBe(false);
  });
});

describe("NbaJobsService", () => {
  function make(
    opts: {
      flag?: string;
      active?: boolean;
      games?: NbaGame[];
      existing?: any[];
      closed?: any[];
    } = {},
  ) {
    const redis = fakeRedis();
    const qb: any = {
      select: () => qb,
      where: () => qb,
      andWhere: () => qb,
      getMany: jest.fn(async () => opts.existing ?? []),
    };
    const marketRepo = {
      createQueryBuilder: jest.fn(() => qb),
      update: jest.fn(async () => undefined),
      find: jest.fn(async () => opts.closed ?? []),
    };
    const marketsService = {
      create: jest.fn(async () => ({ id: "new" })),
      proposeResolution: jest.fn(async () => ({})),
    };
    const telegram = { sendMessage: jest.fn(async () => undefined) };
    const env: Record<string, string> = {
      NBA_AUTO_MARKETS: opts.flag ?? "on",
      ADMIN_TELEGRAM_ID: "42",
    };
    const config = { get: (k: string) => env[k] };
    const nba = { getGames: jest.fn(async () => opts.games ?? scheduled()) };
    const keeper = { getStatus: () => ({ isActive: opts.active ?? true }) };
    const svc = new NbaJobsService(
      nba as any,
      marketsService as any,
      keeper as any,
      telegram as any,
      config as any,
      redis as any,
      marketRepo as any,
    );
    return { svc, redis, marketRepo, marketsService, telegram, nba };
  }
  const now = new Date("2026-10-20T00:00:00Z");

  it("does nothing while NBA_AUTO_MARKETS is off or the keeper is paused", async () => {
    for (const o of [{ flag: "off" }, { active: false }]) {
      const { svc, nba } = make(o);
      await svc.handleCreateMarkets();
      await svc.handleProposeResults();
      expect(nba.getGames).not.toHaveBeenCalled();
    }
  });

  it("creates one market per new game and skips games that already have one", async () => {
    const games = scheduled();
    const { svc, marketsService } = make({
      existing: [
        {
          id: "m1",
          status: MarketStatus.CANCELLED, // an admin cancel is not undone
          closesAt: new Date(games[0].tipoff),
          metadata: { espnGameId: games[0].id },
        },
      ],
    });
    const r = await svc.runCreateMarkets(now);
    expect(r.created).toBe(games.length - 1);
    expect(marketsService.create).toHaveBeenCalledTimes(games.length - 1);
    const dto = (marketsService.create.mock.calls[0] as any[])[0];
    expect(dto.espnGameId).toBe(games[1].id);
  });

  it("skips preseason games", async () => {
    const { svc, marketsService } = make({
      games: scheduled().map((g) => ({ ...g, seasonType: 1 })),
    });
    await svc.runCreateMarkets(now);
    expect(marketsService.create).not.toHaveBeenCalled();
  });

  it("moves an open market's close time when tip-off moves", async () => {
    const [g] = scheduled();
    const { svc, marketRepo, marketsService } = make({
      games: [g],
      existing: [
        {
          id: "m1",
          status: MarketStatus.OPEN,
          closesAt: new Date(Date.parse(g.tipoff) - 3600_000),
          metadata: { espnGameId: g.id },
        },
      ],
    });
    const r = await svc.runCreateMarkets(now);
    expect(r).toEqual({ created: 0, moved: 1 });
    expect(marketRepo.update).toHaveBeenCalledWith("m1", {
      closesAt: new Date(g.tipoff),
    });
    expect(marketsService.create).not.toHaveBeenCalled();
  });

  const closedMarket = (extra: any = {}) => ({
    id: "m9",
    title: "Cleveland Cavaliers vs Toronto Raptors",
    status: MarketStatus.CLOSED,
    externalSource: ESPN_NBA_SOURCE,
    proposedOutcomeId: null,
    metadata: { espnGameId: "401869369" },
    outcomes: [
      { id: "o-cle", label: "Cleveland Cavaliers" },
      { id: "o-tor", label: "Toronto Raptors" },
    ],
    ...extra,
  });

  it("proposes only after the same final is read twice 30 minutes apart", async () => {
    mockEspn({ "summary?event=401869369": fx.summary });
    const { svc, marketsService } = make({ closed: [closedMarket()] });
    const t0 = Date.parse("2026-04-21T03:00:00Z");
    expect(await svc.runProposeResults(t0)).toBe(0); // first sighting
    expect(await svc.runProposeResults(t0 + 10 * 60_000)).toBe(0); // too soon
    expect(await svc.runProposeResults(t0 + NBA_FINAL_STABLE_MS)).toBe(1);
    expect(marketsService.proposeResolution).toHaveBeenCalledWith(
      "m9",
      "o-cle",
    );
  });

  it("restarts the clock when the final changes", async () => {
    const changed = JSON.parse(JSON.stringify(fx.summary));
    mockEspn({ "summary?event=401869369": fx.summary });
    const { svc, marketsService } = make({ closed: [closedMarket()] });
    const t0 = Date.parse("2026-04-21T03:00:00Z");
    await svc.runProposeResults(t0);
    changed.header.competitions[0].competitors.find(
      (c: any) => c.homeAway === "home",
    ).score = "116";
    mockEspn({ "summary?event=401869369": changed });
    expect(await svc.runProposeResults(t0 + NBA_FINAL_STABLE_MS)).toBe(0);
    expect(await svc.runProposeResults(t0 + 2 * NBA_FINAL_STABLE_MS)).toBe(1);
    expect(marketsService.proposeResolution).toHaveBeenCalledTimes(1);
  });

  it("asks a human, once, when no outcome names the winner", async () => {
    mockEspn({ "summary?event=401869369": fx.summary });
    const { svc, marketsService, telegram } = make({
      closed: [
        closedMarket({
          outcomes: [
            { id: "a", label: "Cavs" },
            { id: "b", label: "Raptors" },
          ],
        }),
      ],
    });
    const t0 = Date.parse("2026-04-21T03:00:00Z");
    await svc.runProposeResults(t0);
    await svc.runProposeResults(t0 + NBA_FINAL_STABLE_MS);
    await svc.runProposeResults(t0 + 2 * NBA_FINAL_STABLE_MS);
    expect(marketsService.proposeResolution).not.toHaveBeenCalled();
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("alerts once and proposes nothing for a postponed game", async () => {
    const pp = JSON.parse(JSON.stringify(fx.summary));
    Object.assign(pp.header.competitions[0].status.type, {
      name: "STATUS_POSTPONED",
      state: "post",
      completed: false,
    });
    mockEspn({ "summary?event=401869369": pp });
    const { svc, marketsService, telegram } = make({
      closed: [closedMarket()],
    });
    await svc.runProposeResults();
    await svc.runProposeResults();
    expect(marketsService.proposeResolution).not.toHaveBeenCalled();
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("waits quietly while ESPN is unreachable", async () => {
    mockEspn({});
    const { svc, marketsService, telegram } = make({
      closed: [closedMarket()],
    });
    expect(await svc.runProposeResults()).toBe(0);
    expect(marketsService.proposeResolution).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });
});

describe("keeper pre-payout re-check for NBA", () => {
  function keeper() {
    const marketRepo = { findOne: jest.fn() };
    const svc = new KeeperService(
      {} as any,
      {} as any,
      { get: () => undefined } as any,
      {} as any,
      marketRepo as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return svc as any;
  }
  const market = (proposedOutcomeId: string) => ({
    id: "m9",
    externalSource: ESPN_NBA_SOURCE,
    proposedOutcomeId,
    metadata: { espnGameId: "401869369" },
    outcomes: [
      { id: "o-cle", label: "Cleveland Cavaliers" },
      { id: "o-tor", label: "Toronto Raptors" },
    ],
  });

  it("agrees when ESPN still has the proposed team winning", async () => {
    mockEspn({ "summary?event=401869369": fx.summary });
    const r = await keeper().recheckProposal(market("o-cle"));
    expect(r.verdict).toBe("agrees");
  });

  it("blocks the payout when ESPN now has the other team winning", async () => {
    mockEspn({ "summary?event=401869369": fx.summary });
    const r = await keeper().recheckProposal(market("o-tor"));
    expect(r.verdict).toBe("disagrees");
  });

  it("is unverified, not blocking, when ESPN is unreachable", async () => {
    mockEspn({});
    const r = await keeper().recheckProposal(market("o-cle"));
    expect(r.verdict).toBe("unverified");
  });
});
