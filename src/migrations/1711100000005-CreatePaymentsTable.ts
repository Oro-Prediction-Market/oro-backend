import type { MigrationInterface, QueryRunner } from "typeorm";

export class CreatePaymentsTable1711100000005 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "payments_type_enum" AS ENUM (
          'deposit', 'withdrawal', 'position_placed', 'position_payout', 'refund'
        );
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "payments_status_enum" AS ENUM (
          'pending', 'success', 'failed', 'cancelled'
        );
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "payments_method_enum" AS ENUM ('dkbank', 'ton', 'credits');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "payments" (
        "id"                uuid                     NOT NULL DEFAULT uuid_generate_v4(),
        "type"              payments_type_enum        NOT NULL,
        "status"            payments_status_enum      NOT NULL DEFAULT 'pending',
        "method"            payments_method_enum      NOT NULL,
        "amount"            numeric(18,2)             NOT NULL,
        "currency"          character varying(10)    NOT NULL DEFAULT 'BTN',
        "externalPaymentId" character varying,
        "referenceId"       character varying,
        "dkinquiryid"       character varying,
        "dktxnstatusid"     character varying,
        "dkrequestid"       character varying,
        "customerPhone"     character varying,
        "description"       character varying,
        "metadata"          json,
        "failureReason"     character varying,
        "confirmedAt"       TIMESTAMP WITH TIME ZONE,
        "createdAt"         TIMESTAMP                NOT NULL DEFAULT now(),
        "updatedAt"         TIMESTAMP                NOT NULL DEFAULT now(),
        "userId"            uuid                     NOT NULL,
        CONSTRAINT "PK_payments" PRIMARY KEY ("id"),
        CONSTRAINT "FK_payments_userId" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_payments_externalPaymentId" ON "payments" ("externalPaymentId") WHERE "externalPaymentId" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_payments_userId" ON "payments" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_payments_status" ON "payments" ("status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "payments"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "payments_method_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "payments_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "payments_type_enum"`);
  }
}
