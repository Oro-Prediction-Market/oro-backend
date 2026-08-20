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

export enum PaymentType {
  DEPOSIT = "deposit",
  WITHDRAWAL = "withdrawal",
  POSITION_PLACED = "position_placed",
  POSITION_PAYOUT = "position_payout",
  REFUND = "refund",
}

export enum PaymentStatus {
  PENDING = "pending",
  PROCESSING = "processing",
  SUCCESS = "success",
  FAILED = "failed",
  CANCELLED = "cancelled",
}

export enum PaymentMethod {
  DK_BANK = "dkbank",
  /**
   * @deprecated Never carried a working rail.
   *
   * The value stays because Postgres cannot remove an enum member and old rows
   * may reference it. Nothing offers it: `GET /payments/methods` stopped
   * returning it, and USDT arrives via `usdt` on the 21 Pay rail instead. TON
   * itself is out of scope — its only rationale was Telegram-native signing,
   * and the Telegram client is BTN-only. See docs/usdt-oro/README.md §4.
   */
  TON = "ton",
  CREDITS = "credits",
  /**
   * USDT over the 21 Pay rail, any supported chain.
   *
   * Not `usdt_trc20`: four chains are planned and a payment method should not
   * name one of them. The network lives on the intent row.
   */
  USDT = "usdt",
}

@Index(["userId"])
@Index(["status"])
@Entity("payments")
export class Payment {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "enum", enum: PaymentType })
  type: PaymentType;

  @Column({ type: "enum", enum: PaymentStatus, default: PaymentStatus.PENDING })
  status: PaymentStatus;

  @Column({ type: "enum", enum: PaymentMethod })
  method: PaymentMethod;

  @Column({ type: "decimal", precision: 28, scale: 9 })
  amount: number;

  @Column({ type: "varchar", length: 10, default: "BTN" })
  currency: string;

  @Column({ type: "varchar", nullable: true, unique: true })
  externalPaymentId: string | null;

  @Column({ type: "varchar", nullable: true })
  referenceId: string | null;

  // DK-specific refs to correlate callbacks/webhooks reliably.
  @Column({ type: "varchar", nullable: true, name: "dkinquiryid" })
  dkInquiryId: string | null;

  @Column({ type: "varchar", nullable: true, name: "dktxnstatusid" })
  dkTxnStatusId: string | null;

  @Column({ type: "varchar", nullable: true, name: "dkrequestid" })
  dkRequestId: string | null;

  @Column({ type: "varchar", nullable: true })
  customerPhone: string | null;

  @Column({ type: "varchar", nullable: true })
  description: string | null;

  @Column({ type: "json", nullable: true })
  metadata: Record<string, any> | null;

  @Column({ type: "varchar", nullable: true })
  failureReason: string | null;

  @Column({ type: "timestamptz", nullable: true })
  confirmedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => User, (u) => u.payments, { onDelete: "CASCADE" })
  @JoinColumn()
  user: User;

  @Column()
  userId: string;
}
