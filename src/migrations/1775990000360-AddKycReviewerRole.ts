import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * A reviewer role distinct from admin.
 *
 * KYC review means looking at passport and national-ID images. Everyone with
 * admin access can already move money and resolve markets; that is not the
 * same permission as being able to read a stranger's identity documents, and
 * the set of people who should hold each is different.
 *
 * Separate boolean rather than a role table, matching the existing `isAdmin`
 * shape. A general role system is a bigger change than this stage needs and
 * would touch every guard in the codebase.
 */
export class AddKycReviewerRole1775990000360 implements MigrationInterface {
  name = "AddKycReviewerRole1775990000360";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "isKycReviewer" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "isKycReviewer"`);
  }
}
