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

export enum CommentFlagReason {
  SPAM = "spam",
  ABUSE = "abuse",
  MISINFORMATION = "misinformation",
  OTHER = "other",
}

/**
 * One row per (comment, reporter). The unique constraint is what enforces
 * "one flag per user" — the service relies on the DB rejecting a duplicate
 * rather than a read-then-write check, which would race under concurrency.
 * Same pattern as MarketSuggestionVote.
 */
@Unique("UQ_comment_flag", ["commentId", "userId"])
@Entity("market_comment_flags")
export class MarketCommentFlag {
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

  @Column({
    type: "enum",
    enum: CommentFlagReason,
    default: CommentFlagReason.OTHER,
  })
  reason: CommentFlagReason;

  @Column({ type: "text", nullable: true })
  note: string | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;
}
