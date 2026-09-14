import {
  StatOverridesService,
  playerKeyOf,
  currentFootballSeason,
} from "../stat-overrides/stat-overrides.service";

const svc = new StatOverridesService(null as any, null as any);

const entry = (player: string, value: number, face = "feed.jpg") => ({
  player,
  club: "Feed FC",
  clubBadge: "feed-badge.png",
  face,
  faceBackup: "backup.jpg",
  value,
});

const ov = (
  id: string,
  player: string,
  patch: Partial<{
    value: number | null;
    face: string | null;
    club: string | null;
    isManual: boolean;
  }> = {},
) =>
  ({
    id,
    league: "epl",
    board: "assists",
    season: "2026",
    playerKey: playerKeyOf(player),
    player,
    club: patch.club ?? null,
    clubBadge: null,
    face: patch.face ?? null,
    value: patch.value ?? null,
    isManual: patch.isManual ?? false,
    updatedByAdminId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as any;

describe("stat board: provider first, admin edit wins once made", () => {
  it("leaves the feed untouched when there are no edits", () => {
    const board = [entry("Bukayo Saka", 9)];
    expect(svc.applyToBoard(board, [], 12)).toEqual(board);
  });

  it("pins a value the admin edited, over the provider's", () => {
    const board = [entry("Bukayo Saka", 9)];
    const out = svc.applyToBoard(board, [ov("a", "Bukayo Saka", { value: 12 })], 12);
    expect(out[0].value).toBe(12);
  });

  it("re-ranks when an edit changes the order", () => {
    const board = [entry("Bukayo Saka", 9), entry("Cole Palmer", 4)];
    const out = svc.applyToBoard(board, [ov("a", "Cole Palmer", { value: 20 })], 12);
    expect(out.map((e) => e.player)).toEqual(["Cole Palmer", "Bukayo Saka"]);
  });

  it("edits a photo without freezing the number", () => {
    const board = [entry("Bukayo Saka", 9)];
    const out = svc.applyToBoard(
      board,
      [ov("a", "Bukayo Saka", { face: "correct.jpg" })],
      12,
    );
    expect(out[0].face).toBe("correct.jpg");
    // Still the provider's, because only the photo was touched.
    expect(out[0].value).toBe(9);
  });

  it("does not let the provider's backup photo override the admin's choice", () => {
    const board = [entry("Bukayo Saka", 9)];
    const out = svc.applyToBoard(
      board,
      [ov("a", "Bukayo Saka", { face: "correct.jpg" })],
      12,
    );
    expect(out[0].faceBackup).toBe("");
  });

  it("hands a field back to the provider when the edit is cleared", () => {
    const board = [entry("Bukayo Saka", 9)];
    // value null = no admin opinion.
    const out = svc.applyToBoard(board, [ov("a", "Bukayo Saka", { value: null })], 12);
    expect(out[0].value).toBe(9);
    expect(out[0].face).toBe("feed.jpg");
  });

  it("appends a player the provider does not carry", () => {
    const board = [entry("Bukayo Saka", 9), entry("Cole Palmer", 4)];
    const out = svc.applyToBoard(
      board,
      [ov("a", "Kevin De Bruyne", { value: 6, isManual: true })],
      12,
    );
    expect(out.map((e) => e.player)).toEqual([
      "Bukayo Saka",
      "Kevin De Bruyne",
      "Cole Palmer",
    ]);
  });

  it("ignores a manual row with no value — nothing to rank it by", () => {
    const board = [entry("Bukayo Saka", 9)];
    const out = svc.applyToBoard(
      board,
      [ov("a", "Nobody", { isManual: true })],
      12,
    );
    expect(out).toHaveLength(1);
  });

  it("matches across accents and case, so no player is doubled", () => {
    const board = [entry("Kylian Mbappé", 7)];
    const out = svc.applyToBoard(
      board,
      [ov("a", "kylian mbappe", { value: 11 })],
      12,
    );
    expect(out).toHaveLength(1);
    expect(out[0].value).toBe(11);
  });

  it("respects the board cap after re-ranking", () => {
    const board = Array.from({ length: 12 }, (_, i) => entry(`P${i}`, 20 - i));
    const out = svc.applyToBoard(
      board,
      [ov("a", "Late Arrival", { value: 100, isManual: true })],
      12,
    );
    expect(out).toHaveLength(12);
    expect(out[0].player).toBe("Late Arrival");
  });

  describe("adminView", () => {
    it("shows the provider's number beside the pinned one", () => {
      const board = [entry("Bukayo Saka", 9)];
      const [row] = svc.adminView(board, [ov("a", "Bukayo Saka", { value: 12 })]);
      expect(row.value).toBe(12);
      expect(row.feedValue).toBe(9);
      expect(row.valueEdited).toBe(true);
      expect(row.faceEdited).toBe(false);
    });

    it("marks a player the provider does not carry", () => {
      const [, manual] = svc.adminView(
        [entry("Bukayo Saka", 9)],
        [ov("a", "Kevin De Bruyne", { value: 6, isManual: true })],
      );
      expect(manual.player).toBe("Kevin De Bruyne");
      expect(manual.feedValue).toBeNull();
      expect(manual.isManual).toBe(true);
    });

    it("reports an untouched player as unedited", () => {
      const [row] = svc.adminView([entry("Bukayo Saka", 9)], []);
      expect(row.valueEdited).toBe(false);
      expect(row.overrideId).toBeNull();
      expect(row.feedValue).toBe(9);
    });
  });

  it("keys seasons to the campaign's starting year", () => {
    expect(currentFootballSeason(new Date("2026-09-14"))).toBe("2026");
    expect(currentFootballSeason(new Date("2027-05-01"))).toBe("2026");
    expect(currentFootballSeason(new Date("2027-08-01"))).toBe("2027");
  });
});
