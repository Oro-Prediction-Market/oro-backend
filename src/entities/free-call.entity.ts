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
import { Outcome } from "./outcome.entity";

export enum FreeCallStatus {
  PENDING = "pending",
  CORRECT = "correct",
  INCORRECT = "incorrect",
  /** Market cancelled or refunded — the call is discarded, not scored. */
  VOID = "void",
}

/**
 * A no-stake prediction.
 *
 * Free calls exist for three reasons at once: they give someone a reason to open
 * Oro daily that costs nothing, they sharpen the public probability by pulling
 * in people who will never deposit, and they let a user build a real accuracy
 * record before risking anything.
 *
 * A free call never touches a ledger, a book, or a pool. It is scored against
 * the same resolution as a staked position and feeds the same calibration
 * mathematics — that is the whole point, and why `probabilityAtCall` is
 * captured at insert time and never updated.
 */
@Entity("free_calls")
// One call per user per market — enforced in the DB, not by a read-then-write.
@Index("UQ_free_calls_user_market", ["userId", "marketId"], { unique: true })
@Index("IDX_free_calls_market_status", ["marketId", "status"])
@Index("IDX_free_calls_user_status", ["userId", "status"])
export class FreeCall {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "userId" })
  user: User;

  @Column({ type: "uuid" })
  marketId: string;

  @ManyToOne(() => Market, { onDelete: "CASCADE" })
  @JoinColumn({ name: "marketId" })
  market: Market;

  @Column({ type: "uuid" })
  outcomeId: string;

  @ManyToOne(() => Outcome, { onDelete: "CASCADE" })
  @JoinColumn({ name: "outcomeId" })
  outcome: Outcome;

  /**
   * The crowd probability of the chosen outcome at the moment of the call.
   *
   * This is the Brier input. Calling a 20% outcome that lands is worth far more
   * than calling a 90% favourite, and without the probability at call time
   * there is no way to tell those apart afterwards.
   */
  @Column({ type: "decimal", precision: 10, scale: 6 })
  probabilityAtCall: number;

  @Column({
    type: "enum",
    enum: FreeCallStatus,
    default: FreeCallStatus.PENDING,
  })
  status: FreeCallStatus;

  @CreateDateColumn({ type: "timestamptz" })
  calledAt: Date;

  @Column({ type: "timestamptz", nullable: true })
  resolvedAt: Date | null;
}
