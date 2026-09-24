import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
} from "typeorm";

/**
 * One nation in one Nations League group.
 *
 * Teams are a table rather than something derived from the fixture list, for
 * two reasons. A group table has to show all four nations on zero before a ball
 * is kicked, which a fixture-derived list cannot do until fixtures exist. And
 * every value here is typed in by a human: deriving team identity from a name
 * written out twice per fixture means one slip — "Turkiye" for "Türkiye" —
 * quietly produces a fifth row in a four-team group. Fixtures reference an id,
 * so that slip becomes an error at entry instead of a wrong table in
 * production.
 *
 * Scoped by season because the Nations League runs across two calendar years
 * and groups are redrawn between editions.
 */
@Unique("UQ_unl_team", ["season", "groupKey", "name"])
@Index("IDX_unl_team_group", ["season", "groupKey"])
@Entity("unl_teams")
export class UnlTeam {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** The edition, written as UEFA writes it: "2026-28". */
  @Column({ type: "varchar", length: 16 })
  season: string;

  /** A single letter, "A" through "N" — 14 groups across the four leagues. */
  @Column({ type: "varchar", length: 2 })
  groupKey: string;

  @Column({ type: "varchar", length: 120 })
  name: string;

  /** Flag image. Nullable: a team is enterable before anyone finds the URL. */
  @Column({ type: "varchar", length: 512, nullable: true })
  flagUrl: string | null;

  /**
   * Entry order within the group, and the standings sort's final tiebreaker.
   *
   * It exists so that `computeGroupTable` is a *total* order: after points,
   * head-to-head, and overall goal difference and goals scored, two teams can
   * still be genuinely level, and UEFA's remaining criteria (disciplinary
   * points, national-team coefficient) are data we do not have. Falling back to
   * a stable stored number means the table never reorders itself between two
   * reads of unchanged data, which a fallback on `name` or on row order would
   * not guarantee.
   */
  @Column({ type: "int", default: 0 })
  sortOrder: number;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt: Date;
}
