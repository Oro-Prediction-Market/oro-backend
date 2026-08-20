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
import { Market } from "./market.entity";

@Unique("UQ_market_books_market_currency", ["marketId", "currency"])
@Index("IDX_market_books_marketId", ["marketId"])
@Index("IDX_market_books_currency", ["currency"])
@Entity("market_books")
export class MarketBook {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  marketId: string;

  @ManyToOne(() => Market, { onDelete: "CASCADE" })
  @JoinColumn({ name: "marketId" })
  market: Market;

  /** 'BTN' or 'USDT'. Immutable once the book has positions. */
  @Column({ type: "varchar", length: 10 })
  currency: string;

  /** Everything staked into this book. The payout basis for its winners. */
  @Column({ type: "decimal", precision: 28, scale: 9, default: 0 })
  totalPool: number;

  /**
   * The platform cut for this book, in percent.
   *
   * Per book rather than per market: BTN and USDT can carry different rates,
   * and there is no reason a rate set for one cohort should bind the other.
   */
  @Column({ type: "decimal", precision: 5, scale: 2 })
  houseEdgePct: number;

  /** Minimum stake, in this book's currency. Not a converted figure. */
  @Column({ type: "decimal", precision: 28, scale: 9 })
  minStake: number;

  /**
   * Per-book lifecycle. A market can settle with one book paid out and the
   * other refunded — a thin USDT pool that cannot fund its payout floor
   * refunds on its own, without affecting the BTN book on the same event.
   */
  @Column({ type: "varchar", length: 32, default: "open" })
  status: string;

  /**
   * Whether this book accepts stakes. Lets a market exist BTN-only rather than
   * forcing an empty USDT book onto every event in the feed.
   */
  @Column({ type: "boolean", default: true })
  isEnabled: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
