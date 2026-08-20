import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { User } from "./user.entity";

export enum KycDocumentType {
  PASSPORT = "passport",
  NATIONAL_ID = "national_id",
  DRIVERS_LICENCE = "drivers_licence",
}

export enum KycDocumentStatus {
  PENDING = "pending",
  APPROVED = "approved",
  REJECTED = "rejected",
}

/**
 * A KYC document submitted for manual review.
 *
 * Separate from `auth_methods` on purpose: identity is who you authenticate as,
 * KYC is proof of who you are. Conflating them means a resubmitted document
 * touches the auth path, which serves 1,300 live users who never go near this
 * queue.
 *
 * Everything here is sensitive PII belonging to people in jurisdictions with
 * erasure rights. Two rules follow, and neither is enforced by this file:
 * `documentNumber` is encrypted at rest, and `imageObjectKey` is a reference
 * into private object storage — never the image, never a public URL. Reviewer
 * access goes through short-lived signed URLs and is written to `audit_logs`.
 *
 * Never log either field. Master-plan decision 6 owns retention and deletion.
 */
@Index("IDX_user_kyc_documents_userId", ["userId"])
@Index("IDX_user_kyc_documents_status_submitted", ["status", "submittedAt"])
@Entity("user_kyc_documents")
export class UserKycDocument {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "userId" })
  user: User;

  @Column({ type: "enum", enum: KycDocumentType })
  documentType: KycDocumentType;

  /** Encrypted at rest. Never logged, never returned to a client. */
  @Column({ type: "varchar", length: 255 })
  documentNumber: string;

  /**
   * Keyed one-way hash of the normalised document number.
   *
   * Exists because the ciphertext above is unsearchable by design — a random
   * IV per value means the same passport never encrypts the same way twice.
   * This is what makes "has this document been used before" and "which account
   * holds this document" answerable, without the database ever storing a
   * readable number.
   *
   * Nullable for rows written before this column existed.
   */
  @Column({ type: "varchar", length: 64, nullable: true })
  @Index("IDX_user_kyc_documents_number_index")
  documentNumberIndex: string | null;

  /** ISO 3166-1 alpha-2. */
  @Column({ type: "varchar", length: 2 })
  documentCountry: string;

  /** Private object-storage key. Never the image, never a public URL. */
  @Column({ type: "varchar", length: 255 })
  imageObjectKey: string;

  @Column({
    type: "enum",
    enum: KycDocumentStatus,
    default: KycDocumentStatus.PENDING,
  })
  status: KycDocumentStatus;

  @Column({ type: "uuid", nullable: true })
  reviewedBy: string | null;

  @Column({ type: "timestamptz", nullable: true })
  reviewedAt: Date | null;

  @Column({ type: "varchar", length: 255, nullable: true })
  rejectionReason: string | null;

  @CreateDateColumn({ name: "submittedAt" })
  submittedAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
