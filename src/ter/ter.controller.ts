import {
  Controller,
  Get,
  Post,
  UseGuards,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { TerPriceService, TerPrice } from "./ter-price.service";
import { TerPriceSamplerService } from "./ter-price-sampler.service";
import { TerMarketService } from "./ter-market.service";
import { RedisService } from "../redis/redis.service";
import { Public, JwtAuthGuard, AdminGuard } from "../auth/guards";

@ApiTags("ter")
@Controller("ter")
export class TerController {
  private readonly logger = new Logger(TerController.name);
  private readonly CACHE_KEY = "oro:cache:ter:price";
  private readonly CACHE_TTL = 30; // 30 seconds
  // Last price we successfully fetched, kept far longer than the hot cache so we
  // can keep serving a (stale) price when every upstream source is down instead
  // of 500-ing. Only a fresh success overwrites it.
  private readonly LAST_GOOD_KEY = "oro:cache:ter:price:last-good";
  private readonly LAST_GOOD_TTL = 24 * 60 * 60; // 24 hours

  constructor(
    private readonly terPriceService: TerPriceService,
    private readonly terPriceSampler: TerPriceSamplerService,
    private readonly terMarketService: TerMarketService,
    private readonly redis: RedisService,
  ) {}

  @Get("price")
  @Public()
  @ApiOperation({
    summary: "Get current TER price (cached 30s)",
    description:
      "Returns the current TER/BTN price with buy, sell, and mid prices. " +
      "Cached for 30 seconds in Redis to reduce API calls.",
  })
  async getPrice(): Promise<TerPrice> {
    // Try to get from cache first
    const cached = await this.redis.getJson<TerPrice>(this.CACHE_KEY);
    if (cached) {
      return cached;
    }

    try {
      // Fetch fresh price
      const price = await this.terPriceService.fetchPrice();
      // Cache it (hot cache) and remember it as the last known-good price.
      await this.redis.setJsonEx(this.CACHE_KEY, this.CACHE_TTL, price);
      await this.redis.setJsonEx(this.LAST_GOOD_KEY, this.LAST_GOOD_TTL, price);
      return price;
    } catch (err: any) {
      // Every upstream source failed. Rather than 500 on a 5-second client poll
      // — which floods the browser console AND our own logs — serve the last
      // price we did fetch, if we have one. We also stamp it into the hot cache
      // so we retry upstream at most once per CACHE_TTL instead of on every
      // request while the outage lasts.
      const lastGood = await this.redis.getJson<TerPrice>(this.LAST_GOOD_KEY);
      if (lastGood) {
        await this.redis.setJsonEx(this.CACHE_KEY, this.CACHE_TTL, lastGood);
        this.logger.warn(
          `TER price upstream failed (${err?.message ?? "unknown"}); serving last known-good price.`,
        );
        return lastGood;
      }
      // No price has ever been fetched — nothing to serve. 503 (not 500) tells
      // the client this is a transient upstream problem, not a bug.
      this.logger.error(
        `TER price unavailable and no last known-good price cached: ${err?.message ?? "unknown"}`,
      );
      throw new ServiceUnavailableException(
        "TER price is temporarily unavailable. Please try again shortly.",
      );
    }
  }

  @Get("price/history")
  @Public()
  @ApiOperation({
    summary: "Get recent TER price history",
    description:
      "Returns the rolling history of recent TER prices sampled every 5 seconds " +
      "(up to ~5 minutes). Used to seed the live chart on first page load.",
  })
  async getPriceHistory(): Promise<TerPrice[]> {
    const history = await this.terPriceSampler.getHistory();
    if (history.length > 0) {
      return history;
    }
    // Sampler hasn't produced points yet — return at least the current price
    return [await this.getPrice()];
  }

  @Post("spawn")
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiOperation({
    summary: "Manually spawn a TER market (admin only)",
    description:
      "Manually triggers the creation of a new TER market. " +
      "Useful for testing without waiting for the cron schedule.",
  })
  async spawnMarket(): Promise<{ message: string }> {
    await this.terMarketService.spawnMarket();
    return { message: "TER market spawn triggered" };
  }
}
