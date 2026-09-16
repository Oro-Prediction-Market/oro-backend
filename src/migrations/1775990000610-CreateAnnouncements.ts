import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Admin broadcasts, plus the indexes that make a table of them survivable.
 *
 * Each broadcast adds one `user_notifications` row per user. That is table
 * growth rather than per-user fan-out — twenty broadcasts is twenty extra rows
 * each — but it is what will finally make two long-standing query shapes hurt,
 * so they are fixed here rather than after the first slow page.
 */
export class CreateAnnouncements1775990000610 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await q.query(`
      CREATE TABLE IF NOT EXISTS "announcements" (
        "id"                 uuid NOT NULL DEFAULT uuid_generate_v4(),
        "clientRequestId"    varchar NOT NULL,
        "contentHash"        varchar(64) NOT NULL,
        "title"              varchar NOT NULL,
        "body"               text NOT NULL,
        "createdByAdminId"   uuid NOT NULL,
        "mode"               varchar NOT NULL DEFAULT 'live',
        "status"             varchar NOT NULL DEFAULT 'queued',
        "audienceCount"      integer NOT NULL DEFAULT 0,
        "telegramRecipients" integer NOT NULL DEFAULT 0,
        "enqueuedCount"      integer NOT NULL DEFAULT 0,
        "sentCount"          integer NOT NULL DEFAULT 0,
        "blockedCount"       integer NOT NULL DEFAULT 0,
        "failedCount"        integer NOT NULL DEFAULT 0,
        "failureSummary"     jsonb,
        "runtime"            jsonb,
        "error"              text,
        "startedAt"          timestamptz,
        "finishedAt"         timestamptz,
        "createdAt"          TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_announcements" PRIMARY KEY ("id")
      )
    `);

    // The idempotency key. A double-clicked Send, or a client that timed out and
    // retried, arrives with the same id and Postgres arbitrates rather than us.
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_announcements_clientRequestId"
         ON "announcements" ("clientRequestId")`,
    );
    // Backs the 10-minute identical-content cooldown.
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_announcements_contentHash"
         ON "announcements" ("contentHash")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_announcements_createdAt"
         ON "announcements" ("createdAt")`,
    );
    // At most ONE broadcast in flight, enforced by the database rather than by a
    // Redis lock — a lock can be lost to a restart or a FLUSHDB, and its TTL is
    // a guess about how long delivery takes. A unique index on a constant-true
    // expression over a partial predicate admits exactly one matching row.
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_announcements_one_active"
         ON "announcements" (("status" IS NOT NULL))
         WHERE "status" IN ('queued','sending')`,
    );

    // ── user_notifications: replace the lone userId index ───────────────────
    //
    // listAll() reads WHERE "userId"=$1 ORDER BY "createdAt" DESC LIMIT 30. With
    // only (userId) that means fetching every row the user has ever had, sorting
    // them, and discarding all but 30. The composite lets the scan stop at 30.
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_notifications_user_created"
         ON "user_notifications" ("userId", "createdAt")`,
    );
    // unreadCount() runs on every app open to draw the bell badge, and today it
    // heap-fetches every one of the user's rows just to test seenAt. This
    // partial index holds ONLY unread rows, so it stays small however large the
    // table grows.
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_notifications_unseen"
         ON "user_notifications" ("userId") WHERE "seenAt" IS NULL`,
    );
    // Now redundant: (userId, createdAt) serves every userId-only lookup on its
    // leftmost column. Dropping it removes an index write per row — 2,199 of
    // them per broadcast.
    await q.query(`DROP INDEX IF EXISTS "IDX_user_notifications_userId"`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_notifications_userId"
         ON "user_notifications" ("userId")`,
    );
    await q.query(`DROP INDEX IF EXISTS "IDX_user_notifications_unseen"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_user_notifications_user_created"`);
    await q.query(`DROP INDEX IF EXISTS "UQ_announcements_one_active"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_announcements_createdAt"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_announcements_contentHash"`);
    await q.query(`DROP INDEX IF EXISTS "UQ_announcements_clientRequestId"`);
    await q.query(`DROP TABLE IF EXISTS "announcements"`);
  }
}
