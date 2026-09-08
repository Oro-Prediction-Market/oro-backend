import { Module, forwardRef } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { TypeOrmModule } from "@nestjs/typeorm";
import { NOTIFICATION_QUEUE } from "./notification.queue";
import { NotificationProcessor } from "./notification.processor";
import { AutoResolveMarketsJob } from "./auto-resolve-markets.job";
import { EngagementJob } from "./engagement.job";
import { WeeklyReportJob } from "./weekly-report.job";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";
import { BhutanAppNotificationService } from "../shared/services/bhutanapp-notification.service";
import { User } from "../entities/user.entity";
import { Market } from "../entities/market.entity";
import { Dispute } from "../entities/dispute.entity";
import { AuditLog } from "../entities/audit-log.entity";
import { Transaction } from "../entities/transaction.entity";
import { Challenge } from "../entities/challenge.entity";
import { Settlement } from "../entities/settlement.entity";
import { Position } from "../entities/position.entity";
import { AuthMethod } from "../entities/auth-method.entity";
import { MarketsModule } from "../markets/markets.module";
import { RedisModule } from "../redis/redis.module";
import { UsersModule } from "../users/users.module";

@Module({
  imports: [
    BullModule.registerQueue({ name: NOTIFICATION_QUEUE }),
    TypeOrmModule.forFeature([
      User,
      Market,
      Dispute,
      AuditLog,
      Transaction,
      Challenge,
      Settlement,
      Position,
      AuthMethod,
    ]),
    forwardRef(() => MarketsModule),
    RedisModule,
    // For UserNotificationService — the in-app bell channel, which is the only
    // one that reaches a PWA user with no Telegram chat and no BhutanApp link.
    UsersModule,
  ],
  providers: [
    NotificationProcessor,
    TelegramSimpleService,
    BhutanAppNotificationService,
    AutoResolveMarketsJob,
    EngagementJob,
    WeeklyReportJob,
  ],
  exports: [BullModule],
})
export class JobsModule {}
