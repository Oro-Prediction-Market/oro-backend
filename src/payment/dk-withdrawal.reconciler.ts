import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { DataSource, LessThan, Repository } from "typeorm";

import { User } from "../entities/user.entity";
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
import { ledgerBalance } from "../shared/utils/ledger.util";

/**
 * A withdrawal is only reconciled once it has had time to settle. Anything
 * younger than this is still legitimately in flight.
 */
const SETTLE_GRACE_MS = 10 * 60 * 1000;

/** Never re-ask DK about the same payment more often than this. */
const RECHECK_INTERVAL_MS = 30 * 60 * 1000;

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
  ) {}

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
          createdAt: LessThan(new Date(Date.now() - SETTLE_GRACE_MS)),
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
    const txnId =
      payment.externalPaymentId ||
      payment.dkTxnStatusId ||
      (payment.metadata?.dkTransfer?.txnId as string | undefined);

    if (!txnId) {
      // DK never gave us a handle — most often the call threw before any reply.
      // There is nothing to query, so this needs a human with DK's statement.
      // Logged at a fixed interval so it stays visible without flooding.
      const lastWarn = Number(payment.metadata?.dkReconcileWarnedAt ?? 0);
      if (Date.now() - lastWarn < RECHECK_INTERVAL_MS) return;
      this.logger.error(
        `[Reconcile] payment ${payment.id} (user ${payment.userId}, Nu ` +
          `${payment.amount}) has no DK transaction id — MANUAL reconciliation ` +
          `required against DK's statement before refunding`,
      );
      await this.stampMetadata(payment, { dkReconcileWarnedAt: Date.now() });
      return;
    }

    const lastCheck = Number(payment.metadata?.dkReconcileCheckedAt ?? 0);
    if (Date.now() - lastCheck < RECHECK_INTERVAL_MS) return;

    let result: Awaited<
      ReturnType<DKGatewayService["checkTransactionStatus"]>
    >;
    try {
      result = await this.dkGateway.checkTransactionStatus(txnId);
    } catch (e: any) {
      // Stamp the attempt before rethrowing, or a status check that always
      // errors would re-ask DK on every tick instead of every 30 minutes.
      await this.stampMetadata(payment, {
        dkReconcileCheckedAt: Date.now(),
        dkReconcileLastError: e?.message ?? "status check failed",
      });
      throw e;
    }

    const verdict = classifyDkStatus(result.status);

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
        locked.status = PaymentStatus.SUCCESS;
        locked.confirmedAt = new Date();
        locked.failureReason = null;
        await em.save(locked);
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
          note: `DK Bank withdrawal failed — reserved funds returned`,
        }),
      );
      locked.status = PaymentStatus.FAILED;
      locked.failureReason =
        result.statusDesc || "DK Bank transfer failed (reconciled)";
      locked.confirmedAt = new Date();
      await em.save(locked);
      this.logger.warn(
        `[Reconcile] payment ${payment.id} failed at DK — refunded Nu ${amount}`,
      );
    });

    await this.redis.del(`oro:cache:balance:${userId}`);
    this.sse.emit(userId, "balance:updated", { paymentId: payment.id });
  }
}
