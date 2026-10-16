/**
 * Reading NBA games from ESPN's public site API.
 *
 * ESPN publishes no documentation or terms for these endpoints; they are what
 * espn.com itself calls. No key is needed. Because nobody promises their shape,
 * every reader here returns null (or skips the event) on anything unexpected,
 * and nothing is paid on a game unless it reads cleanly — see `nbaFinalResult`.
 *
 * Kept free of Nest dependencies so the keeper's pre-payout re-check can use it
 * without importing NbaModule (which imports MarketsModule — a cycle), the same
 * way football settlement uses `fetchFixture` from fixture-result.util.
 */

export const ESPN_NBA_SITE =
  "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
export const ESPN_NBA_STANDINGS =
  "https://site.api.espn.com/apis/v2/sports/basketball/nba/standings";

/** Our externalSource / settlementSource for NBA markets. */
export const ESPN_NBA_SOURCE = "espn-nba";

/** ESPN season types. Which ones get markets is NBA_MARKET_SEASON_TYPES. */
export const NBA_SEASON_TYPE = {
  PRE: 1,
  REGULAR: 2,
  POST: 3,
  PLAY_IN: 5,
} as const;

export interface NbaTeamSide {
  id: string;
  name: string; // "Cleveland Cavaliers"
  abbr: string; // "CLE"
  logo: string | null;
  /** Null until the game has a score. */
  score: number | null;
  /** ESPN's own verdict; only meaningful once the game is final. */
  winner: boolean;
}

export interface NbaGame {
  id: string;
  /** Tip-off, ISO UTC. */
  tipoff: string;
  seasonType: number;
  /** "pre" | "in" | "post" */
  state: string;
  /** e.g. STATUS_SCHEDULED, STATUS_IN_PROGRESS, STATUS_FINAL, STATUS_POSTPONED */
  statusName: string;
  /** Human text, e.g. "Final", "Final/OT", "Q3 4:12", "10/22 - 7:00 PM EDT" */
  statusDetail: string;
  completed: boolean;
  period: number;
  home: NbaTeamSide;
  away: NbaTeamSide;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(typeof v === "object" ? (v as any).value : v);
  return Number.isFinite(n) ? n : null;
};

function side(c: any): NbaTeamSide | null {
  const t = c?.team;
  if (!t?.id || !t?.displayName) return null;
  return {
    id: String(t.id),
    name: String(t.displayName),
    abbr: String(t.abbreviation ?? ""),
    logo: t.logo ?? t.logos?.[0]?.href ?? null,
    score: num(c.score),
    winner: c.winner === true,
  };
}

/**
 * One game from a scoreboard event or a summary header. Both carry the game in
 * `competitions[0]`; the scoreboard has the status on the event, the summary
 * header on the competition, so both places are read.
 */
export function parseEspnGame(event: any, header = false): NbaGame | null {
  const comp = event?.competitions?.[0];
  if (!event?.id || !comp) return null;
  const competitors: any[] = comp.competitors ?? [];
  const home = side(competitors.find((c) => c.homeAway === "home"));
  const away = side(competitors.find((c) => c.homeAway === "away"));
  if (!home || !away) return null;
  const status = (header ? comp.status : event.status) ?? comp.status ?? {};
  const type = status.type ?? {};
  const tipoff = event.date ?? comp.date;
  if (!tipoff || Number.isNaN(Date.parse(tipoff))) return null;
  return {
    id: String(event.id),
    tipoff: new Date(tipoff).toISOString(),
    seasonType: Number(event.season?.type ?? 0),
    state: String(type.state ?? ""),
    statusName: String(type.name ?? ""),
    statusDetail: String(type.shortDetail ?? type.detail ?? ""),
    completed: type.completed === true,
    period: Number(status.period ?? 0),
    home,
    away,
  };
}

/** GET an ESPN URL as JSON; null on any failure (network, HTTP, timeout). */
export async function fetchEspnJson<T = any>(url: string): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      // A User-Agent naming a bot ("compatible; OroBot") gets 403;
      // a plain one is served.
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** One game by ESPN id, from the summary endpoint. Never cached. */
export async function fetchNbaGame(id: string): Promise<NbaGame | null> {
  const body = await fetchEspnJson<any>(
    `${ESPN_NBA_SITE}/summary?event=${encodeURIComponent(id)}`,
  );
  if (!body?.header) return null;
  // The summary header has no `date` on the event; it lives on the competition.
  const header = { ...body.header, date: body.header.competitions?.[0]?.date };
  return parseEspnGame(header, true);
}

/**
 * The game's result, if it is one we are willing to pay on; otherwise null.
 *
 * Same lesson football settlement learned (see fixture-result.util): "over" is
 * not "final". All of these must hold:
 *   - ESPN says completed, state "post" and status STATUS_FINAL (which covers
 *     overtime: the detail reads "Final/OT" but the name is still STATUS_FINAL);
 *   - both scores are real numbers and differ — basketball has no draw, so an
 *     equal or missing score is a half-written record, not a result;
 *   - ESPN's winner flag is set on exactly one side and agrees with the score.
 * A forfeit, a postponement or anything else odd returns null and waits.
 */
export function nbaFinalResult(
  game: NbaGame | null,
): { winner: "home" | "away"; home: number; away: number } | null {
  if (!game) return null;
  if (!game.completed || game.state !== "post") return null;
  if (game.statusName !== "STATUS_FINAL") return null;
  const { home, away } = game;
  if (home.score === null || away.score === null) return null;
  if (home.score === away.score) return null;
  if (home.winner === away.winner) return null;
  const byScore = home.score > away.score ? "home" : "away";
  const byFlag = home.winner ? "home" : "away";
  if (byScore !== byFlag) return null;
  return { winner: byScore, home: home.score, away: away.score };
}

/** Fixed offset: Bhutan has no daylight saving. */
const BHUTAN_OFFSET_MS = 6 * 60 * 60 * 1000;

/** The Bhutan calendar date (YYYY-MM-DD) of an instant. */
export function bhutanDate(instant: Date | string): string {
  const t =
    typeof instant === "string" ? Date.parse(instant) : instant.getTime();
  return new Date(t + BHUTAN_OFFSET_MS).toISOString().slice(0, 10);
}

/** YYYY-MM-DD plus n days. */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * ESPN scoreboard dates (YYYYMMDD) to fetch so that every game whose Bhutan
 * date falls in [from, from + days) is included.
 *
 * ESPN files a game under its US date. Bhutan runs 10-11 hours ahead of the US
 * East coast and up to 14 ahead of the West, so a game on Bhutan date D is
 * filed under US date D-1 or D. Fetching D-1 .. D+days-1 covers the range; the
 * caller then keeps only games whose Bhutan date is inside it.
 */
export function espnDatesFor(from: string, days: number): string[] {
  const out: string[] = [];
  for (let i = -1; i < days; i++) out.push(addDays(from, i).replace(/-/g, ""));
  return out;
}
