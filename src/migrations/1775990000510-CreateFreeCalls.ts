import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateFreeCalls1775990000510 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "free_calls_status_enum" AS ENUM
          ('pending', 'correct', 'incorrect', 'void');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "free_calls" (
        "id"                 uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId"             uuid NOT NULL,
        "marketId"           uuid NOT NULL,
        "outcomeId"          uuid NOT NULL,
        "probabilityAtCall"  numeric(10,6) NOT NULL,
        "status"             "free_calls_status_enum" NOT NULL DEFAULT 'pending',
        "calledAt"           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "resolvedAt"         TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_free_calls" PRIMARY KEY ("id"),
        CONSTRAINT "FK_free_calls_user"    FOREIGN KEY ("userId")    REFERENCES "users"("id")    ON DELETE CASCADE,
        CONSTRAINT "FK_free_calls_market"  FOREIGN KEY ("marketId")  REFERENCES "markets"("id")  ON DELETE CASCADE,
        CONSTRAINT "FK_free_calls_outcome" FOREIGN KEY ("outcomeId") REFERENCES "outcomes"("id") ON DELETE CASCADE
      )
    `);

    // One call per user per market. This unique index — not an application
    // check — is what makes the insert safe under a double-tap.
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_free_calls_user_market"
        ON "free_calls" ("userId", "marketId")
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_free_calls_market_status"
        ON "free_calls" ("marketId", "status")
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_free_calls_user_status"
        ON "free_calls" ("userId", "status")
    `);

    // Free-call accuracy aggregates, kept on the user so the leaderboard and
    // calibration profile do not re-scan every call on each read.
    await q.query(`
      ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "freeCallCount"       integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "freeCallCorrect"     integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "freeCallBrierScore"  numeric(5,4),
        ADD COLUMN IF NOT EXISTS "freeCallBrierCount"  integer NOT NULL DEFAULT 0
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "users"
        DROP COLUMN IF EXISTS "freeCallCount",
        DROP COLUMN IF EXISTS "freeCallCorrect",
        DROP COLUMN IF EXISTS "freeCallBrierScore",
        DROP COLUMN IF EXISTS "freeCallBrierCount"
    `);
    await q.query(`DROP TABLE IF EXISTS "free_calls"`);
    await q.query(`DROP TYPE IF EXISTS "free_calls_status_enum"`);
  }
}
