import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSettlementSourceToMarkets1775990000060
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "markets" ADD COLUMN IF NOT EXISTS "settlementSource" varchar(255) NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "markets" DROP COLUMN IF EXISTS "settlementSource"`,
    );
  }
}
