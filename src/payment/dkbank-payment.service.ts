import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { DataSource, Repository } from "typeorm";

import { User } from "../entities/user.entity";
import { LinkedBankAccount } from "../entities/linked-bank-account.entity";
import {
  Payment,
  PaymentMethod,
  PaymentStatus,
  PaymentType,
} from "../entities/payment.entity";
import { Transaction, TransactionType } from "../entities/transaction.entity";
import { PaymentOtp, OtpStatus } from "../entities/payment-otp.entity";
import { DKGatewayService } from "./services/dk-gateway/dk-gateway.service";
import { RedisService } from "../redis/redis.service";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";
import { SseService } from "../sse/sse.service";
import { BhutanAppNotificationService } from "../shared/services/bhutanapp-notification.service";
import { AuthMethod, AuthProvider } from "../entities/auth-method.entity";

import { classifyDkStatus } from "./dk-status.util";
import {
  WITHDRAWAL_CONFIRMED,
  WITHDRAWAL_REFUNDED,
  WITHDRAWAL_RESERVED,
} from "./dk-ledger-notes";
import { ledgerBalance } from "../shared/utils/ledger.util";
import { BTN_CURRENCY } from "../entities/transaction.entity";

/** DK Bank OTP window: 10 minutes. */
const OTP_TTL_MS = 10 * 60 * 1000;

export interface DKBankPaymentRequest {
  amount: number;
  cid: string; // 11-digit Bhutanese CID — used to look up the DK Bank account
  customerName?: string;
  description: string;
  merchantTxnId?: string;
  /** Optional: links this payment's OTP session to a market (e.g. top-up before betting). */
  marketId?: string;
  /** Optional: links this payment's OTP session to a dispute bond. */
  disputeId?: string;
}

export interface PaymentInitiateResponse {
  success: boolean;
  paymentId: string;
  status: "pending" | "processing" | "success" | "failed";
  amount: number;
  currency: string;
  method: "dkbank";
  message: string;
  timestamp: string;
  /** True when the payment is waiting for the customer's OTP before executing. */
  otpRequired?: boolean;
  /** Channel used to deliver the OTP: telegram or sms */
  otpChannel?: "telegram" | "sms";
  paymentUrl?: string;
  qrCode?: string;
}

export interface PaymentStatusResponse {
  paymentId: string;
  status: "pending" | "otp_required" | "success" | "failed" | "cancelled";
  amount: number;
  currency: string;
  method: string;
  confirmedAt?: string;
  failureReason?: string;
}

@Injectable()
export class DKBankPaymentService {
  private readonly logger = new Logger(DKBankPaymentService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly dkGateway: DKGatewayService,
    private readonly configService: ConfigService,
    private readonly redis: RedisService,
    private readonly telegramService: TelegramSimpleService,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(LinkedBankAccount)
    private readonly lbaRepo: Repository<LinkedBankAccount>,
    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,
    @InjectRepository(PaymentOtp)
    private readonly otpRepo: Repository<PaymentOtp>,
    private readonly sse: SseService,
    private readonly bhutanAppNotification: BhutanAppNotificationService,
    @InjectRepository(AuthMethod)
    private readonly authMethodRepo: Repository<AuthMethod>,
  ) {}

  /**
   * Step 1: Look up customer account by CID and call DK account_auth.
   * DK sends an OTP to the customer's registered phone.
   * Returns paymentId + otpRequired: true.
   */
  async initiatePayment(
    userId: string,
    dto: DKBankPaymentRequest,
  ): Promise<PaymentInitiateResponse> {
    const amount = Number(dto.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException("Amount must be a positive number");
    }
    if (amount > 15000) {
      throw new BadRequestException(
        "Deposit amount cannot exceed Nu 15,000 per transaction",
      );
    }

    // ── Daily deposit limit check ─────────────────────────────────────────────
    // Sum all confirmed (COMPLETED) deposits for this user today (Asia/Thimphu).
    const DAILY_DEPOSIT_LIMIT = 15000;
    const todayBhutan = new Date(
      new Date().toLocaleString("en-US", { timeZone: "Asia/Thimphu" }),
    );
    todayBhutan.setHours(0, 0, 0, 0);
    const tomorrowBhutan = new Date(todayBhutan.getTime() + 86_400_000);

    const { todayTotal } = await this.paymentRepo
      .createQueryBuilder("p")
      .select("COALESCE(SUM(p.amount), 0)", "todayTotal")
      .where("p.userId = :userId", { userId })
      .andWhere("p.type = :type", { type: PaymentType.DEPOSIT })
      .andWhere("p.status = :status", { status: PaymentStatus.SUCCESS })
      .andWhere("p.createdAt >= :from", { from: todayBhutan })
      .andWhere("p.createdAt < :to", { to: tomorrowBhutan })
      .getRawOne();

    const depositedToday = Number(todayTotal ?? 0);
    if (depositedToday + amount > DAILY_DEPOSIT_LIMIT) {
      const remaining = Math.max(0, DAILY_DEPOSIT_LIMIT - depositedToday);
      throw new BadRequestException(
        remaining <= 0
          ? `You have reached your daily deposit limit of Nu ${DAILY_DEPOSIT_LIMIT.toLocaleString()}. Limit resets at midnight (Bhutan time).`
          : `This deposit would exceed your daily limit of Nu ${DAILY_DEPOSIT_LIMIT.toLocaleString()}. You can deposit up to Nu ${remaining.toLocaleString()} more today.`,
      );
    }

    const cid =
      typeof dto.cid === "string"
        ? dto.cid.trim().replace(/\s+/g, "").replace(/[^\d]/g, "")
        : "";
    if (!cid) throw new BadRequestException("cid is required");
    if (!dto.description || typeof dto.description !== "string") {
      throw new BadRequestException("description is required");
    }

    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");

    // ── Linked account check ─────────────────────────────────────────────────
    // Require a verified linked account whose CID matches the submitted CID.
    // Ownership was already proven via OTP during bank linking — no phone-hash
    // comparison needed.
    let linkedAccount = await this.lbaRepo.findOne({
      where: { userId, isVerified: true, isDefault: true },
    });

    if (!linkedAccount) {
      linkedAccount = await this.lbaRepo.findOne({
        where: { userId, cid: cid, isVerified: true },
      });
    }
    if (!linkedAccount && user.dkCid === cid) {
      // User linked during onboarding but record may not exist — allow based on user.dkCid
    } else if (!linkedAccount) {
      throw new BadRequestException(
        "You have not linked a DK Bank account yet. " +
          "Please go to Wallet → Link DK Bank Account first.",
      );
    } else if (linkedAccount.cid !== cid) {
      this.logger.warn(
        `[Payment] CID mismatch for user ${userId}: submitted=${cid} linked=${linkedAccount.cid}`,
      );
      throw new BadRequestException(
        "The CID you entered does not match your linked DK Bank account. " +
          "Please use your own CID.",
      );
    }

    const payment = this.paymentRepo.create({
      type: PaymentType.DEPOSIT,
      status: PaymentStatus.PENDING,
      method: PaymentMethod.DK_BANK,
      amount,
      currency: "BTN",
      description: dto.description,
      referenceId: dto.merchantTxnId || null,
      userId: user.id,
      metadata: {
        cid,
        customerName: dto.customerName ?? null,
        initiatedAt: new Date().toISOString(),
        merchantTxnId: dto.merchantTxnId || null,
      },
    });
    await this.paymentRepo.save(payment);

    // ── Step 1: Look up DK Bank account by CID ───────────────────────────────
    let customerAccountNumber: string | null = null;
    let customerAccountName: string | null = null;

    try {
      const account = await this.dkGateway.lookupAccountByCID(cid);
      customerAccountNumber = account.accountNumber;
      customerAccountName = account.accountName;
      payment.customerPhone = account.phoneNumber || null;

      payment.metadata = {
        ...(payment.metadata || {}),
        customerAccountNumber,
        customerAccountName,
      };
      await this.paymentRepo.save(payment);
    } catch (e: any) {
      payment.status = PaymentStatus.FAILED;
      payment.failureReason = e?.message || "Failed to look up DK Bank account";
      payment.metadata = {
        ...(payment.metadata || {}),
        dkInitiateError: { message: payment.failureReason },
      };
      await this.paymentRepo.save(payment);
      throw e;
    }

    // ── Step 2: Call account_auth — DK Bank sends OTP to user's registered phone
    const stanNumber = this.dkGateway.generateStanNumber();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + OTP_TTL_MS);

