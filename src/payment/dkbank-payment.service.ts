import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { DataSource, Repository } from "typeorm";

import { User } from "../entities/user.entity";
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
import { TelegramVerificationService } from "../telegram/telegram-verification.service";
import { SseService } from "../sse/sse.service";

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
  status: "pending" | "success" | "failed";
  amount: number;
  currency: string;
  method: "dkbank";
  message: string;
  timestamp: string;
  /** True when the payment is waiting for the customer's OTP before executing. */
  otpRequired?: boolean;
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
    private readonly telegramVerification: TelegramVerificationService,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,
    @InjectRepository(PaymentOtp)
    private readonly otpRepo: Repository<PaymentOtp>,
    private readonly sse: SseService,
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

    // ── CID ownership check — ALWAYS enforced, even in staging ───────────────
    // The CID submitted must match the one the user linked to their account.
    // This prevents user A from paying with user B's CID.
    if (user.dkCid && user.dkCid !== cid) {
      this.logger.warn(
        `[Payment] CID mismatch for user ${userId}: submitted=${cid} linked=${user.dkCid}`,
      );
      throw new BadRequestException(
        "The CID you entered does not match your linked DK Bank account. " +
          "Please use your own CID.",
      );
    }
    if (!user.dkCid) {
      throw new BadRequestException(
        "You have not linked a DK Bank account yet. " +
          "Please go to Wallet Page → Link DK Bank Account first.",
      );
    }

    // ── Bank-level security: verify Telegram phone == DK Bank phone ──────────
    // ALWAYS enforced in both staging and production.
    // User must have verified their Telegram phone matches their DK Bank phone.
    await this.telegramVerification.verifyPaymentIdentity(userId);

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
        if (otpRecord) {
          otpRecord.failedAttempts += 1;
          await this.otpRepo.save(otpRecord);
        }
        payment.status = PaymentStatus.FAILED;
        payment.failureReason = e?.message || "DK debit request failed";
        await this.paymentRepo.save(payment);
        throw new BadRequestException(
          e?.message || "Invalid OTP or transaction failed. Please try again.",
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
      const [user, balRow] = await Promise.all([
        this.userRepo.findOne({
          where: { id: userId },
          select: ["telegramId", "firstName"],
        }),
        this.dataSource
          .getRepository(Transaction)
          .createQueryBuilder("t")
          .select("COALESCE(SUM(t.amount), 0)", "balance")
          .where("t.userId = :userId", { userId })
          .getRawOne(),
      ]);
      if (user?.telegramId) {
        const newBalance = Number(balRow?.balance ?? 0);
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
            `✅ <b>Deposit Successful</b>\n\n` +
              `<b>Nu ${depositedAmount.toLocaleString()}</b> has been credited to your Oro wallet.\n\n` +
              `💰 New balance: <b>Nu ${newBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>\n` +
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
    const statusUpper = (params.dkStatus || "PENDING").toUpperCase();
    const mapped = statusUpper.includes("SUCCESS")
      ? PaymentStatus.SUCCESS
      : statusUpper.includes("FAIL")
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
        const { balance: rawBefore } = await em
          .getRepository(Transaction)
          .createQueryBuilder("t")
          .select("COALESCE(SUM(t.amount), 0)", "balance")
          .where("t.userId = :userId", { userId: params.userId })
          .getRawOne();
        const balanceBefore = Number(rawBefore);

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

    if (!user.dkAccountNumber || !user.dkCid) {
      throw new BadRequestException(
        "You have not linked a DK Bank account yet. " +
          "Please go to Wallet Page → Link DK Bank Account first.",
      );
    }

    // ── Check in-app credit balance ───────────────────────────────────────────
    // Must happen outside a write-lock — this is a pre-flight read.
    // The authoritative balance check is repeated inside confirmWithdrawal
    // under pessimistic_write lock to prevent TOCTOU races.
    let balance = 0;
    await this.dataSource.transaction(async (em) => {
      const { balance: rawBalance } = await em
        .getRepository(Transaction)
        .createQueryBuilder("t")
        .select("COALESCE(SUM(t.amount), 0)", "balance")
        .where("t.userId = :userId", { userId })
        .getRawOne();
      balance = Number(rawBalance);
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
        dkAccountNumber: user.dkAccountNumber,
        dkAccountName: user.dkAccountName ?? null,
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
      60,
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
    await this.telegramService
      .sendMessage(
        Number(user.telegramId),
        `🏦 <b>Oro Withdrawal OTP</b>\n\nHi ${firstName}, your one-time code to withdraw <b>Nu ${amount.toLocaleString()}</b> to your DK Bank account:\n\n<code>${generatedOtp}</code>\n\n⏳ Expires in 1 minute\n\n⚠️ <b>Oro will never ask for this code.</b> Do not share it with anyone.`,
      )
      .catch((err) =>
        this.logger.warn(
          `Failed to send withdrawal OTP via Telegram: ${err.message}`,
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
        "OTP sent to your Telegram. Please enter it to confirm the withdrawal.",
      timestamp: now.toISOString(),
      otpRequired: true,
    };
  }

  /**
   * Step 2 — Withdrawal confirmation.
   * Validates the Telegram OTP, then inside a single atomic DB transaction:
   *   1. Re-checks balance under pessimistic_write lock (prevents TOCTOU)
   *   2. Calls DK Gateway to push funds from merchant vault → user DK account
   *   3. Only if DK transfer succeeds: writes the WITHDRAWAL debit ledger entry
   *      and marks the payment SUCCESS
   *
   * If the DK transfer fails or throws, the transaction rolls back — no debit
   * is written and the merchant vault balance is unchanged.
   */
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
      throw new BadRequestException(
        "Invalid OTP. Please check your Telegram and try again.",
      );
    }

    // OTP is valid — delete it immediately to prevent replay
    await this.redis.del(`oro:tg-otp:${paymentId}`);

    // ── Atomic: balance re-check + DK transfer + ledger debit ────────────────
    const user = await this.userRepo.findOne({ where: { id: userId } });
    const withdrawalAmount = Number(payment.amount);

    const result: { status: "success" | "failed"; failureReason?: string } = {
      status: "success",
    };

    await this.dataSource.transaction(async (em) => {
      // Pessimistic lock: re-read payment to prevent concurrent withdrawal attempts
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
      const { balance: rawBalance } = await em
        .getRepository(Transaction)
        .createQueryBuilder("t")
        .select("COALESCE(SUM(t.amount), 0)", "balance")
        .where("t.userId = :userId", { userId })
        .getRawOne();
      const balanceBefore = Number(rawBalance);

      if (balanceBefore < withdrawalAmount) {
        throw new BadRequestException(
          `Insufficient balance. Available: Nu ${balanceBefore.toFixed(2)}.`,
        );
      }

      // Bonus credits are play money — they cannot be sent to DK Bank directly.
      // Only the real (non-bonus) portion of the balance is withdrawable.
      const lockedUser = await em.findOne(User, {
        where: { id: userId },
        select: ["id", "bonusBalance"],
      });
      const bonusBalance = Number(lockedUser?.bonusBalance ?? 0);
      const realWithdrawable = balanceBefore - bonusBalance;

      if (realWithdrawable < withdrawalAmount) {
        throw new BadRequestException(
          `Insufficient withdrawable balance. ` +
            `Nu ${bonusBalance.toFixed(2)} of your balance is bonus credit and cannot be withdrawn. ` +
            `Withdrawable: Nu ${Math.max(0, realWithdrawable).toFixed(2)}.`,
        );
      }

      // ── Call DK Gateway: push funds from merchant vault to user account ───
      // Uses /v1/initiate/transaction which works in both staging and production.
      // No bypass needed — this endpoint is confirmed working in DK staging.
      const isStagingWithdrawalBypass =
        this.configService.get<string>("DK_STAGING_WITHDRAWAL_BYPASS") ===
        "true";

      let transferResult: {
        txnId: string | null;
        txnStatusId?: string | null;
        inquiryId?: string | null;
        status: string;
        statusDesc: string;
        raw?: unknown;
      };
      if (isStagingWithdrawalBypass) {
        this.logger.warn(
          `[STAGING] Skipping real DK transfer for payment ${lockedPayment.id} — DK_STAGING_WITHDRAWAL_BYPASS active`,
        );
        transferResult = {
          txnId: `STAGING-${Date.now()}`,
          status: "SUCCESS",
          statusDesc: "Staging bypass — no real transfer",
        };
      } else {
        transferResult = await this.dkGateway.transferToAccount({
          accountNumber:
            user?.dkAccountNumber ?? lockedPayment.metadata?.dkAccountNumber,
          accountName:
            user?.dkAccountName ??
            lockedPayment.metadata?.dkAccountName ??
            undefined,
          amount: withdrawalAmount,
          currency: "BTN",
          reference: lockedPayment.id,
          description: `oro withdrawal for user ${userId}`,
        });
      }

      const transferSucceeded =
        typeof transferResult?.status === "string" &&
        transferResult.status.toUpperCase().includes("SUCCESS");

      if (!transferSucceeded) {
        // DK returned a failure response — mark payment FAILED, no debit written
        lockedPayment.status = PaymentStatus.FAILED;
        lockedPayment.failureReason =
          transferResult?.statusDesc || "DK Bank transfer failed";
        lockedPayment.confirmedAt = new Date();
        await em.save(lockedPayment);
        result.status = "failed";
        result.failureReason = lockedPayment.failureReason ?? undefined;
        return; // exit transaction without writing debit
      }

      // ── DK transfer succeeded — write the ledger debit ───────────────────
      await em.save(
        Transaction,
        em.create(Transaction, {
          type: TransactionType.WITHDRAWAL,
          amount: -withdrawalAmount, // negative = debit from in-app balance
          balanceBefore,
          balanceAfter: balanceBefore - withdrawalAmount,
          paymentId: lockedPayment.id,
          userId,
          note: `DK Bank withdrawal confirmed`,
        }),
      );

      lockedPayment.status = PaymentStatus.SUCCESS;
      lockedPayment.confirmedAt = new Date();
      lockedPayment.externalPaymentId = transferResult?.txnId ?? null;
      lockedPayment.failureReason = null;
      await em.save(lockedPayment);
    });

    // ── Cleanup ──────────────────────────────────────────────────────────────
    if (otpRecord) {
      otpRecord.status = OtpStatus.VERIFIED;
      otpRecord.verifiedAt = new Date();
      await this.otpRepo.save(otpRecord);
    }
    await this.redis.del(`oro:otp:${paymentId}`);
    await this.redis.del(`oro:cache:balance:${userId}`);
    if (result.status !== "failed") {
      this.sse.emit(userId, "balance:updated", { paymentId });
    }

    if (result.status === "failed") {
      await this.paymentRepo.save(
        Object.assign(payment, {
          status: PaymentStatus.FAILED,
          failureReason: result.failureReason,
        }),
      );
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
