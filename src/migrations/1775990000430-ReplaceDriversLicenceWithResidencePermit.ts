import { MigrationInterface, QueryRunner } from "typeorm";

export class ReplaceDriversLicenceWithResidencePermit1775990000430
  implements MigrationInterface
{
  name = "ReplaceDriversLicenceWithResidencePermit1775990000430";

  public async up(queryRunner: QueryRunner): Promise<void> {
    const [{ count }] = await queryRunner.query(
      `SELECT COUNT(*)::int AS count FROM "user_kyc_documents"
        WHERE "documentType" = 'drivers_licence'`,
    );
    if (count > 0) {
      throw new Error(
        `${count} document(s) are recorded as drivers_licence. Re-classify or ` +
          `reject them before running this migration — dropping the value ` +
          `would erase what was actually submitted.`,
      );
    }

    await queryRunner.query(
      `ALTER TYPE "user_kyc_documents_documenttype_enum"
         RENAME TO "user_kyc_documents_documenttype_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "user_kyc_documents_documenttype_enum" AS ENUM
         ('passport', 'national_id', 'residence_permit')`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_kyc_documents"
         ALTER COLUMN "documentType" TYPE "user_kyc_documents_documenttype_enum"
         USING "documentType"::text::"user_kyc_documents_documenttype_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "user_kyc_documents_documenttype_enum_old"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Symmetric: refuse rather than silently lose a residence permit.
    const [{ count }] = await queryRunner.query(
      `SELECT COUNT(*)::int AS count FROM "user_kyc_documents"
        WHERE "documentType" = 'residence_permit'`,
    );
    if (count > 0) {
      throw new Error(
        `${count} document(s) are recorded as residence_permit; reverting ` +
          `would erase that.`,
      );
    }

    await queryRunner.query(
      `ALTER TYPE "user_kyc_documents_documenttype_enum"
         RENAME TO "user_kyc_documents_documenttype_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "user_kyc_documents_documenttype_enum" AS ENUM
         ('passport', 'national_id', 'drivers_licence')`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_kyc_documents"
         ALTER COLUMN "documentType" TYPE "user_kyc_documents_documenttype_enum"
         USING "documentType"::text::"user_kyc_documents_documenttype_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "user_kyc_documents_documenttype_enum_old"`,
    );
  }
}
