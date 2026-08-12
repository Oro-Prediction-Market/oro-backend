/**
 * Redaction helpers for logs.
 *
 * Never write full contact details or credentials to logs — mask them so
 * operational logs stay useful (you can still tell *which* record) without
 * leaking a user's phone or email into log storage.
 */

/** "+97517123456" → "*******3456". Keeps only the last 4 digits. */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return "****";
  const p = String(phone);
  if (p.length <= 4) return "****";
  return p.slice(0, -4).replace(/\d/g, "*") + p.slice(-4);
}

/** "alice@example.com" → "a***@***.com". Keeps first initial and the TLD. */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return "****";
  const s = String(email).trim();
  const at = s.indexOf("@");
  if (at <= 0 || at === s.length - 1) return "****";
  const name = s.slice(0, at);
  const domain = s.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const maskedDomain = dot > 0 ? "***" + domain.slice(dot) : "***";
  return `${name[0]}***@${maskedDomain}`;
}
