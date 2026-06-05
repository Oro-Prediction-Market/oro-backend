import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import { User } from "../../entities/user.entity";

export enum AmlAlertType {
  RAPID_DEPOSIT_WITHDRAWAL = "rapid_deposit_withdrawal",
  LOW_GAMBLING_RATIO = "low_gambling_ratio",
  HIGH_TRANSACTION_FREQUENCY = "high_transaction_frequency",
  NEAR_LIMIT_DEPOSITS = "near_limit_deposits",
}

export enum AmlRiskLevel {
  LOW = "low",
  MEDIUM = "medium",
  HIGH = "high",
}

@Entity("aml_alerts")
export class AmlAlert {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ type: "uuid" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn()
  user: User;

  @Column({ type: "varchar" })
  alertType: AmlAlertType;

  @Column({ type: "varchar" })
  riskLevel: AmlRiskLevel;

  @Column({ type: "text" })
  description: string;

  @Column({ type: "jsonb", nullable: true })
  metadata: Record<string, any> | null;

  @Column({ type: "decimal", precision: 20, scale: 2, nullable: true })
  totalAmount: number | null;

  @Column({ type: "int", nullable: true })
  transactionCount: number | null;

  @Column({ default: false })
  isResolved: boolean;

  @Column({ type: "text", nullable: true })
  resolution: string | null;

  @Column({ type: "uuid", nullable: true })
  resolvedBy: string | null;

  @Column({ type: "timestamptz", nullable: true })
  resolvedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
