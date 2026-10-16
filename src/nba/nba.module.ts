import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Market } from "../entities/market.entity";
import { MarketsModule } from "../markets/markets.module";
import { RedisModule } from "../redis/redis.module";
import { TelegramModule } from "../telegram/telegram.module";
import { NbaController } from "./nba.controller";
import { NbaJobsService } from "./nba-jobs.service";
import { NbaService } from "./nba.service";

/**
 * MarketsModule is a plain import, as in UnlModule: MarketsModule does not
 * import this one, so there is no cycle. The keeper's pre-payout re-check
 * reads ESPN through espn-nba.util directly for the same reason.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Market]),
    RedisModule,
    TelegramModule,
    MarketsModule,
  ],
  controllers: [NbaController],
  providers: [NbaService, NbaJobsService],
  exports: [NbaService],
})
export class NbaModule {}
