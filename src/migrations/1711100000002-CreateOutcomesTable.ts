import type { MigrationInterface, QueryRunner } from "typeorm";

export class CreateOutcomesTable1711100000002 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "outcomes" (
        "id"              uuid              NOT NULL DEFAULT uuid_generate_v4(),
        "label"           character varying NOT NULL,
        "imageUrl"        character varying,
        "totalBetAmount"  numeric(18,2)     NOT NULL DEFAULT 0,
        "currentOdds"     numeric(10,4)     NOT NULL DEFAULT 0,
        "lmsrProbability" numeric(10,6)     NOT NULL DEFAULT 0,
        "isWinner"        boolean           NOT NULL DEFAULT false,
        "marketId"        uuid              NOT NULL,
        CONSTRAINT "PK_outcomes" PRIMARY KEY ("id"),
        CONSTRAINT "FK_outcomes_marketId" FOREIGN KEY ("marketId") REFERENCES "markets" ("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_outcomes_marketId" ON "outcomes" ("marketId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "outcomes"`);
  }
}
