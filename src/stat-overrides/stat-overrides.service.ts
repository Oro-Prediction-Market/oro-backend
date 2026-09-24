import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  StatBoardOverride,
  StatBoardKey,
  StatBoardLeague,
} from "../entities/stat-board-override.entity";
import { RedisService } from "../redis/redis.service";

/** The shape both leagues' boards share. */
export interface StatBoardEntry {
  player: string;
  club: string;
  clubBadge: string;
  face: string;
  faceBackup: string;
  value: number;
}

/** One board row as the admin page sees it: the live value, and the edit. */
export interface AdminBoardRow {
  player: string;
  club: string;
  face: string;
  /** What the board is actually showing, after any edit. */
  value: number;
  /** What the provider reports, or null when it does not carry this player. */
  feedValue: number | null;
  feedFace: string | null;
  /** The admin's row, when one exists. */
  overrideId: string | null;
  valueEdited: boolean;
  faceEdited: boolean;
  isManual: boolean;
}

/** Redis keys the leagues cache their built boards under. */
const STATS_CACHE_KEY: Record<StatBoardLeague, string> = {
  epl: "oro:epl:stats",
  ucl: "oro:ucl:stats",
  // The Nations League service caches nothing — it reads our own database, not
  // a rate-limited provider — so there is no key to bust. Present because the
  // Record is exhaustive; `bust("unl")` is a harmless no-op DEL.
  unl: "oro:unl:stats",
};

/**
 * Normalised player name, used for matching an edit against the feed.
 *
 * Accents are folded because the two sources disagree about them — a provider
 * writing "Kylian Mbappe" and an admin typing "Kylian Mbappé" are the same
 * player, and treating them as two would put him on the board twice.
 */
