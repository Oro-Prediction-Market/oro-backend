import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateMarketComments1775990000530 implements MigrationInterface {
  name = "CreateMarketComments1775990000530";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "market_comment_flags_reason_enum"
        AS ENUM ('spam', 'abuse', 'misinformation', 'other')
    `);

    await queryRunner.query(`
      CREATE TABLE "market_comments" (
        "id"            UUID        NOT NULL DEFAULT gen_random_uuid(),
        "marketId"      UUID        NOT NULL,
        "userId"        UUID        NOT NULL,
        "parentId"      UUID,
        "body"          TEXT        NOT NULL,
        "deletedAt"     TIMESTAMPTZ,
        "deletedBy"     VARCHAR(16),
        "deletedReason" TEXT,
        "flagCount"     INTEGER     NOT NULL DEFAULT 0,
        "replyCount"    INTEGER     NOT NULL DEFAULT 0,
        -- Millisecond precision: this column is the pagination cursor, and a
        -- JS ISO string cannot carry the microseconds now() would otherwise
        -- store. See the note on the entity.
        "createdAt"     TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
        -- Set the first time the author rewrites the comment; drives the
        -- "edited" marker. Never the edit deadline — that comes off
        -- "createdAt", so an edit cannot extend its own window.
        "editedAt"      TIMESTAMPTZ,
        CONSTRAINT "PK_market_comments" PRIMARY KEY ("id"),
        CONSTRAINT "FK_market_comments_market"
          FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_market_comments_user"
          FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_market_comments_parent"
          FOREIGN KEY ("parentId") REFERENCES "market_comments"("id") ON DELETE CASCADE
      )
    `);
    // The thread query's exact shape: one market's comments, newest first.
    await queryRunner.query(
      `CREATE INDEX "IDX_market_comments_market_created" ON "market_comments" ("marketId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_market_comments_userId" ON "market_comments" ("userId")`,
    );
    // Replies are fetched by parent, and the top-level list filters on
    // parentId IS NULL — both go through this index.
    await queryRunner.query(
      `CREATE INDEX "IDX_market_comments_parentId" ON "market_comments" ("parentId")`,
    );

    await queryRunner.query(`
      CREATE TABLE "market_comment_flags" (
        "id"        UUID        NOT NULL DEFAULT gen_random_uuid(),
        "commentId" UUID        NOT NULL,
        "userId"    UUID        NOT NULL,
        "reason"    "market_comment_flags_reason_enum" NOT NULL DEFAULT 'other',
        "note"      TEXT,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_market_comment_flags" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_comment_flag" UNIQUE ("commentId", "userId"),
        CONSTRAINT "FK_comment_flags_comment"
          FOREIGN KEY ("commentId") REFERENCES "market_comments"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_comment_flags_user"
          FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_comment_flags_commentId" ON "market_comment_flags" ("commentId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_comment_flags_userId" ON "market_comment_flags" ("userId")`,
    );

    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "commentsBlockedUntil" TIMESTAMPTZ`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "commentsBlockedUntil"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "market_comment_flags"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "market_comments"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "market_comment_flags_reason_enum"`,
    );
  }
}
