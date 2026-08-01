import { Module } from "@nestjs/common";
import { RedisModule } from "../redis/redis.module";
import { UclController } from "./ucl.controller";
import { UclService } from "./ucl.service";

@Module({
  imports: [RedisModule],
  controllers: [UclController],
  providers: [UclService],
  exports: [UclService],
})
export class UclModule {}
