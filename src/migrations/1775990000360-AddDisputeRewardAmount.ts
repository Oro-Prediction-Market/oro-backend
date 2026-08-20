import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * `disputes.rewardAmount` has been on the entity (and written by the parimutuel
 * engine) since the resolution contest shipped, but no migration ever created
 * it — a database built purely from migrations blows up on every dispute query
 * with `column Dispute.rewardAmount does not exist`.
 *
 * Created at the widened money precision (28,9) so it matches what
 * `1775990000340-AddMarketBooks` leaves the other dispute money columns at.
 * Databases that already have the column (built by an old `synchronize` run)
 * keep it — 340 has already widened those.
 */
export class AddDisputeRewardAmount1775990000360 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "disputes"
       ADD COLUMN IF NOT EXISTS "rewardAmount" numeric(28,9) NOT NULL DEFAULT 0`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "disputes" DROP COLUMN IF EXISTS "rewardAmount"`,
    );
  }
}
