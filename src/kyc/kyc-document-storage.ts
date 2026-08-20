import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { Client as MinioClient } from "minio";
import { decryptBytes, encryptBytes } from "../shared/utils/pii-crypto.util";

/**
 * Where identity-document images live.
 *
 * See docs/usdt-oro/STAGE-G-ONBOARDING-KYC.md §G.3.
 */
export abstract class KycDocumentStorage {
  /** Persist an uploaded image, returning the key stored on the document row. */
  abstract put(userId: string, bytes: Buffer, mimeType: string): Promise<string>;

  /** A short-lived URL a reviewer can open. Never a permanent link. */
  abstract signedUrl(objectKey: string, ttlSeconds: number): Promise<string>;

  /** The decrypted image, for the route that serves it to a reviewer. */
  abstract read(objectKey: string): Promise<{ bytes: Buffer; mimeType: string }>;

  /** Remove an image, for a deletion request or the end of retention. */
  abstract remove(objectKey: string): Promise<void>;
}

/**
 * MinIO-backed storage.
 *
 * **The bucket only ever holds ciphertext.** The image is encrypted with
 * AES-256-GCM under `KYC_ENCRYPTION_KEY` before it is uploaded and decrypted
 * only when a reviewer opens it, so an operator with bucket credentials, a
 * leaked backup, or a misconfigured public policy yields no readable passport.
 * That is also what makes MinIO an acceptable answer to decision 6 without a
 * separate encryption-at-rest story: encryption is ours, not the store's.
 *
 * **Hence no presigned URLs.** A presigned link would serve ciphertext no
 * browser can render. `signedUrl` instead returns a short-lived, signed link
 * back to our own route, which authorises the reviewer, decrypts, logs the
 * access, and streams the image.
 */
@Injectable()
export class MinioKycDocumentStorage extends KycDocumentStorage {
  private readonly logger = new Logger(MinioKycDocumentStorage.name);
  private client: MinioClient | null = null;
  private readonly bucket = process.env.MINIO_KYC_BUCKET || "oro-kyc";

  /** Whether the environment carries enough to talk to MinIO at all. */
  static isConfigured(): boolean {
    return Boolean(
      process.env.MINIO_ENDPOINT &&
        process.env.MINIO_ACCESS_KEY &&
        process.env.MINIO_SECRET_KEY,
    );
  }

  private connect(): MinioClient {
    if (this.client) return this.client;
    const endpoint = process.env.MINIO_ENDPOINT!;
    // Accept "host:port" or a full URL, because both get pasted into env files.
    const url = endpoint.includes("://") ? new URL(endpoint) : null;
    const host = url ? url.hostname : endpoint.split(":")[0];
    const portRaw = url ? url.port : endpoint.split(":")[1];
    const secure =
      process.env.MINIO_USE_SSL === "true" || url?.protocol === "https:";

    this.client = new MinioClient({
      endPoint: host,
      port: portRaw ? Number(portRaw) : secure ? 443 : 9000,
      useSSL: secure,
      accessKey: process.env.MINIO_ACCESS_KEY!,
      secretKey: process.env.MINIO_SECRET_KEY!,
    });
    return this.client;
  }

