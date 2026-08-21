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
  RESIDENCE_PERMIT = "residence_permit",
}

export enum KycDocumentStatus {
  PENDING = "pending",
  APPROVED = "approved",
  REJECTED = "rejected",
}


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
