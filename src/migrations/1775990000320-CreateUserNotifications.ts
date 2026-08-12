import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateUserNotifications1775990000320
  implements MigrationInterface
{
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await q.query(`
      CREATE TABLE IF NOT EXISTS "user_notifications" (
        "id"        uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId"    uuid NOT NULL,
        "type"      varchar NOT NULL DEFAULT 'system',
        "title"     varchar NOT NULL,
        "body"      text NOT NULL,
        "metadata"  jsonb,
        "seenAt"    timestamptz,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_notifications" PRIMARY KEY ("id")
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_notifications_userId" ON "user_notifications" ("userId")`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(
      `DROP INDEX IF EXISTS "IDX_user_notifications_userId"`,
    );
    await q.query(`DROP TABLE IF EXISTS "user_notifications"`);
  }
}
