/**
 * Tests for ReportingService — transaction audits, disputes, paginated results.
 */
import { NotFoundException } from "@nestjs/common";
import { ReportingService } from "../reporting/reporting.service";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeQb(rows: any[] = [], total = 0) {
  const qb: any = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([rows, total || rows.length]),
    getRawMany: jest.fn().mockResolvedValue([]),
    getRawOne: jest.fn().mockResolvedValue({ totalBond: "0" }),
    getCount: jest.fn().mockResolvedValue(rows.length),
  };
  return qb;
}

function makeRepo(rows: any[] = [], findOneResult: any = null) {
  const qb = makeQb(rows, rows.length);
  return {
    findOne: jest.fn().mockResolvedValue(findOneResult),
    find: jest.fn().mockResolvedValue(rows),
    count: jest.fn().mockResolvedValue(rows.length),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    _qb: qb,
  };
}

function makeService(overrides: {
  userRepo?: any;
  marketRepo?: any;
  disputeRepo?: any;
  transactionRepo?: any;
  auditLogRepo?: any;
} = {}) {
  const userRepo = overrides.userRepo ?? makeRepo();
  const marketRepo = overrides.marketRepo ?? makeRepo();
  const disputeRepo = overrides.disputeRepo ?? makeRepo();
  const transactionRepo = overrides.transactionRepo ?? makeRepo();
  const auditLogRepo = overrides.auditLogRepo ?? makeRepo();

  return new ReportingService(
    userRepo as any,
    marketRepo as any,
    disputeRepo as any,
    transactionRepo as any,
    auditLogRepo as any,
  );
}

// ── findTransactionAudits ─────────────────────────────────────────────────────

describe("ReportingService.findTransactionAudits", () => {
  it("returns paginated transactions with defaults", async () => {
    const txns = [{ id: "t1" }, { id: "t2" }];
    const txRepo = makeRepo(txns);
    const svc = makeService({ transactionRepo: txRepo });

    const result = await svc.findTransactionAudits();

    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.page).toBe(1);
    expect(result.pages).toBe(1);
  });

  it("applies userId filter", async () => {
    const txRepo = makeRepo();
    const svc = makeService({ transactionRepo: txRepo });

    await svc.findTransactionAudits("user-1");

    expect(txRepo._qb.andWhere).toHaveBeenCalledWith(
      "t.userId = :userId",
      { userId: "user-1" },
    );
  });

  it("applies type filter", async () => {
    const txRepo = makeRepo();
    const svc = makeService({ transactionRepo: txRepo });

    await svc.findTransactionAudits(undefined, "deposit");

    expect(txRepo._qb.andWhere).toHaveBeenCalledWith(
      "t.type = :type",
      { type: "deposit" },
    );
  });

  it("applies date range filter when both from and to provided", async () => {
    const txRepo = makeRepo();
    const svc = makeService({ transactionRepo: txRepo });

    await svc.findTransactionAudits(
      undefined, undefined, undefined, undefined,
      "2024-01-01", "2024-01-31",
    );

    expect(txRepo._qb.andWhere).toHaveBeenCalledWith(
      "t.createdAt BETWEEN :from AND :to",
      expect.anything(),
    );
  });

  it("does NOT apply date filter when only one of from/to is provided", async () => {
    const txRepo = makeRepo();
    const svc = makeService({ transactionRepo: txRepo });

    await svc.findTransactionAudits(undefined, undefined, undefined, undefined, "2024-01-01");

    const calls = txRepo._qb.andWhere.mock.calls.map((c: any[]) => c[0]);
    expect(calls).not.toContain("t.createdAt BETWEEN :from AND :to");
  });

  it("applies search filter on note field", async () => {
    const txRepo = makeRepo();
    const svc = makeService({ transactionRepo: txRepo });

    await svc.findTransactionAudits(
      undefined, undefined, undefined, undefined,
      undefined, undefined, "bonus",
    );

    expect(txRepo._qb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining("LOWER"),
      expect.objectContaining({ search: "%bonus%" }),
    );
  });

  it("calculates correct pages", async () => {
    const txRepo = makeRepo([]);
    txRepo._qb.getManyAndCount.mockResolvedValue([new Array(50).fill({ id: "t" }), 105]);
    const svc = makeService({ transactionRepo: txRepo });

    const result = await svc.findTransactionAudits(undefined, undefined, undefined, undefined, undefined, undefined, undefined, 1, 50);

    expect(result.pages).toBe(3); // ceil(105/50) = 3
  });
});

// ── findTransactionAuditById ──────────────────────────────────────────────────

describe("ReportingService.findTransactionAuditById", () => {
  it("returns transaction when found", async () => {
    const txn = { id: "t1", type: "deposit" };
    const txRepo = makeRepo([], txn);
    const svc = makeService({ transactionRepo: txRepo });

    const result = await svc.findTransactionAuditById("t1");

    expect(result).toEqual(txn);
    expect(txRepo.findOne).toHaveBeenCalledWith({
      where: { id: "t1" },
      relations: ["user"],
    });
  });

  it("throws NotFoundException when transaction not found", async () => {
    const txRepo = makeRepo([], null);
    const svc = makeService({ transactionRepo: txRepo });

    await expect(svc.findTransactionAuditById("missing")).rejects.toThrow(NotFoundException);
  });
});

