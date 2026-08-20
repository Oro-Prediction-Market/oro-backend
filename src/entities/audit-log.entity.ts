import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

export enum RoleType {
  ADMIN = "admin",
  USER = "user",
}

export enum AuditAction {
  // Market lifecycle
  MARKET_CREATE = "market.create",
  MARKET_UPDATE = "market.update",
  MARKET_DELETE = "market.delete",
  MARKET_TRANSITION = "market.transition",
  MARKET_PROPOSE = "market.propose",
  MARKET_RESOLVE = "market.resolve",
  MARKET_RESOLVE_DISPUTED = "market.resolve_disputed", // resolved while objections were open
  MARKET_RESOLUTION_OVERTURNED = "market.resolution_overturned", // admin changed outcome after objection — admin accountability event
  MARKET_AUTO_RESOLVED = "market.auto_resolved", // auto-settled by cron after clean window
  MARKET_DISPUTE = "market.dispute", // user raised an objection
  MARKET_CANCEL = "market.cancel",

  // Balance / financial
  BALANCE_CREDIT = "balance.credit", // manual admin credit (future)
  PAYMENT_VIEW = "payment.view",

  // User management
  USER_ADMIN_TOGGLE = "user.admin_toggle",
  USER_VIEW = "user.view",
  USER_LOGIN = "user.login",
  USER_LOGOUT = "user.logout",

  // Malpractice & Dispute resolution (GMC Authority)
  MALPRACTICE_VOTE_CREATE = "malpractice.vote.create",
  MALPRACTICE_VOTE_VALIDATE = "malpractice.vote.validate",
  MALPRACTICE_VOTE_REFUND = "malpractice.vote.refund",
  DISPUTE_RESOLUTION_CREATE = "dispute.resolution.create",
  DISPUTE_RESOLUTION_UPDATE = "dispute.resolution.update",
  DISPUTE_RESOLUTION_RESOLVE = "dispute.resolution.resolve",
  ADMIN_PENALTY_APPLY = "admin.penalty.apply",
  ADMIN_PENALTY_REVOKE = "admin.penalty.revoke",

  // Transaction audit actions
  // KYC review. VIEW is logged as well as the decisions: reading a passport
  // image is itself an access to sensitive PII and has to be attributable.
  KYC_DOCUMENT_VIEW = "kyc.document.view",
  KYC_DOCUMENT_APPROVE = "kyc.document.approve",
  KYC_DOCUMENT_REJECT = "kyc.document.reject",

  TRANSACTION_VERIFY = "transaction.verify",
  TRANSACTION_FLAG = "transaction.flag",
  TRANSACTION_REVIEW = "transaction.review",

  // Security events
  AUTH_FAIL_DKBANK = "auth.fail.dkbank", // wrong CID/password
  AUTH_FAIL_PWA = "auth.fail.pwa", // wrong PWA password
  AUTH_FAIL_TELEGRAM = "auth.fail.telegram", // tampered initData
  AUTH_TOKEN_REVOKED = "auth.token_revoked",

  // Batch payment
  BATCH_PAYMENT_LOGIN = "batch_payment.login",
  BATCH_PAYMENT_REFRESH_TOKEN = "batch_payment.refresh_token",
  BATCH_PAYMENT_PROCESSED = "batch_payment.processed",
  BATCH_PAYMENT_UPLOADED = "batch_payment.uploaded",
}

@Entity("audit_logs")
export class AuditLog {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** The admin user who performed the action */
  @Index()
  @Column()
  adminId: string;

  @Column({ type: "varchar", nullable: true })
  username: string;

  /** Role type of the user performing the action (admin or regular user) */
  @Column({ type: "varchar" })
  roleType: RoleType;

  /** What action was performed */
  @Column({ type: "varchar" })
  action: AuditAction | string;

  /** The entity type affected (market, user, payment, etc.) */
  @Column({ type: "varchar", nullable: true })
  entityType: string;

  /** The UUID of the affected entity */
  @Column({ type: "varchar", nullable: true })
  entityId: string;

  /**
   * Full snapshot:
   *  - before: state before the change
   *  - after:  state after the change
   *  - meta:   any extra context (IP, request body, etc.)
   */
  @Column({ type: "jsonb", nullable: true })
  payload: {
    before?: Record<string, any>;
    after?: Record<string, any>;
    meta?: Record<string, any>;
  };

  /** HTTP request IP address */
  @Column({ type: "varchar", nullable: true })
  ipAddress: string;

  @CreateDateColumn()
  createdAt: Date;
}
