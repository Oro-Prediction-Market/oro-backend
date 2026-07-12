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

  // 7.5 min betting + 7.5 min measuring = 15-minute round total; phases must
  // be equal so back-to-back rounds chain with no gap and no double-betting.
  private static readonly PHASE_MS = 7.5 * 60 * 1000;

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
   *   1. lock reference prices on rounds whose betting phase just ended
   *   2. settle rounds whose measuring phase just ended
   */
  @Interval(3_000)
  async tick(): Promise<void> {
    await this.lockReferencePrices();
    await this.closeAndResolveMarkets();
  }

  /**
   * Find OPEN markets past bettingClosesAt that have no reference price yet,
   * lock the current price as their reference, then open the next round.
   */
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

    // Betting just closed on a round — open the next one immediately
    await this.ensureBettableMarket();
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

      const settlementPrice = await this.btcPriceService.fetchPrice();

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

      // Safety net — the lock step normally spawned the next round already
      await this.ensureBettableMarket();
    } finally {
      this.processingMarkets.delete(market.id);
    }
  }

  /**
   * Spawn a new round unless one is still accepting bets.
   * No price fetch happens here — the reference is locked at betting close.
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

      const bettingClosesAt = new Date(
        now.getTime() + BtcMarketService.PHASE_MS,
      );
      const closesAt = new Date(
        bettingClosesAt.getTime() + BtcMarketService.PHASE_MS,
      );

      await this.dataSource.transaction(async (manager) => {
        const market = manager.create(Market, {
          title: "BTC — UP or DOWN?",
          category: MarketCategory.ECONOMY,
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
            openedAt: now.toISOString(),
            // referencePrice is intentionally absent: it is locked when
            // betting closes, so bettors can't watch the answer form.
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
