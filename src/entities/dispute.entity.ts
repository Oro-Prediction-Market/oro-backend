import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { User } from "./user.entity";
import { Market } from "./market.entity";

export enum DisputeBondStatus {
  /** Bond has been locked, outcome not yet finalised */
  LOCKED = "locked",
  /** Objector was right — bond returned + reward paid */
  REWARDED = "rewarded",
  /** Objector was wrong — bond forfeited to reward pool */
  FORFEITED = "forfeited",
  /** Market auto-resolved (zero objections) — not applicable */
  NOT_APPLICABLE = "not_applicable",
}

@Index(["userId"])
@Index(["bondStatus"])
@Entity("disputes")
export class Dispute {
  @ApiProperty({ example: "uuid" })
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @ApiProperty({
    example: "The outcome shown on the live stream was different",
    description: "Reason the user is objecting to the proposed outcome",
  })
  @Column({ type: "text" })
  reason: string;

  @ApiPropertyOptional({
    example: true,
    description:
      "Set after admin finalises resolution: true = admin agreed with the objector, false = objection overruled",
  })
  @Column({ type: "boolean", nullable: true, default: null })
  upheld: boolean | null;

  /**
   * The bond the objector locked when raising this objection.
   * Calculated as max(10, 2% of their position in this market).
   * Forfeited if wrong, returned + rewarded if right.
   */
  @ApiProperty({
    example: 50,
    description: "BTN bond locked with this objection",
  })
  @Column({ type: "decimal", precision: 18, scale: 2, default: 0 })
  bondAmount: number;

  @ApiProperty({
    enum: DisputeBondStatus,
    description: "Current state of the locked bond",
  })
  @Column({
    type: "enum",
    enum: DisputeBondStatus,
    default: DisputeBondStatus.LOCKED,
  })
  bondStatus: DisputeBondStatus;

  @ApiProperty()
  @CreateDateColumn()
  createdAt: Date;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn()
  user: User;

  @ApiProperty()
  @Column()
  userId: string;

  @ManyToOne(() => Market, { onDelete: "CASCADE" })
  @JoinColumn()
  market: Market;

  @ApiProperty()
  @Column()
  marketId: string;
}
