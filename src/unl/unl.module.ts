import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { StatOverridesModule } from "../stat-overrides/stat-overrides.module";
import { MarketsModule } from "../markets/markets.module";
import { UnlTeam } from "../entities/unl-team.entity";
import { UnlFixture } from "../entities/unl-fixture.entity";
import { Market } from "../entities/market.entity";
import { AuditLog } from "../entities/audit-log.entity";
import { UnlController } from "./unl.controller";
import { UnlAdminController } from "./unl-admin.controller";
import { UnlService } from "./unl.service";

/**
 * No RedisModule, unlike the EPL and UCL modules: this service reads our own
 * database and caches nothing. See UnlService for why.
 *
 * MarketsModule is a plain import rather than a forwardRef — MarketsModule
 * imports EplModule and UclModule but not this one, so there is no cycle. That
 * direction is deliberate: the keeper knows nothing about the Nations League,
 * because nothing about this competition is on a schedule.
 */
@Module({
  imports: [
    // AuditLog is here because UnlAdminController writes its audit rows
    // directly, rather than pulling in AdminModule (which imports most of the
    // app) just to log a team rename.
    TypeOrmModule.forFeature([UnlTeam, UnlFixture, Market, AuditLog]),
    StatOverridesModule,
    MarketsModule,
  ],
  controllers: [UnlController, UnlAdminController],
  providers: [UnlService],
  exports: [UnlService],
})
export class UnlModule {}
