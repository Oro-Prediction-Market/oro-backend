import { Injectable, Logger } from "@nestjs/common";
import { Cron, Interval } from "@nestjs/schedule";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";
import { Repository, DataSource } from "typeorm";
import {
  Market,
  MarketStatus,
  MarketCategory,
} from "../entities/market.entity";
import { Outcome } from "../entities/outcome.entity";
import { TerPriceService, TerPrice } from "./ter-price.service";
import { ParimutuelEngine } from "../markets/parimutuel.engine";

@Injectable()
export class TerMarketService {
  private readonly logger = new Logger(TerMarketService.name);
  private spawning = false;
  private readonly processingMarkets = new Set<string>();

  /** Total round length: betting + measuring */
  private static readonly ROUND_MS = 3 * 60 * 60 * 1000;
  /** Betting closes this long before the round settles */
  private static readonly BETTING_BUFFER_MS = 3 * 60 * 1000;

  constructor(
    @InjectRepository(Market)
    private readonly marketRepo: Repository<Market>,
    private readonly terPriceService: TerPriceService,
    private readonly engine: ParimutuelEngine,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * Safety-net spawn check every 5 minutes (also used by the admin spawn
   * endpoint). The primary spawn path is the reference lock step, which
   * opens the next round the moment betting closes on the current one.
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
    await this.lockReferencePrices();
    await this.closeAndResolveMarkets();
    await this.ensureBettableMarket();
  }

