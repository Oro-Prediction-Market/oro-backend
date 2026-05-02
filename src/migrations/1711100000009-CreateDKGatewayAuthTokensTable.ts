import type { MigrationInterface, QueryRunner } from "typeorm";

export class CreateDKGatewayAuthTokensTable1711100000009 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dk_gateway_auth_tokens" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "accesstoken" text NOT NULL,
        "refreshtoken" text,
        "expiresat" TIMESTAMP NOT NULL,
        "createdat" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedat" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dk_gateway_auth_tokens" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_dk_gateway_auth_tokens_accesstoken" ON "dk_gateway_auth_tokens" ("accesstoken")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_dk_gateway_auth_tokens_expiresat" ON "dk_gateway_auth_tokens" ("expiresat")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "dk_gateway_auth_tokens"`);
  }
}
