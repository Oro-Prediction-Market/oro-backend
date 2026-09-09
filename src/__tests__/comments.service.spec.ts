import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { CommentsService, EDIT_WINDOW_MS } from "../comments/comments.service";
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
    query: jest.fn(async () => []),
    createQueryBuilder: jest.fn(),
    ...overrides.repo,
  };
  const flagRepo = {
    insert: jest.fn(async () => ({})),
    find: jest.fn(async () => []),
    ...overrides.flagRepo,
  };
  const likeRepo = {
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
    insert: jest.fn(async () => ({})),
    delete: jest.fn(async () => ({ affected: 1 })),
    ...overrides.likeRepo,
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
  const notifications = {
    create: jest.fn(async () => {}),
    createOrRefresh: jest.fn(async () => {}),
  };
  // resolveSides goes through the raw DataSource; default to "no positions".
  const dataSource = { query: jest.fn(async () => []), ...overrides.dataSource };

  const service = new CommentsService(
    repo as any,
    flagRepo as any,
    likeRepo as any,
    marketRepo as any,
    userRepo as any,
    notifications as any,
    dataSource as any,
  );
  return {
    service,
    repo,
    flagRepo,
    likeRepo,
    marketRepo,
    userRepo,
    notifications,
    dataSource,
  };
}

// ── Blocklist ────────────────────────────────────────────────────────────────

