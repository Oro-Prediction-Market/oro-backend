import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { StatOverridesModule } from "../stat-overrides/stat-overrides.module";
import { UnlTeam } from "../entities/unl-team.entity";
import { UnlFixture } from "../entities/unl-fixture.entity";
import { UnlController } from "./unl.controller";
import { UnlService } from "./unl.service";

/**
 * No RedisModule, unlike the EPL and UCL modules: this service reads our own
 * database and caches nothing. See UnlService for why.
 */
@Module({
  imports: [TypeOrmModule.forFeature([UnlTeam, UnlFixture]), StatOverridesModule],
  controllers: [UnlController],
  providers: [UnlService],
  exports: [UnlService],
})
export class UnlModule {}
