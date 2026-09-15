import { MigrationInterface, QueryRunner } from "typeorm";

export class AddConsentToUsers1775990000600 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    // Additive: two nullable columns on `users`, plus a one-time backfill.
    await q.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "consentedAt" timestamptz`,
    );
    await q.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "consentVersion" character varying(16)`,
    );

    // Everyone who already has an account counts as consented — the apps block
    // on a null `consentedAt`, so without this every existing user would be
    // locked out on the next deploy.
    //
    // Stamped with the row's own `createdAt` rather than NOW(), so the column
    // never claims someone agreed at a moment they were not using the app.
    // Version "0" is not a real version: it marks a row that was granted
    // consent rather than giving it, which keeps those rows tellable apart
    // from an actual acceptance. Idempotent, so a re-run is harmless.
    await q.query(
      `UPDATE "users"
          SET "consentedAt" = "createdAt", "consentVersion" = '0'
        WHERE "consentedAt" IS NULL`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    // Note this discards real acceptances recorded after the deploy, not just
    // the backfill — there is nowhere else they are stored.
    await q.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "consentVersion"`);
    await q.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "consentedAt"`);
  }
}
