import { Injectable, Logger } from "@nestjs/common";
import { Cron, Interval } from "@nestjs/schedule";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";
import { DEFAULT_HOUSE_EDGE_PCT } from "../markets/fee.constants";
import { Repository, DataSource } from "typeorm";
import {
  Market,
  MarketStatus,
  MarketCategory,
} from "../entities/market.entity";
import { Outcome } from "../entities/outcome.entity";
import { BtcPriceService, BtcPrice } from "./btc-price.service";
import { ParimutuelEngine } from "../markets/parimutuel.engine";

@Injectable()
export class BtcMarketService {
  private readonly logger = new Logger(BtcMarketService.name);
  private spawning = false;
  private ticking = false;
  private readonly processingMarkets = new Set<string>();

  /** Total round length: betting + measuring */
  private static readonly ROUND_MS = 9 * 60 * 1000;
  /** Betting closes this long before the round settles */
  private static readonly BETTING_BUFFER_MS = 3 * 60 * 1000;

  constructor(
    @InjectRepository(Market)
    private readonly marketRepo: Repository<Market>,
    private readonly btcPriceService: BtcPriceService,
    private readonly engine: ParimutuelEngine,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * Safety-net spawn check every 5 minutes (also used by the admin
   * POST /btc/spawn endpoint). The primary spawn path is the reference
   * lock step, which opens the next round the moment betting closes on
   * the current one.
   */
  @Cron("*/5 * * * *")
  async spawnMarket(): Promise<void> {
    await this.ensureBettableMarket();
  }

  /**
   * Main lifecycle tick, every 3 seconds:
   *   1. safety-net: lock a reference on rounds that reached betting close without one
   *   2. settle rounds whose measuring phase just ended
   *   3. spawn the next round the moment betting closes on the current one
   */
  @Interval(3_000)
  async tick(): Promise<void> {
    // A slow settle (price fetch + payout) can outlive the 3s interval — the
    // next tick would re-query and re-fire the whole settle check. Skip
    // overlapping ticks; the market is picked up on the next free one.
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.lockReferencePrices();
      await this.closeAndResolveMarkets();
      await this.ensureBettableMarket();
    } finally {
      this.ticking = false;
    }
  }

