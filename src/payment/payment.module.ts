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
import { BhutanAppNotificationService } from "../shared/services/bhutanapp-notification.service";
import { AuthMethod } from "../entities/auth-method.entity";
import { SmsService } from "../shared/services/sms.service";
import { TwentyOnePayClient } from "./services/twentyone-pay/twentyone-pay.client";
import { CryptoDepositService } from "./crypto-deposit.service";
import { CryptoWebhookService } from "./crypto-webhook.service";
import { CryptoSettlementService } from "./crypto-settlement.service";
import { CryptoIntentPoller } from "./crypto-intent.poller";
import { DKWithdrawalReconciler } from "./dk-withdrawal.reconciler";
import { CryptoWithdrawalService } from "./crypto-withdrawal.service";
import {
  CryptoWithdrawal,
  CryptoWithdrawalDestination,
} from "../entities/crypto-withdrawal.entity";
import { Pay21WebhookGuard } from "./guards/pay21-webhook.guard";
import { CryptoWebhookEvent } from "../entities/crypto-webhook-event.entity";
import { CryptoPaymentIntent } from "../entities/crypto-payment-intent.entity";

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
      AuthMethod,
      CryptoPaymentIntent,
      CryptoWebhookEvent,
      CryptoWithdrawal,
      CryptoWithdrawalDestination,
    ]),
    TelegramModule,
  ],
  controllers: [PaymentController],
  providers: [
    DKGatewayService,
    DKBankPaymentService,
    BankLinkService,
    BhutanAppNotificationService,
    SmsService,
    TwentyOnePayClient,
    CryptoDepositService,
    CryptoWebhookService,
    CryptoSettlementService,
    CryptoIntentPoller,
    CryptoWithdrawalService,
    DKWithdrawalReconciler,
    Pay21WebhookGuard,
  ],
  exports: [DKGatewayService, BankLinkService, TwentyOnePayClient, CryptoDepositService, CryptoSettlementService],
})
export class PaymentModule {}
