import { RevenueDistributionService } from "../markets/revenue-distribution.service";

/**
 * The reported house edge describes POOL money, never forfeited bonds.
 *
 * `settlements.houseAmount` is a residual plus any dispute bonds forfeited by
 * losing objectors. The revenue table used to report the edge as
 * `houseAmount / totalPool`, which blends the two — a 10% market that had
 * taken one Nu 10 bond reported 11.11%. Three of the four production rows
 * above 10% were exactly this.
 *
 * It matters because that figure is what someone checks to confirm the edge
 * is being applied correctly, so reading high is worse than untidy.
 */
describe("house edge excludes forfeited dispute bonds", () => {
  function build(settlements: any[], markets: any[]) {
    const qb: any = {
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(settlements),
    };
    const svc = new RevenueDistributionService(
      {} as any,
      { createQueryBuilder: jest.fn(() => qb) } as any,
      { find: jest.fn().mockResolvedValue(markets) } as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const record = jest.fn().mockResolvedValue({ id: "d" });
    (svc as any).recordDistribution = record;
    return { svc, record };
  }

  /** The exact production row: Nu 900 pool, 10% edge, one Nu 10 bond forfeited. */
  it("reports 10% — not 11.11% — when a bond is forfeited", async () => {
    const { svc, record } = build(
      [
        {
          id: "s1",
          marketId: "m1",
          houseAmount: "100.00",
          houseForfeit: "10.00",
          totalPool: "900.00",
          currency: "BTN",
        },
      ],
      [{ id: "m1", houseEdgePct: "10" }],
    );

    await svc.reconcileMissingDistributions();

    const [, , houseAmount, edgePct, totalPool, , forfeit] = record.mock.calls[0];
    expect(edgePct).toBeCloseTo(10, 6);
    // The money transferred is unchanged — only how it is described.
    expect(houseAmount).toBe(100);
    expect(totalPool).toBe(900);
    expect(forfeit).toBe(10);
  });

  it("keeps the plain case at the configured edge", async () => {
    const { svc, record } = build(
      [
        {
          id: "s1",
          marketId: "m1",
          houseAmount: "175.00",
          houseForfeit: "0",
          totalPool: "1750.00",
          currency: "BTN",
        },
      ],
      [{ id: "m1", houseEdgePct: "10" }],
    );

    await svc.reconcileMissingDistributions();

    expect(record.mock.calls[0][3]).toBeCloseTo(10, 6);
    expect(record.mock.calls[0][6]).toBe(0);
  });

  /**
   * A market settled at 15% still reports 15%. The fix separates bond money
   * from pool money; it does not normalise a genuinely different edge, which
   * would hide the one production row that actually warranted a look.
   */
  it("does not flatten a market settled at a non-standard edge", async () => {
    const { svc, record } = build(
      [
        {
          id: "s1",
          marketId: "m1",
          houseAmount: "1732.20",
          houseForfeit: "0",
          totalPool: "11548.00",
          currency: "BTN",
        },
      ],
      [{ id: "m1", houseEdgePct: "15" }],
    );

    await svc.reconcileMissingDistributions();

    expect(record.mock.calls[0][3]).toBeCloseTo(15, 2);
  });

  /** Rows written before the column existed carry no forfeit field at all. */
  it("treats a missing houseForfeit as zero rather than NaN", async () => {
    const { svc, record } = build(
      [
        {
          id: "s1",
          marketId: "m1",
          houseAmount: "24.00",
          totalPool: "240.00",
          currency: "BTN",
        },
      ],
      [{ id: "m1", houseEdgePct: "10" }],
    );

    await svc.reconcileMissingDistributions();

    expect(record.mock.calls[0][3]).toBeCloseTo(10, 6);
    expect(record.mock.calls[0][6]).toBe(0);
  });

  it("falls back to the market's configured edge on a zero pool", async () => {
    const { svc, record } = build(
      [
        {
          id: "s1",
          marketId: "m1",
          houseAmount: "10.00",
          houseForfeit: "10.00",
          totalPool: "0",
          currency: "BTN",
        },
      ],
      [{ id: "m1", houseEdgePct: "10" }],
    );

    await svc.reconcileMissingDistributions();

    expect(record.mock.calls[0][3]).toBe(10);
  });
});

/**
 * houseEdgePct is an audit figure in a decimal(5,2) column. A settlement from
 * before houseForfeit existed, whose forfeited bonds were many times its pool,
 * would compute to 1000% or more — overflowing the column, failing the insert,
 * and leaving that settlement's revenue unbooked forever.
 */
describe("recordDistribution bounds the edge figure, never the money", () => {
  function build() {
    const saved: any[] = [];
    const distributionRepo: any = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((x: any) => x),
      save: jest.fn(async (x: any) => (saved.push(x), x)),
    };
    const svc = new RevenueDistributionService(
      distributionRepo,
      {} as any,
      {} as any,
      { get: jest.fn() } as any,
      {} as any,
      { get: jest.fn().mockResolvedValue("PUB") } as any,
    );
    return { svc, saved };
  }

  it("caps a figure that would overflow decimal(5,2)", async () => {
    const { svc, saved } = build();
    await svc.recordDistribution("m", "s", 1200, 12000, 10, "BTN");
    expect(saved[0]).toMatchObject({ amount: 1200, houseEdgePct: 999.99 });
  });

  it("leaves a normal figure alone", async () => {
    const { svc, saved } = build();
    await svc.recordDistribution("m", "s", 90, 10, 900, "BTN");
    expect(saved[0]).toMatchObject({ amount: 90, houseEdgePct: 10 });
  });

  it("records 0 rather than NaN when the figure cannot be computed", async () => {
    const { svc, saved } = build();
    await svc.recordDistribution("m", "s", 90, Number.NaN, 0, "BTN");
    expect(saved[0].houseEdgePct).toBe(0);
  });
});
