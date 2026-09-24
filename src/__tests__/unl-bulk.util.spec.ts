import {
  parseTeamBlock,
  roundRobin,
  matchdayCount,
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

describe("roundRobin", () => {
  const pairKey = (p: { homeIndex: number; awayIndex: number }) =>
    [p.homeIndex, p.awayIndex].sort().join("-");

  describe("four teams, the ordinary group", () => {
    it("plays six matches over three matchdays in a single round", () => {
      const out = roundRobin(4, 1);
      expect(out).toHaveLength(6);
      expect(new Set(out.map((p) => p.matchday))).toEqual(new Set([1, 2, 3]));
    });

    it("has every pair meet exactly once", () => {
      const out = roundRobin(4, 1);
      expect(new Set(out.map(pairKey)).size).toBe(6);
    });

    it("plays twelve over six matchdays home and away", () => {
      const out = roundRobin(4, 2);
      expect(out).toHaveLength(12);
      expect(new Set(out.map((p) => p.matchday))).toEqual(
        new Set([1, 2, 3, 4, 5, 6]),
      );
    });

    it("reverses home and away in the second leg", () => {
      const out = roundRobin(4, 2);
      for (const first of out.filter((p) => p.matchday <= 3)) {
        const reverse = out.find(
          (p) =>
            p.matchday > 3 &&
            p.homeIndex === first.awayIndex &&
            p.awayIndex === first.homeIndex,
        );
        expect(reverse).toBeDefined();
      }
    });

    it("never has a team playing twice on the same matchday", () => {
      const out = roundRobin(4, 2);
      for (const md of [1, 2, 3, 4, 5, 6]) {
        const playing = out
          .filter((p) => p.matchday === md)
          .flatMap((p) => [p.homeIndex, p.awayIndex]);
        expect(new Set(playing).size).toBe(playing.length);
      }
    });

    it("never pairs a team with itself", () => {
      for (const p of roundRobin(4, 2)) {
        expect(p.homeIndex).not.toBe(p.awayIndex);
      }
    });
  });

  describe("three teams, which League D actually has", () => {
    it("plays three matches, one team resting each matchday", () => {
      const out = roundRobin(3, 1);
      expect(out).toHaveLength(3);
      expect(new Set(out.map(pairKey)).size).toBe(3);
      for (const md of [1, 2, 3]) {
        expect(out.filter((p) => p.matchday === md)).toHaveLength(1);
      }
    });

    it("plays six home and away", () => {
      const out = roundRobin(3, 2);
      expect(out).toHaveLength(6);
      expect(new Set(out.map((p) => p.matchday)).size).toBe(6);
    });

    it("gives every team the same number of matches", () => {
      const counts = new Map<number, number>();
      for (const p of roundRobin(3, 2)) {
        counts.set(p.homeIndex, (counts.get(p.homeIndex) ?? 0) + 1);
        counts.set(p.awayIndex, (counts.get(p.awayIndex) ?? 0) + 1);
      }
      expect([...counts.values()]).toEqual([4, 4, 4]);
    });
  });

  it("handles two teams", () => {
    expect(roundRobin(2, 1)).toHaveLength(1);
    expect(roundRobin(2, 2)).toHaveLength(2);
  });

  it("returns nothing for a group too small to play", () => {
    expect(roundRobin(1, 2)).toEqual([]);
    expect(roundRobin(0, 1)).toEqual([]);
  });

  it("spreads home fixtures rather than giving one team all of them", () => {
    const home = new Map<number, number>();
    for (const p of roundRobin(4, 2)) {
      home.set(p.homeIndex, (home.get(p.homeIndex) ?? 0) + 1);
    }
    // Six matches each over the campaign; nobody should be far off three home.
    for (const n of home.values()) {
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(4);
    }
  });
});

describe("matchdayCount", () => {
  it("matches what roundRobin actually produces", () => {
    for (const count of [2, 3, 4, 5, 6]) {
      for (const rounds of [1, 2] as const) {
        const produced = new Set(roundRobin(count, rounds).map((p) => p.matchday));
        expect(matchdayCount(count, rounds)).toBe(produced.size);
      }
    }
  });

  it("is six for the Nations League shape", () => {
    expect(matchdayCount(4, 2)).toBe(6);
    expect(matchdayCount(3, 2)).toBe(6);
  });
});
