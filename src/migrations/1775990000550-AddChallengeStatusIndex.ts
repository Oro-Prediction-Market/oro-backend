import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * An index for the admin duels dashboard's default view.
 *
 * `challenges` already had (creatorId, status) and (marketId, status), but a
 * composite index cannot serve a query that does not constrain its leading
 * column — so "every duel, newest first, optionally filtered by status" was a
 * sequential scan plus a sort, which is exactly what the page opens with.
 *
 * Declared on the entity as well as here. TypeORM's synchronize drops any index
 * it cannot find in entity metadata, so a migration-only index would survive
 * until the next sync and then vanish.
 */
export class AddChallengeStatusIndex1775990000550 implements MigrationInterface {
  name = "AddChallengeStatusIndex1775990000550";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_challenges_status_createdAt" ON "challenges" ("status", "createdAt")`,
    );
    // The stuck-duel filter and the "duels this user is on" filter both search
    // joinerId, which had no index at all — the FK does not create one.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_challenges_joinerId" ON "challenges" ("joinerId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_challenges_joinerId"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_challenges_status_createdAt"`,
    );
  }
}
