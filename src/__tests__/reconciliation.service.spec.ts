/**
 * Tests for ReconciliationService — settlement reconciliation, report generation,
 * auto-correction, and statistics.
 */
import {
  ReconciliationService,
  ReconciliationReport,
} from "../reconciliation/reconciliation.service";
import {
  ReconciliationStatus,
  ReconciliationType,
} from "../entities/reconciliation.entity";
import { TransactionType } from "../entities/transaction.entity";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeQb(overrides: any = {}) {
  const qb: any = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    getCount: jest.fn().mockResolvedValue(0),
    getRawMany: jest.fn().mockResolvedValue([]),
    getRawOne: jest.fn().mockResolvedValue({ balance: 0 }),
    ...overrides,
  };
  return qb;
}

function makeRepo(rows: any[] = [], findOneResult: any = null) {
  const qb = makeQb();
  return {
    findOne: jest.fn().mockResolvedValue(findOneResult),
    find: jest.fn().mockResolvedValue(rows),
    save: jest.fn().mockImplementation((data: any) => Promise.resolve(data)),
    create: jest.fn().mockImplementation((data: any) => data),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    _qb: qb,
  };
}

function makeReconciliation(overrides: any = {}) {
  return {
    id: "recon-1",
    userId: "u1",
    marketId: "m1",
    positionId: "pos-1",
    settlementId: "s1",
    status: ReconciliationStatus.MATCHED,
    difference: 0,
    expectedAmount: 100,
    actualAmount: 100,
    type: ReconciliationType.SETTLEMENT,
    ...overrides,
  };
}

function makeService(overrides: {
  reconciliationRepo?: any;
  settlementRepo?: any;
  positionRepo?: any;
  transactionRepo?: any;
  marketRepo?: any;
  outcomeRepo?: any;
  userRepo?: any;
  dataSource?: any;
} = {}) {
  const reconciliationRepo = overrides.reconciliationRepo ?? makeRepo();
  const settlementRepo = overrides.settlementRepo ?? makeRepo();
  const positionRepo = overrides.positionRepo ?? makeRepo();
  const transactionRepo = overrides.transactionRepo ?? makeRepo();
  const marketRepo = overrides.marketRepo ?? makeRepo();
  const outcomeRepo = overrides.outcomeRepo ?? makeRepo();
  const userRepo = overrides.userRepo ?? makeRepo();
  const dataSource = overrides.dataSource ?? {
    transaction: jest.fn().mockImplementation((cb: Function) => cb({
      find: jest.fn().mockResolvedValue([]),
      getRepository: jest.fn().mockReturnValue(makeRepo()),
      create: jest.fn().mockImplementation((_e: any, d: any) => d),
      save: jest.fn().mockImplementation((_e: any, d: any) => Promise.resolve({ id: "tx-new", ...d })),
    })),
  };

  return new ReconciliationService(
    dataSource as any,
    reconciliationRepo as any,
    settlementRepo as any,
    positionRepo as any,
    transactionRepo as any,
    marketRepo as any,
    outcomeRepo as any,
    userRepo as any,
  );
}

// ── reconcileSettlement ───────────────────────────────────────────────────────

