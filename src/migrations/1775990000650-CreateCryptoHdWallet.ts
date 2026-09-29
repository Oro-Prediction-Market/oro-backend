import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Single HD wallet: permanent per-customer deposit addresses, and one row per
 * deposit credited to them.
 *
 * New tables only. The invoice tables (`crypto_payment_intents`) are left
 * untouched so the live invoice flow cannot regress.
 *
 * See docs/usdt-oro/STAGE-J-HD-WALLET.md §4.1.
 */
export class CreateCryptoHdWallet1775990000650 implements MigrationInterface {
  name = "CreateCryptoHdWallet1775990000650";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "crypto_deposit_addresses" (
        "id"        uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId"    uuid NOT NULL,
        "network"   varchar(16)  NOT NULL,
        "address"   varchar(128) NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_crypto_deposit_addresses" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_crypto_deposit_addresses_user_network" UNIQUE ("userId", "network"),
        CONSTRAINT "UQ_crypto_deposit_addresses_network_address" UNIQUE ("network", "address"),
        CONSTRAINT "FK_crypto_deposit_addresses_user" FOREIGN KEY ("userId")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "crypto_hd_deposits" (
        "id"             uuid NOT NULL DEFAULT uuid_generate_v4(),
        "pay21IntentId"  varchar(64)  NOT NULL,
        "userId"         uuid,
        "network"        varchar(16)  NOT NULL,
        "depositAddress" varchar(128),
        "amountUsdt"     decimal(28,9) NOT NULL,
        "txHash"         varchar(128),
        "blockNumber"    bigint,
        "paymentId"      uuid,
        "transactionId"  uuid,
        "needsReview"    boolean NOT NULL DEFAULT false,
        "reviewReason"   varchar(64),
        "creditedAt"     timestamptz,
        "createdAt"      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_crypto_hd_deposits" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_crypto_hd_deposits_pay21_intent" UNIQUE ("pay21IntentId")
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_crypto_hd_deposits_user"
         ON "crypto_hd_deposits" ("userId", "createdAt")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_crypto_hd_deposits_review"
         ON "crypto_hd_deposits" ("needsReview")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "crypto_hd_deposits"`);
    await q.query(`DROP TABLE IF EXISTS "crypto_deposit_addresses"`);
  }
}
