import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { JwtModule } from "@nestjs/jwt";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { User } from "../entities/user.entity";
import { AuthMethod } from "../entities/auth-method.entity";
import { Payment } from "../entities/payment.entity";
import { Transaction } from "../entities/transaction.entity";
import { Position } from "../entities/position.entity";
import { CryptoWithdrawal } from "../entities/crypto-withdrawal.entity";
import { Season } from "../entities/season.entity";
import { UserNotification } from "../entities/user-notification.entity";
import { UsersController } from "./users.controller";
import { StreakService } from "./streak.service";
import { SeasonService } from "./season.service";
import { OnboardService } from "./onboard.service";
import { UserNotificationService } from "./user-notification.service";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";
import { SmsService } from "../shared/services/sms.service";
import { EmailService } from "../shared/services/email.service";
import { BhutanAppNotificationService } from "../shared/services/bhutanapp-notification.service";
import { DKGatewayService } from "../payment/services/dk-gateway/dk-gateway.service";
import { DKGatewayAuthToken } from "../entities/dk-gateway-auth-token.entity";
import { TelegramModule } from "../telegram/telegram.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      AuthMethod,
      Payment,
      Transaction,
      Position,
      CryptoWithdrawal,
      Season,
      UserNotification,
      DKGatewayAuthToken,
    ]),
    TelegramModule,
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
  providers: [
    StreakService,
    SeasonService,
    OnboardService,
    UserNotificationService,
    TelegramSimpleService,
    SmsService,
    EmailService,
    BhutanAppNotificationService,
    DKGatewayService,
  ],
  exports: [StreakService, SeasonService, UserNotificationService],
})
export class UsersModule {}
