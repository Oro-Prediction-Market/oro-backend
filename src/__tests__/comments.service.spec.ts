import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { CommentsService } from "../comments/comments.service";
import { CommentDeletedBy } from "../entities/market-comment.entity";
import { CommentFlagReason } from "../entities/market-comment-flag.entity";
import { MarketStatus } from "../entities/market.entity";
import { findBlockedTerm, normalise } from "../comments/blocklist";

// ── Harness ──────────────────────────────────────────────────────────────────

function makeService(overrides: any = {}) {
  const repo = {
    create: jest.fn((v) => v),
    save: jest.fn(async (v) => ({
      id: "comment-1",
      createdAt: new Date(),
      deletedAt: null,
      deletedBy: null,
      flagCount: 0,
      ...v,
    })),
    findOne: jest.fn(),
    update: jest.fn(async () => ({})),
    increment: jest.fn(async () => ({})),
    count: jest.fn(async () => 0),
    createQueryBuilder: jest.fn(),
    ...overrides.repo,
  };
  const flagRepo = {
    insert: jest.fn(async () => ({})),
    find: jest.fn(async () => []),
    ...overrides.flagRepo,
  };
  const marketRepo = {
    findOne: jest.fn(async () => ({
      id: "market-1",
      status: MarketStatus.OPEN,
    })),
    ...overrides.marketRepo,
  };
  const userRepo = {
    findOne: jest.fn(async () => ({
      id: "user-1",
      commentsBlockedUntil: null,
      reputationTier: "scout",
    })),
    update: jest.fn(async () => ({})),
    ...overrides.userRepo,
  };
  const notifications = { create: jest.fn(async () => {}) };
  // resolveSides goes through the raw DataSource; default to "no positions".
  const dataSource = { query: jest.fn(async () => []), ...overrides.dataSource };

  const service = new CommentsService(
    repo as any,
    flagRepo as any,
    marketRepo as any,
    userRepo as any,
    notifications as any,
    dataSource as any,
  );
  return { service, repo, flagRepo, marketRepo, userRepo, notifications, dataSource };
}

// ── Blocklist ────────────────────────────────────────────────────────────────

describe("blocklist", () => {
  it("folds case, accents, leetspeak and repeated letters", () => {
    expect(normalise("FUUUCK")).toBe("fuck");
    expect(normalise("sh1t")).toBe("shit");
    expect(normalise("café")).toBe("cafe");
  });

  it("closes up a term padded with punctuation or spaces", () => {
    expect(findBlockedTerm("f.u.c.k this market")).toBe("fuck");
    expect(findBlockedTerm("s h i t odds")).toBe("shit");
  });

  it("catches obvious profanity", () => {
    expect(findBlockedTerm("what a bitch of a result")).toBe("bitch");
    expect(findBlockedTerm("F*CKING robbery")).toBe("fucking");
    expect(findBlockedTerm("sh#t call")).toBe("shit");
    expect(findBlockedTerm("c-nt of a referee")).toBe("cunt");
  });

  // The first letter of a censored term stays literal on purpose: without that
  // anchor, N censor characters would match any N-letter term, so someone
  // politely self-censoring with "****" would be rejected.
  it("does not treat a run of censor characters as a term", () => {
    expect(findBlockedTerm("that was ****")).toBeNull();
    expect(findBlockedTerm("#### result")).toBeNull();
  });

  // The reason matching is whole-word: a prefix match on a shorter term would
  // reject ordinary betting vocabulary, and "Analyst" is one of our own tiers.
  it("does not flag ordinary words that contain a term as a substring", () => {
    for (const clean of [
      "my analysis says City win",
      "the analyst rating is high",
      "Scunthorpe United away",
      "look at the cockpit view",
      "grapes are cheaper this week",
      "Assam tea",
      "classic mismatch",
      "3-1 at half-time, well-taken goal",
      "Nu 5,000 on the draw — 2.4x is generous",
      "back-to-back clean sheets",
    ]) {
      expect(findBlockedTerm(clean)).toBeNull();
    }
  });
});

// ── Posting rules ────────────────────────────────────────────────────────────

