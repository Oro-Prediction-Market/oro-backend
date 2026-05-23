import { MigrationInterface, QueryRunner } from "typeorm";

export class AddDailyMarketCategory1775990000150 implements MigrationInterface {
  name = "AddDailyMarketCategory1775990000150";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Postgres ALTER TYPE … ADD VALUE is idempotent-safe with IF NOT EXISTS (Postgres 9.6+)
    await queryRunner.query(`
      ALTER TYPE "public"."markets_category_enum" ADD VALUE IF NOT EXISTS 'daily';
    `);

    // Backfill existing TER and BTC auto-markets to the new category
    await queryRunner.query(`
      UPDATE markets
      SET category = 'daily'
      WHERE "externalSource" IN ('ter', 'btc')
        AND category != 'daily';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Revert backfilled rows — Postgres does not support removing enum values,
    // so the enum value itself is left in place.
    await queryRunner.query(`
      UPDATE markets
      SET category = 'economy'
      WHERE "externalSource" IN ('ter', 'btc')
        AND category = 'daily';
    `);
  }
}
