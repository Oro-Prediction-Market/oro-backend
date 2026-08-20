import { MigrationInterface, QueryRunner } from "typeorm";


export class AddMarketBooks1775990000340 implements MigrationInterface {
  name = "AddMarketBooks1775990000340";

  private async widenIfExists(
    q: QueryRunner,
    table: string,
    column: string,
  ): Promise<void> {
    const [{ exists }] = await q.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = $1 AND column_name = $2
       ) AS exists`,
      [table, column],
    );
    if (!exists) return;
    await q.query(
      `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE numeric(28,9)`,
    );
  }

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // ── market_books ─────────────────────────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS "market_books" (
        "id"           uuid          NOT NULL DEFAULT uuid_generate_v4(),
        "marketId"     uuid          NOT NULL,
        "currency"     varchar(10)   NOT NULL,
        "totalPool"    numeric(28,9) NOT NULL DEFAULT 0,
        "houseEdgePct" numeric(5,2)  NOT NULL,
        "minStake"     numeric(28,9) NOT NULL,
        "status"       varchar(32)   NOT NULL DEFAULT 'open',
        "isEnabled"    boolean       NOT NULL DEFAULT true,
        "createdAt"    TIMESTAMP     NOT NULL DEFAULT now(),
        "updatedAt"    TIMESTAMP     NOT NULL DEFAULT now(),
        CONSTRAINT "PK_market_books" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_market_books_market_currency" UNIQUE ("marketId", "currency"),
        CONSTRAINT "FK_market_books_market" FOREIGN KEY ("marketId")
          REFERENCES "markets"("id") ON DELETE CASCADE
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_market_books_marketId" ON "market_books" ("marketId")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_market_books_currency" ON "market_books" ("currency")`,
    );

    // ── outcome_books ────────────────────────────────────────────────────────
    // Odds and LMSR probability both derive from how stake is distributed
    // across outcomes, so both are per book, not per outcome.
    await q.query(`
      CREATE TABLE IF NOT EXISTS "outcome_books" (
        "id"              uuid          NOT NULL DEFAULT uuid_generate_v4(),
        "outcomeId"       uuid          NOT NULL,
        "currency"        varchar(10)   NOT NULL,
        "totalBetAmount"  numeric(28,9) NOT NULL DEFAULT 0,
        "currentOdds"     numeric(10,4) NOT NULL DEFAULT 0,
        "lmsrProbability" numeric(10,6) NOT NULL DEFAULT 0,
        "createdAt"       TIMESTAMP     NOT NULL DEFAULT now(),
        "updatedAt"       TIMESTAMP     NOT NULL DEFAULT now(),
        CONSTRAINT "PK_outcome_books" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_outcome_books_outcome_currency" UNIQUE ("outcomeId", "currency"),
        CONSTRAINT "FK_outcome_books_outcome" FOREIGN KEY ("outcomeId")
          REFERENCES "outcomes"("id") ON DELETE CASCADE
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_outcome_books_outcomeId" ON "outcome_books" ("outcomeId")`,
    );

    await q.query(`
      INSERT INTO "market_books" ("marketId", "currency", "totalPool", "houseEdgePct", "minStake")
      SELECT
        m."id",
        'BTN',
        COALESCE(m."totalPool", 0),
        m."houseEdgePct",
        CASE WHEN m."externalSource" IN ('ter', 'btc') THEN 10 ELSE 50 END
      FROM "markets" m
      ON CONFLICT ("marketId", "currency") DO NOTHING
    `);

    await q.query(`
      INSERT INTO "outcome_books" ("outcomeId", "currency", "totalBetAmount", "currentOdds", "lmsrProbability")
      SELECT
        o."id",
        'BTN',
        COALESCE(o."totalBetAmount", 0),
        COALESCE(o."currentOdds", 0),
        COALESCE(o."lmsrProbability", 0)
      FROM "outcomes" o
      ON CONFLICT ("outcomeId", "currency") DO NOTHING
    `);

    // ── Currency onto the rest of the market money path ──────────────────────
    // Denormalised from the book so aggregations do not need a join, the same
    // way transactions.currency already works.
    for (const table of [
      "positions",
      "settlements",
      "revenue_distributions",
      "challenges",
      "disputes",
    ]) {
      await q.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "currency" varchar(10) NOT NULL DEFAULT 'BTN'`,
      );
    }
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_positions_currency" ON "positions" ("currency")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_settlements_market_currency" ON "settlements" ("marketId", "currency")`,
    );

    // ── Precision ────────────────────────────────────────────────────────────
    // USDT is 6dp; numeric(18,2) truncates it. Widening a numeric in Postgres
    // is a catalogue change, not a table rewrite.
    const widen: [string, string[]][] = [
      ["positions", ["amount", "payout"]],
      ["settlements", ["totalPool", "houseAmount", "payoutPool", "totalPaidOut"]],
      ["revenue_distributions", ["amount", "totalPool"]],
      ["challenges", ["wagerAmount"]],
      ["disputes", ["bondAmount", "rewardAmount"]],
      ["payments", ["amount"]],
    ];
    for (const [table, columns] of widen) {
      for (const column of columns) {
        await this.widenIfExists(q, table, column);
      }
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    const narrow: [string, string[]][] = [
      ["payments", ["amount"]],
      ["disputes", ["bondAmount", "rewardAmount"]],
      ["challenges", ["wagerAmount"]],
      ["revenue_distributions", ["amount", "totalPool"]],
      ["settlements", ["totalPool", "houseAmount", "payoutPool", "totalPaidOut"]],
      ["positions", ["amount", "payout"]],
    ];
    for (const [table, columns] of narrow) {
      for (const column of columns) {
        const [{ exists }] = await q.query(
          `SELECT EXISTS (
             SELECT 1 FROM information_schema.columns
             WHERE table_name = $1 AND column_name = $2
           ) AS exists`,
          [table, column],
        );
        if (!exists) continue;
        await q.query(
          `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE numeric(18,2)`,
        );
      }
    }

    await q.query(`DROP INDEX IF EXISTS "IDX_settlements_market_currency"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_positions_currency"`);
    for (const table of [
      "disputes",
      "challenges",
      "revenue_distributions",
      "settlements",
      "positions",
    ]) {
      await q.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "currency"`);
    }

    await q.query(`DROP TABLE IF EXISTS "outcome_books"`);
    await q.query(`DROP TABLE IF EXISTS "market_books"`);
    // NOTE: narrowing back to numeric(18,2) is lossless only while no USDT book
    // has been opened. Once one has, roll forward instead of down.
  }
}
