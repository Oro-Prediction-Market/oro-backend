import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateSeasonsTable1775980000000 implements MigrationInterface {
  // Keep original name so TypeORM recognises this as already applied on existing DBs.
  name = "AddSeasonsTable1775980000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "seasons" (
        "id"              uuid              NOT NULL DEFAULT uuid_generate_v4(),
        "weekNumber"      integer           NOT NULL,
        "year"            integer           NOT NULL,
        "startsAt"        TIMESTAMPTZ       NOT NULL,
        "endsAt"          TIMESTAMPTZ       NOT NULL,
        "status"          character varying NOT NULL DEFAULT 'active',
        "winnersSnapshot" jsonb,
        "createdAt"       TIMESTAMPTZ       NOT NULL DEFAULT now(),
        CONSTRAINT "PK_seasons" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_seasons_year_week" ON "seasons" ("year", "weekNumber")`,
    );

    // Seed the current week as the first active season
    await queryRunner.query(`
      INSERT INTO "seasons" ("weekNumber", "year", "startsAt", "endsAt", "status")
      VALUES (
        EXTRACT(WEEK FROM NOW())::int,
        EXTRACT(YEAR FROM NOW())::int,
        DATE_TRUNC('week', NOW()),
        DATE_TRUNC('week', NOW()) + INTERVAL '7 days',
        'active'
      )
      ON CONFLICT DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "seasons"`);
  }
}
