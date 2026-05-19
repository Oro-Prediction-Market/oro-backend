import { MigrationInterface, QueryRunner } from "typeorm";

export class AddEmailToUsers1775990000110 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS "email" character varying NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_users_email"
      ON users ("email")
      WHERE "email" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_email"`);
    await queryRunner.query(`ALTER TABLE users DROP COLUMN IF EXISTS "email"`);
  }
}
