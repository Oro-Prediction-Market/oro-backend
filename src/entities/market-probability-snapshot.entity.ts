import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

@Entity("market_probability_snapshots")
// The history query: one market's points in capture order.
@Index("IDX_mps_market_captured", ["marketId", "capturedAt"])
// The movers query: everything captured in a window.
@Index("IDX_mps_captured", ["capturedAt"])
export class MarketProbabilitySnapshot {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  marketId: string;

  @Column({ type: "uuid" })
  outcomeId: string;

  /** Crowd probability for this outcome, 0–1. Mirrors `outcomes.lmsrProbability`. */
  @Column({ type: "decimal", precision: 10, scale: 6 })
  probability: number;

  /**
   * Market pool at capture time. Context for the reader: a move from 40% to 70%
   * on Nu 200 of volume is noise, the same move on Nu 50,000 is news.
   */
  @Column({ type: "decimal", precision: 18, scale: 2, default: 0 })
  totalPool: number;

  /**
   * This outcome's own pool at capture time — the BTN book, same as
   * `totalPool` above and `outcomes.totalBetAmount`.
   *
   * `probability` is the LMSR value, which the apps deliberately do NOT show:
   * on a lopsided book it saturates to ~99/1 and stops describing where the
   * money actually is. Every screen instead prints the Laplace-smoothed pool
   * share, and that cannot be recomputed from a market-wide total alone. So the
   * per-outcome pool is stored and the share is derived at read time.
   *
   * NULLABLE with no default, deliberately: 0 is a real pool, and rows written
   * before this column existed have no honest value. NULL is the only way a
   * reader can tell "empty" from "unknown" and drop the point instead of
   * drawing a confidently wrong one.
   */
  @Column({ type: "decimal", precision: 18, scale: 2, nullable: true })
  outcomePool: number | null;

  @Index()
  @CreateDateColumn({ type: "timestamptz" })
  capturedAt: Date;
}
