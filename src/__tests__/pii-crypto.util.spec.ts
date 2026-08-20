import {
  blindIndex,
  decryptPii,
  encryptPii,
  maskPii,
  normaliseDocumentNumber,
  encryptBytes,
  decryptBytes,
} from "../shared/utils/pii-crypto.util";
import {
  signKycImageUrl,
  verifyKycImageUrl,
} from "../kyc/kyc-document-storage";

const KEY = "test-key-that-is-long-enough-to-pass-the-check";

describe("PII encryption", () => {
  const prev = process.env.KYC_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.KYC_ENCRYPTION_KEY = KEY;
  });
  afterAll(() => {
    process.env.KYC_ENCRYPTION_KEY = prev;
  });

  it("round-trips", () => {
    for (const v of ["X1234567", "A-1", "护照 12345", ""]) {
      expect(decryptPii(encryptPii(v))).toBe(v);
    }
  });

  it("never contains the plaintext", () => {
    expect(encryptPii("X1234567")).not.toContain("X1234567");
  });

  it("produces a different ciphertext each time", () => {
    // A deterministic ciphertext would let anyone with database access confirm
    // a guessed document number by encrypting it and comparing.
    const a = encryptPii("X1234567");
    const b = encryptPii("X1234567");
    expect(a).not.toBe(b);
    expect(decryptPii(a)).toBe(decryptPii(b));
  });

  it("rejects a tampered ciphertext instead of returning garbage", () => {
    // The GCM auth tag is the point: without it a flipped bit decrypts to
    // something plausible and nothing says so.
    const enc = encryptPii("X1234567");
    const [v, iv, tag, data] = enc.split(":");
    const flipped = data[0] === "A" ? "B" : "A";
    expect(() =>
      decryptPii([v, iv, tag, flipped + data.slice(1)].join(":")),
    ).toThrow();
    expect(() => decryptPii("garbage")).toThrow(/Malformed/);
  });

  it("cannot be read with a different key", () => {
    const enc = encryptPii("X1234567");
    process.env.KYC_ENCRYPTION_KEY = "a-completely-different-key-of-good-length";
    expect(() => decryptPii(enc)).toThrow();
  });

  it("refuses to operate with no key, or a short one", () => {
    delete process.env.KYC_ENCRYPTION_KEY;
    expect(() => encryptPii("X1234567")).toThrow(/KYC_ENCRYPTION_KEY/);
    process.env.KYC_ENCRYPTION_KEY = "too-short";
    expect(() => encryptPii("X1234567")).toThrow(/KYC_ENCRYPTION_KEY/);
  });
});

describe("maskPii", () => {
  it("shows only the last four characters", () => {
    expect(maskPii("X1234567")).toBe("••••4567");
    expect(maskPii("1234")).toBe("••••");
    expect(maskPii("")).toBe("");
  });
});

describe("blind index", () => {
  const prev = process.env.KYC_INDEX_KEY;
  beforeEach(() => {
    process.env.KYC_INDEX_KEY = "index-key-that-is-long-enough-to-pass";
  });
  afterAll(() => {
    process.env.KYC_INDEX_KEY = prev;
  });

  it("is deterministic — which is the entire point", () => {
    // The ciphertext cannot be searched because its IV is random. This can.
    expect(blindIndex("P1234567")).toBe(blindIndex("P1234567"));
  });

  it("collapses the ways people write the same number", () => {
    // Same passport typed four ways must be one index, or duplicate detection
    // is defeated by a space.
    const forms = ["P1234567", "p 1234567", "P-1234567", " p1234567 "];
    const indexes = new Set(forms.map(blindIndex));
    expect(indexes.size).toBe(1);
  });

  it("does not collide across different documents", () => {
    expect(blindIndex("P1234567")).not.toBe(blindIndex("P7654321"));
  });

  it("never contains the document number", () => {
    const idx = blindIndex("P1234567");
    expect(idx).not.toContain("P1234567");
    expect(idx).not.toContain("1234567");
    expect(idx).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is keyed, so a stolen database cannot be brute-forced offline", () => {
    // Document numbers are short and low-entropy; an unkeyed digest would fall
    // in seconds. Changing the key must change every index.
    const a = blindIndex("P1234567");
    process.env.KYC_INDEX_KEY = "a-completely-different-index-key-here";
    expect(blindIndex("P1234567")).not.toBe(a);
  });

  it("uses a key separate from the encryption key", () => {
    // Leaking one must not compromise the other.
    process.env.KYC_ENCRYPTION_KEY = "index-key-that-is-long-enough-to-pass";
    process.env.KYC_INDEX_KEY = "a-different-index-key-long-enough-ok";
    expect(() => blindIndex("P1234567")).not.toThrow();
  });

  it("refuses to operate without a key", () => {
    delete process.env.KYC_INDEX_KEY;
    expect(() => blindIndex("P1234567")).toThrow(/KYC_INDEX_KEY/);
    process.env.KYC_INDEX_KEY = "short";
    expect(() => blindIndex("P1234567")).toThrow(/KYC_INDEX_KEY/);
  });

  it("normalises predictably", () => {
    expect(normaliseDocumentNumber(" p-123 456 ")).toBe("P123456");
    expect(normaliseDocumentNumber("")).toBe("");
  });
});

