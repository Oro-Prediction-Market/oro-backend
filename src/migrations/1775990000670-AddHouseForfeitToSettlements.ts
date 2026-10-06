import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Separates forfeited dispute bonds from the house edge.
 *
 * `settlements.houseAmount` is a residual: whatever is left of the pool once
 * winners are paid, PLUS any dispute bonds forfeited by losing objectors. The
 * revenue table reported the edge as `houseAmount / totalPool`, which blends
 * the two — and a forfeit was never pool money. A 10% market that had taken a
 * single Nu 10 bond reported 11.11%.
 *
 * That is the number someone would reach for to check the edge was being
 * applied correctly, so it reading high is worse than merely untidy. Three of
 * the four rows above 10% in production were exactly this; the fourth was a
 * market genuinely configured at 15%, which is a different conversation.
 *
 * The settlement already preserved the identity
 *   totalPool === totalPaidOut + challengerRewardPaid + (houseAmount − houseForfeit)
 * but the forfeit was only recoverable by subtraction, which also swept up
 * rounding breakage (one production row implied a "forfeit" of Nu 0.03 that
 * was nothing of the sort). Storing it makes the split a fact.
 *
 * Existing rows default to 0. Their forfeits are NOT back-fillable — the
 * arithmetic cannot tell a bond from rounding breakage, which is the whole
 * reason for the column — so historical `houseEdgePct` values stay as they
 * were written. New settlements are exact.
 */
export class AddHouseForfeitToSettlements1775990000650
  implements MigrationInterface
{
  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "settlements"
         ADD COLUMN IF NOT EXISTS "houseForfeit" numeric(28,9) NOT NULL DEFAULT 0`,
    );
    await q.query(
      `ALTER TABLE "revenue_distributions"
         ADD COLUMN IF NOT EXISTS "houseForfeit" numeric(28,9) NOT NULL DEFAULT 0`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "revenue_distributions" DROP COLUMN IF EXISTS "houseForfeit"`,
    );
    await q.query(
      `ALTER TABLE "settlements" DROP COLUMN IF EXISTS "houseForfeit"`,
    );
  }
}
