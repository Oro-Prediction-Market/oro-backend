import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * "Sign out everywhere": tokens issued at or before this moment are rejected.
 *
 * Logout blacklists only the jti in hand. Since sessions began sliding, a
 * stolen cookie stays alive for as long as someone keeps using it, and there
 * was no way to end it. Null means nothing has been revoked.
 */
export class AddSessionsRevokedAt1775990000700 implements MigrationInterface {
  name = "AddSessionsRevokedAt1775990000700";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "sessionsRevokedAt" timestamptz`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "sessionsRevokedAt"`,
    );
  }
}