describe("ReconciliationService.reconcileSettlement", () => {
  it("throws when settlement not found", async () => {
    const settlementRepo = makeRepo([], null);
    const svc = makeService({ settlementRepo });

    await expect(svc.reconcileSettlement("missing")).rejects.toThrow("not found");
  });

  it("returns empty array when no winning positions exist", async () => {
    const settlement = {
      id: "s1",
      marketId: "m1",
      winningOutcomeId: "o1",
      totalPool: 1000,
      houseAmount: 50,
      payoutPool: 950,
    };
    const settlementRepo = makeRepo([], settlement);
    const positionRepo = makeRepo([]); // no winning positions
    const svc = makeService({ settlementRepo, positionRepo });

    const result = await svc.reconcileSettlement("s1");

    expect(result).toEqual([]);
  });

  it("creates MATCHED reconciliation record when payout matches expected", async () => {
    const settlement = {
      id: "s1",
      marketId: "m1",
      winningOutcomeId: "o1",
      totalPool: 1000,
      houseAmount: 50,
      payoutPool: 950,
    };
    const winningOutcome = { id: "o1", label: "Yes", totalBetAmount: 500 };
    const position = { id: "pos-1", userId: "u1", amount: 500 };
    const payoutTxn = { id: "tx-1", amount: 950, balanceBefore: 0, balanceAfter: 950 };

    const settlementRepo = makeRepo([], settlement);
    const marketRepo = makeRepo([], { id: "m1", title: "Test Market", houseEdgePct: 5 });
    const outcomeRepo = makeRepo([], winningOutcome);
    const positionRepo = makeRepo([position]);
    const userRepo = makeRepo([], { id: "u1", bonusBalance: 0 });
    const transactionRepo = makeRepo([payoutTxn]);
    // Second find returns empty bonus txns
    transactionRepo.find
      .mockResolvedValueOnce([payoutTxn])  // payout txns
      .mockResolvedValueOnce([]);           // bonus txns
    const reconciliationRepo = makeRepo();
    reconciliationRepo.save.mockImplementation((data: any) => Promise.resolve({ id: "recon-new", ...data }));

    const svc = makeService({
      settlementRepo, marketRepo, outcomeRepo, positionRepo,
      userRepo, transactionRepo, reconciliationRepo,
    });

    const result = await svc.reconcileSettlement("s1");

    expect(result).toHaveLength(1);
    expect(reconciliationRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ReconciliationStatus.MATCHED,
        type: ReconciliationType.SETTLEMENT,
      }),
    );
  });

  it("creates MISMATCH reconciliation record when payout differs from expected", async () => {
    const settlement = {
      id: "s1",
      marketId: "m1",
      winningOutcomeId: "o1",
      totalPool: 1000,
      houseAmount: 50,
      payoutPool: 950,
    };
    const winningOutcome = { id: "o1", label: "Yes", totalBetAmount: 500 };
    const position = { id: "pos-1", userId: "u1", amount: 500 };
    // Actual payout is only 900, expected is 950 → mismatch of -50
    const payoutTxn = { id: "tx-1", amount: 900, balanceBefore: 0, balanceAfter: 900 };

    const settlementRepo = makeRepo([], settlement);
    const marketRepo = makeRepo([], { id: "m1", title: "Test Market", houseEdgePct: 5 });
    const outcomeRepo = makeRepo([], winningOutcome);
    const positionRepo = makeRepo([position]);
    const userRepo = makeRepo([], { id: "u1", bonusBalance: 0 });
    const transactionRepo = makeRepo();
    transactionRepo.find
      .mockResolvedValueOnce([payoutTxn])
      .mockResolvedValueOnce([]);
    const reconciliationRepo = makeRepo();
    reconciliationRepo.save.mockImplementation((d: any) => Promise.resolve({ id: "r1", ...d }));

    const svc = makeService({
      settlementRepo, marketRepo, outcomeRepo, positionRepo,
      userRepo, transactionRepo, reconciliationRepo,
    });

    const result = await svc.reconcileSettlement("s1");

    expect(result).toHaveLength(1);
    expect(reconciliationRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: ReconciliationStatus.MISMATCH }),
    );
  });
});

// ── reconcileMarket ───────────────────────────────────────────────────────────

describe("ReconciliationService.reconcileMarket", () => {
  it("throws when no settlement found for market", async () => {
    const settlementRepo = makeRepo([], null);
    const svc = makeService({ settlementRepo });

    await expect(svc.reconcileMarket("market-missing")).rejects.toThrow("No settlement found");
  });

  it("delegates to reconcileSettlement with the correct settlementId", async () => {
    const settlement = {
      id: "s-found",
      marketId: "m1",
      winningOutcomeId: "o1",
      totalPool: 100,
      houseAmount: 5,
      payoutPool: 95,
    };
    const settlementRepo = makeRepo([], settlement);
    const positionRepo = makeRepo([]); // no positions → returns []
    const svc = makeService({ settlementRepo, positionRepo });

    const result = await svc.reconcileMarket("m1");

    expect(result).toEqual([]);
  });
});

