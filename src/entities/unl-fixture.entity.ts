import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

export enum UnlFixtureStatus {
  SCHEDULED = "scheduled",
  FINISHED = "finished",
  /**
   * Result decided by UEFA rather than on the pitch — typically 3-0 after an
   * abandonment or a forfeit. The scores are entered normally and count toward
   * the table; the status records that they were administrative, which is the
   * same distinction football-data draws with its `AWARDED` match status.
   */
  AWARDED = "awarded",
  /** Rearranged. Scores stay null, so the fixture does not count. */
  POSTPONED = "postponed",
}

/**
 * One Nations League match, and the single source of truth for everything the
 * competition shows.
 *
 * The group table is computed from these rows rather than typed in separately,
 * so a result and a standings table cannot disagree — there is only one place
 * to type a score. The match market is created from this row and settled from
 * it too, which is what keeps the table and the payout describing the same
 * match.
 *
 * Both scores are nullable and stay null until the match is played. They are
 * read strictly: a table only counts a fixture when BOTH are numbers. That is
 * deliberate and hard-won — reading a missing score as zero is exactly what
 * settled Nottingham Forest v Coventry as a draw on 20 September 2026, because
 * `score.fullTime.home ?? 0` cannot tell an absent scoreline from a real 0-0.
 * An abandoned match therefore needs no special case: leave the scores null and
 * it simply does not count.
 *
 * `marketId` is stamped once the keeper has created this fixture's market. It
 * is both the dedupe key for market creation and the handle the score-entry
 * endpoint uses to propose a result.
 */
@Index("IDX_unl_fixture_schedule", ["season", "kickoffAt"])
@Index("IDX_unl_fixture_group", ["season", "groupKey"])
@Entity("unl_fixtures")
export class UnlFixture {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** Matches {@link UnlTeam.season}: "2026-28". */
  @Column({ type: "varchar", length: 16 })
  season: string;

  /**
   * Denormalised from the two teams so a group's table can be built in one
   * query. Both teams always belong to this group — the service enforces it on
   * write, since a cross-group fixture is not a thing the competition has.
   */
  @Column({ type: "varchar", length: 2 })
  groupKey: string;

  @Column({ type: "uuid" })
  homeTeamId: string;

  @Column({ type: "uuid" })
  awayTeamId: string;

  @Column({ type: "timestamptz" })
  kickoffAt: Date;

  /** Null until played. Never defaulted to 0 — see the class docstring. */
  @Column({ type: "int", nullable: true })
  homeScore: number | null;

  @Column({ type: "int", nullable: true })
  awayScore: number | null;

  @Column({
    type: "varchar",
    length: 16,
    default: UnlFixtureStatus.SCHEDULED,
  })
  status: UnlFixtureStatus;

  /**
   * The market this fixture created, once the keeper has made one.
   *
   * Unique: one fixture, at most one market. The authoritative dedupe key is
   * `metadata.unlFixtureId` on the market itself — a market is committed before
   * this column can be written, so a crash in between would otherwise let the
   * next run build a second market for the same match. This column is the
   * convenient direction to read, and the constraint is what stops the two
   * disagreeing.
   */
  @Column({ type: "uuid", nullable: true, unique: true })
  marketId: string | null;

  /**
   * The three outcome ids of {@link marketId}, stamped at creation.
   *
   * Settlement compares two integers and returns one of these. It never matches
   * a team name, because this competition fields **Ireland and Northern
   * Ireland** and **Macedonia and North Macedonia**, and the keeper's generic
   * `resolveOutcome` falls back to substring matching in both directions
   * (`keeper.service.ts:1620`) — which would pick the wrong nation with
   * complete confidence. Exact-match saves that path today and would stop the
   * day someone shortens a label for display.
   */
  @Column({ type: "uuid", nullable: true })
  homeOutcomeId: string | null;

  @Column({ type: "uuid", nullable: true })
  drawOutcomeId: string | null;

  @Column({ type: "uuid", nullable: true })
  awayOutcomeId: string | null;

  /** Nations League matchday 1–6, used to group fixtures in the app. */
  @Column({ type: "int", nullable: true })
  matchday: number | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt: Date;
}
