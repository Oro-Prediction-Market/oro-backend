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
import { User } from "./user.entity";

@Entity("linked_bank_accounts")
@Index("IDX_lba_user_cid", ["userId", "cid"])
export class LinkedBankAccount {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "userId" })
  user: User;

  /** Bhutanese national CID (11-digit). Uniquely identifies the DK Bank customer. */
  @Index()
  @Column({ type: "varchar" })
  cid: string;

  /** DK Bank account number returned by client_inquiry. */
  @Column({ type: "varchar", nullable: true })
  accountNumber: string | null;

  /** Account holder name returned by client_inquiry. */
  @Column({ type: "varchar", nullable: true })
  accountName: string | null;

  /** Phone number registered at DK Bank for this CID. OTP is sent here during linking. */
  @Column({ type: "varchar", nullable: true })
  bankPhone: string | null;

  /** True once the user has successfully entered the OTP sent to their DK-registered phone. */
  @Column({ default: false })
  isVerified: boolean;

  /** True for the account used by default for deposits and withdrawals. */
  @Column({ default: false })
  isDefault: boolean;

  /** Number of OTP verification attempts (resets when a new OTP is requested). */
  @Column({ default: 0 })
  linkAttempts: number;

  @Column({ type: "timestamptz", nullable: true })
  verifiedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
