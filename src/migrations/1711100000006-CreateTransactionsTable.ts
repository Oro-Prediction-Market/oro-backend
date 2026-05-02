import type { MigrationInterface, QueryRunner } from "typeorm";

export class CreateTransactionsTable1711100000006 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "transactions_type_enum" AS ENUM (
          'deposit',
          'withdrawal',
          'bet_placed',
          'bet_payout',
          'refund',
          'dispute_bond',
          'dispute_refund',
          'referral_bonus',
          'free_credit',
          'streak_bonus',
          'referral_prize',
          'duel_wager',
          'duel_payout',
          'dispute_bond_lock',
          'dispute_bond_forfeit',
          'dispute_bond_reward'
        );
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "transactions" (
        "id"            uuid                       NOT NULL DEFAULT uuid_generate_v4(),
        "type"          transactions_type_enum     NOT NULL,
        "amount"        numeric(20,9)              NOT NULL,
        "balanceBefore" numeric(20,9)              NOT NULL,
        "balanceAfter"  numeric(20,9)              NOT NULL,
        "paymentId"     uuid                       UNIQUE,
        "positionId"    uuid,
        "isBonus"       boolean                    NOT NULL DEFAULT false,
        "note"          character varying,
        "createdAt"     TIMESTAMP                  NOT NULL DEFAULT now(),
        "userId"        uuid                       NOT NULL,
        CONSTRAINT "PK_transactions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_transactions_userId" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_transactions_paymentId" ON "transactions" ("paymentId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_transactions_positionId" ON "transactions" ("positionId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_transactions_userId" ON "transactions" ("userId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "transactions"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "transactions_type_enum"`);
  }
}
