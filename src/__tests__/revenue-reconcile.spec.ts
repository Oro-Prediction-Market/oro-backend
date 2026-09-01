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
        { id: "m1", houseEdgePct: "5" },
        { id: "m2", houseEdgePct: "8" },
      ],
    );

    const res = await svc.reconcileMissingDistributions();

    expect(res).toEqual({ created: 2, scanned: 2 });
    expect(record).toHaveBeenCalledTimes(2);
    // (marketId, settlementId, houseAmount, houseEdgePct, totalPool, currency)
    expect(record).toHaveBeenCalledWith("m1", "s1", 24, 5, 300, "BTN");
    expect(record).toHaveBeenCalledWith("m2", "s2", 10, 8, 200, "USDT");
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
