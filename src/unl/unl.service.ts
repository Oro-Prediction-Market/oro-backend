import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { In, IsNull, Not, Repository } from "typeorm";
import { StatOverridesService } from "../stat-overrides/stat-overrides.service";
import { StatBoardOverride } from "../entities/stat-board-override.entity";
import { UnlTeam } from "../entities/unl-team.entity";
import { UnlFixture, UnlFixtureStatus } from "../entities/unl-fixture.entity";
import { Market, MarketStatus } from "../entities/market.entity";
import { MarketsService } from "../markets/markets.service";
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
    @InjectRepository(Market)
    private readonly marketRepo: Repository<Market>,
    private readonly marketsService: MarketsService,
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

  // ══ Admin ══════════════════════════════════════════════════════════════════
  //
  // Everything below is behind JwtAuthGuard + AdminGuard on the controller.
  //
  // There is no cron in this competition, on purpose. EPL and UCL create their
  // markets from a provider feed on a schedule because a feed is what tells
  // them a fixture exists. Here an admin is the feed: they enter the fixture,
  // then press a button to create its market. A cron would add a moving part
  // between those two steps for no gain, and a second thing that writes
  // markets is a second thing to exclude from settlement.

  // ── Teams ────────────────────────────────────────────────────────────────

  async listTeams(season?: string): Promise<UnlTeam[]> {
    const target = season ?? (await this.currentSeason());
    if (!target) return [];
    return this.teamRepo.find({
      where: { season: target },
      order: { groupKey: "ASC", sortOrder: "ASC", name: "ASC" },
    });
  }

  async createTeam(input: {
    season: string;
    groupKey: string;
    name: string;
    flagUrl?: string | null;
    sortOrder?: number;
  }): Promise<UnlTeam> {
    const season = requireText(input.season, "season");
    const groupKey = normaliseGroupKey(input.groupKey);
    const name = requireText(input.name, "name");

    const clash = await this.teamRepo.findOne({
      where: { season, groupKey, name },
    });
    if (clash) {
      throw new ConflictException(
        `${name} is already in Group ${groupKey} for ${season}.`,
      );
    }

    return this.teamRepo.save(
      this.teamRepo.create({
        season,
        groupKey,
        name,
        flagUrl: input.flagUrl?.trim() || null,
        sortOrder: Number.isFinite(input.sortOrder) ? Number(input.sortOrder) : 0,
      }),
    );
  }

  async updateTeam(
    id: string,
    input: { name?: string; flagUrl?: string | null; sortOrder?: number; groupKey?: string },
  ): Promise<UnlTeam> {
    const team = await this.teamRepo.findOne({ where: { id } });
    if (!team) throw new NotFoundException("Team not found");

    // A rename after markets exist would leave the market's outcome labels
    // saying one thing and the table another. Outcome labels are the market's
    // contract with the people holding positions, so the rename is refused
    // rather than quietly applied to only one of the two.
    if (input.name !== undefined && input.name.trim() !== team.name) {
      const live = await this.fixtureRepo.count({
        where: [
          { homeTeamId: id, marketId: Not(IsNull()) },
          { awayTeamId: id, marketId: Not(IsNull()) },
        ],
      });
      if (live > 0) {
        throw new BadRequestException(
          `${team.name} already has ${live} market(s) carrying this name as an ` +
            `outcome label. Renaming here would leave the markets and the table ` +
            `disagreeing — cancel and refund those markets first.`,
        );
      }
      team.name = requireText(input.name, "name");
    }
    if (input.groupKey !== undefined) team.groupKey = normaliseGroupKey(input.groupKey);
    if (input.flagUrl !== undefined) team.flagUrl = input.flagUrl?.trim() || null;
    if (input.sortOrder !== undefined) team.sortOrder = Number(input.sortOrder) || 0;

    return this.teamRepo.save(team);
  }

  async deleteTeam(id: string): Promise<void> {
    const used = await this.fixtureRepo.count({
      where: [{ homeTeamId: id }, { awayTeamId: id }],
    });
    if (used > 0) {
      throw new BadRequestException(
        `This team appears in ${used} fixture(s). Delete those first.`,
      );
    }
    await this.teamRepo.delete(id);
  }

  // ── Fixtures ─────────────────────────────────────────────────────────────

  async listFixtures(season?: string): Promise<UnlFixture[]> {
    const target = season ?? (await this.currentSeason());
    if (!target) return [];
    return this.fixtureRepo.find({
      where: { season: target },
      order: { kickoffAt: "ASC" },
    });
  }

  async createFixture(input: {
    season: string;
    homeTeamId: string;
    awayTeamId: string;
    kickoffAt: string;
    matchday?: number | null;
  }): Promise<UnlFixture> {
    const season = requireText(input.season, "season");
    const { home, away } = await this.loadPair(
      season,
      input.homeTeamId,
      input.awayTeamId,
    );
    const kickoffAt = parseDate(input.kickoffAt, "kickoffAt");

    // Same pairing on the same matchday is a double entry, not a real fixture.
    // Teams DO meet twice over a campaign, so the matchday is part of the key.
    const matchday = input.matchday == null ? null : Number(input.matchday);
    const dup = await this.fixtureRepo.findOne({
      where: {
        season,
        homeTeamId: home.id,
        awayTeamId: away.id,
        ...(matchday == null ? {} : { matchday }),
      },
    });
    if (dup) {
      throw new ConflictException(
        `${home.name} v ${away.name} already exists` +
          (matchday == null ? "" : ` on matchday ${matchday}`) +
          `.`,
      );
    }

    return this.fixtureRepo.save(
      this.fixtureRepo.create({
        season,
        groupKey: home.groupKey,
        homeTeamId: home.id,
        awayTeamId: away.id,
        kickoffAt,
        // Null, never 0 — see the entity docstring.
        homeScore: null,
        awayScore: null,
        status: UnlFixtureStatus.SCHEDULED,
        matchday,
      }),
    );
  }

  async updateFixture(
    id: string,
    input: { kickoffAt?: string; matchday?: number | null },
  ): Promise<UnlFixture> {
    const fixture = await this.mustFindFixture(id);

    if (input.matchday !== undefined) {
      fixture.matchday = input.matchday == null ? null : Number(input.matchday);
    }

    if (input.kickoffAt !== undefined) {
      const kickoffAt = parseDate(input.kickoffAt, "kickoffAt");
      if (fixture.marketId) {
        const market = await this.marketRepo.findOne({
          where: { id: fixture.marketId },
        });
        // Betting closes at kickoff, so a moved kickoff has to move the market
        // or the two disagree about when you can still bet.
        if (
          market &&
          (market.status === MarketStatus.UPCOMING ||
            market.status === MarketStatus.OPEN)
        ) {
          await this.marketsService.update(market.id, {
            closesAt: kickoffAt.toISOString(),
          } as any);
        } else if (market) {
          // There is no supported way back from CLOSED for this subcategory
          // (reopenMarket is gated to wc-*), so betting would stay frozen at
          // the old time whatever we wrote here.
          throw new BadRequestException(
            `This fixture's market is already ${market.status}, so its betting ` +
              `deadline can no longer be moved. Cancel and refund it if the ` +
              `kickoff has genuinely changed.`,
          );
        }
      }
      fixture.kickoffAt = kickoffAt;
    }

    return this.fixtureRepo.save(fixture);
  }

  async deleteFixture(id: string): Promise<void> {
    const fixture = await this.mustFindFixture(id);
    if (fixture.marketId) {
      throw new BadRequestException(
        "This fixture has a market. Cancel and refund the market first — " +
          "deleting the fixture would leave it with nothing to settle against.",
      );
    }
    await this.fixtureRepo.delete(id);
  }

  /**
   * Enter or correct a score.
   *
   * Deliberately has NO market side effects. Proposing is a separate, explicit
   * action, which is what makes a typo free to fix: the admin corrects the
   * number and nothing has happened yet.
   *
   * Returns a `warning` when the score now disagrees with a market that has
   * already settled. `SETTLED` is terminal — the two EPL corrections in
   * September needed direct SQL — so the fixture is updated (the table must
   * self-correct) and the market is left alone and reported. Silence here is
   * how a wrong settlement goes unnoticed for fifteen days.
   */
  async setScore(
    id: string,
    input: { homeScore: number | null; awayScore: number | null; status?: string },
  ): Promise<{ fixture: UnlFixture; warning: string | null }> {
    const fixture = await this.mustFindFixture(id);

    const bothNull = input.homeScore == null && input.awayScore == null;
    const bothSet = input.homeScore != null && input.awayScore != null;
    if (!bothNull && !bothSet) {
      // The same rule the CHECK constraint enforces and the standings code
      // relies on: a half-entered scoreline is not a state this has.
      throw new BadRequestException(
        "Enter both scores or neither. A half-entered scoreline cannot be stored.",
      );
    }

    const home = bothSet ? toScore(input.homeScore, "homeScore") : null;
    const away = bothSet ? toScore(input.awayScore, "awayScore") : null;

    const status = input.status
      ? parseFixtureStatus(input.status)
      : bothSet
        ? UnlFixtureStatus.FINISHED
        : UnlFixtureStatus.SCHEDULED;

    if (
      bothNull &&
      (status === UnlFixtureStatus.FINISHED || status === UnlFixtureStatus.AWARDED)
    ) {
      throw new BadRequestException(
        `A ${status} fixture needs a score. Use "postponed" to clear one.`,
      );
    }

    fixture.homeScore = home;
    fixture.awayScore = away;
    fixture.status = status;
    await this.fixtureRepo.save(fixture);

    const warning = await this.settledDisagreementWarning(fixture);
    if (warning) this.logger.warn(`[UNL] ${warning}`);

    return { fixture, warning };
  }

  /**
   * Does this score now contradict a market that has already been settled?
   *
   * Compares the frozen market against the still-editable fixture row. This is
   * the whole UNL audit: no API call, one lookup, and it catches the case the
   * three-layer football guard cannot — a result corrected AFTER settlement.
   */
  private async settledDisagreementWarning(
    fixture: UnlFixture,
  ): Promise<string | null> {
    if (!fixture.marketId) return null;
    const market = await this.marketRepo.findOne({
      where: { id: fixture.marketId },
      relations: ["outcomes"],
    });
    if (!market) return null;
    if (
      market.status !== MarketStatus.RESOLVED &&
      market.status !== MarketStatus.SETTLED
    ) {
      return null;
    }

    const shouldWin = this.outcomeIdForScore(fixture);
    if (!shouldWin) return null;
    const settledAs = market.resolvedOutcomeId;
    if (!settledAs || settledAs === shouldWin) return null;

    const label = (oid: string | null) =>
      market.outcomes?.find((o) => o.id === oid)?.label ?? oid ?? "unknown";
    return (
      `Market ${market.id} ("${market.title}") settled as "${label(settledAs)}", ` +
      `but the score now reads ${fixture.homeScore}-${fixture.awayScore}, which is ` +
      `"${label(shouldWin)}". A settled market cannot be re-resolved through the ` +
      `app — this needs a manual correction.`
    );
  }

  /**
   * The winning outcome id for a fixture's score.
   *
   * Two integers compared, returning one of three ids stamped on the row when
   * the market was created. **No string ever touches this path.** The keeper's
   * generic `resolveOutcome` falls back to two-directional substring matching,
   * and this competition fields Republic of Ireland AND Northern Ireland —
   * that fallback would pick the wrong nation with complete confidence.
   */
  outcomeIdForScore(fixture: UnlFixture): string | null {
    if (typeof fixture.homeScore !== "number") return null;
    if (typeof fixture.awayScore !== "number") return null;
    if (fixture.homeScore > fixture.awayScore) return fixture.homeOutcomeId;
    if (fixture.homeScore < fixture.awayScore) return fixture.awayOutcomeId;
    return fixture.drawOutcomeId;
  }

  // ── Markets ──────────────────────────────────────────────────────────────

  /**
   * Create the match market for one fixture, and stamp it back onto the row.
   *
   * Dedupe is on `metadata.unlFixtureId`, not on `fixture.marketId`: the market
   * commits before the fixture row can be stamped, so a crash between the two
   * would otherwise let the next attempt build a second market for the same
   * match. The `marketId` column is the convenient direction to read, and its
   * UNIQUE constraint is what stops the two disagreeing.
   */
  async createMarketForFixture(fixtureId: string): Promise<Market> {
    const fixture = await this.mustFindFixture(fixtureId);

    const orphan = await this.marketRepo
      .createQueryBuilder("m")
      .where("m.metadata->>'unlFixtureId' = :id", { id: fixture.id })
      .getOne();
    if (orphan) {
      // Re-stamp rather than build a second one — this is the crash-in-between
      // case, and the market it left behind is perfectly good.
      await this.stampFixture(fixture, orphan);
      throw new ConflictException(
        `A market for this fixture already exists (${orphan.id}). Re-linked it to the fixture.`,
      );
    }

    if (fixture.kickoffAt.getTime() <= Date.now()) {
      // Betting would be open on a known result for the minute before the
      // expiry cron closes it — and the keeper deliberately will not close a
      // market in the same tick it opened it.
      throw new BadRequestException(
        "This fixture has already kicked off. A market created now would take " +
          "bets on a match that is under way or finished.",
      );
    }

    const [home, away] = await Promise.all([
      this.teamRepo.findOne({ where: { id: fixture.homeTeamId } }),
      this.teamRepo.findOne({ where: { id: fixture.awayTeamId } }),
    ]);
    if (!home || !away) throw new NotFoundException("Fixture's teams not found");

    const market = await this.marketsService.create({
      title: `${home.name} vs ${away.name}`,
      description: "UEFA Nations League — who wins the match?",
      category: "sports",
      subcategory: "unl-match",
      // externalMatchId is deliberately LEFT UNSET. runAutoProposal selects on
      // `externalMatchId IS NOT NULL`, so an unset id is what keeps these
      // markets out of the football-data auto-proposal path entirely. Do not
      // "fix" this by adding one.
      externalSource: "unl-manual",
      externalMarketType: "match-winner",
      settlementSource: "Official UEFA Nations League result",
      unlFixtureId: fixture.id,
      matchday: fixture.matchday ?? undefined,
      matchLabel: `Group ${fixture.groupKey}${fixture.matchday ? ` · Matchday ${fixture.matchday}` : ""}`,
      opensAt: new Date().toISOString(),
      closesAt: fixture.kickoffAt.toISOString(), // betting closes at kickoff
      resolutionCriteria:
        "Resolved to the full-time result (Home win / Draw / Away win) of the " +
        "official UEFA Nations League fixture. Extra time and penalties do not " +
        "apply to group-stage matches.",
      outcomes: [
        { label: home.name, imageUrl: home.flagUrl },
        { label: "Draw", imageUrl: null },
        { label: away.name, imageUrl: away.flagUrl },
      ],
    });

    await this.stampFixture(fixture, market);
    return market;
  }

  /** Create markets for every fixture kicking off within `days` that has none. */
  async createMarketsForWindow(
    days: number,
  ): Promise<{ created: string[]; skipped: { fixtureId: string; reason: string }[] }> {
    const fixtures = await this.getUpcomingFixtures(days);
    const created: string[] = [];
    const skipped: { fixtureId: string; reason: string }[] = [];
    for (const f of fixtures) {
      try {
        const m = await this.createMarketForFixture(f.id);
        created.push(m.id);
      } catch (e) {
        skipped.push({ fixtureId: f.id, reason: (e as Error).message });
      }
    }
    return { created, skipped };
  }

  /**
   * Store the market on the fixture, including its three outcome ids.
   *
   * The outcome ids are the reason settlement never has to read a team name.
   * They are matched by position, which is safe because `MarketsService.create`
   * preserves the order outcomes were given in as `sortOrder` — home, draw,
   * away, exactly as built above.
   */
  private async stampFixture(fixture: UnlFixture, market: Market): Promise<void> {
    const outcomes = [...(market.outcomes ?? [])].sort(
      (a, b) => a.sortOrder - b.sortOrder,
    );
    if (outcomes.length !== 3) {
      throw new BadRequestException(
        `Expected 3 outcomes on market ${market.id}, found ${outcomes.length}.`,
      );
    }
    fixture.marketId = market.id;
    fixture.homeOutcomeId = outcomes[0].id;
    fixture.drawOutcomeId = outcomes[1].id;
    fixture.awayOutcomeId = outcomes[2].id;
    await this.fixtureRepo.save(fixture);
  }

  /**
   * Propose this fixture's result, opening the objection window.
   *
   * The explicit, separate action that score entry deliberately is not. It
   * reads the winner from the stored outcome ids, so the only thing that
   * decides a payout is a comparison of two integers an admin typed in and
   * then had a chance to correct.
   */
  async proposeFixtureResult(
    fixtureId: string,
    windowMinutes = 60,
  ): Promise<{ marketId: string; outcomeId: string; outcomeLabel: string }> {
    const fixture = await this.mustFindFixture(fixtureId);

    if (!fixture.marketId) {
      throw new BadRequestException("This fixture has no market to propose on.");
    }
    if (typeof fixture.homeScore !== "number" || typeof fixture.awayScore !== "number") {
      throw new BadRequestException(
        "Enter the full-time score before proposing a result.",
      );
    }
    if (!fixture.homeOutcomeId || !fixture.drawOutcomeId || !fixture.awayOutcomeId) {
      // Without all three, the winner would have to be found by name — the one
      // thing this design exists to avoid.
      throw new BadRequestException(
        "This fixture is missing its stored outcome ids, so the winner cannot be " +
          "identified safely. Re-create the market for it.",
      );
    }

    const market = await this.marketRepo.findOne({
      where: { id: fixture.marketId },
      relations: ["outcomes"],
    });
    if (!market) throw new NotFoundException("Market not found");
    if (market.status !== MarketStatus.CLOSED) {
      throw new BadRequestException(
        `A result can only be proposed on a CLOSED market — this one is ` +
          `${market.status}. Betting closes automatically at kickoff.`,
      );
    }

    const outcomeId = this.outcomeIdForScore(fixture)!;
    await this.marketsService.proposeResolution(
      market.id,
      outcomeId,
      windowMinutes,
    );

    const outcomeLabel =
      market.outcomes?.find((o) => o.id === outcomeId)?.label ?? outcomeId;
    this.logger.log(
      `[UNL] proposed ${outcomeLabel} on ${market.id} from ${fixture.homeScore}-${fixture.awayScore}`,
    );
    return { marketId: market.id, outcomeId, outcomeLabel };
  }

  /** Markets for a set of fixtures, for annotating the admin fixtures list. */
  async marketsByFixture(fixtures: UnlFixture[]): Promise<Map<string, Market>> {
    const ids = fixtures.map((f) => f.marketId).filter((x): x is string => !!x);
    if (ids.length === 0) return new Map();
    const markets = await this.marketRepo.find({
      where: { id: In(ids) },
      relations: ["outcomes"],
    });
    return new Map(markets.map((m) => [m.id, m]));
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async mustFindFixture(id: string): Promise<UnlFixture> {
    const fixture = await this.fixtureRepo.findOne({ where: { id } });
    if (!fixture) throw new NotFoundException("Fixture not found");
    return fixture;
  }

  /** Both teams, checked to be real, distinct, and in the same group. */
  private async loadPair(
    season: string,
    homeTeamId: string,
    awayTeamId: string,
  ): Promise<{ home: UnlTeam; away: UnlTeam }> {
    if (!homeTeamId || !awayTeamId) {
      throw new BadRequestException("Both teams are required.");
    }
    if (homeTeamId === awayTeamId) {
      throw new BadRequestException("A team cannot play itself.");
    }
    const [home, away] = await Promise.all([
      this.teamRepo.findOne({ where: { id: homeTeamId } }),
      this.teamRepo.findOne({ where: { id: awayTeamId } }),
    ]);
    if (!home || !away) throw new NotFoundException("Team not found");
    if (home.season !== season || away.season !== season) {
      throw new BadRequestException(
        `Both teams must be in the ${season} edition.`,
      );
    }
    if (home.groupKey !== away.groupKey) {
      throw new BadRequestException(
        `${home.name} is in Group ${home.groupKey} and ${away.name} is in ` +
          `Group ${away.groupKey}. The group stage has no cross-group fixtures.`,
      );
    }
    return { home, away };
  }
}

