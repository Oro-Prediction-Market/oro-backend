import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { PaymentController } from "./payment.controller";
import { Payment } from "../entities/payment.entity";
import { Transaction } from "../entities/transaction.entity";
import { User } from "../entities/user.entity";
import { DKGatewayAuthToken } from "../entities/dk-gateway-auth-token.entity";
import { PaymentOtp } from "../entities/payment-otp.entity";
import { DKGatewayService } from "./services/dk-gateway/dk-gateway.service";
import { DKBankPaymentService } from "./dkbank-payment.service";
import { TelegramModule } from "../telegram/telegram.module";

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      Payment,
      Transaction,
      User,
      DKGatewayAuthToken,
      PaymentOtp,
    ]),
    TelegramModule,
  ],
  controllers: [PaymentController],
  providers: [DKGatewayService, DKBankPaymentService],
  exports: [DKGatewayService],
})
export class PaymentModule {}
