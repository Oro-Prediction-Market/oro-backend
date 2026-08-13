import { SuggestionsService } from "../suggestions/suggestions.service";
import { SuggestionStatus } from "../entities/market-suggestion.entity";
import { MarketCategory } from "../entities/market.entity";

const PG_UNIQUE_VIOLATION = "23505";

/**
 * The orbit is a shared, live view: a vote by one user must reach every other
 * open orbit. These cover what is broadcast and — just as important — what is
 * not, since a duplicate vote changes no count and must not wake other clients.
 */
describe("SuggestionsService — live broadcasts", () => {
  const makeService = (opts: {
    suggestion?: any;
    voteInsertFails?: boolean;
    freshVoteCount?: number;
  }) => {
    const gateway = { emitVoted: jest.fn(), emitAdded: jest.fn() };

    const suggestionRepo = {
      findOne: jest
        .fn()
        // first call: the suggestion being voted on / reviewed
        .mockResolvedValueOnce(opts.suggestion)
        // second call: the fresh count read after the increment
        .mockResolvedValue({ voteCount: opts.freshVoteCount ?? 0 }),
      save: jest.fn(async (s: any) => s),
    };

    const dataSource = {
      transaction: jest.fn(async (cb: any) => {
        if (opts.voteInsertFails) {
          const err: any = new Error("duplicate key");
          err.code = PG_UNIQUE_VIOLATION;
          throw err;
        }
        return cb({
          getRepository: () => ({
            insert: jest.fn(),
            increment: jest.fn(),
          }),
        });
      }),
    };

    const service = new SuggestionsService(
      suggestionRepo as any,
      { find: jest.fn().mockResolvedValue([]) } as any,
      {} as any,
      dataSource as any,
      { get: jest.fn().mockReturnValue("999") } as any,
      { sendMessage: jest.fn(), sendMessageWithButtons: jest.fn() } as any,
      gateway as any,
    );

    return { service, gateway, suggestionRepo };
  };

  const approvedSuggestion = {
    id: "s-1",
    status: SuggestionStatus.APPROVED,
    voteCount: 4,
  };

  it("broadcasts the new count when a vote is actually recorded", async () => {
    const { service, gateway } = makeService({
      suggestion: approvedSuggestion,
      freshVoteCount: 5,
    });

    const res = await service.vote("s-1", "user-1");

    expect(res).toEqual({ votes: 5, votedByMe: true });
    expect(gateway.emitVoted).toHaveBeenCalledTimes(1);
    expect(gateway.emitVoted).toHaveBeenCalledWith({ id: "s-1", votes: 5 });
  });

  it("stays silent on a duplicate vote — the count did not move", async () => {
    const { service, gateway } = makeService({
      suggestion: approvedSuggestion,
      voteInsertFails: true,
      freshVoteCount: 4,
    });

    const res = await service.vote("s-1", "user-1");

    expect(res).toEqual({ votes: 4, votedByMe: true });
    expect(gateway.emitVoted).not.toHaveBeenCalled();
  });

  it("broadcasts an approved suggestion so it joins open orbits", async () => {
    const createdAt = new Date("2026-08-12T15:44:10.715Z");
    const { service, gateway } = makeService({
      suggestion: {
        id: "s-2",
        status: SuggestionStatus.PENDING,
        title: "Who will be our next Home Minister?",
        description: null,
        category: MarketCategory.OTHER,
        voteCount: 1,
        marketId: null,
        createdAt,
        user: { username: "td" },
      },
    });

    await service.review("s-2", true, "999");

    expect(gateway.emitAdded).toHaveBeenCalledWith({
      id: "s-2",
      title: "Who will be our next Home Minister?",
      description: null,
      category: MarketCategory.OTHER,
      votes: 1,
      creator: "@td",
      createdAt: createdAt.toISOString(),
      marketId: null,
    });
  });

  it("broadcasts nothing when a suggestion is rejected", async () => {
    const { service, gateway } = makeService({
      suggestion: {
        id: "s-3",
        status: SuggestionStatus.PENDING,
        title: "A question nobody wanted",
        description: null,
        category: MarketCategory.OTHER,
        voteCount: 1,
        marketId: null,
        createdAt: new Date(),
        user: null,
      },
    });

    await service.review("s-3", false, "999");

    expect(gateway.emitAdded).not.toHaveBeenCalled();
  });
});
