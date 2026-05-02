import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import { User } from "./user.entity";
import { Payment } from "./payment.entity";
import { Market } from "./market.entity";
import { Dispute } from "./dispute.entity";

export enum OtpStatus {
  PENDING   = "pending",   // OTP sent, awaiting user input
  VERIFIED  = "verified",  // OTP confirmed successfully
  EXPIRED   = "expired",   // OTP window elapsed without verification
  CANCELLED = "cancelled", // Payment was cancelled / failed before OTP
}

@Entity("payment_otps")
export class PaymentOtp {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  // ── Status ────────────────────────────────────────────────────────────────

  @Column({ type: "enum", enum: OtpStatus, default: OtpStatus.PENDING })
  status: OtpStatus;

  // ── Timing ────────────────────────────────────────────────────────────────

  /** When the OTP link was first created (first send). */
  @CreateDateColumn()
  createdAt: Date;

  /** When the OTP window expires — set to createdAt + 5 min on creation. */
  @Column()
  expiresAt: Date;

  /** Updated each time a new OTP is sent (resend). */
  @Column({ type: "timestamptz", nullable: true })
  lastRequestedAt: Date | null;

  /** When the user successfully verified the OTP. */
  @Column({ type: "timestamptz", nullable: true })
  verifiedAt: Date | null;

  @UpdateDateColumn()
  updatedAt: Date;

  // ── Attempt tracking ─────────────────────────────────────────────────────

  /** Total number of times the user requested an OTP (first send + resends). */
  @Column({ type: "int", default: 1 })
  requestCount: number;

  /** Number of incorrect OTP attempts submitted by the user. */
  @Column({ type: "int", default: 0 })
  failedAttempts: number;

  // ── DK Bank reference ─────────────────────────────────────────────────────

  /**
   * DK Bank's bfsTxnId returned from account_auth.
   * Required to call debit_request (confirm OTP step).
   */
  @Column({ type: "varchar", nullable: true })
  bfsTxnId: string | null;

  // ── Relations ─────────────────────────────────────────────────────────────

  /** The DK Bank payment this OTP session belongs to. */
  @Index()
  @Column({ type: "uuid", nullable: true })
  paymentId: string | null;

  @ManyToOne(() => Payment, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn()
  payment: Payment | null;

  /** User who initiated the payment / triggered the OTP. */
  @Index()
  @Column()
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn()
  user: User;

  /**
   * Market context — set when the payment is for placing a position
   * or topping up credits to position on a specific market.
   */
  @Index()
  @Column({ type: "uuid", nullable: true })
  marketId: string | null;

  @ManyToOne(() => Market, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn()
  market: Market | null;

  /**
   * Dispute context — set when the payment is for a dispute bond.
   */
  @Index()
  @Column({ type: "uuid", nullable: true })
  disputeId: string | null;

  @ManyToOne(() => Dispute, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn()
  dispute: Dispute | null;
}
