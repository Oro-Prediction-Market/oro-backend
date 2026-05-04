import { MigrationInterface, QueryRunner } from "typeorm";

export class AddBonusRealPayoutRemaining1775990000030
  implements MigrationInterface
{
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "bonusRealPayoutRemaining" numeric(18,2) NOT NULL DEFAULT 50
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "bonusRealPayoutRemaining"
    `);
  }
}
