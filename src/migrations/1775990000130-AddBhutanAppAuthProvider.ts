import { MigrationInterface, QueryRunner } from "typeorm";

export class AddBhutanAppAuthProvider1775990000130 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL requires ALTER TYPE to add enum values — cannot use IF NOT EXISTS in older PG,
    // so we check via pg_enum before adding to make this migration idempotent.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_enum
          WHERE enumlabel = 'bhutanapp'
            AND enumtypid = (
              SELECT oid FROM pg_type
              WHERE typname = 'auth_methods_provider_enum'
            )
        ) THEN
          ALTER TYPE auth_methods_provider_enum ADD VALUE 'bhutanapp';
        END IF;
      END
      $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL does not support removing enum values directly.
    // To roll back: migrate all bhutanapp rows away, then recreate the type without it.
    // For now this is a no-op — removing enum values requires a full type rebuild.
  }
}
