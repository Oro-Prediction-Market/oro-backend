import type { MigrationInterface, QueryRunner } from "typeorm";

export class CreatePositionsTable1711100000004 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "positions_status_enum" AS ENUM ('pending', 'won', 'lost', 'refunded');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "positions" (
        "id"                   uuid                      NOT NULL DEFAULT uuid_generate_v4(),
        "amount"               numeric(18,2)             NOT NULL,
        "status"               positions_status_enum     NOT NULL DEFAULT 'pending',
        "oddsAtPlacement"      numeric(10,4),
        "payout"               numeric(18,2),
        "predictedProbability" numeric(10,6),
        "placedAt"             TIMESTAMP                 NOT NULL DEFAULT now(),
        "poolPctAtBet"         numeric(10,6),
        "userId"               uuid                      NOT NULL,
        "marketId"             uuid                      NOT NULL,
        "outcomeId"            uuid                      NOT NULL,
        CONSTRAINT "PK_positions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_positions_userId"    FOREIGN KEY ("userId")    REFERENCES "users"    ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_positions_marketId"  FOREIGN KEY ("marketId")  REFERENCES "markets"  ("id"),
        CONSTRAINT "FK_positions_outcomeId" FOREIGN KEY ("outcomeId") REFERENCES "outcomes" ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_positions_userId_marketId" ON "positions" ("userId", "marketId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_positions_placedAt" ON "positions" ("placedAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "positions"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "positions_status_enum"`);
  }
}
