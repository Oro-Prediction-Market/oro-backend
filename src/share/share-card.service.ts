import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { RedisService } from "../redis/redis.service";

/** How long a staged card stays fetchable. */
const TTL_SECONDS = 30 * 60;

/** Well under Telegram's 5MB ceiling; a 640x400@2x JPEG is ~100-250KB. */
export const MAX_CARD_BYTES = 2 * 1024 * 1024;

/**
 * Holds a share card just long enough for Telegram to come and fetch it.
 *
 * The cards are drawn in the app, on canvas, and already look right — so the
 * backend's only job is to give those bytes a public URL, because
 * `InlineQueryResultPhoto` takes a URL and Telegram fetches it from the open
 * internet. Nothing is rendered here.
 *
 * Kept in Redis rather than MinIO deliberately. The MinIO bucket is KYC-only and
 * everything in it is AES-256-GCM encrypted behind a separate access path; a
 * throwaway image that must be *publicly* readable for half an hour does not
 * belong in it. This matches how `users.controller`'s avatar route and the
 * sitemap already work: generate and serve, do not persist.
 */
@Injectable()
export class ShareCardService {
  private readonly logger = new Logger(ShareCardService.name);

  constructor(private readonly redis: RedisService) {}

  private key(id: string): string {
    return `oro:sharecard:${id}`;
  }

  /**
   * The origin Telegram will fetch from.
   *
   * Falls back to the origin of `TELEGRAM_WEBHOOK_URL`, which is by definition a
   * URL Telegram can already reach this server on — so local development works
   * through the existing tunnel with no extra configuration, and production only
   * needs `PUBLIC_API_URL` if the two ever differ.
   */
  publicBaseUrl(): string | null {
    const explicit = process.env.PUBLIC_API_URL?.trim();
    if (explicit) return explicit.replace(/\/+$/, "");
    const webhook = process.env.TELEGRAM_WEBHOOK_URL?.trim();
    if (!webhook) return null;
    try {
      return new URL(webhook).origin;
    } catch {
      return null;
    }
  }

  /** Public URL for a stored card. Absolute, because Telegram fetches it. */
  urlFor(id: string): string | null {
    const base = this.publicBaseUrl();
    return base ? `${base}/api/share-card/${id}.jpg` : null;
  }

  /**
   * A JPEG, by its magic bytes rather than by what the caller claims.
   *
   * Telegram rejects anything that is not really JPEG, and it does so at send
   * time — long after the upload succeeded — so the failure would surface as a
   * share that silently does nothing. Better to refuse it here.
   */
  static looksLikeJpeg(buf: Buffer): boolean {
    return (
      buf.length > 3 &&
      buf[0] === 0xff &&
      buf[1] === 0xd8 &&
      buf[2] === 0xff
    );
  }

  async store(bytes: Buffer): Promise<string> {
    const id = randomUUID();
    await this.redis.setEx(this.key(id), TTL_SECONDS, bytes.toString("base64"));
    return id;
  }

  async read(id: string): Promise<Buffer | null> {
    const raw = await this.redis.get(this.key(id));
    if (!raw) return null;
    try {
      return Buffer.from(raw, "base64");
    } catch {
      this.logger.warn(`Share card ${id} held unreadable bytes`);
      return null;
    }
  }
}
