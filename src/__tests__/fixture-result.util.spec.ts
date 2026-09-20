import { readFixtureResult } from "../markets/fixture-result.util";

/**
 * These cases are the September 2026 wrong settlements, written down.
 *
 * Two markets paid out against the wrong team because the keeper read
 * football-data minutes after the final whistle and treated `status: FINISHED`
 * as "this result is final". Every "must not resolve" case below is a shape the
 * old code would have happily turned into a payout.
 */

const finished = (score: Record<string, unknown>) => ({
  status: "FINISHED",
  homeTeam: { name: "Nottingham Forest FC" },
  awayTeam: { name: "Coventry City FC" },
  score,
});

describe("readFixtureResult", () => {
  describe("refuses anything that is not a committed result", () => {
    it("refuses a match that is not over", () => {
      const r = readFixtureResult({
        status: "IN_PLAY",
        score: { winner: "DRAW", fullTime: { home: 0, away: 0 } },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.contradiction).toBe(false);
    });

    // The exact bug: `score.fullTime.home ?? 0` turned an absent score into
    // 0-0, which is indistinguishable from a real draw and was paid out as one.
    it("refuses a missing full-time score instead of reading it as 0-0", () => {
      const r = readFixtureResult(finished({ winner: "DRAW", fullTime: {} }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/incomplete/);
    });

    it("refuses a half-populated score", () => {
      const r = readFixtureResult(
        finished({ winner: "HOME_TEAM", fullTime: { home: 1, away: null } }),
      );
      expect(r.ok).toBe(false);
    });

    it("refuses a score object that is missing entirely", () => {
      const r = readFixtureResult({ status: "FINISHED" });
      expect(r.ok).toBe(false);
    });

    // The signal the old code never read. Null here means the provider has not
    // made up its mind, which is precisely the window both bad settlements
    // landed in.
    it("refuses a match with no verdict yet", () => {
      const r = readFixtureResult(
        finished({ winner: null, fullTime: { home: 0, away: 0 } }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/no verdict/);
    });

    it("refuses an unrecognised verdict", () => {
      const r = readFixtureResult(
        finished({ winner: "PENALTY_SHOOTOUT", fullTime: { home: 1, away: 1 } }),
      );
      expect(r.ok).toBe(false);
    });
  });

  describe("cross-checks the verdict against the goals", () => {
    it("flags a provider contradicting itself, and marks it as such", () => {
      const r = readFixtureResult(
        finished({ winner: "AWAY_TEAM", fullTime: { home: 0, away: 0 } }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.contradiction).toBe(true);
        expect(r.reason).toMatch(/contradicts itself/);
      }
    });

    // A forfeit's verdict is administrative and need not follow from the goals,
    // so the cross-check must not reject it.
    it("allows an AWARDED match whose verdict does not follow from the goals", () => {
      const r = readFixtureResult({
        ...finished({ winner: "AWAY_TEAM", fullTime: { home: 0, away: 0 } }),
        status: "AWARDED",
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.result.winner).toBe("AWAY_TEAM");
    });
  });

  describe("accepts a complete, self-consistent result", () => {
    it("reads an away win", () => {
      const r = readFixtureResult(
        finished({ winner: "AWAY_TEAM", fullTime: { home: 0, away: 1 } }),
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.result.winner).toBe("AWAY_TEAM");
        expect(r.result.awayTeam).toBe("Coventry City FC");
        expect(r.result.totalGoals).toBe(1);
      }
    });

    it("reads a home win", () => {
      const r = readFixtureResult(
        finished({ winner: "HOME_TEAM", fullTime: { home: 2, away: 1 } }),
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.result.winner).toBe("HOME_TEAM");
    });

    it("reads a genuine draw", () => {
      const r = readFixtureResult(
        finished({ winner: "DRAW", fullTime: { home: 0, away: 0 } }),
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.result.winner).toBe("DRAW");
    });

    it("keeps a 0-0 draw distinguishable from a missing score", () => {
      const real = readFixtureResult(
        finished({ winner: "DRAW", fullTime: { home: 0, away: 0 } }),
      );
      const absent = readFixtureResult(finished({ winner: "DRAW", fullTime: {} }));
      expect(real.ok).toBe(true);
      expect(absent.ok).toBe(false);
    });
  });

  describe("the two markets that actually settled wrong", () => {
    // Match 560589 — settled "Draw", finished 0-1 to Coventry.
    it("reads Forest 0-1 Coventry as an away win, never a draw", () => {
      const r = readFixtureResult(
        finished({ winner: "AWAY_TEAM", duration: "REGULAR", fullTime: { home: 0, away: 1 } }),
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.result.winner).toBe("AWAY_TEAM");
    });

    // Match 560562 — settled "Nottingham Forest FC", finished 0-0.
    it("reads Forest 0-0 Tottenham as a draw, never a home win", () => {
      const r = readFixtureResult(
        finished({ winner: "DRAW", duration: "REGULAR", fullTime: { home: 0, away: 0 } }),
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.result.winner).toBe("DRAW");
    });
  });
});
