import type { MigrationInterface, QueryRunner } from "typeorm";

export class CreateMarketsTable1711100000001 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "markets_status_enum" AS ENUM (
          'upcoming', 'open', 'closed', 'resolving', 'resolved', 'settled', 'cancelled'
        );
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "markets_mechanism_enum" AS ENUM ('parimutuel');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "markets_category_enum" AS ENUM (
          'sports', 'politics', 'weather', 'entertainment', 'economy', 'other'
        );
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "markets" (
        "id"                  uuid                      NOT NULL DEFAULT uuid_generate_v4(),
        "title"               character varying         NOT NULL,
        "description"         text,
        "imageUrl"            character varying,
        "imageUrlAlt"         character varying,
        "status"              markets_status_enum       NOT NULL DEFAULT 'upcoming',
        "totalPool"           numeric(18,2)             NOT NULL DEFAULT 0,
        "houseEdgePct"        numeric(5,2)              NOT NULL DEFAULT 5,
        "mechanism"           markets_mechanism_enum    NOT NULL DEFAULT 'parimutuel',
        "liquidityParam"      numeric(18,2)             NOT NULL DEFAULT 1000,
        "category"            markets_category_enum     NOT NULL DEFAULT 'other',
        "resolutionCriteria"  text,
        "resolvedOutcomeId"   uuid,
        "proposedOutcomeId"   uuid,
        "disputeDeadlineAt"   TIMESTAMP WITH TIME ZONE,
        "opensAt"             TIMESTAMP WITH TIME ZONE,
        "closesAt"            TIMESTAMP WITH TIME ZONE,
        "resolvedAt"          TIMESTAMP WITH TIME ZONE,
        "externalMatchId"     integer,
        "externalSource"      character varying(64),
        "externalMarketType"  character varying(32),
        "evidenceUrl"         character varying,
        "evidenceNote"        text,
        "evidenceSubmittedAt" TIMESTAMP WITH TIME ZONE,
        "resolvedByAdminId"   character varying,
        "windowMinutes"       integer                   NOT NULL DEFAULT 60,
        "disputeBondPool"     numeric(18,2)             NOT NULL DEFAULT 0,
        "createdAt"           TIMESTAMP                 NOT NULL DEFAULT now(),
        "updatedAt"           TIMESTAMP                 NOT NULL DEFAULT now(),
        CONSTRAINT "PK_markets" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_markets_status" ON "markets" ("status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "markets"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "markets_category_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "markets_mechanism_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "markets_status_enum"`);
  }
}
