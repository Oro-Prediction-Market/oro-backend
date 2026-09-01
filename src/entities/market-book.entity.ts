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
   * The per-head bond every participant in this book's resolution contest must
   * lock. Null until the first objector sets it; fixed for everyone after, so
   * all stakes in one contest are equal and the forfeit split is a clean
   * pro-rata.
   *
   * Per book rather than per market for the same reason `houseEdgePct` is: a
   * contest is settled inside the book its bonds were locked in, and there is
   * no rate at which a ngultrum bond and a USDT bond could be pooled.
   */
  @Column({ type: "decimal", precision: 28, scale: 9, nullable: true })
  disputeBondAmount: number | null;

  /**
   * Audit trail of what the losing side forfeited in this book's contest, set
   * once at resolution. Not a live balance — the money is paid out to the
   * winning side (or booked as house revenue) in the same pass that writes it.
   */
  @Column({ type: "decimal", precision: 28, scale: 9, default: 0 })
  disputeBondPool: number;

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
