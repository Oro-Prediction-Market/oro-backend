import { Injectable, Logger } from "@nestjs/common";

export interface BtcPrice {
  price: number;
  source: "binance" | "coinbase";
  fetchedAt: Date;
}

@Injectable()
export class BtcPriceService {
  private readonly logger = new Logger(BtcPriceService.name);
  private readonly BINANCE_URL =
    "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT";
  private readonly COINBASE_URL =
    "https://api.coinbase.com/v2/prices/BTC-USD/spot";

  async fetchPrice(): Promise<BtcPrice> {
    try {
      return await this.fetchFromCoinbase();
    } catch (error) {
      this.logger.warn(
        `Coinbase fetch failed: ${error.message}. Falling back to Binance.`,
      );
      return await this.fetchFromBinance();
    }
  }

  private async fetchFromBinance(): Promise<BtcPrice> {
    const response = await fetch(this.BINANCE_URL);
    if (!response.ok) {
      throw new Error(`Binance API returned ${response.status}`);
    }
    const data: { symbol: string; price: string } = await response.json();
    return {
      price: parseFloat(data.price),
      source: "binance",
      fetchedAt: new Date(),
    };
  }

  private async fetchFromCoinbase(): Promise<BtcPrice> {
    const response = await fetch(this.COINBASE_URL);
    if (!response.ok) {
      throw new Error(`Coinbase API returned ${response.status}`);
    }
    const data: { data: { amount: string; currency: string } } =
      await response.json();
    return {
      price: parseFloat(data.data.amount),
      source: "coinbase",
      fetchedAt: new Date(),
    };
  }
}
