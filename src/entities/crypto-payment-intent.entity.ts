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

/**
 * The engine's nine intent states, verbatim.
 *
 * Kept whole rather than collapsed: `confirmed_partial`, `confirmed_overpaid`
 * and `expired` each drive a different thing the user sees, and a lossy local
 * model would have to be undone later.
 *
 * **Not a one-way progression.** A chain reorg takes `confirmed` back to
 * `failed` and reverses the credit, and AML can flip a detected deposit to
 * `failed` after the fact. Neither sends a webhook. See 21PAY-ANSWERS.md §2.4.
 */
export enum CryptoIntentStatus {
  AWAITING_DEPOSIT = "awaiting_deposit",
  CONFIRMING = "confirming",
  /** A tenant-configured soft threshold, not chain finality. Do not credit. */
  ACCEPTED = "accepted",
  CONFIRMED = "confirmed",
  CONFIRMED_PARTIAL = "confirmed_partial",
  CONFIRMED_OVERPAID = "confirmed_overpaid",
  /** Parent-only signalling once a child settles. Never credit this. */
  COMPLETED_VIA_TOPUP = "completed_via_topup",
  EXPIRED = "expired",
  FAILED = "failed",
}

/** The states in which money has actually landed and we credit. */
export const CREDITING_STATUSES: ReadonlySet<CryptoIntentStatus> = new Set([
  CryptoIntentStatus.CONFIRMED,
  CryptoIntentStatus.CONFIRMED_PARTIAL,
  CryptoIntentStatus.CONFIRMED_OVERPAID,
]);

/** Nothing further will happen to an intent in one of these. */
export const TERMINAL_STATUSES: ReadonlySet<CryptoIntentStatus> = new Set([
  CryptoIntentStatus.CONFIRMED,
  CryptoIntentStatus.CONFIRMED_OVERPAID,
  CryptoIntentStatus.COMPLETED_VIA_TOPUP,
  CryptoIntentStatus.EXPIRED,
  CryptoIntentStatus.FAILED,
]);

/**
 * A 21Pay deposit intent, mirrored locally.
 *
 * 21Pay owns what happened on chain. This row owns which Oro user it belongs
 * to, and is what reconciliation compares their records against.
 */
@Unique("UQ_crypto_intents_pay21_id", ["pay21IntentId"])
@Unique("UQ_crypto_intents_idempotency", ["idempotencyKey"])
@Index("IDX_crypto_intents_user_status", ["userId", "status"])
@Index("IDX_crypto_intents_status_expires", ["status", "expiresAt"])
@Index("IDX_crypto_intents_credited_at", ["creditedAt"])
@Index("IDX_crypto_intents_deposit_address", ["depositAddress"])
@Entity("crypto_payment_intents")
export class CryptoPaymentIntent {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "userId" })
  user: User;

  /** Set once the deposit is credited, linking to the money record. */
  @Column({ type: "uuid", nullable: true })
  paymentId: string | null;

  /**
   * 21Pay's id. The stable natural key across detected, confirmed, partial and
   * top-up events — a `txHash` is per transfer, and a top-up produces a second
   * one against the same intent.
   */
  @Column({ type: "varchar", length: 64 })
  pay21IntentId: string;

  @Column({ type: "varchar", length: 16 })
  network: string;

  /** HD-derived per intent by 21Pay. Never a shared treasury address. */
  @Column({ type: "varchar", length: 128 })
  depositAddress: string;

  @Column({ type: "int", nullable: true })
  derivationIndex: number | null;

  /** What we asked for. */
  @Column({ type: "decimal", precision: 28, scale: 9 })
  amountUsdt: number;

  /**
   * What actually arrived. This is what gets credited — never the expectation.
   *
   * Note this is the amount the user is owed, not what 21Pay hands us: they
   * deduct a per-tenant fee at ledger-post time, so our claim on them is
   * `detected − fee`. Reconciliation models that; the credit does not.
   */
  @Column({ type: "decimal", precision: 28, scale: 9, nullable: true })
  detectedAmountUsdt: number | null;

  @Column({
    type: "enum",
    enum: CryptoIntentStatus,
    default: CryptoIntentStatus.AWAITING_DEPOSIT,
  })
  status: CryptoIntentStatus;

  /** Set on a top-up child, pointing at the intent it tops up. */
  @Column({ type: "varchar", length: 64, nullable: true })
  parentIntentId: string | null;

  @Column({ type: "uuid", nullable: true })
  transactionId: string | null;

  /** Set exactly once. The second guard against a double credit. */
  @Column({ type: "timestamptz", nullable: true })
  creditedAt: Date | null;

  @Column({ type: "varchar", length: 128 })
  idempotencyKey: string;

  @Column({ type: "timestamptz" })
  expiresAt: Date;

  @Column({ type: "varchar", length: 128, nullable: true })
  txHash: string | null;

  @Column({ type: "bigint", nullable: true })
  blockNumber: string | null;

  @Column({ type: "varchar", length: 255, nullable: true })
  failureReason: string | null;

  @Column({ type: "jsonb", nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
