import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { StatOverridesService } from "../stat-overrides/stat-overrides.service";
import { StatBoardOverride } from "../entities/stat-board-override.entity";
import { UnlTeam } from "../entities/unl-team.entity";
import { UnlFixture } from "../entities/unl-fixture.entity";
import {
  computeGroupTable,
  UnlStandingRow,
} from "../markets/unl-standings.util";

/**
 * UEFA Nations League reference data.
 *
 * Unlike {@link EplService} and {@link UclService}, there is no provider behind
 * this one. Our football-data.org plan does not include the competition
 * (`GET /v4/competitions/UNL` → 403), so `unl_teams` and `unl_fixtures` ARE the
 * source: an admin types a score in once, and both the group table and the
 * match result are read off that same row. They cannot drift apart because
 * there is only one of them.
 *
 * **Nothing here is cached, and that is deliberate.** EPL and UCL cache for an
 * hour because their provider only changes hourly and the free tier is rate
 * limited. Neither applies here: this is two indexed queries against our own
 * Postgres, and the data changes the instant an admin saves. An hour-stale
 * group table after a score correction would be a support ticket, and a cache
 * that must be explicitly busted on every write is a bug waiting for the one
 * write path that forgets. The 30-second market cache already taught us that
 * lesson once — a corrected result that still read as uncorrected.
 *
 * These tables are **display-only**. No market settles from them. See
 * `unl-standings.util.ts` before that ever changes.
 */

const TOP_N = 15;

export interface UnlGroupTable {
  /** "A" … "N". */
  groupKey: string;
  table: UnlStandingRow[];
}

export interface UnlStandings {
  updatedAt: string;
  /** The edition these groups belong to, e.g. "2026-27". Null when none exists. */
  season: string | null;
  groups: UnlGroupTable[];
}

/** Structurally identical to `EplStatEntry`, so the app's board markup is a copy. */
export interface UnlStatEntry {
  player: string;
  club: string;
  clubBadge: string;
  face: string;
  faceBackup: string;
  value: number;
}

export interface UnlStats {
  updatedAt: string;
  goals: UnlStatEntry[];
  assists: UnlStatEntry[];
  /** Always empty — there is no card data for this competition, manual or otherwise. */
  yellow: UnlStatEntry[];
  red: UnlStatEntry[];
}

export interface UnlSeasonInfo {
  started: boolean;
  seasonStart: string | null;
  maxPlayed: number;
  /** The edition, e.g. "2026-27". Null before any teams are entered. */
  season: string | null;
  groupCount: number;
  teamCount: number;
}

@Injectable()
export class UnlService {
  private readonly logger = new Logger(UnlService.name);

  constructor(
    @InjectRepository(UnlTeam)
    private readonly teamRepo: Repository<UnlTeam>,
    @InjectRepository(UnlFixture)
    private readonly fixtureRepo: Repository<UnlFixture>,
    private readonly statOverrides: StatOverridesService,
    private readonly config: ConfigService,
  ) {}

  /**
   * The edition to serve.
   *
   * `MAX(season)` rather than a date window: editions are written as
   * "2026-27", which sorts correctly as text for any edition this century, and
   * the newest rows in the table are by definition the current competition.
   * `UNL_SEASON` pins it explicitly, which is what you want during the weeks
   * either side of a changeover when both editions exist.
   */
  async currentSeason(): Promise<string | null> {
    const pinned = this.config.get<string>("UNL_SEASON");
    if (pinned) return pinned;
    const row = await this.teamRepo
      .createQueryBuilder("t")
      .select("MAX(t.season)", "season")
      .getRawOne<{ season: string | null }>();
    return row?.season ?? null;
  }

