import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Store each snapshot's own outcome pool, so a probability curve can be drawn
 * in the same terms the apps display.
 *
 * `probability` holds the LMSR value. Every screen instead shows the
 * Laplace-smoothed pool share, because LMSR saturates on a lopsided book —
 * a market reading 47% in the outcome row would have plotted as 37% from the
 * stored series. Deriving the share needs this outcome's pool, and the table
 * only had the market-wide total.
 *
 * NULLABLE with no default. 0 is a legitimate pool, so a default would make
 * every pre-existing row claim an empty outcome and produce a confidently
 * wrong curve; NULL lets a reader drop the point as unknown. Adding a nullable
 * column with no default is metadata-only on PG11+, so this does not rewrite
 * the table.
 */
export class AddOutcomePoolToSnapshots1775990000560
  implements MigrationInterface
{
  name = "AddOutcomePoolToSnapshots1775990000560";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "market_probability_snapshots" ADD COLUMN IF NOT EXISTS "outcomePool" numeric(18,2)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drops the column only. The 1775990000500 migration that created this
    // table drops the whole table in its down() — correct for a create,
    // catastrophic to copy here.
    await queryRunner.query(
      `ALTER TABLE "market_probability_snapshots" DROP COLUMN IF EXISTS "outcomePool"`,
    );
  }
}
