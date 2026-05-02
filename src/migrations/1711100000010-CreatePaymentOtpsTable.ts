import type { MigrationInterface, QueryRunner } from "typeorm";

export class CreatePaymentOtpsTable1711100000010 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "payment_otps_status_enum" AS ENUM (
          'pending', 'verified', 'expired', 'cancelled'
        );
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "payment_otps" (
        "id"              uuid                        NOT NULL DEFAULT uuid_generate_v4(),
        "status"          payment_otps_status_enum    NOT NULL DEFAULT 'pending',
        "createdAt"       TIMESTAMP                   NOT NULL DEFAULT now(),
        "expiresAt"       TIMESTAMP                   NOT NULL,
        "lastRequestedAt" TIMESTAMP WITH TIME ZONE,
        "verifiedAt"      TIMESTAMP WITH TIME ZONE,
        "updatedAt"       TIMESTAMP                   NOT NULL DEFAULT now(),
        "requestCount"    integer                     NOT NULL DEFAULT 1,
        "failedAttempts"  integer                     NOT NULL DEFAULT 0,
        "bfsTxnId"        character varying,
        "paymentId"       uuid,
        "userId"          uuid                        NOT NULL,
        "marketId"        uuid,
        "disputeId"       uuid,
        CONSTRAINT "PK_payment_otps" PRIMARY KEY ("id"),
        CONSTRAINT "FK_payment_otps_paymentId"  FOREIGN KEY ("paymentId")  REFERENCES "payments"  ("id") ON DELETE SET NULL,
        CONSTRAINT "FK_payment_otps_userId"     FOREIGN KEY ("userId")     REFERENCES "users"     ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_payment_otps_marketId"   FOREIGN KEY ("marketId")   REFERENCES "markets"   ("id") ON DELETE SET NULL,
        CONSTRAINT "FK_payment_otps_disputeId"  FOREIGN KEY ("disputeId")  REFERENCES "disputes"  ("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_payment_otps_paymentId" ON "payment_otps" ("paymentId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_payment_otps_userId" ON "payment_otps" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_payment_otps_marketId" ON "payment_otps" ("marketId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_payment_otps_disputeId" ON "payment_otps" ("disputeId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "payment_otps"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "payment_otps_status_enum"`);
  }
}
