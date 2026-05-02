import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { JwtStrategy } from "./jwt.strategy";
import { User } from "../entities/user.entity";
import { AuthMethod } from "../entities/auth-method.entity";
import { Payment } from "../entities/payment.entity";
import { Transaction } from "../entities/transaction.entity";
import { DKGatewayAuthToken } from "../entities/dk-gateway-auth-token.entity";
import { AuditLog } from "../entities/audit-log.entity";
import { Market } from "../entities/market.entity";
import { Position } from "../entities/position.entity";
import { DKGatewayService } from "../payment/services/dk-gateway/dk-gateway.service";
import { TelegramModule } from "../telegram/telegram.module";
import { AuditService } from "../admin/audit.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      AuthMethod,
      Payment,
      Transaction,
      DKGatewayAuthToken,
      AuditLog,
      Market,
      Position,
    ]),
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>("JWT_SECRET");
        if (!secret) {
          throw new Error("JWT_SECRET environment variable must be set");
        }
        return {
          secret,
          signOptions: { expiresIn: config.get("JWT_EXPIRES_IN", "7d") },
        };
      },
    }),
    TelegramModule,
  ],
  providers: [AuthService, JwtStrategy, DKGatewayService, AuditService], // Add AuditService
  controllers: [AuthController],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
