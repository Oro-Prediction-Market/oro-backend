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

export enum DisputeSide {
  /** Challenges the proposed outcome — claims the admin's proposal is wrong. */
  OBJECT = "object",
  /** Defends the proposed outcome against objectors — claims it is right. */
  SUPPORT = "support",
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
   * Which side of the resolution contest this participant is on.
   * OBJECT = challenges the proposal, SUPPORT = defends it against objectors.
   */
  @ApiProperty({
    enum: DisputeSide,
    description: "OBJECT challenges the proposal; SUPPORT defends it",
  })
  @Column({ type: "enum", enum: DisputeSide, default: DisputeSide.OBJECT })
  side: DisputeSide;

  /**
   * The bond this participant locked. The first objector chooses the amount
   * (minimum Nu 10); every later participant on either side must match it
   * exactly, so all stakes in one contest are equal. Forfeited if their side
   * loses, returned + rewarded (a share of the losing side's bonds) if it wins.
   */
  @ApiProperty({
    example: 50,
    description: "BTN bond locked with this objection",
  })
  @Column({ type: "decimal", precision: 28, scale: 9, default: 0 })
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

  /**
   * Reward paid to this participant on top of the returned bond when their side
   * won — a share of the losing side's forfeited bonds, or (when the admin was
   * overturned with no defenders) a share of the house cut. Excludes the bond
   * itself, which is returned separately. 0 for losing/pending/unrewarded rows.
   */
  @ApiProperty({
    example: 25,
    description: "BTN reward paid on top of the returned bond when this side won",
  })
  @Column({ type: "decimal", precision: 28, scale: 9, default: 0 })
  rewardAmount: number;

  @ApiProperty()

  /**
   * Denormalised from the market's book so aggregations need no join, the same
   * way transactions.currency works. Never disagrees with the book it belongs
   * to; Stage I reconciliation asserts that.
   */
  @Column({ type: "varchar", length: 10, default: "BTN" })
  currency: string;

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
