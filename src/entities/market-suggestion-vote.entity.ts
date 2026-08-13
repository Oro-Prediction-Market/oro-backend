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
import { MarketSuggestion } from "./market-suggestion.entity";

/**
 * One row per (suggestion, user). The unique constraint is what enforces
 * "one vote per user" — the service relies on the DB rejecting a duplicate
 * rather than a read-then-write check, which would race under concurrency.
 */
@Unique("UQ_suggestion_vote", ["suggestionId", "userId"])
@Entity("market_suggestion_votes")
export class MarketSuggestionVote {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column()
  suggestionId: string;

  @ManyToOne(() => MarketSuggestion, { onDelete: "CASCADE" })
  @JoinColumn({ name: "suggestionId" })
  suggestion: MarketSuggestion;

  @Index()
  @Column()
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "userId" })
  user: User;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;
}
