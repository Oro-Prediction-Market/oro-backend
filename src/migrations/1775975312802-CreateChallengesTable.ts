import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateChallengesTable1775975312802 implements MigrationInterface {
  // Keep original name so TypeORM recognises this as already applied on existing DBs.
  name = "AddChallengesTable1775975312802";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE IF NOT EXISTS "public"."challenges_status_enum" AS ENUM(
        'open', 'active', 'settled', 'expired', 'void'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "challenges" (
        "id"               uuid                                  NOT NULL DEFAULT uuid_generate_v4(),
        "creatorId"        uuid                                  NOT NULL,
        "marketId"         uuid                                  NOT NULL,
        "outcomeId"        uuid                                  NOT NULL,
        "status"           "public"."challenges_status_enum"     NOT NULL DEFAULT 'open',
        "participantCount" integer                               NOT NULL DEFAULT 0,
        "expiresAt"        TIMESTAMP WITH TIME ZONE              NOT NULL,
        "createdAt"        TIMESTAMP                             NOT NULL DEFAULT now(),
        "wagerAmount"      numeric(18,2)                         NOT NULL DEFAULT 0,
        "joinerId"         uuid,
        "winnerId"         uuid,
        "settledAt"        TIMESTAMP WITH TIME ZONE,
        "equippedCard"     character varying,
        CONSTRAINT "PK_challenges"            PRIMARY KEY ("id"),
        CONSTRAINT "FK_challenges_creatorId"  FOREIGN KEY ("creatorId") REFERENCES "users"    ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_challenges_marketId"   FOREIGN KEY ("marketId")  REFERENCES "markets"  ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_challenges_outcomeId"  FOREIGN KEY ("outcomeId") REFERENCES "outcomes" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_challenges_joinerId"   FOREIGN KEY ("joinerId")  REFERENCES "users"    ("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_challenges_creatorId" ON "challenges" ("creatorId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_challenges_marketId_status" ON "challenges" ("marketId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_challenges_creatorId_status" ON "challenges" ("creatorId", "status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "challenges"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."challenges_status_enum"`);
  }
}
