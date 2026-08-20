import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

/**
 * One 21Pay webhook delivery, recorded before anything acts on it.
 *
 * There is no delivery-id header to dedup on, and no replay endpoint if we drop
 * one — so this row is both the replay guard and the only route back if
 * processing has a bug. See 21PAY-ANSWERS.md §3.3, §3.5.
 */
@Index("IDX_crypto_webhook_events_intent", ["pay21IntentId"])
@Index("IDX_crypto_webhook_events_unprocessed", ["processedAt", "receivedAt"])
@Entity("crypto_webhook_events")
export class CryptoWebhookEvent {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /**
   * The full NATS subject from `X-T1Pay-Event`, e.g.
   * `payment.tenants.<tid>.deposits.tron.confirmed`. Their docs show a short
   * `deposit.confirmed` label that the engine never sends.
   */
  @Column({ type: "varchar", length: 255 })
  subject: string;

  /** The last segment of the subject: `confirmed`, `expired`, `unexpected`… */
  @Column({ type: "varchar", length: 64 })
  eventAction: string;

  @Column({ type: "varchar", length: 16, nullable: true })
  network: string | null;

  @Column({ type: "varchar", length: 64, nullable: true })
  pay21IntentId: string | null;

  @Column({ type: "varchar", length: 128, nullable: true })
  txHash: string | null;

  /**
   * Base units, exactly as received.
   *
   * Kept as a string on purpose: converting at write time and again at credit
   * time is two chances to be wrong about decimals.
   */
  @Column({ type: "varchar", length: 64, nullable: true })
  amount: string | null;

  @Column({ type: "varchar", length: 8, nullable: true })
  currency: string | null;

  @Column({ type: "jsonb" })
  rawPayload: Record<string, unknown>;

  @CreateDateColumn({ name: "receivedAt" })
  receivedAt: Date;

  /** Null past ten minutes means a stuck deposit with a user waiting. */
  @Column({ type: "timestamptz", nullable: true })
  processedAt: Date | null;

  @Column({ type: "varchar", length: 512, nullable: true })
  processError: string | null;
}
