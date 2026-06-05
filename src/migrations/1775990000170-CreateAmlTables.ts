import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateAmlTables1775990000170 implements MigrationInterface {
  name = "CreateAmlTables1775990000170";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "aml_alerts" (
        "id"               UUID              NOT NULL DEFAULT gen_random_uuid(),
        "userId"           UUID              NOT NULL,
        "alertType"        VARCHAR           NOT NULL,
        "riskLevel"        VARCHAR           NOT NULL,
        "description"      TEXT              NOT NULL,
        "metadata"         JSONB,
        "totalAmount"      DECIMAL(20, 2),
        "transactionCount" INTEGER,
        "isResolved"       BOOLEAN           NOT NULL DEFAULT false,
        "resolution"       TEXT,
        "resolvedBy"       UUID,
        "resolvedAt"       TIMESTAMPTZ,
        "createdAt"        TIMESTAMPTZ       NOT NULL DEFAULT now(),
        "updatedAt"        TIMESTAMPTZ       NOT NULL DEFAULT now(),
        CONSTRAINT "PK_aml_alerts" PRIMARY KEY ("id"),
        CONSTRAINT "FK_aml_alerts_user"
          FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_aml_alerts_userId" ON "aml_alerts" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_aml_alerts_riskLevel" ON "aml_alerts" ("riskLevel")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_aml_alerts_isResolved" ON "aml_alerts" ("isResolved")`,
    );

    await queryRunner.query(`
      CREATE TABLE "aml_reports" (
        "id"               UUID        NOT NULL DEFAULT gen_random_uuid(),
        "reportType"       VARCHAR     NOT NULL,
        "periodFrom"       TIMESTAMPTZ NOT NULL,
        "periodTo"         TIMESTAMPTZ NOT NULL,
        "alertIds"         JSONB       NOT NULL DEFAULT '[]',
        "totalAlerts"      INTEGER     NOT NULL DEFAULT 0,
        "highRiskCount"    INTEGER     NOT NULL DEFAULT 0,
        "mediumRiskCount"  INTEGER     NOT NULL DEFAULT 0,
        "lowRiskCount"     INTEGER     NOT NULL DEFAULT 0,
        "affectedUsers"    INTEGER     NOT NULL DEFAULT 0,
        "generatedBy"      UUID        NOT NULL,
        "generatedByName"  VARCHAR,
        "notes"            TEXT,
        "createdAt"        TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_aml_reports" PRIMARY KEY ("id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "aml_reports"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_aml_alerts_isResolved"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_aml_alerts_riskLevel"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_aml_alerts_userId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "aml_alerts"`);
  }
}
