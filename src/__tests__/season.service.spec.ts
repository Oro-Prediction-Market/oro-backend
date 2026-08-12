/**
 * Tests for SeasonService — season rollover, ISO week calculation, and
 * duplicate-season prevention.
 */
import { SeasonService } from "../users/season.service";
import { SeasonStatus } from "../entities/season.entity";

function makeSeasonRepo(activeSeason: any = null) {
  return {
    findOne: jest.fn().mockResolvedValue(activeSeason),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn((data: any) => data),
    save: jest.fn((data: any) => Promise.resolve({ id: "s1", ...data })),
    update: jest.fn().mockResolvedValue(undefined),
  };
}

function makeUserRepo(users: any[] = []) {
  const qb: any = {
    innerJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    having: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(users),
    // closeActiveSeason ranks by season aggregates; mirror each user's stats
    // into the raw row so winRate computes without an actual DB.
    getRawAndEntities: jest.fn().mockResolvedValue({
      entities: users,
      raw: users.map((u) => ({
        seasonTotal: u.totalPredictions ?? 0,
        seasonWins: u.correctPredictions ?? 0,
      })),
    }),
  };
  return { createQueryBuilder: jest.fn().mockReturnValue(qb) };
}

function makeDataSource() {
  return {
    transaction: jest.fn().mockResolvedValue(undefined),
    getRepository: jest.fn().mockReturnValue({
      createQueryBuilder: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ balance: 0 }),
      }),
      create: jest.fn((d: any) => d),
      save: jest.fn().mockResolvedValue(undefined),
    }),
  };
}

function makeTelegram() {
  return { sendMessage: jest.fn().mockResolvedValue(undefined) };
}

function makeRedis() {
  // Default: this replica wins the rollover lock so the body runs.
  return {
    acquireLock: jest.fn().mockResolvedValue("lock-token"),
    releaseLock: jest.fn().mockResolvedValue(undefined),
  };
}

function makeAuthMethodRepo() {
  return { findOne: jest.fn().mockResolvedValue(null) };
}

function makeBhutanApp() {
  return { sendNotification: jest.fn().mockResolvedValue(true) };
}

function makeUserNotifications() {
  return {
    create: jest.fn().mockResolvedValue(undefined),
    listUnseen: jest.fn().mockResolvedValue([]),
    markSeen: jest.fn().mockResolvedValue(undefined),
  };
}