describe("blocklist", () => {
  it("folds case, accents and leetspeak", () => {
    expect(normalise("sh1t")).toBe("shit");
    expect(normalise("café")).toBe("cafe");
    expect(normalise("SHOUTING")).toBe("shouting");
  });

  // Repeated letters are absorbed by the match patterns rather than by
  // normalise: collapsing the body would turn "ass" into "as", which appears in
  // most English sentences.
  it("catches a stretched or doubled letter", () => {
    expect(normalise("FUUUCK")).toBe("fuuuck");
    expect(findBlockedTerm("FUUUCK")).toBe("fuck");
    expect(findBlockedTerm("ffuuuuck this market")).toBe("fuck");
  });

  it("closes up a term padded with punctuation or spaces", () => {
    expect(findBlockedTerm("f.u.c.k this market")).toBe("fuck");
    expect(findBlockedTerm("s h i t odds")).toBe("shit");
  });

  it("catches obvious profanity", () => {
    expect(findBlockedTerm("what a bitch of a result")).toBe("bitch");
    expect(findBlockedTerm("F*CKING robbery")).toBe("fuck");
    expect(findBlockedTerm("sh#t call")).toBe("shit");
    expect(findBlockedTerm("c-nt of a referee")).toBe("cunt");
  });

  // The old matcher listed every form by hand and so caught the base word only:
  // "fuck" was blocked and "fucked", "bitches" and "retards" all went through.
  it("catches the inflections of a listed term", () => {
    expect(findBlockedTerm("that was fucked")).toBe("fuck");
    expect(findBlockedTerm("bitches be betting")).toBe("bitch");
    expect(findBlockedTerm("shitting myself over this one")).toBe("shit");
    expect(findBlockedTerm("what a bunch of retards")).toBe("retard");
    expect(findBlockedTerm("absolutely retarded call")).toBe("retard");
    expect(findBlockedTerm("dumbass bet")).toBe("dumbass");
  });

  // A digit substitution the leet map cannot undo: "c4nt" folds to "cant",
  // which is a word, so only the censored pass can see it.
  it("catches a substitution that folds to an ordinary word", () => {
    expect(findBlockedTerm("c4nt of a ref")).toBe("cunt");
    expect(findBlockedTerm("f@ck this")).toBe("fuck");
  });

  it("catches harassment phrases", () => {
    expect(findBlockedTerm("kys loser")).toBe("kys");
    expect(findBlockedTerm("go kill yourself")).toBe("kill yourself");
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
      // "arse" is on the list and Arsenal play every week. The suffix set is
      // what keeps these apart, so this is the case to re-run after editing it.
      "Arsenal away to Spurs",
      "van Dijk is back from injury",
      "assess the odds before you bet",
      "assists leader this season",
      "the title race is over",
      "City are cocky after that run",
      "cocktail of injuries",
      "association football",
      "Pakistan vs India",
      "GBP/USD at 1.27",
      "6-0 aggregate, 1-1 on the night",
    ]) {
      expect(findBlockedTerm(clean)).toBeNull();
    }
  });

  // Blocking these would gut ordinary match argument, which is the whole point
  // of the thread. They are the flag queue's job, not the matcher's.
  it("lets mild words through on purpose", () => {
    for (const mild of [
      "damn that was close",
      "what a stupid mistake by the keeper",
      "crap performance from the back four",
      "this ref is an idiot",
      "the git repo is public",
    ]) {
      expect(findBlockedTerm(mild)).toBeNull();
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

// ── Replies ──────────────────────────────────────────────────────────────────

describe("CommentsService replies", () => {
  const parent = {
    id: "parent-1",
    marketId: "market-1",
    parentId: null,
    deletedAt: null,
  };

  it("stores parentId and bumps the parent's counter", async () => {
    const { service, repo } = makeService({
      repo: { findOne: async () => parent },
    });
    await service.create("market-1", "user-1", "agreed", "parent-1");
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: "parent-1" }),
    );
    expect(repo.increment).toHaveBeenCalledWith(
      { id: "parent-1" },
      "replyCount",
      1,
    );
  });

  it("leaves replyCount alone for a top-level comment", async () => {
    const { service, repo } = makeService();
    await service.create("market-1", "user-1", "top level");
    expect(repo.increment).not.toHaveBeenCalled();
  });

  // Depth is capped at one. Arbitrary nesting turns a thread into a tree that
  // has to be paginated and indented at every level.
  it("refuses to reply to a reply", async () => {
    const { service } = makeService({
      repo: { findOne: async () => ({ ...parent, parentId: "grandparent" }) },
    });
    await expect(
      service.create("market-1", "user-1", "nested", "parent-1"),
    ).rejects.toThrow(BadRequestException);
  });

  it("refuses a parent from a different market", async () => {
    const { service } = makeService({
      repo: { findOne: async () => ({ ...parent, marketId: "other-market" }) },
    });
    await expect(
      service.create("market-1", "user-1", "wrong thread", "parent-1"),
    ).rejects.toThrow(BadRequestException);
  });

  it("refuses a removed parent", async () => {
    const { service } = makeService({
      repo: { findOne: async () => ({ ...parent, deletedAt: new Date() }) },
    });
    await expect(
      service.create("market-1", "user-1", "too late", "parent-1"),
    ).rejects.toThrow(BadRequestException);
  });

  it("refuses an unknown parent", async () => {
    const { service } = makeService({ repo: { findOne: async () => null } });
    await expect(
      service.create("market-1", "user-1", "ghost", "missing"),
    ).rejects.toThrow(NotFoundException);
  });

  // The settled lock covers replies too — it is the same write path.
  it("refuses a reply on a settled market", async () => {
    const { service } = makeService({
      marketRepo: {
        findOne: async () => ({ id: "market-1", status: MarketStatus.SETTLED }),
      },
      repo: { findOne: async () => parent },
    });
    await expect(
      service.create("market-1", "user-1", "late take", "parent-1"),
    ).rejects.toThrow(BadRequestException);
  });

  it("releases the parent's slot when a reply is deleted", async () => {
    const { service, repo } = makeService({
      repo: {
        findOne: async () => ({
          id: "reply-1",
          userId: "user-1",
          parentId: "parent-1",
          deletedAt: null,
        }),
        query: jest.fn(async () => []),
      },
    });
    await service.remove("reply-1", "user-1");
    expect(repo.query).toHaveBeenCalledWith(
      expect.stringContaining("GREATEST(0"),
      ["parent-1"],
    );
  });

  it("does not touch any counter when a top-level comment is deleted", async () => {
    const { service, repo } = makeService({
      repo: {
        findOne: async () => ({
          id: "c-1",
          userId: "user-1",
          parentId: null,
          deletedAt: null,
        }),
        query: jest.fn(async () => []),
      },
    });
    await service.remove("c-1", "user-1");
    expect(repo.query).not.toHaveBeenCalled();
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

// ── Editing ──────────────────────────────────────────────────────────────────

describe("CommentsService.edit", () => {
  const fresh = (v: Record<string, unknown> = {}) => ({
    id: "comment-1",
    userId: "user-1",
    marketId: "market-1",
    body: "Original text.",
    parentId: null,
    deletedAt: null,
    editedAt: null,
    replyCount: 0,
    createdAt: new Date(Date.now() - 60_000),
    ...v,
  });

  it("rewrites the body and stamps editedAt", async () => {
    const { service, repo } = makeService({
      repo: { findOne: async () => fresh() },
    });
    const view = await service.edit("comment-1", "user-1", "  New text.  ");
    expect(repo.update).toHaveBeenCalledWith(
      "comment-1",
      expect.objectContaining({ body: "New text." }),
    );
    expect(view.body).toBe("New text.");
    expect(view.edited).toBe(true);
  });

  it("leaves editedAt alone when the text has not changed", async () => {
    const { service, repo } = makeService({
      repo: { findOne: async () => fresh() },
    });
    const view = await service.edit("comment-1", "user-1", "Original text.");
    expect(repo.update).not.toHaveBeenCalled();
    expect(view.edited).toBe(false);
  });

  it("refuses once the edit window has passed", async () => {
    const { service } = makeService({
      repo: {
        findOne: async () =>
          fresh({ createdAt: new Date(Date.now() - EDIT_WINDOW_MS - 1000) }),
      },
    });
    await expect(
      service.edit("comment-1", "user-1", "Too late."),
    ).rejects.toThrow(BadRequestException);
  });

  it("measures the window from createdAt, so an edit cannot extend it", async () => {
    const { service } = makeService({
      repo: {
        findOne: async () =>
          fresh({
            createdAt: new Date(Date.now() - EDIT_WINDOW_MS - 1000),
            // Edited a moment ago — irrelevant, the window is off createdAt.
            editedAt: new Date(),
          }),
      },
    });
    await expect(
      service.edit("comment-1", "user-1", "Sneaky."),
    ).rejects.toThrow(BadRequestException);
  });

  it("refuses to edit someone else's comment", async () => {
    const { service } = makeService({
      repo: { findOne: async () => fresh({ userId: "someone-else" }) },
    });
    await expect(
      service.edit("comment-1", "user-1", "Hijack."),
    ).rejects.toThrow(ForbiddenException);
  });

  it("refuses to edit a removed comment", async () => {
    const { service } = makeService({
      repo: { findOne: async () => fresh({ deletedAt: new Date() }) },
    });
    await expect(
      service.edit("comment-1", "user-1", "Back from the dead."),
    ).rejects.toThrow(BadRequestException);
  });

  it("still applies the blocklist", async () => {
    const { service } = makeService({
      repo: { findOne: async () => fresh() },
    });
    await expect(
      service.edit("comment-1", "user-1", "you are a piece of shit"),
    ).rejects.toThrow(BadRequestException);
  });

  it("still refuses an empty body", async () => {
    const { service } = makeService({
      repo: { findOne: async () => fresh() },
    });
    await expect(service.edit("comment-1", "user-1", "   ")).rejects.toThrow(
      BadRequestException,
    );
  });

  it("refuses on a settled market, like posting", async () => {
    const { service } = makeService({
      repo: { findOne: async () => fresh() },
      marketRepo: {
        findOne: async () => ({ id: "market-1", status: MarketStatus.SETTLED }),
      },
    });
    await expect(
      service.edit("comment-1", "user-1", "After the whistle."),
    ).rejects.toThrow(BadRequestException);
  });

  it("refuses while the author is muted", async () => {
    const { service } = makeService({
      repo: { findOne: async () => fresh() },
      userRepo: {
        findOne: async () => ({
          id: "user-1",
          commentsBlockedUntil: new Date(Date.now() + 3_600_000),
          reputationTier: "scout",
        }),
      },
    });
    await expect(
      service.edit("comment-1", "user-1", "Still talking."),
    ).rejects.toThrow(ForbiddenException);
  });
});

// ── Likes ────────────────────────────────────────────────────────────────────

describe("CommentsService.toggleLike", () => {
  const live = { id: "comment-1", userId: "author-1", deletedAt: null };

  it("likes a comment that the caller has not liked", async () => {
    const { service, repo, likeRepo } = makeService({
      repo: {
        findOne: jest
          .fn()
          .mockResolvedValueOnce(live)
          .mockResolvedValueOnce({ likeCount: 1 }),
      },
      likeRepo: { findOne: async () => null },
    });
    await expect(service.toggleLike("comment-1", "user-1")).resolves.toEqual({
      liked: true,
      likeCount: 1,
    });
    expect(likeRepo.insert).toHaveBeenCalledWith({
      commentId: "comment-1",
      userId: "user-1",
    });
    expect(repo.increment).toHaveBeenCalledWith(
      { id: "comment-1" },
      "likeCount",
      1,
    );
  });

  it("unlikes one the caller had already liked", async () => {
    const { service, likeRepo } = makeService({
      repo: {
        findOne: jest
          .fn()
          .mockResolvedValueOnce(live)
          .mockResolvedValueOnce({ likeCount: 0 }),
      },
      likeRepo: { findOne: async () => ({ id: "like-1" }) },
    });
    await expect(service.toggleLike("comment-1", "user-1")).resolves.toEqual({
      liked: false,
      likeCount: 0,
    });
    expect(likeRepo.delete).toHaveBeenCalledWith({
      commentId: "comment-1",
      userId: "user-1",
    });
    expect(likeRepo.insert).not.toHaveBeenCalled();
  });

  it("swallows a duplicate insert instead of double-counting", async () => {
    const { service, repo } = makeService({
      repo: {
        findOne: jest
          .fn()
          .mockResolvedValueOnce(live)
          .mockResolvedValueOnce({ likeCount: 1 }),
      },
      likeRepo: {
        findOne: async () => null,
        // The other tap won the race between our read and our write.
        insert: jest.fn(async () => {
          throw Object.assign(new Error("dup"), { code: "23505" });
        }),
      },
    });
    await expect(service.toggleLike("comment-1", "user-1")).resolves.toEqual({
      liked: true,
      likeCount: 1,
    });
    expect(repo.increment).not.toHaveBeenCalled();
  });

  it("leaves the count alone when the delete removed nothing", async () => {
    const { service, repo } = makeService({
      repo: {
        findOne: jest
          .fn()
          .mockResolvedValueOnce(live)
          .mockResolvedValueOnce({ likeCount: 3 }),
      },
      likeRepo: {
        findOne: async () => ({ id: "like-1" }),
        delete: jest.fn(async () => ({ affected: 0 })),
      },
    });
    await service.toggleLike("comment-1", "user-1");
    expect(repo.query).not.toHaveBeenCalled();
  });

  it("refuses on a removed comment", async () => {
    const { service } = makeService({
      repo: { findOne: async () => ({ ...live, deletedAt: new Date() }) },
    });
    await expect(service.toggleLike("comment-1", "user-1")).rejects.toThrow(
      BadRequestException,
    );
  });

  it("lets you like your own comment", async () => {
    const { service } = makeService({
      repo: {
        findOne: jest
          .fn()
          .mockResolvedValueOnce({ ...live, userId: "user-1" })
          .mockResolvedValueOnce({ likeCount: 1 }),
      },
      likeRepo: { findOne: async () => null },
    });
    await expect(service.toggleLike("comment-1", "user-1")).resolves.toEqual({
      liked: true,
      likeCount: 1,
    });
  });
});

// ── Notifications ────────────────────────────────────────────────────────────

describe("comment notifications", () => {
  const parentBy = (userId: string) => ({
    id: "parent-1",
    userId,
    marketId: "market-1",
    parentId: null,
    deletedAt: null,
    replyCount: 0,
  });

  it("tells the parent's author about a reply", async () => {
    const { service, notifications } = makeService({
      repo: { findOne: async () => parentBy("author-1") },
    });
    await service.create("market-1", "user-1", "Disagree.", "parent-1");
    expect(notifications.create).toHaveBeenCalledWith(
      "author-1",
      expect.objectContaining({
        type: "comment_reply",
        metadata: expect.objectContaining({
          marketId: "market-1",
          commentId: "parent-1",
        }),
      }),
    );
  });

  it("does not notify you for replying to yourself", async () => {
    const { service, notifications } = makeService({
      repo: { findOne: async () => parentBy("user-1") },
    });
    await service.create("market-1", "user-1", "Adding to this.", "parent-1");
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it("does not notify on a top-level comment", async () => {
    const { service, notifications } = makeService();
    await service.create("market-1", "user-1", "Opening take.", null);
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it("folds like notifications on one comment", async () => {
    const { service, notifications } = makeService({
      repo: {
        findOne: jest
          .fn()
          .mockResolvedValueOnce({
            id: "comment-1",
            userId: "author-1",
            marketId: "market-1",
            deletedAt: null,
          })
          .mockResolvedValueOnce({ likeCount: 4 }),
      },
      likeRepo: { findOne: async () => null },
    });
    await service.toggleLike("comment-1", "user-1");
    expect(notifications.createOrRefresh).toHaveBeenCalledWith(
      "author-1",
      "comment-like:comment-1",
      expect.objectContaining({ type: "comment_like" }),
    );
    // The running total, not "someone liked it" four times over.
    const body = (notifications.createOrRefresh as jest.Mock).mock
      .calls[0][2].body as string;
    expect(body).toMatch(/3 others/);
  });

  it("says nothing when you like your own comment", async () => {
    const { service, notifications } = makeService({
      repo: {
        findOne: jest
          .fn()
          .mockResolvedValueOnce({
            id: "comment-1",
            userId: "user-1",
            marketId: "market-1",
            deletedAt: null,
          })
          .mockResolvedValueOnce({ likeCount: 1 }),
      },
      likeRepo: { findOne: async () => null },
    });
    await service.toggleLike("comment-1", "user-1");
    expect(notifications.createOrRefresh).not.toHaveBeenCalled();
  });

  it("says nothing on an unlike", async () => {
    const { service, notifications } = makeService({
      repo: {
        findOne: jest
          .fn()
          .mockResolvedValueOnce({
            id: "comment-1",
            userId: "author-1",
            marketId: "market-1",
            deletedAt: null,
          })
          .mockResolvedValueOnce({ likeCount: 0 }),
      },
      likeRepo: { findOne: async () => ({ id: "like-1" }) },
    });
    await service.toggleLike("comment-1", "user-1");
    expect(notifications.createOrRefresh).not.toHaveBeenCalled();
  });

  it("does not let a failed notification fail the reply", async () => {
    const { service } = makeService({
      repo: { findOne: async () => parentBy("author-1") },
    });
    const svc = service as any;
    svc.notifications.create = jest.fn(async () => {
      throw new Error("notification store down");
    });
    await expect(
      service.create("market-1", "user-1", "Still saved.", "parent-1"),
    ).resolves.toBeDefined();
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

  it("returns top-level comments only", async () => {
    const { service, calls } = spyHarness();
    await service.list("market-1", null, {});
    expect(calls.where.some((w: string) => w.includes("parentId IS NULL"))).toBe(
      true,
    );
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
