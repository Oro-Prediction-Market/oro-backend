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

  /**
   * Forfeited dispute bonds booked into `houseAmount`, and NOT part of
   * `totalPool`.
   *
   * Kept separately because the two are different kinds of money. The edge is
   * taken out of the pool; a forfeit is a losing objector's bond, which the
   * pool never held. Blending them makes the realised edge read above the
   * configured one — `houseAmount / totalPool` showed 11.11% on a 10% market
   * that had taken a single Nu 10 bond — which is exactly the number someone
   * would reach for to check the edge was applied correctly.
   *
   * The settlement already preserves the identity
   *   totalPool === totalPaidOut + (houseAmount − houseForfeit)
   * but it was only reconstructable by subtraction, which also swept up
   * rounding breakage. Storing it makes the split a fact rather than an
   * inference.
   *
   * Rows written before this column existed keep 0: their forfeits are not
   * recoverable from arithmetic alone, so a historical edge figure may still
   * be blended. New settlements are exact.
   */
  @Column({ type: "decimal", precision: 28, scale: 9, default: 0 })
  houseForfeit: number;

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
