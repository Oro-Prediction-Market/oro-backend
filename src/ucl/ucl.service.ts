import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RedisService } from "../redis/redis.service";

// UEFA Champions League live data — football-data.org (free tier includes CL).
//  • standings  → league-phase table (36-team single table in the 2024+ format)
//  • scorers    → goals + assists boards (official)
//  • cards      → NOT available on the free tier for CL (no /scorers cards, no
//                 FPL equivalent). Those boards come back empty; the keeper skips
//                 creating yellow/red stat markets when a board is empty.
const FOOTBALL_DATA_BASE = "https://api.football-data.org/v4/";
const CACHE_TTL_SEC = 3600; // 1h — well within free-tier rate limits
const TOP_N = 15;

export interface UclStandingRow {
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

export interface UclStandings {
  updatedAt: string;
  table: UclStandingRow[];
}

export interface UclStatEntry {
  player: string;
  club: string;
  clubBadge: string;
  face: string; // primary player photo (empty — no free CL photo feed)
  faceBackup: string; // secondary player photo (TheSportsDB); "" when none
  value: number;
}

export interface UclStats {
  updatedAt: string;
  goals: UclStatEntry[];
  assists: UclStatEntry[];
  yellow: UclStatEntry[]; // empty on the free tier (no CL card data)
  red: UclStatEntry[]; // empty on the free tier (no CL card data)
}

export interface UclBracketTeam {
  name: string;
  short: string;
  crest: string;
}
export interface UclBracketMatch {
  a: UclBracketTeam | null;
  b: UclBracketTeam | null;
  winner: "a" | "b" | null;
}
export interface UclBracketRound {
  key: string;
  label: string;
  matches: UclBracketMatch[];
}
export interface UclBracket {
  updatedAt: string;
  season: string | null;
  hasData: boolean;
  decided: boolean; // the final has a winner
  rounds: UclBracketRound[];
}

const num = (v: unknown): number => {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : 0;
};

// Lower-case, strip accents/punctuation → token list, for TheSportsDB name lookup.
const normTokens = (s: string): string[] =>
  (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

@Injectable()
export class UclService {
  private readonly logger = new Logger(UclService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  /** GET football-data.org. Returns the parsed JSON body, or null on any
   *  failure (missing key, HTTP error, network). */
  private async footballData<T = any>(path: string): Promise<T | null> {
    const key = this.config.get<string>("FOOTBALL_DATA_API_KEY");
    if (!key) {
      this.logger.warn("FOOTBALL_DATA_API_KEY not set — UCL data unavailable");
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

  // The league-phase standings live under type "LEAGUE"/"TOTAL". Older group-
  // stage seasons return several GROUP tables — flatten those as a fallback.
  private extractTable(data: any): any[] {
    const st: any[] = data?.standings ?? [];
    if (!st.length) return [];
    const preferred = st.find(
      (x) => x.type === "TOTAL" || x.type === "LEAGUE",
    );
    if (preferred?.table?.length) return preferred.table;
    if (st.length === 1) return st[0]?.table ?? [];
    return st.flatMap((x) => x.table ?? []);
  }

  async getStandings(): Promise<UclStandings> {
    const cacheKey = "oro:ucl:standings";
    const cached = await this.redis.getJson<UclStandings>(cacheKey);
    if (cached) return cached;

    const rows = await this.fetchStandingsTable();
    const table: UclStandingRow[] = rows
      .map((r: any): UclStandingRow => ({
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

    const result: UclStandings = { updatedAt: new Date().toISOString(), table };
    if (table.length > 0) {
      await this.redis.setJsonEx(cacheKey, CACHE_TTL_SEC, result);
    }
    return result;
  }

  /** football-data.org CL standings for the CURRENT season only (or an explicit
   *  UCL_SEASON override). No summer-gap fallback: before the season is under
   *  way the table is simply empty rather than showing last season's — the hub
   *  renders its pre-season state instead of stale data. */
  private async fetchStandingsTable(): Promise<any[]> {
    const override = this.config.get<string>("UCL_SEASON");
    const path = `competitions/CL/standings${override ? `?season=${override}` : ""}`;

    const data = await this.footballData<any>(path);
    if (!data) return [];
    return this.extractTable(data);
  }

  /** football-data.org CL top-scorers (goal-ranked, carries assists too) for the
   *  CURRENT season only (or an explicit UCL_SEASON override). No summer-gap
   *  fallback: before the season is under way the boards are empty rather than
   *  showing last season's leaders as if they were current. */
  private async fetchScorers(): Promise<any[]> {
    const override = this.config.get<string>("UCL_SEASON");
    const path = `competitions/CL/scorers?limit=100${override ? `&season=${override}` : ""}`;
    const data = await this.footballData<any>(path);
    return data?.scorers ?? [];
  }

  /** Status of the CURRENT Champions League season (no fallback). `started` is
   *  false during the summer gap so DB-writing callers refuse to bake stale data
   *  into a market. `maxPlayed` gates auto-creation until a few matchdays in. */
  async getSeasonInfo(): Promise<{
    started: boolean;
    seasonStart: string | null;
    maxPlayed: number;
  }> {
    const override = this.config.get<string>("UCL_SEASON");
    const path = `competitions/CL/standings${override ? `?season=${override}` : ""}`;
    const data = await this.footballData<any>(path);
    if (!data) {
      // Unreachable provider → treat as started so we don't hard-block callers.
      return { started: true, seasonStart: null, maxPlayed: 0 };
    }
    const table = this.extractTable(data);
    const maxPlayed = table.reduce(
      (m: number, r: any) => Math.max(m, num(r.playedGames)),
      0,
    );
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
      maxPlayed: live ? maxPlayed : 0,
    };
  }

  async seasonHasStarted(): Promise<boolean> {
    return (await this.getSeasonInfo()).started;
  }

  /** Upcoming Champions League fixtures within the next `daysAhead` days (not
   *  yet played). Used by the keeper to auto-create match-winner markets. */
  async getUpcomingFixtures(daysAhead: number): Promise<
    Array<{
      id: number;
      homeTeam: string;
      awayTeam: string;
      homeCrest: string;
      awayCrest: string;
      utcDate: string;
      stage: string;
    }>
  > {
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const from = new Date();
    const to = new Date(from.getTime() + daysAhead * 86_400_000);
    const path = `competitions/CL/matches?status=SCHEDULED,TIMED&dateFrom=${day(from)}&dateTo=${day(to)}`;
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
        stage: m.stage ?? "",
      }))
      .filter((f: any) => f.id && f.homeTeam && f.awayTeam && f.utcDate);
  }

  /** Build the knockout bracket (Round of 16 → Final) from the CL match list.
   *  football-data.org exposes each knockout match with a `stage` but no bracket
   *  slot, so we group two-legged ties by team pair, then reconstruct the tree by
   *  advancement: the winner of a tie is whichever team turns up in the next
   *  round (robust to extra-time/penalties); the final uses `score.winner`. */
  async getBracket(): Promise<UclBracket> {
    const cacheKey = "oro:ucl:bracket";
    const cached = await this.redis.getJson<UclBracket>(cacheKey);
    if (cached) return cached;

    const override = this.config.get<string>("UCL_SEASON");
    const data = await this.footballData<any>(
      `competitions/CL/matches${override ? `?season=${override}` : ""}`,
    );
    const matches: any[] = data?.matches ?? [];
    const season = data?.filters?.season ?? data?.season?.startDate ?? null;

    type Team = { id: number; name: string; short: string; crest: string };
    type Tie = { a: Team; b: Team; matches: any[]; firstDate: number };
    const team = (t: any): Team | null =>
      t && t.id
        ? { id: t.id, name: t.name ?? "", short: t.shortName || t.tla || t.name || "", crest: t.crest ?? "" }
        : null;

    const STAGES = [
      { stage: "LAST_16", key: "r16", label: "Round of 16", size: 8 },
      { stage: "QUARTER_FINALS", key: "qf", label: "Quarter-finals", size: 4 },
      { stage: "SEMI_FINALS", key: "sf", label: "Semi-finals", size: 2 },
      { stage: "FINAL", key: "final", label: "Final", size: 1 },
    ];

    // Group each stage's matches into ties by unordered team pair.
    const tiesByStage: Tie[][] = STAGES.map(({ stage }) => {
      const byPair = new Map<string, Tie>();
      for (const m of matches) {
        if (m.stage !== stage) continue;
        const h = team(m.homeTeam);
        const a = team(m.awayTeam);
        if (!h || !a) continue;
        const key = [h.id, a.id].sort((x, y) => x - y).join("-");
        const when = new Date(m.utcDate ?? 0).getTime();
        if (!byPair.has(key)) byPair.set(key, { a: h, b: a, matches: [], firstDate: when });
        const tie = byPair.get(key)!;
        tie.matches.push(m);
        tie.firstDate = Math.min(tie.firstDate, when);
      }
      return [...byPair.values()].sort((x, y) => x.firstDate - y.firstDate);
    });

    const hasData = tiesByStage.some((t) => t.length > 0);
    const tieContaining = (ties: Tie[], teamId: number): Tie | null =>
      ties.find((t) => t.a.id === teamId || t.b.id === teamId) ?? null;

    // Slot arrays sized to the bracket, filled null (TBD) by default.
    const ordered: (Tie | null)[][] = STAGES.map((s) => Array(s.size).fill(null));

    // Anchor on the deepest round that has ties (usually the Final for a finished
    // season), then expand toward the Round of 16 by following feeder ties.
    let deepest = -1;
    for (let i = STAGES.length - 1; i >= 0; i--) {
      if (tiesByStage[i].length) { deepest = i; break; }
    }
    if (deepest >= 0) {
      tiesByStage[deepest].forEach((tie, i) => {
        if (i < ordered[deepest].length) ordered[deepest][i] = tie;
      });
      for (let r = deepest; r >= 1; r--) {
        ordered[r].forEach((tie, j) => {
          if (!tie) return;
          ordered[r - 1][2 * j] = tieContaining(tiesByStage[r - 1], tie.a.id);
          ordered[r - 1][2 * j + 1] = tieContaining(tiesByStage[r - 1], tie.b.id);
        });
      }
    }

    const pub = (t: Team): UclBracketTeam => ({ name: t.name, short: t.short, crest: t.crest });
    const toMatch = (
      tie: Tie | null,
      nextTies: Tie[],
      isFinal: boolean,
    ): UclBracketMatch => {
      if (!tie) return { a: null, b: null, winner: null };
      let winner: "a" | "b" | null = null;
      if (isFinal) {
        const m = tie.matches[0];
        const w = m?.score?.winner;
        if (w === "HOME_TEAM") winner = tie.a.id === m.homeTeam?.id ? "a" : "b";
        else if (w === "AWAY_TEAM") winner = tie.a.id === m.awayTeam?.id ? "a" : "b";
      } else {
        const nextIds = new Set(nextTies.flatMap((t) => [t.a.id, t.b.id]));
        winner = nextIds.has(tie.a.id) ? "a" : nextIds.has(tie.b.id) ? "b" : null;
      }
      return { a: pub(tie.a), b: pub(tie.b), winner };
    };

    const rounds: UclBracketRound[] = STAGES.map((s, idx) => ({
      key: s.key,
      label: s.label,
      matches: ordered[idx].map((tie) =>
        toMatch(tie, tiesByStage[idx + 1] ?? [], idx === STAGES.length - 1),
      ),
    }));

    const finalMatch = rounds[rounds.length - 1].matches[0];
    const decided = !!finalMatch && finalMatch.winner !== null;

    const result: UclBracket = {
      updatedAt: new Date().toISOString(),
      season: season ? String(season) : null,
      hasData,
      decided,
      rounds,
    };
    if (hasData) await this.redis.setJsonEx(cacheKey, CACHE_TTL_SEC, result);
    return result;
  }

  /** Upcoming knockout ties (R16 → Final) within the next `daysAhead` days,
   *  grouped by team pair so a two-legged tie is a single entry. Used by the
   *  keeper to create one "who advances" market per tie. */
  async getUpcomingKnockoutTies(daysAhead: number): Promise<
    Array<{
      stage: string;
      a: { id: number; name: string; crest: string };
      b: { id: number; name: string; crest: string };
      firstKickoff: string;
    }>
  > {
    const override = this.config.get<string>("UCL_SEASON");
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const from = new Date();
    const to = new Date(from.getTime() + daysAhead * 86_400_000);
    const path = `competitions/CL/matches?status=SCHEDULED,TIMED&dateFrom=${day(from)}&dateTo=${day(to)}${override ? `&season=${override}` : ""}`;
    const data = await this.footballData<any>(path);
    const KO = new Set(["LAST_16", "QUARTER_FINALS", "SEMI_FINALS", "FINAL"]);
    const byPair = new Map<
      string,
      { stage: string; a: any; b: any; firstKickoff: string }
    >();
    for (const m of data?.matches ?? []) {
      if (!KO.has(m.stage)) continue;
      const h = m.homeTeam;
      const a = m.awayTeam;
      if (!h?.id || !a?.id) continue;
      const key = [h.id, a.id].sort((x, y) => x - y).join("-") + ":" + m.stage;
      const when = m.utcDate ?? "";
      const entry = byPair.get(key);
      if (!entry) {
        byPair.set(key, {
          stage: m.stage,
          a: { id: h.id, name: h.name ?? "", crest: h.crest ?? "" },
          b: { id: a.id, name: a.name ?? "", crest: a.crest ?? "" },
          firstKickoff: when,
        });
      } else if (when && when < entry.firstKickoff) {
        entry.firstKickoff = when;
      }
    }
    return [...byPair.values()].filter((t) => t.a.name && t.b.name && t.firstKickoff);
  }

  async getStats(): Promise<UclStats> {
    const cacheKey = "oro:ucl:stats";
    const cached = await this.redis.getJson<UclStats>(cacheKey);
    if (cached) return cached;

    // Goals & assists → football-data.org CL /scorers (goal-ranked, carries
    // assists). Cards are unavailable for CL on the free tier → empty boards.
    const scorers = await this.fetchScorers();

    const scorerEntry = (s: any, value: number): UclStatEntry => ({
      player: s.player?.name ?? "",
      club: s.team?.shortName ?? s.team?.name ?? "",
      clubBadge: s.team?.crest ?? "",
      face: "",
      faceBackup: "", // filled in after the boards are built
      value,
    });
    const scorerBoard = (pick: "goals" | "assists"): UclStatEntry[] =>
      scorers
        .map((s) => scorerEntry(s, num(s[pick])))
        .filter((e) => e.value > 0 && e.player)
        .sort((a, b) => b.value - a.value)
        .slice(0, TOP_N);

    const result: UclStats = {
      updatedAt: new Date().toISOString(),
      goals: scorerBoard("goals"),
      assists: scorerBoard("assists"),
      yellow: [],
      red: [],
    };

    // Resolve a secondary photo (TheSportsDB) per player for the client avatars.
    const allEntries = [result.goals, result.assists].flat();
    const uniqueNames = [...new Set(allEntries.map((e) => e.player))];
    const backups = new Map<string, string>();
    await this.mapWithConcurrency(uniqueNames, 5, async (name) => {
      backups.set(name, await this.faceBackup(name));
    });
    for (const e of allEntries) e.faceBackup = backups.get(e.player) ?? "";

    if (scorers.length > 0) {
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
    const workers = Array.from(
      { length: Math.min(limit, queue.length) },
      async () => {
        while (queue.length) {
          const item = queue.shift();
          if (item !== undefined) await fn(item);
        }
      },
    );
    await Promise.all(workers);
  }

  /** Secondary player photo via TheSportsDB (cutout, else thumbnail). Cached in
   *  Redis for 7 days. Returns "" when unavailable. */
  private async faceBackup(name: string): Promise<string> {
    const norm = normTokens(name).join(" ");
    if (!norm) return "";
    const cacheKey = `oro:ucl:facebk:${norm}`;
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
      await this.redis.setJsonEx(cacheKey, 7 * 24 * 3600, url);
      return url;
    } catch (err: any) {
      clearTimeout(timeout);
      this.logger.warn(`TheSportsDB ${name} failed: ${err.message}`);
      return "";
    }
  }
}
