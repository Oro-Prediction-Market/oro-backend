import {
  BadRequestException,
  ServiceUnavailableException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { User, KycStatus } from "../entities/user.entity";
import {
  KycDocumentStatus,
  KycDocumentType,
  UserKycDocument,
} from "../entities/user-kyc-document.entity";
import { AuditService } from "../admin/audit.service";
import { AuditAction } from "../entities/audit-log.entity";
import {
  blindIndex,
  decryptPii,
  encryptPii,
  maskPii,
} from "../shared/utils/pii-crypto.util";
import { KycDocumentStorage } from "./kyc-document-storage";

/** How long a reviewer's link to an image stays valid. */
const SIGNED_URL_TTL_SECONDS = 5 * 60;

/**
 * Document KYC: submission, review, and the account status that gates funding.
 *
 * The gate is on **deposit**, not withdrawal. Blocking withdrawal would mean
 * taking money from someone we might then refuse to pay, which is the worst
 * position to be in both legally and reputationally. Blocking deposit means a
 * rejected applicant simply never funded an account and nothing is in limbo.
 *
 * Nothing here logs a document number or an object key. Both are in
 * `redact.util.ts`'s remit and neither has any business in a log line.
 */
@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);

  constructor(
    @InjectRepository(UserKycDocument)
    private readonly docRepo: Repository<UserKycDocument>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly storage: KycDocumentStorage,
  ) {}

  /**
   * Submit an identity document for review.
   *
   * Requires a verified email. Without that check the queue fills with
   * documents belonging to addresses nobody controls, and a reviewer spends
   * their time on submissions that can never be contacted.
   */
  /**
   * What a document image is allowed to be.
   *
   * JPEG, PNG and WebP only — a reviewer needs to look at a photograph, and
   * anything else arriving here is either a mistake or an attempt to store
   * something that is not one. Notably not PDF: it can carry script and
   * embedded files, and a reviewer opening one is a different risk entirely.
   */
  private static readonly ALLOWED_IMAGE_TYPES = [
    "image/jpeg",
    "image/png",
    "image/webp",
  ];

  /**
   * 4 MB decoded.
   *
   * Phone cameras produce 3–8 MB, so the client downscales before sending.
   * This is the backstop for a client that does not, set above what a
   * legible document photo needs and below what would let anyone use the
   * review queue as free storage.
   */
  private static readonly MAX_IMAGE_BYTES = 4 * 1024 * 1024;

  async submit(
    userId: string,
    input: {
      documentType: KycDocumentType;
      documentNumber: string;
      documentCountry: string;
      image: Buffer;
      mimeType: string;
    },
  ): Promise<{ status: KycStatus }> {
    const user = await this.userRepo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException("User not found");

    if (!user.emailVerifiedAt) {
      throw new BadRequestException(
        "Verify your email address before submitting documents",
      );
    }
    if (user.kycStatus === KycStatus.APPROVED) {
      throw new BadRequestException("Your account is already verified");
    }
    if (user.kycStatus === KycStatus.PENDING) {
      throw new BadRequestException(
        "You already have a document under review",
      );
    }
    if (!input.documentNumber?.trim()) {
      throw new BadRequestException("Document number is required");
    }
    if (!/^[A-Za-z]{2}$/.test(input.documentCountry ?? "")) {
      throw new BadRequestException("Country must be a two-letter code");
    }
    if (!Object.values(KycDocumentType).includes(input.documentType)) {
      throw new BadRequestException("Choose a document type");
    }
    if (!KycService.ALLOWED_IMAGE_TYPES.includes(input.mimeType)) {
      throw new BadRequestException(
        "The document image must be a JPEG, PNG or WebP photograph",
      );
    }
    if (!input.image?.length) {
      throw new BadRequestException("A photograph of the document is required");
    }
    if (input.image.length > KycService.MAX_IMAGE_BYTES) {
      throw new BadRequestException(
        "That image is too large. Please send one under 4 MB.",
      );
    }
    // The declared type is not evidence; check the bytes. A mismatch means the
    // header was set by hand, which is the only way this happens by accident.
    if (!KycService.looksLikeImage(input.image, input.mimeType)) {
      throw new BadRequestException(
        "That file is not the image type it claims to be",
      );
    }

    // Encrypt before anything touches the database, and index in the same
    // breath. Both throw when their key is missing rather than falling back to
    // plaintext or to an unsearchable row.
    //
    // A missing key is a deployment fault, not a bad request, so it surfaces as
    // "unavailable" with the detail in the log. A bare 500 here reads as a code
    // bug and sends whoever is on call looking in the wrong place.
    let encrypted: string;
    let numberIndex: string;
    try {
      encrypted = encryptPii(input.documentNumber.trim());
      numberIndex = blindIndex(input.documentNumber.trim());
    } catch (err) {
      this.logger.error(
        `[KYC] Cannot accept documents: ${(err as Error).message}`,
      );
      throw new ServiceUnavailableException(
        "Identity verification is temporarily unavailable. Please try again later.",
      );
    }
    const objectKey = await this.storage.put(
      userId,
      input.image,
      input.mimeType,
    );

    await this.dataSource.transaction(async (em) => {
      await em.save(
        UserKycDocument,
        em.create(UserKycDocument, {
          userId,
          documentType: input.documentType,
          documentNumber: encrypted,
          documentNumberIndex: numberIndex,
          documentCountry: input.documentCountry.toUpperCase(),
          imageObjectKey: objectKey,
          status: KycDocumentStatus.PENDING,
        }),
      );
      await em.update(User, { id: userId }, { kycStatus: KycStatus.PENDING });
    });

    this.logger.log(`[KYC] Document submitted for review by user ${userId}`);
    return { status: KycStatus.PENDING };
  }

  /**
   * Other accounts that have submitted this same document.
   *
   * A duplicate is a **signal for a human**, never an automatic rejection.
   * Families share addresses, people legitimately re-register after a
   * rejection, and a hard block would turn a review case into a support
   * incident. What it does mean is that per-user limits and AML need to know
   * these accounts are one person.
   */
  async otherAccountsWithSameDocument(
    documentId: string,
  ): Promise<{ userId: string; documentId: string; status: KycDocumentStatus }[]> {
    const doc = await this.docRepo.findOneBy({ id: documentId });
    if (!doc?.documentNumberIndex) return [];

    const matches = await this.docRepo.find({
      where: { documentNumberIndex: doc.documentNumberIndex },
    });
    return matches
      .filter((m) => m.userId !== doc.userId)
      .map((m) => ({ userId: m.userId, documentId: m.id, status: m.status }));
  }

  /**
   * Find the accounts behind a document number, for support-led recovery.
   *
   * The backstop when someone loses the Google account they signed up with.
   * They cannot receive an email or a code, but they can still prove they are
   * the person on the passport we already hold — which is stronger evidence
   * than either.
   *
   * Takes the raw number and indexes it here, so no caller ever has to know
   * how the index is derived.
   */
  async findAccountsByDocumentNumber(
    documentNumber: string,
  ): Promise<{ userId: string; documentId: string; status: KycDocumentStatus }[]> {
    if (!documentNumber?.trim()) return [];
    const matches = await this.docRepo.find({
      where: { documentNumberIndex: blindIndex(documentNumber.trim()) },
    });
    return matches.map((m) => ({
      userId: m.userId,
      documentId: m.id,
      status: m.status,
    }));
  }

  /** Oldest pending first — the queue a reviewer works through. */
  async listPending(limit = 50): Promise<
    {
      id: string;
      userId: string;
      documentType: KycDocumentType;
      documentCountry: string;
      submittedAt: Date;
    }[]
  > {
    const docs = await this.docRepo.find({
      where: { status: KycDocumentStatus.PENDING },
      order: { submittedAt: "ASC" },
      take: limit,
    });
    // No document number and no object key: a queue listing does not need
    // either, and the fewer places they travel the better.
    return docs.map((d) => ({
      id: d.id,
      userId: d.userId,
      documentType: d.documentType,
      documentCountry: d.documentCountry,
      submittedAt: d.submittedAt,
    }));
  }

  /**
   * Open one document for review.
   *
   * The image comes back as a short-lived signed URL, never a permanent link,
   * and the number as its last four characters — enough to check against the
   * image, not enough to be worth stealing. The view itself is audited: reading
   * a passport is an access to sensitive PII and has to be attributable.
   */
  async openForReview(
    reviewerId: string,
    documentId: string,
    ipAddress?: string,
  ): Promise<{
    id: string;
    userId: string;
    documentType: KycDocumentType;
    documentCountry: string;
    documentNumberMasked: string;
    imageUrl: string;
    submittedAt: Date;
    status: KycDocumentStatus;
    /** Other accounts holding this same document. Empty is the normal case. */
    alsoUsedBy: { userId: string; documentId: string; status: KycDocumentStatus }[];
  }> {
    const doc = await this.docRepo.findOneBy({ id: documentId });
    if (!doc) throw new NotFoundException("Document not found");

    const imageUrl = await this.storage.signedUrl(
      doc.imageObjectKey,
      SIGNED_URL_TTL_SECONDS,
    );

    await this.audit.log({
      adminId: reviewerId,
      isAdmin: true,
      action: AuditAction.KYC_DOCUMENT_VIEW,
      entityType: "user_kyc_document",
      entityId: doc.id,
      meta: { subjectUserId: doc.userId },
      ipAddress,
    });

    const alsoUsedBy = await this.otherAccountsWithSameDocument(doc.id);
    if (alsoUsedBy.length) {
      this.logger.warn(
        `[KYC] Document ${doc.id} is also held by ${alsoUsedBy.length} other ` +
          `account(s) — reviewer should treat these as one person`,
      );
    }

    return {
      id: doc.id,
      userId: doc.userId,
      documentType: doc.documentType,
      documentCountry: doc.documentCountry,
      alsoUsedBy,
      // Decrypted only to mask it; the full value is never returned.
      documentNumberMasked: maskPii(this.safeDecrypt(doc.documentNumber)),
      imageUrl,
      submittedAt: doc.submittedAt,
      status: doc.status,
    };
  }

  private safeDecrypt(value: string): string {
    try {
      return decryptPii(value);
    } catch {
      // A number that cannot be decrypted is a real problem, but it must not
      // stop a reviewer working — the image is the evidence, the number is a
      // cross-check. Never log the value or the failure detail.
      this.logger.error("[KYC] Stored document number failed to decrypt");
      return "";
    }
  }

  async approve(
    reviewerId: string,
    documentId: string,
    ipAddress?: string,
  ): Promise<{ status: KycStatus }> {
    const doc = await this.requirePending(documentId);

    await this.dataSource.transaction(async (em) => {
      await em.update(
        UserKycDocument,
        { id: doc.id },
        {
          status: KycDocumentStatus.APPROVED,
          reviewedBy: reviewerId,
          reviewedAt: new Date(),
        },
      );
      await em.update(
        User,
        { id: doc.userId },
        { kycStatus: KycStatus.APPROVED },
      );
    });

    await this.audit.log({
      adminId: reviewerId,
      isAdmin: true,
      action: AuditAction.KYC_DOCUMENT_APPROVE,
      entityType: "user_kyc_document",
      entityId: doc.id,
      meta: { subjectUserId: doc.userId },
      ipAddress,
    });

    return { status: KycStatus.APPROVED };
  }

  /**
   * Reject with a reason the user will see.
   *
   * The account goes to REJECTED rather than back to NONE, which is what lets
   * a single resubmission through: `submit` refuses while APPROVED or PENDING
   * and allows it otherwise.
   */
  async reject(
    reviewerId: string,
    documentId: string,
    reason: string,
    ipAddress?: string,
  ): Promise<{ status: KycStatus }> {
    if (!reason?.trim()) {
      throw new BadRequestException("A rejection reason is required");
    }
    const doc = await this.requirePending(documentId);

    await this.dataSource.transaction(async (em) => {
      await em.update(
        UserKycDocument,
        { id: doc.id },
        {
          status: KycDocumentStatus.REJECTED,
          reviewedBy: reviewerId,
          reviewedAt: new Date(),
          rejectionReason: reason.trim().slice(0, 255),
        },
      );
      await em.update(
        User,
        { id: doc.userId },
        { kycStatus: KycStatus.REJECTED },
      );
    });

    await this.audit.log({
      adminId: reviewerId,
      isAdmin: true,
      action: AuditAction.KYC_DOCUMENT_REJECT,
      entityType: "user_kyc_document",
      entityId: doc.id,
      meta: { subjectUserId: doc.userId, reason: reason.trim().slice(0, 255) },
      ipAddress,
    });

    return { status: KycStatus.REJECTED };
  }

  private async requirePending(documentId: string): Promise<UserKycDocument> {
    const doc = await this.docRepo.findOneBy({ id: documentId });
    if (!doc) throw new NotFoundException("Document not found");
    if (doc.status !== KycDocumentStatus.PENDING) {
      // Two reviewers opening the same queue item must not both decide it.
      throw new ForbiddenException("This document has already been reviewed");
    }
    return doc;
  }

  /** Queue depth and age — the first thing that breaks on a growth spike. */
  async queueHealth(): Promise<{ depth: number; oldestPendingAt: Date | null }> {
    const [oldest] = await this.docRepo.find({
      where: { status: KycDocumentStatus.PENDING },
      order: { submittedAt: "ASC" },
      take: 1,
    });
    const depth = await this.docRepo.count({
      where: { status: KycDocumentStatus.PENDING },
    });
    return { depth, oldestPendingAt: oldest?.submittedAt ?? null };
  }
  /**
   * Magic-byte check against the declared MIME type.
   *
   * Cheap, and it closes the gap between "the client said image/jpeg" and
   * "this is a JPEG". Not a full parse — the point is to reject the obvious
   * mismatch, not to validate the format.
   */
  private static looksLikeImage(buf: Buffer, mimeType: string): boolean {
    if (buf.length < 12) return false;
    switch (mimeType) {
      case "image/jpeg":
        return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
      case "image/png":
        return (
          buf[0] === 0x89 &&
          buf[1] === 0x50 &&
          buf[2] === 0x4e &&
          buf[3] === 0x47
        );
      case "image/webp":
        return (
          buf.toString("ascii", 0, 4) === "RIFF" &&
          buf.toString("ascii", 8, 12) === "WEBP"
        );
      default:
        return false;
    }
  }

  /**
   * The decrypted bytes of a stored document image.
   *
   * Guarded by the signed link the caller had to present, not by a session —
   * see `KycImageController`.
   */
  async readImage(
    objectKey: string,
  ): Promise<{ bytes: Buffer; mimeType: string }> {
    return this.storage.read(objectKey);
  }

  /**
   * This account's verification state, read live.
   *
   * Deliberately not served from the JWT: the token is minted at login and
   * says whatever was true then, so a user who submits a document would keep
   * seeing "not started" until they logged out and back in, and an approval
   * would not unlock deposit until the same. The database is the only source
   * that is right the moment it changes.
   */
  async statusFor(userId: string): Promise<{
    status: KycStatus;
    submittedAt: Date | null;
    reviewedAt: Date | null;
    rejectionReason: string | null;
    canSubmit: boolean;
  }> {
    const user = await this.userRepo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException("User not found");

    const latest = await this.docRepo.findOne({
      where: { userId },
      order: { submittedAt: "DESC" },
    });

    const status = user.kycStatus ?? KycStatus.NONE;
    return {
      status,
      submittedAt: latest?.submittedAt ?? null,
      reviewedAt: latest?.reviewedAt ?? null,
      // Only ever the reason for a rejection. A pending or approved document
      // has nothing to explain, and echoing a stale reason reads as a fresh
      // one.
      rejectionReason:
        status === KycStatus.REJECTED ? (latest?.rejectionReason ?? null) : null,
      // Rejected is resubmittable — that is the whole point of a reason.
      canSubmit: status === KycStatus.NONE || status === KycStatus.REJECTED,
    };
  }
}
