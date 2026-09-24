import { AutoResolveMarketsJob } from "../jobs/auto-resolve-markets.job";
import { MarketStatus } from "../entities/market.entity";

/**
 * AutoResolveMarketsJob must settle via MarketsService.resolve() — NOT the
 * engine directly — so cache invalidation and knockout bracket advancement
 * (maybeAdvanceBracket) run on auto-settlement too. Regression guard for the
 * bug where wc-match markets auto-settled without creating the next round.
 */
describe("AutoResolveMarketsJob", () => {
  const baseMarket = {
    id: "m1",
    title: "Spain vs Argentina",
    status: MarketStatus.RESOLVING,
    proposedOutcomeId: "o1",
    disputeDeadlineAt: new Date("2026-07-16T00:00:00Z"),
    externalSource: null,
  };

  function build(overrides: Partial<typeof baseMarket>[] = [{}], objections = 0) {
    const markets = overrides.map((o) => ({ ...baseMarket, ...o }));
    const marketRepo = { find: jest.fn().mockResolvedValue(markets) };
    const disputeRepo = { count: jest.fn().mockResolvedValue(objections) };
    const auditRepo = {
      create: jest.fn((x) => x),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const marketsService = { resolve: jest.fn().mockResolvedValue(undefined) };
    const job = new AutoResolveMarketsJob(
      marketRepo as any,
      disputeRepo as any,
      auditRepo as any,
      marketsService as any,
      {} as any,
    );
    return { job, marketRepo, disputeRepo, auditRepo, marketsService };
  }

  it("settles an unobjected expired market through MarketsService.resolve", async () => {
    const { job, marketsService, auditRepo } = build();

    await job.autoResolveExpiredWindows();

    expect(marketsService.resolve).toHaveBeenCalledTimes(1);
    expect(marketsService.resolve).toHaveBeenCalledWith(
      "m1",
      "o1",
      "system:auto-resolve",
    );
    expect(auditRepo.save).toHaveBeenCalledTimes(1);
  });

  it("skips markets with objections", async () => {
    const { job, marketsService } = build([{}], 2);

    await job.autoResolveExpiredWindows();

    expect(marketsService.resolve).not.toHaveBeenCalled();
  });

  it("skips ter/btc self-resolving markets", async () => {
    const { job, marketsService } = build([
      { externalSource: "ter" as any },
      { externalSource: "btc" as any },
    ]);

    await job.autoResolveExpiredWindows();

    expect(marketsService.resolve).not.toHaveBeenCalled();
  });

  /**
   * The test that makes "an admin resolves the Nations League" true rather
   * than intended.
   *
   * There is no provider for this competition, so nothing can check a proposal
   * against a result — an admin enters the score, proposes, and resolves. This
   * job and KeeperService.handleDisputeWindowExpiry both settle any RESOLVING
   * market whose window expires unobjected, and EITHER ONE alone is enough to
   * settle it. If someone removes the exclusion here, this fails loudly.
   */
  it("never settles a Nations League market, however quiet the window was", async () => {
    const { job, marketsService } = build([
      { externalSource: "unl-manual" as any },
    ]);

    await job.autoResolveExpiredWindows();

    expect(marketsService.resolve).not.toHaveBeenCalled();
  });

  it("skips markets without a proposed outcome", async () => {
    const { job, marketsService } = build([{ proposedOutcomeId: null as any }]);

    await job.autoResolveExpiredWindows();

    expect(marketsService.resolve).not.toHaveBeenCalled();
  });

  it("continues with remaining markets when one resolve throws", async () => {
    const { job, marketsService } = build([{}, { id: "m2" }]);
    marketsService.resolve
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);

    await job.autoResolveExpiredWindows();

    expect(marketsService.resolve).toHaveBeenCalledTimes(2);
    expect(marketsService.resolve).toHaveBeenLastCalledWith(
      "m2",
      "o1",
      "system:auto-resolve",
    );
  });
});
