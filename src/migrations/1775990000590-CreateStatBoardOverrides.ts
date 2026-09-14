import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Admin edits to the EPL/UCL goals and assists leaderboards.
 *
 * Every editable column is NULLABLE on purpose. A row records only the fields
 * an admin actually changed; anything left null keeps following the live feed.
 * That is what makes "fetch from the provider, but our correction sticks"
 * expressible per field — an admin fixing a wrong photo does not thereby also
 * freeze the goal count, which would go stale the moment the player scored.
 *
 * Additive only: a new table that nothing else references, so the feature is
 * revertible by reverting code plus dropping this table. No change to
 * `markets` or `outcomes` — making a player bettable stays a separate admin
 * action through the existing add-outcome path.
 */
export class CreateStatBoardOverrides1775990000590
  implements MigrationInterface
{
  name = "CreateStatBoardOverrides1775990000590";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "stat_board_overrides" (
        "id"               UUID         NOT NULL DEFAULT gen_random_uuid(),
        "league"           VARCHAR(8)   NOT NULL,
        "board"            VARCHAR(16)  NOT NULL,
        "season"           VARCHAR(8)   NOT NULL,
        "playerKey"        VARCHAR(160) NOT NULL,
        "player"           VARCHAR(160) NOT NULL,
        -- Null means "no admin opinion, use whatever the provider says".
        "club"             VARCHAR(160) NULL,
        "clubBadge"        VARCHAR(512) NULL,
        "face"             VARCHAR(512) NULL,
        "value"            INTEGER      NULL,
        -- True for a player the provider does not carry at all, who therefore
        -- exists on the board only because an admin added them.
        "isManual"         BOOLEAN      NOT NULL DEFAULT false,
        "updatedByAdminId" UUID         NULL,
        "createdAt"        TIMESTAMPTZ  NOT NULL DEFAULT now(),
        "updatedAt"        TIMESTAMPTZ  NOT NULL DEFAULT now(),
        CONSTRAINT "PK_stat_board_overrides" PRIMARY KEY ("id"),
        -- One row per player per board per season. The service writes through
        -- this constraint instead of reading first, so two admins saving the
        -- same player at once cannot create a duplicate board entry.
        CONSTRAINT "UQ_stat_board_override"
          UNIQUE ("league", "board", "season", "playerKey")
      )
    `);

    // The merge inside getStats() reads every override for one board of one
    // season, on every cache miss.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_stat_board_override_lookup" ON "stat_board_overrides" ("league", "board", "season")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_stat_board_override_lookup"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "stat_board_overrides"`);
  }
}
