import {
  decidedTiesFrom,
  matchMarketToTie,
} from "../markets/keeper.service";

/**
 * "Who advances" markets resolve by comparing club names, not scores. Nothing
 * links a market to a bracket tie but the text, so the matching is the whole
 * correctness argument for these markets — and it is shared by three callers
 * (propose, re-check before settling, daily audit). If they ever match
 * different ties they contradict each other rather than the provider, which
 * reads as verification while being none.
 *
 * The cases below are mostly about refusing, not matching. A wrong pairing here
 * pays the wrong club with complete confidence and nothing downstream questions
 * it, because every downstream check uses this same function.
 */

const club = (name: string, short: string) => ({ name, short });

const tie = (
  a: [string, string],
  b: [string, string],
  winner: "a" | "b" | null,
  extra: { lastUpdated?: string; decidedLegKickoff?: string } = {},
) => ({
  a: club(...a),
  b: club(...b),
  winner,
  lastUpdated: extra.lastUpdated ?? null,
  decidedLegKickoff: extra.decidedLegKickoff ?? null,
});

const bracketOf = (matches: ReturnType<typeof tie>[]) => ({
  rounds: [{ matches }],
});

const outcome = (id: string, label: string) => ({ id, label });

describe("decidedTiesFrom", () => {
  it("keeps only ties the bracket has actually decided", () => {
    const ties = decidedTiesFrom(
      bracketOf([
        tie(["Real Madrid CF", "RMA"], ["Arsenal FC", "ARS"], "a"),
        tie(["FC Bayern München", "FCB"], ["Inter Milan", "INT"], null),
      ]),
    );
    expect(ties).toHaveLength(1);
    expect(ties[0].winner).toBe("Real Madrid CF");
  });

  it("ignores a half-drawn tie with only one club", () => {
    const ties = decidedTiesFrom({
      rounds: [
        {
          matches: [
            { a: club("Arsenal FC", "ARS"), b: null, winner: "a" },
            { a: null, b: club("Arsenal FC", "ARS"), winner: "b" },
          ],
        },
      ],
    });
    expect(ties).toHaveLength(0);
  });

  // The keeper needs these to decide whether the tie has stopped moving. If
  // they were dropped here the stability gate would silently pass everything.
  it("carries the provenance timestamps through", () => {
    const ties = decidedTiesFrom(
      bracketOf([
        tie(["Real Madrid CF", "RMA"], ["Arsenal FC", "ARS"], "a", {
          lastUpdated: "2026-09-05T21:00:00Z",
          decidedLegKickoff: "2026-09-05T19:00:00Z",
        }),
      ]),
    );
    expect(ties[0].lastUpdated).toBe("2026-09-05T21:00:00Z");
    expect(ties[0].decidedLegKickoff).toBe("2026-09-05T19:00:00Z");
  });

  it("survives a bracket with no rounds at all", () => {
    expect(decidedTiesFrom({ rounds: [] })).toEqual([]);
  });
});

describe("matchMarketToTie", () => {
  const ties = decidedTiesFrom(
    bracketOf([
      tie(["Real Madrid CF", "RMA"], ["Arsenal FC", "ARS"], "a"),
      tie(["FC Bayern München", "FCB"], ["Inter Milan", "INT"], "b"),
    ]),
  );

  it("matches a market to its tie and names the club that advanced", () => {
    const hit = matchMarketToTie(
      [outcome("o1", "Real Madrid CF"), outcome("o2", "Arsenal FC")],
      ties,
    );
    expect(hit?.winningOutcomeId).toBe("o1");
  });

  it("matches when the market spells a club shorter than the bracket does", () => {
    const hit = matchMarketToTie(
      [outcome("o1", "Real Madrid"), outcome("o2", "Arsenal")],
      ties,
    );
    expect(hit?.winningOutcomeId).toBe("o1");
  });

  it("looks past accents, which the bracket carries and market labels may not", () => {
    const hit = matchMarketToTie(
      [outcome("o1", "Bayern Munchen"), outcome("o2", "Inter Milan")],
      ties,
    );
    expect(hit?.winningOutcomeId).toBe("o2");
  });

  it("returns the losing side's outcome id for a tie the other club won", () => {
    const hit = matchMarketToTie(
      [outcome("o1", "FC Bayern München"), outcome("o2", "Inter Milan")],
      ties,
    );
    expect(hit?.winningOutcomeId).toBe("o2");
  });

  describe("refuses rather than guesses", () => {
    it("refuses a market whose clubs match no decided tie", () => {
      expect(
        matchMarketToTie(
          [outcome("o1", "Chelsea FC"), outcome("o2", "FC Porto")],
          ties,
        ),
      ).toBeNull();
    });

    // Both clubs match, but two different ties. Picking the first would be
    // picking at random with real money behind it.
    it("refuses when two decided ties both fit", () => {
      const duplicated = decidedTiesFrom(
        bracketOf([
          tie(["Real Madrid CF", "RMA"], ["Arsenal FC", "ARS"], "a"),
          tie(["Real Madrid CF", "RMA"], ["Arsenal FC", "ARS"], "b"),
        ]),
      );
      expect(
        matchMarketToTie(
          [outcome("o1", "Real Madrid CF"), outcome("o2", "Arsenal FC")],
          duplicated,
        ),
      ).toBeNull();
    });

    // The failure this guards: two outcomes whose labels both contain the
    // winner's name. Paying "the first one that matched" is how a loose
    // substring rule turns into a wrong payout.
    it("refuses when the advancing club matches two of the market's outcomes", () => {
      const madridDerby = decidedTiesFrom(
        bracketOf([tie(["Real Madrid", "RMA"], ["Madrid", "MAD"], "a")]),
      );
      expect(
        matchMarketToTie(
          [outcome("o1", "Real Madrid"), outcome("o2", "Madrid")],
          madridDerby,
        ),
      ).toBeNull();
    });

    it("refuses a market with fewer than two outcomes", () => {
      expect(matchMarketToTie([outcome("o1", "Real Madrid CF")], ties)).toBeNull();
    });

    it("refuses against an empty bracket rather than throwing", () => {
      expect(
        matchMarketToTie(
          [outcome("o1", "Real Madrid CF"), outcome("o2", "Arsenal FC")],
          [],
        ),
      ).toBeNull();
    });
  });
});
