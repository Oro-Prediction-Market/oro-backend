import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { In, IsNull, LessThan, Not, Repository } from "typeorm";
import {
  CryptoIntentStatus,
  CryptoPaymentIntent,
} from "../entities/crypto-payment-intent.entity";
import { TwentyOnePayClient } from "./services/twentyone-pay/twentyone-pay.client";
import { CryptoSettlementService } from "./crypto-settlement.service";
import { CryptoWithdrawal, TERMINAL_REMOTE_STATUSES } from "../entities/crypto-withdrawal.entity";
import { CryptoWithdrawalService } from "./crypto-withdrawal.service";

/** How long after a credit a reorg can still take it back. Generous. */
const REORG_WINDOW_MINUTES = 60;

/** Do not hammer the intents endpoint: it is 30/min per source IP. */
const BATCH = 20;

/**
 * Polls 21Pay for intent state.
 *
 * Described in the original plan as a fallback behind webhooks. It is not.
 * **21Pay has no webhook replay** — a delivery we drop, or one that terminally
 * fails during an incident, is gone — so this is the only recovery mechanism
 * that exists.
 *
 * It also covers two things webhooks cannot deliver at all:
 *
 * - **Reorg reversals.** A `confirmed` deposit can revert to `failed`, and the
 *   reorg subject is engine-wide and not in the webhook fan-out. Nothing will
 *   ever tell us; we have to look.
 * - **AML failures.** No `deposits.<net>.failed` publisher exists in the
 *   engine, despite their docs listing one.
 *
 * See docs/usdt-oro/21PAY-ANSWERS.md §2.4, §3.5, §3.7.
 */
@Injectable()
export class CryptoIntentPoller {
  private readonly logger = new Logger(CryptoIntentPoller.name);

  constructor(
    @InjectRepository(CryptoPaymentIntent)
    private readonly intentRepo: Repository<CryptoPaymentIntent>,
    @InjectRepository(CryptoWithdrawal)
    private readonly withdrawalRepo: Repository<CryptoWithdrawal>,
    private readonly client: TwentyOnePayClient,
    private readonly settlement: CryptoSettlementService,
    private readonly withdrawals: CryptoWithdrawalService,
  ) {}

  /**
   * Advance submitted withdrawals.
   *
   * Withdrawals are **not** in the webhook fan-out at all — the consumer binds
   * deposits, payouts and freeze only. So unlike deposits, where polling is
   * recovery, here it is the entire mechanism. A stuck poller is a user whose
   * withdrawal silently never completes.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async pollWithdrawals(): Promise<void> {
    if (!this.client.enabled) return;

    const open = await this.withdrawalRepo.find({
      where: { pay21WithdrawalId: Not(IsNull()) },
      order: { updatedAt: "ASC" },
      take: BATCH,
    });

    for (const wd of open) {
      if (wd.remoteStatus && TERMINAL_REMOTE_STATUSES.has(wd.remoteStatus)) {
        continue;
      }
      try {
        const remote = await this.client.getWithdrawal(wd.pay21WithdrawalId!);
        await this.withdrawals.applyRemoteState(wd.id, remote);
      } catch (err) {
        this.logger.warn(
          `[USDT] Withdrawal poll failed for ${wd.pay21WithdrawalId}: ` +
            `${(err as Error).message}`,
        );
      }
    }
  }

  /** Advance intents that are still in flight. */
  @Cron(CronExpression.EVERY_MINUTE)
  async pollOpenIntents(): Promise<void> {
    if (!this.client.enabled) return;

    // Only rows the webhook has had a fair chance at first, so the common case
    // costs nothing.
    const staleBefore = new Date(Date.now() - 90_000);
    const open = await this.intentRepo.find({
      where: {
        status: In([
          CryptoIntentStatus.AWAITING_DEPOSIT,
          CryptoIntentStatus.CONFIRMING,
          CryptoIntentStatus.ACCEPTED,
          CryptoIntentStatus.CONFIRMED_PARTIAL,
        ]),
        updatedAt: LessThan(staleBefore),
      },
      order: { updatedAt: "ASC" },
      take: BATCH,
    });

    for (const intent of open) {
      await this.syncOne(intent);
    }
  }

  /**
   * Re-check recently credited deposits for a reversal.
   *
   * The only way we ever learn a confirmed deposit was orphaned by a reorg.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async pollForReversals(): Promise<void> {
    if (!this.client.enabled) return;

    const since = new Date(Date.now() - REORG_WINDOW_MINUTES * 60_000);
    const credited = await this.intentRepo.find({
      where: { creditedAt: Not(IsNull()), status: CryptoIntentStatus.CONFIRMED },
      order: { creditedAt: "DESC" },
      take: BATCH,
    });

    for (const intent of credited) {
      if (!intent.creditedAt || intent.creditedAt < since) continue;
      try {
        const remote = await this.client.getPaymentIntent(intent.pay21IntentId);
        if (remote.status === "failed") {
          await this.settlement.reverse(
            intent.pay21IntentId,
            "chain reorg — deposit orphaned at 21Pay",
          );
        }
      } catch (err) {
        this.logger.warn(
          `[USDT] Reversal check failed for ${intent.pay21IntentId}: ` +
            `${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Mark intents past their expiry.
   *
   * A mirror of 21Pay's own expiry watcher, not the authority: if they later
   * report a deposit against an intent we called expired, they win. That is
   * exactly what `confirmed_partial` on an expired parent plus top-up is for.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async sweepExpired(): Promise<void> {
    if (!this.client.enabled) return;

    const { affected } = await this.intentRepo.update(
      {
        status: CryptoIntentStatus.AWAITING_DEPOSIT,
        expiresAt: LessThan(new Date()),
      },
      { status: CryptoIntentStatus.EXPIRED },
    );
    if (affected) {
      this.logger.log(`[USDT] Marked ${affected} intent(s) expired`);
    }
  }

  private async syncOne(intent: CryptoPaymentIntent): Promise<void> {
    try {
      const remote = await this.client.getPaymentIntent(intent.pay21IntentId);
      if (remote.status === intent.status) return;

      // Same entry point the webhook uses. One code path, two triggers: a
      // status change must produce the same result however we learned of it.
      await this.settlement.settle({
        pay21IntentId: intent.pay21IntentId,
        status: remote.status,
        detectedAmountBaseUnits: remote.detected_amount ?? null,
        txHash: remote.tx_hash ?? null,
      });
    } catch (err) {
      this.logger.warn(
        `[USDT] Poll failed for ${intent.pay21IntentId}: ` +
          `${(err as Error).message}`,
      );
    }
  }
}
