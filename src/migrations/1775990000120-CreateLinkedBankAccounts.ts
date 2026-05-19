import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateLinkedBankAccounts1775990000120
  implements MigrationInterface
{
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "linked_bank_accounts" (
        "id"            uuid                        NOT NULL DEFAULT gen_random_uuid(),
        "userId"        uuid                        NOT NULL,
        "cid"           character varying           NOT NULL,
        "accountNumber" character varying           NULL,
        "accountName"   character varying           NULL,
        "bankPhone"     character varying           NULL,
        "isVerified"    boolean                     NOT NULL DEFAULT false,
        "isDefault"     boolean                     NOT NULL DEFAULT false,
        "linkAttempts"  integer                     NOT NULL DEFAULT 0,
        "verifiedAt"    timestamp with time zone    NULL,
        "createdAt"     timestamp with time zone    NOT NULL DEFAULT now(),
        "updatedAt"     timestamp with time zone    NOT NULL DEFAULT now(),
        CONSTRAINT "PK_linked_bank_accounts" PRIMARY KEY ("id"),
        CONSTRAINT "FK_lba_user"
          FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_lba_user_cid"
        ON "linked_bank_accounts" ("userId", "cid")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_lba_cid"
        ON "linked_bank_accounts" ("cid")
    `);

    // Migrate existing users who already have a linked DK Bank account.
    // Mark them as verified + default so existing payment flows continue working.
    await queryRunner.query(`
      INSERT INTO "linked_bank_accounts"
        ("userId", "cid", "accountNumber", "accountName", "bankPhone",
         "isVerified", "isDefault", "verifiedAt")
      SELECT
        u."id",
        u."dkCid",
        u."dkAccountNumber",
        u."dkAccountName",
        u."phoneNumber",
        true,
        true,
        COALESCE(u."dkLinkVerifiedAt", u."telegramLinkedAt", now())
      FROM users u
      WHERE u."dkCid" IS NOT NULL
      ON CONFLICT DO NOTHING
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "linked_bank_accounts"`);
  }
}
