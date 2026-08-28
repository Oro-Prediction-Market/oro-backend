import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RedisService } from "../redis/redis.service";

// EPL live data sources — both free:
//  • football-data.org  → standings + goals/assists (official, accurate).
//  • Fantasy Premier League (official, no key) → yellow/red cards.
const FOOTBALL_DATA_BASE = "https://api.football-data.org/v4/";
const FPL_BOOTSTRAP = "https://fantasy.premierleague.com/api/bootstrap-static/";
const FPL_BADGE = (code: number | string) =>
  `https://resources.premierleague.com/premierleague/badges/50/t${code}@x2.png`;
const FPL_FACE = (code: number | string) =>
  `https://resources.premierleague.com/premierleague/photos/players/110x140/p${code}.png`;
const CACHE_TTL_SEC = 3600; // 1h — well within provider rate limits
const TOP_N = 12;

export interface EplStandingRow {
  position: number;
  teamName: string;
  teamBadge: string;
  played: number;
  won: number;
  draw: number;
  lost: number;
  gf: number;
  ga: number;
  gd: number;
  points: number;
}

export interface EplStandings {
  updatedAt: string;
  table: EplStandingRow[];
}

export interface EplStatEntry {
  player: string;
  club: string;
  clubBadge: string;
  face: string; // primary player photo (FPL); "" when no match
  faceBackup: string; // secondary player photo (TheSportsDB); "" when none
  value: number;
}

export interface EplStats {
  updatedAt: string;
  goals: EplStatEntry[];
  assists: EplStatEntry[];
  yellow: EplStatEntry[];
  red: EplStatEntry[];
}

const num = (v: unknown): number => {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : 0;
};

