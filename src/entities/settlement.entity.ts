import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

// Declared here as well as in the migration: DB_SYNCHRONIZE drops any index
// absent from entity metadata.
@Index("IDX_settlements_market_currency", ["marketId", "currency"])
@Entity("settlements")
export class Settlement {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  marketId: string;

  @Column({ type: "uuid" })
  winningOutcomeId: string;

  @Column({ name: "totalBets", type: "int", default: 0 })
  totalPositions: number;

  @Column({ name: "winningBets", type: "int", default: 0 })
  winningPositions: number;

  @Column({ type: "decimal", precision: 28, scale: 9, default: 0 })
  totalPool: number;

  @Column({ type: "decimal", precision: 28, scale: 9, default: 0 })
  houseAmount: number;

  @Column({ type: "decimal", precision: 28, scale: 9, default: 0 })
  payoutPool: number;

  @Column({ type: "decimal", precision: 28, scale: 9, default: 0 })
  totalPaidOut: number;

  /** Refund reason, e.g. "thin_pool" or "payout_floor_underfunded"; null for paid settlements. */
  @Column({ type: "varchar", length: 32, nullable: true })
  cancelReason: string | null;


  /**
   * Denormalised from the market's book so aggregations need no join, the same
   * way transactions.currency works. Never disagrees with the book it belongs
   * to; Stage I reconciliation asserts that.
   */
  @Column({ type: "varchar", length: 10, default: "BTN" })
  currency: string;

  @CreateDateColumn()
  settledAt: Date;
}
