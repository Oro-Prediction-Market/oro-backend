import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateRevenueDistributions1775990000140 implements MigrationInterface {
  name = "CreateRevenueDistributions1775990000140";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "revenue_distribution_status_enum" AS ENUM ('pending', 'completed', 'failed')
    `);
    await queryRunner.query(`
      CREATE TABLE "revenue_distributions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "marketId" uuid NOT NULL,
        "settlementId" uuid NOT NULL,
        "amount" decimal(18,2) NOT NULL,
        "houseEdgePct" decimal(5,2) NOT NULL,
        "totalPool" decimal(18,2) NOT NULL,
        "publicAccountNo" varchar(50) NOT NULL,
        "status" "revenue_distribution_status_enum" NOT NULL DEFAULT 'pending',
        "paymentReference" varchar(100),
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "paidAt" TIMESTAMP,
        CONSTRAINT "PK_revenue_distributions" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_revenue_distributions_marketId" ON "revenue_distributions" ("marketId")`);
    await queryRunner.query(`CREATE INDEX "IDX_revenue_distributions_settlementId" ON "revenue_distributions" ("settlementId")`);
    await queryRunner.query(`CREATE INDEX "IDX_revenue_distributions_status" ON "revenue_distributions" ("status")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "revenue_distributions"`);
    await queryRunner.query(`DROP TYPE "revenue_distribution_status_enum"`);
  }
}
