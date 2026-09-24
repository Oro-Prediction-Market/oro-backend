/**
 * Nations League — LOCAL fake data.
 *
 * Usage:
 *   npm run seed:unl            # seed (skips if teams already exist)
 *   npm run seed:unl -- --reset # wipe the fake UNL data first, then reseed
 *
 * The UEFA Nations League is not on our football-data.org plan
 * (`GET /v4/competitions/UNL` → 403), so there is no feed to point a dev
 * environment at. This script stands in for one: 54 nations across groups A–N,
 * a full six-matchday fixture list, results already entered for the September
 * window, and match markets for the October window.
 *
 * ── Why it cannot touch anything real ──────────────────────────────────────
 *
 * This writes invented results and creates markets people could bet on, so it
 * refuses to run anywhere but a local database (see `assertLocalOnly`), and
 * `--reset` refuses to delete a market that has positions against it. Neither
 * guard is a formality: the whole point of the file is to fabricate the data
 * that decides who wins.
 *
 * ── Things it deliberately does ────────────────────────────────────────────
 *
 * - **Leaves `externalMatchId` NULL.** `runAutoProposal` selects on
 *   `externalMatchId IS NOT NULL` (keeper.service.ts:1223), so a null here is
 *   what keeps these markets out of the football-data auto-proposal path
 *   entirely. They cannot be resolved against a real fixture that happens to
 *   share an id.
 * - **Creates markets in `open`/`closed`, never with a past `closesAt` while
 *   open.** The keeper closes any OPEN market whose `closesAt` has passed and
 *   DMs the admin a one-tap propose keyboard (keeper.service.ts:467). Seeding a
 *   market that is already overdue would fire that DM through whatever bot
 *   token `.env` holds, at whoever the admin chat is. The one closed market
 *   below is inserted already closed, which the keeper skips.
 * - **Scores are deterministic.** Seeded PRNG, so re-running produces the same
 *   tables. A group table that reshuffles on every seed looks like a standings
 *   bug when it is only the fixture data moving.
 * - **Leaves unplayed fixtures' scores NULL, never 0.** Same reason the
 *   standings code reads them strictly — see unl-standings.util.ts.
 */
import { DataSource } from "typeorm";
import * as dotenv from "dotenv";
import { randomUUID } from "crypto";
import { LMSRService } from "./markets/lmsr.service";
import { DEFAULT_HOUSE_EDGE_PCT } from "./markets/fee.constants";
import { Market, MarketStatus, MarketCategory, MarketMechanism } from "./entities/market.entity";
import { Outcome } from "./entities/outcome.entity";
import { Position } from "./entities/position.entity";
import { UnlTeam } from "./entities/unl-team.entity";
import { UnlFixture, UnlFixtureStatus } from "./entities/unl-fixture.entity";

dotenv.config();

const SEASON = "2026-27";
const RESET = process.argv.includes("--reset");

/**
 * Groups A–N of the 2026/27 edition, as a plausible draw.
 *
 * 54 teams, not 56: UEFA has 55 members and Russia is suspended, so the two
 * League D groups (M and N) have three teams rather than four. That is worth
 * keeping rather than padding — a three-team group is a real shape the
 * standings code has to handle, and it is the shape a four-team assumption
 * breaks on.
 *
 * Group I fields the **Republic of Ireland and Northern Ireland**, and group J
 * fields **North Macedonia**, on purpose. Those are the names that defeat the
 * keeper's substring team-matching fallback (keeper.service.ts:1620), so the
 * dev database should contain them from day one rather than the day it
 * mis-pays someone.
 */
