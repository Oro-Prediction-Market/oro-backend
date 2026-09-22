/**
 * Reading a football-data.org match into a result we are willing to pay on.
 *
 * On 5 and 19 September 2026 two markets settled against the wrong team. The
 * keeper had asked football-data for the score ~16 minutes after the final
 * whistle, taken what it got, and paid out. Both scores were later corrected —
 * Nottingham Forest v Tottenham finished 0-0 but settled as a Forest win, and
 * Nottingham Forest v Coventry finished 0-1 but settled as a Draw. 62 of the
 * 64 markets checked were right, so the arithmetic was never the problem: the
 * input moved after we read it.
 *
 * `status: "FINISHED"` means "the match is over". It does not mean "this result
 * is final", and the old code treated the two as the same claim. The checks
 * below are what separate them:
 *
 *   - `score.winner` must be present. football-data publishes its own verdict
 *     alongside the goals, and it is null while the record is still being
 *     finalised. The old code never read this field at all, which threw away
 *     the one signal that says "we have not made up our mind yet".
 *
 *   - The goals must agree with that verdict. A record that says AWAY_TEAM
 *     while carrying 0-0 is half-written, and the right response is to wait,
 *     not to pick one of the two.
 *
 *   - The goals must actually be numbers. The old code read
 *     `score.fullTime.home ?? 0`, so a missing score became 0-0 — which is
 *     indistinguishable from a real draw, and paid out as one. Absent data must
 *     stop the settlement, never resolve it.
 *
 * None of these three catches a record that is simply wrong while looking
 * complete — which is the likelier explanation of Forest v Tottenham, since a
 * missing score reads as 0-0 and would have settled as a draw, not as the home
 * win we actually paid. That one needs {@link isFixtureStable} below, which
 * asks a different question: not "is this record usable" but "has the provider
 * finished changing it". The post-settlement audit remains the backstop for a
 * correction that lands after we have already paid.
 */

export type FixtureWinner = "HOME_TEAM" | "AWAY_TEAM" | "DRAW";

export interface FixtureResult {
  winner: FixtureWinner;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  totalGoals: number;
}

export type FixtureReadout =
  | { ok: true; result: FixtureResult }
  /**
   * `settled` distinguishes "the provider has not finished" (wait quietly, this
   * is normal and self-clearing) from "the provider contradicts itself" (a real
   * anomaly worth telling a human about). Callers log the first and escalate
   * the second.
   */
  | { ok: false; reason: string; contradiction: boolean };

const FINAL_STATUSES = ["FINISHED", "AWARDED"];

/** Only a match whose provider has committed to a result is payable. */
export function readFixtureResult(matchData: any): FixtureReadout {
  const status: string = matchData?.status ?? "";
  if (!FINAL_STATUSES.includes(status)) {
    return { ok: false, reason: `not finished (${status || "no status"})`, contradiction: false };
  }

  const score = matchData?.score ?? {};
  const full = score?.fullTime ?? {};
  const homeScore = full?.home;
  const awayScore = full?.away;

  // Deliberately not `?? 0`. A missing score is missing, not nil-nil.
  if (typeof homeScore !== "number" || typeof awayScore !== "number") {
    return {
      ok: false,
      reason: `full-time score incomplete (home=${JSON.stringify(homeScore)}, away=${JSON.stringify(awayScore)})`,
      contradiction: false,
    };
  }

  const winner: unknown = score?.winner;
  if (winner !== "HOME_TEAM" && winner !== "AWAY_TEAM" && winner !== "DRAW") {
    return {
      ok: false,
      reason: `no verdict yet (score.winner=${JSON.stringify(winner)})`,
      contradiction: false,
    };
  }

  const implied: FixtureWinner =
    homeScore > awayScore
      ? "HOME_TEAM"
      : homeScore < awayScore
        ? "AWAY_TEAM"
        : "DRAW";

  // An AWARDED match is a forfeit: the verdict is administrative and is not
  // expected to follow from the goals, so the cross-check does not apply.
  if (status !== "AWARDED" && implied !== winner) {
    return {
      ok: false,
      reason:
        `provider contradicts itself — score.winner=${winner} but ` +
        `full-time ${homeScore}-${awayScore} implies ${implied}`,
      contradiction: true,
    };
  }

  return {
    ok: true,
    result: {
      winner,
      homeTeam: matchData?.homeTeam?.name ?? "",
      awayTeam: matchData?.awayTeam?.name ?? "",
      homeScore,
      awayScore,
      totalGoals: homeScore + awayScore,
    },
  };
}

