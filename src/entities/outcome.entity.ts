import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  OneToMany,
} from "typeorm";
import { Market } from "./market.entity";
import { Position } from "./position.entity";

@Entity("outcomes")
export class Outcome {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column()
  label: string;

  @Column({ type: "varchar", nullable: true })
  imageUrl: string | null;

  @Column({ type: "decimal", precision: 18, scale: 2, default: 0 })
  totalBetAmount: number;

  // Calculated odds = (totalPool * (1 - houseEdge)) / outcomePool
  @Column({ type: "decimal", precision: 10, scale: 4, default: 0 })
  currentOdds: number;

  // LMSR probability for improved odds display (0.0 to 1.0)
  @Column({ type: "decimal", precision: 10, scale: 6, default: 0 })
  lmsrProbability: number;

  @Column({ default: false })
  isWinner: boolean;

  @ManyToOne(() => Market, (m) => m.outcomes, { onDelete: "CASCADE" })
  @JoinColumn()
  market: Market;

  @Column()
  marketId: string;

  @OneToMany(() => Position, (p) => p.outcome)
  positions: Position[];
}
