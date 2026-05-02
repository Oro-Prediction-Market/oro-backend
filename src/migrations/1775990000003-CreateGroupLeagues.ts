import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateGroupLeagues1775990000003 implements MigrationInterface {
  name = "CreateGroupLeagues1775990000003";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "telegram_groups" (
        "id"        UUID NOT NULL DEFAULT uuid_generate_v4(),
        "chatId"    VARCHAR NOT NULL,
        "title"     VARCHAR,
        "isActive"  BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_telegram_groups" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_telegram_groups_chatId" UNIQUE ("chatId")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "group_memberships" (
        "id"       UUID NOT NULL DEFAULT uuid_generate_v4(),
        "chatId"   VARCHAR NOT NULL,
        "userId"   UUID NOT NULL,
        "joinedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_group_memberships" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_group_memberships_chatId_userId" UNIQUE ("chatId", "userId"),
        CONSTRAINT "FK_group_memberships_user" FOREIGN KEY ("userId")
          REFERENCES "users" ("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_group_memberships_chatId" ON "group_memberships" ("chatId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_group_memberships_chatId"`);
    await queryRunner.query(`DROP TABLE "group_memberships"`);
    await queryRunner.query(`DROP TABLE "telegram_groups"`);
  }
}
