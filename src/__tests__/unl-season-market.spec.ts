import { BadRequestException } from "@nestjs/common";
import { AdminController } from "../admin/admin.controller";
import {
  buildUnlSeasonMarketDto,
  leagueATeams,
  seasonLabel,
} from "../unl/unl-season-market";

const team = (
  groupKey: string,
  name: string,
  flagUrl: string | null = null,
) => ({
  groupKey,
  name,
  flagUrl:
    flagUrl ?? `https://flagcdn.com/w320/${name.slice(0, 2).toLowerCase()}.png`,
});

// listTeams order: group, then draw position.
const DRAW = [
  team("A", "Spain"),
  team("A", "Portugal"),
  team("B", "France"),
  team("D", "Germany"),
  team("E", "Wales"),
  team("N", "San Marino"),
];

describe("buildUnlSeasonMarketDto", () => {
  it("lists League A only, in draw order, each with its flag", () => {
    const dto = buildUnlSeasonMarketDto(
      "2026-27",
      DRAW,
      "2027-03-01T12:00:00.000Z",
    );
    expect(dto.outcomes).toEqual([
      { label: "Spain", imageUrl: DRAW[0].flagUrl },
      { label: "Portugal", imageUrl: DRAW[1].flagUrl },
      { label: "France", imageUrl: DRAW[2].flagUrl },
      { label: "Germany", imageUrl: DRAW[3].flagUrl },
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

  it("matches group letters in either case", () => {
    expect(leagueATeams([team("c", "Italy"), team("e", "Wales")])).toHaveLength(
      1,
    );
  });
});

describe("AdminController.createUnlSeasonMarket", () => {
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

  it("refuses a missing or past closing date", async () => {
    const ctrl = build();
    for (const closesAt of [
      undefined,
      "",
      "nonsense",
      "2020-01-01T00:00:00Z",
    ]) {
      await expect(
        ctrl.createUnlSeasonMarket({ closesAt }, req),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(ctrl.marketsService.create).not.toHaveBeenCalled();
  });

  it("refuses while a season market is still active", async () => {
    const ctrl = build({ existing: { id: "old" } });
    await expect(
      ctrl.createUnlSeasonMarket({ closesAt: FUTURE }, req),
    ).rejects.toThrow(/already exists \(id old\)/);
    expect(ctrl.marketsService.create).not.toHaveBeenCalled();
  });

  it("asks for the draw when League A is empty", async () => {
    const ctrl = build({ teams: [team("E", "Wales")] });
    await expect(
      ctrl.createUnlSeasonMarket({ closesAt: FUTURE }, req),
    ).rejects.toThrow(/Paste the draw/);
    const none = build({ season: null });
    await expect(
      none.createUnlSeasonMarket({ closesAt: FUTURE }, req),
    ).rejects.toThrow(/Paste the draw/);
    expect(ctrl.marketsService.create).not.toHaveBeenCalled();
  });

  it("creates the market from League A and records who did it", async () => {
    const ctrl = build();
    await expect(
      ctrl.createUnlSeasonMarket({ closesAt: FUTURE }, req),
    ).resolves.toMatchObject({ id: "m1" });
    const dto = ctrl.marketsService.create.mock.calls[0][0];
    expect(dto.outcomes).toHaveLength(4);
    expect(dto.closesAt).toBe(FUTURE);
    expect(ctrl.unlService.listTeams).toHaveBeenCalledWith("2026-27");
    expect(ctrl.auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        adminId: "admin-1",
        entityId: "m1",
        after: expect.objectContaining({
          subcategory: "unl-season",
          outcomes: 4,
        }),
      }),
    );
  });
});
