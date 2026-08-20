import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Durable record of every 21Pay webhook delivery.
 *
 * The table exists for two reasons beyond an audit trail.
 *
 * **Replay protection.** 21Pay sends no delivery-id header of any kind — their
 * docs describe an `X-Request-Id` that the engine never emits. So the dedup key
 * has to be built from the payload: `(eventAction, pay21IntentId, txHash)`,
 * which is exactly what the publisher's own JetStream idempotency key is built
 * from (`<tx_hash>:<kind>`).
 *
 * **Recovery.** There is no replay endpoint on their side either, contrary to
 * their docs. A delivery we drop is gone, so recording it before doing anything
 * with it is the only way to reprocess after a bug.
 *
 * See docs/usdt-oro/21PAY-ANSWERS.md §3.3, §3.5.
 */
export class CreateCryptoWebhookEvents1775990000380
  implements MigrationInterface
{
  name = "CreateCryptoWebhookEvents1775990000380";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "crypto_webhook_events" (
        "id"            uuid NOT NULL DEFAULT uuid_generate_v4(),
        "subject"       varchar(255) NOT NULL,
        "eventAction"   varchar(64)  NOT NULL,
        "network"       varchar(16),
        "pay21IntentId" varchar(64),
        "txHash"        varchar(128),
        "amount"        varchar(64),
        "currency"      varchar(8),
        "rawPayload"    jsonb NOT NULL,
        "receivedAt"    TIMESTAMP NOT NULL DEFAULT now(),
        "processedAt"   timestamptz,
        "processError"  varchar(512),
        CONSTRAINT "PK_crypto_webhook_events" PRIMARY KEY ("id")
      )
    `);

    // The replay guard. Partial, because a payload without an intent id or a
    // tx hash (an expiry, say) has no natural key to dedup on and must not
    // collide with another such event.
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_crypto_webhook_events_natural_key"
        ON "crypto_webhook_events" ("eventAction", "pay21IntentId", "txHash")
        WHERE "pay21IntentId" IS NOT NULL AND "txHash" IS NOT NULL
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_crypto_webhook_events_intent"
         ON "crypto_webhook_events" ("pay21IntentId")`,
    );
    // Drives the "stuck deposit" alert: processedAt still null after 10 minutes.
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_crypto_webhook_events_unprocessed"
         ON "crypto_webhook_events" ("processedAt", "receivedAt")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "crypto_webhook_events"`);
  }
}
