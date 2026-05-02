import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { TypeOrmModule } from "@nestjs/typeorm";
import { BullModule } from "@nestjs/bullmq";
import { AuthModule } from "./auth/auth.module";
import { UsersModule } from "./users/users.module";
import { MarketsModule } from "./markets/markets.module";
import { PositionsModule } from "./positions/positions.module";
import { AdminModule } from "./admin/admin.module";
import { TelegramModule } from "./telegram/telegram.module";
import { PaymentModule } from "./payment/payment.module";
import { RedisModule } from "./redis/redis.module";
import { JobsModule } from "./jobs/jobs.module";
import { User } from "./entities/user.entity";
import { AuthMethod } from "./entities/auth-method.entity";
import { Market } from "./entities/market.entity";
import { Outcome } from "./entities/outcome.entity";
import { Position } from "./entities/position.entity";
import { Payment } from "./entities/payment.entity";
import { Transaction } from "./entities/transaction.entity";
import { Settlement } from "./entities/settlement.entity";
import { Dispute } from "./entities/dispute.entity";
import { DKGatewayAuthToken } from "./entities/dk-gateway-auth-token.entity";
import { PaymentOtp } from "./entities/payment-otp.entity";
import { AuditLog } from "./entities/audit-log.entity";
import { Challenge } from "./entities/challenge.entity";
import { Season } from "./entities/season.entity";
import { TelegramGroup } from "./entities/telegram-group.entity";
import { GroupMembership } from "./entities/group-membership.entity";
import { ChallengesModule } from "./challenges/challenges.module";
import { LeaguesModule } from "./leagues/leagues.module";
import { ReportingModule } from "./reporting/reporting.module";
import { ReconciliationModule } from "./reconciliation/reconciliation.module";
import { Reconciliation } from "./entities/reconciliation.entity";
import { EventsModule } from "./events/events.module";
import { UserEvent } from "./entities/user-event.entity";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]), // 120 req/min global default
    ScheduleModule.forRoot(),
    RedisModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>("REDIS_URL", "redis://localhost:6379");
        // Parse host/port from URL for BullMQ connection config
        const parsed = new URL(url);
        return {
          connection: {
            host: parsed.hostname || "localhost",
            port: parseInt(parsed.port || "6379", 10),
            password: parsed.password || undefined,
          },
          defaultJobOptions: {
            attempts: 3,
            backoff: {
              type: "exponential",
              delay: 5000, // 5s → 10s → 20s
            },
            removeOnComplete: 100, // keep last 100 completed jobs
            removeOnFail: 200, // keep last 200 failed jobs for inspection
          },
        };
      },
    }),
    JobsModule,
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: "postgres",
        host: config.get("DB_HOST", "localhost"),
        port: config.get<number>("DB_PORT", 5432),
        username: config.get("DB_USERNAME", "postgres"),
        password: config.get("DB_PASSWORD", "postgres"),
        database: config.get("DB_NAME", "oro_db"),
        entities: [
          User,
          AuthMethod,
          Market,
          Outcome,
          Position,
          Payment,
          Transaction,
          Settlement,
          Dispute,
          DKGatewayAuthToken,
          PaymentOtp,
          AuditLog,
          Challenge,
          Season,
          TelegramGroup,
          GroupMembership,
          Reconciliation,
          UserEvent,
        ],
        synchronize: false,
        logging: false,
        extra: {
          max: 20,
          min: 2,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
        },
      }),
    }),
    AuthModule,
    UsersModule,
    MarketsModule,
    PositionsModule,
    AdminModule,
    TelegramModule,
    PaymentModule,
    ChallengesModule,
    LeaguesModule,
    ReportingModule,
    ReconciliationModule,
    EventsModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
