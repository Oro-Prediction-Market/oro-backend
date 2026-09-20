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
 * None of this makes a late correction impossible. It narrows the window; the
 * post-settlement audit is what actually catches one.
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
