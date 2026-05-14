import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ConfigModule } from "@nestjs/config";
import { Market } from "../entities/market.entity";
import { Outcome } from "../entities/outcome.entity";
import { BtcController } from "./btc.controller";
import { BtcPriceService } from "./btc-price.service";
import { BtcMarketService } from "./btc-market.service";
import { MarketsModule } from "../markets/markets.module";
import { RedisModule } from "../redis/redis.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([Market, Outcome]),
    ConfigModule,
    MarketsModule,
    RedisModule,
  ],
  controllers: [BtcController],
  providers: [BtcPriceService, BtcMarketService],
  exports: [BtcPriceService],
})
export class BtcModule {}
