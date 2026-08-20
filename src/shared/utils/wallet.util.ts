import { KycStatus, User } from "../../entities/user.entity";

export const BTN = "BTN";
export const USDT = "USDT";

/**
 * Which currencies an account may hold.
 *
 * `users.currency` is the account's **native** currency, fixed at signup: BTN
 * for a Bhutanese account, USDT for one created through Google. It stays the
 * currency every existing feature reads — streaks, seasons, leaderboards,
 * bonuses and the DK Bank rail all keep using it, unchanged.
 *
 * A second, USDT-only wallet sits alongside it. A Bhutanese user who holds
 * USDT elsewhere can deposit it here and stake it in the USDT book, without
 * that touching their ngultrum balance in any way. There is no conversion
 * between the two and there is no rate anywhere: they are separate claims that
 * happen to belong to the same person.
 *
 * The reverse does not exist. A USDT-native account cannot hold BTN, because
 * BTN only enters through DK Bank, which requires a Bhutanese identity.
 */
export function allowedCurrencies(
  user: Pick<User, "currency" | "kycStatus" | "dkAccountNumber">,
): string[] {
  const native = user.currency ?? BTN;
  if (native === USDT) return [USDT];
  return usdtIdentityVerified(user) ? [BTN, USDT] : [BTN];
}

/**
 * Whether this account has proved its identity well enough to move USDT.
 *
 * Two routes, because they prove the same thing:
 *
 * - An **approved KYC document**. The only route for an account created
 *   through Google, which has no Bhutanese identity behind it.
 * - A **linked DK Bank account**. A verified CID is national identity checked
 *   by a bank — strictly stronger evidence than a photograph of a passport
 *   read by a reviewer. Requiring a document on top of it would put the
 *   best-identified users in the slowest queue for no gain.
 *
 * Note what this is **not**: being a USDT-native account is not evidence of
 * anything. An account created through Google starts unverified, and the whole
 * point of the deposit gate is that it cannot fund itself until a human has
 * approved a document. An earlier version of this function short-circuited on
 * `currency === "USDT"` and silently removed that gate for every international
 * user — the exact people it exists for.
 */
export function usdtIdentityVerified(
  user: Pick<User, "currency" | "kycStatus" | "dkAccountNumber">,
): boolean {
  if (user.kycStatus === KycStatus.APPROVED) return true;
  return Boolean(user.dkAccountNumber);
}

/**
 * Resolve the currency a request is asking to move, and refuse anything this
 * account cannot hold.
 *
 * Omitted means the native currency, so every existing caller keeps its
 * current behaviour without passing anything.
 */
export function resolveWalletCurrency(
  user: Pick<User, "currency" | "kycStatus" | "dkAccountNumber">,
  requested?: string | null,
): { currency: string; allowed: boolean } {
  const native = user.currency ?? BTN;
  if (!requested) return { currency: native, allowed: true };
  const currency = String(requested).toUpperCase();
  return { currency, allowed: allowedCurrencies(user).includes(currency) };
}
