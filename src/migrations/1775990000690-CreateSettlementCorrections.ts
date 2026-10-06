import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * A record of every settled market whose result was corrected.
 *
 * September's two wrong results were fixed by hand-written SQL, with backup
 * tables created for the purpose and dropped afterwards — so the only record of
 * what was overwritten, and of the decision to let one market's wrongly-paid
 * side keep their money, was a chat history. Each correction now keeps a full
 * snapshot of the rows it rewrote, who made it, and why.
 */
export class CreateSettlementCorrections1775990000690
  implements MigrationInterface
{
  name = "CreateSettlementCorrections1775990000690";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "settlement_corrections" (
        "id"            uuid NOT NULL DEFAULT uuid_generate_v4(),
        "marketId"      uuid NOT NULL,
        "fromOutcomeId" uuid NOT NULL,
        "toOutcomeId"   uuid NOT NULL,
        "mode"          varchar(16) NOT NULL,
        "note"          text NOT NULL,
        "adminId"       uuid NOT NULL,
        "summary"       jsonb NOT NULL,
        "snapshot"      jsonb NOT NULL,
        "createdAt"     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_settlement_corrections" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_settlement_corrections_mode"
          CHECK ("mode" IN ('clawback', 'keep'))
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_settlement_corrections_market"
         ON "settlement_corrections" ("marketId", "createdAt")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "settlement_corrections"`);
  }
}
