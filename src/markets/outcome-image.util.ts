import { createHash } from "crypto";

/**
 * Outcome images that live inside the JSON, and how to get them out of it.
 *
 * Some outcome images are stored as `data:image/png;base64,...` rather than a
 * URL — club crests, mostly. Measured on the live market list: 55 of 171
 * outcomes carried one, together 206KB of a 320KB response. The 88 outcomes
 * with a real URL averaged 97 bytes; the inlined ones averaged 3,833.
 *
 * Size is only half of it. A data URI sits in the response body, so the
 * browser cannot cache it — it is re-sent and re-parsed on every request, and
 * the Mini App feed reloads every ten seconds. The same crests were being
 * pushed down the wire six times a minute, per viewer, on mobile data.
 *
 * So list responses can hand back a reference instead, pointing at an endpoint
 * that serves the decoded bytes with a long-lived cache header. The image is
 * then fetched once and reused, which is what it should always have been.
 *
 * The reference carries a fingerprint of the image. Without it the URL would
 * be stable for all time while the image behind it could change, and an
 * immutable cache header would pin the old one on every device that had seen
 * it. With it, replacing an image changes its URL.
 */

/** Path (relative to the API root) that serves a decoded outcome image. */
export const OUTCOME_IMAGE_ROUTE = "markets/outcome-image";

export function isDataUri(url: string | null | undefined): boolean {
  return typeof url === "string" && url.startsWith("data:");
}

/** Short, stable fingerprint of the image bytes. Not a security boundary. */
export function dataUriTag(dataUri: string): string {
  return createHash("sha1").update(dataUri).digest("hex").slice(0, 12);
}

/**
 * What a list response puts in `imageUrl` in place of the data URI.
 *
 * Deliberately origin-relative. The API and the apps are on different hosts,
 * and this process cannot reliably know its own public origin — there is no
 * configured base URL, and `req.protocol` behind a TLS-terminating proxy
 * reports "http", which would emit an http image URL onto an https page and
 * have the browser block it as mixed content. The client already builds
 * absolute API URLs from its own VITE_API_URL (see `avatarUrl`), so it is the
 * side that knows, and it prefixes this.
 */
export function outcomeImageRef(outcomeId: string, dataUri: string): string {
  return `/${OUTCOME_IMAGE_ROUTE}/${outcomeId}?v=${dataUriTag(dataUri)}`;
}

/** `data:<mime>;base64,<payload>` → bytes, or null if it is not one we can serve. */
export function decodeDataUri(
  dataUri: string,
): { mime: string; body: Buffer } | null {
  const m = /^data:([a-z0-9.+/-]+);base64,(.*)$/is.exec(dataUri.trim());
  if (!m) return null;
  const [, mime, payload] = m;
  // Only images. This endpoint is public and unauthenticated, so it must not
  // become a way to serve arbitrary stored bytes with a content type of the
  // writer's choosing.
  if (!mime.toLowerCase().startsWith("image/")) return null;
  try {
    const body = Buffer.from(payload, "base64");
    return body.length > 0 ? { mime, body } : null;
  } catch {
    return null;
  }
}

/**
 * Replace inlined images with references, without touching anything else.
 *
 * Returns new objects rather than mutating: the markets handed in may have
 * come straight from the Redis cache, and rewriting them in place would leave
 * the cached copy in whatever shape the last caller happened to want.
 */
export function withOutcomeImageRefs<
  T extends { outcomes?: { id: string; imageUrl?: string | null }[] | null },
>(markets: T[]): T[] {
  return markets.map((market) => {
    const outcomes = market.outcomes;
    if (!outcomes?.some((o) => isDataUri(o.imageUrl))) return market;
    return {
      ...market,
      outcomes: outcomes.map((o) =>
        isDataUri(o.imageUrl)
          ? { ...o, imageUrl: outcomeImageRef(o.id, o.imageUrl as string) }
          : o,
      ),
    };
  });
}
