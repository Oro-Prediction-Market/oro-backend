import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from "typeorm";
import { User } from "./user.entity";
import { Market } from "./market.entity";

/**
 * One row per (user, saved market) — a bookmark on a predictor's watchlist.
 *
 * The unique constraint is what enforces "saved once": the service lets
 * Postgres reject the duplicate rather than doing a read-then-write check,
 * which races on a double tap. Same pattern as MarketCommentLike.
 *
 * Unsaving DELETEs the row. A tombstone would buy nothing — nobody counts
 * saves, and the readers are profile pages.
 *
 * Deliberately carries no counter on markets: "saved 41 times" on a market
 * page would be a number people could pump, and nothing on the platform reads
 * it. If a public signal is ever wanted it can be aggregated from here.
 */
@Unique("UQ_saved_market", ["userId", "marketId"])
// Named, and composite on the read path, to say exactly what the migration
// creates. A bare @Index() on userId would have synchronize quietly replace the
// migration's index with a differently-named one in dev, leaving local and
// production disagreeing about a table neither is wrong about.
@Index("IDX_saved_markets_user_created", ["userId", "createdAt"])
@Index("IDX_saved_markets_marketId", ["marketId"])
@Entity("saved_markets")
export class SavedMarket {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column()
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "userId" })
  user: User;

  @Column()
  marketId: string;

  @ManyToOne(() => Market, { onDelete: "CASCADE" })
  @JoinColumn({ name: "marketId" })
  market: Market;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;
}
