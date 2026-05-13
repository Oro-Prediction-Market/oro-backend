import { MigrationInterface, QueryRunner } from "typeorm";

export class AddStakeAmountToTransactions1775990000100 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE transactions
      ADD COLUMN IF NOT EXISTS "stakeAmount" numeric(20,9) NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE transactions
      DROP COLUMN IF EXISTS "stakeAmount"
    `);
  }
}