const GROUPS: Record<string, [string, string][]> = {
  A: [["France", "fr"], ["Italy", "it"], ["Belgium", "be"], ["Türkiye", "tr"]],
  B: [["Spain", "es"], ["Netherlands", "nl"], ["Denmark", "dk"], ["Czechia", "cz"]],
  C: [["Portugal", "pt"], ["Croatia", "hr"], ["Poland", "pl"], ["Scotland", "gb-sct"]],
  D: [["Germany", "de"], ["England", "gb-eng"], ["Austria", "at"], ["Wales", "gb-wls"]],
  E: [["Switzerland", "ch"], ["Serbia", "rs"], ["Greece", "gr"], ["Israel", "il"]],
  F: [["Ukraine", "ua"], ["Norway", "no"], ["Slovenia", "si"], ["Iceland", "is"]],
  G: [["Hungary", "hu"], ["Sweden", "se"], ["Albania", "al"], ["Montenegro", "me"]],
  H: [["Romania", "ro"], ["Finland", "fi"], ["Georgia", "ge"], ["Kosovo", "xk"]],
  I: [["Slovakia", "sk"], ["Bosnia and Herzegovina", "ba"], ["Republic of Ireland", "ie"], ["Northern Ireland", "gb-nir"]],
  J: [["Bulgaria", "bg"], ["Belarus", "by"], ["Luxembourg", "lu"], ["North Macedonia", "mk"]],
  K: [["Armenia", "am"], ["Azerbaijan", "az"], ["Cyprus", "cy"], ["Estonia", "ee"]],
  L: [["Kazakhstan", "kz"], ["Lithuania", "lt"], ["Latvia", "lv"], ["Moldova", "md"]],
  M: [["Faroe Islands", "fo"], ["Malta", "mt"], ["Andorra", "ad"]],
  N: [["San Marino", "sm"], ["Liechtenstein", "li"], ["Gibraltar", "gi"]],
};

const flag = (code: string) => `https://flagcdn.com/w320/${code}.png`;

/**
 * Matchday dates, anchored on the real international windows.
 *
 * Matchdays 1–2 are in the past and carry results; 3–6 are ahead of us. Markets
 * are created for matchday 3 only, which is what one real matchday of Nations
 * League looks like in the feed.
 */
const MATCHDAY_DATES: Record<number, string> = {
  1: "2026-09-04",
  2: "2026-09-07",
  3: "2026-10-09",
  4: "2026-10-12",
  5: "2026-11-13",
  6: "2026-11-16",
};
const PLAYED_THROUGH = 2; // matchdays 1..2 have scores entered
const MARKET_MATCHDAY = 3; // the window we create markets for

/** Round-robin pairings by team index, home team first. */
const SCHEDULE_4: Record<number, [number, number][]> = {
  1: [[0, 1], [2, 3]],
  2: [[0, 2], [3, 1]],
  3: [[0, 3], [1, 2]],
  4: [[1, 0], [3, 2]],
  5: [[2, 0], [1, 3]],
  6: [[3, 0], [2, 1]],
};
const SCHEDULE_3: Record<number, [number, number][]> = {
  1: [[0, 1]],
  2: [[2, 0]],
  3: [[1, 2]],
  4: [[1, 0]],
  5: [[0, 2]],
  6: [[2, 1]],
};

// ── Deterministic scorelines ────────────────────────────────────────────────

/** mulberry32 — small, seeded, and stable across Node versions. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Weighted toward the scorelines football actually produces. */
const GOAL_TABLE = [0, 0, 0, 1, 1, 1, 1, 2, 2, 3];

function scoreFor(key: string): [number, number] {
  const r = rng(hash(key));
  const home = GOAL_TABLE[Math.floor(r() * GOAL_TABLE.length)];
  const away = GOAL_TABLE[Math.floor(r() * GOAL_TABLE.length)];
  return [home, away];
}

function kickoff(matchday: number, slot: number): Date {
  // 18:45 and 20:45 UTC, the two UEFA evening slots.
  const hour = slot === 0 ? 18 : 20;
  return new Date(`${MATCHDAY_DATES[matchday]}T${String(hour).padStart(2, "0")}:45:00Z`);
}

// ── Safety ──────────────────────────────────────────────────────────────────

/**
 * Fake results and bettable markets belong on a laptop and nowhere else.
 *
 * Both checks matter independently: NODE_ENV is routinely "staging" or unset on
 * a machine pointed at a shared database, and a local NODE_ENV says nothing
 * about which host DB_HOST resolves to.
 */