export function playerKeyOf(name: string): string {
  return (name ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Starting year of the football campaign that `now` falls in.
 *
 * Seasons run August–May, so anything from June onwards belongs to the
 * campaign starting that year. Matches the window `eplStatMarketCloseDate`
 * already uses, and keeps last season's edits from reappearing when the new
 * one kicks off.
 */
export function currentFootballSeason(now = new Date()): string {
  return String(now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1);
}

@Injectable()
export class StatOverridesService {
  private readonly logger = new Logger(StatOverridesService.name);

  constructor(
    @InjectRepository(StatBoardOverride)
    private readonly repo: Repository<StatBoardOverride>,
    private readonly redis: RedisService,
  ) {}

  list(
    league: StatBoardLeague,
    season = currentFootballSeason(),
  ): Promise<StatBoardOverride[]> {
    return this.repo.find({
      where: { league, season },
      order: { board: "ASC", player: "ASC" },
    });
  }

  /**
   * Record an admin's edit to one player.
   *
   * Only the fields present in `input` are written, so editing a photo leaves
   * the value following the feed and vice versa. Passing `null` for a field
   * clears it, handing that field back to the provider.
   */
  async upsert(input: {
    league: StatBoardLeague;
    board: StatBoardKey;
    player: string;
    club?: string | null;
    clubBadge?: string | null;
    face?: string | null;
    value?: number | null;
    isManual?: boolean;
    adminId?: string | null;
    season?: string;
  }): Promise<StatBoardOverride> {
    const season = input.season ?? currentFootballSeason();
    const playerKey = playerKeyOf(input.player);

    const patch: Partial<StatBoardOverride> = {
      updatedByAdminId: input.adminId ?? null,
    };
    if (input.club !== undefined) patch.club = input.club;
    if (input.clubBadge !== undefined) patch.clubBadge = input.clubBadge;
    if (input.face !== undefined) patch.face = input.face;
    if (input.value !== undefined) {
      patch.value =
        input.value === null ? null : Math.max(0, Math.round(input.value));
    }
    if (input.isManual !== undefined) patch.isManual = input.isManual;

    const existing = await this.repo.findOne({
      where: { league: input.league, board: input.board, season, playerKey },
    });

    if (existing) {
      await this.repo.update({ id: existing.id }, patch);
    } else {
      // Insert through the unique constraint rather than read-then-write: two
      // admins saving the same player at once would otherwise both see "not
      // there" and insert.
      await this.repo
        .createQueryBuilder()
        .insert()
        .into(StatBoardOverride)
        .values({
          league: input.league,
          board: input.board,
          season,
          playerKey,
          player: input.player.trim(),
          club: patch.club ?? null,
          clubBadge: patch.clubBadge ?? null,
          face: patch.face ?? null,
          value: patch.value ?? null,
          isManual: patch.isManual ?? false,
          updatedByAdminId: input.adminId ?? null,
        })
        .orUpdate(
          ["club", "clubBadge", "face", "value", "isManual", "updatedByAdminId"],
          ["league", "board", "season", "playerKey"],
        )
        .execute();
    }

    await this.bust(input.league);
    const row = await this.repo.findOne({
      where: { league: input.league, board: input.board, season, playerKey },
    });
    return row!;
  }

  async remove(id: string): Promise<StatBoardOverride | null> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) return null;
    await this.repo.delete({ id });
    await this.bust(row.league);
    return row;
  }

  /**
   * Lay the admin's edits over a freshly fetched board.
   *
   * The provider supplies every row and every default. An override then
   * replaces only the fields it actually carries, and rows flagged `isManual`
   * are appended because the provider has no row of its own for them. The
   * result is re-sorted and re-capped, so an edited number moves the player to
   * where that number belongs rather than leaving them in their old slot.
   */
  applyToBoard<T extends StatBoardEntry>(
    board: T[],
    overrides: StatBoardOverride[],
    limit: number,
  ): T[] {
    if (overrides.length === 0) return board;
    const byKey = new Map(overrides.map((o) => [o.playerKey, o]));

    const merged = board.map((e) => {
      const o = byKey.get(playerKeyOf(e.player));
      if (!o) return e;
      return {
        ...e,
        club: o.club ?? e.club,
        clubBadge: o.clubBadge ?? e.clubBadge,
        face: o.face ?? e.face,
        // A photo the admin chose should not be silently replaced by the
        // provider's backup when the primary fails to load.
        faceBackup: o.face ? "" : e.faceBackup,
        value: o.value ?? e.value,
      };
    });

    const onBoard = new Set(board.map((e) => playerKeyOf(e.player)));
    const added = overrides
      .filter((o) => o.isManual && !onBoard.has(o.playerKey) && (o.value ?? 0) > 0)
      .map(
        (o) =>
          ({
            player: o.player,
            club: o.club ?? "",
            clubBadge: o.clubBadge ?? "",
            face: o.face ?? "",
            faceBackup: "",
            value: o.value ?? 0,
          }) as unknown as T,
      );

    return [...merged, ...added]
      .sort((a, b) => b.value - a.value)
      .slice(0, limit);
  }

  /**
   * A board built entirely from the admin's rows, with no provider input.
   *
   * Used for assists in both leagues. football-data.org's free tier ranks
   * /scorers by goals and carries assists only incidentally, so the assists
   * board it produces is a near-arbitrary subset of the real one — worse than
   * nothing, because it looks authoritative. Assists are therefore curated by
   * hand, and the provider is not consulted at all.
   *
   * Rows need a value: with no feed number underneath them there is nothing
   * else to rank by.
   */
  buildManualBoard<T extends StatBoardEntry>(
    overrides: StatBoardOverride[],
    limit: number,
  ): T[] {
    return overrides
      .filter((o) => (o.value ?? 0) > 0)
      .map(
        (o) =>
          ({
            player: o.player,
            club: o.club ?? "",
            clubBadge: o.clubBadge ?? "",
            face: o.face ?? "",
            faceBackup: "",
            value: o.value ?? 0,
          }) as unknown as T,
      )
      .sort((a, b) => b.value - a.value)
      .slice(0, limit);
  }

  /**
   * The board as the admin page shows it: every row the provider returned,
   * plus the manual ones, each annotated with what the feed says versus what
   * has been edited. This is what makes an edit reviewable — without
   * `feedValue` there is no way to see that a pinned number has drifted from
   * the provider's.
   */
  adminView<T extends StatBoardEntry>(
    board: T[],
    overrides: StatBoardOverride[],
    /** True for a board with no provider behind it, i.e. assists. */
    manualOnly = false,
  ): AdminBoardRow[] {
    if (manualOnly) {
      return overrides
        .map((o) => ({
          player: o.player,
          club: o.club ?? "",
          face: o.face ?? "",
          value: o.value ?? 0,
          feedValue: null,
          feedFace: null,
          overrideId: o.id,
          valueEdited: o.value != null,
          faceEdited: !!o.face,
          isManual: true,
        }))
        .sort((a, b) => b.value - a.value);
    }
    const byKey = new Map(overrides.map((o) => [o.playerKey, o]));
    const rows: AdminBoardRow[] = board.map((e) => {
      const o = byKey.get(playerKeyOf(e.player));
      return {
        player: e.player,
        club: o?.club ?? e.club,
        face: o?.face ?? e.face,
        value: o?.value ?? e.value,
        feedValue: e.value,
        feedFace: e.face || null,
        overrideId: o?.id ?? null,
        valueEdited: o?.value != null,
        faceEdited: !!o?.face,
        isManual: false,
      };
    });

    const onBoard = new Set(board.map((e) => playerKeyOf(e.player)));
    for (const o of overrides) {
      if (onBoard.has(o.playerKey)) continue;
      rows.push({
        player: o.player,
        club: o.club ?? "",
        face: o.face ?? "",
        value: o.value ?? 0,
        feedValue: null,
        feedFace: null,
        overrideId: o.id,
        valueEdited: o.value != null,
        faceEdited: !!o.face,
        isManual: true,
      });
    }

    return rows.sort((a, b) => b.value - a.value);
  }

  /**
   * Drop the league's cached boards so an edit shows up immediately.
   *
   * Without this an admin would save a player and then stare at an unchanged
   * Stats tab for up to an hour, and reasonably conclude the save had failed.
   */
  private async bust(league: StatBoardLeague): Promise<void> {
    try {
      await this.redis.del(STATS_CACHE_KEY[league]);
    } catch (e) {
      // A stale board for the rest of the TTL is survivable; failing the
      // admin's save because Redis hiccuped is not.
      this.logger.warn(
        `Failed to bust ${STATS_CACHE_KEY[league]}: ${(e as Error).message}`,
      );
    }
  }
}