describe("CommentsService.create", () => {
  it("rejects a post on a settled market", async () => {
    const { service } = makeService({
      marketRepo: {
        findOne: async () => ({ id: "market-1", status: MarketStatus.SETTLED }),
      },
    });
    await expect(service.create("market-1", "user-1", "nice call")).rejects.toThrow(
      BadRequestException,
    );
  });

  it("rejects a post on a cancelled market", async () => {
    const { service } = makeService({
      marketRepo: {
        findOne: async () => ({
          id: "market-1",
          status: MarketStatus.CANCELLED,
        }),
      },
    });
    await expect(service.create("market-1", "user-1", "hello")).rejects.toThrow(
      BadRequestException,
    );
  });

  it("rejects an unknown market", async () => {
    const { service } = makeService({
      marketRepo: { findOne: async () => null },
    });
    await expect(service.create("nope", "user-1", "hello")).rejects.toThrow(
      NotFoundException,
    );
  });

  it("rejects a muted user until the mute expires", async () => {
    const { service } = makeService({
      userRepo: {
        findOne: async () => ({
          id: "user-1",
          commentsBlockedUntil: new Date(Date.now() + 60_000),
        }),
      },
    });
    await expect(service.create("market-1", "user-1", "hello")).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("allows a user whose mute has expired", async () => {
    const { service } = makeService({
      userRepo: {
        findOne: async () => ({
          id: "user-1",
          commentsBlockedUntil: new Date(Date.now() - 60_000),
          reputationTier: "scout",
        }),
      },
    });
    await expect(
      service.create("market-1", "user-1", "back in business"),
    ).resolves.toMatchObject({ body: "back in business" });
  });

  it("rejects a blocked term", async () => {
    const { service } = makeService();
    await expect(
      service.create("market-1", "user-1", "this is shit"),
    ).rejects.toThrow(BadRequestException);
  });

  // The DTO caps the untrimmed string, so whitespace-only input passes
  // validation and has to be caught here.
  it("rejects a whitespace-only body", async () => {
    const { service } = makeService();
    await expect(service.create("market-1", "user-1", "     ")).rejects.toThrow(
      BadRequestException,
    );
  });

  it("rejects a body that is over the cap once trimmed", async () => {
    const { service } = makeService();
    await expect(
      service.create("market-1", "user-1", `  ${"a".repeat(501)}  `),
    ).rejects.toThrow(BadRequestException);
  });

  it("stores the trimmed body", async () => {
    const { service, repo } = makeService();
    await service.create("market-1", "user-1", "  spurs to win  ");
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ body: "spurs to win" }),
    );
  });
});

// ── Author deletion ──────────────────────────────────────────────────────────

describe("CommentsService.remove", () => {
  it("lets an author remove their own comment", async () => {
    const { service, repo } = makeService({
      repo: {
        findOne: async () => ({
          id: "comment-1",
          userId: "user-1",
          deletedAt: null,
        }),
      },
    });
    await expect(service.remove("comment-1", "user-1")).resolves.toEqual({
      ok: true,
    });
    expect(repo.update).toHaveBeenCalledWith(
      "comment-1",
      expect.objectContaining({ deletedBy: CommentDeletedBy.AUTHOR }),
    );
  });

  it("refuses to remove someone else's comment", async () => {
    const { service } = makeService({
      repo: {
        findOne: async () => ({
          id: "comment-1",
          userId: "someone-else",
          deletedAt: null,
        }),
      },
    });
    await expect(service.remove("comment-1", "user-1")).rejects.toThrow(
      ForbiddenException,
    );
  });
});

// ── Flagging ─────────────────────────────────────────────────────────────────

describe("CommentsService.flag", () => {
  const openComment = {
    findOne: async () => ({
      id: "comment-1",
      userId: "author-1",
      deletedAt: null,
    }),
  };

  it("records a flag and bumps the counter", async () => {
    const { service, repo } = makeService({ repo: openComment });
    await expect(
      service.flag("comment-1", "user-2", CommentFlagReason.SPAM, null),
    ).resolves.toEqual({ ok: true, alreadyFlagged: false });
    expect(repo.increment).toHaveBeenCalledWith(
      { id: "comment-1" },
      "flagCount",
      1,
    );
  });

  // Uniqueness is enforced by the DB, not a read-then-write check. A second
  // flag must read as success, not a 500.
  it("treats a duplicate flag as success and does not double-count", async () => {
    const { service, repo } = makeService({
      repo: openComment,
      flagRepo: {
        insert: async () => {
          const err: any = new Error("duplicate key");
          err.code = "23505";
          throw err;
        },
      },
    });
    await expect(
      service.flag("comment-1", "user-2", CommentFlagReason.ABUSE, null),
    ).resolves.toEqual({ ok: true, alreadyFlagged: true });
    expect(repo.increment).not.toHaveBeenCalled();
  });

  it("refuses a self-flag", async () => {
    const { service } = makeService({ repo: openComment });
    await expect(
      service.flag("comment-1", "author-1", CommentFlagReason.OTHER, null),
    ).rejects.toThrow(BadRequestException);
  });

  it("rethrows a non-uniqueness database error", async () => {
    const { service } = makeService({
      repo: openComment,
      flagRepo: {
        insert: async () => {
          const err: any = new Error("connection lost");
          err.code = "08006";
          throw err;
        },
      },
    });
    await expect(
      service.flag("comment-1", "user-2", CommentFlagReason.SPAM, null),
    ).rejects.toThrow("connection lost");
  });
});

