import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ScheduleModule } from "@nestjs/schedule";
import { JwtModule } from "@nestjs/jwt";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { User } from "../entities/user.entity";
import { AuthMethod } from "../entities/auth-method.entity";
import { Payment } from "../entities/payment.entity";
import { Transaction } from "../entities/transaction.entity";
import { Position } from "../entities/position.entity";
import { Season } from "../entities/season.entity";
import { UsersController } from "./users.controller";
import { StreakService } from "./streak.service";
import { SeasonService } from "./season.service";
import { OnboardService } from "./onboard.service";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";
import { SmsService } from "../shared/services/sms.service";
import { EmailService } from "../shared/services/email.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([User, AuthMethod, Payment, Transaction, Position, Season]),
    ScheduleModule.forRoot(),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>("JWT_SECRET"),
        signOptions: { expiresIn: "7d" },
      }),
    }),
  ],
  controllers: [UsersController],
  providers: [StreakService, SeasonService, OnboardService, TelegramSimpleService, SmsService, EmailService],
  exports: [StreakService, SeasonService],
})
export class UsersModule {}
