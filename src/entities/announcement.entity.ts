import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

export type AnnouncementMode = "live" | "test";

export type AnnouncementStatus =
  | "queued"
  | "sending"
  | "completed"
  | "completed_with_failures"
  | "failed"
  /** The fan-out guard refused this attempt — see {@link Announcement.runtime}. */
  | "blocked";

/**
 * One admin broadcast: a notice written in the dashboard and sent to every user,
 * in-app and by Telegram DM.
 *
 * The row is not just a log. It is the idempotency anchor for the whole
 * operation — a broadcast cannot be sent twice because the database will not
 * allow a second row to claim the same request, and the worker cannot re-run a
 * fan-out because it claims this row's status with a compare-and-swap before
 * doing any work. Delete this table and the feature loses its safety, not just
 * its history.
 */
@Entity("announcements")
export class Announcement {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /**
   * Minted by the dashboard when the compose form OPENS, not when Send is
   * clicked — one opened form is one intent, however many times the button is
   * pressed. Unique, so Postgres arbitrates a double-click rather than us.
   */
  @Index({ unique: true })
  @Column({ type: "varchar" })
  clientRequestId: string;

  /**
   * sha256(title + "\n" + body). Catches the retry the request id cannot: an
   * admin who reloads the page and retypes the same notice because the first
   * attempt "looked stuck".
   */
  @Index()
  @Column({ type: "varchar", length: 64 })
  contentHash: string;

  @Column({ type: "varchar" })
  title: string;

  @Column({ type: "text" })
  body: string;

  /** No FK, matching the convention on user_notifications.userId. */
  @Column({ type: "uuid" })
  createdByAdminId: string;

  @Column({ type: "varchar", default: "live" })
  mode: AnnouncementMode;

  @Column({ type: "varchar", default: "queued" })
  status: AnnouncementStatus;

  /** In-app rows actually written. */
  @Column({ type: "int", default: 0 })
  audienceCount: number;

  /** Distinct deliverable Telegram chat ids — always ≤ audienceCount. */
  @Column({ type: "int", default: 0 })
  telegramRecipients: number;

  @Column({ type: "int", default: 0 })
  enqueuedCount: number;

  @Column({ type: "int", default: 0 })
  sentCount: number;

  /**
   * Recipients who have blocked the bot or never started it (Telegram 403).
   * Counted apart from failures on purpose: this number is normally 5-20% and
   * means the feature is working, not breaking.
   */
  @Column({ type: "int", default: 0 })
  blockedCount: number;

  /** Real failures — rate limits, Telegram outages, malformed payloads. */
  @Column({ type: "int", default: 0 })
  failedCount: number;

  /** `{ byCode: { "403": 214 }, samples: [{ code, description }] }` */
  @Column({ type: "jsonb", nullable: true })
  failureSummary: Record<string, any> | null;

  /**
   * Which machine sent this: `{ nodeEnv, inCluster, botId, hostname, at }`.
   * Written for blocked attempts too, so a laptop that tried leaves a trace.
   */
  @Column({ type: "jsonb", nullable: true })
  runtime: Record<string, any> | null;

  @Column({ type: "text", nullable: true })
  error: string | null;

  @Column({ type: "timestamptz", nullable: true })
  startedAt: Date | null;

  @Column({ type: "timestamptz", nullable: true })
  finishedAt: Date | null;

  @Index()
  @CreateDateColumn()
  createdAt: Date;
}
