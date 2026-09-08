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

  @Index()
  @CreateDateColumn({ type: "timestamptz" })
  capturedAt: Date;
}
