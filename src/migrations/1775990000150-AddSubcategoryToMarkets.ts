import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSubcategoryToMarkets1775990000150 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "markets"
      ADD COLUMN IF NOT EXISTS "subcategory" character varying NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "markets"
      DROP COLUMN IF EXISTS "subcategory";
    `);
  }
}
