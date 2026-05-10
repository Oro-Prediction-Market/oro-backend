/**
 * Tests for LeaguesService — group management, membership, and leaderboards.
 */
import { LeaguesService } from "../leagues/leagues.service";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeGroupRepo(existing: any = null) {
  return {
    findOne: jest.fn().mockResolvedValue(existing),
    find: jest.fn().mockResolvedValue(existing ? [existing] : []),
    create: jest.fn().mockImplementation((data: any) => data),
    save: jest.fn().mockImplementation((data: any) => Promise.resolve({ id: "g1", ...data })),
    update: jest.fn().mockResolvedValue(undefined),
  };
}

function makeMembershipRepo(existing: any = null, countResult = 0) {
  const qb: any = {
    innerJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
  };
  return {
    findOne: jest.fn().mockResolvedValue(existing),
    count: jest.fn().mockResolvedValue(countResult),
    create: jest.fn().mockImplementation((data: any) => data),
    save: jest.fn().mockImplementation((data: any) => Promise.resolve({ id: "mem1", ...data })),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    _qb: qb,
  };
}

function makeUserRepo(user: any = null) {
  return {
    findOne: jest.fn().mockResolvedValue(user),
  };
}

function makeTelegram() {
  return {
    sendMessage: jest.fn().mockResolvedValue(undefined),
  };
}

function makeService(overrides: {
  groupRepo?: any;
  membershipRepo?: any;
  userRepo?: any;
  telegram?: any;
} = {}) {
  const groupRepo = overrides.groupRepo ?? makeGroupRepo();
  const membershipRepo = overrides.membershipRepo ?? makeMembershipRepo();
  const userRepo = overrides.userRepo ?? makeUserRepo();
  const telegram = overrides.telegram ?? makeTelegram();

  return {
    svc: new LeaguesService(groupRepo as any, membershipRepo as any, userRepo as any, telegram as any, {} as any),
    groupRepo,
    membershipRepo,
    userRepo,
    telegram,
  };
}

// ── isGroupMember ─────────────────────────────────────────────────────────────

describe("LeaguesService.isGroupMember", () => {
  it("returns false when user with telegramId not found", async () => {
    const { svc } = makeService({ userRepo: makeUserRepo(null) });
    const result = await svc.isGroupMember("chat-1", "tg-123");
    expect(result).toBe(false);
  });

  it("returns false when user exists but has made no predictions", async () => {
    const user = { id: "u1", totalPredictions: 0 };
    const { svc } = makeService({ userRepo: makeUserRepo(user) });

    const result = await svc.isGroupMember("chat-1", "tg-123");

    expect(result).toBe(false);
  });

  it("returns true when user has made at least one prediction", async () => {
    const user = { id: "u1", totalPredictions: 3 };
    const { svc } = makeService({ userRepo: makeUserRepo(user) });

    const result = await svc.isGroupMember("chat-1", "tg-123");

    expect(result).toBe(true);
  });
});

// ── upsertGroup ───────────────────────────────────────────────────────────────

describe("LeaguesService.upsertGroup", () => {
  it("creates a new group record when none exists", async () => {
    const groupRepo = makeGroupRepo(null); // no existing group
    const { svc } = makeService({ groupRepo });

    await svc.upsertGroup("chat-1", "My Group");

    expect(groupRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "chat-1", title: "My Group", isActive: true }),
    );
  });

  it("reactivates existing group and updates title when already registered", async () => {
    const existing = { id: "g1", chatId: "chat-1", title: "Old Title", isActive: false };
    const groupRepo = makeGroupRepo(existing);
    const { svc } = makeService({ groupRepo });

    await svc.upsertGroup("chat-1", "New Title");

    expect(groupRepo.update).toHaveBeenCalledWith("g1", {
      isActive: true,
      title: "New Title",
    });
    expect(groupRepo.save).not.toHaveBeenCalled();
  });

  it("keeps existing title when new title is null", async () => {
    const existing = { id: "g1", chatId: "chat-1", title: "Existing Title", isActive: true };
    const groupRepo = makeGroupRepo(existing);
    const { svc } = makeService({ groupRepo });

    await svc.upsertGroup("chat-1", null);

    expect(groupRepo.update).toHaveBeenCalledWith("g1", {
      isActive: true,
      title: "Existing Title", // falls back to existing.title
    });
  });
});

// ── deactivateGroup ───────────────────────────────────────────────────────────

describe("LeaguesService.deactivateGroup", () => {
  it("sets isActive=false for the group", async () => {
    const groupRepo = makeGroupRepo();
    const { svc } = makeService({ groupRepo });

    await svc.deactivateGroup("chat-1");

    expect(groupRepo.update).toHaveBeenCalledWith({ chatId: "chat-1" }, { isActive: false });
  });
});

