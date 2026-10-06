import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { User } from "./user.entity";

export const ADJUSTMENT_REASONS = {
  goodwill: "Goodwill credit",
  payout_correction: "Payout correction",
  withdrawal_return: "Withdrawal returned",
  recover_overpayment: "Recover an overpayment",
  other: "Other",
} as const;

export type AdjustmentReason = keyof typeof ADJUSTMENT_REASONS;

/**
 * Why an admin moved money into or out of a wallet. One row per `adjustment`
 * ledger row; see migration 1775990000680.
 */
// Constraints and indexes declared here as well as in the migration, so a
// DB_SYNCHRONIZE run never drops what it cannot see in entity metadata.
@Entity("balance_adjustments")
@Index("IDX_balance_adjustments_user", ["userId", "createdAt"])
@Index("IDX_balance_adjustments_created", ["createdAt"])
@Check("CHK_balance_adjustments_nonzero", `"amount" <> 0`)
export class BalanceAdjustment {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column("uuid")
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({
    name: "userId",
    foreignKeyConstraintName: "FK_balance_adjustments_user",
  })
  user?: User;

  @Column({ type: "varchar", length: 10 })
  currency: string;

  /** Signed: positive credits the wallet, negative debits it. */
  @Column({ type: "decimal", precision: 20, scale: 9 })
  amount: number;

  @Column({ type: "varchar", length: 32 })
  reason: AdjustmentReason;

  /** Internal. Never shown to the customer. */
  @Column({ type: "text" })
  note: string;

  /** The ledger row's note — what the customer sees in their history. */
  @Column({ type: "varchar", length: 200 })
  userNote: string;

  /** Optional link to what this corrects: a payment, market, or ticket. */
  @Column({ type: "varchar", length: 128, nullable: true })
  reference: string | null;

  @Column("uuid")
  adminId: string;

  @Column({ type: "uuid", unique: true })
  transactionId: string;

  /** Client-generated, so a double-submitted form writes once. */
  @Column({ type: "uuid", unique: true })
  requestId: string;

  @Column({ type: "decimal", precision: 20, scale: 9 })
  balanceBefore: number;

  @Column({ type: "decimal", precision: 20, scale: 9 })
  balanceAfter: number;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;
}
