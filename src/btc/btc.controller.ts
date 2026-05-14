import { Controller, Get, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { BtcPriceService, BtcPrice } from "./btc-price.service";
import { BtcMarketService } from "./btc-market.service";
import { RedisService } from "../redis/redis.service";
import { Public, JwtAuthGuard, AdminGuard } from "../auth/guards";

@ApiTags("btc")
@Controller("btc")
export class BtcController {
  private readonly CACHE_KEY = "oro:cache:btc:price";
  private readonly CACHE_TTL = 30; // 30 seconds

  constructor(
    private readonly btcPriceService: BtcPriceService,
    private readonly btcMarketService: BtcMarketService,
    private readonly redis: RedisService,
  ) {}

  @Get("price")
  @Public()
  @ApiOperation({
    summary: "Get current BTC/USD price (cached 30s)",
    description:
      "Returns the current BTC/USD spot price. " +
      "Primary source is Binance; falls back to Coinbase. " +
      "Cached for 30 seconds in Redis.",
  })
  async getPrice(): Promise<BtcPrice> {
    const cached = await this.redis.getJson<BtcPrice>(this.CACHE_KEY);
    if (cached) {
      return cached;
    }

    const price = await this.btcPriceService.fetchPrice();
    await this.redis.setJsonEx(this.CACHE_KEY, this.CACHE_TTL, price);

    return price;
  }

  @Post("spawn")
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiOperation({
    summary: "Manually spawn a BTC market (admin only)",
    description:
      "Manually triggers the creation of a new BTC UP/DOWN market. " +
      "Useful for testing without waiting for the cron schedule.",
  })
  async spawnMarket(): Promise<{ message: string }> {
    await this.btcMarketService.spawnMarket();
    return { message: "BTC market spawn triggered" };
  }
}
