import { MigrationInterface, QueryRunner } from "typeorm";

export class AddStreakBoostArmedToPositions1775990000190
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "positions"
      ADD COLUMN IF NOT EXISTS "streakBoostArmed" boolean NOT NULL DEFAULT false;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "positions"
      DROP COLUMN IF EXISTS "streakBoostArmed";
    `);
  }
}