    let bfsTxnId: string;
    let txDatetime: string;

    try {
      const authResult = await this.dkGateway.authorizeTransaction({
        customerAccountNumber,
        customerAccountName,
        customerPhone: payment.customerPhone ?? "",
        amount,
        description: dto.description,
        stanNumber,
      });
      bfsTxnId = authResult.bfsTxnId;
      txDatetime = authResult.txDatetime;

      payment.dkInquiryId = bfsTxnId;
      payment.metadata = {
        ...(payment.metadata || {}),
        bfsTxnId,
        stanNumber,
        txDatetime,
        otpExpiresAt: expiresAt.toISOString(),
      };
      await this.paymentRepo.save(payment);
    } catch (e: any) {
      payment.status = PaymentStatus.FAILED;
      payment.failureReason = e?.message || "DK account authorization failed";
      await this.paymentRepo.save(payment);
      throw new BadRequestException(payment.failureReason);
    }

    // ── Step 3: Record OTP session and notify user via Telegram ──────────────
    await this.otpRepo.save(
      this.otpRepo.create({
        paymentId: payment.id,
        userId,
        marketId: dto.marketId || null,
        disputeId: dto.disputeId || null,
        status: OtpStatus.PENDING,
        expiresAt,
        lastRequestedAt: now,
        verifiedAt: null,
        requestCount: 1,
        failedAttempts: 0,
        bfsTxnId,
      }),
    );