function assertLocalOnly() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("seed-unl refuses to run with NODE_ENV=production.");
  }
  const host = (process.env.DB_HOST || "localhost").trim();
  if (!["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host)) {
    throw new Error(
      `seed-unl refuses to run against DB_HOST=${host}. It writes invented ` +
        `match results and creates bettable markets; point it at a local database.`,
    );
  }
}

const ds = new DataSource({
  type: "postgres",
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 5432,
  username: process.env.DB_USERNAME || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  database: process.env.DB_NAME || "oro_db",
  synchronize: false,
  entities: [__dirname + "/entities/*.entity.{ts,js}"],
});

const lmsr = new LMSRService();

/** Mirrors MarketsService.create(), minus the cache invalidation an offline script cannot do. */
function buildMarket(input: {
  title: string;
  description: string;
  subcategory: string;
  resolutionCriteria: string;
  status: MarketStatus;
  opensAt: Date;
  closesAt: Date;
  metadata: Record<string, any>;
  outcomes: { label: string; imageUrl: string | null }[];
}): { market: Market; outcomes: Outcome[] } {
  const marketId = randomUUID();
  const outcomes = input.outcomes.map((o, i) => {
    const row = new Outcome();
    row.id = randomUUID();
    row.marketId = marketId;
    row.label = o.label;
    row.imageUrl = o.imageUrl;
    row.totalBetAmount = 0;
    row.currentOdds = 0;
    row.isWinner = false;
    row.isEliminated = false;
    row.sortOrder = i;
    return row;
  });
  const probs = lmsr.calculateProbabilities(outcomes, 1000);
  outcomes.forEach((o, i) => (o.lmsrProbability = probs[i]));

  const market = new Market();
  market.id = marketId;
  market.title = input.title;
  market.description = input.description;
  market.status = input.status;
  market.totalPool = 0;
  market.houseEdgePct = DEFAULT_HOUSE_EDGE_PCT;
  market.mechanism = MarketMechanism.PARIMUTUEL;
  market.liquidityParam = 1000;
  market.category = MarketCategory.SPORTS;
  market.subcategory = input.subcategory;
  market.resolutionCriteria = input.resolutionCriteria;
  market.opensAt = input.opensAt;
  market.closesAt = input.closesAt;
  // Null on purpose — this is what keeps these out of runAutoProposal.
  market.externalMatchId = null;
  market.externalSource = "unl-manual";
  market.externalMarketType = "match-winner";
  market.settlementSource = "Official UEFA Nations League result";
  market.metadata = input.metadata;
  market.isFeatured = false;

  return { market, outcomes };
}

async function reset() {
  const marketRepo = ds.getRepository(Market);
  const positionRepo = ds.getRepository(Position);

  const markets = await marketRepo.find({ where: { externalSource: "unl-manual" } });
  if (markets.length) {
    // Refuse to delete a market anyone has money on, even fake money — a
    // position without its market is an orphan row in the ledger, and this
    // script is not the place to discover what that breaks.
    for (const m of markets) {
      const n = await positionRepo.count({ where: { marketId: m.id } });
      if (n > 0) {
        throw new Error(
          `Refusing --reset: market ${m.id} ("${m.title}") has ${n} position(s). ` +
            `Cancel and refund it through the admin panel first.`,
        );
      }
    }
    // Fixtures point at markets; clear the reference before the markets go.
    await ds.query(
      `UPDATE unl_fixtures SET "marketId" = NULL, "homeOutcomeId" = NULL, "drawOutcomeId" = NULL, "awayOutcomeId" = NULL`,
    );
    await marketRepo.remove(markets); // outcomes cascade
    console.log(`🗑  removed ${markets.length} unl-manual market(s)`);
  }
  await ds.query(`DELETE FROM unl_fixtures WHERE season = $1`, [SEASON]);
  await ds.query(`DELETE FROM unl_teams WHERE season = $1`, [SEASON]);
  console.log(`🗑  removed ${SEASON} fixtures and teams`);
}

