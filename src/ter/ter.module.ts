import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ConfigModule } from "@nestjs/config";
import { Market } from "../entities/market.entity";
import { Outcome } from "../entities/outcome.entity";
import { TerController } from "./ter.controller";
import { TerPriceService } from "./ter-price.service";
import { TerMarketService } from "./ter-market.service";
import { MarketsModule } from "../markets/markets.module";
import { RedisModule } from "../redis/redis.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([Market, Outcome]),
    ConfigModule,
    MarketsModule,
    RedisModule,
  ],
  controllers: [TerController],
  providers: [TerPriceService, TerMarketService],
  exports: [TerPriceService],
})
export class TerModule {}
