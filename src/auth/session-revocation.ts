/**
 * Whether a token was issued at or before the user's "sign out everywhere"
 * cutoff and so must no longer be accepted.
 *
 * Sessions slide — every refresh mints a new token — so revoking the jti in
 * hand cannot end a session someone else is holding. The cutoff can: every
 * token minted up to that moment fails, and a stolen one cannot be refreshed
 * past it because the refresh has to verify the old token first.
 *
 * `iat` is whole seconds and the cutoff is milliseconds, so the comparison is
 * `<=`: a token minted earlier in the same second as the cutoff is rejected.
 * The cost is that a login landing in that same second is rejected too, which
 * only means signing in again. A token with no `iat` cannot be placed, so once
 * a cutoff exists it fails closed.
 */
export function issuedBeforeRevocation(
  iat: number | undefined,
  sessionsRevokedAt: Date | null | undefined,
): boolean {
  if (!sessionsRevokedAt) return false;
  if (typeof iat !== "number") return true;
  return iat * 1000 <= sessionsRevokedAt.getTime();
}
