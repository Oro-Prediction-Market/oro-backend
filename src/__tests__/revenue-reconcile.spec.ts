import { RevenueDistributionService } from "../markets/revenue-distribution.service";

/**
 * F-17 safety net: reconcileMissingDistributions must book a PENDING revenue
 * record for every settled market that has none, so "settled" can never leave
 * house revenue silently unbooked.
 */
describe("RevenueDistributionService.reconcileMissingDistributions", () => {
  function build(settlements: any[], markets: any[]) {
    const qb: any = {
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(settlements),
    };
    const settlementRepo = { createQueryBuilder: jest.fn(() => qb) };
    const marketRepo = { find: jest.fn().mockResolvedValue(markets) };

    const svc = new RevenueDistributionService(
      {} as any, // distributionRepo
      settlementRepo as any,
      marketRepo as any,
      {} as any, // config
      {} as any, // dkGateway
      {} as any, // redis
    );
    const record = jest.fn().mockResolvedValue({ id: "d" });
    (svc as any).recordDistribution = record;
    return { svc, record, marketRepo };
  }

  it("books a distribution for every settled-but-unbooked market", async () => {
    const { svc, record } = build(
      [
        // One settlement per book. m2's is the USDT book, which is the case
        // that used to book its house cut as ngultrum revenue.
        { id: "s1", marketId: "m1", houseAmount: "24.00", totalPool: "300.00", currency: "BTN" },
        { id: "s2", marketId: "m2", houseAmount: "10.00", totalPool: "200.00", currency: "USDT" },
      ],
      [
        // Edges match what the settlements actually took (24/300, 10/200).
        // They used to read 5 and 8 against those same amounts, which no real
        // settlement could produce.
        { id: "m1", houseEdgePct: "8" },
        { id: "m2", houseEdgePct: "5" },
      ],
    );

    const res = await svc.reconcileMissingDistributions();

    expect(res).toEqual({ created: 2, scanned: 2 });
    expect(record).toHaveBeenCalledTimes(2);
    // (marketId, settlementId, houseAmount, houseEdgePct, totalPool, currency,
    //  houseForfeit)
    //
    // The edge is derived from the settlement, not read off the market. This
    // path used to take the market's configured edge while the engine's own
    // path computed it from the settlement, so the same settlement got a
    // different figure depending on which one booked it. The settlement is the
    // record of what was actually taken; a market's edge can be edited after
    // it settles.
    expect(record).toHaveBeenCalledWith("m1", "s1", 24, 8, 300, "BTN", 0);
    expect(record).toHaveBeenCalledWith("m2", "s2", 10, 5, 200, "USDT", 0);
  });

  it("does nothing when every settlement is already booked", async () => {
    const { svc, record, marketRepo } = build([], []);
    const res = await svc.reconcileMissingDistributions();
    expect(res).toEqual({ created: 0, scanned: 0 });
    expect(record).not.toHaveBeenCalled();
    expect(marketRepo.find).not.toHaveBeenCalled();
  });

  it("keeps going if one market's record fails, and counts only the successes", async () => {
    const { svc, record } = build(
      [
        { id: "s1", marketId: "m1", houseAmount: "24.00", totalPool: "300.00" },
        { id: "s2", marketId: "m2", houseAmount: "10.00", totalPool: "200.00" },
      ],
      [
        { id: "m1", houseEdgePct: "5" },
        { id: "m2", houseEdgePct: "8" },
      ],
    );
    record
      .mockRejectedValueOnce(new Error("transient db error"))
      .mockResolvedValueOnce({ id: "d2" });

    const res = await svc.reconcileMissingDistributions();
    expect(res).toEqual({ created: 1, scanned: 2 });
    expect(record).toHaveBeenCalledTimes(2);
  });
});
