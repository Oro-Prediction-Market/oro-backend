import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Email as an auth provider, plus document KYC.
 *
 * The credential half of this already exists: `users.pwaPasswordHash` holds a
 * bcrypt hash and `auth.service.ts` verifies it today. What is missing is email
 * as an *identity* — a way to authenticate as someone without BhutanApp, DK
 * Bank or Telegram — and the document review that gates funding.
 *
 * Note the change in threat model: for existing accounts a password is a
 * convenience second factor layered on an external provider. For an email
 * account it is the sole credential, so registration, login and reset all need
 * rate limiting of their own.
 *
 * KYC lives in its own table rather than on `users`. Identity is who you
 * authenticate as; KYC is proof of who you are. Conflating them means a
 * resubmitted document touches the auth path.
 *
 * `users.kycStatus` is denormalised so the deposit gate does not join.
 *
 * See docs/usdt-oro/STAGE-G-ONBOARDING-KYC.md.
 */
export class AddEmailAuthAndKyc1775990000350 implements MigrationInterface {
  name = "AddEmailAuthAndKyc1775990000350";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // Postgres 12+ allows ADD VALUE inside a transaction provided the value is
    // not used in the same transaction. Cannot be removed later, so the
    // spelling is fixed here for good.
    await q.query(
      `ALTER TYPE "auth_methods_provider_enum" ADD VALUE IF NOT EXISTS 'email'`,
    );

    // ── KYC status on the account ────────────────────────────────────────────
    // NONE is right for every existing user: BhutanApp and DK Bank accounts are
    // verified through their provider, never through this queue, and nothing
    // reads this column for them.
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "users_kycstatus_enum" AS ENUM ('none','pending','approved','rejected');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await q.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "kycStatus" "users_kycstatus_enum" NOT NULL DEFAULT 'none'`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_users_kycStatus" ON "users" ("kycStatus")`,
    );

    // Email verification state. An unverified address must not reach document
    // upload, or the review queue fills with documents belonging to addresses
    // nobody controls.
    await q.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" timestamptz`,
    );

    // ── Documents ────────────────────────────────────────────────────────────
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "user_kyc_documents_documenttype_enum"
          AS ENUM ('passport','national_id','drivers_licence');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "user_kyc_documents_status_enum"
          AS ENUM ('pending','approved','rejected');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "user_kyc_documents" (
        "id"              uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId"          uuid NOT NULL,
        "documentType"    "user_kyc_documents_documenttype_enum" NOT NULL,
        "documentNumber"  varchar(255) NOT NULL,
        "documentCountry" varchar(2)   NOT NULL,
        "imageObjectKey"  varchar(255) NOT NULL,
        "status"          "user_kyc_documents_status_enum" NOT NULL DEFAULT 'pending',
        "reviewedBy"      uuid,
        "reviewedAt"      timestamptz,
        "rejectionReason" varchar(255),
        "submittedAt"     TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt"       TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_kyc_documents" PRIMARY KEY ("id"),
        CONSTRAINT "FK_user_kyc_documents_user" FOREIGN KEY ("userId")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_kyc_documents_userId" ON "user_kyc_documents" ("userId")`,
    );
    // The review queue: oldest pending first.
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_kyc_documents_status_submitted"
         ON "user_kyc_documents" ("status", "submittedAt")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_user_kyc_documents_status_submitted"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_user_kyc_documents_userId"`);
    await q.query(`DROP TABLE IF EXISTS "user_kyc_documents"`);
    await q.query(`DROP TYPE IF EXISTS "user_kyc_documents_status_enum"`);
    await q.query(`DROP TYPE IF EXISTS "user_kyc_documents_documenttype_enum"`);

    await q.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "emailVerifiedAt"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_users_kycStatus"`);
    await q.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "kycStatus"`);
    await q.query(`DROP TYPE IF EXISTS "users_kycstatus_enum"`);
    // 'email' cannot be removed from auth_methods_provider_enum; Postgres has
    // no DROP VALUE. Harmless — nothing authenticates with it after a revert.
  }
}
