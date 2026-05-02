import type { MigrationInterface, QueryRunner } from "typeorm";

export class CreateUsersTable1711100000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "users" (
        "id"                     uuid              NOT NULL DEFAULT uuid_generate_v4(),
        "telegramId"             character varying,
        "telegramStreak"         integer,
        "firstName"              character varying,
        "lastName"               character varying,
        "username"               character varying,
        "photoUrl"               character varying,
        "isAdmin"                boolean           NOT NULL DEFAULT false,
        "dkCid"                  character varying,
        "dkAccountNumber"        character varying,
        "dkAccountName"          character varying,
        "phoneNumber"            character varying,
        "telegramChatId"         character varying,
        "telegramPhoneHash"      character varying,
        "dkPhoneHash"            character varying,
        "telegramLinkedAt"       TIMESTAMP WITH TIME ZONE,
        "reputationScore"        numeric(5,4),
        "reputationTier"         character varying NOT NULL DEFAULT 'rookie',
        "totalPredictions"       integer           NOT NULL DEFAULT 0,
        "correctPredictions"     integer           NOT NULL DEFAULT 0,
        "categoryScores"         jsonb,
        "brierScore"             numeric(5,4),
        "brierCount"             integer           NOT NULL DEFAULT 0,
        "lastActiveAt"           TIMESTAMP WITH TIME ZONE,
        "contrarianWins"         integer           NOT NULL DEFAULT 0,
        "contrarianAttempts"     integer           NOT NULL DEFAULT 0,
        "contrarianBadge"        character varying,
        "betStreakCount"         integer           NOT NULL DEFAULT 0,
        "betStreakLastAt"        DATE,
        "streakBoostUsed"        boolean           NOT NULL DEFAULT false,
        "referredByUserId"       uuid,
        "referralBonusTriggered" boolean           NOT NULL DEFAULT false,
        "freeCreditGranted"      boolean           NOT NULL DEFAULT false,
        "bonusBalance"           numeric(18,2)     NOT NULL DEFAULT 0,
        "referralPrizeClaimed"   boolean           NOT NULL DEFAULT false,
        "cardInventory"          jsonb             NOT NULL DEFAULT '{"doubleDown":0,"shield":0,"ghost":0}',
        "adminTotalResolutions"  integer           NOT NULL DEFAULT 0,
        "adminWrongResolutions"  integer           NOT NULL DEFAULT 0,
        "pwaPasswordHash"        character varying,
        "createdAt"              TIMESTAMP         NOT NULL DEFAULT now(),
        "updatedAt"              TIMESTAMP         NOT NULL DEFAULT now(),
        CONSTRAINT "PK_users" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_users_telegramId" ON "users" ("telegramId") WHERE "telegramId" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_users_username" ON "users" ("username") WHERE "username" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_users_dkCid" ON "users" ("dkCid") WHERE "dkCid" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_users_dkAccountNumber" ON "users" ("dkAccountNumber") WHERE "dkAccountNumber" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_users_telegramChatId" ON "users" ("telegramChatId") WHERE "telegramChatId" IS NOT NULL`,
    );

    // Self-referencing FK — must come after the table exists
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD CONSTRAINT "FK_users_referredByUserId"
        FOREIGN KEY ("referredByUserId")
        REFERENCES "users" ("id")
        ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "FK_users_referredByUserId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);
  }
}