// ── registerMember ────────────────────────────────────────────────────────────

describe("LeaguesService.registerMember", () => {
  it("does nothing when user with telegramId is not found", async () => {
    const membershipRepo = makeMembershipRepo();
    const { svc } = makeService({ userRepo: makeUserRepo(null), membershipRepo });

    await svc.registerMember("chat-1", "tg-999");

    expect(membershipRepo.save).not.toHaveBeenCalled();
  });

  it("creates the group and membership when group does not exist yet", async () => {
    const user = { id: "u1", telegramId: "tg-1" };
    const groupRepo = makeGroupRepo(null); // group not found initially
    const membershipRepo = makeMembershipRepo(null); // not yet a member
    const { svc } = makeService({ userRepo: makeUserRepo(user), groupRepo, membershipRepo });

    await svc.registerMember("chat-1", "tg-1", "My Group");

    // Group should have been created via upsertGroup
    expect(groupRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "chat-1", isActive: true }),
    );
    // Membership should still be created
    expect(membershipRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "chat-1", userId: "u1" }),
    );
  });

  it("saves membership when user and group both exist and user is not yet a member", async () => {
    const user = { id: "u1", telegramId: "tg-1" };
    const group = { id: "g1", chatId: "chat-1" };
    const groupRepo = makeGroupRepo(group);
    const membershipRepo = makeMembershipRepo(null); // not an existing member
    const { svc } = makeService({ userRepo: makeUserRepo(user), groupRepo, membershipRepo });

    await svc.registerMember("chat-1", "tg-1");

    expect(membershipRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "chat-1", userId: "u1" }),
    );
  });

  it("skips saving when user is already a member", async () => {
    const user = { id: "u1", telegramId: "tg-1" };
    const group = { id: "g1", chatId: "chat-1" };
    const existingMembership = { chatId: "chat-1", userId: "u1" };
    const groupRepo = makeGroupRepo(group);
    const membershipRepo = makeMembershipRepo(existingMembership); // already a member
    const { svc } = makeService({ userRepo: makeUserRepo(user), groupRepo, membershipRepo });

    await svc.registerMember("chat-1", "tg-1");

    expect(membershipRepo.save).not.toHaveBeenCalled();
  });
});

// ── getGroupLeaderboard ───────────────────────────────────────────────────────

describe("LeaguesService.getGroupLeaderboard", () => {
  it("returns empty array when no members with predictions", async () => {
    const membershipRepo = makeMembershipRepo();
    membershipRepo._qb.getRawMany.mockResolvedValue([]);
    const { svc } = makeService({ membershipRepo });

    const result = await svc.getGroupLeaderboard("chat-1");

    expect(result).toEqual([]);
  });

  it("maps raw query results to leaderboard entries with rank", async () => {
    const rawRows = [
      {
        u_id: "u1",
        u_firstName: "Alice",
        u_username: "alice",
        u_reputationScore: "0.85",
        u_reputationTier: "sharpshooter",
        u_totalPredictions: "10",
        u_correctPredictions: "8",
      },
      {
        u_id: "u2",
        u_firstName: "Bob",
        u_username: null,
        u_reputationScore: null,
        u_reputationTier: "rookie",
        u_totalPredictions: "5",
        u_correctPredictions: "2",
      },
    ];
    const membershipRepo = makeMembershipRepo();
    membershipRepo._qb.getRawMany.mockResolvedValue(rawRows);
    const { svc } = makeService({ membershipRepo });

    const result = await svc.getGroupLeaderboard("chat-1");

    expect(result).toHaveLength(2);

    expect(result[0]).toMatchObject({
      rank: 1,
      userId: "u1",
      firstName: "Alice",
      username: "alice",
      reputationScore: 0.85,
      reputationTier: "sharpshooter",
      totalPredictions: 10,
      winRate: 80, // 8/10 = 80%
    });

    expect(result[1]).toMatchObject({
      rank: 2,
      userId: "u2",
      firstName: "Bob",
      username: null,
      reputationScore: null,
      winRate: 40, // 2/5 = 40%
    });
  });

  it("returns 0 winRate when totalPredictions is 0", async () => {
    const rawRows = [{
      u_id: "u1",
      u_firstName: "Charlie",
      u_username: null,
      u_reputationScore: null,
      u_reputationTier: "rookie",
      u_totalPredictions: "0",
      u_correctPredictions: "0",
    }];
    const membershipRepo = makeMembershipRepo();
    membershipRepo._qb.getRawMany.mockResolvedValue(rawRows);
    const { svc } = makeService({ membershipRepo });

    const result = await svc.getGroupLeaderboard("chat-1");

    expect(result[0].winRate).toBe(0);
  });
});

