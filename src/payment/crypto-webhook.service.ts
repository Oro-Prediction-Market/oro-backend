import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { CryptoWebhookEvent } from "../entities/crypto-webhook-event.entity";

/** Deposit actions the engine actually publishes. Anything else is dropped. */
export const KNOWN_DEPOSIT_ACTIONS = new Set([
  "detected",
  "accepted",
  "confirmed",
  "confirmed_partial",
  "confirmed_overpaid",
  "completed_via_topup",
  "expired",
  "unexpected",
]);

/** Payout actions. Note withdrawals are **not** delivered by webhook at all. */
export const KNOWN_PAYOUT_ACTIONS = new Set([
  "broadcast",
  "confirmed",
  "failed",
]);

export interface RecordedEvent {
  event: CryptoWebhookEvent | null;
  duplicate: boolean;
}

/**
 * Records 21Pay webhook deliveries.
 *
 * This service only writes the event down. Crediting is the settlement
 * service's job, and keeping them apart is what lets this run against real
 * traffic — accumulating replayable events — before any money moves.
 */
@Injectable()
export class CryptoWebhookService {
  private readonly logger = new Logger(CryptoWebhookService.name);

  constructor(
    @InjectRepository(CryptoWebhookEvent)
    private readonly eventRepo: Repository<CryptoWebhookEvent>,
  ) {}

  /**
   * `X-T1Pay-Event` carries the **full NATS subject**, not the short label
   * 21Pay's docs show:
   *
   *   payment.tenants.<tid>.deposits.tron.confirmed
   *
   * so the action is the last segment and the family the third from last.
   */
  parseSubject(subject: string): {
    family: string | null;
    network: string | null;
    action: string | null;
  } {
    const parts = String(subject ?? "").split(".");
    if (parts.length < 3) return { family: null, network: null, action: null };
    return {
      family: parts[parts.length - 3] ?? null,
      network: parts[parts.length - 2] ?? null,
      action: parts[parts.length - 1] ?? null,
    };
  }

  isHandled(family: string | null, action: string | null): boolean {
    if (!family || !action) return false;
    if (family === "deposits") return KNOWN_DEPOSIT_ACTIONS.has(action);
    if (family === "payouts") return KNOWN_PAYOUT_ACTIONS.has(action);
    return false;
  }

  /**
   * Write the delivery down, or report it as one we have already seen.
   *
   * The duplicate check is a real query rather than a caught constraint
   * violation, because the unique index is partial: a payload with no intent
   * id or no tx hash — an expiry, for instance — has no natural key and the
   * index does not cover it. Relying on the constraint alone would let those
   * through silently.
   */
  async record(
    subject: string,
    payload: Record<string, any>,
  ): Promise<RecordedEvent> {
    const { family, network, action } = this.parseSubject(subject);

    if (!this.isHandled(family, action)) {
      // Not an error: subscribing with a wildcard is more maintainable than
      // enumerating subjects, and the cost is dropping what we do not handle.
      this.logger.debug(`[21pay] ignoring unhandled subject ${subject}`);
      return { event: null, duplicate: false };
    }

    const pay21IntentId =
      payload?.intent_id ?? payload?.intentId ?? payload?.id ?? null;
    const txHash = payload?.tx_hash ?? payload?.txHash ?? null;

    if (pay21IntentId && txHash) {
      const seen = await this.eventRepo.findOne({
        where: { eventAction: action!, pay21IntentId, txHash },
      });
      if (seen) {
        this.logger.log(
          `[21pay] duplicate ${action} for intent ${pay21IntentId}, ignoring`,
        );
        return { event: seen, duplicate: true };
      }
    }

    const event = await this.eventRepo.save(
      this.eventRepo.create({
        subject,
        eventAction: action!,
        network: network ?? payload?.network ?? null,
        pay21IntentId,
        txHash,
        amount: payload?.amount != null ? String(payload.amount) : null,
        currency: payload?.currency ?? null,
        rawPayload: payload,
      }),
    );

    return { event, duplicate: false };
  }

  async markProcessed(id: string, error?: string): Promise<void> {
    await this.eventRepo.update(
      { id },
      { processedAt: new Date(), processError: error?.slice(0, 512) ?? null },
    );
  }

  /**
   * Deliveries recorded but never processed.
   *
   * Anything older than ten minutes is a stuck deposit with a user waiting,
   * and since 21Pay has no replay this is the only place it shows up.
   */
  async stuck(olderThanMinutes = 10): Promise<CryptoWebhookEvent[]> {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
    return this.eventRepo
      .createQueryBuilder("e")
      .where("e.processedAt IS NULL")
      .andWhere("e.receivedAt < :cutoff", { cutoff })
      .orderBy("e.receivedAt", "ASC")
      .take(100)
      .getMany();
  }
}
