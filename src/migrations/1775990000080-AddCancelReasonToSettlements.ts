import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCancelReasonToSettlements1775990000080
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "settlements" ADD COLUMN IF NOT EXISTS "cancelReason" varchar(32) NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "settlements" DROP COLUMN IF EXISTS "cancelReason"`,
    );
  }
}
