import { BadRequestException } from "@nestjs/common";
import { AdminController } from "../admin/admin.controller";
import {
  buildUnlSeasonMarketDto,
  leagueOf,
  seasonLabel,
} from "../unl/unl-season-market";

const team = (groupKey: string, name: string) => ({
  id: `id-${name}`,
  groupKey,
  name,
  flagUrl: `https://flagcdn.com/w320/${name.slice(0, 2).toLowerCase()}.png`,
});

// listTeams order: group, then draw position.
const DRAW = [
  team("A", "Spain"),
  team("A", "Portugal"),
  team("B", "France"),
  team("E", "Wales"),
  team("N", "San Marino"),
];

const INPUT = {
  title: "Who tops Group A?",
  opensAt: "2026-10-20T08:00:00.000Z",
  closesAt: "2027-03-01T12:00:00.000Z",
};

describe("buildUnlSeasonMarketDto", () => {
  it("lists exactly the nations it is given, each with its flag", () => {
    const dto = buildUnlSeasonMarketDto("2026-27", [DRAW[0], DRAW[3]], INPUT);
    expect(dto.outcomes).toEqual([
      { label: "Spain", imageUrl: DRAW[0].flagUrl },
      { label: "Wales", imageUrl: DRAW[3].flagUrl },
    ]);
  });

  it("uses the admin's name and dates on a manually settled market", () => {
    const dto = buildUnlSeasonMarketDto("2026-27", DRAW, INPUT);
    expect(dto).toMatchObject({
      title: "Who tops Group A?",
      category: "sports",
      subcategory: "unl-season",
      externalSource: "unl-manual",
      opensAt: INPUT.opensAt,
      closesAt: INPUT.closesAt,
    });
    expect(dto.resolutionCriteria).toContain('"Who tops Group A?"');
    expect(dto.resolutionCriteria).toContain("2026/27");
  });

  it("keeps a season label it does not recognise as it is", () => {
    expect(seasonLabel("2026-27")).toBe("2026/27");
    expect(seasonLabel("2027")).toBe("2027");
  });

  it("maps each group to its league, in either case", () => {
    expect(["a", "D", "E", "l", "N", "Z"].map(leagueOf)).toEqual([
      "A",
      "A",
      "B",
      "C",
      "D",
      null,
    ]);
  });
});

