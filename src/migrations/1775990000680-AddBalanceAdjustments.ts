import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Admin balance adjustments: a ledger type of their own, and a record of why.
 *
 * Credits and corrections were written as hand-typed SQL against production,
 * or through an endpoint that recorded them as DEPOSITs — which counted money
 * nobody paid in as money paid in, and kept no reason. An `adjustment` row is
 * platform money moving into (or out of) a wallet with nothing external
 * behind it, and `balance_adjustments` holds who did it and why.
 *
 * The reason lives here and not on the ledger row because the ledger row's
 * note is shown to the customer in their wallet history.
 */
export class AddBalanceAdjustments1775990000680 implements MigrationInterface {
  name = "AddBalanceAdjustments1775990000680";

  public async up(q: QueryRunner): Promise<void> {
    // Not used in this migration's transaction, which is the one thing
    // Postgres forbids for a value added inside one.
    await q.query(
      `ALTER TYPE "transactions_type_enum" ADD VALUE IF NOT EXISTS 'adjustment'`,
    );

    await q.query(`
      CREATE TABLE IF NOT EXISTS "balance_adjustments" (
        "id"            uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId"        uuid NOT NULL,
        "currency"      varchar(10)   NOT NULL,
        "amount"        numeric(20,9) NOT NULL,
        "reason"        varchar(32)   NOT NULL,
        "note"          text          NOT NULL,
        "userNote"      varchar(200)  NOT NULL,
        "reference"     varchar(128),
        "adminId"       uuid          NOT NULL,
        "transactionId" uuid          NOT NULL,
        "requestId"     uuid          NOT NULL,
        "balanceBefore" numeric(20,9) NOT NULL,
        "balanceAfter"  numeric(20,9) NOT NULL,
        "createdAt"     timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT "PK_balance_adjustments" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_balance_adjustments_transaction" UNIQUE ("transactionId"),
        CONSTRAINT "UQ_balance_adjustments_request" UNIQUE ("requestId"),
        CONSTRAINT "CHK_balance_adjustments_nonzero" CHECK ("amount" <> 0),
        CONSTRAINT "FK_balance_adjustments_user" FOREIGN KEY ("userId")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_balance_adjustments_user"
         ON "balance_adjustments" ("userId", "createdAt")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_balance_adjustments_created"
         ON "balance_adjustments" ("createdAt")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "balance_adjustments"`);
    // Postgres cannot remove an enum value; 'adjustment' survives a revert.
  }
}
