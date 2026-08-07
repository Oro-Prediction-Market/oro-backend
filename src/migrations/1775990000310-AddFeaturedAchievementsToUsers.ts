import { MigrationInterface, QueryRunner } from "typeorm";
export class AddFeaturedAchievementsToUsers1775990000310 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> { await q.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "featuredAchievementIds" jsonb NOT NULL DEFAULT '[]'`); }
  async down(q: QueryRunner): Promise<void> { await q.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "featuredAchievementIds"`); }
}
