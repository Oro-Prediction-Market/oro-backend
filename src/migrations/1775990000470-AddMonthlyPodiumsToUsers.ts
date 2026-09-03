import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMonthlyPodiumsToUsers1775990000470
  implements MigrationInterface
{
  async up(q: QueryRunner): Promise<void> {
    // Additive only: one nullable jsonb column on `users`, defaulted to '[]'.
    // Mirrors AddNotifiedAchievementsToUsers. Touches no other table.
    // Stores monthly top-3 finishes as [{ year, month, rank }] for the
    // Monthly Champion/Runner-Up/Third collectible badges.
    await q.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "monthlyPodiums" jsonb NOT NULL DEFAULT '[]'`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "monthlyPodiums"`,
    );
  }
}
