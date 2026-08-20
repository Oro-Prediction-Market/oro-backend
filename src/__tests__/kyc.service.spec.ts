import {
  BadRequestException,
  ServiceUnavailableException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { KycService } from "../kyc/kyc.service";
import { KycStatus } from "../entities/user.entity";
import {
  KycDocumentStatus,
  KycDocumentType,
} from "../entities/user-kyc-document.entity";
import { AuditAction } from "../entities/audit-log.entity";
import { decryptPii } from "../shared/utils/pii-crypto.util";

const KEY = "test-key-that-is-long-enough-to-pass-the-check";
const INDEX_KEY = "index-key-that-is-long-enough-to-pass-check";


/**
 * A minimal buffer that passes the magic-byte check: SOI marker plus enough
 * length to clear the 12-byte floor. The service inspects the header, so a
 * fixture of arbitrary text is rejected before it reaches anything worth
 * testing.
 */
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(16, 1),
]);

function build(opts: { user?: any; doc?: any } = {}) {
  const saved: any[] = [];
  const updates: { entity: string; where: any; patch: any }[] = [];
  const audits: any[] = [];

  const docRepo: any = {
    findOneBy: jest.fn().mockResolvedValue(opts.doc ?? null),
    find: jest.fn().mockResolvedValue(opts.doc ? [opts.doc] : []),
    count: jest.fn().mockResolvedValue(opts.doc ? 1 : 0),
  };
  const userRepo: any = {
    findOneBy: jest.fn().mockResolvedValue(opts.user ?? null),
  };
  const dataSource: any = {
    transaction: jest.fn().mockImplementation((cb: Function) =>
      cb({
        create: (_e: any, d: any) => ({ ...d }),
        save: (_e: any, d: any) => {
          saved.push(d);
          return Promise.resolve(d);
        },
        update: (entity: any, where: any, patch: any) => {
          updates.push({ entity: entity?.name ?? "unknown", where, patch });
          return Promise.resolve(undefined);
        },
      }),
    ),
  };
  const audit: any = {
    log: jest.fn().mockImplementation((a: any) => {
      audits.push(a);
      return Promise.resolve();
    }),
  };
  const storage: any = {
    put: jest.fn().mockResolvedValue("kyc/u1/passport.jpg"),
    signedUrl: jest.fn().mockResolvedValue("https://signed.example/abc?exp=300"),
    remove: jest.fn().mockResolvedValue(undefined),
  };

  const service = new KycService(docRepo, userRepo, dataSource, audit, storage);
  return { service, saved, updates, audits, storage, docRepo };
}

const verifiedUser = {
  id: "u1",
  emailVerifiedAt: new Date(),
  kycStatus: KycStatus.NONE,
};
const submission = {
  documentType: KycDocumentType.PASSPORT,
  documentNumber: "X1234567",
  documentCountry: "in",
  image: JPEG,
  mimeType: "image/jpeg",
};