  async lockReferencePrices(): Promise<void> {
    const now = new Date();

    const markets = await this.marketRepo
      .createQueryBuilder("market")
      .where("market.externalSource = :source", { source: "btc" })
      .andWhere("market.status = :status", { status: MarketStatus.OPEN })
      .andWhere("market.bettingClosesAt <= :now", { now })
      .andWhere("market.closesAt > :now", { now })
      .getMany();

    const toLock = markets.filter(
      (m) =>
        m.metadata?.referencePrice == null &&
        !this.processingMarkets.has(m.id),
    );

    if (toLock.length === 0) return;

    // Claim before the (slow) price fetch so an overlapping tick skips these
    toLock.forEach((m) => this.processingMarkets.add(m.id));
    try {
      const price = await this.btcPriceService.fetchPrice();

      for (const market of toLock) {
        await this.marketRepo.update(market.id, {
          metadata: {
            ...(market.metadata || {}),
            referencePrice: price.price,
            referenceSource: price.source,
            referenceLockedAt: new Date().toISOString(),
          } as any,
        });
        this.logger.log(
          `[Lock] BTC market ${market.id} reference locked at $${price.price.toFixed(2)} (${price.source})`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to lock BTC reference price: ${error.message}`,
        error.stack,
      );
      return; // retried on the next tick
    } finally {
      toLock.forEach((m) => this.processingMarkets.delete(m.id));
    }
  }

  /**
   * Close and resolve BTC markets that have reached their close time.
   */
  async closeAndResolveMarkets(): Promise<void> {
    const now = new Date();

    const markets = await this.marketRepo
      .createQueryBuilder("market")
      .leftJoinAndSelect("market.outcomes", "outcome")
      .where("market.externalSource = :source", { source: "btc" })
      .andWhere("market.status = :status", { status: MarketStatus.OPEN })
      .andWhere("market.closesAt <= :now", { now })
      .getMany();

    if (markets.length === 0) {
      return;
    }

    this.logger.log(
      `Found ${markets.length} BTC market(s) to close and resolve`,
    );

    for (const market of markets) {
      try {
        await this.closeAndResolve(market);
      } catch (error) {
        this.logger.error(
          `Failed to close/resolve BTC market ${market.id}: ${error.message}`,
          error.stack,
        );
      }
    }
  }

  private async closeAndResolve(market: Market): Promise<void> {
    if (this.processingMarkets.has(market.id)) {
      this.logger.warn(
        `BTC market ${market.id} is already being processed — skipping duplicate interval tick`,
      );
      return;
    }
    this.processingMarkets.add(market.id);

    try {
      // ── Atomic claim: OPEN → CLOSED ─────────────────────────────────────────
      // Only one resolver (overlapping tick, second app instance, admin retry)
      // can win this conditional UPDATE; everyone else sees affected === 0 and
      // bails. Without this, a second pass would unconditionally re-transition
      // an already-RESOLVED market back through CLOSED → RESOLVING, letting it
      // pass the engine's RESOLVING → RESOLVED claim a second time and re-fire
      // the whole settlement flow (notifications, revenue record, logs).
      const claim = await this.marketRepo
        .createQueryBuilder()
        .update(Market)
        .set({ status: MarketStatus.CLOSED })
        .where("id = :id AND status = :status", {
          id: market.id,
          status: MarketStatus.OPEN,
        })
        .execute();
      if (!claim.affected) {
        this.logger.warn(
          `BTC market ${market.id} already claimed by another resolver — skipping duplicate settle`,
        );
        return;
      }

      this.logger.log(`Closing and resolving BTC market ${market.id}`);

      const referencePrice = market.metadata?.referencePrice;

      if (!referencePrice) {
        // Reference lock never succeeded (price API down for the whole
        // measuring phase) — refund everyone rather than settle blind.
        this.logger.error(
          `BTC market ${market.id} has no reference price in metadata — cancelling and refunding`,
        );
        await this.engine.cancelMarket(market.id);
        await this.ensureBettableMarket();
        return;
      }

      let settlementPrice: BtcPrice;
      try {
        settlementPrice = await this.btcPriceService.fetchPrice();
      } catch (error) {
        // Release the claim so the next tick retries the settle
        await this.marketRepo.update(
          { id: market.id, status: MarketStatus.CLOSED },
          { status: MarketStatus.OPEN },
        );
        throw error;
      }

      let winnerLabel: "UP" | "DOWN" | null = null;

      if (settlementPrice.price > referencePrice) {
        winnerLabel = "UP";
      } else if (settlementPrice.price < referencePrice) {
        winnerLabel = "DOWN";
      }

      if (!winnerLabel) {
        this.logger.log(
          `BTC market ${market.id} settlement price equals reference price — cancelling`,
        );
        await this.engine.cancelMarket(market.id);
        await this.ensureBettableMarket();
        return;
      }

      const winningOutcome = market.outcomes.find(
        (o) => o.label === winnerLabel,
      );

      if (!winningOutcome) {
        this.logger.error(
          `Could not find ${winnerLabel} outcome in BTC market ${market.id}`,
        );
        await this.engine.cancelMarket(market.id);
        await this.ensureBettableMarket();
        return;
      }

      const updatedMetadata = {
        ...(market.metadata || {}),
        settlementPrice: settlementPrice.price,
        settlementSource: settlementPrice.source,
        settledAt: new Date().toISOString(),
      };

      const evidenceNote = `BTC/USD at close: $${settlementPrice.price.toFixed(2)} (${settlementPrice.source}) vs reference: $${referencePrice.toFixed(2)}`;

      await this.marketRepo.update(market.id, {
        metadata: updatedMetadata as any,
        evidenceNote,
      });

      // Bypass dispute window: backdate disputeDeadlineAt to the past.
      // Conditional on CLOSED (set by our claim above) so a stale caller can
      // never drag a RESOLVED market back into RESOLVING.
      const toResolving = await this.marketRepo
        .createQueryBuilder()
        .update(Market)
        .set({
          status: MarketStatus.RESOLVING,
          proposedOutcomeId: winningOutcome.id,
          windowMinutes: 10,
          disputeDeadlineAt: new Date(Date.now() - 1000),
        })
        .where("id = :id AND status = :status", {
          id: market.id,
          status: MarketStatus.CLOSED,
        })
        .execute();
      if (!toResolving.affected) {
        this.logger.warn(
          `BTC market ${market.id} left CLOSED state mid-settle — skipping resolve`,
        );
        return;
      }

      this.logger.log(
        `Resolving BTC market ${market.id} with winner: ${winnerLabel}`,
      );
      await this.engine.resolveMarket(
        market.id,
        winningOutcome.id,
        "system:auto-resolve",
        undefined,
        evidenceNote,
      );

      // Safety net — the lock step normally spawned the next round already
      await this.ensureBettableMarket();
    } finally {
      this.processingMarkets.delete(market.id);
    }
  }

  /**
   * Spawn a new round unless one is still accepting bets.
   * The current price is snapshotted as the reference ("price to beat"),
   * fixed for the whole round.
   */
  private async ensureBettableMarket(): Promise<void> {
    if (this.spawning) return;
    this.spawning = true;
    try {
      const now = new Date();
      const bettable = await this.marketRepo
        .createQueryBuilder("market")
        .where("market.externalSource = :source", { source: "btc" })
        .andWhere("market.status = :status", { status: MarketStatus.OPEN })
        .andWhere("market.bettingClosesAt > :now", { now })
        .getOne();

      if (bettable) {
        return;
      }

      // Price fetch failure aborts the spawn — retried on the next tick
      const price = await this.btcPriceService.fetchPrice();

      const closesAt = new Date(now.getTime() + BtcMarketService.ROUND_MS);
      const bettingClosesAt = new Date(
        closesAt.getTime() - BtcMarketService.BETTING_BUFFER_MS,
      );

      await this.dataSource.transaction(async (manager) => {
        await manager.query(
          "SELECT pg_advisory_xact_lock(hashtext('btc-market-spawn'))",
        );
        const existing = await manager
          .getRepository(Market)
          .createQueryBuilder("market")
          .where("market.externalSource = :source", { source: "btc" })
          .andWhere("market.status = :status", { status: MarketStatus.OPEN })
          .andWhere("market.bettingClosesAt > :now", { now })
          .getOne();
        if (existing) {
          this.logger.warn(
            `BTC round ${existing.id} was spawned concurrently — skipping duplicate spawn`,
          );
          return;
        }

        const market = manager.create(Market, {
          title: "BTC — UP or DOWN in 9 minutes?",
          category: MarketCategory.ECONOMY,
          status: MarketStatus.OPEN,
          opensAt: now,
          closesAt,
          bettingClosesAt,
          externalSource: "btc",
          externalMarketType: "price-prediction",
          houseEdgePct: DEFAULT_HOUSE_EDGE_PCT,
          liquidityParam: 1000,
          metadata: {
            isBtc: true,
            openedAt: now.toISOString(),
            referencePrice: price.price,
            referenceSource: price.source,
            referenceLockedAt: now.toISOString(),
          },
        });

        const savedMarket = await manager.save(Market, market);

        const upOutcome = manager.create(Outcome, {
          marketId: savedMarket.id,
          label: "UP",
          description: "BTC price will increase",
          totalPool: 0,
        });

        const downOutcome = manager.create(Outcome, {
          marketId: savedMarket.id,
          label: "DOWN",
          description: "BTC price will decrease",
          totalPool: 0,
        });

        await manager.save(Outcome, [upOutcome, downOutcome]);

        this.logger.log(
          `Spawned BTC round ${savedMarket.id}: betting until ${bettingClosesAt.toISOString()}, settles ${closesAt.toISOString()}`,
        );
      });
    } catch (error) {
      this.logger.error(
        `Failed to spawn BTC market: ${error.message}`,
        error.stack,
      );
    } finally {
      this.spawning = false;
    }
  }
}