// Lower-case, strip accents/punctuation → token list, for cross-provider name
// matching (football-data.org scorer ↔ FPL player, to borrow the photo).
const normTokens = (s: string): string[] =>
  (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

@Injectable()
export class EplService {
  private readonly logger = new Logger(EplService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  /** GET football-data.org. Returns the parsed JSON body, or null on any
   *  failure (missing key, HTTP error, network). */
  private async footballData<T = any>(path: string): Promise<T | null> {
    const key = this.config.get<string>("FOOTBALL_DATA_API_KEY");
    if (!key) {
      this.logger.warn("FOOTBALL_DATA_API_KEY not set — EPL data unavailable");
      return null;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(`${FOOTBALL_DATA_BASE}${path}`, {
        headers: { "X-Auth-Token": key },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        this.logger.warn(`football-data ${path} HTTP ${res.status}`);
        return null;
      }
      return (await res.json()) as T;
    } catch (err: any) {
      clearTimeout(timeout);
      this.logger.warn(`football-data ${path} failed: ${err.message}`);
      return null;
    }
  }

  /** GET the Fantasy Premier League bootstrap (players + teams). Public, no key;
   *  needs a browser-ish User-Agent or it 403s. Returns null on failure. */
  private async fplBootstrap(): Promise<any | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(FPL_BOOTSTRAP, {
        headers: { "User-Agent": "Mozilla/5.0 (Oro EPL hub)" },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        this.logger.warn(`FPL bootstrap HTTP ${res.status}`);
        return null;
      }
      return await res.json();
    } catch (err: any) {
      clearTimeout(timeout);
      this.logger.warn(`FPL bootstrap failed: ${err.message}`);
      return null;
    }
  }

  async getStandings(): Promise<EplStandings> {
    const cacheKey = "oro:epl:standings";
    const cached = await this.redis.getJson<EplStandings>(cacheKey);
    if (cached) return cached;

    const rows = await this.fetchStandingsTable();
    const table: EplStandingRow[] = rows
      .map((r: any): EplStandingRow => ({
        position: num(r.position),
        teamName: r.team?.shortName ?? r.team?.name ?? "",
        teamBadge: r.team?.crest ?? "",
        played: num(r.playedGames),
        won: num(r.won),
        draw: num(r.draw),
        lost: num(r.lost),
        gf: num(r.goalsFor),
        ga: num(r.goalsAgainst),
        gd: num(r.goalDifference),
        points: num(r.points),
      }))
      .sort((a, b) => a.position - b.position);

    const result: EplStandings = { updatedAt: new Date().toISOString(), table };
    // Cache only real data — never poison the cache with an empty table.
    if (table.length > 0) {
      await this.redis.setJsonEx(cacheKey, CACHE_TTL_SEC, result);
    }
    return result;
  }

  /** football-data.org standings TOTAL table for the CURRENT season (or an
   *  explicit EPL_SEASON override). No summer-gap fallback: before kickoff this
   *  is the new campaign's table with every club on zero, and it fills in as
   *  games are played — we never carry last season's numbers over. */
  private async fetchStandingsTable(): Promise<any[]> {
    const override = this.config.get<string>("EPL_SEASON");
    const path = `competitions/PL/standings${override ? `?season=${override}` : ""}`;
    const data = await this.footballData<any>(path);
    if (!data) return [];
    return data?.standings?.find((x: any) => x.type === "TOTAL")?.table ?? [];
  }

  /** football-data.org top-scorers (goal-ranked, carries assists too) for the
   *  CURRENT season only — no summer-gap fallback, so the board is empty until
   *  the season is underway. */
  private async fetchScorers(): Promise<any[]> {
    const override = this.config.get<string>("EPL_SEASON");
    const path = `competitions/PL/scorers?limit=100${override ? `&season=${override}` : ""}`;
    const data = await this.footballData<any>(path);
    return data?.scorers ?? [];
  }

  /** Status of the CURRENT Premier League season (no fallback). `started` is
   *  false during the summer gap — when the boards are showing LAST season's
   *  data — so DB-writing callers (market creation) can refuse. `maxPlayed` is
   *  the most games any club has played, used to gate auto-creation until the
   *  season is a few gameweeks in. An EPL_SEASON override counts as started. */
  async getSeasonInfo(): Promise<{
    started: boolean;
    seasonStart: string | null;
    maxPlayed: number;
  }> {
    const override = this.config.get<string>("EPL_SEASON");
    const path = `competitions/PL/standings${override ? `?season=${override}` : ""}`;
    const data = await this.footballData<any>(path);
    if (!data) {
      // Unreachable provider → treat as started so we don't hard-block callers.
      return { started: true, seasonStart: null, maxPlayed: 0 };
    }
    const table = data.standings?.find((x: any) => x.type === "TOTAL")?.table ?? [];
    const maxPlayed = table.reduce((m: number, r: any) => Math.max(m, num(r.playedGames)), 0);
    // Summer gap: football-data.org rolls the "current" season label forward to
    // the UPCOMING campaign (future start/end dates) while the standings TABLE
    // still holds LAST season's final numbers (38 games played) until the new
    // season actually kicks off. So games-played alone can't distinguish a live
    // season from the off-season — the stale 38 wrongly reads as "started" and
    // unlocks market creation on old data. A season is only genuinely live when
    // TODAY falls inside its [startDate, endDate] window.
    const now = Date.now();
    const start = data.season?.startDate
      ? new Date(data.season.startDate).getTime()
      : null;
    const end = data.season?.endDate
      ? new Date(data.season.endDate).getTime()
      : null;
    const inWindow =
      (start === null || start <= now) && (end === null || now <= end);
    const live = maxPlayed > 0 && inWindow;
    return {
      started: override ? true : live,
      seasonStart: data.season?.startDate ?? null,
      // Report 0 outside the season window so the gameweek-maturity gate can't
      // fire on stale carry-over standings either.
      maxPlayed: live ? maxPlayed : 0,
    };
  }

  /** Convenience: has the current season kicked off (any games played)? */
  async seasonHasStarted(): Promise<boolean> {
    return (await this.getSeasonInfo()).started;
  }

  /** Upcoming Premier League fixtures within the next `daysAhead` days (not yet
   *  played). Used by the keeper to auto-create match-winner markets. */
  async getUpcomingFixtures(daysAhead: number): Promise<
    Array<{
      id: number;
      homeTeam: string;
      awayTeam: string;
      homeCrest: string;
      awayCrest: string;
      utcDate: string;
    }>
  > {
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const from = new Date();
    const to = new Date(from.getTime() + daysAhead * 86_400_000);
    const path = `competitions/PL/matches?status=SCHEDULED,TIMED&dateFrom=${day(from)}&dateTo=${day(to)}`;
    const data = await this.footballData<any>(path);
    if (!data?.matches) return [];
    return data.matches
      .map((m: any) => ({
        id: m.id,
        homeTeam: m.homeTeam?.name ?? "",
        awayTeam: m.awayTeam?.name ?? "",
        homeCrest: m.homeTeam?.crest ?? "",
        awayCrest: m.awayTeam?.crest ?? "",
        utcDate: m.utcDate ?? "",
      }))
      .filter((f: any) => f.id && f.homeTeam && f.awayTeam && f.utcDate);
  }

  async getStats(): Promise<EplStats> {
    const cacheKey = "oro:epl:stats";
    const cached = await this.redis.getJson<EplStats>(cacheKey);
    if (cached) return cached;

    // Summer gap: the season hasn't kicked off, so there are no current-season
    // stats. Show nothing rather than carrying last season's boards over. (Not
    // cached — flips to real data on the first call once the season is live.)
    if (!(await this.seasonHasStarted())) {
      return {
        updatedAt: new Date().toISOString(),
        goals: [],
        assists: [],
        yellow: [],
        red: [],
      };
    }

    // Goals & assists → football-data.org (official). The /scorers list is
    // goal-ranked but carries each scorer's assists, so the assists board is
    // that same list re-sorted by assists (limit=100 reaches low-goal
    // playmakers like Bruno Fernandes).
    // Yellow & red → Fantasy Premier League (official, has real card counts).
    const [scorers, fpl] = await Promise.all([
      this.fetchScorers(),
      this.fplBootstrap(),
    ]);

    // Index FPL players by name so football-data.org scorers can borrow a photo.
    const teamsById = new Map<number, { name: string; code: number }>();
    for (const t of fpl?.teams ?? []) {
      teamsById.set(t.id, { name: t.name, code: t.code });
    }
    const fplByName = new Map<string, any>();
    const addKey = (k: string, el: any) => {
      if (k && !fplByName.has(k)) fplByName.set(k, el);
    };
    for (const el of fpl?.elements ?? []) {
      addKey(normTokens(el.web_name ?? "").join(" "), el);
      addKey(normTokens(el.second_name ?? "").join(" "), el);
      addKey(normTokens(`${el.first_name ?? ""} ${el.second_name ?? ""}`).join(" "), el);
      const st = normTokens(el.second_name ?? el.web_name ?? "");
      if (st.length) addKey(st[st.length - 1], el);
    }
    const faceFor = (name: string): string => {
      const toks = normTokens(name);
      const el =
        fplByName.get(toks.join(" ")) ??
        (toks.length >= 2 ? fplByName.get(toks.slice(-2).join(" ")) : undefined) ??
        (toks.length ? fplByName.get(toks[toks.length - 1]) : undefined);
      return el ? FPL_FACE(el.code) : "";
    };

    const scorerEntry = (s: any, value: number): EplStatEntry => ({
      player: s.player?.name ?? "",
      club: s.team?.shortName ?? s.team?.name ?? "",
      clubBadge: s.team?.crest ?? "",
      face: faceFor(s.player?.name ?? ""),
      faceBackup: "", // filled in after the boards are built
      value,
    });
    const scorerBoard = (pick: "goals" | "assists"): EplStatEntry[] =>
      scorers
        .map((s) => scorerEntry(s, num(s[pick])))
        .filter((e) => e.value > 0 && e.player)
        .sort((a, b) => b.value - a.value)
        .slice(0, TOP_N);

    // --- cards (FPL) -------------------------------------------------------
    // FPL stores web_name (short) plus first_name/second_name — use the full
    // name for parity with the football-data.org goals/assists boards.
    const fullName = (p: any): string =>
      `${p.first_name ?? ""} ${p.second_name ?? ""}`.trim() || (p.web_name ?? "");
    const cardBoard = (
      field: "yellow_cards" | "red_cards",
    ): EplStatEntry[] =>
      (fpl?.elements ?? [])
        .map((p: any): EplStatEntry => {
          const team = teamsById.get(p.team);
          return {
            player: fullName(p),
            club: team?.name ?? "",
            clubBadge: team ? FPL_BADGE(team.code) : "",
            face: p.code ? FPL_FACE(p.code) : "",
            faceBackup: "", // filled in after the boards are built
            value: num(p[field]),
          };
        })
        .filter((e: EplStatEntry) => e.value > 0 && e.player)
        .sort((a: EplStatEntry, b: EplStatEntry) => b.value - a.value)
        .slice(0, TOP_N);

    const result: EplStats = {
      updatedAt: new Date().toISOString(),
      goals: scorerBoard("goals"),
      // Assists → football-data.org (Opta-official). FPL counts assists under
      // its own rules (won penalties, pass-before-the-pass, rebounds), so its
      // numbers don't match the league record we settle "Most Assists" against.
      // The trade-off is a thinner board when the free tier returns few assists.
      assists: scorerBoard("assists"),
      yellow: cardBoard("yellow_cards"),
      red: cardBoard("red_cards"),
    };

    // Resolve the secondary photo (TheSportsDB) for every player on the boards,
    // so the client can swap to it if the FPL photo 404s. Deduped by name and
    // Redis-cached per player, so this stays cheap across hourly refreshes.
    const allEntries = [result.goals, result.assists, result.yellow, result.red].flat();
    const uniqueNames = [...new Set(allEntries.map((e) => e.player))];
    const backups = new Map<string, string>();
    await this.mapWithConcurrency(uniqueNames, 5, async (name) => {
      backups.set(name, await this.faceBackup(name));
    });
    for (const e of allEntries) e.faceBackup = backups.get(e.player) ?? "";

    // Cache only when at least one source returned data.
    if (scorers.length > 0 || (fpl?.elements?.length ?? 0) > 0) {
      await this.redis.setJsonEx(cacheKey, CACHE_TTL_SEC, result);
    }
    return result;
  }

  /** Run an async fn over items with a fixed concurrency ceiling. */
  private async mapWithConcurrency<T>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<void>,
  ): Promise<void> {
    const queue = [...items];
    const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (item !== undefined) await fn(item);
      }
    });
    await Promise.all(workers);
  }

  /** Secondary player photo via TheSportsDB (cutout, else thumbnail). Cached in
   *  Redis for 7 days — player images rarely change, and a successful "no image"
   *  result is cached too so we don't re-query. Network/rate-limit failures are
   *  NOT cached, so they retry on the next refresh. Returns "" when unavailable. */
  private async faceBackup(name: string): Promise<string> {
    const norm = normTokens(name).join(" ");
    if (!norm) return "";
    const cacheKey = `oro:epl:facebk:${norm}`;
    const cached = await this.redis.getJson<string>(cacheKey);
    if (typeof cached === "string") return cached;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetch(
        `https://www.thesportsdb.com/api/v1/json/3/searchplayers.php?p=${encodeURIComponent(name)}`,
        { signal: controller.signal },
      );
      clearTimeout(timeout);
      if (!res.ok) return ""; // rate-limited/error — don't cache, retry later
      const data = await res.json();
      const players = (data?.player ?? []).filter(
        (p: any) => (p.strSport ?? "").toLowerCase() === "soccer",
      );
      const url = players[0]?.strCutout || players[0]?.strThumb || "";
      await this.redis.setJsonEx(cacheKey, 7 * 24 * 3600, url); // cache result (incl. "")
      return url;
    } catch (err: any) {
      clearTimeout(timeout);
      this.logger.warn(`TheSportsDB ${name} failed: ${err.message}`);
      return ""; // don't cache transient failures
    }
  }
}
