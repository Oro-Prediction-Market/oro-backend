import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export interface TerPrice {
  midPrice: number;
  buyPrice: number;
  sellPrice: number;
  xauUsd: number;
  usdInr: number;
  fetchedAt: Date;
}

interface TerApiResponse {
  prices: Array<{
    product_symbol: string;
    ask_price: number;
    bid_price: number;
    tradeable: boolean;
    spread: number;
    effective_at: string;
  }>;
}

@Injectable()
export class TerPriceService {
  private readonly logger = new Logger(TerPriceService.name);
  private readonly TER_API_URL = "https://api.ter.bt/prices";
  private readonly XAU_API_URL =
    "https://api.exchangerate-api.com/v4/latest/USD";

  constructor(private readonly configService: ConfigService) {}

  /**
   * Fetches the current TER price from api.ter.bt.
   * Falls back to XAU/USD × USD/INR derivation if primary source fails.
   */
  async fetchPrice(): Promise<TerPrice> {
    try {
      return await this.fetchFromTerApi();
    } catch (error) {
      this.logger.warn(
        `Failed to fetch from TER API: ${error.message}. Falling back to XAU derivation.`,
      );
      return await this.fetchFromXauDerivation();
    }
  }

  /**
   * Primary: fetch from api.ter.bt/prices
   */
  private async fetchFromTerApi(): Promise<TerPrice> {
    const response = await fetch(this.TER_API_URL);
    if (!response.ok) {
      throw new Error(`TER API returned ${response.status}`);
    }

    const data: TerApiResponse = await response.json();
    const terBtn = data.prices.find((p) => p.product_symbol === "TERBTN");

    if (!terBtn) {
      throw new Error("TERBTN price not found in API response");
    }

    // Prices are in integer format (multiply by 10000 for Nu X.XXXX)
    const buyPrice = terBtn.ask_price / 10000;
    const sellPrice = terBtn.bid_price / 10000;
    const midPrice = (buyPrice + sellPrice) / 2;

    // For display purposes, we'll set xauUsd and usdInr to 0 when using direct API
    return {
      midPrice,
      buyPrice,
      sellPrice,
      xauUsd: 0,
      usdInr: 0,
      fetchedAt: new Date(),
    };
  }

  /**
   * Fallback: derive from XAU/USD × USD/INR
   */
  private async fetchFromXauDerivation(): Promise<TerPrice> {
    // Fetch XAU/USD (gold price per troy ounce)
    const xauUsd = await this.fetchGoldPrice();

    // Fetch USD/INR exchange rate
    const usdInr = await this.fetchUsdInrRate();

    // 1 TER = 0.01g of .9999 fine gold
    // 1 troy oz = 31.1035 grams
    // midPrice = (XAU_USD / 31.1035) × 0.01 × USD_INR
    const midPrice = (xauUsd / 31.1035) * 0.01 * usdInr;

    // Apply spread: ±1.22%
    const buyPrice = midPrice * 1.0122;
    const sellPrice = midPrice * 0.9878;

    return {
      midPrice,
      buyPrice,
      sellPrice,
      xauUsd,
      usdInr,
      fetchedAt: new Date(),
    };
  }

  /**
   * Fetch current gold price (XAU/USD) from a public API
   */
  private async fetchGoldPrice(): Promise<number> {
    // Using a free gold price API (you may want to use a more reliable source)
    const response = await fetch("https://api.metals.live/v1/spot/gold");
    if (!response.ok) {
      throw new Error(`Gold price API returned ${response.status}`);
    }
    const data = await response.json();
    return data.price; // Price per troy ounce in USD
  }

  /**
   * Fetch USD to INR exchange rate
   */
  private async fetchUsdInrRate(): Promise<number> {
    const response = await fetch(this.XAU_API_URL);
    if (!response.ok) {
      throw new Error(`Exchange rate API returned ${response.status}`);
    }
    const data = await response.json();
    return data.rates.INR;
  }
}
