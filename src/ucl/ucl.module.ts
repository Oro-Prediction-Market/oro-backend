import { Module } from "@nestjs/common";
import { RedisModule } from "../redis/redis.module";
import { StatOverridesModule } from "../stat-overrides/stat-overrides.module";
import { UclController } from "./ucl.controller";
import { UclService } from "./ucl.service";

@Module({
  imports: [RedisModule, StatOverridesModule],
  controllers: [UclController],
  providers: [UclService],
  exports: [UclService],
})
export class UclModule {}
