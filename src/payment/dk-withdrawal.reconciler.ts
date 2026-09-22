import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { DataSource, LessThan, Repository } from "typeorm";

import { User } from "../entities/user.entity";
import { UserNotification } from "../entities/user-notification.entity";
import {
  Payment,
  PaymentMethod,
  PaymentStatus,
  PaymentType,
} from "../entities/payment.entity";
import {
  BTN_CURRENCY,
  Transaction,
  TransactionType,
} from "../entities/transaction.entity";
import { DKGatewayService } from "./services/dk-gateway/dk-gateway.service";
import { RedisService } from "../redis/redis.service";
import { SseService } from "../sse/sse.service";
import { classifyDkStatus } from "./dk-status.util";
import { WITHDRAWAL_CONFIRMED, WITHDRAWAL_REFUNDED } from "./dk-ledger-notes";
import { ledgerBalance } from "../shared/utils/ledger.util";

/**
 * A withdrawal is only reconciled once it has had time to settle. Anything
 * younger than this is still legitimately in flight.
 *
 * Two tiers, because the two rails answer at different speeds. A new-core
 * transfer settles in seconds and its status endpoint replies at once, so ten
 * minutes there is latency we impose, not latency DK does. The legacy route
 * keeps the original grace — it was chosen against that rail's behaviour and
 * nothing here has learned anything new about it.
 */
const NEW_CORE_SETTLE_GRACE_MS = 2 * 60 * 1000;
const LEGACY_SETTLE_GRACE_MS = 10 * 60 * 1000;

/**
 * Never re-ask DK about the same payment more often than this. Same split and
 * the same reasoning: a new-core row that is still validating is worth another
 * question in minutes, and waiting half an hour would leave a transfer that
 * settled seconds after the first check looking stuck for the rest of the hour.
 */
const NEW_CORE_RECHECK_MS = 5 * 60 * 1000;
const LEGACY_RECHECK_MS = 30 * 60 * 1000;

/**
 * Closes out withdrawals left in PROCESSING.
 *
 * `confirmWithdrawal` deliberately parks a withdrawal in PROCESSING whenever
 * DK's answer is indeterminate: the user's debit stays put and no refund is
 * issued, because refunding a transfer that actually settled would pay twice.
 * That is the correct call at the time — but nothing used to revisit those
 * rows, so a user's money sat in limbo indefinitely. This asks DK what
 * happened and finishes the job.
 */
