import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSuggestionAutoPromotion1775990000520
  implements MigrationInterface
{
  async up(q: QueryRunner): Promise<void> {
    // New enum member. ADD VALUE IF NOT EXISTS is idempotent and cannot run
    // inside a transaction block on older PG, so it goes first and alone.
    await q.query(`
      ALTER TYPE "market_suggestions_status_enum" ADD VALUE IF NOT EXISTS 'queued'
    `);
    await q.query(`
      ALTER TABLE "market_suggestions"
        ADD COLUMN IF NOT EXISTS "promotedAt" TIMESTAMP WITH TIME ZONE
    `);
    // The public "questions the crowd wants answered" list.
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_market_suggestions_promotedAt"
        ON "market_suggestions" ("promotedAt")
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_market_suggestions_promotedAt"`);
    await q.query(
      `ALTER TABLE "market_suggestions" DROP COLUMN IF EXISTS "promotedAt"`,
    );
    // Postgres cannot drop a single enum value; 'queued' is left in place.
    // Harmless: nothing reads it once the column and code are gone.
  }
}
