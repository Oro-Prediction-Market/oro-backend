import { Module, forwardRef } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { BullModule } from "@nestjs/bullmq";
import { Market } from "../entities/market.entity";
import { Outcome } from "../entities/outcome.entity";
import { Position } from "../entities/position.entity";
import { Payment } from "../entities/payment.entity";
import { Settlement } from "../entities/settlement.entity";
import { User } from "../entities/user.entity";
import { Transaction } from "../entities/transaction.entity";
import { Dispute } from "../entities/dispute.entity";
import { MarketsService } from "./markets.service";
import { MarketsController } from "./markets.controller";
import { SitemapController } from "./sitemap.controller";
import { ParimutuelEngine } from "./parimutuel.engine";
import { LMSRService } from "./lmsr.service";
import { KeeperService } from "./keeper.service";
import { ReputationService } from "./reputation.service";
import { RevenueDistributionModule } from "./revenue-distribution.module";
import { MarketsGateway } from "./markets.gateway";
import { TelegramModule } from "../telegram/telegram.module";
import { PaymentModule } from "../payment/payment.module";
import { UsersModule } from "../users/users.module";
import { ChallengesModule } from "../challenges/challenges.module";
import { RedisModule } from "../redis/redis.module";
import { NOTIFICATION_QUEUE } from "../jobs/notification.queue";
import { EplModule } from "../epl/epl.module";

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      Market,
      Outcome,
      Position,
      Payment,
      Settlement,
      User,
      Transaction,
      Dispute,
    ]),
    RevenueDistributionModule,
    BullModule.registerQueue({ name: NOTIFICATION_QUEUE }),
    TelegramModule,
    PaymentModule,
    UsersModule,
    RedisModule,
    EplModule,
    forwardRef(() => ChallengesModule),
  ],
  providers: [
    MarketsService,
    ParimutuelEngine,
    LMSRService,
    KeeperService,
    ReputationService,
    MarketsGateway,
  ],
  controllers: [MarketsController, SitemapController],
  exports: [
    MarketsService,
    ParimutuelEngine,
    KeeperService,
    MarketsGateway,
    RevenueDistributionModule,
  ],
})
export class MarketsModule {}
