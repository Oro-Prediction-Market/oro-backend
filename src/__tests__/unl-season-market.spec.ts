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

describe("buildUnlSeasonMarketDto", () => {
  it("lists exactly the nations it is given, each with its flag", () => {
    const dto = buildUnlSeasonMarketDto(
      "2026-27",
      [DRAW[0], DRAW[3]],
      "2027-03-01T12:00:00.000Z",
    );
    expect(dto.outcomes).toEqual([
      { label: "Spain", imageUrl: DRAW[0].flagUrl },
      { label: "Wales", imageUrl: DRAW[3].flagUrl },
    ]);
  });

  it("is a manually settled Nations League season market", () => {
    const dto = buildUnlSeasonMarketDto(
      "2026-27",
      DRAW,
      "2027-03-01T12:00:00.000Z",
    );
    expect(dto).toMatchObject({
      title: "Who wins the 2026/27 UEFA Nations League?",
      category: "sports",
      subcategory: "unl-season",
      externalSource: "unl-manual",
      closesAt: "2027-03-01T12:00:00.000Z",
    });
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
  const FUTURE = new Date(Date.now() + 30 * 864e5).toISOString();
  const req = { user: { userId: "admin-1" }, ip: "127.0.0.1" };

  function build({
    existing = null as any,
    season = "2026-27" as string | null,
    teams = DRAW,
  } = {}) {
    const ctrl = Object.create(AdminController.prototype) as any;
    const findOne = jest.fn().mockResolvedValue(existing);
    ctrl.dataSource = { getRepository: () => ({ findOne }) };
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
  const ids = (...names: string[]) => names.map((n) => `id-${n}`);

  it("previews every nation in the draw with its league", async () => {
    const out = await build().previewUnlSeasonMarket();
    expect(out.teams.map((t: any) => [t.name, t.league])).toEqual([
      ["Spain", "A"],
      ["Portugal", "A"],
      ["France", "A"],
      ["Wales", "B"],
      ["San Marino", "D"],
    ]);
    expect(out.teams[0]).toMatchObject({ id: "id-Spain", groupKey: "A" });
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
        ctrl.createUnlSeasonMarket(
          { closesAt, teamIds: ids("Spain", "France") },
          req,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(ctrl.marketsService.create).not.toHaveBeenCalled();
  });

  it("refuses while a season market is still active", async () => {
    const ctrl = build({ existing: { id: "old" } });
    await expect(
      ctrl.createUnlSeasonMarket(
        { closesAt: FUTURE, teamIds: ids("Spain", "France") },
        req,
      ),
    ).rejects.toThrow(/already exists \(id old\)/);
    expect(ctrl.marketsService.create).not.toHaveBeenCalled();
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
        ctrl.createUnlSeasonMarket({ closesAt: FUTURE, teamIds }, req),
      ).rejects.toThrow(/at least two/);
    }
    expect(ctrl.marketsService.create).not.toHaveBeenCalled();
  });

  it("refuses a nation that is not in the current draw", async () => {
    const ctrl = build();
    await expect(
      ctrl.createUnlSeasonMarket(
        { closesAt: FUTURE, teamIds: [...ids("Spain"), "id-Atlantis"] },
        req,
      ),
    ).rejects.toThrow(/1 of the chosen nations are not in the current draw/);
    const none = build({ season: null, teams: [] });
    await expect(
      none.createUnlSeasonMarket(
        { closesAt: FUTURE, teamIds: ids("Spain", "France") },
        req,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ctrl.marketsService.create).not.toHaveBeenCalled();
  });

  it("creates the market from the picked nations, in draw order, and audits it", async () => {
    const ctrl = build();
    await expect(
      ctrl.createUnlSeasonMarket(
        { closesAt: FUTURE, teamIds: ids("Wales", "Spain", "France") },
        req,
      ),
    ).resolves.toMatchObject({ id: "m1" });
    const dto = ctrl.marketsService.create.mock.calls[0][0];
    expect(dto.outcomes.map((o: any) => o.label)).toEqual([
      "Spain",
      "France",
      "Wales",
    ]);
    expect(dto.closesAt).toBe(FUTURE);
    expect(ctrl.unlService.listTeams).toHaveBeenCalledWith("2026-27");
    expect(ctrl.auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        adminId: "admin-1",
        entityId: "m1",
        after: expect.objectContaining({
          subcategory: "unl-season",
          outcomes: 3,
        }),
      }),
    );
  });
});