    const firstName = user.firstName?.trim() || "there";
    const expiresAtStr = expiresAt.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Thimphu",
      hour12: true,
    });

    await this.telegramService
      .sendMessage(
        Number(user.telegramId),
        `🔐 <b>Oro Deposit Confirmation</b>\n\nHi ${firstName}, DK Bank has sent an OTP to your registered phone number.\n\nEnter it in the app to confirm your <b>Nu ${amount.toLocaleString()}</b> deposit.\n\n⏳ Expires at ${expiresAtStr} (10 min)\n\n⚠️ Do not share your OTP with anyone.`,
      )
      .catch((err) =>
        this.logger.warn(
          `Failed to send deposit prompt via Telegram: ${err.message}`,
        ),
      );

    return {
      success: true,
      paymentId: payment.id,
      status: "pending",
      amount,
      currency: "BTN",
      method: "dkbank",
      message:
        "DK Bank has sent an OTP to your registered phone. Enter it to complete the deposit.",
      timestamp: now.toISOString(),
      otpRequired: true,
    };
  }

  /**
   * Step 2: Submit the DK Bank OTP to complete the deposit.
   * Passes the OTP directly to DK's debit_request (the bfsTxnId was obtained
   * during initiatePayment when account_auth was called).
   */
  async confirmPayment(
    userId: string,
    paymentId: string,
    otp: string,
  ): Promise<PaymentInitiateResponse> {
    const payment = await this.paymentRepo.findOne({
      where: { id: paymentId, userId },
    });
    if (!payment) throw new NotFoundException("Payment not found");
    if (payment.status !== PaymentStatus.PENDING) {
      throw new BadRequestException(`Payment is already ${payment.status}`);
    }

    const MAX_OTP_ATTEMPTS = 5;

    const otpRecord = await this.otpRepo.findOne({
      where: { paymentId, userId },
      order: { createdAt: "DESC" },
    });

    if (otpRecord && otpRecord.failedAttempts >= MAX_OTP_ATTEMPTS) {
      throw new BadRequestException(
        "Too many incorrect OTP attempts. Please initiate a new payment.",
      );
    }

    // Check OTP session expiry
    const meta = payment.metadata || {};
    if (meta.otpExpiresAt && new Date(meta.otpExpiresAt) < new Date()) {
      throw new BadRequestException(
        "OTP has expired. Please initiate a new payment.",
      );
    }

    const { bfsTxnId, stanNumber, txDatetime } = meta;
    if (!bfsTxnId || !stanNumber || !txDatetime) {
      throw new BadRequestException(
        "Payment session is invalid. Please initiate a new payment.",
      );
    }

    // ── Atomically mark as PROCESSING to prevent double-submit race condition ─
    const updateResult = await this.paymentRepo.update(
      { id: paymentId, userId, status: PaymentStatus.PENDING },
      { status: PaymentStatus.PROCESSING },
    );
    if (updateResult.affected === 0) {
      throw new BadRequestException(
        "Payment is already being processed. Please wait.",
      );
    }
    payment.status = PaymentStatus.PROCESSING;

    // ── Call DK Bank debit_request with the OTP from the user ────────────────
    const isStagingDepositBypass =
      this.configService.get<string>("DK_STAGING_DEPOSIT_BYPASS") === "true";

    if (isStagingDepositBypass) {
      this.logger.warn(
        `[STAGING] Skipping real DK debit_request for payment ${payment.id} — DK_STAGING_DEPOSIT_BYPASS active`,
      );
      payment.dkTxnStatusId = `STAGING-${Date.now()}`;
      await this.paymentRepo.save(payment);
    } else {
      try {
        const execResult = await this.dkGateway.executeTransactionWithOtp({
          bfsTxnId,
          otp,
          stanNumber,
          txDatetime,
          sourceAccountNumber: meta.customerAccountNumber,
          sourceAccountName: meta.customerAccountName,
          amount: Number(payment.amount),
          description: payment.description ?? "DK Bank deposit",
        });
        payment.dkTxnStatusId = execResult.txnStatusId;
        await this.paymentRepo.save(payment);
      } catch (e: any) {
        // A rejected OTP (or a failed debit request) must NOT kill the payment
        // outright — the user is allowed up to MAX_OTP_ATTEMPTS tries. Count the
        // failure and, unless the cap is now reached, revert the payment to
        // PENDING so a fresh OTP can be submitted against the same payment.
        // Only on the final permitted attempt (or when we cannot track attempts)
        // is the payment marked terminally FAILED.
        let attempts = MAX_OTP_ATTEMPTS; // no otpRecord ⇒ cannot retry safely
        if (otpRecord) {
          otpRecord.failedAttempts += 1;
          attempts = otpRecord.failedAttempts;
          await this.otpRepo.save(otpRecord);
        }
        const exhausted = attempts >= MAX_OTP_ATTEMPTS;
        payment.status = exhausted
          ? PaymentStatus.FAILED
          : PaymentStatus.PENDING;
        payment.failureReason = e?.message || "DK debit request failed";
        await this.paymentRepo.save(payment);
        throw new BadRequestException(
          exhausted
            ? "Too many incorrect OTP attempts. Please initiate a new payment."
            : e?.message ||
              "Invalid OTP or transaction failed. Please try again.",
        );
      }
    }

    this.logger.log(`[Payment] DK debit accepted for payment ${payment.id}`);

    // ── Credit Oro balance immediately ───────────────────────────────────────
    // The executeTransactionWithOtp call succeeded (DK returned "0000") and
    // money has been confirmed to reach the merchant account via the real-time
    // /v1/initiate/transaction endpoint. Safe to credit the wallet now.
    await this.applyDKStatusUpdate({
      userId,
      paymentId: payment.id,
      dkRaw: { source: "dk_otp", txnStatusId: payment.dkTxnStatusId },
      dkStatus: "SUCCESS",
      dkStatusDesc: "DK debit confirmed — balance credited",
      isFromWebhook: false,
    });

    if (otpRecord) {
      otpRecord.status = OtpStatus.VERIFIED;
      otpRecord.verifiedAt = new Date();
      await this.otpRepo.save(otpRecord);
    }
    await this.redis.del(`oro:cache:balance:${userId}`);
    this.sse.emit(userId, "balance:updated", { paymentId: payment.id });

    // ── Telegram success notification ─────────────────────────────────────────
    const depositedAmount = Number(payment.amount);
    try {
      const user = await this.userRepo.findOne({
        where: { id: userId },
        select: ["telegramId", "firstName"],
      });
      if (user?.telegramId) {
        const firstName = user.firstName?.trim() || "there";
        const ts = new Date().toLocaleString("en-US", {
          timeZone: "Asia/Thimphu",
          day: "2-digit",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        });
        await this.telegramService
          .sendMessage(
            Number(user.telegramId),
            `✅ <b>Top Up Successful</b>\n\n` +
              `<b>Nu ${depositedAmount.toLocaleString()}</b> has been credited to your Oro wallet.\n\n` +
              `🕐 ${ts}\n` +
              `🔖 Ref: <code>${payment.id.slice(0, 8).toUpperCase()}</code>\n\n` +
              `Thank you, ${firstName}! Open Oro to start predicting. 🎯`,
          )
          .catch((err) =>
            this.logger.warn(
              `Failed to send deposit success message: ${err.message}`,
            ),
          );
      }
    } catch (err: any) {
      this.logger.warn(`Deposit success notification failed: ${err.message}`);
    }

    return {
      success: true,
      paymentId: payment.id,
      status: "success" as any,
      amount: depositedAmount,
      currency: payment.currency,
      method: "dkbank",
      message: "Payment confirmed. Balance credited.",
      timestamp: new Date().toISOString(),
    };
  }

  async getPaymentStatus(
    userId: string,
    paymentId: string,
  ): Promise<PaymentStatusResponse> {
    const payment = await this.paymentRepo.findOne({
      where: { id: paymentId, userId },
    });
    if (!payment) throw new NotFoundException("Payment not found");

    if (payment.status === PaymentStatus.SUCCESS)
      return this.mapPayment(payment);
    if (payment.status === PaymentStatus.FAILED)
      return this.mapPayment(payment);

    // Polling below drives the DEPOSIT status machine. Withdrawals now carry a
    // dkTxnStatusId too, so without this they would fall through and fire a DK
    // call whose result applyDKStatusUpdate discards — and race the
    // reconciler, which is what actually finalises them.
    if (payment.type !== PaymentType.DEPOSIT) return this.mapPayment(payment);

    // If the payment hasn't been confirmed with OTP yet (no txnStatusId)
    if (!payment.dkTxnStatusId && !payment.externalPaymentId) {
      return {
        paymentId: payment.id,
        status: payment.metadata?.bfsTxnId ? "otp_required" : "pending",
        amount: Number(payment.amount),
        currency: payment.currency,
        method: payment.method,
      };
    }

    const txnStatusId =
      payment.dkTxnStatusId || payment.externalPaymentId || "";
    let dkResult: Awaited<
      ReturnType<DKGatewayService["checkTransactionStatus"]>
    > | null = null;
    try {
      dkResult = await this.dkGateway.checkTransactionStatus(txnStatusId);
    } catch (e: any) {
      payment.metadata = {
        ...(payment.metadata || {}),
        dkStatusError: { message: e?.message || "DK status error" },
        dkStatusAttemptedAt: new Date().toISOString(),
      };
      await this.paymentRepo.save(payment);
      return this.mapPayment(payment);
    }

    if (!dkResult) return this.mapPayment(payment);

    await this.applyDKStatusUpdate({
      userId,
      paymentId: payment.id,
      dkRaw: dkResult.raw,
      dkStatus: dkResult.status,
      dkStatusDesc: dkResult.statusDesc,
      isFromWebhook: false,
    });

    const updated = await this.paymentRepo.findOne({
      where: { id: payment.id, userId },
    });
    if (!updated) throw new NotFoundException("Payment not found after update");
    return this.mapPayment(updated);
  }

  async handleWebhook(payload: any, signatureHeader?: string) {
    const sigOk = this.dkGateway.verifyWebhookSignature(
      payload,
      signatureHeader,
    );
    if (!sigOk) throw new BadRequestException("Invalid DK webhook signature");

    const inquiryId = payload?.inquiry_id || payload?.bfs_txn_id;
    if (!inquiryId || typeof inquiryId !== "string") {
      throw new BadRequestException(
        "Missing inquiry_id/bfs_txn_id in DK webhook payload",
      );
    }

    const payment = await this.paymentRepo.findOne({
      where: { dkInquiryId: inquiryId },
      relations: ["user"],
    });
    if (!payment) return { received: true, ignored: true };

    const txnStatusId = payment.dkTxnStatusId || payment.externalPaymentId;
    if (!txnStatusId) {
      payment.metadata = {
        ...(payment.metadata || {}),
        dkWebhookPayload: payload,
      };
      await this.paymentRepo.save(payment);
      return { received: true, ignored: true };
    }

    try {
      const dkResult = await this.dkGateway.checkTransactionStatus(txnStatusId);
      await this.applyDKStatusUpdate({
        userId: payment.userId,
        paymentId: payment.id,
        dkRaw: dkResult.raw,
        dkStatus: dkResult.status,
        dkStatusDesc: dkResult.statusDesc,
        isFromWebhook: true,
        dkWebhookPayload: payload,
      });
    } catch (e: any) {
      payment.metadata = {
        ...(payment.metadata || {}),
        dkWebhookStatusError: {
          message: e?.message || "DK webhook status error",
        },
        dkWebhookReceivedAt: new Date().toISOString(),
        dkWebhookPayload: payload,
      };
      await this.paymentRepo.save(payment);
      return { received: true, ignored: true };
    }

    return { received: true, ignored: false };
  }

  private mapPayment(payment: Payment): PaymentStatusResponse {
    const status =
      payment.status === PaymentStatus.SUCCESS
        ? "success"
        : payment.status === PaymentStatus.FAILED
          ? "failed"
          : payment.metadata?.bfsTxnId && !payment.dkTxnStatusId
            ? "otp_required"
            : "pending";
    return {
      paymentId: payment.id,
      status,
      amount: Number(payment.amount),
      currency: payment.currency,
      method: payment.method,
      confirmedAt: payment.confirmedAt
        ? payment.confirmedAt.toISOString()
        : undefined,
      failureReason: payment.failureReason || undefined,
    };
  }

  private async applyDKStatusUpdate(params: {
    userId: string;
    paymentId: string;
    dkRaw: any;
    dkStatus: string;
    dkStatusDesc?: string;
    isFromWebhook: boolean;
    dkWebhookPayload?: any;
  }) {
    // Failure is tested before success — see classifyDkStatus. This path
    // CREDITS on success, so reading "UNSUCCESSFUL" as a success would hand a
    // user real balance for a deposit that never landed.
    const verdict = classifyDkStatus(params.dkStatus);
    const mapped =
      verdict === "success"
        ? PaymentStatus.SUCCESS
        : verdict === "failed"
          ? PaymentStatus.FAILED
          : PaymentStatus.PENDING;

    await this.dataSource.transaction(async (em) => {
      const payment = await em
        .getRepository(Payment)
        .createQueryBuilder("p")
        .setLock("pessimistic_write")
        .where("p.id = :id", { id: params.paymentId })
        .andWhere("p.userId = :userId", { userId: params.userId })
        .getOne();
      if (!payment) throw new NotFoundException("Payment not found");
      if (
        payment.status !== PaymentStatus.PENDING &&
        payment.status !== PaymentStatus.PROCESSING
      )
        return;

      // Deposits only. This path CREDITS the user on success, so letting a
      // withdrawal through would hand back the withdrawn amount as balance
      // while the payout itself is still in flight. Withdrawals are finalised
      // exclusively by confirmWithdrawal / the reconciler.
      if (payment.type !== PaymentType.DEPOSIT) {
        this.logger.warn(
          `[DK] Ignoring status update for non-deposit payment ${payment.id} ` +
            `(type=${payment.type}) — deposit crediting must not touch it`,
        );
        payment.metadata = {
          ...(payment.metadata || {}),
          dkIgnoredStatusUpdate: {
            status: params.dkStatus,
            statusDesc: params.dkStatusDesc,
            at: new Date().toISOString(),
          },
        };
        await em.save(payment);
        return;
      }

      payment.metadata = {
        ...(payment.metadata || {}),
        dkStatus: { status: params.dkStatus, statusDesc: params.dkStatusDesc },
        dkRaw: params.dkRaw,
        dkStatusSource: params.isFromWebhook ? "webhook" : "poll",
      };
      if (params.dkWebhookPayload)
        payment.metadata.dkWebhookPayload = params.dkWebhookPayload;

      if (mapped === PaymentStatus.SUCCESS) {
        payment.status = PaymentStatus.SUCCESS;
        payment.confirmedAt = new Date();
        payment.failureReason = null;

        // Snapshot balance before crediting
        const balanceBefore = await ledgerBalance(
          em,
          params.userId,
          BTN_CURRENCY,
        );

        this.logger.log(
          `[CREDITS] Crediting ${payment.amount} to user ${params.userId} from DK payment ${payment.id}`,
        );

        const depositAmount = Number(payment.amount);

        await em.save(
          Transaction,
          em.create(Transaction, {
            type: TransactionType.DEPOSIT,
            amount: depositAmount,
            balanceBefore,
            balanceAfter: balanceBefore + depositAmount,
            paymentId: payment.id,
            userId: params.userId,
            note: `DK Bank deposit confirmed`,
          }),
        );

        // Invalidate cached balance so the next /users/me returns the updated value
        await this.redis.del(`oro:cache:balance:${params.userId}`);
      } else if (mapped === PaymentStatus.FAILED) {
        payment.status = PaymentStatus.FAILED;
        payment.failureReason = params.dkStatusDesc || "Payment failed";
        payment.confirmedAt = new Date();
      }

      await em.save(payment);
    });
  }

  // ── Withdrawal: merchant vault → user DK Bank account ─────────────────────

  /**
   * Step 1 — Withdrawal initiation.
   * Validates that the user has a linked DK account and sufficient in-app
   * credit balance, then creates a PENDING withdrawal payment record and
   * sends a Telegram OTP as the confirmation gate.
   *
   * No funds leave the merchant vault until confirmWithdrawal succeeds.
   */
  async initiateWithdrawal(
    userId: string,
    dto: { amount: number },
  ): Promise<PaymentInitiateResponse> {
    const amount = Number(dto.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException(
        "Withdrawal amount must be a positive number",
      );
    }

    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");

    let linkedAccount = await this.lbaRepo.findOne({
      where: { userId, isVerified: true, isDefault: true },
    });
    // Fallback: find any linked account for this user (may not be verified yet)
    if (!linkedAccount) {
      linkedAccount = await this.lbaRepo.findOne({
        where: { userId },
        order: { createdAt: "DESC" },
      });
    }
    // PWA users who linked via CID may only have user.dkAccountNumber (no LinkedBankAccount record)
    const withdrawAccountNumber =
      linkedAccount?.accountNumber || user.dkAccountNumber;
    const withdrawAccountName =
      linkedAccount?.accountName || user.dkAccountName || null;

    if (!withdrawAccountNumber) {
      throw new BadRequestException(
        "You have not linked a DK Bank account yet. " +
          "Please link your account in the Wallet page first.",
      );
    }

    // ── Check in-app credit balance ───────────────────────────────────────────
    // Must happen outside a write-lock — this is a pre-flight read.
    // The authoritative balance check is repeated inside confirmWithdrawal
    // under pessimistic_write lock to prevent TOCTOU races.
    let balance = 0;
    await this.dataSource.transaction(async (em) => {
      balance = await ledgerBalance(em, userId, BTN_CURRENCY);
    });

    if (balance < amount) {
      throw new BadRequestException(
        `Insufficient balance. You have Nu ${balance.toFixed(2)} but requested Nu ${amount.toFixed(2)}.`,
      );
    }

    // ── Create PENDING withdrawal payment record ───────────────────────────
    const payment = this.paymentRepo.create({
      type: PaymentType.WITHDRAWAL,
      status: PaymentStatus.PENDING,
      method: PaymentMethod.DK_BANK,
      amount,
      currency: "BTN",
      description: "Withdrawal to DK Bank account",
      userId: user.id,
      metadata: {
        dkAccountNumber: withdrawAccountNumber,
        dkAccountName: withdrawAccountName,
        linkedBankAccountId: linkedAccount?.id ?? null,
        initiatedAt: new Date().toISOString(),
      },
    });
    await this.paymentRepo.save(payment);

    // ── Generate and send Telegram OTP ────────────────────────────────────
    const { randomBytes } = await import("crypto");
    const generatedOtp = String(
      100000 + (randomBytes(3).readUIntBE(0, 3) % 900000),
    );
    const now = new Date();

    await this.redis.setJsonEx<{ otp: string; userId: string }>(
      `oro:tg-otp:${payment.id}`,
      300,
      { otp: generatedOtp, userId },
    );

    await this.otpRepo.save(
      this.otpRepo.create({
        paymentId: payment.id,
        userId,
        status: OtpStatus.PENDING,
        expiresAt: new Date(now.getTime() + OTP_TTL_MS),
        lastRequestedAt: now,
        verifiedAt: null,
        requestCount: 1,
        failedAttempts: 0,
        bfsTxnId: null,
      }),
    );

    const firstName = user.firstName?.trim() || "there";

    // ── Route OTP delivery based on user's linked channels ────────────────
    // Priority: BhutanApp push (PWA) → Telegram (TMA). We must confirm delivery
    // actually succeeded before telling the frontend to prompt for the OTP —
    // otherwise a failed push strands the user on an OTP screen with no code.
    let otpChannel: "telegram" | "sms" = "telegram";
    let otpDelivered = false;

    const bhutanAppAuth = await this.authMethodRepo.findOne({
      where: { user: { id: userId }, provider: AuthProvider.BHUTANAPP },
    });
    const bhutanAppUserId = (bhutanAppAuth?.metadata as any)?.externalUserId;

    if (bhutanAppAuth && bhutanAppUserId) {
      // PWA/BhutanApp user — try BhutanApp push first. sendNotification never
      // throws; it returns false on any failure (401, validation, network).
      const sent = await this.bhutanAppNotification.sendNotification(
        bhutanAppUserId,
        "Oro Withdrawal OTP",
        `Your one-time code to withdraw Nu ${amount.toLocaleString()}: ${generatedOtp}. Expires in 5 minutes. Never share this code.`,
      );
      if (sent) {
        otpChannel = "sms"; // frontend treats as "sms" (non-telegram)
        otpDelivered = true;
      } else {
        this.logger.warn(
          `BhutanApp OTP delivery failed for user ${userId}; attempting fallback`,
        );
      }
    }

    // Fall back to Telegram if BhutanApp didn't deliver, or for TMA users.
    if (!otpDelivered && user.telegramId) {
      try {
        await this.telegramService.sendMessage(
          Number(user.telegramId),
          `🏦 <b>Oro Withdrawal OTP</b>\n\nHi ${firstName}, your one-time code to withdraw <b>Nu ${amount.toLocaleString()}</b> to your DK Bank account:\n\n<code>${generatedOtp}</code>\n\n⏳ Expires in 5 minutes\n\n⚠️ <b>Oro will never ask for this code.</b> Do not share it with anyone.`,
        );
        otpChannel = "telegram";
        otpDelivered = true;
      } catch (err: any) {
        this.logger.warn(
          `Failed to send withdrawal OTP via Telegram: ${err.message}`,
        );
      }
    }

    if (!otpDelivered) {
      // No channel succeeded — fail loudly instead of returning a fake success
      // that leaves the user waiting for an OTP that never arrives.
      await this.paymentRepo.update(payment.id, {
        status: PaymentStatus.FAILED,
      });
      throw new BadRequestException(
        "Could not deliver your withdrawal OTP. Please try again or contact support.",
      );
    }

    return {
      success: true,
      paymentId: payment.id,
      status: "pending",
      amount,
      currency: "BTN",
      method: "dkbank",
      message:
        otpChannel === "telegram"
          ? "OTP sent to your Telegram. Please enter it to confirm the withdrawal."
          : "OTP sent to your My Bhutan App. Please enter it to confirm the withdrawal.",
      timestamp: now.toISOString(),
      otpRequired: true,
      otpChannel,
    };
  }

  async confirmWithdrawal(
    userId: string,
    paymentId: string,
    otp: string,
  ): Promise<PaymentInitiateResponse> {
    const payment = await this.paymentRepo.findOne({
      where: { id: paymentId, userId },
    });
    if (!payment) throw new NotFoundException("Payment not found");
    if (payment.status !== PaymentStatus.PENDING) {
      throw new BadRequestException(`Withdrawal is already ${payment.status}`);
    }

    const MAX_OTP_ATTEMPTS = 5;

    // ── OTP lockout check ────────────────────────────────────────────────────
    const otpRecord = await this.otpRepo.findOne({
      where: { paymentId, userId },
      order: { createdAt: "DESC" },
    });
    if (otpRecord && otpRecord.failedAttempts >= MAX_OTP_ATTEMPTS) {
      throw new BadRequestException(
        "Too many incorrect OTP attempts. Please initiate a new withdrawal.",
      );
    }

    // ── Telegram OTP validation ──────────────────────────────────────────────
    const tgOtpSession = await this.redis.getJson<{
      otp: string;
      userId: string;
    }>(`oro:tg-otp:${paymentId}`);
    if (!tgOtpSession) {
      throw new BadRequestException(
        "OTP has expired. Please initiate a new withdrawal.",
      );
    }
    if (tgOtpSession.userId !== userId) {
      throw new BadRequestException("Payment not found.");
    }

    const { timingSafeEqual } = await import("crypto");
    const otpValid =
      tgOtpSession.otp.length === otp.length &&
      timingSafeEqual(Buffer.from(tgOtpSession.otp), Buffer.from(otp));

    if (!otpValid) {
      if (otpRecord) {
        otpRecord.failedAttempts += 1;
        await this.otpRepo.save(otpRecord);
      }
      throw new BadRequestException("Invalid OTP. Please check and try again.");
    }

    // OTP is valid — delete it immediately to prevent replay
    await this.redis.del(`oro:tg-otp:${paymentId}`);

    // ── Pre-debit guard: don't reserve while DK is offline ────────────────────
    // Reserving debits the user's balance BEFORE the DK call. If DK is in
    // maintenance / unreachable, that call would throw and strand the debit in
    // PROCESSING ("reserved") with the money gone and nothing sent — exactly the
    // incident we hit. A quick read-only liveness probe up front lets us reject
    // cleanly with the balance untouched, so the user just retries later.
    // Skipped under the staging bypass, where there is no real DK to probe.
    const stagingBypass =
      this.configService.get<string>("DK_STAGING_WITHDRAWAL_BYPASS") === "true";
    if (!stagingBypass && !(await this.dkGateway.isReachable())) {
      throw new ServiceUnavailableException(
        "Withdrawals are temporarily unavailable while the bank is offline. " +
          "Your balance is unchanged — please try again shortly.",
      );
    }

    // ── Reserve-then-call ─────────────────────────────────────────────────────
    // The debit is written and COMMITTED before the DK network call, so we can
    // never pay the bank without a matching Oro ledger debit. Three phases:
    //   Phase 1 — short txn: lock, re-check balance, write debit, → PROCESSING.
    //   Phase 2 — no lock/txn: call DK (can take ~60s).
    //   Phase 3 — short txn: finalise SUCCESS, or reverse the debit on a
    //             definitive failure. On an AMBIGUOUS outcome (the call threw —
    //             timeout/network) we neither refund nor confirm: the debit
    //             stays and the payment is left PROCESSING for reconciliation.
    const withdrawalAmount = Number(payment.amount);

    const result: {
      status: "success" | "failed" | "processing";
      failureReason?: string;
    } = { status: "success" };

    // ── Phase 1: reserve funds (no external calls while holding the lock) ─────
    await this.dataSource.transaction(async (em) => {
      // Lock the USER row first so every balance-affecting operation for this
      // user serializes. Locking only the payment row is NOT enough: two
      // *different* pending withdrawals are two different payment rows, so their
      // locks never collide — both could read the same balance and both pay out.
      // The user-row lock forces the second confirm to wait, then re-read the
      // now-debited balance and correctly fail.
      const lockedUser = await em
        .getRepository(User)
        .createQueryBuilder("u")
        .setLock("pessimistic_write")
        .where("u.id = :id", { id: userId })
        .getOne();
      if (!lockedUser) throw new NotFoundException("User not found");

      const lockedPayment = await em
        .getRepository(Payment)
        .createQueryBuilder("p")
        .setLock("pessimistic_write")
        .where("p.id = :id", { id: paymentId })
        .andWhere("p.userId = :userId", { userId })
        .getOne();
      if (!lockedPayment) throw new NotFoundException("Payment not found");
      if (lockedPayment.status !== PaymentStatus.PENDING) {
        throw new BadRequestException(
          `Withdrawal is already ${lockedPayment.status}`,
        );
      }

      // Re-check balance under lock (authoritative TOCTOU guard)
      const balanceBefore = await ledgerBalance(em, userId, BTN_CURRENCY);

      if (balanceBefore < withdrawalAmount) {
        throw new BadRequestException(
          `Insufficient balance. Available: Nu ${balanceBefore.toFixed(2)}.`,
        );
      }

      // Bonus credits are play money — they cannot be sent to DK Bank directly.
      // Only the real (non-bonus) portion of the balance is withdrawable.
      const bonusBalance = Number(lockedUser.bonusBalance ?? 0);
      const realWithdrawable = balanceBefore - bonusBalance;

      if (realWithdrawable < withdrawalAmount) {
        throw new BadRequestException(
          `Insufficient withdrawable balance. ` +
            `Nu ${bonusBalance.toFixed(2)} of your balance is bonus credit and cannot be withdrawn. ` +
            `Withdrawable: Nu ${Math.max(0, realWithdrawable).toFixed(2)}.`,
        );
      }

      // Write the debit NOW — before any bank call. This is the invariant that
      // makes the flow safe: the ledger is reduced first, so a later DK success
      // can never leave the bank paid without a matching Oro debit.
      await em.save(
        Transaction,
        em.create(Transaction, {
          type: TransactionType.WITHDRAWAL,
          amount: -withdrawalAmount, // negative = debit from in-app balance
          balanceBefore,
          balanceAfter: balanceBefore - withdrawalAmount,
          paymentId: lockedPayment.id,
          userId,
          note: WITHDRAWAL_RESERVED,
        }),
      );

      lockedPayment.status = PaymentStatus.PROCESSING;
      await em.save(lockedPayment);
    });

    // Funds are reserved — reflect the hold in the UI immediately.
    await this.redis.del(`oro:cache:balance:${userId}`);
    this.sse.emit(userId, "balance:updated", { paymentId });

    // ── Phase 2: call DK OUTSIDE any transaction or lock (may take ~60s) ───────
    const isStagingWithdrawalBypass =
      this.configService.get<string>("DK_STAGING_WITHDRAWAL_BYPASS") === "true";

    let transferResult: {
      txnId: string | null;
      txnStatusId?: string | null;
      inquiryId?: string | null;
      status: string;
      statusDesc: string;
      raw?: unknown;
    } | null = null;
    let transferThrew = false;
    let transferError = "";
    if (isStagingWithdrawalBypass) {
      this.logger.warn(
        `[STAGING] Skipping real DK transfer for payment ${paymentId} — DK_STAGING_WITHDRAWAL_BYPASS active`,
      );
      transferResult = {
        txnId: `STAGING-${Date.now()}`,
        status: "SUCCESS",
        statusDesc: "Staging bypass — no real transfer",
      };
    } else {
      try {
        transferResult = await this.dkGateway.transferToAccount({
          accountNumber: payment.metadata?.dkAccountNumber,
          accountName: payment.metadata?.dkAccountName ?? undefined,
          amount: withdrawalAmount,
          currency: "BTN",
          reference: payment.id,
          description: `oro withdrawal for user ${userId}`,
        });
      } catch (e: any) {
        // AMBIGUOUS: we don't know whether DK moved the money. Do NOT refund
        // (DK may have paid) and do NOT confirm. Handled in phase 3 below.
        transferThrew = true;
        transferError = e?.message || "DK Bank transfer error";
      }
    }

    const transferStatus = (transferResult?.status ?? "").toUpperCase();
    const transferSucceeded =
      !transferThrew && transferStatus.includes("SUCCESS");
    // DK replied, but with an indeterminate code (timeout / no-response /
    // internal error): treat it exactly like a thrown call — money state
    // unknown, so keep the debit and leave PROCESSING, never refund.
    const transferAmbiguous =
      !transferThrew && transferStatus === "AMBIGUOUS";

    // ── Phase 3: finalise (short txn) ─────────────────────────────────────────
    await this.dataSource.transaction(async (em) => {
      const lockedPayment = await em
        .getRepository(Payment)
        .createQueryBuilder("p")
        .setLock("pessimistic_write")
        .where("p.id = :id", { id: paymentId })
        .andWhere("p.userId = :userId", { userId })
        .getOne();
      if (!lockedPayment) throw new NotFoundException("Payment not found");
      // Idempotency: only a PROCESSING withdrawal can be finalised here.
      if (lockedPayment.status !== PaymentStatus.PROCESSING) {
        result.status =
          lockedPayment.status === PaymentStatus.SUCCESS ? "success" : "failed";
        return;
      }

      // Keep DK's own words on the row, whatever the outcome. Without this the
      // only record of what the bank actually said is a debug log line, which
      // is off in production — so a misclassified payout is undiagnosable
      // after the fact.
      lockedPayment.metadata = {
        ...(lockedPayment.metadata || {}),
        dkTransfer: {
          status: transferThrew ? "THREW" : (transferResult?.status ?? null),
          statusDesc: transferThrew
            ? transferError
            : (transferResult?.statusDesc ?? null),
          txnId: transferResult?.txnId ?? null,
          txnStatusId: transferResult?.txnStatusId ?? null,
          inquiryId: transferResult?.inquiryId ?? null,
          raw: transferResult?.raw ?? null,
          at: new Date().toISOString(),
        },
      };

      if (transferThrew || transferAmbiguous) {
        // Ambiguous — either the call threw (no reply at all) or DK replied with
        // an indeterminate code (timeout / no-response / internal error). Either
        // way we do NOT know whether the money moved, so keep the debit and
        // leave PROCESSING for reconciliation. Never auto-refund: refunding a
        // transfer that actually settled would double-pay the user.
        const reason = transferThrew
          ? transferError
          : (transferResult?.statusDesc ??
            "DK Bank returned an indeterminate status");
        result.status = "processing";
        result.failureReason = reason;
        // Persist whatever handle DK gave us — the reconciler needs an id to
        // ask "did this settle?" later.
        lockedPayment.dkTxnStatusId =
          transferResult?.txnStatusId ?? lockedPayment.dkTxnStatusId;
        lockedPayment.dkInquiryId =
          transferResult?.inquiryId ?? lockedPayment.dkInquiryId;
        lockedPayment.failureReason = reason;
        await em.save(lockedPayment);
        this.logger.warn(
          `[Withdrawal] DK transfer ambiguous for payment ${paymentId} — left ` +
            `PROCESSING with debit intact for reconciliation: ${reason}`,
        );
        return;
      }

      if (!transferSucceeded) {
        // Definitive DK failure — reverse the reserved debit and fail cleanly.
        const balNow = await ledgerBalance(em, userId, BTN_CURRENCY);
        await em.save(
          Transaction,
          em.create(Transaction, {
            type: TransactionType.REFUND,
            amount: withdrawalAmount, // positive = return the reserved funds
            balanceBefore: balNow,
            balanceAfter: balNow + withdrawalAmount,
            paymentId: lockedPayment.id,
            userId,
            note: WITHDRAWAL_REFUNDED,
          }),
        );
        lockedPayment.status = PaymentStatus.FAILED;
        lockedPayment.failureReason =
          transferResult?.statusDesc || "DK Bank transfer failed";
        lockedPayment.confirmedAt = new Date();
        await em.save(lockedPayment);
        result.status = "failed";
        result.failureReason = lockedPayment.failureReason ?? undefined;
        return;
      }

      // Definitive success — the debit already exists; restamp it so the user's
      // history reads "confirmed" rather than "reserved", then finalise.
      await em.update(
        Transaction,
        { paymentId: lockedPayment.id, type: TransactionType.WITHDRAWAL },
        { note: WITHDRAWAL_CONFIRMED },
      );

      lockedPayment.status = PaymentStatus.SUCCESS;
      lockedPayment.confirmedAt = new Date();
      lockedPayment.externalPaymentId = transferResult?.txnId ?? null;
      lockedPayment.dkTxnStatusId =
        transferResult?.txnStatusId ?? lockedPayment.dkTxnStatusId;
      lockedPayment.dkInquiryId =
        transferResult?.inquiryId ?? lockedPayment.dkInquiryId;
      lockedPayment.failureReason = null;
      await em.save(lockedPayment);
      result.status = "success";
    });

    // ── Cleanup ──────────────────────────────────────────────────────────────
    if (otpRecord) {
      otpRecord.status = OtpStatus.VERIFIED;
      otpRecord.verifiedAt = new Date();
      await this.otpRepo.save(otpRecord);
    }
    await this.redis.del(`oro:otp:${paymentId}`);
    await this.redis.del(`oro:cache:balance:${userId}`);
    this.sse.emit(userId, "balance:updated", { paymentId });

    if (result.status === "failed") {
      return {
        success: false,
        paymentId: payment.id,
        status: "failed",
        amount: withdrawalAmount,
        currency: payment.currency,
        method: "dkbank",
        message: result.failureReason ?? "Withdrawal failed",
        timestamp: new Date().toISOString(),
      };
    }

    if (result.status === "processing") {
      return {
        success: true,
        paymentId: payment.id,
        status: "processing",
        amount: withdrawalAmount,
        currency: payment.currency,
        method: "dkbank",
        message:
          "Your withdrawal is being processed. We'll confirm once the bank " +
          "completes the transfer.",
        timestamp: new Date().toISOString(),
      };
    }

    return {
      success: true,
      paymentId: payment.id,
      status: "success",
      amount: withdrawalAmount,
      currency: payment.currency,
      method: "dkbank",
      message:
        "Withdrawal confirmed. Funds are on their way to your DK Bank account.",
      timestamp: new Date().toISOString(),
    };
  }
}
