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
 * Markets whose result only a human can propose.
 *
 * The Nations League has no data provider — our football-data.org plan returns
 * 403 for it — so nothing automated can know a result. An admin enters the
 * score and proposes it from the fixtures page, where the winning outcome is
 * read from the id stored on the fixture row.
 *
 * This governs PROPOSING, not settling. Once a proposal is made it goes
 * through the same objection window as everything else, and settles the same
 * way — see NEVER_AUTO_SETTLE_SOURCES for why this list is no longer part of
 * that one.
 */
export const MANUAL_PROPOSAL_SOURCES = ["unl-manual"] as const;

/**
 * Everything the two auto-settlers must leave alone.
 *
 * Both `KeeperService.handleDisputeWindowExpiry` (every minute) and
 * `AutoResolveMarketsJob.autoResolveExpiredWindows` (every five minutes)
 * settle any RESOLVING market whose objection window has expired with no
 * objections. Either one is enough to settle a market, so a source has to be
 * excluded from BOTH — excluding it from one buys nothing at all.
 *
 * `unl-manual` used to be here, so a Nations League market sat in RESOLVING
 * until an admin resolved it by hand. That was one step too many: the admin
 * who would press "resolve" is the same one who typed the score and proposed
 * it, so the step re-read their own work rather than checking it, while
 * leaving winners unpaid until they next opened the panel.
 *
 * What does check the proposal is the objection window, which these markets
 * get like any other. Worth being clear about the trade: a fixture-linked
 * market is also re-read from football-data before the money moves, and this
 * competition has no feed to re-read, so the window is the only check between
 * a typed score and a payout.
 */
export const NEVER_AUTO_SETTLE_SOURCES: readonly string[] = [
  ...SELF_RESOLVING_SOURCES,
];

const has = (list: readonly string[], source: string | null | undefined) =>
  list.includes((source ?? "").toLowerCase());

/** The keeper leaves these markets alone completely — including opening and closing. */
export function isSelfResolvingSource(source: string | null | undefined): boolean {
  return has(SELF_RESOLVING_SOURCES, source);
}

/**
 * Only an admin may PROPOSE this market's result.
 *
 * In practice this is the test for whether to offer the Telegram one-tap
 * propose keyboard, and the answer is no: that handler writes a raw
 * `marketRepo.update` which bypasses `proposeResolution` entirely and picks
 * the outcome by its LABEL. For a competition whose whole safety story is
 * "the outcome id comes from the fixture row" — because it fields Republic of
 * Ireland and Northern Ireland — a label-matching shortcut is exactly the
 * wrong default. The admin proposes from the fixtures page instead.
 *
 * Says nothing about settling. Once proposed, these settle on the objection
 * window like everything else.
 */
export function requiresManualProposal(
  source: string | null | undefined,
): boolean {
  return has(MANUAL_PROPOSAL_SOURCES, source);
}

/** True when no automated settler may resolve this market. */
export function neverAutoSettles(source: string | null | undefined): boolean {
  return has(NEVER_AUTO_SETTLE_SOURCES, source);
}
