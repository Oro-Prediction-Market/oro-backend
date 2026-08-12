import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Two-sided resolution contest:
 *  - disputes.side       → OBJECT (challenges the proposal) | SUPPORT (defends it)
 *  - markets.disputeBondAmount → per-head bond set by the first objector; every
 *    later participant matches it. Null until the first objection is filed.
 */
export class AddDisputeSideAndBondAmount1775990000200
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "disputes_side_enum" AS ENUM ('object', 'support');
      EXCEPTION WHEN duplicate_object THEN null;
      END $$;
    `);
    await queryRunner.query(`
      ALTER TABLE "disputes"
      ADD COLUMN IF NOT EXISTS "side" "disputes_side_enum" NOT NULL DEFAULT 'object';
    `);
    await queryRunner.query(`
      ALTER TABLE "markets"
      ADD COLUMN IF NOT EXISTS "disputeBondAmount" numeric(18,2);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "markets" DROP COLUMN IF EXISTS "disputeBondAmount";
    `);
    await queryRunner.query(`
      ALTER TABLE "disputes" DROP COLUMN IF EXISTS "side";
    `);
    await queryRunner.query(`DROP TYPE IF EXISTS "disputes_side_enum";`);
  }
}