async function seed() {
  assertLocalOnly();
  await ds.initialize();
  console.log(`✅ connected to ${process.env.DB_NAME || "oro_db"} on ${process.env.DB_HOST || "localhost"}`);

  if (RESET) await reset();

  const teamRepo = ds.getRepository(UnlTeam);
  const fixtureRepo = ds.getRepository(UnlFixture);
  const marketRepo = ds.getRepository(Market);
  const outcomeRepo = ds.getRepository(Outcome);

  const existingTeams = await teamRepo.count({ where: { season: SEASON } });
  if (existingTeams > 0) {
    console.log(
      `ℹ️  ${existingTeams} team(s) already seeded for ${SEASON} — nothing to do. ` +
        `Re-run with --reset to rebuild.`,
    );
    await ds.destroy();
    return;
  }

  // ── Teams ────────────────────────────────────────────────────────────────
  const byGroup = new Map<string, UnlTeam[]>();
  for (const [groupKey, entries] of Object.entries(GROUPS)) {
    const rows = entries.map(([name, code], i) =>
      teamRepo.create({
        season: SEASON,
        groupKey,
        name,
        flagUrl: flag(code),
        sortOrder: i,
      }),
    );
    byGroup.set(groupKey, await teamRepo.save(rows));
  }
  const teamCount = [...byGroup.values()].reduce((n, r) => n + r.length, 0);
  console.log(`✅ ${teamCount} teams across ${byGroup.size} groups`);

  // ── Fixtures ─────────────────────────────────────────────────────────────
  //
  // One fixture per group is deliberately left unplayed in the September
  // window: group A matchday 2, which gets a market in `closed` state below.
  // That is the state the admin flow starts from — a match that has finished
  // in reality, a market that has stopped taking bets, and nothing proposed.
  const HELD_BACK = { groupKey: "A", matchday: 2, slot: 0 };

  const fixtures: UnlFixture[] = [];
  for (const [groupKey, teams] of byGroup) {
    const schedule = teams.length === 3 ? SCHEDULE_3 : SCHEDULE_4;
    for (let md = 1; md <= 6; md++) {
      schedule[md].forEach(([h, a], slot) => {
        const home = teams[h];
        const away = teams[a];
        const held =
          groupKey === HELD_BACK.groupKey &&
          md === HELD_BACK.matchday &&
          slot === HELD_BACK.slot;
        const isPlayed = md <= PLAYED_THROUGH && !held;
        const [hs, as] = scoreFor(`${SEASON}|${groupKey}|${md}|${home.name}|${away.name}`);

        fixtures.push(
          fixtureRepo.create({
            season: SEASON,
            groupKey,
            homeTeamId: home.id,
            awayTeamId: away.id,
            kickoffAt: kickoff(md, slot),
            // Null, not 0, for anything unplayed.
            homeScore: isPlayed ? hs : null,
            awayScore: isPlayed ? as : null,
            status: isPlayed ? UnlFixtureStatus.FINISHED : UnlFixtureStatus.SCHEDULED,
            matchday: md,
            marketId: null,
            homeOutcomeId: null,
            drawOutcomeId: null,
            awayOutcomeId: null,
          }),
        );
      });
    }
  }
  const saved = await fixtureRepo.save(fixtures);
  const played = saved.filter((f) => f.homeScore !== null).length;
  console.log(`✅ ${saved.length} fixtures (${played} with results, 1 held back unplayed)`);

  // ── Markets ──────────────────────────────────────────────────────────────
  const teamById = new Map<string, UnlTeam>();
  for (const rows of byGroup.values()) for (const t of rows) teamById.set(t.id, t);

  const RESOLUTION =
    "Resolved to the full-time result (Home win / Draw / Away win) of the official " +
    "UEFA Nations League fixture. Extra time and penalties do not apply to group-stage matches.";
  const DESCRIPTION = "UEFA Nations League — who wins the match?";

  const heldFixture = saved.find(
    (f) =>
      f.groupKey === HELD_BACK.groupKey &&
      f.matchday === HELD_BACK.matchday &&
      f.homeScore === null,
  )!;
  const marketFixtures = saved.filter((f) => f.matchday === MARKET_MATCHDAY);

  const now = new Date();
  const openedAt = new Date(now.getTime() - 60 * 60 * 1000);

  let created = 0;
  for (const fixture of [...marketFixtures, heldFixture]) {
    const home = teamById.get(fixture.homeTeamId)!;
    const away = teamById.get(fixture.awayTeamId)!;
    const isHeld = fixture.id === heldFixture.id;

    const { market, outcomes } = buildMarket({
      title: `${home.name} vs ${away.name}`,
      description: DESCRIPTION,
      subcategory: "unl-match",
      resolutionCriteria: RESOLUTION,
      // The held-back fixture goes in already CLOSED. The keeper only closes
      // markets that are OPEN, so inserting it closed is what stops it firing
      // an admin propose DM the moment this script finishes.
      status: isHeld ? MarketStatus.CLOSED : MarketStatus.OPEN,
      opensAt: isHeld ? new Date(fixture.kickoffAt.getTime() - 7 * 864e5) : openedAt,
      closesAt: fixture.kickoffAt,
      metadata: {
        unlFixtureId: fixture.id,
        matchday: fixture.matchday,
        matchLabel: `Group ${fixture.groupKey} · Matchday ${fixture.matchday}`,
      },
      outcomes: [
        { label: home.name, imageUrl: home.flagUrl },
        { label: "Draw", imageUrl: null },
        { label: away.name, imageUrl: away.flagUrl },
      ],
    });

    await marketRepo.save(market);
    await outcomeRepo.save(outcomes);

    // Stamp the outcome ids back onto the fixture. Settlement compares two
    // integers and returns one of these three ids — no team name ever reaches
    // the settlement path, which is the only thing that keeps Republic of
    // Ireland and Northern Ireland apart.
    fixture.marketId = market.id;
    fixture.homeOutcomeId = outcomes[0].id;
    fixture.drawOutcomeId = outcomes[1].id;
    fixture.awayOutcomeId = outcomes[2].id;
    await fixtureRepo.save(fixture);
    created++;
  }
  console.log(
    `✅ ${created} match markets (${marketFixtures.length} open for matchday ${MARKET_MATCHDAY}, ` +
      `1 closed and awaiting an admin proposal)`,
  );

  // ── Season-long stat markets ─────────────────────────────────────────────
  //
  // These carry no fixture and no externalMatchId, so they are admin-resolved
  // exactly as the EPL and UCL stat markets already are.
  const GROUP_STAGE_END = new Date("2026-11-16T22:45:00Z");
  const SCORERS = [
    "Kylian Mbappé", "Harry Kane", "Erling Haaland", "Cristiano Ronaldo",
    "Romelu Lukaku", "Lautaro Martínez", "Rasmus Højlund", "Memphis Depay",
  ];
  const PLAYMAKERS = [
    "Kevin De Bruyne", "Bruno Fernandes", "Jude Bellingham", "Lamine Yamal",
    "Rodrygo", "Florian Wirtz", "Nicolò Barella", "Martin Ødegaard",
  ];

  for (const [subcategory, title, players] of [
    ["unl-topscorer", "Nations League Top Scorer — group stage", SCORERS],
    ["unl-assists", "Nations League Most Assists — group stage", PLAYMAKERS],
  ] as const) {
    const { market, outcomes } = buildMarket({
      title,
      description: "UEFA Nations League 2026/27 group stage.",
      subcategory,
      resolutionCriteria:
        "Resolved to the player leading the official UEFA Nations League group-stage " +
        "board at the end of matchday 6. Ties are split by matches played, then minutes played.",
      status: MarketStatus.OPEN,
      opensAt: openedAt,
      closesAt: GROUP_STAGE_END,
      metadata: {},
      outcomes: players.map((label) => ({ label, imageUrl: null })),
    });
    market.externalMarketType = null; // not a match
    await marketRepo.save(market);
    await outcomeRepo.save(outcomes);
    console.log(`✅ stat market: ${title}`);
  }

  await ds.destroy();
  console.log("\n🎉 Nations League fake data seeded.");
}

seed().catch(async (e) => {
  console.error(`❌ ${(e as Error).message}`);
  if (ds.isInitialized) await ds.destroy();
  process.exit(1);
});