// ── getTransactionStats ───────────────────────────────────────────────────────

describe("ReportingService.getTransactionStats", () => {
  it("returns totalCount and byType", async () => {
    const byType = [{ type: "deposit", count: "5", totalAmount: "500" }];
    const txRepo = makeRepo();
    txRepo._qb.getCount.mockResolvedValue(10);
    txRepo._qb.getRawMany.mockResolvedValue(byType);
    const svc = makeService({ transactionRepo: txRepo });

    const result = await svc.getTransactionStats();

    expect(result.totalCount).toBe(10);
    expect(result.byType).toEqual(byType);
  });

  it("applies date range when provided", async () => {
    const txRepo = makeRepo();
    const svc = makeService({ transactionRepo: txRepo });

    await svc.getTransactionStats("2024-01-01", "2024-12-31");

    expect(txRepo._qb.where).toHaveBeenCalledWith(
      "t.createdAt BETWEEN :from AND :to",
      expect.anything(),
    );
  });
});

// ── findAdminAuditLogs ────────────────────────────────────────────────────────

describe("ReportingService.findAdminAuditLogs", () => {
  it("returns paginated audit logs", async () => {
    const logs = [{ id: "log-1" }];
    const auditRepo = makeRepo(logs);
    const svc = makeService({ auditLogRepo: auditRepo });

    const result = await svc.findAdminAuditLogs();

    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it("applies userId filter", async () => {
    const auditRepo = makeRepo();
    const svc = makeService({ auditLogRepo: auditRepo });

    await svc.findAdminAuditLogs("admin-1");

    expect(auditRepo._qb.andWhere).toHaveBeenCalledWith(
      "log.userId = :userId",
      { userId: "admin-1" },
    );
  });

  it("applies action filter", async () => {
    const auditRepo = makeRepo();
    const svc = makeService({ auditLogRepo: auditRepo });

    await svc.findAdminAuditLogs(undefined, "MARKET_CREATE");

    expect(auditRepo._qb.andWhere).toHaveBeenCalledWith(
      "log.action = :action",
      { action: "MARKET_CREATE" },
    );
  });
});

// ── findDisputes ──────────────────────────────────────────────────────────────

describe("ReportingService.findDisputes", () => {
  it("returns paginated disputes", async () => {
    const disputes = [{ id: "d1" }, { id: "d2" }];
    const disputeRepo = makeRepo(disputes);
    const svc = makeService({ disputeRepo });

    const result = await svc.findDisputes();

    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.page).toBe(1);
  });

  it("applies marketId filter", async () => {
    const disputeRepo = makeRepo();
    const svc = makeService({ disputeRepo });

    await svc.findDisputes("market-1");

    expect(disputeRepo._qb.andWhere).toHaveBeenCalledWith(
      "d.marketId = :marketId",
      { marketId: "market-1" },
    );
  });

  it("applies date range filter", async () => {
    const disputeRepo = makeRepo();
    const svc = makeService({ disputeRepo });

    await svc.findDisputes(undefined, "2024-01-01", "2024-12-31");

    expect(disputeRepo._qb.andWhere).toHaveBeenCalledWith(
      "d.createdAt BETWEEN :from AND :to",
      expect.anything(),
    );
  });
});

// ── findDisputeById ───────────────────────────────────────────────────────────

describe("ReportingService.findDisputeById", () => {
  it("returns dispute when found", async () => {
    const dispute = { id: "d1", reason: "Wrong result" };
    const disputeRepo = makeRepo([], dispute);
    const svc = makeService({ disputeRepo });

    const result = await svc.findDisputeById("d1");

    expect(result).toEqual(dispute);
  });

  it("throws NotFoundException when dispute not found", async () => {
    const disputeRepo = makeRepo([], null);
    const svc = makeService({ disputeRepo });

    await expect(svc.findDisputeById("missing")).rejects.toThrow(NotFoundException);
  });
});

// ── getDisputeStats ───────────────────────────────────────────────────────────

describe("ReportingService.getDisputeStats", () => {
  it("returns dispute counts (total/pending/resolved) and total bond", async () => {
    const disputeRepo = makeRepo();
    // count() → total (4); count({ bondStatus: LOCKED }) → pending (2)
    disputeRepo.count = jest
      .fn()
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(2);
    disputeRepo._qb.getCount.mockResolvedValue(2); // resolved (rewarded/forfeited)
    // Bond sums arrive grouped by currency: contests are per book, and one
    // SUM across all of them would add ngultrum to USDT.
    disputeRepo._qb.getRawMany.mockResolvedValue([
      { currency: "BTN", totalBond: "350" },
      { currency: "USDT", totalBond: "4.5" },
    ]);
    const svc = makeService({ disputeRepo });

    const result = await svc.getDisputeStats();

    expect(result.total).toBe(4);
    expect(result.pending).toBe(2);
    expect(result.resolved).toBe(2);
    // `totalBond` stays the ngultrum figure it has always been in practice —
    // never 354.5, which would be two currencies added together.
    expect(result.totalBond).toBe(350);
    expect(result.bondsByCurrency).toEqual({ BTN: 350, USDT: 4.5 });
  });

  it("reports a zero ngultrum total when every bond is USDT", async () => {
    const disputeRepo = makeRepo();
    disputeRepo.count = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    disputeRepo._qb.getCount.mockResolvedValue(0);
    disputeRepo._qb.getRawMany.mockResolvedValue([
      { currency: "USDT", totalBond: "2" },
    ]);
    const svc = makeService({ disputeRepo });

    const result = await svc.getDisputeStats();

    // 0, not 2: the ngultrum total must never borrow another book's number.
    expect(result.totalBond).toBe(0);
    expect(result.bondsByCurrency).toEqual({ USDT: 2 });
  });
});

// ── getMarketDisputeSummary ───────────────────────────────────────────────────

describe("ReportingService.getMarketDisputeSummary", () => {
  it("throws NotFoundException when market not found", async () => {
    const marketRepo = makeRepo([], null);
    const svc = makeService({ marketRepo });

    await expect(svc.getMarketDisputeSummary("missing")).rejects.toThrow(NotFoundException);
  });

  it("returns dispute summary with totals", async () => {
    const market = { id: "m1", outcomes: [] };
    const disputes = [
      { userId: "u1", bondAmount: 100 },
      { userId: "u2", bondAmount: 200 },
      { userId: "u1", bondAmount: 50 }, // same user
    ];
    const marketRepo = makeRepo([], market);
    const disputeRepo = makeRepo(disputes);
    disputeRepo.find = jest.fn().mockResolvedValue(disputes);
    const svc = makeService({ marketRepo, disputeRepo });

    const result = await svc.getMarketDisputeSummary("m1");

    expect(result.market).toEqual(market);
    expect(result.totalBond).toBe(350);
    expect(result.uniqueVoters).toBe(2); // u1 and u2
    expect(result.hasMinVoters).toBe(false); // 2 < 3
  });

  it("hasMinVoters is true when 3+ unique voters", async () => {
    const market = { id: "m1", outcomes: [] };
    const disputes = [
      { userId: "u1", bondAmount: 100 },
      { userId: "u2", bondAmount: 100 },
      { userId: "u3", bondAmount: 100 },
    ];
    const marketRepo = makeRepo([], market);
    const disputeRepo = makeRepo(disputes);
    disputeRepo.find = jest.fn().mockResolvedValue(disputes);
    const svc = makeService({ marketRepo, disputeRepo });

    const result = await svc.getMarketDisputeSummary("m1");

    expect(result.hasMinVoters).toBe(true);
  });
});

// ── getAllMarketsDisputeSummary ────────────────────────────────────────────────

describe("ReportingService.getAllMarketsDisputeSummary", () => {
  it("returns only markets with disputes, sorted by totalBond descending", async () => {
    const markets = [
      { id: "m1", outcomes: [] },
      { id: "m2", outcomes: [] },
      { id: "m3", outcomes: [] }, // no disputes
    ];
    const marketRepo = makeRepo(markets);
    marketRepo.find = jest.fn().mockResolvedValue(markets);

    const disputeRepo = makeRepo();
    disputeRepo.find = jest.fn()
      .mockResolvedValueOnce([{ userId: "u1", bondAmount: 50 }])    // m1
      .mockResolvedValueOnce([{ userId: "u1", bondAmount: 200 }])   // m2
      .mockResolvedValueOnce([]);                                     // m3 — no disputes

    const svc = makeService({ marketRepo, disputeRepo });

    const result = await svc.getAllMarketsDisputeSummary();

    expect(result).toHaveLength(2); // m3 excluded
    expect(result[0].market.id).toBe("m2"); // higher bond first
    expect(result[1].market.id).toBe("m1");
  });
});

// ── getPendingDisputes ────────────────────────────────────────────────────────

describe("ReportingService.getPendingDisputes", () => {
  it("returns pending disputes (bondStatus=locked) paginated", async () => {
    const disputes = [{ id: "d1", bondAmount: 100 }];
    const disputeRepo = makeRepo(disputes);
    const svc = makeService({ disputeRepo });

    const result = await svc.getPendingDisputes(1, 50);

    expect(result.data).toHaveLength(1);
    expect(disputeRepo._qb.where).toHaveBeenCalledWith(
      "d.bondStatus = :status",
      { status: "locked" },
    );
  });

  it("returns pages=1 when no pending disputes", async () => {
    const disputeRepo = makeRepo([]);
    disputeRepo._qb.getManyAndCount.mockResolvedValue([[], 0]);
    const svc = makeService({ disputeRepo });

    const result = await svc.getPendingDisputes();

    expect(result.pages).toBe(1);
  });
});
