import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * What happens to the people the wrong result paid.
 *  - clawback: their payout is taken back.
 *  - keep: they keep it, and the house pays the right side on top.
 */
export type CorrectionMode = "clawback" | "keep";

/** One corrected settlement; see migration 1775990000690. */
@Entity("settlement_corrections")
@Index("IDX_settlement_corrections_market", ["marketId", "createdAt"])
@Check("CHK_settlement_corrections_mode", `"mode" IN ('clawback', 'keep')`)
export class SettlementCorrection {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column("uuid")
  marketId: string;

  @Column("uuid")
  fromOutcomeId: string;

  @Column("uuid")
  toOutcomeId: string;

  @Column({ type: "varchar", length: 16 })
  mode: CorrectionMode;

  @Column({ type: "text" })
  note: string;

  @Column("uuid")
  adminId: string;

  /** Per book and per user: what moved. */
  @Column({ type: "jsonb" })
  summary: Record<string, unknown>;

  /** Every row the correction rewrote or deleted, as it was before. */
  @Column({ type: "jsonb" })
  snapshot: Record<string, unknown>;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;
}
