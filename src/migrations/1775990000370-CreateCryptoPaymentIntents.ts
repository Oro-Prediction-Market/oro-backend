import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateCryptoPaymentIntents1775990000370
  implements MigrationInterface
{
  name = "CreateCryptoPaymentIntents1775990000370";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "crypto_payment_intents_status_enum" AS ENUM (
          'awaiting_deposit','confirming','accepted','confirmed',
          'confirmed_partial','confirmed_overpaid','completed_via_topup',
          'expired','failed'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "crypto_payment_intents" (
        "id"                 uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId"             uuid NOT NULL,
        "paymentId"          uuid,
        "pay21IntentId"      varchar(64) NOT NULL,
        "network"            varchar(16) NOT NULL,
        "depositAddress"     varchar(128) NOT NULL,
        "derivationIndex"    integer,
        "amountUsdt"         numeric(28,9) NOT NULL,
        "detectedAmountUsdt" numeric(28,9),
        "status"             "crypto_payment_intents_status_enum" NOT NULL
                             DEFAULT 'awaiting_deposit',
        "parentIntentId"     varchar(64),
        "transactionId"      uuid,
        "creditedAt"         timestamptz,
        "idempotencyKey"     varchar(128) NOT NULL,
        "expiresAt"          timestamptz NOT NULL,
        "txHash"             varchar(128),
        "blockNumber"        bigint,
        "failureReason"      varchar(255),
        "metadata"           jsonb,
        "createdAt"          TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt"          TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_crypto_payment_intents" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_crypto_intents_pay21_id" UNIQUE ("pay21IntentId"),
        CONSTRAINT "UQ_crypto_intents_idempotency" UNIQUE ("idempotencyKey"),
        CONSTRAINT "FK_crypto_intents_user" FOREIGN KEY ("userId")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    // The pending-deposit list a user polls.
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_crypto_intents_user_status"
         ON "crypto_payment_intents" ("userId", "status")`,
    );
    // The expiry sweeper and the reconciliation poller.
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_crypto_intents_status_expires"
         ON "crypto_payment_intents" ("status", "expiresAt")`,
    );
    // Reorg re-polling: everything credited inside the window.
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_crypto_intents_credited_at"
         ON "crypto_payment_intents" ("creditedAt")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_crypto_intents_deposit_address"
         ON "crypto_payment_intents" ("depositAddress")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "crypto_payment_intents"`);
    await q.query(`DROP TYPE IF EXISTS "crypto_payment_intents_status_enum"`);
  }
}
