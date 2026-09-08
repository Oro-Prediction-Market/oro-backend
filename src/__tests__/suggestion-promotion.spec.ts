import { SuggestionsService } from "../suggestions/suggestions.service";
import { SuggestionStatus } from "../entities/market-suggestion.entity";

/**
 * Auto-promotion removes the discovery bottleneck: the admin no longer has to
 * spot which question the crowd wants. It deliberately does not remove the
 * judgement one — a human still defines outcomes and resolution criteria,
 * because a market nobody can settle is a dispute with real money on it.
 */
describe("SuggestionsService auto-promotion", () => {
  function build(opts: {
    suggestion?: any;
    votesAfter?: number;
    threshold?: string | null;
    claimed?: boolean;
    adminId?: string | null;
  } = {}) {
    const suggestion =
      opts.suggestion === undefined
        ? {
            id: "s1",
            title: "Will the rupee peg hold?",
            description: "Ngultrum / INR parity",
            category: "economy",
            status: SuggestionStatus.APPROVED,
            voteCount: 9,
            promotedAt: null,
            user: { firstName: "Karma" },
          }
        : opts.suggestion;

    const updates: any[] = [];
    const suggestionRepo: any = {
      findOne: jest.fn(async () => ({
        ...suggestion,
        voteCount: opts.votesAfter ?? suggestion?.voteCount ?? 0,
      })),
      find: jest.fn(async () => []),
      createQueryBuilder: () => {
        const state: any = { set: null };
        const qb: any = {
          update: () => qb,
          set: (v: any) => {
            state.set = v;
            return qb;
          },
          where: () => qb,
          andWhere: () => qb,
          execute: async () => {
            updates.push(state.set);
            return { affected: opts.claimed === false ? 0 : 1 };
          },
        };
        return qb;
      },
    };

    const votes: any[] = [];
    const dataSource: any = {
      transaction: async (cb: Function) =>
        cb({
          getRepository: () => ({
            insert: async (v: any) => votes.push(v),
            increment: async () => undefined,
          }),
        }),
    };

    const telegram: any = {
      sendMessageWithButtons: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const gateway: any = { emitVoted: jest.fn(), emitAdded: jest.fn() };
    const config: any = {
      get: jest.fn((k: string) =>
        k === "SUGGESTION_PROMOTE_VOTES"
          ? (opts.threshold ?? undefined)
          : k === "ADMIN_TELEGRAM_ID"
            ? (opts.adminId === undefined ? "12345" : opts.adminId)
            : undefined,
      ),
    };

    const svc = new SuggestionsService(
      suggestionRepo,
      {} as any, // voteRepo
      {} as any, // userRepo
      dataSource,
      config,
      telegram,
      gateway,
    );
    return { svc, updates, telegram, gateway };
  }

  it("defaults the threshold to 10 votes", async () => {
    const { svc } = build();
    expect(svc.promoteThreshold()).toBe(10);
  });

  it("honours a configured threshold", async () => {
    const { svc } = build({ threshold: "25" });
    expect(svc.promoteThreshold()).toBe(25);
  });

  it("ignores a nonsense configured threshold", async () => {
    const { svc } = build({ threshold: "not-a-number" });
    expect(svc.promoteThreshold()).toBe(10);
  });

  it("promotes to QUEUED once the vote threshold is crossed", async () => {
    const { svc, updates, telegram } = build({ votesAfter: 10 });

    await svc.vote("s1", "u1");
    await new Promise((r) => setImmediate(r));

    expect(updates[0].status).toBe(SuggestionStatus.QUEUED);
    expect(updates[0].promotedAt).toBeInstanceOf(Date);
    expect(telegram.sendMessageWithButtons).toHaveBeenCalledTimes(1);
    expect(telegram.sendMessageWithButtons.mock.calls[0][1]).toContain(
      "crowd wants this answered",
    );
  });

  it("does not promote below the threshold", async () => {
    const { svc, updates, telegram } = build({ votesAfter: 9 });

    await svc.vote("s1", "u1");
    await new Promise((r) => setImmediate(r));

    expect(updates).toHaveLength(0);
    expect(telegram.sendMessageWithButtons).not.toHaveBeenCalled();
  });

  it("pings the admin only once, however many votes land at the threshold", async () => {
    // The conditional UPDATE claims nothing the second time around.
    const { svc, telegram } = build({ votesAfter: 12, claimed: false });

    await svc.vote("s1", "u1");
    await new Promise((r) => setImmediate(r));

    expect(telegram.sendMessageWithButtons).not.toHaveBeenCalled();
  });

  it("keeps accepting votes on an already-queued question", async () => {
    const { svc } = build({
      suggestion: {
        id: "s1",
        title: "Q",
        description: null,
        category: "other",
        status: SuggestionStatus.QUEUED,
        voteCount: 15,
        promotedAt: new Date(),
        user: { firstName: "Karma" },
      },
      votesAfter: 16,
    });

    await expect(svc.vote("s1", "u2")).resolves.toMatchObject({
      votedByMe: true,
    });
  });

  it("still refuses votes on a pending or rejected question", async () => {
    for (const status of [
      SuggestionStatus.PENDING,
      SuggestionStatus.REJECTED,
      SuggestionStatus.CREATED,
    ]) {
      const { svc } = build({
        suggestion: {
          id: "s1",
          title: "Q",
          description: null,
          category: "other",
          status,
          voteCount: 1,
          promotedAt: null,
          user: {},
        },
      });
      await expect(svc.vote("s1", "u1")).rejects.toThrow(
        "not open for votes",
      );
    }
  });

  it("a vote still succeeds when the promotion DM fails", async () => {
    const { svc, telegram } = build({ votesAfter: 10 });
    telegram.sendMessageWithButtons.mockRejectedValue(new Error("bot blocked"));

    await expect(svc.vote("s1", "u1")).resolves.toMatchObject({
      votedByMe: true,
    });
    await new Promise((r) => setImmediate(r));
  });
});