  /**
   * Safety net: the reference ("price to beat") is normally snapshotted when
   * the round is spawned. Rounds that reach betting close without one (price
   * API was down at spawn, or legacy rounds from the lock-at-betting-close
   * era) get the current price locked here so they can still settle.
   */
  async lockReferencePrices(): Promise<void> {
    const now = new Date();

    const markets = await this.marketRepo
      .createQueryBuilder("market")
      .where("market.externalSource = :source", { source: "ter" })
      .andWhere("market.status = :status", { status: MarketStatus.OPEN })
      .andWhere("market.bettingClosesAt <= :now", { now })
      .andWhere("market.closesAt > :now", { now })
      .getMany();

    const toLock = markets.filter(
      (m) =>
        m.metadata?.referenceBuyPrice == null &&
        m.metadata?.referenceTerPrice == null &&
        !this.processingMarkets.has(m.id),
    );

    if (toLock.length === 0) return;

    // Claim before the (slow) price fetch so an overlapping tick skips these
    toLock.forEach((m) => this.processingMarkets.add(m.id));
    try {
      const price = await this.terPriceService.fetchPrice();

      for (const market of toLock) {
        await this.marketRepo.update(market.id, {
          metadata: {
            ...(market.metadata || {}),
            referenceTerPrice: price.midPrice,
            referenceBuyPrice: price.buyPrice,
            referenceSellPrice: price.sellPrice,
            openXauUsd: price.xauUsd,
            referenceLockedAt: new Date().toISOString(),
          } as any,
        });
        this.logger.log(
          `[Lock] TER market ${market.id} reference locked at Nu ${price.buyPrice.toFixed(4)}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to lock TER reference price: ${error.message}`,
        error.stack,
      );
      return; // retried on the next tick
    } finally {
      toLock.forEach((m) => this.processingMarkets.delete(m.id));
    }
  }

  /**
   * Close and resolve TER markets that have reached their close time.
   */
  async closeAndResolveMarkets(): Promise<void> {
    const now = new Date();

    const markets = await this.marketRepo
      .createQueryBuilder("market")
      .leftJoinAndSelect("market.outcomes", "outcome")
      .where("market.externalSource = :source", { source: "ter" })
      .andWhere("market.status = :status", { status: MarketStatus.OPEN })
      .andWhere("market.closesAt <= :now", { now })
      .getMany();

    if (markets.length === 0) {
      return;
    }

    this.logger.log(
      `Found ${markets.length} TER market(s) to close and resolve`,
    );

    for (const market of markets) {
      try {
        await this.closeAndResolve(market);
      } catch (error) {
        this.logger.error(
          `Failed to close/resolve TER market ${market.id}: ${error.message}`,
          error.stack,
        );
      }
    }
  }

  /**
   * Close and resolve a single TER market.
   */
  private async closeAndResolve(market: Market): Promise<void> {
    if (this.processingMarkets.has(market.id)) {
      this.logger.warn(
        `TER market ${market.id} is already being processed — skipping duplicate interval tick`,
      );
      return;
    }
    this.processingMarkets.add(market.id);

    try {
      this.logger.log(`Closing and resolving TER market ${market.id}`);

      // Reference buy price locked at betting close (fall back to midPrice
      // for legacy markets that snapshotted at spawn)
      const referenceBuyPrice =
        market.metadata?.referenceBuyPrice ??
        market.metadata?.referenceTerPrice;

      if (!referenceBuyPrice) {
        // Reference lock never succeeded (price API down for the whole
        // measuring phase) — refund everyone rather than settle blind.
        this.logger.error(
          `TER market ${market.id} has no reference price in metadata — cancelling and refunding`,
        );
        await this.engine.cancelMarket(market.id);
        await this.ensureBettableMarket();
        return;
      }

      const settlementPrice = await this.terPriceService.fetchPrice();

      // Determine winner: UP if settlement buy price > reference buy price
      let winnerLabel: "UP" | "DOWN" | null = null;

      if (settlementPrice.buyPrice > referenceBuyPrice) {
        winnerLabel = "UP";
      } else if (settlementPrice.buyPrice < referenceBuyPrice) {
        winnerLabel = "DOWN";
      }

      // If prices are equal, cancel the market
      if (!winnerLabel) {
        this.logger.log(
          `TER market ${market.id} settlement price equals reference price - cancelling`,
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
          `Could not find ${winnerLabel} outcome in TER market ${market.id}`,
        );
        await this.engine.cancelMarket(market.id);
        await this.ensureBettableMarket();
        return;
      }

      // Update market metadata with settlement data
      const updatedMetadata = {
        ...(market.metadata || {}),
        settlementTerPrice: settlementPrice.midPrice,
        settlementBuyPrice: settlementPrice.buyPrice,
        settlementSellPrice: settlementPrice.sellPrice,
        closeXauUsd: settlementPrice.xauUsd,
      };

      const evidenceNote = `TER buy price at close: Nu ${settlementPrice.buyPrice.toFixed(4)} vs reference: Nu ${referenceBuyPrice.toFixed(4)} → ${winnerLabel}`;

      await this.marketRepo.update(market.id, {
        status: MarketStatus.CLOSED,
        metadata: updatedMetadata as any,
        evidenceNote,
      });

      // TER markets skip the dispute window entirely.
      // Combine propose + backdate into a single DB write to cut ~100ms of latency.
      await this.marketRepo.update(market.id, {
        status: MarketStatus.RESOLVING,
        proposedOutcomeId: winningOutcome.id,
        windowMinutes: 10,
        disputeDeadlineAt: new Date(Date.now() - 1000), // already expired → no window
      });

      this.logger.log(
        `Resolving TER market ${market.id} with winner: ${winnerLabel}`,
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
        .where("market.externalSource = :source", { source: "ter" })
        .andWhere("market.status = :status", { status: MarketStatus.OPEN })
        .andWhere("market.bettingClosesAt > :now", { now })
        .getOne();

      if (bettable) {
        return;
      }

      // Price fetch failure aborts the spawn — retried on the next tick
      const price = await this.terPriceService.fetchPrice();

      const closesAt = new Date(now.getTime() + TerMarketService.ROUND_MS);
      const bettingClosesAt = new Date(
        closesAt.getTime() - TerMarketService.BETTING_BUFFER_MS,
      );

      await this.dataSource.transaction(async (manager) => {
        await manager.query(
          "SELECT pg_advisory_xact_lock(hashtext('ter-market-spawn'))",
        );
        const existing = await manager
          .getRepository(Market)
          .createQueryBuilder("market")
          .where("market.externalSource = :source", { source: "ter" })
          .andWhere("market.status = :status", { status: MarketStatus.OPEN })
          .andWhere("market.bettingClosesAt > :now", { now })
          .getOne();
        if (existing) {
          this.logger.warn(
            `TER round ${existing.id} was spawned concurrently — skipping duplicate spawn`,
          );
          return;
        }

        const market = manager.create(Market, {
          title: "TER — UP or DOWN in 3 hours?",
          category: MarketCategory.ECONOMY,
          status: MarketStatus.OPEN,
          opensAt: now,
          closesAt,
          bettingClosesAt,
          externalSource: "ter",
          externalMarketType: "price-prediction",
          houseEdgePct: 5,
          liquidityParam: 1000,
          metadata: {
            isTer: true,
            openedAt: now.toISOString(),
            referenceTerPrice: price.midPrice,
            referenceBuyPrice: price.buyPrice,
            referenceSellPrice: price.sellPrice,
            openXauUsd: price.xauUsd,
            referenceLockedAt: now.toISOString(),
          },
        });

        const savedMarket = await manager.save(Market, market);

        const upOutcome = manager.create(Outcome, {
          marketId: savedMarket.id,
          label: "UP",
          description: "TER price will increase",
          totalPool: 0,
        });

        const downOutcome = manager.create(Outcome, {
          marketId: savedMarket.id,
          label: "DOWN",
          description: "TER price will decrease",
          totalPool: 0,
        });

        await manager.save(Outcome, [upOutcome, downOutcome]);

        this.logger.log(
          `Spawned TER round ${savedMarket.id}: betting until ${bettingClosesAt.toISOString()}, settles ${closesAt.toISOString()}`,
        );
      });
    } catch (error) {
      this.logger.error(
        `Failed to spawn TER market: ${error.message}`,
        error.stack,
      );
    } finally {
      this.spawning = false;
    }
  }
}