// ── reconcileDKTransfers ──────────────────────────────────────────────────────

describe("ReconciliationService.reconcileDKTransfers", () => {
  it("appends 'No DK account linked' note when user has no DK account", async () => {
    const recon = makeReconciliation({ notes: "Verified" });
    const reconciliationRepo = makeRepo([recon]);
    reconciliationRepo.save.mockResolvedValue([recon]);
    const userRepo = makeRepo([], { id: "u1", dkAccountNumber: null });
    const svc = makeService({ reconciliationRepo, userRepo });

    await svc.reconcileDKTransfers("s1");

    expect(reconciliationRepo.save).toHaveBeenCalled();
    // The recon object should have "No DK account" appended
    expect(recon.notes).toContain("No DK account");
  });

  it("appends DK account info note when user has DK account", async () => {
    const recon = makeReconciliation({ notes: "Verified" });
    const reconciliationRepo = makeRepo([recon]);
    reconciliationRepo.save.mockResolvedValue([recon]);
    const userRepo = makeRepo([], { id: "u1", dkAccountNumber: "ACC001" });
    const svc = makeService({ reconciliationRepo, userRepo });

    await svc.reconcileDKTransfers("s1");

    expect(recon.notes).toContain("ACC001");
  });
});

// ── autoCorrectDiscrepancies ──────────────────────────────────────────────────

describe("ReconciliationService.autoCorrectDiscrepancies", () => {
  it("returns empty array when no mismatches exist", async () => {
    const em = {
      find: jest.fn().mockResolvedValue([]),
      getRepository: jest.fn().mockReturnValue(makeRepo()),
      create: jest.fn().mockImplementation((_e: any, d: any) => d),
      save: jest.fn().mockResolvedValue({}),
    };
    const dataSource = { transaction: jest.fn().mockImplementation((cb: Function) => cb(em)) };
    const svc = makeService({ dataSource });

    const result = await svc.autoCorrectDiscrepancies();

    expect(result).toEqual([]);
  });

  it("corrects mismatches below the threshold", async () => {
    const mismatch = makeReconciliation({
      status: ReconciliationStatus.MISMATCH,
      difference: 0.05, // below 0.1 threshold
      userId: "u1",
      positionId: "pos-1",
    });
    const qb = makeQb({ getRawOne: jest.fn().mockResolvedValue({ balance: 500 }) });
    const txRepo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
    const em = {
      find: jest.fn().mockResolvedValue([mismatch]),
      getRepository: jest.fn().mockReturnValue(txRepo),
      create: jest.fn().mockImplementation((_e: any, d: any) => ({ id: "tx-corr", ...d })),
      save: jest.fn().mockResolvedValue({}),
    };
    const dataSource = { transaction: jest.fn().mockImplementation((cb: Function) => cb(em)) };
    const svc = makeService({ dataSource });

    const result = await svc.autoCorrectDiscrepancies(0.1);

    expect(result).toHaveLength(1);
    expect(mismatch.status).toBe(ReconciliationStatus.CORRECTED);
    expect(em.save).toHaveBeenCalledWith(
      expect.any(Function), // Transaction entity
      expect.objectContaining({
        type: TransactionType.FREE_CREDIT,
        amount: 0.05,
      }),
    );
  });

  it("skips mismatches at or above the threshold", async () => {
    const largeMismatch = makeReconciliation({
      status: ReconciliationStatus.MISMATCH,
      difference: 5.0, // above 0.1 threshold
    });
    const em = {
      find: jest.fn().mockResolvedValue([largeMismatch]),
      getRepository: jest.fn().mockReturnValue(makeRepo()),
      create: jest.fn(),
      save: jest.fn(),
    };
    const dataSource = { transaction: jest.fn().mockImplementation((cb: Function) => cb(em)) };
    const svc = makeService({ dataSource });

    const result = await svc.autoCorrectDiscrepancies(0.1);

    expect(result).toHaveLength(0);
    expect(largeMismatch.status).toBe(ReconciliationStatus.MISMATCH); // unchanged
  });

  it("uses custom threshold when provided", async () => {
    const recon = makeReconciliation({
      status: ReconciliationStatus.MISMATCH,
      difference: 1.5, // above default 0.1 but below custom 2.0
      userId: "u1",
      positionId: "pos-1",
    });
    const qb = makeQb({ getRawOne: jest.fn().mockResolvedValue({ balance: 100 }) });
    const txRepo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
    const em = {
      find: jest.fn().mockResolvedValue([recon]),
      getRepository: jest.fn().mockReturnValue(txRepo),
      create: jest.fn().mockImplementation((_e: any, d: any) => ({ id: "tx-1", ...d })),
      save: jest.fn().mockResolvedValue({}),
    };
    const dataSource = { transaction: jest.fn().mockImplementation((cb: Function) => cb(em)) };
    const svc = makeService({ dataSource });

    const result = await svc.autoCorrectDiscrepancies(2.0);

    expect(result).toHaveLength(1);
    expect(recon.status).toBe(ReconciliationStatus.CORRECTED);
  });
});

