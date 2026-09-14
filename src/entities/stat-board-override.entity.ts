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
 * An admin-supplied entry on a football stat leaderboard.
 *
 * The goals/assists boards are fetched live from football-data.org, and on the
 * free tier they are thin — the /scorers list is goal-ranked, so a player with
 * assists but few goals never appears, and `value > 0` then drops them from the
 * assists board entirely. That leaves real contenders invisible on the Stats
 * tab, and therefore unbettable: the tab renders rows from the BOARD and
 * attaches betting only where a market outcome's name matches one.
 *
 * These rows fill that gap. They are deliberately NOT authoritative — the feed
 * wins wherever it reports a player, and an override only applies to players
 * the feed is silent about. An admin correcting a number the provider is
 * already reporting will see the provider's figure stand; the admin page says
 * so rather than letting the edit look applied. That keeps the boards
 * self-healing: when the provider starts carrying a player, the manual row
 * stops being consulted instead of freezing a stale number in place forever.
 *
 * Adding a row here does NOT make the player bettable. Writing an outcome into
 * a live parimutuel market is a separate, explicit admin action — see the
 * "open betting" endpoint — because it changes a market people already hold
 * positions in.
 *
 * Scoped by season so last season's manual entries do not silently reappear in
 * August. `season` is the starting year of the campaign ("2026" = 2026/27).
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

  @Column({ type: "varchar", length: 160, default: "" })
  club: string;

  @Column({ type: "varchar", length: 512, default: "" })
  clubBadge: string;

  @Column({ type: "varchar", length: 512, default: "" })
  face: string;

  /** Goals or assists, depending on `board`. */
  @Column({ type: "int", default: 0 })
  value: number;

  /** Admin who last wrote this row, for the audit trail. */
  @Column({ type: "uuid", nullable: true })
  updatedByAdminId: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
