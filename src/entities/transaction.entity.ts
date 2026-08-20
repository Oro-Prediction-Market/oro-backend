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
  SEASON_PRIZE = "season_prize",
}

// Back-compat aliases
export const BET_PLACED = TransactionType.POSITION_OPENED;
export const BET_PAYOUT = TransactionType.POSITION_PAYOUT;

/**
 * The ngultrum ledger. Every balance read that means "spendable Nu" filters on
 * this — an unfiltered SUM(amount) folds the USDT book into the BTN book and
 * lets a crypto deposit be staked or withdrawn as ngultrum.
 */
export const BTN_CURRENCY = "BTN";

// Declared here as well as in the migration: DB_SYNCHRONIZE runs TypeORM
// synchronize at boot, which drops any index it cannot find in entity metadata.
@Index("IDX_transactions_user_currency", ["userId", "currency"])
@Entity("transactions")
export class Transaction {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "enum", enum: TransactionType })
  type: TransactionType;

  @Column({ type: "decimal", precision: 20, scale: 9 })
  amount: number;

  /**
   * Ledger currency for this row. Balances are per-currency:
   *
   *   SUM(amount) WHERE "userId" = ? AND currency = ?
   *
   * Existing rows backfill to 'BTN'. Every balance read MUST filter on this;
   * `ledger-currency-guard.spec.ts` fails the build if one does not. The
   * supporting composite index is declared at class level.
   */
  @Column({ type: "varchar", length: 10, default: BTN_CURRENCY })
  currency: string;

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

  @Column({ type: "decimal", precision: 20, scale: 9, nullable: true })
  stakeAmount: number | null;

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
