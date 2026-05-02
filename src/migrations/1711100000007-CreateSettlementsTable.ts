import type { MigrationInterface, QueryRunner } from "typeorm";

export class CreateSettlementsTable1711100000007 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "settlements" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "marketId" uuid NOT NULL,
        "winningOutcomeId" uuid NOT NULL,
        "totalBets" integer NOT NULL DEFAULT 0,
        "winningBets" integer NOT NULL DEFAULT 0,
        "totalPool" numeric(18,2) NOT NULL DEFAULT 0,
        "houseAmount" numeric(18,2) NOT NULL DEFAULT 0,
        "payoutPool" numeric(18,2) NOT NULL DEFAULT 0,
        "totalPaidOut" numeric(18,2) NOT NULL DEFAULT 0,
        "settledAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_settlements" PRIMARY KEY ("id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "settlements"`);
  }
}
