import {
  parseTeamBlock,
  parseFixtureBlock,
  flagUrlFor,
} from "../unl/unl-bulk.util";

describe("flagUrlFor", () => {
  it("resolves the nations whose codes nobody can guess", () => {
    expect(flagUrlFor("England")).toContain("/gb-eng.png");
    expect(flagUrlFor("Scotland")).toContain("/gb-sct.png");
    expect(flagUrlFor("Wales")).toContain("/gb-wls.png");
    expect(flagUrlFor("Northern Ireland")).toContain("/gb-nir.png");
    expect(flagUrlFor("Kosovo")).toContain("/xk.png");
  });

  it("keeps Republic of Ireland and Northern Ireland apart", () => {
    // The pair this whole competition's settlement design is built around.
    expect(flagUrlFor("Republic of Ireland")).toContain("/ie.png");
    expect(flagUrlFor("Northern Ireland")).toContain("/gb-nir.png");
  });

  it("ignores accents and accepts the common alternative spellings", () => {
    expect(flagUrlFor("Türkiye")).toContain("/tr.png");
    expect(flagUrlFor("Turkiye")).toContain("/tr.png");
    expect(flagUrlFor("Turkey")).toContain("/tr.png");
    expect(flagUrlFor("Czech Republic")).toContain("/cz.png");
    expect(flagUrlFor("Czechia")).toContain("/cz.png");
  });

  it("returns nothing rather than a guess for a name it does not know", () => {
    // A wrong flag is worse than none: it looks deliberate.
    expect(flagUrlFor("Atlantis")).toBeNull();
    expect(flagUrlFor("")).toBeNull();
  });
});

describe("parseTeamBlock", () => {
  it("reads the format the draw is actually written in", () => {
    const { teams, errors } = parseTeamBlock(
      "A: France, Italy, Belgium, Türkiye",
    );
    expect(errors).toEqual([]);
    expect(teams).toHaveLength(4);
    expect(teams[0]).toMatchObject({ groupKey: "A", name: "France" });
    expect(teams[3].name).toBe("Türkiye");
    expect(teams[3].flagUrl).toContain("/tr.png");
  });

  it("accepts the separators people actually type", () => {
    const { teams, errors } = parseTeamBlock(
      [
        "A: France, Italy",
        "Group B - Spain, Netherlands",
        "c | Portugal | Croatia",
      ].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(teams.map((t) => t.groupKey)).toEqual(["A", "A", "B", "B", "C", "C"]);
    // Lower-case group letters are normalised, not rejected.
    expect(teams[4].groupKey).toBe("C");
  });

  it("skips blank lines", () => {
    const { teams, errors } = parseTeamBlock("\n\nA: France, Italy\n\n");
    expect(errors).toEqual([]);
    expect(teams).toHaveLength(2);
  });

  it("refuses a line with no group rather than guessing one", () => {
    // Attaching these to the previous group would put a team in the wrong
    // table, and the table is what the app shows.
    const { teams, errors } = parseTeamBlock(
      "A: France, Italy\nBelgium, Türkiye",
    );
    expect(teams).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/line 2/i);
  });

  it("flags a nation it does not recognise instead of dropping it", () => {
    const { teams, errors } = parseTeamBlock("A: France, Narnia");
    expect(errors).toEqual([]);
    expect(teams).toHaveLength(2);
    // Still added — the admin may know something we do not — but marked.
    expect(teams[1]).toMatchObject({ name: "Narnia", unknownNation: true });
    expect(teams[0].unknownNation).toBe(false);
  });

  it("catches the same nation listed twice in one group", () => {
    const { teams, errors } = parseTeamBlock("A: France, france, Italy");
    expect(teams).toHaveLength(2);
    expect(errors[0]).toMatch(/twice/i);
  });

  it("allows the same nation in different groups without complaint", () => {
    // Not legal in the real draw, but it is the database's uniqueness rule to
    // enforce, not the parser's — and the parser refusing would be confusing.
    const { errors } = parseTeamBlock("A: France\nB: France");
    expect(errors).toEqual([]);
  });

  it("returns nothing for empty input", () => {
    expect(parseTeamBlock("")).toEqual({ teams: [], errors: [] });
  });
});

