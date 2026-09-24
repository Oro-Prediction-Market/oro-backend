import {
  computeGroupTable,
  StandingsFixture,
  StandingsTeam,
} from "../markets/unl-standings.util";

/**
 * The Nations League has no provider, so this function is the only thing
 * standing between a typed-in score and a wrong table. Two of the cases below
 * are regressions written down rather than hypotheticals:
 *
 *  - "does not read a missing score as nil-nil" is the September 2026 bug that
 *    settled Nottingham Forest v Coventry as a draw, ported to this code path.
 *  - the head-to-head cases are the ones a points → GD → GF sort gets wrong,
 *    which in a four-team group is a common outcome rather than an edge case.
 */

const team = (id: string, name: string, sortOrder = 0): StandingsTeam => ({
  id,
  name,
  flagUrl: `https://flags.example/${id}.svg`,
  sortOrder,
});

const played = (
  home: string,
  homeScore: number,
  awayScore: number,
  away: string,
): StandingsFixture => ({
  homeTeamId: home,
  awayTeamId: away,
  homeScore,
  awayScore,
});

const unplayed = (home: string, away: string): StandingsFixture => ({
  homeTeamId: home,
  awayTeamId: away,
  homeScore: null,
  awayScore: null,
});

// Group A as the screenshot shows it.
const FRA = team("fra", "France", 0);
const ITA = team("ita", "Italy", 1);
const BEL = team("bel", "Belgium", 2);
const TUR = team("tur", "Türkiye", 3);
const GROUP_A = [FRA, ITA, BEL, TUR];

const names = (rows: { teamName: string }[]) => rows.map((r) => r.teamName);

