import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTerMarketColumns1746587000000 implements MigrationInterface {
  name = "AddTerMarketColumns1746587000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add metadata column if it doesn't exist
    await queryRunner.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'markets' AND column_name = 'metadata'
        ) THEN
          ALTER TABLE "markets" ADD COLUMN "metadata" jsonb NULL;
        END IF;
      END $$;
    `);

    // Add bettingClosesAt column if it doesn't exist
    await queryRunner.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'markets' AND column_name = 'bettingClosesAt'
        ) THEN
          ALTER TABLE "markets" ADD COLUMN "bettingClosesAt" TIMESTAMP WITH TIME ZONE NULL;
        END IF;
      END $$;
    `);

    // Create index if it doesn't exist
    await queryRunner.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes WHERE indexname = 'IDX_markets_externalSource'
        ) THEN
          CREATE INDEX "IDX_markets_externalSource"
          ON "markets" ("externalSource")
          WHERE "externalSource" IS NOT NULL;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_markets_externalSource"`,
    );
    await queryRunner.query(
      `ALTER TABLE "markets" DROP COLUMN IF EXISTS "bettingClosesAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "markets" DROP COLUMN IF EXISTS "metadata"`,
    );
  }
}
