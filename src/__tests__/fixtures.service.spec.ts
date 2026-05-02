/**
 * Tests for FixturesService — football fixture fetching and transformation.
 */
import { FixturesService } from "../admin/fixtures.service";

function makeConfig(values: Record<string, string> = {}) {
  return {
    get: jest.fn().mockImplementation((key: string) => values[key] ?? undefined),
  };
}

function makeApiMatch(overrides: any = {}) {
  return {
    id: 101,
    competition: { name: "FIFA World Cup" },
    utcDate: "2024-06-01T15:00:00Z",
    homeTeam: { name: "Brazil" },
    awayTeam: { name: "Argentina" },
    venue: "Stadium A",
    status: "TIMED",
    score: { fullTime: { home: null, away: null }, halfTime: { home: null, away: null } },
    ...overrides,
  };
}

function makeService(apiKey?: string) {
  const config = makeConfig(apiKey ? { FOOTBALL_DATA_API_KEY: apiKey } : {});
  return new FixturesService(config as any);
}

beforeEach(() => {
  global.fetch = jest.fn();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── getFixtures ───────────────────────────────────────────────────────────────

describe("FixturesService.getFixtures", () => {
  it("returns empty array when FOOTBALL_DATA_API_KEY is not set", async () => {
    const svc = makeService(); // no API key
    const result = await svc.getFixtures();
    expect(result).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns empty array when football-data.org returns non-200", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 429 });
    const svc = makeService("test-key");

    const result = await svc.getFixtures();

    expect(result).toEqual([]);
  });

  it("returns empty array when fetch throws (network error)", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error("Network failure"));
    const svc = makeService("test-key");

    const result = await svc.getFixtures();

    expect(result).toEqual([]);
  });

  it("transforms a single match into two markets (match-winner + over-under)", async () => {
    const match = makeApiMatch({ id: 200 });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ matches: [match] }),
    });
    const svc = makeService("test-key");

    const result = await svc.getFixtures();

    expect(result).toHaveLength(2);
    const matchWinner = result.find((m) => m.id.startsWith("match-winner-"));
    const overUnder = result.find((m) => m.id.startsWith("over-under-"));
    expect(matchWinner).toBeDefined();
    expect(overUnder).toBeDefined();
  });

  it("match-winner market has correct title and 3 outcomes", async () => {
    const match = makeApiMatch({ id: 201 });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ matches: [match] }),
    });
    const svc = makeService("test-key");

    const result = await svc.getFixtures();
    const mw = result.find((m) => m.id === "match-winner-201")!;

    expect(mw.title).toBe("Brazil vs Argentina - Match Winner");
    expect(mw.outcomes).toEqual(["Brazil", "Draw", "Argentina"]);
    expect(mw.category).toBe("FIFA World Cup");
    expect(mw.source).toBe("football-data.org");
  });

  it("over-under market has correct title and 2 outcomes", async () => {
    const match = makeApiMatch({ id: 202 });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ matches: [match] }),
    });
    const svc = makeService("test-key");

    const result = await svc.getFixtures();
    const ou = result.find((m) => m.id === "over-under-202")!;

    expect(ou.title).toBe("Brazil vs Argentina - Over/Under 2.5 Goals");
    expect(ou.outcomes).toEqual(["Over 2.5", "Under 2.5"]);
  });

  it("markets are sorted by closesAt (date) ascending", async () => {
    const earlierMatch = makeApiMatch({ id: 300, utcDate: "2024-06-01T10:00:00Z" });
    const laterMatch = makeApiMatch({ id: 301, utcDate: "2024-06-02T15:00:00Z" });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ matches: [laterMatch, earlierMatch] }), // reversed order
    });
    const svc = makeService("test-key");

    const result = await svc.getFixtures();

    // First two markets should be from the earlier match (300)
    expect(result[0].matchData.id).toBe(300);
    expect(result[1].matchData.id).toBe(300);
    expect(result[2].matchData.id).toBe(301);
  });

  it("filters markets by query string (case-insensitive)", async () => {
    const match = makeApiMatch({ id: 400 });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ matches: [match] }),
    });
    const svc = makeService("test-key");

    const result = await svc.getFixtures("brazil"); // match by homeTeam

    expect(result.length).toBeGreaterThan(0);
    result.forEach((m) => {
      const lowerTitle = m.title.toLowerCase();
      const lowerHome = m.matchData.homeTeam.toLowerCase();
      const lowerAway = m.matchData.awayTeam.toLowerCase();
      expect(
        lowerTitle.includes("brazil") || lowerHome.includes("brazil") || lowerAway.includes("brazil"),
      ).toBe(true);
    });
  });

  it("filters out non-matching markets when query provided", async () => {
    const matchA = makeApiMatch({ id: 500, homeTeam: { name: "Brazil" }, awayTeam: { name: "Argentina" } });
    const matchB = makeApiMatch({ id: 501, homeTeam: { name: "Germany" }, awayTeam: { name: "France" } });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ matches: [matchA, matchB] }),
    });
    const svc = makeService("test-key");

    const result = await svc.getFixtures("germany");

    expect(result.length).toBe(2); // only the Germany markets
    result.forEach((m) => expect(m.matchData.homeTeam).toBe("Germany"));
  });

  it("returns all markets when no query (undefined)", async () => {
    const matches = [makeApiMatch({ id: 600 }), makeApiMatch({ id: 601 })];
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ matches }),
    });
    const svc = makeService("test-key");

    const result = await svc.getFixtures(undefined);

    expect(result).toHaveLength(4); // 2 matches × 2 markets each
  });
});

