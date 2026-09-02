import { MigrationInterface, QueryRunner } from "typeorm";

export class AddNotifiedAchievementsToUsers1775990000460
  implements MigrationInterface
{
  async up(q: QueryRunner): Promise<void> {
    // Additive only: one nullable jsonb column on `users`, defaulted to '[]'.
    // Mirrors AddFeaturedAchievementsToUsers. Touches no other table.
    await q.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "notifiedAchievementIds" jsonb NOT NULL DEFAULT '[]'`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "notifiedAchievementIds"`,
    );
  }
}