@Injectable()
export class DKWithdrawalReconciler {
  private readonly logger = new Logger(DKWithdrawalReconciler.name);
  private running = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,
    private readonly dkGateway: DKGatewayService,
    private readonly redis: RedisService,
    private readonly sse: SseService,
    @InjectRepository(UserNotification)
    private readonly userNotifRepo: Repository<UserNotification>,
  ) {}

  /**
   * Fire-and-forget in-app notification, on the default connection and never
   * throwing — a notification failure must never affect a reconciled
   * withdrawal or its refund.
   */
  private notifyTransaction(
    userId: string,
    title: string,
    body: string,
    metadata: Record<string, any>,
  ): void {
    void this.userNotifRepo
      .save(
        this.userNotifRepo.create({
          userId,
          type: "transaction",
          title,
          body,
          metadata,
        }),
      )
      .catch((err: any) =>
        this.logger.warn(
          `[Reconcile] transaction notification failed for ${userId}: ${err.message}`,
        ),
      );
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async reconcileStuckWithdrawals() {
    // Overlapping runs would ask DK about the same payment twice and race on
    // the refund. A single-flight flag is enough — this is one process's cron.
    if (this.running) return;
    this.running = true;
    try {
      const stuck = await this.paymentRepo.find({
        where: {
          type: PaymentType.WITHDRAWAL,
          method: PaymentMethod.DK_BANK,
          status: PaymentStatus.PROCESSING,
          // The wider of the two nets. A legacy row caught early is held back
          // in reconcileOne rather than asked about before its own grace.
          createdAt: LessThan(new Date(Date.now() - NEW_CORE_SETTLE_GRACE_MS)),
        },
        order: { createdAt: "ASC" },
        take: 50,
      });
      if (!stuck.length) return;

      this.logger.log(
        `[Reconcile] ${stuck.length} withdrawal(s) stuck in PROCESSING`,
      );
      for (const payment of stuck) {
        try {
          await this.reconcileOne(payment);
        } catch (e: any) {
          this.logger.error(
            `[Reconcile] payment ${payment.id} failed: ${e?.message}`,
          );
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async reconcileOne(payment: Payment) {
    // DK's new core answers an initiate call with `0001` and a payment_number,
    // and the legacy status route cannot say anything about those transfers.
    // The handle the payment carries is what picks the route, so rows written
    // before the migration keep reconciling exactly as they did.
    const pendingHandle =
      (payment.metadata?.dkTransfer?.paymentNumber as string | undefined) ||
      (payment.metadata?.dkTransfer?.requestId as string | undefined);
    // A payout credits the USER's account, so that is the account the status
    // lookup must be scoped to. The legacy route hardcodes the merchant vault,
    // which is the wrong side of the transfer.
    const destinationAccount = payment.metadata?.dkAccountNumber as
      | string
      | undefined;
    const useNewCore = !!pendingHandle && !!destinationAccount;

    const legacyTxnId =
      payment.externalPaymentId ||
      payment.dkTxnStatusId ||
      (payment.metadata?.dkTransfer?.txnId as string | undefined);

    const txnId = useNewCore ? pendingHandle : legacyTxnId;

    // The sweep selects on the shorter of the two graces, so a legacy row can
    // arrive here before it has had its ten minutes. Let it finish settling.
    const ageMs = payment.createdAt
      ? Date.now() - new Date(payment.createdAt).getTime()
      : Number.NaN;
    if (!useNewCore && ageMs < LEGACY_SETTLE_GRACE_MS) return;

    if (!txnId) {
      // DK never gave us a handle — most often the call threw before any reply.
      // There is nothing to query, so this needs a human with DK's statement.
      // Logged at a fixed interval so it stays visible without flooding.
      const lastWarn = Number(payment.metadata?.dkReconcileWarnedAt ?? 0);
      if (Date.now() - lastWarn < LEGACY_RECHECK_MS) return;
      this.logger.error(
        `[Reconcile] payment ${payment.id} (user ${payment.userId}, Nu ` +
          `${payment.amount}) has no DK transaction id — MANUAL reconciliation ` +
          `required against DK's statement before refunding`,
      );
      await this.stampMetadata(payment, { dkReconcileWarnedAt: Date.now() });
      return;
    }

    const recheckMs = useNewCore ? NEW_CORE_RECHECK_MS : LEGACY_RECHECK_MS;
    const lastCheck = Number(payment.metadata?.dkReconcileCheckedAt ?? 0);
    if (Date.now() - lastCheck < recheckMs) return;

    let result: { status: string; statusDesc?: string; raw?: unknown };
    let verdict: "success" | "failed" | "pending";
    try {
      if (useNewCore) {
        const answer = await this.dkGateway.checkTransferStatus({
          referenceNo: pendingHandle!,
          beneAccountNumber: destinationAccount!,
        });
        verdict = answer.verdict;
        // Keep DK's own word where it sent one, so the row records what the
        // bank said rather than how we classified it.
        result = {
          status: answer.status ?? answer.responseCode,
          statusDesc: answer.statusDesc,
          raw: answer.raw,
        };
      } else {
        result = await this.dkGateway.checkTransactionStatus(txnId);
        verdict = classifyDkStatus(result.status);
      }
    } catch (e: any) {
      // Stamp the attempt before rethrowing, or a status check that always
      // errors would re-ask DK on every tick instead of every 30 minutes.
      await this.stampMetadata(payment, {
        dkReconcileCheckedAt: Date.now(),
        dkReconcileLastError: e?.message ?? "status check failed",
      });
      throw e;
    }

    if (verdict === "pending") {
      await this.stampMetadata(payment, {
        dkReconcileCheckedAt: Date.now(),
        dkReconcileLastStatus: result.status,
      });
      return;
    }

    await this.finalise(payment, verdict, result);
  }

  /**
   * Merge keys into a payment's metadata.
   *
   * `repo.save(entity)` would write every column from a row this service read
   * minutes ago, so a concurrent finalise could be reverted to PROCESSING by a
   * bookkeeping write. The grace period makes that overlap unlikely rather
   * than impossible; targeting the one column removes the question.
   */
  private async stampMetadata(
    payment: Payment,
    fields: Record<string, unknown>,
  ) {
    const merged = { ...(payment.metadata || {}), ...fields };
    payment.metadata = merged;
    await this.paymentRepo.update(payment.id, { metadata: merged });
  }

  /**
   * Apply a terminal verdict. Mirrors phase 3 of `confirmWithdrawal`: on
   * success the existing debit simply stands; on a definite failure the
   * reserved funds are returned.
   */
  private async finalise(
    payment: Payment,
    verdict: "success" | "failed",
    result: { status: string; statusDesc?: string; raw?: unknown },
  ) {
    const userId = payment.userId;
    const amount = Number(payment.amount);
    // Set only past the `status === PROCESSING` guard below, so the notification
    // fires exactly once — only for the run that actually finalised the row.
    // Wrapper object so the closure assignment survives TS narrowing.
    const finalized: { outcome: "success" | "failed" | null } = {
      outcome: null,
    };

    await this.dataSource.transaction(async (em) => {
      // Same lock order as confirmWithdrawal — user first, then payment — so
      // the two can never deadlock against each other.
      await em
        .getRepository(User)
        .createQueryBuilder("u")
        .setLock("pessimistic_write")
        .where("u.id = :id", { id: userId })
        .getOne();

      const locked = await em
        .getRepository(Payment)
        .createQueryBuilder("p")
        .setLock("pessimistic_write")
        .where("p.id = :id", { id: payment.id })
        .getOne();
      if (!locked) return;
      // Someone else finished it while we were talking to DK.
      if (locked.status !== PaymentStatus.PROCESSING) return;

      locked.metadata = {
        ...(locked.metadata || {}),
        dkReconcileCheckedAt: Date.now(),
        dkReconcile: {
          status: result.status,
          statusDesc: result.statusDesc ?? null,
          raw: result.raw ?? null,
          at: new Date().toISOString(),
        },
      };

      if (verdict === "success") {
        // Same restamp as confirmWithdrawal's success path.
        await em.update(
          Transaction,
          { paymentId: locked.id, type: TransactionType.WITHDRAWAL },
          { note: WITHDRAWAL_CONFIRMED },
        );
        locked.status = PaymentStatus.SUCCESS;
        locked.confirmedAt = new Date();
        locked.failureReason = null;
        await em.save(locked);
        finalized.outcome = "success";
        this.logger.log(
          `[Reconcile] payment ${payment.id} settled at DK — marked SUCCESS`,
        );
        return;
      }

      const balNow = await ledgerBalance(em, userId, BTN_CURRENCY);
      await em.save(
        Transaction,
        em.create(Transaction, {
          type: TransactionType.REFUND,
          amount, // positive = return the reserved funds
          balanceBefore: balNow,
          balanceAfter: balNow + amount,
          paymentId: locked.id,
          userId,
          note: WITHDRAWAL_REFUNDED,
        }),
      );
      locked.status = PaymentStatus.FAILED;
      locked.failureReason =
        result.statusDesc || "DK Bank transfer failed (reconciled)";
      locked.confirmedAt = new Date();
      await em.save(locked);
      finalized.outcome = "failed";
      this.logger.warn(
        `[Reconcile] payment ${payment.id} failed at DK — refunded Nu ${amount}`,
      );
    });

    await this.redis.del(`oro:cache:balance:${userId}`);
    this.sse.emit(userId, "balance:updated", { paymentId: payment.id });

    // Same messages as the instant path (confirmWithdrawal), so a withdrawal
    // notifies identically whether DK answered at once or was reconciled later.
    if (finalized.outcome === "success") {
      this.notifyTransaction(
        userId,
        "Withdrawal sent",
        `Nu ${amount.toLocaleString()} has been sent to your bank account.`,
        {
          kind: "withdrawal",
          amount,
          currency: BTN_CURRENCY,
          status: "sent",
        },
      );
    } else if (finalized.outcome === "failed") {
      this.notifyTransaction(
        userId,
        "Withdrawal failed",
        `Your Nu ${amount.toLocaleString()} withdrawal could not be completed and has been refunded to your wallet.`,
        {
          kind: "withdrawal",
          amount,
          currency: BTN_CURRENCY,
          status: "refunded",
        },
      );
    }
  }
}
