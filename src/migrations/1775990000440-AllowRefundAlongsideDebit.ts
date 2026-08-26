import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Let a payment carry both its debit and its refund.
 *
 * `transactions.paymentId` was created `UNIQUE` (see
 * 1711100000006-CreateTransactionsTable). That is the right guard for a
 * deposit — one payment must not be credited twice — but it silently made
 * refunds impossible: reversing a withdrawal means writing a second row
 * against the same `paymentId`, which violates the constraint. The insert
 * throws, the surrounding transaction rolls back, and the user keeps the
 * debit with no credit.
 *
 * The effect was total. Across every DK payout to date the ledger holds not
 * one refund row — not because none were warranted, but because none could
 * ever be written. `confirmWithdrawal`'s failure branch and the withdrawal
 * reconciler both depend on this working.
 *
 * Replacing it with `UNIQUE (paymentId, type)` keeps the original guarantee —
 * still one `deposit` per payment, still one `refund` per payment — while
 * allowing the debit/refund pair. It is a relaxation, so no existing row can
 * conflict with it.
 *
 * The original constraint is unnamed in the DDL, so Postgres named it; this
 * looks it up by definition rather than guessing at `transactions_paymentId_key`.
 */
export class AllowRefundAlongsideDebit1775990000440
  implements MigrationInterface
{
  name = "AllowRefundAlongsideDebit1775990000440";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop whichever single-column UNIQUE on "paymentId" this database has.
    const existing: { conname: string }[] = await queryRunner.query(`
      SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_attribute att
        ON att.attrelid = rel.oid AND att.attnum = ANY (con.conkey)
      WHERE rel.relname = 'transactions'
        AND con.contype  = 'u'
        AND array_length(con.conkey, 1) = 1
        AND att.attname  = 'paymentId'
    `);
    for (const { conname } of existing) {
      await queryRunner.query(
        `ALTER TABLE "transactions" DROP CONSTRAINT "${conname}"`,
      );
    }

    // Same guarantee, scoped per ledger entry type.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_transactions_payment_type"
        ON "transactions" ("paymentId", "type")
        WHERE "paymentId" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_transactions_payment_type"`,
    );
    // Restoring the old constraint fails if any payment now holds a pair,
    // which is the point: it cannot be restored once refunds exist.
    await queryRunner.query(
      `ALTER TABLE "transactions" ADD CONSTRAINT "transactions_paymentId_key" UNIQUE ("paymentId")`,
    );
  }
}
