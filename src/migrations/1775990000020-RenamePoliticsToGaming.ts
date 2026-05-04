import { MigrationInterface, QueryRunner } from "typeorm";

export class RenamePoliticsToGaming1775990000020 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "markets_category_enum" RENAME VALUE 'politics' TO 'gaming';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "markets_category_enum" RENAME VALUE 'gaming' TO 'politics';
    `);
  }
}
