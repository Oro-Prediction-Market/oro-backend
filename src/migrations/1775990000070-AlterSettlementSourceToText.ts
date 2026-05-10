import { MigrationInterface, QueryRunner } from "typeorm";

export class AlterSettlementSourceToText1775990000070
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "markets" ALTER COLUMN "settlementSource" TYPE text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "markets" ALTER COLUMN "settlementSource" TYPE varchar(255)`,
    );
  }
}
