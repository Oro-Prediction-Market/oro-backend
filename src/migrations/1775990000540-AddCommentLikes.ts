import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Likes on market comments.
 *
 * A separate migration rather than an extension of CreateMarketComments: that
 * one creates the table, so re-running it means dropping every comment in the
 * database. Adding to it was fine while the feature had no data worth keeping.
 */
export class AddCommentLikes1775990000540 implements MigrationInterface {
  name = "AddCommentLikes1775990000540";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "market_comments"
        ADD COLUMN IF NOT EXISTS "likeCount" INTEGER NOT NULL DEFAULT 0
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "market_comment_likes" (
        "id"        UUID        NOT NULL DEFAULT gen_random_uuid(),
        "commentId" UUID        NOT NULL,
        "userId"    UUID        NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_market_comment_likes" PRIMARY KEY ("id"),
        -- One like per person. The service relies on this rejecting a
        -- duplicate rather than reading first, which would race on a double tap.
        CONSTRAINT "UQ_comment_like" UNIQUE ("commentId", "userId"),
        CONSTRAINT "FK_market_comment_likes_comment"
          FOREIGN KEY ("commentId") REFERENCES "market_comments"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_market_comment_likes_user"
          FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    // "Which of these comments have I liked?" — one query per thread page.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_market_comment_likes_commentId" ON "market_comment_likes" ("commentId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_market_comment_likes_userId" ON "market_comment_likes" ("userId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_market_comment_likes_userId"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_market_comment_likes_commentId"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "market_comment_likes"`);
    await queryRunner.query(
      `ALTER TABLE "market_comments" DROP COLUMN IF EXISTS "likeCount"`,
    );
  }
}
