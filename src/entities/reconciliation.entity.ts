import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

export enum ReconciliationStatus {
  PENDING = "pending",
  MATCHED = "matched",
  MISMATCH = "mismatch",
  CORRECTED = "corrected",
}

export enum ReconciliationType {
  SETTLEMENT = "settlement",
  DEPOSIT = "deposit",
  WITHDRAWAL = "withdrawal",
  REFUND = "refund",
}

@Entity("reconciliations")
export class Reconciliation {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ type: "uuid" })
  userId: string;

  @Index()
  @Column({ type: "uuid", nullable: true })
  marketId: string;

  @Index()
  @Column({ type: "uuid", nullable: true })
  positionId: string;

  @Index()
  @Column({ type: "uuid", nullable: true })
  settlementId: string;

  @Column({ type: "enum", enum: ReconciliationType })
  type: ReconciliationType;

  @Column({
    type: "enum",
    enum: ReconciliationStatus,
    default: ReconciliationStatus.PENDING,
  })
  status: ReconciliationStatus;

  // Expected amounts (calculated from settlement logic)
  @Column({ type: "decimal", precision: 20, scale: 9 })
  expectedAmount: number;

  // Actual amounts (from transaction records)
  @Column({ type: "decimal", precision: 20, scale: 9 })
  actualAmount: number;

  // Difference
  @Column({ type: "decimal", precision: 20, scale: 9 })
  difference: number;

  // Balance checks
  @Column({ type: "decimal", precision: 20, scale: 9, nullable: true })
  balanceBeforeExpected: number;

  @Column({ type: "decimal", precision: 20, scale: 9, nullable: true })
  balanceAfterExpected: number;

  @Column({ type: "decimal", precision: 20, scale: 9, nullable: true })
  balanceBeforeActual: number;

  @Column({ type: "decimal", precision: 20, scale: 9, nullable: true })
  balanceAfterActual: number;

  // DK Bank transfer reconciliation
  @Column({ type: "varchar", nullable: true })
  dkTransferId: string;

  @Column({ type: "varchar", nullable: true })
  dkStatus: string;

  @Column({ type: "decimal", precision: 20, scale: 9, nullable: true })
  dkTransferAmount: number;

  // Details and resolution
  @Column({ type: "jsonb", nullable: true })
  details: {
    marketTitle?: string;
    outcomeLabel?: string;
    betAmount?: number;
    odds?: number;
    houseEdge?: number;
    winnerPoolShare?: number;
    bonusCapped?: boolean;
    transactionIds?: string[];
    errorMessages?: string[];
  };

  @Column({ type: "text", nullable: true })
  notes: string;

  @Column({ type: "text", nullable: true })
  resolutionAction: string;

  @Column({ type: "uuid", nullable: true })
  correctionTransactionId: string;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: "timestamp", nullable: true })
  resolvedAt: Date;
}
