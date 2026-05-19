import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { PaymentController } from "./payment.controller";
import { Payment } from "../entities/payment.entity";
import { Transaction } from "../entities/transaction.entity";
import { User } from "../entities/user.entity";
import { DKGatewayAuthToken } from "../entities/dk-gateway-auth-token.entity";
import { PaymentOtp } from "../entities/payment-otp.entity";
import { LinkedBankAccount } from "../entities/linked-bank-account.entity";
import { DKGatewayService } from "./services/dk-gateway/dk-gateway.service";
import { DKBankPaymentService } from "./dkbank-payment.service";
import { BankLinkService } from "./bank-link.service";
import { TelegramModule } from "../telegram/telegram.module";
import { SmsService } from "../shared/services/sms.service";

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      Payment,
      Transaction,
      User,
      DKGatewayAuthToken,
      PaymentOtp,
      LinkedBankAccount,
    ]),
    TelegramModule,
  ],
  controllers: [PaymentController],
  providers: [DKGatewayService, DKBankPaymentService, BankLinkService, SmsService],
  exports: [DKGatewayService, BankLinkService],
})
export class PaymentModule {}
