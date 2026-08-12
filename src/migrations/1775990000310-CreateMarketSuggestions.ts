import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateMarketSuggestions1775990000310
  implements MigrationInterface
{
  name = "CreateMarketSuggestions1775990000310";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "market_suggestions_status_enum"
        AS ENUM ('pending', 'approved', 'rejected', 'created')
    `);

    await queryRunner.query(`
      CREATE TABLE "market_suggestions" (
        "id"                   UUID        NOT NULL DEFAULT gen_random_uuid(),
        "userId"               UUID        NOT NULL,
        "title"                VARCHAR(200) NOT NULL,
        "description"          TEXT,
        "category"             "markets_category_enum" NOT NULL DEFAULT 'other',
        "status"               "market_suggestions_status_enum" NOT NULL DEFAULT 'pending',
        "voteCount"            INTEGER     NOT NULL DEFAULT 0,
        "marketId"             UUID,
        "reviewedByTelegramId" VARCHAR,
        "reviewedAt"           TIMESTAMPTZ,
        "createdAt"            TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_market_suggestions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_market_suggestions_user"
          FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_market_suggestions_market"
          FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_market_suggestions_userId" ON "market_suggestions" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_market_suggestions_status_votes" ON "market_suggestions" ("status", "voteCount")`,
    );

    await queryRunner.query(`
      CREATE TABLE "market_suggestion_votes" (
        "id"           UUID        NOT NULL DEFAULT gen_random_uuid(),
        "suggestionId" UUID        NOT NULL,
        "userId"       UUID        NOT NULL,
        "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_market_suggestion_votes" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_suggestion_vote" UNIQUE ("suggestionId", "userId"),
        CONSTRAINT "FK_suggestion_votes_suggestion"
          FOREIGN KEY ("suggestionId") REFERENCES "market_suggestions"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_suggestion_votes_user"
          FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_suggestion_votes_suggestionId" ON "market_suggestion_votes" ("suggestionId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_suggestion_votes_userId" ON "market_suggestion_votes" ("userId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "market_suggestion_votes"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "market_suggestions"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "market_suggestions_status_enum"`,
    );
  }
}