describe("parseFixtureBlock", () => {
  // Bhutan time, which is what the admins' browsers report: UTC = local - 6h.
  const BTT = -360;

  it("reads the documented line format", () => {
    const { fixtures, errors } = parseFixtureBlock(
      "A | France | Italy | 2026-09-04 20:45 | 1",
      BTT,
    );
    expect(errors).toEqual([]);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]).toMatchObject({
      groupKey: "A",
      homeName: "France",
      awayName: "Italy",
      matchday: 1,
    });
  });

  it("reads a bare time as the admin's own wall clock", () => {
    // 20:45 typed in Bhutan is 14:45 UTC. Getting this wrong would set a
    // market's betting deadline six hours from the actual kickoff.
    const { fixtures } = parseFixtureBlock(
      "A | France | Italy | 2026-09-04 20:45 | 1",
      BTT,
    );
    expect(fixtures[0].kickoffAt).toBe("2026-09-04T14:45:00.000Z");
  });

  it("lets an explicit zone override the admin's", () => {
    const utc = parseFixtureBlock("A | France | Italy | 2026-09-04 20:45Z", BTT);
    expect(utc.fixtures[0].kickoffAt).toBe("2026-09-04T20:45:00.000Z");

    const plusTwo = parseFixtureBlock(
      "A | France | Italy | 2026-09-04 20:45+02:00",
      BTT,
    );
    expect(plusTwo.fixtures[0].kickoffAt).toBe("2026-09-04T18:45:00.000Z");
  });

  it("accepts 'France vs Italy' in one field", () => {
    const { fixtures, errors } = parseFixtureBlock(
      "A | France vs Italy | 2026-09-04 20:45 | 1",
      BTT,
    );
    expect(errors).toEqual([]);
    expect(fixtures[0]).toMatchObject({ homeName: "France", awayName: "Italy" });
  });

  it("treats the matchday as optional", () => {
    const { fixtures, errors } = parseFixtureBlock(
      "A | France | Italy | 2026-09-04 20:45",
      BTT,
    );
    expect(errors).toEqual([]);
    expect(fixtures[0].matchday).toBeNull();
  });

  it("tolerates 'Group A' and a lower-case letter", () => {
    const { fixtures, errors } = parseFixtureBlock(
      "Group a | France | Italy | 2026-09-04 20:45 | 1",
      BTT,
    );
    expect(errors).toEqual([]);
    expect(fixtures[0].groupKey).toBe("A");
  });

  it("skips blank lines and reports the right line numbers", () => {
    const { fixtures, errors } = parseFixtureBlock(
      ["", "A | France | Italy | 2026-09-04 20:45 | 1", "", "nonsense"].join("\n"),
      BTT,
    );
    expect(fixtures).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/line 4/i);
  });

  describe("refuses rather than guesses", () => {
    it("rejects an ambiguous date format", () => {
      // 04/09/2026 is the 4th of September or the 9th of April depending on
      // who wrote it, and the wrong reading is a market closing months out.
      const { fixtures, errors } = parseFixtureBlock(
        "A | France | Italy | 04/09/2026 20:45 | 1",
        BTT,
      );
      expect(fixtures).toHaveLength(0);
      expect(errors[0]).toMatch(/YYYY-MM-DD/);
    });

    it("rejects a date that does not exist", () => {
      const { errors } = parseFixtureBlock(
        "A | France | Italy | 2026-02-31 20:45 | 1",
        BTT,
      );
      expect(errors[0]).toMatch(/not a real date/i);
    });

    it("rejects an impossible time", () => {
      const { errors } = parseFixtureBlock(
        "A | France | Italy | 2026-09-04 25:00 | 1",
        BTT,
      );
      expect(errors).toHaveLength(1);
    });

    it("rejects a line with too few fields", () => {
      const { errors } = parseFixtureBlock("A | France | Italy", BTT);
      expect(errors[0]).toMatch(/group \| home \| away \| kickoff/i);
    });

    it("rejects a team playing itself", () => {
      const { errors } = parseFixtureBlock(
        "A | France | france | 2026-09-04 20:45 | 1",
        BTT,
      );
      expect(errors[0]).toMatch(/cannot play itself/i);
    });

    it("rejects a group that is not a single letter", () => {
      const { errors } = parseFixtureBlock(
        "A1 | France | Italy | 2026-09-04 20:45 | 1",
        BTT,
      );
      expect(errors[0]).toMatch(/not a group letter/i);
    });

    it("rejects a matchday that is not a number", () => {
      const { errors } = parseFixtureBlock(
        "A | France | Italy | 2026-09-04 20:45 | first",
        BTT,
      );
      expect(errors[0]).toMatch(/not a matchday/i);
    });
  });

  it("keeps the good lines when one is broken", () => {
    const { fixtures, errors } = parseFixtureBlock(
      [
        "A | France | Italy | 2026-09-04 20:45 | 1",
        "A | Belgium | 2026-09-04 20:45 | 1",
        "A | Belgium | Türkiye | 2026-09-07 20:45 | 2",
      ].join("\n"),
      BTT,
    );
    // A whole paste failing because of one typo would be miserable to use.
    expect(fixtures).toHaveLength(2);
    expect(errors).toHaveLength(1);
  });

  it("returns nothing for empty input", () => {
    expect(parseFixtureBlock("", BTT)).toEqual({ fixtures: [], errors: [] });
  });
});
