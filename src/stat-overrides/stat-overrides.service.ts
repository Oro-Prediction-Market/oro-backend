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

/** Redis keys the leagues cache their built boards under. */
const STATS_CACHE_KEY: Record<StatBoardLeague, string> = {
  epl: "oro:epl:stats",
  ucl: "oro:ucl:stats",
};

/**
 * Normalised player name, used for matching an override against the feed.
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
 * already uses, and keeps last season's manual entries from reappearing when
 * the new one kicks off.
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
      order: { board: "ASC", value: "DESC" },
    });
  }

  async upsert(input: {
    league: StatBoardLeague;
    board: StatBoardKey;
    player: string;
    club?: string;
    clubBadge?: string;
    face?: string;
    value: number;
    adminId?: string | null;
    season?: string;
  }): Promise<StatBoardOverride> {
    const season = input.season ?? currentFootballSeason();
    const playerKey = playerKeyOf(input.player);

    // Write through the unique constraint rather than read-then-write: two
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
        club: input.club ?? "",
        clubBadge: input.clubBadge ?? "",
        face: input.face ?? "",
        value: Math.max(0, Math.round(input.value)),
        updatedByAdminId: input.adminId ?? null,
      })
      .orUpdate(
        ["player", "club", "clubBadge", "face", "value", "updatedByAdminId"],
        ["league", "board", "season", "playerKey"],
      )
      .execute();

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
   * Fold the admin's rows into a freshly built board.
   *
   * The feed wins wherever it reports a player: an override whose name already
   * appears is dropped, not merged. What is left are the players the provider
   * is silent about, which is the gap this exists to fill. Re-sorted and
   * re-capped so a manual entry lands in its rightful place rather than at the
   * bottom.
   */
  applyToBoard<T extends StatBoardEntry>(
    board: T[],
    overrides: StatBoardOverride[],
    limit: number,
  ): T[] {
    if (overrides.length === 0) return board;
    const fromFeed = new Set(board.map((e) => playerKeyOf(e.player)));
    const extra = overrides
      .filter((o) => !fromFeed.has(o.playerKey) && o.value > 0)
      .map(
        (o) =>
          ({
            player: o.player,
            club: o.club,
            clubBadge: o.clubBadge,
            face: o.face,
            faceBackup: "",
            value: o.value,
          }) as unknown as T,
      );
    if (extra.length === 0) return board;
    return [...board, ...extra].sort((a, b) => b.value - a.value).slice(0, limit);
  }

  /** Which overrides the feed is currently overruling, for the admin page. */
  shadowedBy<T extends StatBoardEntry>(
    board: T[],
    overrides: StatBoardOverride[],
  ): Map<string, number> {
    const feedValue = new Map<string, number>();
    for (const e of board) feedValue.set(playerKeyOf(e.player), e.value);
    const out = new Map<string, number>();
    for (const o of overrides) {
      const v = feedValue.get(o.playerKey);
      if (v !== undefined) out.set(o.id, v);
    }
    return out;
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
