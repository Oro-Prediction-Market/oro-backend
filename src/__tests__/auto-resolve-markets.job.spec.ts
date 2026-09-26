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
   * The Nations League settles on its objection window like everything else.
   *
   * It was once excluded here, so a proposed market sat in RESOLVING until an
   * admin resolved it by hand. That step re-read the work of the same person
   * who had typed the score and proposed it, rather than checking it, while
   * winners went unpaid until someone next opened the panel.
   *
   * Worth knowing what is and is not guaranteed: a fixture-linked market is
   * re-read from football-data before the money moves, and this competition
   * has no feed to re-read, so the objection window is the only check between
   * a typed score and a payout.
   */
  it("settles a Nations League market once its window expires unobjected", async () => {
    const { job, marketsService } = build([
      { externalSource: "unl-manual" as any },
    ]);

    await job.autoResolveExpiredWindows();

    expect(marketsService.resolve).toHaveBeenCalledWith(
      "m1",
      "o1",
      "system:auto-resolve",
    );
  });

  /**
   * TER and BTC are still excluded, and for a different reason: their own
   * service drives them end to end. Two systems settling one market is how a
   * market gets settled twice.
   */
  it("still never settles a self-resolving price market", async () => {
    for (const externalSource of ["ter", "btc"]) {
      const { job, marketsService } = build([{ externalSource: externalSource as any }]);
      await job.autoResolveExpiredWindows();
      expect(marketsService.resolve).not.toHaveBeenCalled();
    }
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
