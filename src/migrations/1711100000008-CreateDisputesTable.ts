import type { MigrationInterface, QueryRunner } from "typeorm";

export class CreateDisputesTable1711100000008 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."dispute_bond_status_enum" AS ENUM(
          'locked', 'rewarded', 'forfeited', 'not_applicable'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "disputes" (
        "id"         uuid                                NOT NULL DEFAULT uuid_generate_v4(),
        "reason"     text                               NOT NULL,
        "upheld"     boolean,
        "bondAmount" numeric(18,2)                      NOT NULL DEFAULT 0,
        "bondStatus" "public"."dispute_bond_status_enum" NOT NULL DEFAULT 'locked',
        "createdAt"  TIMESTAMP                          NOT NULL DEFAULT now(),
        "userId"     uuid                               NOT NULL,
        "marketId"   uuid                               NOT NULL,
        CONSTRAINT "PK_disputes" PRIMARY KEY ("id"),
        CONSTRAINT "FK_disputes_userId"   FOREIGN KEY ("userId")   REFERENCES "users"   ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_disputes_marketId" FOREIGN KEY ("marketId") REFERENCES "markets" ("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_disputes_userId" ON "disputes" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_disputes_marketId" ON "disputes" ("marketId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_disputes_bondStatus" ON "disputes" ("bondStatus")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "disputes"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."dispute_bond_status_enum"`,
    );
  }
}
