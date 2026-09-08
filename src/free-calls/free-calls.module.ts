import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { FreeCall } from "../entities/free-call.entity";
import { Market } from "../entities/market.entity";
import { Position } from "../entities/position.entity";
import { User } from "../entities/user.entity";
import { FreeCallsService } from "./free-calls.service";
import { FreeCallsController } from "./free-calls.controller";
import { RedisModule } from "../redis/redis.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([FreeCall, Market, Position, User]),
    RedisModule,
  ],
  controllers: [FreeCallsController],
  providers: [FreeCallsService],
  // The settlement path scores free calls, so the engine needs this service.
  exports: [FreeCallsService],
})
export class FreeCallsModule {}