/**
 * How long a fixture record must sit untouched before we will propose on it.
 *
 * `readFixtureResult` above only asks "is this record complete and internally
 * consistent". It cannot tell a finished record from a provisional one that
 * happens to be well-formed — and that is what settled Nottingham Forest v
 * Tottenham against the wrong team. The record said the home side was ahead,
 * said so consistently, and was later corrected to 0-0. Nothing readable from a
 * single snapshot would have caught it.
 *
 * So the second question is "has the provider stopped changing its mind", and
 * football-data answers it directly: `lastUpdated` moves on every revision.
 * Requiring an hour of quiet is strictly better than waiting a fixed hour after
 * the whistle — a cleanly-finalised record clears the moment it has been stable
 * long enough, and a record still being revised waits exactly as long as the
 * revisions continue, which is the case we actually care about.
 */
export const PROPOSAL_MIN_STABLE_MS = 60 * 60 * 1000;

/**
 * Used only when `lastUpdated` is absent or unusable. A match runs about two
 * hours including stoppages and half time, so this is roughly ninety minutes
 * past a normal full-time whistle.
 *
 * It exists so that a provider quietly dropping the field degrades to a slower
 * guard rather than to no guard at all — a stability check that silently
 * disappears when its input does is worse than no check, because it still looks
 * present in the code.
 */
export const PROPOSAL_FALLBACK_MIN_AGE_MS = 3.5 * 60 * 60 * 1000;

export type StabilityReadout =
  | { stable: true; reason: string }
  | { stable: false; reason: string };

/**
 * Whether the provider has left this fixture alone long enough to pay on it.
 *
 * Deliberately separate from {@link readFixtureResult}: that one answers "is
 * this record usable", this one answers "is it finished changing". A record can
 * pass the first and fail the second, which is exactly the September failure.
 *
 * Returns `stable: false` when it cannot tell — a fixture carrying neither a
 * usable `lastUpdated` nor a usable `utcDate` never proposes and waits for an
 * admin. That parks the market, which is the safe direction: an unpaid market
 * is visible and reversible, a wrongly paid one is neither.
 */
export function isFixtureStable(
  matchData: any,
  now: Date = new Date(),
  minStableMs: number = PROPOSAL_MIN_STABLE_MS,
): StabilityReadout {
  const lastUpdated = parseInstant(matchData?.lastUpdated);

  if (lastUpdated !== null) {
    const quietFor = now.getTime() - lastUpdated.getTime();

    // A timestamp in the future is clock skew or provider nonsense. A little is
    // harmless and resolves itself as the clock catches up; a lot would park
    // the market until the date arrived, so past that point we stop believing
    // the field and fall through to the kickoff rule.
    if (quietFor < -minStableMs) {
      return fromKickoff(matchData, now, "lastUpdated is implausibly far ahead");
    }

    if (quietFor >= minStableMs) {
      return {
        stable: true,
        reason: `unchanged for ${Math.floor(quietFor / 60_000)} min`,
      };
    }

    const waitMin = Math.ceil((minStableMs - quietFor) / 60_000);
    return {
      stable: false,
      reason:
        `provider last revised this record ` +
        `${Math.max(0, Math.floor(quietFor / 60_000))} min ago — ` +
        `waiting another ${waitMin} min for it to settle`,
    };
  }

  return fromKickoff(matchData, now, "no usable lastUpdated");
}

function fromKickoff(
  matchData: any,
  now: Date,
  why: string,
): StabilityReadout {
  const kickoff = parseInstant(matchData?.utcDate);
  if (kickoff === null) {
    return {
      stable: false,
      reason: `${why}, and no usable utcDate either — cannot judge staleness`,
    };
  }

  const sinceKickoff = now.getTime() - kickoff.getTime();
  if (sinceKickoff >= PROPOSAL_FALLBACK_MIN_AGE_MS) {
    return {
      stable: true,
      reason: `${why}; ${Math.floor(sinceKickoff / 60_000)} min past kickoff`,
    };
  }

  const waitMin = Math.ceil((PROPOSAL_FALLBACK_MIN_AGE_MS - sinceKickoff) / 60_000);
  return {
    stable: false,
    reason: `${why}; only ${Math.floor(sinceKickoff / 60_000)} min past kickoff — waiting another ${waitMin} min`,
  };
}

/** null for absent, non-string, or unparseable — every one means "cannot use this". */
function parseInstant(raw: unknown): Date | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Fetch one match. Returns null on any transport or HTTP failure — every caller
 * treats "could not ask" the same as "not ready", and must never settle on it.
 */
export async function fetchFixture(
  matchId: number,
  apiKey: string,
): Promise<any | null> {
  try {
    const res = await fetch(
      `https://api.football-data.org/v4/matches/${matchId}`,
      {
        headers: { "X-Auth-Token": apiKey },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
