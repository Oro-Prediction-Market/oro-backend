import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Which 21 Pay API a withdrawal went through: `destination` (`/v1/withdrawals`,
 * whitelisted at 21 Pay) or `customer_payout` (`/v1/customer-payouts`, Single
 * HD wallet). Existing rows are all `destination`.
 *
 * See docs/usdt-oro/STAGE-J-HD-WALLET.md §4.4.
 */
export class AddKindToCryptoWithdrawals1775990000660
  implements MigrationInterface
{
  name = "AddKindToCryptoWithdrawals1775990000660";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "crypto_withdrawals"
        ADD COLUMN IF NOT EXISTS "kind" varchar(24) NOT NULL DEFAULT 'destination'
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "crypto_withdrawals" DROP COLUMN IF EXISTS "kind"`);
  }
}
