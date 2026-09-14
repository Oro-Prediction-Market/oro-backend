import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Admin-supplied rows for the EPL/UCL goals and assists leaderboards.
 *
 * Additive only: a new table that nothing else references, so the feature is
 * revertible by reverting code plus dropping this table. No change to
 * `markets` or `outcomes` — making a manual player bettable stays a separate
 * admin action that goes through the existing add-outcome path.
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
        "club"             VARCHAR(160) NOT NULL DEFAULT '',
        "clubBadge"        VARCHAR(512) NOT NULL DEFAULT '',
        "face"             VARCHAR(512) NOT NULL DEFAULT '',
        "value"            INTEGER      NOT NULL DEFAULT 0,
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