describe("KycService.submit", () => {
  const prevKey = process.env.KYC_ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.KYC_ENCRYPTION_KEY = KEY;
    process.env.KYC_INDEX_KEY = INDEX_KEY;
  });
  afterAll(() => {
    process.env.KYC_ENCRYPTION_KEY = prevKey;
  });

  it("never stores the document number in plaintext", async () => {
    const { service, saved } = build({ user: verifiedUser });
    await service.submit("u1", submission);

    const doc = saved[0];
    expect(doc.documentNumber).not.toContain("X1234567");
    expect(doc.documentNumber.startsWith("v1:")).toBe(true);
    // Still recoverable by something holding the key.
    expect(decryptPii(doc.documentNumber)).toBe("X1234567");
  });

  it("stores a storage key, never the image bytes", async () => {
    const { service, saved, storage } = build({ user: verifiedUser });
    await service.submit("u1", submission);
    expect(storage.put).toHaveBeenCalled();
    expect(saved[0].imageObjectKey).toBe("kyc/u1/passport.jpg");
    expect(JSON.stringify(saved[0])).not.toContain("jpeg-bytes");
  });

  it("moves the account to PENDING and upper-cases the country", async () => {
    const { service, saved, updates } = build({ user: verifiedUser });
    await service.submit("u1", submission);
    expect(saved[0].documentCountry).toBe("IN");
    expect(updates[0].patch.kycStatus).toBe(KycStatus.PENDING);
  });

  it("refuses an unverified email address", async () => {
    // Otherwise the queue fills with documents belonging to addresses nobody
    // controls, and reviewers spend time on submissions that cannot be reached.
    const { service } = build({
      user: { ...verifiedUser, emailVerifiedAt: null },
    });
    await expect(service.submit("u1", submission)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("refuses a second submission while one is under review, and after approval", async () => {
    for (const status of [KycStatus.PENDING, KycStatus.APPROVED]) {
      const { service } = build({ user: { ...verifiedUser, kycStatus: status } });
      await expect(service.submit("u1", submission)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
  });

  it("allows exactly one resubmission after a rejection", async () => {
    const { service, saved } = build({
      user: { ...verifiedUser, kycStatus: KycStatus.REJECTED },
    });
    await expect(service.submit("u1", submission)).resolves.toEqual({
      status: KycStatus.PENDING,
    });
    expect(saved).toHaveLength(1);
  });

  it("validates the country code", async () => {
    const { service } = build({ user: verifiedUser });
    await expect(
      service.submit("u1", { ...submission, documentCountry: "IND" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses to store anything when no encryption key is configured", async () => {
    // The failure mode this prevents is quietly writing passport numbers in
    // the clear, which nobody discovers in time.
    delete process.env.KYC_ENCRYPTION_KEY;
    const { service, saved, storage } = build({ user: verifiedUser });

    // A missing key is a deployment fault, so the user sees "unavailable"
    // rather than a 500 — but nothing is written either way, which is the part
    // that matters.
    await expect(service.submit("u1", submission)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    // And the key name never reaches the client.
    await expect(service.submit("u1", submission)).rejects.not.toThrow(
      /KYC_ENCRYPTION_KEY/,
    );
    expect(saved).toHaveLength(0);
    expect(storage.put).not.toHaveBeenCalled();
    process.env.KYC_ENCRYPTION_KEY = KEY;
  });

  it("rejects a file that is not the image type it claims to be", async () => {
    // The declared MIME type is client-controlled. A reviewer opening what
    // turns out not to be an image is the thing this prevents.
    const { service } = build({
      user: { id: "u1", emailVerifiedAt: new Date(), kycStatus: KycStatus.NONE },
    });
    await expect(
      service.submit("u1", {
        ...submission,
        image: Buffer.from("%PDF-1.7 this is not a photograph"),
      }),
    ).rejects.toThrow(/not the image type/i);
  });

  it("rejects a document type we do not accept", async () => {
    const { service } = build({
      user: { id: "u1", emailVerifiedAt: new Date(), kycStatus: KycStatus.NONE },
    });
    await expect(
      service.submit("u1", { ...submission, mimeType: "application/pdf" }),
    ).rejects.toThrow(/JPEG, PNG or WebP/i);
  });

  it("rejects an image over the size ceiling", async () => {
    // Without this the review queue is free storage for anyone with an account.
    const { service } = build({
      user: { id: "u1", emailVerifiedAt: new Date(), kycStatus: KycStatus.NONE },
    });
    const huge = Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024, 1)]);
    await expect(
      service.submit("u1", { ...submission, image: huge }),
    ).rejects.toThrow(/too large/i);
  });

  it("rejects a submission with no image at all", async () => {
    const { service } = build({
      user: { id: "u1", emailVerifiedAt: new Date(), kycStatus: KycStatus.NONE },
    });
    await expect(
      service.submit("u1", { ...submission, image: Buffer.alloc(0) }),
    ).rejects.toThrow(/photograph of the document is required/i);
  });

});

describe("KycService review queue", () => {
  const pendingDoc = {
    id: "d1",
    userId: "u1",
    documentType: KycDocumentType.PASSPORT,
    documentCountry: "IN",
    documentNumber: "unused-in-listing",
    imageObjectKey: "kyc/u1/passport.jpg",
    status: KycDocumentStatus.PENDING,
    submittedAt: new Date("2026-01-01"),
  };

  beforeAll(() => {
    process.env.KYC_ENCRYPTION_KEY = KEY;
    process.env.KYC_INDEX_KEY = INDEX_KEY;
  });

  it("lists without exposing the number or the storage key", async () => {
    const { service } = build({ doc: pendingDoc });
    const [row] = await service.listPending();
    expect(row).not.toHaveProperty("documentNumber");
    expect(row).not.toHaveProperty("imageObjectKey");
  });

  it("returns a short-lived URL and only the last four characters", async () => {
    const { encryptPii } = require("../shared/utils/pii-crypto.util");
    const doc = { ...pendingDoc, documentNumber: encryptPii("X1234567") };
    const { service, storage } = build({ doc });

    const res = await service.openForReview("rev-1", "d1", "1.2.3.4");
    expect(res.documentNumberMasked).toBe("••••4567");
    expect(res.imageUrl).toContain("signed.example");
    expect(storage.signedUrl).toHaveBeenCalledWith(
      "kyc/u1/passport.jpg",
      5 * 60,
    );
  });

  it("audits the act of looking at a document", async () => {
    // Reading a passport is itself an access to sensitive PII and has to be
    // attributable, not just the decision that follows it.
    const { encryptPii } = require("../shared/utils/pii-crypto.util");
    const { service, audits } = build({
      doc: { ...pendingDoc, documentNumber: encryptPii("X1234567") },
    });
    await service.openForReview("rev-1", "d1", "1.2.3.4");

    expect(audits[0]).toMatchObject({
      adminId: "rev-1",
      action: AuditAction.KYC_DOCUMENT_VIEW,
      entityId: "d1",
      ipAddress: "1.2.3.4",
    });
  });

  it("approving unlocks the account and is audited", async () => {
    const { service, updates, audits } = build({ doc: pendingDoc });
    await expect(service.approve("rev-1", "d1")).resolves.toEqual({
      status: KycStatus.APPROVED,
    });

    const userUpdate = updates.find((u) => u.entity === "User");
    expect(userUpdate!.patch.kycStatus).toBe(KycStatus.APPROVED);
    expect(audits[0].action).toBe(AuditAction.KYC_DOCUMENT_APPROVE);
  });

  it("rejecting requires a reason and records it", async () => {
    const { service, updates, audits } = build({ doc: pendingDoc });
    await expect(service.reject("rev-1", "d1", "  ")).rejects.toBeInstanceOf(
      BadRequestException,
    );

    await service.reject("rev-1", "d1", "Image unreadable");
    const docUpdate = updates.find((u) => u.entity === "UserKycDocument");
    expect(docUpdate!.patch.rejectionReason).toBe("Image unreadable");
    expect(audits[0].action).toBe(AuditAction.KYC_DOCUMENT_REJECT);
  });

  it("refuses a second decision on the same document", async () => {
    // Two reviewers working the same queue must not both decide one item.
    const { service } = build({
      doc: { ...pendingDoc, status: KycDocumentStatus.APPROVED },
    });
    await expect(service.approve("rev-2", "d1")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.reject("rev-2", "d1", "no")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("404s on an unknown document", async () => {
    const { service } = build({ doc: null });
    await expect(service.approve("rev-1", "nope")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("reports queue depth and oldest pending age", async () => {
    const { service } = build({ doc: pendingDoc });
    await expect(service.queueHealth()).resolves.toEqual({
      depth: 1,
      oldestPendingAt: pendingDoc.submittedAt,
    });
  });
});

describe("KycService — duplicate documents", () => {
  const KEY2 = "test-key-that-is-long-enough-to-pass-the-check";
  beforeAll(() => {
    process.env.KYC_ENCRYPTION_KEY = KEY2;
    process.env.KYC_INDEX_KEY = "index-key-that-is-long-enough-to-pass-check";
  });

  it("stores a searchable index alongside the unreadable number", async () => {
    const { service, saved } = build({
      user: {
        id: "u1",
        emailVerifiedAt: new Date(),
        kycStatus: KycStatus.NONE,
      },
    });
    await service.submit("u1", {
      documentType: KycDocumentType.PASSPORT,
      documentNumber: "X1234567",
      documentCountry: "in",
      image: JPEG,
      mimeType: "image/jpeg",
    });

    const doc = saved[0];
    expect(doc.documentNumberIndex).toMatch(/^[0-9a-f]{64}$/);
    // The index must not be derivable from, or reveal, the number.
    expect(doc.documentNumberIndex).not.toContain("1234567");
    expect(doc.documentNumber).not.toContain("X1234567");
  });

  it("finds other accounts holding the same document", async () => {
    // Google sign-in makes accounts nearly free; this is the only thing that
    // links five of them to one person.
    const mine = {
      id: "d1",
      userId: "u1",
      documentNumberIndex: "abc123",
      status: KycDocumentStatus.PENDING,
    };
    const theirs = {
      id: "d2",
      userId: "u2",
      documentNumberIndex: "abc123",
      status: KycDocumentStatus.APPROVED,
    };
    const { service, docRepo } = build({ doc: mine });
    docRepo.find = jest.fn().mockResolvedValue([mine, theirs]);

    const others = await service.otherAccountsWithSameDocument("d1");
    // Only the *other* account — not the document we asked about.
    expect(others).toEqual([
      { userId: "u2", documentId: "d2", status: KycDocumentStatus.APPROVED },
    ]);
  });

  it("reports no duplicates for a document nobody else submitted", async () => {
    const mine = {
      id: "d1",
      userId: "u1",
      documentNumberIndex: "abc123",
      status: KycDocumentStatus.PENDING,
    };
    const { service, docRepo } = build({ doc: mine });
    docRepo.find = jest.fn().mockResolvedValue([mine]);
    expect(await service.otherAccountsWithSameDocument("d1")).toEqual([]);
  });

  it("finds the account behind a document number, for recovery", async () => {
    // The backstop when someone loses the Google account they signed up with:
    // they cannot get an email or a code, but they are still the person on the
    // passport we hold.
    const { service, docRepo } = build();
    docRepo.find = jest.fn().mockResolvedValue([
      { id: "d1", userId: "u1", status: KycDocumentStatus.APPROVED },
    ]);

    const found = await service.findAccountsByDocumentNumber("X1234567");
    expect(found).toEqual([
      { userId: "u1", documentId: "d1", status: KycDocumentStatus.APPROVED },
    ]);
    // Looked up by index, never by the raw number.
    const where = (docRepo.find as jest.Mock).mock.calls[0][0].where;
    expect(where.documentNumberIndex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns nothing for an empty query rather than matching everything", async () => {
    const { service } = build();
    expect(await service.findAccountsByDocumentNumber("")).toEqual([]);
  });
});

describe("KycService.statusFor", () => {
  it("reads status from the database, not the login token", async () => {
    // A JWT says whatever was true at login. Serving status from it means a
    // user who just submitted keeps seeing "not started", and an approval does
    // not unlock deposit until they log out and back in.
    const { service, docRepo } = build({
      user: { id: "u1", kycStatus: KycStatus.PENDING },
    });
    const submittedAt = new Date("2026-08-01T00:00:00Z");
    docRepo.findOne = jest.fn().mockResolvedValue({ submittedAt });

    const res = await service.statusFor("u1");
    expect(res.status).toBe(KycStatus.PENDING);
    expect(res.submittedAt).toBe(submittedAt);
    // Nothing to do while a human is looking at it.
    expect(res.canSubmit).toBe(false);
  });

  it("returns the reason and reopens submission after a rejection", async () => {
    const { service, docRepo } = build({
      user: { id: "u1", kycStatus: KycStatus.REJECTED },
    });
    docRepo.findOne = jest.fn().mockResolvedValue({
      submittedAt: new Date(),
      reviewedAt: new Date(),
      rejectionReason: "The photograph is too blurred to read",
    });

    const res = await service.statusFor("u1");
    expect(res.rejectionReason).toBe("The photograph is too blurred to read");
    // A reason with no way to act on it is just an insult.
    expect(res.canSubmit).toBe(true);
  });

  it("does not echo a stale reason once approved", async () => {
    // Someone rejected then approved still has the old reason on an older row.
    // Showing it alongside "verified" reads as a fresh problem.
    const { service, docRepo } = build({
      user: { id: "u1", kycStatus: KycStatus.APPROVED },
    });
    docRepo.findOne = jest
      .fn()
      .mockResolvedValue({ rejectionReason: "blurred", submittedAt: new Date() });

    const res = await service.statusFor("u1");
    expect(res.rejectionReason).toBeNull();
    expect(res.canSubmit).toBe(false);
  });

  it("reports a fresh account as able to submit", async () => {
    const { service, docRepo } = build({
      user: { id: "u1", kycStatus: KycStatus.NONE },
    });
    docRepo.findOne = jest.fn().mockResolvedValue(null);

    const res = await service.statusFor("u1");
    expect(res).toMatchObject({
      status: KycStatus.NONE,
      submittedAt: null,
      rejectionReason: null,
      canSubmit: true,
    });
  });
});
