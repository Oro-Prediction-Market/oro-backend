import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Position } from "../entities/position.entity";
import { PositionsController } from "./positions.controller";

@Module({
  imports: [TypeOrmModule.forFeature([Position])],
  controllers: [PositionsController],
})
export class PositionsModule {}
