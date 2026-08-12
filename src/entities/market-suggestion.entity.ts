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
import { MarketCategory } from "./market.entity";

export enum SuggestionStatus {
  /** Submitted, waiting on the admin's Telegram approval. Hidden from the orbit. */
  PENDING = "pending",
  /** Approved — visible in the orbit and open for votes. */
  APPROVED = "approved",
  /** Rejected by the admin. Hidden, and does not free up the monthly quota. */
  REJECTED = "rejected",
  /** An admin turned this into a real market. `marketId` points at it. */
  CREATED = "created",
}

/**
 * A market a user wants to exist. Users submit one per calendar month; the admin
 * approves or rejects each from a Telegram DM before it becomes visible.
 *
 * `voteCount` is denormalised for ordering the orbit — the authoritative count is
 * always `COUNT(*)` over market_suggestion_votes, and the two are kept in step in
 * the same transaction as the vote insert.
 */
@Index(["status", "voteCount"])
@Entity("market_suggestions")
export class MarketSuggestion {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column()
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "userId" })
  user: User;

  @Column({ length: 200 })
  title: string;

  @Column({ type: "text", nullable: true })
  description: string | null;

  @Column({
    type: "enum",
    enum: MarketCategory,
    enumName: "markets_category_enum",
    default: MarketCategory.OTHER,
  })
  category: MarketCategory;

  @Column({
    type: "enum",
    enum: SuggestionStatus,
    default: SuggestionStatus.PENDING,
  })
  status: SuggestionStatus;

  /** Distinct upvoters, including the proposer's own vote. */
  @Column({ type: "int", default: 0 })
  voteCount: number;

  /** Set once an admin turns this suggestion into a live market. */
  @Column({ type: "uuid", nullable: true })
  marketId: string | null;

  @ManyToOne(() => Market, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "marketId" })
  market: Market | null;

  /** Telegram id of the admin who approved/rejected it. */
  @Column({ type: "varchar", nullable: true })
  reviewedByTelegramId: string | null;

  @Column({ type: "timestamptz", nullable: true })
  reviewedAt: Date | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;
}
