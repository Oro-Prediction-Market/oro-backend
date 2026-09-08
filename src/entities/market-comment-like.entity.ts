import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from "typeorm";
import { User } from "./user.entity";
import { MarketComment } from "./market-comment.entity";

/**
 * One row per (comment, liker).
 *
 * The unique constraint is what enforces "one like per person" — the service
 * lets Postgres reject a duplicate rather than doing a read-then-write check,
 * which races under a double tap. Same pattern as MarketCommentFlag and
 * MarketSuggestionVote.
 *
 * Unlike a flag, a like is undone by DELETEing the row: the button is a toggle,
 * and keeping tombstones would only complicate the count.
 */
@Unique("UQ_comment_like", ["commentId", "userId"])
@Entity("market_comment_likes")
export class MarketCommentLike {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column()
  commentId: string;

  @ManyToOne(() => MarketComment, { onDelete: "CASCADE" })
  @JoinColumn({ name: "commentId" })
  comment: MarketComment;

  @Index()
  @Column()
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "userId" })
  user: User;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;
}
