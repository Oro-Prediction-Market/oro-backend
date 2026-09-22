import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Marks a revenue distribution whose DK transfer is at the bank but unsettled.
 *
 * `processAllPending` sends every PENDING row as ONE combined transfer. When DK
 * answered with anything other than `0000` it wrote nothing at all, so the rows
 * stayed PENDING and the next admin click re-sent the whole batch — while the
 * first transfer was still validating. On the new core that is the normal
 * answer, not an edge case, so the batch was one click away from paying the
 * platform fee twice.
 *
 * A row holding a reference is off-limits to both transfer paths until the
 * resolver has asked DK what happened. NULL means free to send, which is what
 * every existing row correctly is.
 */
export class AddPendingTransferRefToRevenueDistributions1775990000630
  implements MigrationInterface
{
  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "revenue_distributions"
         ADD COLUMN IF NOT EXISTS "pendingTransferRef" varchar(100)`,
    );

    // The resolver sweeps on exactly this predicate, and the two send paths
    // filter on it. Partial, because the rows of interest are the rare ones.
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_revenue_distributions_pendingTransferRef"
         ON "revenue_distributions" ("pendingTransferRef")
       WHERE "pendingTransferRef" IS NOT NULL`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(
      `DROP INDEX IF EXISTS "IDX_revenue_distributions_pendingTransferRef"`,
    );
    await q.query(
      `ALTER TABLE "revenue_distributions"
         DROP COLUMN IF EXISTS "pendingTransferRef"`,
    );
  }
}
