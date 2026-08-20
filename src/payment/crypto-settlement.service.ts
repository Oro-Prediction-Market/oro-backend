import { Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, EntityManager } from "typeorm";
import {
  Payment,
  PaymentMethod,
  PaymentStatus,
  PaymentType,
} from "../entities/payment.entity";
import {
  Transaction,
  TransactionType,
} from "../entities/transaction.entity";
import {
  CREDITING_STATUSES,
  CryptoIntentStatus,
  CryptoPaymentIntent,
} from "../entities/crypto-payment-intent.entity";
import { ledgerBalance } from "../shared/utils/ledger.util";
import { fromBaseUnits } from "./usdt.util";

const USDT = "USDT";

export interface SettlementInput {
  pay21IntentId: string;
  status: string;
  /** Base units, as 21Pay sent them. Converted once, here. */
  detectedAmountBaseUnits?: string | null;
  txHash?: string | null;
  blockNumber?: string | null;
  failureReason?: string | null;
}

export interface SettlementOutcome {
  handled: boolean;
  credited: boolean;
  reason?: string;
}

/**
 * Turns a verified 21Pay event into a USDT credit, exactly once.
 *
 * One entry point, two callers: the webhook controller and the polling job.
 * One code path, two triggers — a status change must produce the same result
 * whichever way we learned about it, and since 21Pay has no webhook replay the
 * poller is not a fallback but the recovery mechanism.
 *
 * **No conversion anywhere.** USDT in, USDT credited. This is the whole
 * dividend of segregation: the stage that carried all the FX complexity under
 * the old design is now mostly bookkeeping.
 */
