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
   * Reserved for threading and deliberately inert in v1 — nothing reads or
   * writes it. It exists so replies become a UI change later rather than a
   * migration against a table that by then holds real conversations.
   */
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

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;
}
