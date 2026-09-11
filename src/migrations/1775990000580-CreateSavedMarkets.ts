import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Saved markets — a user's private bookmarks.
 *
 * Additive only: a new table with no change to `markets` or `users`, so the
 * feature is revertible by reverting code plus this table, and nothing else in
 * the schema depends on it.
 */
export class CreateSavedMarkets1775990000580 implements MigrationInterface {
  name = "CreateSavedMarkets1775990000580";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "saved_markets" (
        "id"        UUID        NOT NULL DEFAULT gen_random_uuid(),
        "userId"    UUID        NOT NULL,
        "marketId"  UUID        NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_saved_markets" PRIMARY KEY ("id"),
        -- Saved once. The service relies on this rejecting the duplicate
        -- rather than reading first, which would race on a double tap.
        CONSTRAINT "UQ_saved_market" UNIQUE ("userId", "marketId"),
        CONSTRAINT "FK_saved_markets_user"
          FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_saved_markets_market"
          FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE
      )
    `);

    // "What have I saved?" — the list page, and the id set the feed hydrates
    // its bookmark icons from. Ordered by save time, newest first.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_saved_markets_user_created" ON "saved_markets" ("userId", "createdAt" DESC)`,
    );
    // The unique constraint already indexes ("userId", "marketId"); this one is
    // for the reverse direction, so deleting a market does not seq-scan.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_saved_markets_marketId" ON "saved_markets" ("marketId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_saved_markets_marketId"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_saved_markets_user_created"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "saved_markets"`);
  }
}