describe("SeasonService", () => {
  describe("openNewSeason", () => {
    it("creates a new season when none exists for current week", async () => {
      const seasonRepo = makeSeasonRepo();
      // findOne for duplicate check returns null (no existing season)
      seasonRepo.findOne.mockResolvedValue(null);
      const svc = new SeasonService(seasonRepo as any, makeUserRepo() as any, makeAuthMethodRepo() as any, makeDataSource() as any, makeTelegram() as any, makeBhutanApp() as any, makeUserNotifications() as any, makeRedis() as any);

      const result = await svc.openNewSeason();

      expect(seasonRepo.save).toHaveBeenCalled();
      expect(result).toMatchObject({ status: SeasonStatus.ACTIVE });
    });

    it("returns existing season without creating a duplicate", async () => {
      const existing = {
        id: "existing",
        weekNumber: 1,
        year: 2025,
        status: SeasonStatus.ACTIVE,
      };
      const seasonRepo = makeSeasonRepo();
      seasonRepo.findOne.mockResolvedValue(existing);
      const svc = new SeasonService(seasonRepo as any, makeUserRepo() as any, makeAuthMethodRepo() as any, makeDataSource() as any, makeTelegram() as any, makeBhutanApp() as any, makeUserNotifications() as any, makeRedis() as any);

      const result = await svc.openNewSeason();

      expect(seasonRepo.save).not.toHaveBeenCalled();
      expect(result.id).toBe("existing");
    });
  });

  describe("closeActiveSeason", () => {
    it("does nothing when no active season exists", async () => {
      const seasonRepo = makeSeasonRepo(null);
      const svc = new SeasonService(seasonRepo as any, makeUserRepo() as any, makeAuthMethodRepo() as any, makeDataSource() as any, makeTelegram() as any, makeBhutanApp() as any, makeUserNotifications() as any, makeRedis() as any);

      await svc.closeActiveSeason();

      expect(seasonRepo.update).not.toHaveBeenCalled();
    });

    it("closes active season and snapshots top users", async () => {
      const active = { id: "active1", status: SeasonStatus.ACTIVE };
      const seasonRepo = makeSeasonRepo(active);
      const users = [
        {
          id: "u1",
          firstName: "Alice",
          username: null,
          reputationScore: 0.9,
          reputationTier: "legend",
          totalPredictions: 20,
          correctPredictions: 18,
        },
        {
          id: "u2",
          firstName: "Bob",
          username: "bob",
          reputationScore: 0.7,
          reputationTier: "hot_hand",
          totalPredictions: 15,
          correctPredictions: 10,
        },
      ];
      const svc = new SeasonService(
        seasonRepo as any,
        makeUserRepo(users) as any,
        makeAuthMethodRepo() as any,
        makeDataSource() as any,
        makeTelegram() as any,
        makeBhutanApp() as any,
        makeUserNotifications() as any,
        makeRedis() as any,
      );

      await svc.closeActiveSeason();

      expect(seasonRepo.update).toHaveBeenCalledWith(
        "active1",
        expect.objectContaining({ status: SeasonStatus.CLOSED }),
      );
      const [, updatePayload] = seasonRepo.update.mock.calls[0];
      expect(updatePayload.winnersSnapshot).toHaveLength(2);
      expect(updatePayload.winnersSnapshot[0].rank).toBe(1);
      expect(updatePayload.winnersSnapshot[0].userId).toBe("u1");
    });

    it("credits top-3 and excludes sub-floor users when the field is deep enough", async () => {
      const active = { id: "active1", status: SeasonStatus.ACTIVE };
      const seasonRepo = makeSeasonRepo(active);
      // 5 eligible contenders (>= SEASON_MIN_QUALIFIERS) …
      const strong = Array.from({ length: 5 }, (_, i) => ({
        id: `s${i}`,
        firstName: `Strong${i}`,
        username: null,
        reputationScore: 0.8,
        reputationTier: "legend",
        totalPredictions: 20,
        correctPredictions: 16, // 16 wins, 80% — clears both floors
      }));
      // … plus one user below the win-rate floor who must NOT place.
      const weak = {
        id: "weak",
        firstName: "Weak",
        username: null,
        reputationScore: 0.3,
        reputationTier: "rookie",
        totalPredictions: 20,
        correctPredictions: 4, // 20% win rate — below SEASON_MIN_WIN_RATE
      };
      const dataSource = makeDataSource();
      const svc = new SeasonService(
        seasonRepo as any,
        makeUserRepo([...strong, weak]) as any,
        makeAuthMethodRepo() as any,
        dataSource as any,
        makeTelegram() as any,
        makeBhutanApp() as any,
        makeUserNotifications() as any,
        makeRedis() as any,
      );

      await svc.closeActiveSeason();
      // Crediting is fire-and-forget — flush the microtask queue.
      await new Promise((r) => setImmediate(r));

      const [, updatePayload] = seasonRepo.update.mock.calls[0];
      expect(updatePayload.winnersSnapshot).toHaveLength(5); // weak dropped
      expect(
        updatePayload.winnersSnapshot.some((w: any) => w.userId === "weak"),
      ).toBe(false);
      // Deep field → prizes actually credited (one transaction per top-3 winner).
      expect(dataSource.transaction).toHaveBeenCalled();
    });

    it("closes the season WITHOUT paying when too few qualify", async () => {
      const active = { id: "active1", status: SeasonStatus.ACTIVE };
      const seasonRepo = makeSeasonRepo(active);
      // Only 2 eligible — below SEASON_MIN_QUALIFIERS.
      const users = [
        {
          id: "u1",
          firstName: "Alice",
          username: null,
          reputationScore: 0.9,
          reputationTier: "legend",
          totalPredictions: 20,
          correctPredictions: 18,
        },
        {
          id: "u2",
          firstName: "Bob",
          username: "bob",
          reputationScore: 0.7,
          reputationTier: "hot_hand",
          totalPredictions: 15,
          correctPredictions: 10,
        },
      ];
      const dataSource = makeDataSource();
      const svc = new SeasonService(
        seasonRepo as any,
        makeUserRepo(users) as any,
        makeAuthMethodRepo() as any,
        dataSource as any,
        makeTelegram() as any,
        makeBhutanApp() as any,
        makeUserNotifications() as any,
        makeRedis() as any,
      );

      await svc.closeActiveSeason();
      await new Promise((r) => setImmediate(r));

      // Season still closes and snapshots …
      expect(seasonRepo.update).toHaveBeenCalledWith(
        "active1",
        expect.objectContaining({ status: SeasonStatus.CLOSED }),
      );
      // … but no prize is credited in a thin field.
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });

  describe("getCurrentSeason", () => {
    it("returns active season", async () => {
      const active = { id: "s1", status: SeasonStatus.ACTIVE };
      const seasonRepo = makeSeasonRepo(active);
      const svc = new SeasonService(seasonRepo as any, makeUserRepo() as any, makeAuthMethodRepo() as any, makeDataSource() as any, makeTelegram() as any, makeBhutanApp() as any, makeUserNotifications() as any, makeRedis() as any);

      const result = await svc.getCurrentSeason();

      expect(result?.id).toBe("s1");
    });

    it("returns null when no active season", async () => {
      const seasonRepo = makeSeasonRepo(null);
      const svc = new SeasonService(seasonRepo as any, makeUserRepo() as any, makeAuthMethodRepo() as any, makeDataSource() as any, makeTelegram() as any, makeBhutanApp() as any, makeUserNotifications() as any, makeRedis() as any);

      const result = await svc.getCurrentSeason();

      expect(result).toBeNull();
    });
  });

  describe("getSeasonHistory", () => {
    it("returns closed seasons up to limit", async () => {
      const closed = [
        { id: "s0", status: SeasonStatus.CLOSED },
        { id: "s-1", status: SeasonStatus.CLOSED },
      ];
      const seasonRepo = makeSeasonRepo();
      seasonRepo.find.mockResolvedValue(closed);
      const svc = new SeasonService(seasonRepo as any, makeUserRepo() as any, makeAuthMethodRepo() as any, makeDataSource() as any, makeTelegram() as any, makeBhutanApp() as any, makeUserNotifications() as any, makeRedis() as any);

      const result = await svc.getSeasonHistory(5);

      expect(result).toHaveLength(2);
      expect(seasonRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5 }),
      );
    });
  });
});
