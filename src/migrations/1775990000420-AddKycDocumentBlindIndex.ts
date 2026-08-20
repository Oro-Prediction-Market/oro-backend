import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * A searchable index over encrypted document numbers.
 *
 * `documentNumber` is AES-GCM with a random IV, so the same passport encrypts
 * differently every time and `WHERE documentNumber = ?` can never match. Two
 * things need that lookup and neither is optional:
 *
 *   - **Duplicate detection.** Google sign-in makes accounts nearly free, so
 *     the only thing linking five accounts to one person is the document
 *     behind them. Per-user limits and AML both rest on it.
 *   - **Account recovery.** Someone locked out of their Google account proves
 *     identity with the document we already hold — which requires finding the
 *     account from the document.
 *
 * Not unique: a duplicate is a signal for a human to review, not something to
 * reject at the database. Families share addresses, people legitimately
 * re-register, and a hard constraint would turn a review case into an outage.
 */
export class AddKycDocumentBlindIndex1775990000420
  implements MigrationInterface
{
  name = "AddKycDocumentBlindIndex1775990000420";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "user_kyc_documents"
         ADD COLUMN IF NOT EXISTS "documentNumberIndex" varchar(64)`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_kyc_documents_number_index"
         ON "user_kyc_documents" ("documentNumberIndex")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_user_kyc_documents_number_index"`);
    await q.query(
      `ALTER TABLE "user_kyc_documents" DROP COLUMN IF EXISTS "documentNumberIndex"`,
    );
  }
}
