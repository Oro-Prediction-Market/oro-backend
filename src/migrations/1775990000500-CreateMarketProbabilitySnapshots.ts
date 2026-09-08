import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateMarketProbabilitySnapshots1775990000500
  implements MigrationInterface
{
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "market_probability_snapshots" (
        "id"          uuid NOT NULL DEFAULT uuid_generate_v4(),
        "marketId"    uuid NOT NULL,
        "outcomeId"   uuid NOT NULL,
        "probability" numeric(10,6) NOT NULL,
        "totalPool"   numeric(18,2) NOT NULL DEFAULT 0,
        "capturedAt"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_market_probability_snapshots" PRIMARY KEY ("id")
      )
    `);

    // One market's curve, in capture order — the history endpoint.
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_mps_market_captured"
        ON "market_probability_snapshots" ("marketId", "capturedAt")
    `);
    // Everything in a time window — the movers digest.
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_mps_captured"
        ON "market_probability_snapshots" ("capturedAt")
    `);
    // Latest point per outcome, via DISTINCT ON (marketId, outcomeId).
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_mps_market_outcome_captured"
        ON "market_probability_snapshots" ("marketId", "outcomeId", "capturedAt" DESC)
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "market_probability_snapshots"`);
  }
}
