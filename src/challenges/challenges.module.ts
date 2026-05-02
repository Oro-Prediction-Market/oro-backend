import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Challenge } from "../entities/challenge.entity";
import { Position } from "../entities/position.entity";
import { Market } from "../entities/market.entity";
import { ChallengesController } from "./challenges.controller";
import { ChallengesService } from "./challenges.service";

@Module({
  imports: [TypeOrmModule.forFeature([Challenge, Position, Market])],
  controllers: [ChallengesController],
  providers: [ChallengesService],
  exports: [ChallengesService],
})
export class ChallengesModule {}
