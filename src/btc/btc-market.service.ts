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
import { BtcPriceService, BtcPrice } from "./btc-price.service";
import { ParimutuelEngine } from "../markets/parimutuel.engine";

@Injectable()
export class BtcMarketService {
  private readonly logger = new Logger(BtcMarketService.name);
  private spawning = false;
  private readonly processingMarkets = new Set<string>();

  constructor(
    @InjectRepository(Market)
    private readonly marketRepo: Repository<Market>,
    @InjectRepository(Outcome)
    private readonly outcomeRepo: Repository<Outcome>,
    private readonly btcPriceService: BtcPriceService,
    private readonly engine: ParimutuelEngine,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * Spawn a new BTC market every 15 minutes.
   * Only spawns if no active BTC market exists.
   */
  @Cron("*/15 * * * *")
  async spawnMarket(): Promise<void> {
    if (this.spawning) return;
    this.spawning = true;
    this.logger.log("Checking if we should spawn a new BTC market...");

    try {
      const existingMarket = await this.marketRepo.findOne({
        where: {
          externalSource: "btc",
          status: MarketStatus.OPEN,
        },
      });

      if (existingMarket) {
        this.logger.log(
          `BTC market ${existingMarket.id} is still open. Skipping spawn.`,
        );
        return;
      }

      this.logger.log("No active BTC market found. Spawning new one...");

      const price = await this.btcPriceService.fetchPrice();

      const now = new Date();
      const closesAt = new Date(now.getTime() + 15 * 60 * 1000);
      const bettingClosesAt = new Date(closesAt.getTime() - 2 * 60 * 1000);

      await this.dataSource.transaction(async (manager) => {
        const market = manager.create(Market, {
          title: "BTC — UP or DOWN in 15 minutes?",
          category: MarketCategory.DAILY,
          status: MarketStatus.OPEN,
          opensAt: now,
          closesAt,
          bettingClosesAt,
          externalSource: "btc",
          externalMarketType: "price-prediction",
          houseEdgePct: 5,
          liquidityParam: 1000,
          metadata: {
            isBtc: true,
            referencePrice: price.price,
            referenceSource: price.source,
            openedAt: now.toISOString(),
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
          `Created BTC market ${savedMarket.id} with reference price $${price.price.toFixed(2)} (${price.source})`,
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

  /**
   * Close and resolve BTC markets that have reached their close time.
   * Runs every 3 seconds.
   */
  @Interval(3_000)
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

  /**
   * Close betting on BTC markets 2 minutes before close.
   * Runs every minute.
   */
  @Cron("* * * * *")
  async closeBetting(): Promise<void> {
    const now = new Date();

    const markets = await this.marketRepo
      .createQueryBuilder("market")
      .where("market.externalSource = :source", { source: "btc" })
      .andWhere("market.status = :status", { status: MarketStatus.OPEN })
      .andWhere("market.bettingClosesAt <= :now", { now })
      .andWhere("market.closesAt > :now", { now })
      .getMany();

    if (markets.length === 0) {
      return;
    }

    for (const market of markets) {
      this.logger.log(
        `Betting closed on BTC market ${market.id} at ${now.toISOString()}`,
      );
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
      this.logger.log(`Closing and resolving BTC market ${market.id}`);

      const settlementPrice = await this.btcPriceService.fetchPrice();
      const referencePrice = market.metadata?.referencePrice;

      if (!referencePrice) {
        this.logger.error(
          `BTC market ${market.id} has no reference price in metadata`,
        );
        await this.engine.cancelMarket(market.id);
        await this.spawnNextMarket();
        return;
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
        await this.spawnNextMarketWithPrice(settlementPrice);
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
        await this.spawnNextMarket();
        return;
      }

      const updatedMetadata = {
        ...(market.metadata || {}),
        settlementPrice: settlementPrice.price,
        settlementSource: settlementPrice.source,
        settledAt: new Date().toISOString(),
      };

      const evidenceNote = `BTC/USD at close: $${settlementPrice.price.toFixed(2)} (${settlementPrice.source}) vs open: $${referencePrice.toFixed(2)}`;

      await this.marketRepo.update(market.id, {
        status: MarketStatus.CLOSED,
        metadata: updatedMetadata as any,
        evidenceNote,
      });

      // Bypass dispute window: backdate disputeDeadlineAt to the past
      await this.marketRepo.update(market.id, {
        status: MarketStatus.RESOLVING,
        proposedOutcomeId: winningOutcome.id,
        windowMinutes: 10,
        disputeDeadlineAt: new Date(Date.now() - 1000),
      });

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

      await this.spawnNextMarketWithPrice(settlementPrice);
    } finally {
      this.processingMarkets.delete(market.id);
    }
  }

  private async spawnNextMarketWithPrice(price?: BtcPrice): Promise<void> {
    if (this.spawning) return;
    this.spawning = true;
    try {
      const existing = await this.marketRepo.findOne({
        where: { externalSource: "btc", status: MarketStatus.OPEN },
      });
      if (existing) {
        this.logger.log("Next BTC market already exists, skipping spawn.");
        return;
      }

      const p = price ?? (await this.btcPriceService.fetchPrice());
      const now = new Date();
      const closesAt = new Date(now.getTime() + 15 * 60 * 1000);
      const bettingClosesAt = new Date(closesAt.getTime() - 2 * 60 * 1000);

      await this.dataSource.transaction(async (manager) => {
        const market = manager.create(Market, {
          title: "BTC — UP or DOWN in 15 minutes?",
          category: MarketCategory.DAILY,
          status: MarketStatus.OPEN,
          opensAt: now,
          closesAt,
          bettingClosesAt,
          externalSource: "btc",
          externalMarketType: "price-prediction",
          houseEdgePct: 5,
          liquidityParam: 1000,
          metadata: {
            isBtc: true,
            referencePrice: p.price,
            referenceSource: p.source,
            openedAt: now.toISOString(),
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
          `[Back-to-back] Spawned next BTC market ${savedMarket.id} with reference price $${p.price.toFixed(2)} (${p.source})`,
        );
      });
    } catch (error) {
      this.logger.error(
        `Failed to spawn next BTC market: ${error.message}`,
        error.stack,
      );
    } finally {
      this.spawning = false;
    }
  }

  private async spawnNextMarket(): Promise<void> {
    return this.spawnNextMarketWithPrice();
  }
}
