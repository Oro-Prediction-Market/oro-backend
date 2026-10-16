import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RedisService } from "../redis/redis.service";
import {
  ESPN_NBA_SITE,
  ESPN_NBA_STANDINGS,
  NbaGame,
  addDays,
  bhutanDate,
  espnDatesFor,
  fetchEspnJson,
  parseEspnGame,
} from "./espn-nba.util";

export interface NbaStandingRow {
  seed: number;
  teamId: string;
  team: string;
  abbr: string;
  logo: string | null;
  w: number;
  l: number;
  pct: string;
  gb: string;
  streak: string;
  l10: string;
  home: string;
  road: string;
}

export interface NbaStandings {
  updatedAt: string;
  season: number;
  conferences: { name: string; table: NbaStandingRow[] }[];
}

/** Longest range one /nba/games request may ask for. */
export const NBA_MAX_DAYS = 14;
const STANDINGS_TTL_SEC = 30 * 60;

/**
 * How long one ESPN scoreboard day may be served from cache.
 *
 *   - a game in progress: 60 s, so the hub's live score keeps up;
 *   - a game starting within the hour: 60 s, so it flips to live promptly;
 *   - every game final: 6 h (a finished day barely changes);
 *   - otherwise (all ahead): 15 min — tip-off times move rarely.
 */
export function dayCacheTtlSec(games: NbaGame[], now = Date.now()): number {
  if (games.some((g) => g.state === "in")) return 60;
  const soon = games.some(
    (g) => g.state === "pre" && Date.parse(g.tipoff) - now < 60 * 60 * 1000,
  );
  if (soon) return 60;
  if (games.length && games.every((g) => g.state === "post"))
    return 6 * 60 * 60;
  return 15 * 60;
}

/** Turn ESPN's standings response into two seeded conference tables. */
export function parseStandings(body: any, season: number): NbaStandings | null {
  const groups: any[] = body?.children ?? [];
  const conferences = groups
    .map((g) => {
      const entries: any[] = g?.standings?.entries ?? [];
      const table = entries
        .map((e): NbaStandingRow | null => {
          const t = e?.team;
          if (!t?.id) return null;
          const stat = (name: string) =>
            (e.stats ?? []).find((s: any) => s?.name === name);
          const n = (name: string) => Number(stat(name)?.value ?? 0) || 0;
          const s = (name: string) => String(stat(name)?.displayValue ?? "-");
          return {
            seed: n("playoffSeed"),
            teamId: String(t.id),
            team: String(t.displayName ?? ""),
            abbr: String(t.abbreviation ?? ""),
            logo: t.logos?.[0]?.href ?? null,
            w: n("wins"),
            l: n("losses"),
            pct: s("winPercent"),
            gb: s("gamesBehind"),
            streak: s("streak"),
            l10: s("Last Ten Games"),
            home: s("Home"),
            road: s("Road"),
          };
        })
        .filter((r): r is NbaStandingRow => r !== null)
        // ESPN's seed order. Before the season every seed is 0, so fall back
        // to wins, then name, rather than ESPN's arbitrary order.
        .sort(
          (a, b) =>
            (a.seed || 99) - (b.seed || 99) ||
            b.w - a.w ||
            a.team.localeCompare(b.team),
        );
      return { name: String(g?.name ?? ""), table };
    })
    .filter((c) => c.table.length > 0);
  if (!conferences.length) return null;
  return { updatedAt: new Date().toISOString(), season, conferences };
}

/**
 * NBA reference data — the schedule with live scores, and the conference
 * standings — from ESPN's public site API, cached in Redis. Markets are made
 * and settled by NbaJobsService; this class only reads.
 */
@Injectable()
export class NbaService {
  private readonly logger = new Logger(NbaService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  /** The season ESPN files 2026-27 under: the year it ends in. */
  season(): number {
    return Number(this.config.get<string>("NBA_SEASON") ?? 2027);
  }

  private async cached<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  private async cache(key: string, ttl: number, value: unknown): Promise<void> {
    try {
      await this.redis.setEx(key, ttl, JSON.stringify(value));
    } catch {
      /* cache is best-effort */
    }
  }

  /** Every game ESPN files under one US date (YYYYMMDD). */
  async getEspnDay(yyyymmdd: string): Promise<NbaGame[]> {
    const key = `oro:nba:day:${yyyymmdd}`;
    const hit = await this.cached<NbaGame[]>(key);
    if (hit) return hit;
    const body = await fetchEspnJson<any>(
      `${ESPN_NBA_SITE}/scoreboard?dates=${yyyymmdd}`,
    );
    if (!body) {
      this.logger.warn(`ESPN scoreboard ${yyyymmdd} unavailable`);
      return [];
    }
    const games = (body.events ?? [])
      .map((e: any) => parseEspnGame(e))
      .filter((g: NbaGame | null): g is NbaGame => g !== null);
    await this.cache(key, dayCacheTtlSec(games), games);
    return games;
  }

  /**
   * Games whose Bhutan date is in [from, from + days), in tip-off order.
   * `from` defaults to yesterday in Bhutan, so last night's results show.
   */
  async getGames(from?: string, days = 9): Promise<NbaGame[]> {
    const start = from ?? addDays(bhutanDate(new Date()), -1);
    const span = Math.min(Math.max(Math.floor(days) || 1, 1), NBA_MAX_DAYS);
    const end = addDays(start, span);
    const perDay = await Promise.all(
      espnDatesFor(start, span).map((d) => this.getEspnDay(d)),
    );
    const byId = new Map<string, NbaGame>();
    for (const g of perDay.flat()) {
      const day = bhutanDate(g.tipoff);
      if (day >= start && day < end) byId.set(g.id, g);
    }
    return [...byId.values()].sort(
      (a, b) => Date.parse(a.tipoff) - Date.parse(b.tipoff),
    );
  }

  async getStandings(): Promise<NbaStandings> {
    const season = this.season();
    const key = `oro:nba:standings:${season}`;
    const hit = await this.cached<NbaStandings>(key);
    if (hit) return hit;
    const body = await fetchEspnJson<any>(
      `${ESPN_NBA_STANDINGS}?season=${season}&seasontype=2`,
    );
    const parsed = parseStandings(body, season);
    if (!parsed) {
      this.logger.warn("ESPN standings unavailable");
      return { updatedAt: new Date().toISOString(), season, conferences: [] };
    }
    await this.cache(key, STANDINGS_TTL_SEC, parsed);
    return parsed;
  }
}
