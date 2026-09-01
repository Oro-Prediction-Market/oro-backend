import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Move the resolution contest's bond terms from the market onto its books.
 *
 * A contest is settled inside the book its bonds were locked in: the winning
 * side is paid from the losing side's forfeited bonds, and an overturned
 * proposal with no defenders is rewarded from that book's house cut. Both are
 * same-currency operations, so the agreed per-head bond and the forfeited pool
 * belong per book. Held on `markets` they could only ever describe one cohort,
 * which is why objections were ngultrum-only.
 *
 * `markets.disputeBondAmount` / `disputeBondPool` are deliberately left in
 * place, not dropped:
 *
 *   - every historical value is already correct as the BTN figure it always
 *     was, and the backfill below copies it onto the BTN book rather than
 *     recomputing it
 *   - no production path writes them after this migration, so they cannot
 *     drift (the dev seeder still sets the legacy column; it is inert)
 *   - dropping money columns whose rows are the audit trail for settled
 *     markets is not worth the tidiness
 *
 * `disputes.currency` already exists as `NOT NULL DEFAULT 'BTN'` from
 * `1775990000340-AddMarketBooks`, so every pre-existing bond is already
 * correctly labelled ngultrum and needs no backfill of its own.
 */
export class AddPerBookDisputeBonds1775990000450 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    // Precision matches the other money columns on market_books (28,9) so a
    // 6dp USDT bond is not silently truncated.
    await q.query(
      `ALTER TABLE "market_books"
       ADD COLUMN IF NOT EXISTS "disputeBondAmount" numeric(28,9)`,
    );
    await q.query(
      `ALTER TABLE "market_books"
       ADD COLUMN IF NOT EXISTS "disputeBondPool" numeric(28,9) NOT NULL DEFAULT 0`,
    );

    // ── Backfill the BTN book from the market it mirrors ──────────────────────
    // BTN only: every bond that exists today was locked in ngultrum, so copying
    // these onto a USDT book would assert a contest that never happened.
    // Guarded on the source column existing (a database that predates the
    // dispute work has neither) and written with IS DISTINCT FROM so a re-run
    // is a no-op.
    const [{ exists: hasLegacyColumns }] = await q.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'markets' AND column_name = 'disputeBondAmount'
       ) AS exists`,
    );
    if (!hasLegacyColumns) return;

    await q.query(
      `UPDATE "market_books" b
          SET "disputeBondAmount" = m."disputeBondAmount",
              "disputeBondPool"   = COALESCE(m."disputeBondPool", 0)
         FROM "markets" m
        WHERE b."marketId" = m."id"
          AND b."currency" = 'BTN'
          AND (
                b."disputeBondAmount" IS DISTINCT FROM m."disputeBondAmount"
             OR b."disputeBondPool"   IS DISTINCT FROM COALESCE(m."disputeBondPool", 0)
              )`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    // The market-level columns were never dropped and nothing wrote to them
    // after `up`, so they are still the ngultrum truth for every market settled
    // before this migration. Dropping these two is therefore lossless for BTN;
    // a USDT contest opened in the meantime is not representable on `markets`
    // and its bond terms would be lost — roll forward instead of down once one
    // exists.
    await q.query(
      `ALTER TABLE "market_books" DROP COLUMN IF EXISTS "disputeBondPool"`,
    );
    await q.query(
      `ALTER TABLE "market_books" DROP COLUMN IF EXISTS "disputeBondAmount"`,
    );
  }
}
