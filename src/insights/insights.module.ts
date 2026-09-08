import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { MarketProbabilitySnapshot } from "../entities/market-probability-snapshot.entity";
import { Market } from "../entities/market.entity";
import { Position } from "../entities/position.entity";
import { FreeCall } from "../entities/free-call.entity";
import { ProbabilityHistoryService } from "./probability-history.service";
import { AnswerService } from "./answer.service";
import { InsightsController } from "./insights.controller";
import { MovementDigestJob } from "./movement-digest.job";
import { RedisModule } from "../redis/redis.module";
import { UsersModule } from "../users/users.module";
import { ConfigModule } from "@nestjs/config";
import { TelegramModule } from "../telegram/telegram.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MarketProbabilitySnapshot,
      Market,
      Position,
      FreeCall,
    ]),
    RedisModule,
    // UserNotificationService for the bell half of the digest.
    UsersModule,
    // TelegramSimpleService for the channel post.
    TelegramModule,
    ConfigModule,
  ],
  controllers: [InsightsController],
  providers: [ProbabilityHistoryService, AnswerService, MovementDigestJob],
  exports: [ProbabilityHistoryService, AnswerService],
})
export class InsightsModule {}
