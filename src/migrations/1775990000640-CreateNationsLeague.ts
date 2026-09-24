import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * UEFA Nations League — teams and fixtures.
 *
 * Unlike the Premier League and the Champions League, this competition is not
 * on our football-data.org plan (`GET /v4/competitions/UNL` returns 403), so
 * there is no feed behind it. These two tables ARE the competition: the group
 * tables are computed from finished fixtures, and the match markets are created
 * from the same rows. One place to type a score means a result and a standings
 * table cannot drift apart.
 *
 * Additive only. Two new tables that nothing else references, and no change to
 * `markets` or `outcomes` — the link to a market is a nullable column here plus
 * `metadata.unlFixtureId` on the market, both of which a revert simply leaves
 * behind harmlessly.
 *
 * Scores are nullable with no default, deliberately. A fixture that has not
 * been played has no score, and the standings code must be able to tell that
 * from a real 0-0: reading an absent score as zero is what settled Nottingham
 * Forest v Coventry as a draw in September 2026. A DEFAULT 0 here would make
 * that bug unavoidable at the storage layer.
 */
export class CreateNationsLeague1775990000640 implements MigrationInterface {
  name = "CreateNationsLeague1775990000640";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "unl_teams" (
        "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
        -- The edition as UEFA writes it, e.g. "2026-28". Groups are redrawn
        -- between editions, so everything here is scoped by it.
        "season"     VARCHAR(16)  NOT NULL,
        -- "A" through "N" — 14 groups across the four leagues.
        "groupKey"   VARCHAR(2)   NOT NULL,
        "name"       VARCHAR(120) NOT NULL,
        "flagUrl"    VARCHAR(512) NULL,
        -- Final tiebreaker, so the standings sort is total and stable. UEFA's
        -- last criteria (disciplinary points, coefficient) are data we do not
        -- have; this keeps the table from reordering itself between two reads.
        "sortOrder"  INTEGER      NOT NULL DEFAULT 0,
        "createdAt"  TIMESTAMPTZ  NOT NULL DEFAULT now(),
        "updatedAt"  TIMESTAMPTZ  NOT NULL DEFAULT now(),
        CONSTRAINT "PK_unl_teams" PRIMARY KEY ("id"),
        -- One row per nation per group per edition. Entry is manual, so this is
        -- the constraint that turns a misspelling into an error at the point of
        -- entry instead of a fifth row in a four-team table.
        CONSTRAINT "UQ_unl_team" UNIQUE ("season", "groupKey", "name")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_unl_team_group"
        ON "unl_teams" ("season", "groupKey")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "unl_fixtures" (
        "id"            UUID        NOT NULL DEFAULT gen_random_uuid(),
        "season"        VARCHAR(16) NOT NULL,
        -- Denormalised from the two teams so one group's table is one query.
        -- The service enforces that both teams belong to this group.
        "groupKey"      VARCHAR(2)  NOT NULL,
        "homeTeamId"    UUID        NOT NULL,
        "awayTeamId"    UUID        NOT NULL,
        "kickoffAt"     TIMESTAMPTZ NOT NULL,
        -- Null until played. No DEFAULT 0 — see the class docstring.
        "homeScore"     INTEGER     NULL,
        "awayScore"     INTEGER     NULL,
        "status"        VARCHAR(16) NOT NULL DEFAULT 'scheduled',
        -- At most one market per fixture. The authoritative dedupe key lives on
        -- the market (metadata.unlFixtureId) because the market commits first;
        -- this constraint is what stops the two from disagreeing.
        "marketId"      UUID        NULL,
        -- The market's three outcome ids, stamped at creation, so settlement
        -- never has to match a team name. This competition fields Ireland and
        -- Northern Ireland, and Macedonia and North Macedonia.
        "homeOutcomeId" UUID        NULL,
        "drawOutcomeId" UUID        NULL,
        "awayOutcomeId" UUID        NULL,
        "matchday"      INTEGER     NULL,
        "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_unl_fixtures" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_unl_fixture_market" UNIQUE ("marketId"),
        CONSTRAINT "FK_unl_fixture_home"
          FOREIGN KEY ("homeTeamId") REFERENCES "unl_teams" ("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_unl_fixture_away"
          FOREIGN KEY ("awayTeamId") REFERENCES "unl_teams" ("id") ON DELETE RESTRICT,
        -- A fixture between one team and itself is always a data-entry slip.
        CONSTRAINT "CHK_unl_fixture_distinct_teams"
          CHECK ("homeTeamId" <> "awayTeamId"),
        -- Both scores or neither. A half-entered scoreline is the shape the
        -- standings code refuses to read, so do not let it be stored either.
        CONSTRAINT "CHK_unl_fixture_score_pair"
          CHECK (("homeScore" IS NULL) = ("awayScore" IS NULL))
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_unl_fixture_schedule"
        ON "unl_fixtures" ("season", "kickoffAt")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_unl_fixture_group"
        ON "unl_fixtures" ("season", "groupKey")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Fixtures first: they hold the foreign keys into teams.
    await queryRunner.query(`DROP TABLE IF EXISTS "unl_fixtures"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "unl_teams"`);
  }
}
