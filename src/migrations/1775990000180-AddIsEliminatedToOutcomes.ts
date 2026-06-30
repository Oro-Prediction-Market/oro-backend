import { MigrationInterface, QueryRunner } from "typeorm";

export class AddIsEliminatedToOutcomes1775990000180
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "outcomes"
      ADD COLUMN IF NOT EXISTS "isEliminated" boolean NOT NULL DEFAULT false;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "outcomes"
      DROP COLUMN IF EXISTS "isEliminated";
    `);
  }
}