// ── Moderation ───────────────────────────────────────────────────────────────

describe("CommentsService moderation", () => {
  it("notifies the author when a moderator removes their comment", async () => {
    const { service, notifications } = makeService({
      repo: {
        findOne: async () => ({
          id: "comment-1",
          userId: "author-1",
          marketId: "market-1",
          deletedAt: null,
        }),
      },
    });
    await service.adminRemove("comment-1", "Abusive language");
    expect(notifications.create).toHaveBeenCalledWith(
      "author-1",
      expect.objectContaining({ type: "comment_removed" }),
    );
  });

  it("does not re-notify when removing an already-removed comment", async () => {
    const { service, notifications } = makeService({
      repo: {
        findOne: async () => ({
          id: "comment-1",
          userId: "author-1",
          marketId: "market-1",
          deletedAt: new Date(),
        }),
      },
    });
    await service.adminRemove("comment-1", "Abusive language");
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it("mutes a user for the requested window", async () => {
    const { service, userRepo } = makeService();
    const before = Date.now();
    const res = await service.adminMute("user-1", 24, "spamming");
    expect(res.until.getTime()).toBeGreaterThanOrEqual(
      before + 24 * 60 * 60 * 1000,
    );
    expect(userRepo.update).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ commentsBlockedUntil: expect.any(Date) }),
    );
  });

  it("clears the block on unmute", async () => {
    const { service, userRepo } = makeService();
    await service.adminUnmute("user-1");
    expect(userRepo.update).toHaveBeenCalledWith("user-1", {
      commentsBlockedUntil: null,
    });
  });
});

// ── Side resolution ──────────────────────────────────────────────────────────

