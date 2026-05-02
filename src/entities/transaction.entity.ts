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

export enum TransactionType {
  DEPOSIT = "deposit",
  WITHDRAWAL = "withdrawal",
  POSITION_OPENED = "bet_placed",
  POSITION_PAYOUT = "bet_payout",
  REFUND = "refund",
  DISPUTE_BOND = "dispute_bond",
  DISPUTE_REFUND = "dispute_refund",
  DISPUTE_BOND_LOCK = "dispute_bond_lock",
  DISPUTE_BOND_FORFEIT = "dispute_bond_forfeit",
  DISPUTE_BOND_REWARD = "dispute_bond_reward",
  REFERRAL_BONUS = "referral_bonus",
  FREE_CREDIT = "free_credit",
  STREAK_BONUS = "streak_bonus",
  REFERRAL_PRIZE = "referral_prize",
  DUEL_WAGER = "duel_wager",
  DUEL_PAYOUT = "duel_payout",
}

// Back-compat aliases
export const BET_PLACED = TransactionType.POSITION_OPENED;
export const BET_PAYOUT = TransactionType.POSITION_PAYOUT;

@Entity("transactions")
export class Transaction {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "enum", enum: TransactionType })
  type: TransactionType;

  @Column({ type: "decimal", precision: 20, scale: 9 })
  amount: number;

  @Column({ type: "decimal", precision: 20, scale: 9 })
  balanceBefore: number;

  @Column({ type: "decimal", precision: 20, scale: 9 })
  balanceAfter: number;

  @Index()
  @Column({ type: "uuid", nullable: true, unique: true })
  paymentId: string;

  @Index()
  @Column({ type: "uuid", nullable: true })
  positionId: string;

  @Column({ type: "varchar", nullable: true })
  note: string;

  /**
   * True when this transaction originated from a FREE_CREDIT grant or a
   * payout derived from a free-credit bet. Winnings from bonus credits are
   * capped at Nu 50 withdrawable — the rest is re-credited as play money.
   */
  @Column({ default: false })
  isBonus: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @ManyToOne(() => User, (u) => u.transactions, { onDelete: "CASCADE" })
  @JoinColumn()
  user: User;

  @Column()
  userId: string;
}