// ── postStandingsToGroup ──────────────────────────────────────────────────────

describe("LeaguesService.postStandingsToGroup", () => {
  it("does nothing when group is not active", async () => {
    const group = { chatId: "chat-1", isActive: false, title: "Test" };
    const groupRepo = makeGroupRepo(group);
    const telegram = makeTelegram();
    const { svc } = makeService({ groupRepo, telegram });

    await svc.postStandingsToGroup("chat-1");

    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("does nothing when group is not found", async () => {
    const groupRepo = makeGroupRepo(null);
    const telegram = makeTelegram();
    const { svc } = makeService({ groupRepo, telegram });

    await svc.postStandingsToGroup("chat-1");

    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("sends empty leaderboard message when no predictions exist", async () => {
    const group = { chatId: "chat-1", isActive: true, title: "Test Group" };
    const groupRepo = makeGroupRepo(group);
    const membershipRepo = makeMembershipRepo();
    membershipRepo._qb.getRawMany.mockResolvedValue([]);
    const telegram = makeTelegram();
    const { svc } = makeService({ groupRepo, membershipRepo, telegram });

    await svc.postStandingsToGroup("chat-1");

    expect(telegram.sendMessage).toHaveBeenCalledWith(
      expect.any(Number),
      expect.stringContaining("No predictions recorded"),
    );
  });

  it("sends standings message with member entries when predictions exist", async () => {
    const group = { chatId: "chat-1", isActive: true, title: "Test Group" };
    const groupRepo = makeGroupRepo(group);
    const membershipRepo = makeMembershipRepo();
    membershipRepo._qb.getRawMany.mockResolvedValue([{
      u_id: "u1",
      u_firstName: "Alice",
      u_username: "alice",
      u_reputationScore: "0.75",
      u_reputationTier: "sharpshooter",
      u_totalPredictions: "20",
      u_correctPredictions: "15",
    }]);
    const telegram = makeTelegram();
    const { svc } = makeService({ groupRepo, membershipRepo, telegram });

    await svc.postStandingsToGroup("chat-1");

    expect(telegram.sendMessage).toHaveBeenCalledWith(
      expect.any(Number),
      expect.stringContaining("Group Standings"),
    );
    const msg: string = telegram.sendMessage.mock.calls[0][1];
    expect(msg).toContain("@alice");
    expect(msg).toContain("Sharpshooter");
  });
});

// ── postWeeklyStandings ───────────────────────────────────────────────────────

describe("LeaguesService.postWeeklyStandings", () => {
  it("posts standings to all active groups", async () => {
    const groups = [
      { id: "g1", chatId: "chat-1", isActive: true, title: "Group 1" },
      { id: "g2", chatId: "chat-2", isActive: true, title: "Group 2" },
    ];
    const groupRepo = makeGroupRepo();
    groupRepo.find.mockResolvedValue(groups);
    groupRepo.findOne
      .mockResolvedValueOnce(groups[0])
      .mockResolvedValueOnce(groups[1]);

    const membershipRepo = makeMembershipRepo();
    membershipRepo._qb.getRawMany.mockResolvedValue([]); // no predictions for simplicity

    const telegram = makeTelegram();
    const { svc } = makeService({ groupRepo, membershipRepo, telegram });

    await svc.postWeeklyStandings();

    expect(telegram.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("continues posting to other groups when one fails", async () => {
    const groups = [
      { id: "g1", chatId: "chat-1", isActive: true, title: "Group 1" },
      { id: "g2", chatId: "chat-2", isActive: true, title: "Group 2" },
    ];
    const groupRepo = makeGroupRepo();
    groupRepo.find.mockResolvedValue(groups);
    groupRepo.findOne
      .mockResolvedValueOnce(groups[0])
      .mockResolvedValueOnce(groups[1]);

    const membershipRepo = makeMembershipRepo();
    membershipRepo._qb.getRawMany.mockResolvedValue([]);

    const telegram = makeTelegram();
    telegram.sendMessage
      .mockRejectedValueOnce(new Error("Telegram error"))
      .mockResolvedValueOnce(undefined);
    const { svc } = makeService({ groupRepo, membershipRepo, telegram });

    await expect(svc.postWeeklyStandings()).resolves.not.toThrow();
    // Second group should still be attempted
    expect(telegram.sendMessage).toHaveBeenCalledTimes(2);
  });
});
