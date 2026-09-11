import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";
import { SavedMarket } from "../entities/saved-market.entity";
import { Market } from "../entities/market.entity";
import { MarketsService } from "../markets/markets.service";

/**
 * A user's saved markets.
 *
 * Bookmarks, not positions: saving costs nothing and commits nothing. The list
 * is deliberately unbounded in kind — any market can be saved, whatever its
 * status — because a settled market you saved is still the market you wanted
 * to come back to.
 *
 * A list is readable by anyone who can see its owner's profile, and writable
 * only by its owner. {@link list} is therefore used by both the owner's page
 * and a visitor's, and must never return anything a profile would not.
 */
@Injectable()
export class SavedMarketsService {
  constructor(
    @InjectRepository(SavedMarket)
    private readonly savedRepo: Repository<SavedMarket>,
    @InjectRepository(Market)
    private readonly marketRepo: Repository<Market>,
    private readonly markets: MarketsService,
  ) {}

  /**
   * Save a market. Idempotent: saving twice is a no-op, not an error, because
   * the button is a toggle and a double tap must not 500.
   */
  async save(userId: string, marketId: string): Promise<{ saved: true }> {
    const exists = await this.marketRepo.exists({ where: { id: marketId } });
    if (!exists) throw new NotFoundException("Market not found");

    // ON CONFLICT DO NOTHING against UQ_saved_market, rather than SELECT then
    // INSERT — the read-then-write version races itself on a double tap.
    await this.savedRepo
      .createQueryBuilder()
      .insert()
      .into(SavedMarket)
      .values({ userId, marketId })
      .orIgnore()
      .execute();

    return { saved: true };
  }

  /** Unsave. Also idempotent — removing what is not there is success. */
  async unsave(userId: string, marketId: string): Promise<{ saved: false }> {
    await this.savedRepo.delete({ userId, marketId });
    return { saved: false };
  }

  /**
   * Just the ids, newest save first.
   *
   * This is what the feed and the detail page ask for on load, to know which
   * bookmarks to draw filled. One small array beats asking per card, and it
   * costs a single index scan.
   */
  async listIds(userId: string): Promise<string[]> {
    const rows = await this.savedRepo.find({
      where: { userId },
      select: { marketId: true },
      order: { createdAt: "DESC" },
    });
    return rows.map((r) => r.marketId);
  }

  /**
   * The saved markets themselves, newest save first, in the same shape the
   * feed serves so the same cards render them.
   *
   * A market that has since been hard-deleted simply drops out: the foreign
   * key cascades the bookmark away with it, so there is nothing to clean up.
   */
  async list(
    userId: string,
    limit?: number,
  ): Promise<(Market & { savedAt: Date })[]> {
    const rows = await this.savedRepo.find({
      where: { userId },
      order: { createdAt: "DESC" },
      ...(limit ? { take: limit } : {}),
    });
    if (!rows.length) return [];

    const markets = await this.markets.findManyByIds(
      rows.map((r) => r.marketId),
    );
    const byId = new Map(markets.map((m) => [m.id, m]));

    // Ordered by the bookmark, not by the market: the list is a reading list,
    // so the thing saved last belongs at the top regardless of market age.
    return rows.flatMap((row) => {
      const market = byId.get(row.marketId);
      return market
        ? [Object.assign(market, { savedAt: row.createdAt })]
        : [];
    });
  }

  /** Whether this user has saved these markets — used to hydrate one page. */
  async savedSet(userId: string, marketIds: string[]): Promise<Set<string>> {
    if (!marketIds.length) return new Set();
    const rows = await this.savedRepo.find({
      where: { userId, marketId: In(marketIds) },
      select: { marketId: true },
    });
    return new Set(rows.map((r) => r.marketId));
  }
}
