import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Fee standardisation (boss review #6): Oro's platform fee is a flat 10% for all
 * markets. An older migration created markets."houseEdgePct" with a DEFAULT of 5,
 * which drifted from the entity default (10). This aligns the column default to
 * 10 so a market inserted without an explicit edge gets the canonical fee even
 * when TypeORM synchronize is off.
 *
 * Only the column DEFAULT changes — existing rows keep whatever edge they already
 * have, so no live market's fee is retroactively altered.
 */
export class AlignHouseEdgeDefault1775990000300 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "markets" ALTER COLUMN "houseEdgePct" SET DEFAULT 10;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "markets" ALTER COLUMN "houseEdgePct" SET DEFAULT 5;
    `);
  }
}
