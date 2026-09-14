import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
} from "typeorm";

export type StatBoardLeague = "epl" | "ucl";
export type StatBoardKey = "goals" | "assists";

/**
 * An admin's edits to one player's row on a football stat leaderboard.
 *
 * The goals/assists boards are fetched live from football-data.org. The
 * provider is the default for everything — this table records only the fields
 * an admin has deliberately changed, and every one of them is nullable so that
 * "no opinion" is a real state rather than a sentinel value.
 *
 * The rule is "provider first, admin wins once they touch it": a board is
 * built from the feed, then each row an admin has edited has their fields laid
 * over it. Clearing a field hands it back to the feed. This is per field on
 * purpose — correcting a wrong player photo must not also freeze the goal
 * count, which would go stale the moment the player scored again.
 *
 * `isManual` marks a player the provider does not carry at all. The free tier
 * drops plenty: /scorers is goal-ranked, so a player with assists but few
 * goals never appears, and the boards then filter value > 0. Those players are
 * invisible on the Stats tab and therefore unbettable, because the tab renders
 * rows from the BOARD and attaches betting only where a market outcome's name
 * matches one. A manual row needs a `value`, since there is no feed number to
 * rank it by.
 *
 * Adding a row here does NOT make the player bettable. Writing an outcome into
 * a live parimutuel market is a separate, explicit admin action — see the
 * "open betting" endpoint — because it changes a market people already hold
 * positions in.
 *
 * Scoped by season so last season's edits do not silently reappear in August.
 * `season` is the starting year of the campaign ("2026" = 2026/27).
 */
@Unique("UQ_stat_board_override", ["league", "board", "season", "playerKey"])
@Index("IDX_stat_board_override_lookup", ["league", "board", "season"])
@Entity("stat_board_overrides")
export class StatBoardOverride {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", length: 8 })
  league: StatBoardLeague;

  @Column({ type: "varchar", length: 16 })
  board: StatBoardKey;

  /** Starting year of the campaign, e.g. "2026" for 2026/27. */
  @Column({ type: "varchar", length: 8 })
  season: string;

  /**
   * Normalised name, and the thing the merge matches on.
   *
   * Stored rather than derived at read time so the unique constraint can do
   * the de-duplication: "Erling Haaland" and "erling haaland" are one player,
   * and Postgres should be the one saying so.
   */
  @Column({ type: "varchar", length: 160 })
  playerKey: string;

  /** Name as displayed on the board. */
  @Column({ type: "varchar", length: 160 })
  player: string;

  /** Null on every one of these means "no admin opinion — use the feed". */
  @Column({ type: "varchar", length: 160, nullable: true })
  club: string | null;

  @Column({ type: "varchar", length: 512, nullable: true })
  clubBadge: string | null;

  @Column({ type: "varchar", length: 512, nullable: true })
  face: string | null;

  /** Goals or assists, depending on `board`. */
  @Column({ type: "int", nullable: true })
  value: number | null;

  /**
   * The provider does not carry this player, so the board only has them
   * because an admin added them. Such a row must carry a `value`: there is no
   * feed number underneath it to rank by.
   */
  @Column({ type: "boolean", default: false })
  isManual: boolean;

  /** Admin who last wrote this row, for the audit trail. */
  @Column({ type: "uuid", nullable: true })
  updatedByAdminId: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
