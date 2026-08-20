import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from "typeorm";
import { User } from "./user.entity";

export enum WithdrawalDestinationStatus {
  /** 21Pay holds a new destination for 24h before its first use. */
  COOLDOWN = "cooldown",
  ACTIVE = "active",
  DISABLED = "disabled",
}

/** Our approval, which is not 21Pay's. */
export enum WithdrawalApprovalStatus {
  PENDING_APPROVAL = "pending_approval",
  APPROVED = "approved",
  REJECTED = "rejected",
}

/**
 * 21Pay's own nine-state machine, mirrored.
 *
 * **Only `COMPLETED` means the user has been paid.** `broadcast` and
 * `confirming` are on the way, not there.
 */
export enum RemoteWithdrawalStatus {
  REQUESTED = "requested",
  PENDING_APPROVAL = "pending_approval",
  APPROVED = "approved",
  BROADCASTING = "broadcasting",
  CONFIRMING = "confirming",
  COMPLETED = "completed",
  REJECTED = "rejected",
  FAILED = "failed",
  CANCELLED = "cancelled",
}

export const TERMINAL_REMOTE_STATUSES: ReadonlySet<string> = new Set([
  RemoteWithdrawalStatus.COMPLETED,
  RemoteWithdrawalStatus.REJECTED,
  RemoteWithdrawalStatus.FAILED,
  RemoteWithdrawalStatus.CANCELLED,
]);

/**
 * A whitelisted payout address.
 *
 * **The network is a property of this record, never a choice at withdrawal
 * time.** All three EVM chains share the `0x` format, so no validation can tell
 * a Base address from an Arbitrum one — binding the network here removes the
 * choice, and therefore the unrecoverable mistake.
 */
@Unique("UQ_crypto_dest_user_network_address", ["userId", "network", "address"])
@Index("IDX_crypto_dest_user", ["userId"])
@Entity("crypto_withdrawal_destinations")
export class CryptoWithdrawalDestination {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "userId" })
  user: User;

  @Column({ type: "varchar", length: 64, nullable: true })
  pay21DestinationId: string | null;

  @Column({ type: "varchar", length: 16 })
  network: string;

  @Column({ type: "varchar", length: 128 })
  address: string;

  @Column({ type: "varchar", length: 64, nullable: true })
  label: string | null;

  @Column({
    type: "enum",
    enum: WithdrawalDestinationStatus,
    default: WithdrawalDestinationStatus.COOLDOWN,
  })
  status: WithdrawalDestinationStatus;

  /**
   * When the cooldown ends.
   *
   * Surfaced rather than hidden: a winner who cannot be paid for 24 hours
   * needs to be told why, or the product looks broken at exactly the moment it
   * matters most.
   */
  @Column({ type: "timestamptz", nullable: true })
  usableAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

/**
 * A USDT withdrawal.
 *
 * Money is debited at request and returned by a compensating credit if it
 * fails — deliberately not a `lockedBalance` column, which would reintroduce
 * the stored-balance problem the whole ledger design avoids.
 */
@Unique("UQ_crypto_withdrawals_idempotency", ["idempotencyKey"])
@Unique("UQ_crypto_withdrawals_pay21_id", ["pay21WithdrawalId"])
@Index("IDX_crypto_withdrawals_user", ["userId"])
@Index("IDX_crypto_withdrawals_approval", ["approvalStatus", "createdAt"])
@Index("IDX_crypto_withdrawals_remote", ["remoteStatus"])
@Index("IDX_crypto_withdrawals_review", ["needsManualReview"])
@Entity("crypto_withdrawals")
export class CryptoWithdrawal {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  userId: string;

  @Column({ type: "uuid" })
  destinationId: string;

  @ManyToOne(() => CryptoWithdrawalDestination)
  @JoinColumn({ name: "destinationId" })
  destination: CryptoWithdrawalDestination;

  @Column({ type: "varchar", length: 64, nullable: true })
  pay21WithdrawalId: string | null;

  @Column({ type: "varchar", length: 16 })
  network: string;

  @Column({ type: "decimal", precision: 28, scale: 9 })
  amountUsdt: number;

  @Column({
    type: "enum",
    enum: WithdrawalApprovalStatus,
    default: WithdrawalApprovalStatus.PENDING_APPROVAL,
  })
  approvalStatus: WithdrawalApprovalStatus;

  @Column({ type: "varchar", length: 32, nullable: true })
  remoteStatus: string | null;

  @Column({ type: "uuid", nullable: true })
  debitTransactionId: string | null;

  @Column({ type: "uuid", nullable: true })
  restoreTransactionId: string | null;

  @Column({ type: "varchar", length: 128, nullable: true })
  txHash: string | null;

  @Column({ type: "varchar", length: 255, nullable: true })
  failureReason: string | null;

  /**
   * 21Pay reported failure, but a `tx_hash` exists — so we cannot know whether
   * the money actually moved. **Never auto-restore one of these.** Their own
   * reaper refuses to reverse a `broadcasting` row for the same reason.
   */
  @Column({ type: "boolean", default: false })
  needsManualReview: boolean;

  @Column({ type: "uuid", nullable: true })
  approvedBy: string | null;

  @Column({ type: "timestamptz", nullable: true })
  approvedAt: Date | null;

  @Column({ type: "varchar", length: 255, nullable: true })
  rejectionReason: string | null;

  @Column({ type: "timestamptz", nullable: true })
  completedAt: Date | null;

  @Column({ type: "varchar", length: 128 })
  idempotencyKey: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
