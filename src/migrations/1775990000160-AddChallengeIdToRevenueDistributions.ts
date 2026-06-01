import { MigrationInterface, QueryRunner } from "typeorm";

export class AddChallengeIdToRevenueDistributions1775990000160 implements MigrationInterface {
  name = "AddChallengeIdToRevenueDistributions1775990000160";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Allow null so duel distributions have no marketId / settlementId
    await queryRunner.query(`ALTER TABLE "revenue_distributions" ALTER COLUMN "marketId" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "revenue_distributions" ALTER COLUMN "settlementId" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "revenue_distributions" ADD COLUMN "challengeId" uuid`);
    await queryRunner.query(`CREATE INDEX "IDX_revenue_distributions_challengeId" ON "revenue_distributions" ("challengeId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_revenue_distributions_challengeId"`);
    await queryRunner.query(`ALTER TABLE "revenue_distributions" DROP COLUMN "challengeId"`);
    await queryRunner.query(`ALTER TABLE "revenue_distributions" ALTER COLUMN "settlementId" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "revenue_distributions" ALTER COLUMN "marketId" SET NOT NULL`);
  }
}
