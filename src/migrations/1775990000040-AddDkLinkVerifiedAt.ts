import { MigrationInterface, QueryRunner } from "typeorm";

export class AddDkLinkVerifiedAt1775990000040 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "dkLinkVerifiedAt" timestamptz NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "dkLinkVerifiedAt"
    `);
  }
}
