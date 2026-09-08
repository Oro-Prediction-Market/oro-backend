import { MigrationInterface, QueryRunner } from "typeorm";

export class AddReengagementStageToUsers1775990000490
  implements MigrationInterface
{
  async up(q: QueryRunner): Promise<void> {
    // Additive only: one nullable int column on `users`. Null means "no win-back
    // DM sent since this user was last active", which is the correct starting
    // state for every existing row. Touches no other table.
    await q.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "reengagementStage" integer`,
    );

    // Partial index: the re-engagement cron scans for users who have not yet
    // been messaged at a given milestone. The overwhelming majority of rows are
    // NULL, so index those and let the cron's stage comparison hit it.
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_users_reengagementStage"
         ON "users" ("reengagementStage")`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_users_reengagementStage"`);
    await q.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "reengagementStage"`,
    );
  }
}