describe("encryptBytes / decryptBytes", () => {
  const KEY = "test-key-that-is-long-enough-to-pass-the-check";
  const prev = process.env.KYC_ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.KYC_ENCRYPTION_KEY = KEY;
  });
  afterAll(() => {
    process.env.KYC_ENCRYPTION_KEY = prev;
  });

  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(2048, 7),
  ]);

  it("round-trips an image byte for byte", () => {
    expect(decryptBytes(encryptBytes(jpeg))).toEqual(jpeg);
  });

  it("leaves nothing recognisable in the stored object", () => {
    // The whole point: bucket credentials, a leaked backup, or a public policy
    // must not yield a readable passport.
    const sealed = encryptBytes(jpeg);
    expect(sealed.includes(jpeg.subarray(0, 64))).toBe(false);
    // The JPEG magic must not survive either, or the object is identifiable
    // as a photograph even unopened.
    expect(sealed.subarray(4).includes(Buffer.from([0xff, 0xd8, 0xff]))).toBe(
      false,
    );
  });

  it("produces different ciphertext for the same image every time", () => {
    // A fresh IV per object. Otherwise two users submitting the same document
    // would produce identical objects, which is a leak by itself.
    expect(encryptBytes(jpeg).equals(encryptBytes(jpeg))).toBe(false);
  });

  it("refuses a tampered object rather than returning garbage", () => {
    const sealed = encryptBytes(jpeg);
    sealed[sealed.length - 1] ^= 0xff;
    expect(() => decryptBytes(sealed)).toThrow();
  });

  it("refuses a truncated object", () => {
    const sealed = encryptBytes(jpeg);
    expect(() => decryptBytes(sealed.subarray(0, 20))).toThrow();
  });

  it("refuses something that was never encrypted by us", () => {
    // A plaintext image written by some future code path must fail loudly
    // here, not be served as though it had been protected.
    expect(() => decryptBytes(jpeg)).toThrow(/not an oro-encrypted object/i);
  });

  it("cannot be read with a different key", () => {
    const sealed = encryptBytes(jpeg);
    process.env.KYC_ENCRYPTION_KEY = "a-completely-different-key-32-chars-x";
    try {
      expect(() => decryptBytes(sealed)).toThrow();
    } finally {
      process.env.KYC_ENCRYPTION_KEY = KEY;
    }
  });

  it("handles an empty buffer without special-casing", () => {
    expect(decryptBytes(encryptBytes(Buffer.alloc(0)))).toEqual(
      Buffer.alloc(0),
    );
  });
});

describe("KYC image links", () => {
  const KEY = "test-key-that-is-long-enough-to-pass-the-check";
  beforeAll(() => {
    process.env.KYC_ENCRYPTION_KEY = KEY;
  });

  it("round-trips a valid link", () => {
    const url = signKycImageUrl("kyc/u1/abc.enc", 300);
    const q = new URLSearchParams(url.split("?")[1]);
    expect(
      verifyKycImageUrl(q.get("key")!, q.get("expires")!, q.get("sig")!),
    ).toBe("kyc/u1/abc.enc");
  });

  it("refuses a different object key under the same signature", () => {
    // The signature binds key and expiry together, so a reviewer cannot walk
    // to another applicant's document by editing the query string.
    const url = signKycImageUrl("kyc/u1/abc.enc", 300);
    const q = new URLSearchParams(url.split("?")[1]);
    expect(
      verifyKycImageUrl("kyc/u2/other.enc", q.get("expires")!, q.get("sig")!),
    ).toBeNull();
  });

  it("refuses an extended expiry", () => {
    const url = signKycImageUrl("kyc/u1/abc.enc", 300);
    const q = new URLSearchParams(url.split("?")[1]);
    const later = String(Number(q.get("expires")) + 86_400);
    expect(verifyKycImageUrl(q.get("key")!, later, q.get("sig")!)).toBeNull();
  });

  it("refuses a link that has already expired", () => {
    const url = signKycImageUrl("kyc/u1/abc.enc", -10);
    const q = new URLSearchParams(url.split("?")[1]);
    expect(
      verifyKycImageUrl(q.get("key")!, q.get("expires")!, q.get("sig")!),
    ).toBeNull();
  });

  it("refuses a missing or malformed signature without throwing", () => {
    // timingSafeEqual throws on a length mismatch; the comparison must not.
    expect(verifyKycImageUrl("kyc/u1/abc.enc", "9999999999", "")).toBeNull();
    expect(verifyKycImageUrl("kyc/u1/abc.enc", "9999999999", "zz")).toBeNull();
    expect(verifyKycImageUrl("", "9999999999", "zz")).toBeNull();
    expect(verifyKycImageUrl("kyc/u1/abc.enc", "not-a-number", "zz")).toBeNull();
  });
});