  /**
   * Prove the bucket is usable, not merely that a client object exists.
   *
   * Constructing a MinIO client performs no I/O, so bad credentials or a
   * missing bucket surface as a failed upload much later, with a boot log that
   * said everything was fine. `bucketExists` is a signed call and fails now.
   */
  async healthy(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const client = this.connect();
      if (!(await client.bucketExists(this.bucket))) {
        return { ok: false, reason: `bucket "${this.bucket}" does not exist` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }

  async put(userId: string, bytes: Buffer, mimeType: string): Promise<string> {
    const client = this.connect();
    // Random, not derived from anything about the person: an object key ends
    // up in logs and error reports, and a guessable one built from a user id
    // plus a timestamp would leak who submitted when.
    const objectKey = `kyc/${userId}/${randomUUID()}.enc`;
    const sealed = encryptBytes(bytes);

    await client.putObject(this.bucket, objectKey, sealed, sealed.length, {
      // Metadata is stored unencrypted, so it carries only what is safe to
      // leak: the media type, needed to serve the image back with the right
      // Content-Type. Never the user, never the document.
      "Content-Type": "application/octet-stream",
      "x-amz-meta-oro-mime": mimeType,
    });

    // Deliberately no user id and no key in the log line.
    this.logger.log(`[KYC] Stored an encrypted document (${sealed.length} bytes)`);
    return objectKey;
  }

  async read(objectKey: string): Promise<{ bytes: Buffer; mimeType: string }> {
    const client = this.connect();
    const stat = await client.statObject(this.bucket, objectKey);
    const stream = await client.getObject(this.bucket, objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return {
      bytes: decryptBytes(Buffer.concat(chunks)),
      mimeType:
        (stat.metaData?.["oro-mime"] as string) ??
        (stat.metaData?.["x-amz-meta-oro-mime"] as string) ??
        "image/jpeg",
    };
  }

  async signedUrl(objectKey: string, ttlSeconds: number): Promise<string> {
    return signKycImageUrl(objectKey, ttlSeconds);
  }

  async remove(objectKey: string): Promise<void> {
    await this.connect().removeObject(this.bucket, objectKey);
    this.logger.log("[KYC] Removed a stored document");
  }
}

/**
 * A short-lived link to our own image route.
 *
 * Signed rather than relying on the session, because a reviewer's browser
 * loads this in an `<img>` tag, which sends no Authorization header. The
 * signature binds the key and the expiry together, so neither can be edited,
 * and the window is minutes rather than the lifetime of the object.
 */
export function signKycImageUrl(
  objectKey: string,
  ttlSeconds: number,
): string {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = kycImageSignature(objectKey, expires);
  const params = new URLSearchParams({
    key: objectKey,
    expires: String(expires),
    sig,
  });
  return `/api/admin/kyc/image?${params.toString()}`;
}

/** Returns the object key when the signature is valid and unexpired. */
export function verifyKycImageUrl(
  key: string,
  expires: string,
  sig: string,
): string | null {
  const exp = Number(expires);
  if (!key || !Number.isFinite(exp)) return null;
  if (exp < Math.floor(Date.now() / 1000)) return null;

  const expected = Buffer.from(kycImageSignature(key, exp), "utf8");
  const given = Buffer.from(String(sig ?? ""), "utf8");
  // Length check first: timingSafeEqual throws on a mismatch rather than
  // returning false.
  if (expected.length !== given.length) return null;
  return timingSafeEqual(expected, given) ? key : null;
}

function kycImageSignature(objectKey: string, expires: number): string {
  const secret = process.env.KYC_ENCRYPTION_KEY;
  if (!secret) throw new Error("KYC_ENCRYPTION_KEY is not configured");
  // Domain-separated from every other use of this secret, so a signature can
  // never be replayed as anything else.
  return createHmac("sha256", `kyc-image:${secret}`)
    .update(`${objectKey}:${expires}`)
    .digest("hex");
}

@Injectable()
export class UnconfiguredKycDocumentStorage extends KycDocumentStorage {
  private readonly logger = new Logger(UnconfiguredKycDocumentStorage.name);

  private refuse(): never {
    // The reason goes to the log, not to the user.
    this.logger.error(
      "KYC document storage is not configured. Set MINIO_ENDPOINT, " +
        "MINIO_ACCESS_KEY and MINIO_SECRET_KEY. Uploads are refused.",
    );
    throw new ServiceUnavailableException(
      "Identity verification is temporarily unavailable. Please try again later.",
    );
  }
  async put(): Promise<string> {
    this.refuse();
  }
  async signedUrl(): Promise<string> {
    this.refuse();
  }
  async read(): Promise<{ bytes: Buffer; mimeType: string }> {
    this.refuse();
  }
  async remove(): Promise<void> {
    this.refuse();
  }
}
