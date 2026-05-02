import type { MigrationInterface, QueryRunner } from "typeorm";

export class CreateAuditLogsTable1711100000011 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // roleType is a plain varchar (role_type_enum was introduced then dropped in
    // migration 1775975312802-AddChallengesTable — created as varchar from the start
    // to avoid that churn on fresh databases).
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "audit_logs" (
        "id"         uuid              NOT NULL DEFAULT uuid_generate_v4(),
        "adminId"    character varying NOT NULL,
        "username"   character varying,
        "roleType"   character varying NOT NULL DEFAULT 'admin',
        "action"     character varying NOT NULL,
        "entityType" character varying,
        "entityId"   character varying,
        "payload"    jsonb,
        "ipAddress"  character varying,
        "createdAt"  TIMESTAMP         NOT NULL DEFAULT now(),
        CONSTRAINT "PK_audit_logs" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_audit_logs_adminId" ON "audit_logs" ("adminId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_logs"`);
  }
}
