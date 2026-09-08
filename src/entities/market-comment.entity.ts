import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import { User } from "./user.entity";
import { Market } from "./market.entity";

export enum CommentDeletedBy {
  AUTHOR = "author",
  ADMIN = "admin",
}

/**
 * A user's comment on a market — the platform's first user-authored public
 * content.
 *
 * `body` is stored RAW and trimmed, matching how every other free-text field
 * here is handled (suggestion titles, dispute reasons). That is only safe
 * because React escapes text children, so the invariant this design rests on
 * is: **a comment body must never reach dangerouslySetInnerHTML**, in the TMA,
 * the PWA, or oro-admin. Escape at the sink if one is ever added.
 *
 * Deletes are SOFT, unlike everything else in this codebase. A removed comment
 * is the evidence in a moderation dispute, so the row survives with `deletedAt`
 * set and `deletedBy` recording who removed it. The column is explicit rather
 * than TypeORM's @DeleteDateColumn so the exclusion is visible in every query
 * instead of being applied invisibly.
 */
@Index("IDX_market_comments_market_created", ["marketId", "createdAt"])
@Entity("market_comments")
export class MarketComment {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column()
  marketId: string;

  @ManyToOne(() => Market, { onDelete: "CASCADE" })
  @JoinColumn({ name: "marketId" })
  market: Market;

  @Index()
  @Column()
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "userId" })
  user: User;

  /**
   * The comment this one replies to, or null for a top-level comment.
   *
   * Threading is ONE level deep by design: a reply cannot itself be replied
   * to, enforced in the service. Arbitrary nesting turns a thread into a tree
   * that has to be paginated, indented and collapsed at every depth, and it
   * gives an argument somewhere to hide. Everything stays a flat conversation
   * under a top-level comment.
   */
  @Index()
  @Column({ type: "uuid", nullable: true })
  parentId: string | null;

  @Column({ type: "text" })
  body: string;

  @Column({ type: "timestamptz", nullable: true })
  deletedAt: Date | null;

  @Column({ type: "varchar", length: 16, nullable: true })
  deletedBy: CommentDeletedBy | null;

  @Column({ type: "text", nullable: true })
  deletedReason: string | null;

  /**
   * Denormalised count of rows in market_comment_flags. Kept in step by the
   * service so the moderation queue can order by "most reported" without
   * joining and grouping the flag table on every page load.
   */
  @Column({ type: "int", default: 0 })
  flagCount: number;

  /**
   * Denormalised number of live replies, so a page of comments can render
   * "2 Replies" without a grouped join per page. Maintained by the service on
   * reply create and delete; always read through GREATEST(0, ...) on the way
   * down so a double-delete cannot drive it negative.
   */
  @Column({ type: "int", default: 0 })
  replyCount: number;

  /**
   * Millisecond precision, deliberately, because this column is the pagination
   * cursor. Postgres `now()` stores microseconds while a JS ISO string carries
   * only milliseconds, so a cursor round-tripped through the client lands
   * slightly BEFORE the row it came from — which an ascending `>` comparison
   * then re-includes, returning the boundary row on every page. Matching the
   * column to the precision the wire format can express removes the whole
   * class of problem.
   */
  @CreateDateColumn({ type: "timestamptz", precision: 3 })
  createdAt: Date;

  /**
   * When the author last rewrote this comment, or null if they never have.
   *
   * Its only job is to drive the "edited" marker: a comment someone argued
   * with must not be able to change out from under the reply quietly. The
   * body itself is overwritten — no revision history, which is the honest
   * trade for a market thread rather than a wiki.
   *
   * NOT the edit deadline. That is derived from `createdAt`, so editing a
   * comment can never extend the window to edit it again.
   */
  @Column({ type: "timestamptz", nullable: true })
  editedAt: Date | null;
}