// ── generateReport ────────────────────────────────────────────────────────────

describe("ReconciliationService.generateReport", () => {
  it("generates correct report from reconciliation records", async () => {
    const records = [
      makeReconciliation({ status: ReconciliationStatus.MATCHED, difference: 0 }),
      makeReconciliation({ id: "r2", status: ReconciliationStatus.MISMATCH, difference: -5 }),
      makeReconciliation({ id: "r3", status: ReconciliationStatus.CORRECTED, difference: 0.05 }),
      makeReconciliation({ id: "r4", status: ReconciliationStatus.PENDING, difference: 0 }),
    ];
    const svc = makeService();

    const report = await svc.generateReport(records);

    expect(report.total).toBe(4);
    expect(report.matched).toBe(1);
    expect(report.mismatched).toBe(1);
    expect(report.corrected).toBe(1);
    expect(report.pending).toBe(1);
    expect(report.totalDifference).toBeCloseTo(5.05, 2);
    expect(report.records).toHaveLength(4);
  });

  it("fetches all reconciliations from DB when no records provided", async () => {
    const records = [makeReconciliation()];
    const reconciliationRepo = makeRepo(records);
    const svc = makeService({ reconciliationRepo });

    const report = await svc.generateReport();

    expect(reconciliationRepo.find).toHaveBeenCalled();
    expect(report.total).toBe(1);
    expect(report.matched).toBe(1);
  });

  it("returns zero counts for empty records", async () => {
    const svc = makeService();

    const report = await svc.generateReport([]);

    expect(report.total).toBe(0);
    expect(report.matched).toBe(0);
    expect(report.totalDifference).toBe(0);
  });
});

// ── getReconciliations ────────────────────────────────────────────────────────