describe("computeGroupTable", () => {
  describe("before anything is played", () => {
    it("lists every team on zero, not an empty table", () => {
      const rows = computeGroupTable(GROUP_A, []);
      expect(rows).toHaveLength(4);
      for (const r of rows) {
        expect(r.played).toBe(0);
        expect(r.points).toBe(0);
        expect(r.gd).toBe(0);
      }
      expect(rows.map((r) => r.position)).toEqual([1, 2, 3, 4]);
    });

    it("falls back to sortOrder so the order is stable between reads", () => {
      const rows = computeGroupTable(GROUP_A, []);
      expect(names(rows)).toEqual(["France", "Italy", "Belgium", "Türkiye"]);
    });

    it("carries the flag through as the badge", () => {
      const rows = computeGroupTable([FRA], []);
      expect(rows[0].teamBadge).toBe("https://flags.example/fra.svg");
    });

    it("uses an empty badge rather than null when no flag is set", () => {
      const rows = computeGroupTable([{ ...FRA, flagUrl: null }], []);
      expect(rows[0].teamBadge).toBe("");
    });
  });

  describe("reads scores strictly", () => {
    // THE September bug, in this code path: `?? 0` would make this a 0-0 draw
    // and hand both teams a point they did not earn.
    it("does not read a missing score as nil-nil", () => {
      const rows = computeGroupTable(GROUP_A, [unplayed("fra", "ita")]);
      expect(rows.every((r) => r.played === 0)).toBe(true);
      expect(rows.every((r) => r.points === 0)).toBe(true);
    });

    it("refuses a half-entered scoreline", () => {
      const half: StandingsFixture = {
        homeTeamId: "fra",
        awayTeamId: "ita",
        homeScore: 2,
        awayScore: null,
      };
      expect(computeGroupTable(GROUP_A, [half]).every((r) => r.played === 0)).toBe(
        true,
      );
    });

    it("counts a real nil-nil, which a missing score must not be confused with", () => {
      const rows = computeGroupTable(GROUP_A, [played("fra", 0, 0, "ita")]);
      const fra = rows.find((r) => r.teamName === "France")!;
      expect(fra.played).toBe(1);
      expect(fra.draw).toBe(1);
      expect(fra.points).toBe(1);
    });
  });

  describe("arithmetic", () => {
    it("scores a win 3, a draw 1 and a loss 0, with goals both ways", () => {
      const rows = computeGroupTable(GROUP_A, [
        played("fra", 3, 1, "ita"),
        played("bel", 2, 2, "tur"),
      ]);
      const fra = rows.find((r) => r.teamName === "France")!;
      const ita = rows.find((r) => r.teamName === "Italy")!;
      const bel = rows.find((r) => r.teamName === "Belgium")!;

      expect(fra).toMatchObject({ played: 1, won: 1, draw: 0, lost: 0, gf: 3, ga: 1, gd: 2, points: 3 });
      expect(ita).toMatchObject({ played: 1, won: 0, draw: 0, lost: 1, gf: 1, ga: 3, gd: -2, points: 0 });
      expect(bel).toMatchObject({ played: 1, won: 0, draw: 1, lost: 0, gf: 2, ga: 2, gd: 0, points: 1 });
    });

    it("ranks on points before anything else", () => {
      const rows = computeGroupTable(GROUP_A, [
        played("tur", 1, 0, "fra"), // Türkiye 3pts, tiny GD
        played("ita", 5, 0, "bel"), // Italy 3pts, huge GD
      ]);
      expect(names(rows).slice(0, 2)).toEqual(["Italy", "Türkiye"]);
    });
  });

  describe("head-to-head, which a naive sort gets wrong", () => {
    // Both on 3 points. Türkiye has the better overall goal difference, but
    // France beat them in the meeting between the two — UEFA ranks France above.
    it("puts the winner of the meeting above a better overall goal difference", () => {
      const rows = computeGroupTable(GROUP_A, [
        played("fra", 1, 0, "tur"), // France beat Türkiye
        played("tur", 4, 0, "bel"), // Türkiye's big win inflates their GD
        // Italy and Belgium draw, so only France and Türkiye are level on 3 —
        // a genuinely two-way tie. (An earlier version of this test gave
        // Belgium a win, making it a three-way tie, where the mini-table
        // correctly ranks Türkiye first because they played two of the three.)
        played("ita", 1, 1, "bel"),
      ]);
      const fra = rows.findIndex((r) => r.teamName === "France");
      const tur = rows.findIndex((r) => r.teamName === "Türkiye");

      const fraRow = rows.find((r) => r.teamName === "France")!;
      const turRow = rows.find((r) => r.teamName === "Türkiye")!;
      expect(fraRow.points).toBe(turRow.points);
      expect(turRow.gd).toBeGreaterThan(fraRow.gd); // worse GD...
      expect(fra).toBeLessThan(tur); // ...but still ranked higher
    });

    it("uses only the matches between the tied teams, ignoring the rest", () => {
      // France and Italy both on 4. Their meeting was a draw, so head-to-head
      // separates nothing and it falls through to overall goal difference.
      const rows = computeGroupTable(GROUP_A, [
        played("fra", 1, 1, "ita"),
        played("fra", 1, 0, "bel"),
        played("ita", 3, 0, "tur"),
      ]);
      const fra = rows.find((r) => r.teamName === "France")!;
      const ita = rows.find((r) => r.teamName === "Italy")!;
      expect(fra.points).toBe(ita.points);
      expect(names(rows).slice(0, 2)).toEqual(["Italy", "France"]); // Italy +3 vs +1
    });

    // Three level on points, ranked by the mini-table between the three.
    it("resolves a three-way tie on the mini-table between those three", () => {
      const rows = computeGroupTable(GROUP_A, [
        played("fra", 1, 0, "ita"),
        played("ita", 1, 0, "bel"),
        played("bel", 1, 0, "fra"),
        // Each beat one of the others and lost to another: all level on 3,
        // all level in the mini-table too, so overall GF breaks it.
        played("fra", 5, 0, "tur"),
      ]);
      const fra = rows.find((r) => r.teamName === "France")!;
      expect(fra.points).toBe(6);
      expect(names(rows)[0]).toBe("France");
    });

    it("never leaves two teams comparing equal — the order is total", () => {
      // Perfectly symmetrical: every match a goalless draw.
      const rows = computeGroupTable(GROUP_A, [
        played("fra", 0, 0, "ita"),
        played("bel", 0, 0, "tur"),
        played("fra", 0, 0, "bel"),
        played("ita", 0, 0, "tur"),
      ]);
      expect(names(rows)).toEqual(["France", "Italy", "Belgium", "Türkiye"]);
      expect(new Set(rows.map((r) => r.position)).size).toBe(4);
    });
  });

  describe("isolation", () => {
    it("ignores a fixture involving a team from another group", () => {
      const stray: StandingsFixture = {
        homeTeamId: "fra",
        awayTeamId: "esp", // not in this group
        homeScore: 9,
        awayScore: 0,
      };
      const rows = computeGroupTable(GROUP_A, [stray]);
      expect(rows.every((r) => r.played === 0)).toBe(true);
    });

    it("does not depend on the order fixtures were entered", () => {
      const fixtures = [
        played("fra", 2, 1, "ita"),
        played("bel", 0, 3, "tur"),
        played("fra", 1, 1, "bel"),
      ];
      const forward = names(computeGroupTable(GROUP_A, fixtures));
      const reversed = names(computeGroupTable(GROUP_A, [...fixtures].reverse()));
      expect(reversed).toEqual(forward);
    });

    it("does not depend on the order teams were listed", () => {
      const fixtures = [played("fra", 2, 1, "ita"), played("bel", 0, 3, "tur")];
      const a = names(computeGroupTable(GROUP_A, fixtures));
      const b = names(computeGroupTable([...GROUP_A].reverse(), fixtures));
      expect(b).toEqual(a);
    });
  });

  describe("administrative results", () => {
    // UEFA awards 3-0 after a forfeit. It is entered as an ordinary score, so
    // the table needs no special case — the status column records that it was
    // administrative, which matters to an admin, not to the arithmetic.
    it("counts an awarded 3-0 like any other result", () => {
      const rows = computeGroupTable(GROUP_A, [played("fra", 3, 0, "ita")]);
      expect(rows.find((r) => r.teamName === "France")!.points).toBe(3);
      expect(rows.find((r) => r.teamName === "Italy")!.gd).toBe(-3);
    });

    it("leaves a postponed fixture out entirely", () => {
      const rows = computeGroupTable(GROUP_A, [
        played("fra", 1, 0, "ita"),
        unplayed("bel", "tur"),
      ]);
      expect(rows.find((r) => r.teamName === "Belgium")!.played).toBe(0);
      expect(rows.find((r) => r.teamName === "France")!.played).toBe(1);
    });
  });
});
