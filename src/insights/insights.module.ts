import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { MarketProbabilitySnapshot } from "../entities/market-probability-snapshot.entity";
import { Market } from "../entities/market.entity";
import { Position } from "../entities/position.entity";
import { FreeCall } from "../entities/free-call.entity";
import { ProbabilityHistoryService } from "./probability-history.service";
import { AnswerService } from "./answer.service";
import { InsightsController } from "./insights.controller";
import { RedisModule } from "../redis/redis.module";

@Module({
  imports: [
    // Position and FreeCall are AnswerService's, not the removed digest's.
    TypeOrmModule.forFeature([
      MarketProbabilitySnapshot,
      Market,
      Position,
      FreeCall,
    ]),
    RedisModule,
  ],
  controllers: [InsightsController],
  providers: [ProbabilityHistoryService, AnswerService],
  exports: [ProbabilityHistoryService, AnswerService],
})
export class InsightsModule {}