describe("ReconciliationService.getReconciliations", () => {
  it("returns paginated reconciliation records", async () => {
    const records = [makeReconciliation()];
    const reconciliationRepo = makeRepo();
    reconciliationRepo._qb.getManyAndCount.mockResolvedValue([records, 1]);
    const svc = makeService({ reconciliationRepo });

    const result = await svc.getReconciliations({ page: 1, limit: 50 });

    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.pages).toBe(1);
  });

  it("applies status filter", async () => {
    const reconciliationRepo = makeRepo();
    const svc = makeService({ reconciliationRepo });

    await svc.getReconciliations({ status: ReconciliationStatus.MISMATCH });

    expect(reconciliationRepo._qb.andWhere).toHaveBeenCalledWith(
      "r.status = :status",
      { status: ReconciliationStatus.MISMATCH },
    );
  });

  it("applies userId filter", async () => {
    const reconciliationRepo = makeRepo();
    const svc = makeService({ reconciliationRepo });

    await svc.getReconciliations({ userId: "user-1" });

    expect(reconciliationRepo._qb.andWhere).toHaveBeenCalledWith(
      "r.userId = :userId",
      { userId: "user-1" },
    );
  });

  it("applies date range filter when both from and to provided", async () => {
    const reconciliationRepo = makeRepo();
    const svc = makeService({ reconciliationRepo });

    const from = new Date("2024-01-01");
    const to = new Date("2024-01-31");
    await svc.getReconciliations({ from, to });

    expect(reconciliationRepo._qb.andWhere).toHaveBeenCalledWith(
      "r.createdAt BETWEEN :from AND :to",
      { from, to },
    );
  });

  it("caps limit at 100", async () => {
    const reconciliationRepo = makeRepo();
    const svc = makeService({ reconciliationRepo });

    await svc.getReconciliations({ limit: 9999 });

    expect(reconciliationRepo._qb.take).toHaveBeenCalledWith(100);
  });

  it("returns pages=1 when total is 0", async () => {
    const reconciliationRepo = makeRepo();
    reconciliationRepo._qb.getManyAndCount.mockResolvedValue([[], 0]);
    const svc = makeService({ reconciliationRepo });

    const result = await svc.getReconciliations({});

    expect(result.pages).toBe(1);
  });
});

// ── getReconciliationById ─────────────────────────────────────────────────────

describe("ReconciliationService.getReconciliationById", () => {
  it("returns reconciliation when found", async () => {
    const recon = makeReconciliation();
    const reconciliationRepo = makeRepo([], recon);
    const svc = makeService({ reconciliationRepo });

    const result = await svc.getReconciliationById("recon-1");

    expect(result).toEqual(recon);
  });

  it("throws when reconciliation not found", async () => {
    const reconciliationRepo = makeRepo([], null);
    const svc = makeService({ reconciliationRepo });

    await expect(svc.getReconciliationById("missing")).rejects.toThrow("not found");
  });
});

// ── getStatistics ─────────────────────────────────────────────────────────────

describe("ReconciliationService.getStatistics", () => {
  it("returns aggregated statistics", async () => {
    const byStatus = [
      { status: "matched", count: "5", totalDifference: "0" },
      { status: "mismatch", count: "2", totalDifference: "10.5" },
    ];
    const byType = [{ type: "settlement", count: "7" }];

    const reconciliationRepo = makeRepo();
    reconciliationRepo._qb.getCount.mockResolvedValue(7);
    reconciliationRepo._qb.getRawMany
      .mockResolvedValueOnce(byStatus)
      .mockResolvedValueOnce(byType);
    const svc = makeService({ reconciliationRepo });

    const result = await svc.getStatistics();

    expect(result.total).toBe(7);
    expect(result.byStatus).toEqual(byStatus);
    expect(result.byType).toEqual(byType);
    expect(result.totalDiscrepancy).toBeCloseTo(10.5, 2);
    expect(result.avgDiscrepancy).toBeCloseTo(10.5 / 7, 4);
  });

  it("returns 0 avgDiscrepancy when total is 0", async () => {
    const reconciliationRepo = makeRepo();
    reconciliationRepo._qb.getCount.mockResolvedValue(0);
    reconciliationRepo._qb.getRawMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const svc = makeService({ reconciliationRepo });

    const result = await svc.getStatistics();

    expect(result.avgDiscrepancy).toBe(0);
  });

  it("applies date range filter when provided", async () => {
    const reconciliationRepo = makeRepo();
    reconciliationRepo._qb.getCount.mockResolvedValue(0);
    reconciliationRepo._qb.getRawMany.mockResolvedValue([]);
    const svc = makeService({ reconciliationRepo });

    const from = new Date("2024-01-01");
    const to = new Date("2024-12-31");
    await svc.getStatistics(from, to);

    expect(reconciliationRepo._qb.where).toHaveBeenCalledWith(
      "r.createdAt BETWEEN :from AND :to",
      { from, to },
    );
  });
});
