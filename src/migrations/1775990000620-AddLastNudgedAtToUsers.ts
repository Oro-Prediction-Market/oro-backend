import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * A hard floor on how often one user can be sent a win-back nudge.
 *
 * `reengagementStage` was the only guard, and `placePosition` clears it on every
 * bet — so it only ever prevented repeats within a single quiet spell. Anyone
 * whose rhythm was slower than the lowest rung got the same "you have gone
 * quiet" DM on a permanent loop while predicting the whole time. This column
 * does not reset when they predict, which is the entire point of it.
 */
export class AddLastNudgedAtToUsers1775990000620 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lastNudgedAt" TIMESTAMP WITH TIME ZONE`,
    );

    // Backfill from the ladder state that already exists, so the cooldown is in
    // force from the moment this deploys rather than fourteen days later.
    // Anyone mid-ladder has been nudged at some point; without this they would
    // all be immediately eligible again and the fix would let through exactly
    // the wave of DMs it exists to prevent. `lastActiveAt` is the best available
    // proxy for when that happened, and erring recent is the safe direction.
    await q.query(
      `UPDATE "users"
          SET "lastNudgedAt" = COALESCE("lastActiveAt", now())
        WHERE "reengagementStage" IS NOT NULL
          AND "lastNudgedAt" IS NULL`,
    );

    // The job filters on this on every run, across the whole table. Partial:
    // only rows that have actually been nudged are of interest, and NULL means
    // "never nudged", which the query treats as always eligible.
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_users_lastNudgedAt"
         ON "users" ("lastNudgedAt") WHERE "lastNudgedAt" IS NOT NULL`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_users_lastNudgedAt"`);
    await q.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "lastNudgedAt"`);
  }
}
