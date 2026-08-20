import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

export enum DistributionStatus {
  PENDING = "pending",
  COMPLETED = "completed",
  FAILED = "failed",
}

/**
 * Revenue Distribution Entity
 *
 * Tracks house edge (platform fee) transfers from the beneficiary account
 * to the public account (DK_PUBLIC_ACCOUNT_NO) for each settled market.
 *
 * Flow: Market settles → houseAmount recorded as PENDING → Admin triggers
 * transfer → DK Gateway moves BTN from bene acc → public acc → COMPLETED
 */
@Entity("revenue_distributions")
export class RevenueDistribution {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ type: "uuid", nullable: true })
  marketId: string | null;

  @Index()
  @Column({ type: "uuid", nullable: true })
  settlementId: string | null;

  /** Set for duel (challenge) distributions; null for market distributions */
  @Index()
  @Column({ type: "uuid", nullable: true })
  challengeId: string | null;

  /** House edge amount to transfer (Nu) */
  @Column({ type: "decimal", precision: 28, scale: 9 })
  amount: number;

  /** House edge percentage at time of settlement (for audit) */
  @Column({ type: "decimal", precision: 5, scale: 2 })
  houseEdgePct: number;

  /** Total pool at time of settlement (for audit) */
  @Column({ type: "decimal", precision: 28, scale: 9 })
  totalPool: number;

  /** Destination: DK_PUBLIC_ACCOUNT_NO */
  @Column({ type: "varchar", length: 50 })
  publicAccountNo: string;

  /** Transfer status */
  @Column({
    type: "enum",
    enum: DistributionStatus,
    default: DistributionStatus.PENDING,
  })
  status: DistributionStatus;

  /** DK Bank transaction reference (set after successful transfer) */
  @Column({ type: "varchar", length: 100, nullable: true })
  paymentReference: string | null;


  /**
   * Denormalised from the market's book so aggregations need no join, the same
   * way transactions.currency works. Never disagrees with the book it belongs
   * to; Stage I reconciliation asserts that.
   */
  @Column({ type: "varchar", length: 10, default: "BTN" })
  currency: string;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: "timestamp", nullable: true })
  paidAt: Date | null;
}
