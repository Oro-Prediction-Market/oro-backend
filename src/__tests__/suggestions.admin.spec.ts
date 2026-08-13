import { SuggestionsService } from "../suggestions/suggestions.service";
import { SuggestionStatus } from "../entities/market-suggestion.entity";
import { MarketCategory } from "../entities/market.entity";

/**
 * The admin dashboard flow (HTTP), parallel to the Telegram approve/reject.
 * Approve/reject transitions, orbit removal, and publish→CREATED.
 */
describe("SuggestionsService — admin dashboard", () => {
  const makeService = (suggestion?: any) => {
    const gateway = {
      emitVoted: jest.fn(),
      emitAdded: jest.fn(),
      emitRemoved: jest.fn(),
    };
    const suggestionRepo = {
      findOne: jest.fn().mockResolvedValue(suggestion),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn(async (s: any) => s),
    };
    const service = new SuggestionsService(
      suggestionRepo as any,
      { find: jest.fn().mockResolvedValue([]) } as any,
      {} as any,
      {} as any,
      { get: jest.fn().mockReturnValue("999") } as any,
      { sendMessage: jest.fn(), sendMessageWithButtons: jest.fn() } as any,
      gateway as any,
    );
    return { service, gateway, suggestionRepo };
  };

  const pending = () => ({
    id: "s-1",
    status: SuggestionStatus.PENDING,
    title: "Will X happen?",
    description: null,
    category: MarketCategory.OTHER,
    voteCount: 0,
    marketId: null,
    createdAt: new Date(),
    reviewedAt: null,
    user: { firstName: "Grey" },
  });

  it("approves a pending suggestion and broadcasts it into the orbit", async () => {
    const { service, gateway } = makeService(pending());
    const saved = await service.reviewByAdmin("s-1", true);
    expect(saved.status).toBe(SuggestionStatus.APPROVED);
    expect(gateway.emitAdded).toHaveBeenCalledTimes(1);
    expect(gateway.emitRemoved).not.toHaveBeenCalled();
  });

  it("rejecting an approved suggestion removes it from the orbit", async () => {
    const s = { ...pending(), status: SuggestionStatus.APPROVED, voteCount: 9 };
    const { service, gateway } = makeService(s);
    const saved = await service.reviewByAdmin("s-1", false);
    expect(saved.status).toBe(SuggestionStatus.REJECTED);
    expect(gateway.emitRemoved).toHaveBeenCalledWith("s-1");
  });

  it("won't approve an already-approved suggestion", async () => {
    const s = { ...pending(), status: SuggestionStatus.APPROVED };
    const { service } = makeService(s);
    await expect(service.reviewByAdmin("s-1", true)).rejects.toThrow();
  });

  it("publishing links the market, marks CREATED, and drops it from the orbit", async () => {
    const s = { ...pending(), status: SuggestionStatus.APPROVED, voteCount: 12 };
    const { service, gateway } = makeService(s);
    const saved = await service.markPublished("s-1", "market-42");
    expect(saved.status).toBe(SuggestionStatus.CREATED);
    expect(saved.marketId).toBe("market-42");
    expect(gateway.emitRemoved).toHaveBeenCalledWith("s-1");
  });

  it("won't publish a suggestion twice", async () => {
    const s = { ...pending(), status: SuggestionStatus.CREATED };
    const { service } = makeService(s);
    await expect(service.markPublished("s-1", "m-1")).rejects.toThrow();
  });

  it("listForAdmin maps status, votes and proposer", async () => {
    const { service, suggestionRepo } = makeService();
    suggestionRepo.find.mockResolvedValueOnce([
      {
        id: "s-1",
        title: "T",
        description: null,
        category: MarketCategory.OTHER,
        status: SuggestionStatus.APPROVED,
        voteCount: 7,
        marketId: null,
        createdAt: new Date(),
        reviewedAt: null,
        user: { username: "grey" },
      },
    ]);
    const rows = await service.listForAdmin();
    expect(rows[0]).toMatchObject({
      status: SuggestionStatus.APPROVED,
      votes: 7,
      proposer: "@grey",
    });
  });
});
