import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { TerPriceService, TerPrice } from "./ter-price.service";
import { RedisService } from "../redis/redis.service";

export const TER_PRICE_CACHE_KEY = "oro:cache:ter:price";
export const TER_PRICE_HISTORY_KEY = "oro:cache:ter:price:history";
export const TER_PRICE_CACHE_TTL = 30; // fallback freshness if sampling stalls

const SAMPLE_MS = 5_000; // must match the frontend chart's assumed point spacing
const HISTORY_MAX_POINTS = 60; // ~5 minutes of points at 5s
const HISTORY_TTL = 1_800; // drop stale history if sampling stops

@Injectable()
export class TerPriceSamplerService {
  private readonly logger = new Logger(TerPriceSamplerService.name);
  private sampling = false;

  constructor(
    private readonly terPriceService: TerPriceService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Keeps the price cache warm and maintains a rolling history in Redis,
   * so the frontend chart can render on first load instead of accumulating
   * points by polling for several seconds.
   */
  @Interval(SAMPLE_MS)
  async sample(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const price = await this.terPriceService.fetchPrice();
      await this.redis.setJsonEx(
        TER_PRICE_CACHE_KEY,
        TER_PRICE_CACHE_TTL,
        price,
      );
      const history =
        (await this.redis.getJson<TerPrice[]>(TER_PRICE_HISTORY_KEY)) ?? [];
      history.push(price);
      await this.redis.setJsonEx(
        TER_PRICE_HISTORY_KEY,
        HISTORY_TTL,
        history.slice(-HISTORY_MAX_POINTS),
      );
    } catch (error) {
      this.logger.warn(`TER price sample failed: ${error.message}`);
    } finally {
      this.sampling = false;
    }
  }

  async getHistory(): Promise<TerPrice[]> {
    return (
      (await this.redis.getJson<TerPrice[]>(TER_PRICE_HISTORY_KEY)) ?? []
    );
  }
}