  /**
   * Every group's table, ordered A → N.
   *
   * Teams come from `unl_teams`, never from the fixtures, so all four nations
   * in a group show on zero before a ball is kicked — which is what the group
   * screens display for most of a Nations League cycle.
   */
  async getStandings(season?: string): Promise<UnlStandings> {
    const target = season ?? (await this.currentSeason());
    if (!target) {
      return { updatedAt: new Date().toISOString(), season: null, groups: [] };
    }

    const [teams, fixtures] = await Promise.all([
      this.teamRepo.find({ where: { season: target } }),
      this.fixtureRepo.find({ where: { season: target } }),
    ]);

    const teamsByGroup = new Map<string, UnlTeam[]>();
    for (const t of teams) {
      if (!teamsByGroup.has(t.groupKey)) teamsByGroup.set(t.groupKey, []);
      teamsByGroup.get(t.groupKey)!.push(t);
    }
    const fixturesByGroup = new Map<string, UnlFixture[]>();
    for (const f of fixtures) {
      if (!fixturesByGroup.has(f.groupKey)) fixturesByGroup.set(f.groupKey, []);
      fixturesByGroup.get(f.groupKey)!.push(f);
    }

    const groups: UnlGroupTable[] = [...teamsByGroup.keys()]
      .sort((a, b) => a.localeCompare(b))
      .map((groupKey) => ({
        groupKey,
        // computeGroupTable ignores any fixture naming a team outside the list
        // it was given, so a mis-keyed row cannot leak into another group's
        // table even if one were somehow written.
        table: computeGroupTable(
          teamsByGroup.get(groupKey)!,
          fixturesByGroup.get(groupKey) ?? [],
        ),
      }));

    // The most recent write to either table, so the client can say how fresh
    // this is without us inventing a timestamp that is always "now".
    const touched = [...teams, ...fixtures].map((r) => r.updatedAt.getTime());
    const updatedAt = touched.length
      ? new Date(Math.max(...touched)).toISOString()
      : new Date().toISOString();

    return { updatedAt, season: target, groups };
  }

  /**
   * Goals and assists.
   *
   * Both boards are entirely admin-entered — unlike EPL and UCL, where the
   * provider supplies goals and only assists are manual. Empty boards are the
   * correct answer until an admin fills them, not an error.
   */
  async getStats(): Promise<UnlStats> {
    const overrides: StatBoardOverride[] = await this.statOverrides
      .list("unl")
      .catch((e) => {
        this.logger.warn(`UNL stat overrides unavailable: ${(e as Error).message}`);
        return [];
      });

    const board = (key: "goals" | "assists") =>
      this.statOverrides.buildManualBoard<UnlStatEntry>(
        overrides.filter((o) => o.board === key),
        TOP_N,
      );

    return {
      updatedAt: new Date().toISOString(),
      goals: board("goals"),
      assists: board("assists"),
      yellow: [],
      red: [],
    };
  }

  /**
   * Whether the competition is underway, for the hub's empty states.
   *
   * "Started" means a result has actually been entered, not that a kickoff time
   * has passed. A fixture list loaded weeks early would otherwise report the
   * competition as running while every table still reads nil.
   */
  async getSeasonInfo(): Promise<UnlSeasonInfo> {
    const season = await this.currentSeason();
    if (!season) {
      return {
        started: false,
        seasonStart: null,
        maxPlayed: 0,
        season: null,
        groupCount: 0,
        teamCount: 0,
      };
    }

    const [fixtures, teams] = await Promise.all([
      this.fixtureRepo.find({ where: { season } }),
      this.teamRepo.find({ where: { season } }),
    ]);

    const played = fixtures.filter(
      (f) => typeof f.homeScore === "number" && typeof f.awayScore === "number",
    );
    const kickoffs = fixtures.map((f) => f.kickoffAt.getTime());

    return {
      started: played.length > 0,
      seasonStart: kickoffs.length
        ? new Date(Math.min(...kickoffs)).toISOString()
        : null,
      maxPlayed: played.reduce((max, f) => Math.max(max, f.matchday ?? 0), 0),
      season,
      groupCount: new Set(teams.map((t) => t.groupKey)).size,
      teamCount: teams.length,
    };
  }

  /**
   * Fixtures kicking off within `daysAhead`, for the market-creation cron.
   *
   * Only fixtures with no market yet, and never one whose kickoff has already
   * passed — a market created for a played match would take bets on a known
   * result for the minute before the expiry cron closes it.
   */
  async getUpcomingFixtures(daysAhead: number): Promise<UnlFixture[]> {
    const season = await this.currentSeason();
    if (!season) return [];
    const now = new Date();
    const until = new Date(now.getTime() + daysAhead * 86_400_000);
    return this.fixtureRepo
      .createQueryBuilder("f")
      .where("f.season = :season", { season })
      .andWhere("f.marketId IS NULL")
      .andWhere("f.kickoffAt > :now", { now })
      .andWhere("f.kickoffAt <= :until", { until })
      .orderBy("f.kickoffAt", "ASC")
      .getMany();
  }
}
