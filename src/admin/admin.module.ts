import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Announcement } from "../entities/announcement.entity";
import { NOTIFICATION_QUEUE } from "../jobs/notification.queue";
import { RedisModule } from "../redis/redis.module";
import { UsersModule } from "../users/users.module";
import { AnnouncementsController } from "./announcements.controller";
import { AnnouncementsService } from "./announcements.service";
import { Settlement } from "../entities/settlement.entity";
import { Dispute } from "../entities/dispute.entity";
import { Position } from "../entities/position.entity";
import { User } from "../entities/user.entity";
import { Payment } from "../entities/payment.entity";
import { Transaction } from "../entities/transaction.entity";
import { AuditLog } from "../entities/audit-log.entity";
import { AdminController } from "./admin.controller";
import { MarketsModule } from "../markets/markets.module";
import { FixturesService } from "./fixtures.service";
import { AuditService } from "./audit.service";
import { TelegramModule } from "../telegram/telegram.module";
import { EplModule } from "../epl/epl.module";
import { UclModule } from "../ucl/ucl.module";
import { StatOverridesModule } from "../stat-overrides/stat-overrides.module";
import { SuggestionsModule } from "../suggestions/suggestions.module";
import { ChallengesModule } from "../challenges/challenges.module";
import { InsightsModule } from "../insights/insights.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Settlement,
      Dispute,
      Position,
      User,
      Payment,
      Transaction,
      AuditLog,
      Announcement,
    ]),
    // Announcement DMs ride the same rate-limited queue as settlement DMs, so
    // the two share Telegram's ~30/s budget instead of competing for it.
    BullModule.registerQueue({ name: NOTIFICATION_QUEUE }),
    RedisModule,
    MarketsModule,
    TelegramModule,
    // For UserNotificationService — announcements write the in-app bell rows.
    UsersModule,
    EplModule,
    UclModule,
    StatOverridesModule,
    SuggestionsModule,
    // For voiding stuck duels. The Duels list reads Challenge through the
    // DataSource directly, but refunding needs the service's guarded write path.
    ChallengesModule,
    // The public platform-accuracy service: the admin page reads the same
    // numbers rather than keeping its own copy of the query.
    InsightsModule,
  ],
  controllers: [AdminController, AnnouncementsController],
  providers: [FixturesService, AuditService, AnnouncementsService],
  exports: [AuditService],
})
export class AdminModule {}
