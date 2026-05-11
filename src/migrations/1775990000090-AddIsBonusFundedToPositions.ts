import { MigrationInterface, QueryRunner } from "typeorm";

export class AddIsBonusFundedToPositions1775990000090 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE positions
      ADD COLUMN IF NOT EXISTS "isBonusFunded" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE positions
      DROP COLUMN IF EXISTS "isBonusFunded"
    `);
  }
}
