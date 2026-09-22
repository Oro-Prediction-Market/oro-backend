import {
  isFixtureStable,
  PROPOSAL_FALLBACK_MIN_AGE_MS,
  PROPOSAL_MIN_STABLE_MS,
  readFixtureResult,
} from "../markets/fixture-result.util";

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

/**
 * The second question, asked after the record is known to be readable: has the
 * provider stopped changing it?
 *
 * Forest v Tottenham is the case that needs this. A missing score would have
 * read as 0-0 and settled as a draw; we paid a home win, so the record was
 * populated, self-consistent and wrong. No single snapshot distinguishes that
 * from a correct one — only watching it stop moving does.
 *
 * Derived from the exported constants rather than hardcoding "60 minutes": the
 * window is policy and the tests should keep passing when it is retuned. A test
 * that fails because a number changed tells you nothing about behaviour.
 */
const NOW = new Date("2026-09-05T23:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe("isFixtureStable", () => {
  describe("when the provider tells us when it last touched the record", () => {
    it("allows a record that has been quiet for the full window", () => {
      const r = isFixtureStable({ lastUpdated: ago(PROPOSAL_MIN_STABLE_MS) }, NOW);
      expect(r.stable).toBe(true);
    });

    it("holds a record revised moments ago", () => {
      const r = isFixtureStable({ lastUpdated: ago(60_000) }, NOW);
      expect(r.stable).toBe(false);
      expect(r.reason).toMatch(/waiting another/);
    });

    // The whole point: a revision restarts the clock. This is the shape that
    // would have stopped match 560562 from paying out.
    it("restarts the clock when the provider revises a nearly-ready record", () => {
      const nearlyReady = { lastUpdated: ago(PROPOSAL_MIN_STABLE_MS - 60_000) };
      expect(isFixtureStable(nearlyReady, NOW).stable).toBe(false);

      // Provider corrects the score; lastUpdated jumps to now.
      const revised = { lastUpdated: ago(0) };
      expect(isFixtureStable(revised, NOW).stable).toBe(false);

      // And an hour after the revision, not an hour after the original read.
      const later = new Date(NOW.getTime() + PROPOSAL_MIN_STABLE_MS);
      expect(isFixtureStable(revised, later).stable).toBe(true);
    });

    it("is exclusive at the boundary by one millisecond, not inclusive", () => {
      expect(
        isFixtureStable({ lastUpdated: ago(PROPOSAL_MIN_STABLE_MS - 1) }, NOW).stable,
      ).toBe(false);
    });
  });

  describe("when lastUpdated is unusable", () => {
    const kickoff = (ms: number) => ({ utcDate: ago(ms) });

    it("falls back to time since kickoff when the field is absent", () => {
      expect(isFixtureStable(kickoff(PROPOSAL_FALLBACK_MIN_AGE_MS), NOW).stable).toBe(true);
      expect(isFixtureStable(kickoff(PROPOSAL_FALLBACK_MIN_AGE_MS - 60_000), NOW).stable).toBe(
        false,
      );
    });

    it("treats an unparseable timestamp as absent rather than as now", () => {
      const r = isFixtureStable(
        { lastUpdated: "not a date", utcDate: ago(PROPOSAL_FALLBACK_MIN_AGE_MS) },
        NOW,
      );
      expect(r.stable).toBe(true);
      expect(r.reason).toMatch(/no usable lastUpdated/);
    });

    // A far-future timestamp would otherwise park the market until that date
    // arrived. Small skew is tolerated and clears itself; large skew is not
    // believed at all.
    it("stops believing a lastUpdated that is implausibly far ahead", () => {
      const r = isFixtureStable(
        {
          lastUpdated: new Date(NOW.getTime() + 10 * PROPOSAL_MIN_STABLE_MS).toISOString(),
          utcDate: ago(PROPOSAL_FALLBACK_MIN_AGE_MS),
        },
        NOW,
      );
      expect(r.stable).toBe(true);
      expect(r.reason).toMatch(/implausibly far ahead/);
    });

    it("tolerates small clock skew by simply waiting", () => {
      const r = isFixtureStable(
        { lastUpdated: new Date(NOW.getTime() + 60_000).toISOString() },
        NOW,
      );
      expect(r.stable).toBe(false);
    });

    // Refusing forever parks the market for an admin. That is the safe
    // direction: an unpaid market is visible and reversible.
    it("refuses when it cannot judge staleness at all", () => {
      const r = isFixtureStable({}, NOW);
      expect(r.stable).toBe(false);
      expect(r.reason).toMatch(/cannot judge staleness/);
    });
  });
});
