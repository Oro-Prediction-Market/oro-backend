import { MigrationInterface, QueryRunner } from "typeorm";

export class AddUsersCreatedAtIndex1775990000480 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    // Index only — no column or data change. `users.createdAt` had no index,
    // and the admin user-growth panel filters and GROUP BYs on it on every
    // dashboard load. Plain CREATE INDEX, not CONCURRENTLY: TypeORM wraps
    // migrations in a transaction and CONCURRENTLY cannot run inside one.
    // The matching class-level @Index on the User entity is required too, or
    // DB_SYNCHRONIZE drops this index again locally.
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_users_createdAt" ON "users" ("createdAt")`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_users_createdAt"`);
  }
}