// ── status mapping ────────────────────────────────────────────────────────────

describe("FixturesService status mapping", () => {
  const statusCases = [
    ["TIMED", "scheduled"],
    ["SCHEDULED", "scheduled"],
    ["IN_PLAY", "live"],
    ["PAUSED", "live"],
    ["LIVE", "live"],
    ["FINISHED", "completed"],
    ["AWARDED", "completed"],
    ["UNKNOWN", "scheduled"], // fallback
  ] as const;

  for (const [apiStatus, expected] of statusCases) {
    it(`maps API status ${apiStatus} → ${expected}`, async () => {
      const match = makeApiMatch({ id: 700, status: apiStatus });
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ matches: [match] }),
      });
      const svc = makeService("test-key");

      const result = await svc.getFixtures();

      expect(result[0].matchData.status).toBe(expected);
    });
  }
});

// ── score transformation ──────────────────────────────────────────────────────

describe("FixturesService score handling", () => {
  it("includes score when fullTime scores are available", async () => {
    const match = makeApiMatch({
      id: 800,
      status: "FINISHED",
      score: { fullTime: { home: 2, away: 1 }, halfTime: { home: 1, away: 0 } },
    });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ matches: [match] }),
    });
    const svc = makeService("test-key");

    const result = await svc.getFixtures();

    expect(result[0].matchData.score).toEqual({ home: 2, away: 1 });
  });

  it("falls back to halfTime score when fullTime is null", async () => {
    const match = makeApiMatch({
      id: 801,
      status: "PAUSED",
      score: { fullTime: { home: null, away: null }, halfTime: { home: 1, away: 0 } },
    });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ matches: [match] }),
    });
    const svc = makeService("test-key");

    const result = await svc.getFixtures();

    expect(result[0].matchData.score).toEqual({ home: 1, away: 0 });
  });

  it("score is undefined when both fullTime and halfTime are null", async () => {
    const match = makeApiMatch({
      id: 802,
      score: { fullTime: { home: null, away: null }, halfTime: { home: null, away: null } },
    });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ matches: [match] }),
    });
    const svc = makeService("test-key");

    const result = await svc.getFixtures();

    expect(result[0].matchData.score).toBeUndefined();
  });

  it("uses fallback team names when homeTeam/awayTeam are missing", async () => {
    const match = makeApiMatch({ id: 803, homeTeam: undefined, awayTeam: undefined });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ matches: [match] }),
    });
    const svc = makeService("test-key");

    const result = await svc.getFixtures();

    expect(result[0].matchData.homeTeam).toBe("Team A");
    expect(result[0].matchData.awayTeam).toBe("Team B");
  });
});
