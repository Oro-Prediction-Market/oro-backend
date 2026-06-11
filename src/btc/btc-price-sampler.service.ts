import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { BtcPriceService, BtcPrice } from "./btc-price.service";
import { RedisService } from "../redis/redis.service";

export const BTC_PRICE_CACHE_KEY = "oro:cache:btc:price";
export const BTC_PRICE_HISTORY_KEY = "oro:cache:btc:price:history";
export const BTC_PRICE_CACHE_TTL = 30; // fallback freshness if sampling stalls

const SAMPLE_MS = 2_000; // must match the frontend chart's assumed point spacing
const HISTORY_MAX_POINTS = 90; // ~3 minutes of points at 2s
const HISTORY_TTL = 900; // drop stale history if sampling stops

@Injectable()
export class BtcPriceSamplerService {
  private readonly logger = new Logger(BtcPriceSamplerService.name);
  private sampling = false;

  constructor(
    private readonly btcPriceService: BtcPriceService,
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
      const price = await this.btcPriceService.fetchPrice();
      await this.redis.setJsonEx(
        BTC_PRICE_CACHE_KEY,
        BTC_PRICE_CACHE_TTL,
        price,
      );
      const history =
        (await this.redis.getJson<BtcPrice[]>(BTC_PRICE_HISTORY_KEY)) ?? [];
      history.push(price);
      await this.redis.setJsonEx(
        BTC_PRICE_HISTORY_KEY,
        HISTORY_TTL,
        history.slice(-HISTORY_MAX_POINTS),
      );
    } catch (error) {
      this.logger.warn(`BTC price sample failed: ${error.message}`);
    } finally {
      this.sampling = false;
    }
  }

  async getHistory(): Promise<BtcPrice[]> {
    return (
      (await this.redis.getJson<BtcPrice[]>(BTC_PRICE_HISTORY_KEY)) ?? []
    );
  }
}
