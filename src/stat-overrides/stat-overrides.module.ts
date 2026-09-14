import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { RedisModule } from "../redis/redis.module";
import { StatBoardOverride } from "../entities/stat-board-override.entity";
import { StatOverridesService } from "./stat-overrides.service";

/**
 * Shared by both leagues' services (which fold the rows into their boards) and
 * by the admin controller (which writes them), so it lives on its own rather
 * than inside either league's module.
 */
@Module({
  imports: [TypeOrmModule.forFeature([StatBoardOverride]), RedisModule],
  providers: [StatOverridesService],
  exports: [StatOverridesService],
})
export class StatOverridesModule {}
