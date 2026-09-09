/**
 * The seven reputation rungs, in one place.
 *
 * This file exists because the ladder was previously written out by hand in
 * every surface that displayed it. When the ladder grew from four rungs to
 * seven, the Telegram bot's copies were missed, so every Scout, Analyst and
 * Prophet was shown as "Rookie" — a silent wrong answer, because a ternary
 * chain has no way to say "I don't know this tier".
 *
 * Anything that turns a stored `reputationTier` into text should call
 * `tierLabel()` rather than matching on the string itself.
 *
 * The rung a user earns is decided by `calcTier()` in reputation.service.ts —
 * that is the authority on thresholds. This file only names them.
 */

/**
 * Lowest to highest. Order is meaningful: a promotion is a move to a higher
 * index, which is how the settlement notification decides whether to fire.
 */
export const TIER_ORDER = [
  "rookie",
  "scout",
  "sharpshooter",
  "analyst",
  "hot_hand",
  "prophet",
  "legend",
] as const;

export type ReputationTier = (typeof TIER_ORDER)[number];

export const TIER_LABELS: Record<string, string> = {
  rookie: "Rookie",
  scout: "Scout",
  sharpshooter: "Sharpshooter",
  analyst: "Analyst",
  hot_hand: "Hot Hand",
  prophet: "Prophet",
  legend: "Legend",
};

/**
 * Display name for a stored tier.
 *
 * Falls back to "Rookie" for null (a user who has never been scored) and for
 * anything unrecognised. The fallback is a last resort, not a design: if a new
 * rung is added to calcTier it must be added here too, or it will quietly read
 * as Rookie exactly the way Scout once did.
 */
export function tierLabel(tier: string | null | undefined): string {
  return TIER_LABELS[tier ?? "rookie"] ?? "Rookie";
}
