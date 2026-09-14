import { StatOverridesService, playerKeyOf, currentFootballSeason } from "../stat-overrides/stat-overrides.service";

const svc = new StatOverridesService(null as any, null as any);
const entry = (player: string, value: number) => ({
  player, club: "", clubBadge: "", face: "", faceBackup: "", value,
});
const ov = (id: string, player: string, value: number) => ({
  id, league: "epl", board: "assists", season: "2026",
  playerKey: playerKeyOf(player), player, club: "", clubBadge: "", face: "",
  value, updatedByAdminId: null, createdAt: new Date(), updatedAt: new Date(),
}) as any;

describe("stat board overrides", () => {
  it("appends a player the feed does not carry, in rank order", () => {
    const board = [entry("Bukayo Saka", 9), entry("Cole Palmer", 4)];
    const out = svc.applyToBoard(board, [ov("a", "Kevin De Bruyne", 6)], 12);
    expect(out.map((e) => e.player)).toEqual([
      "Bukayo Saka", "Kevin De Bruyne", "Cole Palmer",
    ]);
  });

  it("lets the feed win for a player it already reports", () => {
    const board = [entry("Bukayo Saka", 9)];
    const out = svc.applyToBoard(board, [ov("a", "Bukayo Saka", 99)], 12);
    expect(out).toEqual(board);
  });

  it("matches across accents and case, so no player is doubled", () => {
    const board = [entry("Kylian Mbappé", 7)];
    const out = svc.applyToBoard(board, [ov("a", "kylian mbappe", 99)], 12);
    expect(out).toHaveLength(1);
    expect(out[0].value).toBe(7);
  });

  it("reports which overrides the feed is overruling", () => {
    const board = [entry("Bukayo Saka", 9)];
    const rows = [ov("a", "Bukayo Saka", 99), ov("b", "Kevin De Bruyne", 6)];
    const shadow = svc.shadowedBy(board, rows);
    expect(shadow.get("a")).toBe(9);
    expect(shadow.has("b")).toBe(false);
  });

  it("respects the board cap", () => {
    const board = Array.from({ length: 12 }, (_, i) => entry(`P${i}`, 20 - i));
    const out = svc.applyToBoard(board, [ov("a", "Late Arrival", 100)], 12);
    expect(out).toHaveLength(12);
    expect(out[0].player).toBe("Late Arrival");
  });

  it("ignores a zero-value override rather than putting a 0 on the board", () => {
    const board = [entry("Bukayo Saka", 9)];
    const out = svc.applyToBoard(board, [ov("a", "Nobody", 0)], 12);
    expect(out).toEqual(board);
  });

  it("keys seasons to the campaign's starting year", () => {
    expect(currentFootballSeason(new Date("2026-09-14"))).toBe("2026");
    expect(currentFootballSeason(new Date("2027-05-01"))).toBe("2026");
    expect(currentFootballSeason(new Date("2027-08-01"))).toBe("2027");
  });
});
