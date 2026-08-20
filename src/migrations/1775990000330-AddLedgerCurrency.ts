import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds currency to the ledger and to the account.
 *
 * Balances in Oro are derived — `SUM(amount)` over `transactions`, with no
 * balance column anywhere. Without a currency on each row there is no way to
 * ask for "spendable ngultrum" as distinct from "everything this user holds",
 * so the first USDT row would silently inflate every BTN balance in the system.
 *
 * This migration only adds the column. Scoping the 48 queries that read it is
 * a separate change, gated by `ledger-currency-guard.spec.ts`.
 *
 * Both columns backfill to 'BTN' and are NOT NULL, so every existing
 * `SUM(amount)` keeps returning exactly the number it returned before.
 *
 * See docs/usdt-oro/STAGE-B-LEDGER-SEGREGATION.md.
 */
export class AddLedgerCurrency1775990000330 implements MigrationInterface {
  name = "AddLedgerCurrency1775990000330";

  public async up(q: QueryRunner): Promise<void> {
    // Postgres 12+ permits ALTER TYPE ... ADD VALUE inside a transaction so
    // long as the new value is not *used* in the same transaction. We only add.
    //
    // Named `usdt`, not `usdt_trc20`: four chains are planned, and a payment
    // method should not name one of them. The network belongs on the intent
    // row. Postgres cannot remove an enum value, so this is the only moment
    // the choice is free.
    await q.query(
      `ALTER TYPE "payments_method_enum" ADD VALUE IF NOT EXISTS 'usdt'`,
    );

    // ── transactions.currency ────────────────────────────────────────────────
    await q.query(
      `ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "currency" varchar(10)`,
    );
    await q.query(
      `UPDATE "transactions" SET "currency" = 'BTN' WHERE "currency" IS NULL`,
    );
    await q.query(
      `ALTER TABLE "transactions" ALTER COLUMN "currency" SET DEFAULT 'BTN'`,
    );
    await q.query(
      `ALTER TABLE "transactions" ALTER COLUMN "currency" SET NOT NULL`,
    );

    // Every balance read is (userId, currency) — composite, not currency alone.
    // Also declared on the Transaction entity: DB_SYNCHRONIZE runs TypeORM
    // synchronize at boot and drops any index absent from entity metadata.
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_transactions_user_currency"
         ON "transactions" ("userId", "currency")`,
    );

    // ── users.currency ───────────────────────────────────────────────────────
    // The account's currency, fixed at creation. There is deliberately no
    // application code path that updates it; that absence is what guarantees a
    // user cannot cross between the BTN and USDT books.
    await q.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "currency" varchar(10)`,
    );
    await q.query(
      `UPDATE "users" SET "currency" = 'BTN' WHERE "currency" IS NULL`,
    );
    await q.query(
      `ALTER TABLE "users" ALTER COLUMN "currency" SET DEFAULT 'BTN'`,
    );
    await q.query(`ALTER TABLE "users" ALTER COLUMN "currency" SET NOT NULL`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "currency"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_transactions_user_currency"`);
    await q.query(
      `ALTER TABLE "transactions" DROP COLUMN IF EXISTS "currency"`,
    );
    // Postgres cannot remove a value from an enum type, so 'usdt' survives a
    // revert. Correct, not an oversight: dropping it would require rewriting
    // the type and every column that uses it.
  }
}
