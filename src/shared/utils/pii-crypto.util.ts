import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";

/**
 * Authenticated encryption for PII held at rest.
 *
 * Used for KYC document numbers, which are the one field in this system that
 * is both directly identifying and useless to us in plaintext — nothing queries
 * or sorts by it, so there is no reason for it ever to be readable in the
 * database, in a backup, or in a log.
 *
 * AES-256-GCM rather than CBC: the auth tag means a tampered ciphertext fails
 * loudly on read instead of decrypting to plausible garbage.
 *
 * The key comes from `KYC_ENCRYPTION_KEY` and there is deliberately no
 * fallback. A missing key raises rather than degrading to plaintext — the
 * failure mode of "quietly stored passport numbers in the clear" is not one
 * anybody discovers in time.
 */
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const PREFIX = "v1";
const BYTES_MAGIC = Buffer.from("ORO1");
const TAG_BYTES = 16;
const BYTES_HEADER = BYTES_MAGIC.length + IV_BYTES + TAG_BYTES;

function key(): Buffer {
  const raw = process.env.KYC_ENCRYPTION_KEY;
  if (!raw || raw.length < 32) {
    throw new Error(
      "KYC_ENCRYPTION_KEY is not configured (needs at least 32 characters). " +
        "Refusing to handle identity documents without it.",
    );
  }
  // Hashed to exactly 32 bytes so any sufficiently long secret works, without
  // requiring operators to produce hex of an exact length.
  return createHash("sha256").update(raw, "utf8").digest();
}

/** Returns `v1:<iv>:<tag>:<ciphertext>`, all base64url. */
export function encryptPii(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const enc = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    PREFIX,
    iv.toString("base64url"),
    tag.toString("base64url"),
    enc.toString("base64url"),
  ].join(":");
}

/**
 * Encrypt raw bytes — a document photograph, not a string.
 *
 * Same key and same algorithm as {@link encryptPii}, but framed as binary
 * rather than base64url text: an image is already megabytes, and base64 would
 * add a third to every upload and every download for nothing.
 *
 * Layout: `ORO1` magic, 12-byte IV, 16-byte GCM tag, then ciphertext. The
 * magic byte-string is there so a file pulled straight out of the bucket is
 * identifiable as ours, and so a plaintext image accidentally written by some
 * future code path fails loudly here instead of being served as if encrypted.
 */
export function encryptBytes(plain: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([BYTES_MAGIC, iv, cipher.getAuthTag(), enc]);
}

/**
 * Reverse {@link encryptBytes}.
 *
 * GCM authenticates as it decrypts, so a tampered or truncated object throws
 * rather than returning plausible garbage.
 */
export function decryptBytes(payload: Buffer): Buffer {
  if (
    payload.length < BYTES_HEADER ||
    !payload.subarray(0, BYTES_MAGIC.length).equals(BYTES_MAGIC)
  ) {
    throw new Error("Not an Oro-encrypted object");
  }
  const iv = payload.subarray(BYTES_MAGIC.length, BYTES_MAGIC.length + IV_BYTES);
  const tag = payload.subarray(BYTES_MAGIC.length + IV_BYTES, BYTES_HEADER);
  const decipher = createDecipheriv(ALGORITHM, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(payload.subarray(BYTES_HEADER)),
    decipher.final(),
  ]);
}

export function decryptPii(payload: string): string {
  const parts = String(payload).split(":");
  const [version, ivB64, tagB64, dataB64] = parts;
  // Structure, not emptiness: an empty plaintext encrypts to an empty
  // ciphertext, which is legitimate and must still round-trip.
  if (parts.length !== 4 || version !== PREFIX || !ivB64 || !tagB64) {
    throw new Error("Malformed encrypted value");
  }
  const decipher = createDecipheriv(
    ALGORITHM,
    key(),
    Buffer.from(ivB64, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * A deterministic, one-way index over a document number.
 *
 * `encryptPii` uses a random IV per value, so the same passport encrypts
 * differently every time — which is correct for confidentiality and makes
 * `WHERE documentNumber = ?` permanently useless. Two things genuinely need
 * that lookup:
 *
 *   1. **Duplicate detection.** Sign-in is nearly free, so the only thing
 *      stopping one person running five accounts is noticing the same document
 *      behind them. Per-user responsible-gaming limits and AML both depend on
 *      it.
 *   2. **Account recovery.** A user locked out of their Google account proves
 *      who they are with the document we already hold — which means we have to
 *      be able to find the account from the document.
 *
 * So: an HMAC. Deterministic, therefore searchable and indexable. One-way,
 * therefore the database still never holds a readable passport number.
 *
 * **Keyed separately from the encryption key.** If they were the same, leaking
 * one would compromise both, and this key has to be readable by anything that
 * writes a document while the encryption key ideally is not.
 *
 * A plain hash would not do: document numbers have low entropy and a short
 * format, so an unkeyed digest is brute-forceable in seconds.
 */
export function blindIndex(plaintext: string): string {
  const raw = process.env.KYC_INDEX_KEY;
  if (!raw || raw.length < 32) {
    throw new Error(
      "KYC_INDEX_KEY is not configured (needs at least 32 characters). " +
        "Refusing to store a document without a duplicate/recovery index.",
    );
  }
  return createHmac("sha256", createHash("sha256").update(raw, "utf8").digest())
    .update(normaliseDocumentNumber(plaintext), "utf8")
    .digest("hex");
}

/**
 * Canonical form of a document number, so trivial formatting differences do
 * not defeat the index.
 *
 * People write the same passport as `P1234567`, `p 1234567` and `P-1234567`.
 * Uppercasing and stripping everything that is not alphanumeric collapses all
 * three. It cannot collapse a genuine transcription error, and it is not meant
 * to — this catches the same person re-registering, not a forger.
 */
export function normaliseDocumentNumber(value: string): string {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * Last four characters, for a reviewer to match against the image without the
 * full number ever leaving the database.
 */
export function maskPii(plaintext: string): string {
  const s = String(plaintext ?? "");
  return s.length <= 4 ? "•".repeat(s.length) : `••••${s.slice(-4)}`;
}
