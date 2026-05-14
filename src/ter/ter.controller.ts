import { Controller, Get, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { TerPriceService, TerPrice } from "./ter-price.service";
import { TerMarketService } from "./ter-market.service";
import { RedisService } from "../redis/redis.service";
import { Public, JwtAuthGuard, AdminGuard } from "../auth/guards";

@ApiTags("ter")
@Controller("ter")
export class TerController {
  private readonly CACHE_KEY = "oro:cache:ter:price";
  private readonly CACHE_TTL = 30; // 30 seconds

  constructor(
    private readonly terPriceService: TerPriceService,
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

    // Fetch fresh price
    const price = await this.terPriceService.fetchPrice();

    // Cache it
    await this.redis.setJsonEx(this.CACHE_KEY, this.CACHE_TTL, price);

    return price;
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