describe("AdminController season market", () => {
  const DAY = 864e5;
  const FUTURE = new Date(Date.now() + 30 * DAY).toISOString();
  const req = { user: { userId: "admin-1" }, ip: "127.0.0.1" };
  const ids = (...names: string[]) => names.map((n) => `id-${n}`);
  const body = (over: Record<string, unknown> = {}) => ({
    title: "Who wins the 2026/27 UEFA Nations League?",
    closesAt: FUTURE,
    teamIds: ids("Spain", "France"),
    ...over,
  });

  function build({
    existing = [] as any[],
    season = "2026-27" as string | null,
    teams = DRAW,
  } = {}) {
    const ctrl = Object.create(AdminController.prototype) as any;
    const find = jest.fn().mockResolvedValue(existing);
    ctrl.dataSource = { getRepository: () => ({ find }) };
    ctrl.unlService = {
      currentSeason: jest.fn().mockResolvedValue(season),
      listTeams: jest.fn().mockResolvedValue(teams),
    };
    ctrl.marketsService = {
      create: jest.fn().mockImplementation(async (dto: any) => ({
        id: "m1",
        title: dto.title,
      })),
    };
    ctrl.auditService = { log: jest.fn().mockResolvedValue(undefined) };
    return ctrl;
  }

  it("previews every nation in the draw with its league, and the running markets", async () => {
    const running = [{ id: "s1", title: "Who wins it?", status: "open" }];
    const out = await build({ existing: running }).previewUnlSeasonMarket();
    expect(out.teams.map((t: any) => [t.name, t.league])).toEqual([
      ["Spain", "A"],
      ["Portugal", "A"],
      ["France", "A"],
      ["Wales", "B"],
      ["San Marino", "D"],
    ]);
    expect(out.teams[0]).toMatchObject({ id: "id-Spain", groupKey: "A" });
    expect(out.existing).toEqual(running);
  });

  it("needs a name", async () => {
    const ctrl = build();
    for (const title of [undefined, "", "  ", "ab", 42, "x".repeat(201)]) {
      await expect(
        ctrl.createUnlSeasonMarket(body({ title }), req),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(ctrl.marketsService.create).not.toHaveBeenCalled();
  });

  it("refuses a missing or past closing date", async () => {
    const ctrl = build();
    for (const closesAt of [
      undefined,
      "",
      "nonsense",
      "2020-01-01T00:00:00Z",
    ]) {
      await expect(
        ctrl.createUnlSeasonMarket(body({ closesAt }), req),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(ctrl.marketsService.create).not.toHaveBeenCalled();
  });

  it("refuses an opening date that is invalid or not before the close", async () => {
    const ctrl = build();
    for (const opensAt of [
      "nonsense",
      FUTURE,
      new Date(Date.now() + 31 * DAY).toISOString(),
    ]) {
      await expect(
        ctrl.createUnlSeasonMarket(body({ opensAt }), req),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(ctrl.marketsService.create).not.toHaveBeenCalled();
  });

  it("allows several markets but not two running with the same name", async () => {
    const running = [{ id: "old", title: "Who tops Group A?", status: "open" }];
    const ctrl = build({ existing: running });
    await expect(
      ctrl.createUnlSeasonMarket(
        body({ title: "  who tops   group a? " }),
        req,
      ),
    ).rejects.toThrow(/already running \(id old\)/);
    await expect(
      ctrl.createUnlSeasonMarket(body({ title: "Who tops Group B?" }), req),
    ).resolves.toMatchObject({ id: "m1" });
  });

  it("needs at least two distinct nations", async () => {
    const ctrl = build();
    for (const teamIds of [
      undefined,
      "id-Spain",
      [],
      ids("Spain"),
      ids("Spain", "Spain"),
    ]) {
      await expect(
        ctrl.createUnlSeasonMarket(body({ teamIds }), req),
      ).rejects.toThrow(/at least two/);
    }
    expect(ctrl.marketsService.create).not.toHaveBeenCalled();
  });

  it("refuses a nation that is not in the current draw", async () => {
    const ctrl = build();
    await expect(
      ctrl.createUnlSeasonMarket(
        body({ teamIds: [...ids("Spain"), "id-Atlantis"] }),
        req,
      ),
    ).rejects.toThrow(/1 of the chosen nations are not in the current draw/);
    const none = build({ season: null, teams: [] });
    await expect(
      none.createUnlSeasonMarket(body(), req),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ctrl.marketsService.create).not.toHaveBeenCalled();
  });

  it("creates it with the typed name, dates and picked nations, and audits it", async () => {
    const ctrl = build();
    const opensAt = new Date(Date.now() + 2 * DAY).toISOString();
    await expect(
      ctrl.createUnlSeasonMarket(
        body({
          title: "  Who is relegated   from League A? ",
          opensAt,
          teamIds: ids("Wales", "Spain", "France"),
        }),
        req,
      ),
    ).resolves.toMatchObject({ id: "m1" });
    const dto = ctrl.marketsService.create.mock.calls[0][0];
    expect(dto.title).toBe("Who is relegated from League A?");
    expect(dto.opensAt).toBe(opensAt);
    expect(dto.closesAt).toBe(FUTURE);
    expect(dto.outcomes.map((o: any) => o.label)).toEqual([
      "Spain",
      "France",
      "Wales",
    ]);
    expect(ctrl.unlService.listTeams).toHaveBeenCalledWith("2026-27");
    expect(ctrl.auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        adminId: "admin-1",
        entityId: "m1",
        after: expect.objectContaining({
          title: "Who is relegated from League A?",
          subcategory: "unl-season",
          outcomes: 3,
          opensAt,
        }),
      }),
    );
  });

  it("opens now when no opening date is given", async () => {
    const ctrl = build();
    const before = Date.now();
    await ctrl.createUnlSeasonMarket(body(), req);
    const opens = Date.parse(
      ctrl.marketsService.create.mock.calls[0][0].opensAt,
    );
    expect(opens).toBeGreaterThanOrEqual(before - 1000);
    expect(opens).toBeLessThanOrEqual(Date.now());
  });
});
