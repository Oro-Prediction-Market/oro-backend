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
  SUCCESS = "success",
  FAILED = "failed",
  CANCELLED = "cancelled",
}

export enum PaymentMethod {
  DK_BANK = "dkbank",
  TON = "ton",
  CREDITS = "credits",
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

  @Column({ type: "decimal", precision: 18, scale: 2 })
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
