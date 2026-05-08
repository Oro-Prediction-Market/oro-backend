import { MigrationInterface, QueryRunner } from "typeorm";

export class AddProcessingToPaymentStatusEnum1775990000050
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "payments_status_enum" ADD VALUE IF NOT EXISTS 'processing'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL does not support removing enum values directly.
    // Recreate the enum without 'processing' and migrate existing rows.
    await queryRunner.query(
      `UPDATE "payments" SET "status" = 'pending' WHERE "status" = 'processing'`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ALTER COLUMN "status" TYPE text`,
    );
    await queryRunner.query(`DROP TYPE "payments_status_enum"`);
    await queryRunner.query(
      `CREATE TYPE "payments_status_enum" AS ENUM ('pending', 'success', 'failed', 'cancelled')`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ALTER COLUMN "status" TYPE "payments_status_enum" USING "status"::"payments_status_enum"`,
    );
  }
}