describe("CommentsService.list query shape", () => {
  /** Records what the service asked the query builder for. */
  function spyHarness() {
    const calls: any = { where: [], order: [], params: [] };
    const qb: any = {
      leftJoinAndSelect: () => qb,
      where: () => qb,
      andWhere: (sql: string, p?: any) => {
        calls.where.push(sql);
        if (p) calls.params.push(p);
        return qb;
      },
      orderBy: (col: string, dir: string) => {
        calls.order.push(`${col} ${dir}`);
        return qb;
      },
      addOrderBy: (col: string, dir: string) => {
        calls.order.push(`${col} ${dir}`);
        return qb;
      },
      take: () => qb,
      getMany: async () => [],
    };
    const { service } = makeService({ repo: { createQueryBuilder: () => qb } });
    return { service, calls };
  }

  it("defaults to newest first", async () => {
    const { service, calls } = spyHarness();
    await service.list("market-1", null, {});
    expect(calls.order).toEqual(["c.createdAt DESC", "c.id DESC"]);
  });

  it("flips both order keys together for oldest", async () => {
    const { service, calls } = spyHarness();
    await service.list("market-1", null, { order: "oldest" });
    expect(calls.order).toEqual(["c.createdAt ASC", "c.id ASC"]);
  });

  // Ordering by createdAt alone is not a total order — two comments can share a
  // millisecond, and the cursor would then skip one or serve it twice.
  it("always adds id as a tiebreaker", async () => {
    const { service, calls } = spyHarness();
    await service.list("market-1", null, {});
    expect(calls.order).toHaveLength(2);
    expect(calls.order[1]).toContain("c.id");
  });

  // The comparison must flip with the order, or paging runs off the wrong end.
  it("compares the cursor as a tuple, in the direction of travel", async () => {
    const cur = "2026-09-08T10:00:00.500Z|abc-123";
    const desc = spyHarness();
    await desc.service.list("market-1", null, { cursor: cur });
    expect(desc.calls.where.some((w: string) => w.includes(`) < (`))).toBe(true);

    const asc = spyHarness();
    await asc.service.list("market-1", null, { cursor: cur, order: "oldest" });
    expect(asc.calls.where.some((w: string) => w.includes(`) > (`))).toBe(true);
  });

  it("splits the cursor into timestamp and id", async () => {
    const { service, calls } = spyHarness();
    await service.list("market-1", null, {
      cursor: "2026-09-08T10:00:00.500Z|abc-123",
    });
    const p = calls.params.find((x: any) => x.cursorId);
    expect(p.cursorId).toBe("abc-123");
    expect(p.cursorTs.toISOString()).toBe("2026-09-08T10:00:00.500Z");
  });

  it("still accepts a bare timestamp cursor with no id", async () => {
    const { service, calls } = spyHarness();
    await service.list("market-1", null, { cursor: "2026-09-08T10:00:00.500Z" });
    expect(calls.where.some((w: string) => w.includes("c.createdAt <"))).toBe(true);
    expect(calls.params.some((p: any) => p.cursorId)).toBe(false);
  });

  it("ignores an unparseable cursor rather than returning nothing", async () => {
    const { service, calls } = spyHarness();
    await service.list("market-1", null, { cursor: "not-a-date|x" });
    expect(calls.where.some((w: string) => w.includes("createdAt"))).toBe(false);
  });

  it("only adds the positions semi-join when holders is asked for", async () => {
    const off = spyHarness();
    await off.service.list("market-1", null, {});
    expect(off.calls.where.some((w: string) => w.includes("positions"))).toBe(false);

    const on = spyHarness();
    await on.service.list("market-1", null, { holdersOnly: true });
    expect(on.calls.where.some((w: string) => w.includes("EXISTS"))).toBe(true);
  });
});

describe("CommentsService side badge", () => {
  function listHarness(sideRows: any[], commentRows: any[]) {
    const qb: any = {
      leftJoinAndSelect: () => qb,
      where: () => qb,
      andWhere: () => qb,
      orderBy: () => qb,
      addOrderBy: () => qb,
      take: () => qb,
      getMany: async () => commentRows,
    };
    return makeService({
      repo: { createQueryBuilder: () => qb },
      dataSource: { query: async () => sideRows },
    });
  }

  const comment = {
    id: "comment-1",
    userId: "user-1",
    body: "City look strong",
    createdAt: new Date(),
    deletedAt: null,
    deletedBy: null,
    user: { username: "abc", reputationTier: "analyst" },
  };

  it("shows the outcome the author holds", async () => {
    const { service } = listHarness(
      [{ userId: "user-1", outcomeId: "o-1", label: "Man City" }],
      [comment],
    );
    const [view] = await service.list("market-1", "user-2", {});
    expect(view.side).toEqual({ outcomeId: "o-1", label: "Man City" });
  });

  it("shows no side for an author with no position", async () => {
    const { service } = listHarness([], [comment]);
    const [view] = await service.list("market-1", "user-2", {});
    expect(view.side).toBeNull();
  });

  // A missing badge is cosmetic — it must never take the thread down with it.
  it("still returns the thread when the side query fails", async () => {
    const qb: any = {
      leftJoinAndSelect: () => qb,
      where: () => qb,
      andWhere: () => qb,
      orderBy: () => qb,
      addOrderBy: () => qb,
      take: () => qb,
      getMany: async () => [comment],
    };
    const { service } = makeService({
      repo: { createQueryBuilder: () => qb },
      dataSource: {
        query: async () => {
          throw new Error("relation does not exist");
        },
      },
    });
    const [view] = await service.list("market-1", null, {});
    expect(view.body).toBe("City look strong");
    expect(view.side).toBeNull();
  });

  it("withholds body and author for a moderator-removed comment", async () => {
    const { service } = listHarness(
      [{ userId: "user-1", outcomeId: "o-1", label: "Man City" }],
      [{ ...comment, deletedAt: new Date(), deletedBy: CommentDeletedBy.ADMIN }],
    );
    const [view] = await service.list("market-1", "user-2", {});
    expect(view.deleted).toBe(true);
    expect(view.body).toBe("");
    expect(view.author).toBeNull();
  });
});
