// ─────────────────────────────────────────────────────────────────────────────
// FIFA World Cup 2026 — Knockout bracket topology (backend copy)
//
// Mirrors oro-pwa/shared/data/wcKnockout.ts. Used to auto-create the next-round
// wc-match market when the two feeder matches that lead into a slot are decided.
//
// Topology rule (same one the frontend connectors use): the two feeder slots
// `<round>-<2k+1>` and `<round>-<2k+2>` (1-based) advance their winners into
// slot `<nextRound>-<k+1>`.
//
// ⚠️  Kickoffs are anchored to Bhutan time (Asia/Thimphu, +06:00). Keep these in
//     sync with the frontend file — that remains the source of truth for display.
// ─────────────────────────────────────────────────────────────────────────────

/** Ordered knockout rounds. A slot's next round is the following entry. */
export const WC_ROUND_ORDER = ["r32", "r16", "qf", "sf", "final"] as const;

/** Kickoff per next-round slot, used as the new market's `closesAt`. null = TBD. */
export const WC_KICKOFFS: Record<string, string | null> = {
  "r16-1": "2026-07-04T23:00:00+06:00",
  "r16-2": "2026-07-05T03:00:00+06:00",
  "r16-3": "2026-07-07T06:00:00+06:00",
  "r16-4": "2026-07-07T01:00:00+06:00",
  "r16-5": "2026-07-06T02:00:00+06:00",
  "r16-6": "2026-07-06T06:00:00+06:00",
  "r16-7": "2026-07-08T02:00:00+06:00",
  "r16-8": null,
  "qf-1": "2026-07-10T02:00:00+06:00",
  "qf-2": "2026-07-11T01:00:00+06:00",
  "qf-3": "2026-07-12T03:00:00+06:00",
  "qf-4": "2026-07-12T07:00:00+06:00",
  "sf-1": null,
  "sf-2": null,
  "final-1": null,
};

export interface BracketAdvance {
  /** The slot the winners advance into, e.g. "r16-1". */
  nextSlotId: string;
  /** The two feeder slots in bracket order [team1 slot, team2 slot]. */
  feeders: [string, string];
}

/**
 * Given a feeder slot id (e.g. "r32-3"), return the next-round slot it advances
 * into and the ordered pair of feeder slots for that next slot. Returns null for
 * the final (no next round) or an unparseable id.
 */
export function bracketAdvance(slotId: string): BracketAdvance | null {
  const m = /^(r32|r16|qf|sf|final)-(\d+)$/.exec(slotId);
  if (!m) return null;
  const round = m[1] as (typeof WC_ROUND_ORDER)[number];
  const n = parseInt(m[2], 10);
  if (!Number.isFinite(n) || n < 1) return null;

  const ri = WC_ROUND_ORDER.indexOf(round);
  if (ri < 0 || ri >= WC_ROUND_ORDER.length - 1) return null; // final has no next

  const i = n - 1; // 0-based index within the round
  const k = Math.floor(i / 2); // 0-based index within the next round
  const nextRound = WC_ROUND_ORDER[ri + 1];

  return {
    nextSlotId: `${nextRound}-${k + 1}`,
    feeders: [`${round}-${2 * k + 1}`, `${round}-${2 * k + 2}`],
  };
}
