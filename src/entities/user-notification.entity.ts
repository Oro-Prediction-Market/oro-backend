import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * A per-user in-app notification. Surfaced as a one-time popup the next time the
 * user opens Oro (TMA or PWA), then marked seen so it doesn't show again.
 * System-generated only for now (e.g. season prize wins).
 */
// Composite rather than a bare @Index() on userId: the list query orders by
// createdAt and takes 30, which with a userId-only index means reading every row
// the user has ever had and sorting them. The plain userId index was dropped in
// 1775990000610 — this one serves those lookups on its leftmost column. Keeping
// both declared here would let DB_SYNCHRONIZE recreate the dropped one locally
// and drift dev from prod.
@Index(["userId", "createdAt"])
@Entity("user_notifications")
export class UserNotification {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column("uuid")
  userId: string;

  /** e.g. "season_prize" | "system" — lets the client pick an icon/treatment. */
  @Column({ type: "varchar", default: "system" })
  type: string;

  @Column({ type: "varchar" })
  title: string;

  @Column({ type: "text" })
  body: string;

  /** Optional structured payload (e.g. { rank, prize, month }). */
  @Column({ type: "jsonb", nullable: true })
  metadata: Record<string, any> | null;

  /** Null until the user has seen the popup. */
  @Column({ type: "timestamptz", nullable: true })
  seenAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
