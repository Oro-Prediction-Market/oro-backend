import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * An index for replaying a market's price history from its bets.
 *
 * The probability chart no longer reads the snapshot table — it sums the stakes
 * placed up to each instant, which means one query per market detail page that
 * asks for "every position on this market, in time order". `positions` had
 * (userId, marketId), (placedAt) and (currency), none of which lead with
 * marketId, so Postgres scanned the composite index on its second column and
 * then sorted — and estimated 12 rows where the busiest market has 1,080.
 *
 * Declared on the entity as well as here. TypeORM's synchronize drops any index
 * it cannot find in entity metadata, so a migration-only index would survive
 * until the next sync and then vanish.
 */
export class AddPositionMarketPlacedAtIndex1775990000570
  implements MigrationInterface
{
  name = "AddPositionMarketPlacedAtIndex1775990000570";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_positions_market_placedAt" ON "positions" ("marketId", "placedAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_positions_market_placedAt"`,
    );
  }
}
