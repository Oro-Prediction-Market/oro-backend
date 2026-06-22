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

  constructor(
    @InjectRepository(Market)
    private readonly marketRepo: Repository<Market>,
    private readonly terPriceService: TerPriceService,
    private readonly engine: ParimutuelEngine,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * Spawn a new TER market every 24 hours
   * Runs at midnight each day
   * Only spawns if no active TER market exists
   */
  @Cron("0 0 * * *")
  async spawnMarket(): Promise<void> {
    if (this.spawning) return;
    this.spawning = true;
    this.logger.log("Checking if we should spawn a new TER market...");

    try {
      // Check if there's already an active TER market (open or upcoming)
      const existingMarket = await this.marketRepo.findOne({
        where: {
          externalSource: "ter",
          status: MarketStatus.OPEN,
        },
      });

      if (existingMarket) {
        this.logger.log(
          `TER market ${existingMarket.id} is still open. Skipping spawn.`,
        );
        return;
      }

      this.logger.log("No active TER market found. Spawning new one...");

      // Fetch current TER price
      const price = await this.terPriceService.fetchPrice();

      // Market opens immediately
      const now = new Date();

      // Market closes in 24 hours
      const closesAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      // Betting closes 4 hours before market close
      const bettingClosesAt = new Date(closesAt.getTime() - 4 * 60 * 60 * 1000);

      await this.dataSource.transaction(async (manager) => {
        // Create market
        const market = manager.create(Market, {
          title: "TER — UP or DOWN in 24 hours?",
          category: MarketCategory.OTHER,
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
            referenceTerPrice: price.midPrice,
            referenceBuyPrice: price.buyPrice,
            referenceSellPrice: price.sellPrice,
            openXauUsd: price.xauUsd,
          },
        });

        const savedMarket = await manager.save(Market, market);

        // Create UP and DOWN outcomes
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
          `Created TER market ${savedMarket.id} with reference price Nu ${price.buyPrice.toFixed(4)}`,
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

  /**
   * Close and resolve TER markets that have reached their close time
   * Runs every 3 seconds
   */
  @Interval(3_000)
  async closeAndResolveMarkets(): Promise<void> {
    const now = new Date();

    // Find all open TER markets that should be closed
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
   * Close betting on TER markets 2 minutes before close
   * Runs every minute
   */
  @Cron("* * * * *")
  async closeBetting(): Promise<void> {
    const now = new Date();

    // Find all open TER markets where betting should close
    const markets = await this.marketRepo
      .createQueryBuilder("market")
      .where("market.externalSource = :source", { source: "ter" })
      .andWhere("market.status = :status", { status: MarketStatus.OPEN })
      .andWhere("market.bettingClosesAt <= :now", { now })
      .andWhere("market.closesAt > :now", { now })
      .getMany();

    if (markets.length === 0) {
      return;
    }

    this.logger.log(`Closing betting on ${markets.length} TER market(s)`);

    for (const market of markets) {
      // Just log it - the frontend will check bettingClosesAt
      this.logger.log(
        `Betting closed on TER market ${market.id} at ${now.toISOString()} (4h before settlement)`,
      );
    }
  }

  /**
   * Close and resolve a single TER market
   * After resolution, immediately spawns the next market
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

    // Fetch settlement price
    const settlementPrice = await this.terPriceService.fetchPrice();

    // Get reference buy price from metadata (fall back to midPrice for legacy markets)
    const referenceBuyPrice =
      market.metadata?.referenceBuyPrice ?? market.metadata?.referenceTerPrice;

    if (!referenceBuyPrice) {
      this.logger.error(
        `TER market ${market.id} has no reference price in metadata`,
      );
      // Cancel the market
      await this.engine.cancelMarket(market.id);
      // Still spawn next market
      await this.spawnNextMarket();
      return;
    }

    // Determine winner: UP if settlement buy price > reference buy price, DOWN if lower
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
      // Still spawn next market
      await this.spawnNextMarket();
      return;
    }

    // Find winning outcome
    const winningOutcome = market.outcomes.find((o) => o.label === winnerLabel);

    if (!winningOutcome) {
      this.logger.error(
        `Could not find ${winnerLabel} outcome in TER market ${market.id}`,
      );
      await this.engine.cancelMarket(market.id);
      await this.spawnNextMarket();
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

    const evidenceNote = `TER buy price at close: Nu ${settlementPrice.buyPrice.toFixed(4)} vs open: Nu ${referenceBuyPrice.toFixed(4)} → ${winnerLabel}`;

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

    // Immediately spawn the next market — reuse settlement price to avoid a second API call
    await this.spawnNextMarketWithPrice(settlementPrice);
    } finally {
      this.processingMarkets.delete(market.id);
    }
  }

  /**
   * Spawn the next TER market immediately after the previous one closes.
   * Accepts an optional pre-fetched price to avoid a redundant API call.
   */
  private async spawnNextMarketWithPrice(price?: TerPrice): Promise<void> {
    if (this.spawning) return;
    this.spawning = true;
    try {
      // Check if there's already an active TER market
      const existing = await this.marketRepo.findOne({
        where: { externalSource: "ter", status: MarketStatus.OPEN },
      });
      if (existing) {
        this.logger.log("Next TER market already exists, skipping spawn.");
        return;
      }

      // Reuse provided price or fetch fresh
      const p = price ?? (await this.terPriceService.fetchPrice());
      const now = new Date();
      const closesAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const bettingClosesAt = new Date(closesAt.getTime() - 4 * 60 * 60 * 1000);

      await this.dataSource.transaction(async (manager) => {
        const market = manager.create(Market, {
          title: "TER — UP or DOWN in 24 hours?",
          category: MarketCategory.OTHER,
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
            referenceTerPrice: p.midPrice,
            referenceBuyPrice: p.buyPrice,
            referenceSellPrice: p.sellPrice,
            openXauUsd: p.xauUsd,
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
          `[Back-to-back] Spawned next TER market ${savedMarket.id} with reference price Nu ${p.buyPrice.toFixed(4)}`,
        );
      });
    } catch (error) {
      this.logger.error(
        `Failed to spawn next TER market: ${error.message}`,
        error.stack,
      );
    } finally {
      this.spawning = false;
    }
  }

  /** Convenience wrapper for cancel paths that don't have a cached price */
  private async spawnNextMarket(): Promise<void> {
    return this.spawnNextMarketWithPrice();
  }
}
