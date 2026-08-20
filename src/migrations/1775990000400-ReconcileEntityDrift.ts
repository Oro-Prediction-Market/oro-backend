import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Bring the migration-built schema back in line with the entities.
 *
 * Four columns and one enum value are declared on entities, used by running
 * code, and created by no migration. Production has them — almost certainly
 * from a historical `DB_SYNCHRONIZE` run — which is exactly why the gap went
 * unnoticed: every environment that mattered already had them.
 *
 * A database built purely from migrations does not, and **does not boot**:
 * `outcomes.sortOrder` is read by a startup query, and `markets.groupId` fails
 * a scheduler job every few seconds. Any new staging environment hits this on
 * the first run.
 *
 * Every statement is `IF NOT EXISTS`, so this is a no-op where the columns are
 * already present.
 *
 * Found by diffing entity metadata against a freshly migrated database rather
 * than by reading migrations, which is the only way to catch drift that has
 * accumulated silently. See docs/usdt-oro/BUILD.md.
 */
export class ReconcileEntityDrift1775990000400 implements MigrationInterface {
  name = "ReconcileEntityDrift1775990000400";

  public async up(q: QueryRunner): Promise<void> {
    // Read at startup by the market list query's ORDER BY. Its absence stops
    // the application booting outright.
    await q.query(
      `ALTER TABLE "outcomes" ADD COLUMN IF NOT EXISTS "sortOrder" integer NOT NULL DEFAULT 0`,
    );

    // Grouped political/candidate markets. Absence throws in a scheduled job.
    await q.query(
      `ALTER TABLE "markets" ADD COLUMN IF NOT EXISTS "groupId" uuid`,
    );
    await q.query(
      `ALTER TABLE "markets" ADD COLUMN IF NOT EXISTS "groupTitle" character varying`,
    );
    await q.query(
      `ALTER TABLE "markets" ADD COLUMN IF NOT EXISTS "isFeatured" boolean NOT NULL DEFAULT false`,
    );

    // `TransactionType.SEASON_PRIZE` is written by season.service.ts, but the
    // value was never added to the database enum — so on a migration-built
    // database every season prize payout fails on insert.
    await q.query(
      `ALTER TYPE "transactions_type_enum" ADD VALUE IF NOT EXISTS 'season_prize'`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "markets" DROP COLUMN IF EXISTS "isFeatured"`);
    await q.query(`ALTER TABLE "markets" DROP COLUMN IF EXISTS "groupTitle"`);
    await q.query(`ALTER TABLE "markets" DROP COLUMN IF EXISTS "groupId"`);
    await q.query(`ALTER TABLE "outcomes" DROP COLUMN IF EXISTS "sortOrder"`);
    // Postgres cannot remove an enum value; 'season_prize' survives a revert.
    // Correct rather than an oversight — the alternative is rewriting the type
    // and every column that uses it.
  }
}
