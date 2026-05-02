import type { MigrationInterface, QueryRunner } from "typeorm";

export class CreateAuthMethodsTable1711100000003 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "auth_methods_provider_enum" AS ENUM ('telegram', 'dkbank');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "auth_methods" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "provider" auth_methods_provider_enum NOT NULL DEFAULT 'telegram',
        "providerId" character varying NOT NULL,
        "metadata" jsonb,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "userId" uuid NOT NULL,
        CONSTRAINT "PK_auth_methods" PRIMARY KEY ("id"),
        CONSTRAINT "FK_auth_methods_userId" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_auth_methods_provider_providerId" ON "auth_methods" ("provider", "providerId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "auth_methods"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "auth_methods_provider_enum"`);
  }
}
