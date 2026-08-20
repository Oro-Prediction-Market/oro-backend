import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from "typeorm";
import { Outcome } from "./outcome.entity";

@Unique("UQ_outcome_books_outcome_currency", ["outcomeId", "currency"])
@Index("IDX_outcome_books_outcomeId", ["outcomeId"])
@Entity("outcome_books")
export class OutcomeBook {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  outcomeId: string;

  @ManyToOne(() => Outcome, { onDelete: "CASCADE" })
  @JoinColumn({ name: "outcomeId" })
  outcome: Outcome;

  @Column({ type: "varchar", length: 10 })
  currency: string;

  @Column({ type: "decimal", precision: 28, scale: 9, default: 0 })
  totalBetAmount: number;

  @Column({ type: "decimal", precision: 10, scale: 4, default: 0 })
  currentOdds: number;

  @Column({ type: "decimal", precision: 10, scale: 6, default: 0 })
  lmsrProbability: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
