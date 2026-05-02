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

export enum ChallengeStatus {
  OPEN = "open",      // waiting for a challenger to accept
  ACTIVE = "active",  // challenger accepted — both wagers locked
  SETTLED = "settled", // market resolved — winner paid out
  EXPIRED = "expired", // no one joined before deadline — wager refunded
  VOID = "void",      // market voided — wagers refunded
}

export enum CardType {
  DOUBLE_DOWN = "doubleDown", // platform waives 10% fee — winner gets full 2× pot
  SHIELD = "shield",          // loss doesn't reset bet streak
  GHOST = "ghost",            // wager hidden as "???" until opponent accepts
}

@Index(["creatorId", "status"])
@Index(["marketId", "status"])
@Entity("challenges")
export class Challenge {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column()
  creatorId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "creatorId" })
  creator: User;

  @Column()
  marketId: string;

  @ManyToOne(() => Market, { onDelete: "CASCADE" })
  @JoinColumn({ name: "marketId" })
  market: Market;

  /** The outcome the creator is defending */
  @Column()
  outcomeId: string;

  @ManyToOne(() => Outcome, { onDelete: "CASCADE" })
  @JoinColumn({ name: "outcomeId" })
  outcome: Outcome;

  @Column({
    type: "enum",
    enum: ChallengeStatus,
    default: ChallengeStatus.OPEN,
  })
  status: ChallengeStatus;

  /** Number of participants who have joined via the challenge link */
  @Column({ default: 0 })
  participantCount: number;

  /** Oro credits each side puts up. 0 = bragging-rights only challenge */
  @Column({ type: "decimal", precision: 18, scale: 2, default: 0 })
  wagerAmount: number;

  /** The user who accepted the challenge (null until someone joins) */
  @Column({ type: "uuid", nullable: true })
  joinerId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "joinerId" })
  joiner: User | null;

  /** Set on settlement — the userId who won, or null for a void/draw */
  @Column({ type: "uuid", nullable: true })
  winnerId: string | null;

  /** When the challenge was settled or expired */
  @Column({ type: "timestamptz", nullable: true })
  settledAt: Date | null;

  /**
   * Power card the creator equipped for this duel.
   * doubleDown → fee waived on winner payout.
   * shield     → creator's bet streak won't reset if they lose.
   * ghost      → wager hidden as "???" in the open feed until accepted.
   */
  @Column({ type: "varchar", nullable: true })
  equippedCard: CardType | null;

  /** Challenge expires 24 hours after creation if no one joins */
  @Column({ type: "timestamptz" })
  expiresAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}