@Injectable()
export class CryptoSettlementService {
  private readonly logger = new Logger(CryptoSettlementService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async settle(input: SettlementInput): Promise<SettlementOutcome> {
    return this.dataSource.transaction(async (em) => {
      const intent = await em
        .createQueryBuilder(CryptoPaymentIntent, "i")
        .setLock("pessimistic_write")
        .where("i.pay21IntentId = :id", { id: input.pay21IntentId })
        .getOne();

      if (!intent) {
        // An event for an intent we never created. Retrying will not conjure
        // the row, so this must not 5xx — 21Pay would burn its whole backoff
        // and terminally fail a delivery we can never accept.
        this.logger.error(
          `[USDT] Event for unknown intent ${input.pay21IntentId} — ignoring`,
        );
        return { handled: false, credited: false, reason: "unknown_intent" };
      }

      const status = this.parseStatus(input.status);
      if (!status) {
        this.logger.error(
          `[USDT] Unrecognised status "${input.status}" for intent ` +
            `${input.pay21IntentId}. Recorded, not acted on.`,
        );
        return { handled: false, credited: false, reason: "unknown_status" };
      }

      // Already credited. The second guard, independent of the unique
      // constraint on payments.externalPaymentId — two guards on a credit path
      // is correct, not redundant.
      if (intent.creditedAt) {
        await this.applyMetadata(em, intent, input, status, { skipStatus: true });
        return { handled: true, credited: false, reason: "already_credited" };
      }

      // `completed_via_topup` is parent-only signalling: the money arrived
      // against a child intent which settles on its own. Crediting here pays
      // twice.
      if (status === CryptoIntentStatus.COMPLETED_VIA_TOPUP) {
        await this.applyMetadata(em, intent, input, status);
        return { handled: true, credited: false, reason: "topup_parent" };
      }

      if (!CREDITING_STATUSES.has(status)) {
        // Includes `accepted`, which is a tenant-configured soft threshold
        // rather than chain finality. Crediting there trades reorg risk for a
        // few seconds of UX.
        await this.applyMetadata(em, intent, input, status);
        return { handled: true, credited: false, reason: `no_credit:${status}` };
      }

      const detected = this.detectedAmount(input, intent);
      if (detected === null || detected <= 0) {
        this.logger.error(
          `[USDT] ${status} for intent ${intent.pay21IntentId} carried no ` +
            `usable detected amount — refusing to credit`,
        );
        await this.applyMetadata(em, intent, input, status);
        return { handled: true, credited: false, reason: "no_detected_amount" };
      }

      await this.credit(em, intent, detected, input, status);
      return { handled: true, credited: true };
    });
  }

  /**
   * Write the credit: one `payments` row and one ledger row.
   *
   * The `payments` row keys on the 21Pay intent id, whose unique constraint
   * gives exactly-once at the database layer independently of `creditedAt`.
   */
  private async credit(
    em: EntityManager,
    intent: CryptoPaymentIntent,
    detected: number,
    input: SettlementInput,
    status: CryptoIntentStatus,
  ): Promise<void> {
    const payment = await em.save(
      Payment,
      em.create(Payment, {
        userId: intent.userId,
        type: PaymentType.DEPOSIT,
        status: PaymentStatus.SUCCESS,
        method: PaymentMethod.USDT,
        amount: detected,
        currency: USDT,
        // The intent id, never the tx hash: it is the stable natural key
        // across detected, confirmed, partial and top-up events, whereas a
        // hash is per transfer.
        externalPaymentId: intent.pay21IntentId,
        confirmedAt: new Date(),
        metadata: {
          network: intent.network,
          txHash: input.txHash ?? null,
          blockNumber: input.blockNumber ?? null,
          intentStatus: status,
        },
      }),
    );

    const balanceBefore = await ledgerBalance(em, intent.userId, USDT);

    const tx = await em.save(
      Transaction,
      em.create(Transaction, {
        userId: intent.userId,
        type: TransactionType.DEPOSIT,
        // We credit what arrived, always. Note this is what the *user* is
        // owed; our own claim on 21Pay is `detected − fee`, because they
        // deduct a per-tenant fee at ledger-post time. Reconciliation models
        // that difference; the credit does not.
        amount: detected,
        currency: USDT,
        balanceBefore,
        balanceAfter: balanceBefore + detected,
        paymentId: payment.id,
        isBonus: false,
        note: `USDT deposit · ${intent.network}`,
      }),
    );

    await em.update(
      CryptoPaymentIntent,
      { id: intent.id },
      {
        status,
        detectedAmountUsdt: detected,
        txHash: input.txHash ?? intent.txHash,
        blockNumber: input.blockNumber ?? intent.blockNumber,
        paymentId: payment.id,
        transactionId: tx.id,
        creditedAt: new Date(),
      },
    );

    this.logger.log(
      `[USDT] Credited ${detected} USDT to user ${intent.userId} ` +
        `for intent ${intent.pay21IntentId} (${status})`,
    );
  }

  /**
   * Reverse a credited deposit after a chain reorg.
   *
   * **Nothing pushes this to us.** The reorg subject is engine-wide and not in
   * the webhook fan-out, so a reversal is only ever discovered by re-polling.
   * That makes reconciliation the mechanism, not a safety net.
   *
   * The compensating row is allowed to drive the user negative, exactly as
   * 21Pay's own clawback drives our tenant balance negative: the money is gone
   * and pretending otherwise would leave us funding it. A negative balance
   * blocks staking and withdrawal until it is resolved, which is the correct
   * outcome and needs an ops path rather than a silent write-off.
   */
  async reverse(
    pay21IntentId: string,
    reason: string,
  ): Promise<SettlementOutcome> {
    return this.dataSource.transaction(async (em) => {
      const intent = await em
        .createQueryBuilder(CryptoPaymentIntent, "i")
        .setLock("pessimistic_write")
        .where("i.pay21IntentId = :id", { id: pay21IntentId })
        .getOne();

      if (!intent || !intent.creditedAt) {
        return { handled: false, credited: false, reason: "not_credited" };
      }

      const amount = Number(intent.detectedAmountUsdt ?? 0);
      if (amount <= 0) {
        return { handled: false, credited: false, reason: "no_amount" };
      }

      const balanceBefore = await ledgerBalance(em, intent.userId, USDT);
      await em.save(
        Transaction,
        em.create(Transaction, {
          userId: intent.userId,
          type: TransactionType.REFUND,
          amount: -amount,
          currency: USDT,
          balanceBefore,
          balanceAfter: balanceBefore - amount,
          isBonus: false,
          note: `USDT deposit reversed · ${reason}`,
        }),
      );

      await em.update(
        CryptoPaymentIntent,
        { id: intent.id },
        {
          status: CryptoIntentStatus.FAILED,
          failureReason: reason.slice(0, 255),
          creditedAt: null,
        },
      );

      // Loud: this is money taken back from a user who already saw it.
      this.logger.error(
        `[USDT] REVERSED ${amount} USDT for intent ${pay21IntentId} ` +
          `(user ${intent.userId}): ${reason}`,
      );
      return { handled: true, credited: false, reason: "reversed" };
    });
  }

  /** Status and chain metadata for a non-crediting event. */
  private async applyMetadata(
    em: EntityManager,
    intent: CryptoPaymentIntent,
    input: SettlementInput,
    status: CryptoIntentStatus,
    opts: { skipStatus?: boolean } = {},
  ): Promise<void> {
    await em.update(
      CryptoPaymentIntent,
      { id: intent.id },
      {
        ...(opts.skipStatus ? {} : { status }),
        txHash: input.txHash ?? intent.txHash,
        blockNumber: input.blockNumber ?? intent.blockNumber,
        failureReason: input.failureReason ?? intent.failureReason,
      },
    );
  }

  private detectedAmount(
    input: SettlementInput,
    intent: CryptoPaymentIntent,
  ): number | null {
    if (input.detectedAmountBaseUnits != null) {
      const human = fromBaseUnits(String(input.detectedAmountBaseUnits));
      return Number(human);
    }
    // Never fall back to the expected amount: the expectation is what we asked
    // for, and crediting it is how a ledger drifts from what is on chain.
    return intent.detectedAmountUsdt !== null &&
      intent.detectedAmountUsdt !== undefined
      ? Number(intent.detectedAmountUsdt)
      : null;
  }

  private parseStatus(raw: string): CryptoIntentStatus | null {
    const known = Object.values(CryptoIntentStatus) as string[];
    return known.includes(raw) ? (raw as CryptoIntentStatus) : null;
  }
}
