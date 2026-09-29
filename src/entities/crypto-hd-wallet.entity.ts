import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";
import { User } from "./user.entity";

/**
 * A customer's permanent 21 Pay deposit address (Single HD wallet).
 *
 * One per user per network, handed out by
 * `POST /v1/customers/{end_user_id}/deposit-addresses` with our user id as
 * `end_user_id`. It never expires and accepts any amount, any number of times.
 *
 * This row is also how a deposit is tied back to a user when the webhook's
 * `end_user_id` is missing, so `(network, address)` is unique: an address that
 * resolved to two users could credit the wrong one.
 */
@Unique("UQ_crypto_deposit_addresses_user_network", ["userId", "network"])
@Unique("UQ_crypto_deposit_addresses_network_address", ["network", "address"])
@Entity("crypto_deposit_addresses")
export class CryptoDepositAddress {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "userId" })
  user: User;

  @Column({ type: "varchar", length: 16 })
  network: string;

  /** Tron base58 is case-sensitive; stored exactly as 21 Pay returned it. */
  @Column({ type: "varchar", length: 128 })
  address: string;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;
}

/**
 * One deposit to a permanent address, credited from the
 * `deposits.<net>.credited` webhook.
 *
 * `pay21IntentId` is the exactly-once key: 21 Pay creates a payment intent per
 * incoming transfer and tells us to credit once per `intent_id`. The row is
 * inserted before the credit is written, in the same transaction, so a
 * duplicate delivery finds it and stops.
 *
 * A deposit we could not attribute (unknown customer, or an address that
 * belongs to someone else) is still recorded, with `userId` null and
 * `needsReview` set — the money has arrived and must stay visible to an admin.
 */
@Unique("UQ_crypto_hd_deposits_pay21_intent", ["pay21IntentId"])
@Index("IDX_crypto_hd_deposits_user", ["userId", "createdAt"])
@Index("IDX_crypto_hd_deposits_review", ["needsReview"])
@Entity("crypto_hd_deposits")
export class CryptoHdDeposit {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", length: 64 })
  pay21IntentId: string;

  @Column({ type: "uuid", nullable: true })
  userId: string | null;

  @Column({ type: "varchar", length: 16 })
  network: string;

  @Column({ type: "varchar", length: 128, nullable: true })
  depositAddress: string | null;

  /** What arrived, converted once from base units. Never an expected amount. */
  @Column({ type: "decimal", precision: 28, scale: 9 })
  amountUsdt: number;

  @Column({ type: "varchar", length: 128, nullable: true })
  txHash: string | null;

  @Column({ type: "bigint", nullable: true })
  blockNumber: string | null;

  @Column({ type: "uuid", nullable: true })
  paymentId: string | null;

  @Column({ type: "uuid", nullable: true })
  transactionId: string | null;

  /** Set for an over-limit deposit (credited) or an unattributable one (not). */
  @Column({ type: "boolean", default: false })
  needsReview: boolean;

  @Column({ type: "varchar", length: 64, nullable: true })
  reviewReason: string | null;

  @Column({ type: "timestamptz", nullable: true })
  creditedAt: Date | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;
}
