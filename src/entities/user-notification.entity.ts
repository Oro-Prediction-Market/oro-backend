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
@Entity("user_notifications")
export class UserNotification {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
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
