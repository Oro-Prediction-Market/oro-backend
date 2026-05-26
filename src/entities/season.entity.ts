import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from "typeorm";

export enum SeasonStatus {
  ACTIVE = "active",
  CLOSED = "closed",
}

@Entity("seasons")
export class Season {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "int" })
  weekNumber: number; // month number (1–12); column name kept for backwards compatibility

  @Column({ type: "int" })
  year: number;

  @Column({ type: "timestamptz" })
  startsAt: Date;

  @Column({ type: "timestamptz" })
  endsAt: Date;

  @Column({ type: "varchar", default: SeasonStatus.ACTIVE })
  status: SeasonStatus;

  /** Snapshot of top-10 at close: [{ userId, rank, reputationScore, winRate }] */
  @Column({ type: "jsonb", nullable: true })
  winnersSnapshot: Record<string, any>[] | null;

  @CreateDateColumn()
  createdAt: Date;
}
