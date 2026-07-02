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

export enum PositionStatus {
  PENDING = "pending",
  WON = "won",
  LOST = "lost",
  REFUNDED = "refunded",
}

// Back-compat alias so any remaining references compile during migration
export { PositionStatus as BetStatus };

@Index(["userId", "marketId"])
@Index(["placedAt"])
@Entity("positions")
export class Position {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "decimal", precision: 18, scale: 2 })
  amount: number;

  @Column({
    type: "enum",
    enum: PositionStatus,
    default: PositionStatus.PENDING,
  })
  status: PositionStatus;

  @Column({ type: "decimal", precision: 10, scale: 4, nullable: true })
  oddsAtPlacement: number;

  @Column({ type: "decimal", precision: 18, scale: 2, nullable: true })
  payout: number;

  /**
   * LMSR probability of the chosen outcome at the moment of bet placement.
   * Stored for Brier score calibration tracking on settlement.
   */
  @Column({ type: "decimal", precision: 10, scale: 6, nullable: true })
  predictedProbability: number | null;

  /**
   * Fraction of the total pool sitting on this outcome at bet time (0–1).
   * Used to compute the early-confidence bonus payout: closer to 0.5 = higher uncertainty = more conviction.
   */
  @Column({ type: "decimal", precision: 10, scale: 6, nullable: true })
  poolPctAtBet: number | null;

  /**
   * True if this bet was funded by bonus credits at placement time.
   * Stored so settlement can identify bonus-funded losses — these are the ones
   * that create real-money exposure for the platform (the OTHER side wins real Nu
   * from a pool partly funded by fake credits).
   */
  @Column({ type: "boolean", default: false })
  isBonusFunded: boolean;

  /**
   * True if this bet was placed on the 7th day of a bet streak and "armed" the
   * Day-7 boost. If the bet WINS, settlement credits an extra 20% of its payout
   * as a streak bonus (STREAK_BONUS_MULT). Set once per streak cycle at placement.
   */
  @Column({ type: "boolean", default: false })
  streakBoostArmed: boolean;

  @CreateDateColumn()
  placedAt: Date;

  @ManyToOne(() => User, (u) => u.positions, { onDelete: "CASCADE" })
  @JoinColumn()
  user: User;

  @Column()
  userId: string;

  @ManyToOne(() => Market, (m) => m.positions)
  @JoinColumn()
  market: Market;

  @Column()
  marketId: string;

  @ManyToOne(() => Outcome, (o) => o.positions)
  @JoinColumn()
  outcome: Outcome;

  @Column()
  outcomeId: string;
}

// Back-compat alias
export { Position as Bet };
