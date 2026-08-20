import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * USDT withdrawals over the 21Pay merchant rail.
 *
 * Two tables, and both exist because 21Pay's controls and ours answer
 * different questions. Theirs protect the tenant float — whitelisting,
 * cooldown, velocity, maker-checker — and know nothing about which of our users
 * is entitled to what. Ours decide whose money it is.
 *
 * There is no `key_handle` and no `from_address` anywhere here: `POST
 * /v1/payouts` is operator-only and we are never meant to name a wallet.
 *
 * See docs/usdt-oro/STAGE-F-WITHDRAWALS.md.
 */
export class CreateCryptoWithdrawals1775990000390
  implements MigrationInterface
{
  name = "CreateCryptoWithdrawals1775990000390";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // ── Destinations ─────────────────────────────────────────────────────────
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "crypto_withdrawal_destinations_status_enum"
          AS ENUM ('cooldown','active','disabled');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "crypto_withdrawal_destinations" (
        "id"                 uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId"             uuid NOT NULL,
        "pay21DestinationId" varchar(64),
        "network"            varchar(16) NOT NULL,
        "address"            varchar(128) NOT NULL,
        "label"              varchar(64),
        "status"             "crypto_withdrawal_destinations_status_enum"
                             NOT NULL DEFAULT 'cooldown',
        "usableAt"           timestamptz,
        "createdAt"          TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt"          TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_crypto_withdrawal_destinations" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_crypto_dest_user_network_address"
          UNIQUE ("userId", "network", "address"),
        CONSTRAINT "FK_crypto_dest_user" FOREIGN KEY ("userId")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_crypto_dest_user"
         ON "crypto_withdrawal_destinations" ("userId")`,
    );

    // ── Withdrawals ──────────────────────────────────────────────────────────
    // Our approval is separate from 21Pay's: theirs asks "is the tenant allowed
    // to move this much", ours asks "is this user entitled to it".
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "crypto_withdrawals_approval_enum"
          AS ENUM ('pending_approval','approved','rejected');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "crypto_withdrawals" (
        "id"                  uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId"              uuid NOT NULL,
        "destinationId"       uuid NOT NULL,
        "pay21WithdrawalId"   varchar(64),
        "network"             varchar(16) NOT NULL,
        "amountUsdt"          numeric(28,9) NOT NULL,
        "approvalStatus"      "crypto_withdrawals_approval_enum"
                              NOT NULL DEFAULT 'pending_approval',
        "remoteStatus"        varchar(32),
        "debitTransactionId"  uuid,
        "restoreTransactionId" uuid,
        "txHash"              varchar(128),
        "failureReason"       varchar(255),
        -- Set when 21Pay reports failure but a tx hash exists, so we cannot
        -- know whether the money moved. Never auto-restored.
        "needsManualReview"   boolean NOT NULL DEFAULT false,
        "approvedBy"          uuid,
        "approvedAt"          timestamptz,
        "rejectionReason"     varchar(255),
        "completedAt"         timestamptz,
        "idempotencyKey"      varchar(128) NOT NULL,
        "createdAt"           TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt"           TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_crypto_withdrawals" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_crypto_withdrawals_idempotency" UNIQUE ("idempotencyKey"),
        CONSTRAINT "UQ_crypto_withdrawals_pay21_id" UNIQUE ("pay21WithdrawalId"),
        CONSTRAINT "FK_crypto_withdrawals_user" FOREIGN KEY ("userId")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_crypto_withdrawals_destination" FOREIGN KEY ("destinationId")
          REFERENCES "crypto_withdrawal_destinations"("id")
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_crypto_withdrawals_user"
         ON "crypto_withdrawals" ("userId")`,
    );
    // The approval queue, oldest first.
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_crypto_withdrawals_approval"
         ON "crypto_withdrawals" ("approvalStatus", "createdAt")`,
    );
    // The poller: anything submitted but not yet terminal.
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_crypto_withdrawals_remote"
         ON "crypto_withdrawals" ("remoteStatus")`,
    );
    // The alert: withdrawals stuck in review.
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_crypto_withdrawals_review"
         ON "crypto_withdrawals" ("needsManualReview")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "crypto_withdrawals"`);
    await q.query(`DROP TYPE IF EXISTS "crypto_withdrawals_approval_enum"`);
    await q.query(`DROP TABLE IF EXISTS "crypto_withdrawal_destinations"`);
    await q.query(
      `DROP TYPE IF EXISTS "crypto_withdrawal_destinations_status_enum"`,
    );
  }
}
