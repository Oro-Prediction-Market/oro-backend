/**
 * Which markets the automated settlers are allowed to touch.
 *
 * Two different reasons produce the same "skip" behaviour, and keeping them
 * apart is the point of this file. Before it existed, `["ter", "btc"]` was
 * written out at five separate call sites, each meaning something slightly
 * different, and a third source could only be added by finding all five and
 * guessing which ones applied to it.
 */

/**
 * Markets whose own service drives them end to end.
 *
 * TER and BTC price markets open, close and resolve themselves on a schedule
 * the keeper knows nothing about. The keeper skips them **entirely** — it does
 * not even close them at their deadline — because two systems transitioning
 * the same market is how a market ends up closed twice or settled twice.
 */
export const SELF_RESOLVING_SOURCES = ["ter", "btc"] as const;

/**
 * Markets that a human resolves, and nothing else may.
 *
 * The Nations League has no data provider — our football-data.org plan returns
 * 403 for it — so there is no feed to check a proposal against and no way for
 * software to know a result. An admin enters the score, an admin proposes, and
 * an admin resolves.
 *
 * Unlike the self-resolving sources, these markets DO get opened and closed by
 * the keeper on schedule. It is only the settling that is withheld.
 */
export const MANUAL_ONLY_SOURCES = ["unl-manual"] as const;

/**
 * Everything the two auto-settlers must leave alone.
 *
 * Both `KeeperService.handleDisputeWindowExpiry` (every minute) and
 * `AutoResolveMarketsJob.autoResolveExpiredWindows` (every five minutes)
 * settle any RESOLVING market whose objection window has expired with no
 * objections. Either one is enough to settle a market, so a source has to be
 * excluded from BOTH — excluding it from one buys nothing at all.
 */
export const NEVER_AUTO_SETTLE_SOURCES: readonly string[] = [
  ...SELF_RESOLVING_SOURCES,
  ...MANUAL_ONLY_SOURCES,
];

const has = (list: readonly string[], source: string | null | undefined) =>
  list.includes((source ?? "").toLowerCase());

/** The keeper leaves these markets alone completely — including opening and closing. */
export function isSelfResolvingSource(source: string | null | undefined): boolean {
  return has(SELF_RESOLVING_SOURCES, source);
}

/**
 * Only an admin may settle this market.
 *
 * Also the test for whether to offer the Telegram one-tap propose keyboard:
 * that handler writes a raw `marketRepo.update` which bypasses
 * `proposeResolution` entirely and picks the outcome by its LABEL. For a
 * competition whose whole safety story is "the outcome id comes from the
 * fixture row" — because it fields Republic of Ireland and Northern Ireland —
 * a label-matching shortcut is exactly the wrong default.
 */
export function isManualOnlySource(source: string | null | undefined): boolean {
  return has(MANUAL_ONLY_SOURCES, source);
}

/** True when no automated settler may resolve this market. */
export function neverAutoSettles(source: string | null | undefined): boolean {
  return has(NEVER_AUTO_SETTLE_SOURCES, source);
}