// ── Input helpers ──────────────────────────────────────────────────────────

function requireText(value: string | undefined | null, field: string): string {
  const s = (value ?? "").trim();
  if (!s) throw new BadRequestException(`${field} is required.`);
  return s;
}

/** "a" and " A " are Group A; anything else is a typo worth catching here. */
function normaliseGroupKey(raw: string): string {
  const key = (raw ?? "").trim().toUpperCase();
  if (!/^[A-Z]$/.test(key)) {
    throw new BadRequestException(
      `Group must be a single letter, A–N. Got "${raw}".`,
    );
  }
  return key;
}

function parseDate(raw: string, field: string): Date {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException(`${field} is not a valid date.`);
  }
  return d;
}

/**
 * A goal count, read strictly.
 *
 * `Number("")` is 0 and `Number(null)` is 0, either of which would quietly
 * turn an empty box into a nil — the exact shape of the September bug, one
 * layer up from where the storage constraint catches it.
 */
function toScore(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new BadRequestException(`${field} must be a whole number, 0 or more.`);
  }
  if (value > 99) throw new BadRequestException(`${field} looks wrong (${value}).`);
  return value;
}

function parseFixtureStatus(raw: string): UnlFixtureStatus {
  const s = (raw ?? "").trim().toLowerCase();
  const all = Object.values(UnlFixtureStatus) as string[];
  if (!all.includes(s)) {
    throw new BadRequestException(`status must be one of: ${all.join(", ")}`);
  }
  return s as UnlFixtureStatus;
}
