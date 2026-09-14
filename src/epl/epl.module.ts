import { Module } from "@nestjs/common";
import { RedisModule } from "../redis/redis.module";
import { StatOverridesModule } from "../stat-overrides/stat-overrides.module";
import { EplController } from "./epl.controller";
import { EplService } from "./epl.service";

@Module({
  imports: [RedisModule, StatOverridesModule],
  controllers: [EplController],
  providers: [EplService],
  exports: [EplService],
})
export class EplModule {}
