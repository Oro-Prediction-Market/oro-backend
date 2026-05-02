import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from "typeorm";
import { Outcome } from "./outcome.entity";
import { Position } from "./position.entity";

export enum MarketStatus {
  UPCOMING = "upcoming",
  OPEN = "open",
  CLOSED = "closed",
  RESOLVING = "resolving",
  RESOLVED = "resolved",
  SETTLED = "settled",
  CANCELLED = "cancelled",
}

export enum MarketMechanism {
  PARIMUTUEL = "parimutuel",
}

export enum MarketCategory {
  SPORTS = "sports",
  POLITICS = "politics",
  WEATHER = "weather",
  ENTERTAINMENT = "entertainment",
  ECONOMY = "economy",
  OTHER = "other",
}

@Entity("markets")
export class Market {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column()
  title: string;

  @Column({ type: "text", nullable: true })
  description: string;

  @Column({ type: "varchar", nullable: true })
  imageUrl: string;

  @Column({ type: "varchar", nullable: true })
  imageUrlAlt: string;

  @Index()
  @Column({ type: "enum", enum: MarketStatus, default: MarketStatus.UPCOMING })
  status: MarketStatus;

  @Column({ type: "decimal", precision: 18, scale: 2, default: 0 })
  totalPool: number;

  @Column({ type: "decimal", precision: 5, scale: 2, default: 5 })
  houseEdgePct: number; // e.g. 5 = 5%

  @Column({
    type: "enum",
    enum: MarketMechanism,
    default: MarketMechanism.PARIMUTUEL,
  })
  mechanism: MarketMechanism;

  @Column({ type: "decimal", precision: 18, scale: 2, default: 1000 })
  liquidityParam: number; // LMSR 'b' parameter

  @Column({
    type: "enum",
    enum: MarketCategory,
    default: MarketCategory.OTHER,
  })
  category: MarketCategory;

  @Column({ type: "text", nullable: true })
  resolutionCriteria: string;

  @Column({ type: "uuid", nullable: true })
  resolvedOutcomeId: string;

  @Column({ type: "uuid", nullable: true })
  proposedOutcomeId: string;

  @Column({ type: "timestamptz", nullable: true })
  disputeDeadlineAt: Date;

  @Column({ type: "timestamptz", nullable: true })
  opensAt: Date;

  @Column({ type: "timestamptz", nullable: true })
  closesAt: Date;

  @Column({ type: "timestamptz", nullable: true })
  resolvedAt: Date;

  // ─── Evidence / Resolution Transparency ──────────────────────────────────
  /** Public URL to the evidence used for this resolution (screenshot, API result, official page) */
  @Column({ type: "varchar", nullable: true })
  evidenceUrl: string | null;

  /** Admin's plain-language explanation of how the evidence determines the winner */
  @Column({ type: "text", nullable: true })
  evidenceNote: string | null;

  /** When the evidence was published (= resolvedAt in most cases, stored separately for clarity) */
  @Column({ type: "timestamptz", nullable: true })
  evidenceSubmittedAt: Date | null;

  /** ID of the admin who performed the final resolution (not the proposer) */
  @Column({ type: "varchar", nullable: true })
  resolvedByAdminId: string | null;

  /**
   * Objection window length in minutes. Set at propose time, default 60 min.
   * Allowed values: 10, 20, 30, 60, 120.
   */
  @Column({ type: "int", default: 60 })
  windowMinutes: number;

  /**
   * Running total of forfeited bonds from wrong objectors.
   * Distributed to correct objectors when the market is resolved.
   */
  @Column({ type: "decimal", precision: 18, scale: 2, default: 0 })
  disputeBondPool: number;

  /** football-data.org match ID — set when a market is created from a fixture */
  @Column({ type: "int", nullable: true })
  externalMatchId: number | null;

  /** Source identifier, e.g. "football-data.org" */
  @Column({ type: "varchar", length: 64, nullable: true })
  externalSource: string | null;

  /** market type for auto-resolution: "match-winner" | "over-under" */
  @Column({ type: "varchar", length: 32, nullable: true })
  externalMarketType: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => Outcome, (o) => o.market, { cascade: true, eager: true })
  outcomes: Outcome[];

  @OneToMany(() => Position, (p) => p.market)
  positions: Position[];
}
