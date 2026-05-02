/**
 * Tests for AuditService — logging admin actions and paginated retrieval.
 */
import { AuditService, RoleType } from "../admin/audit.service";
import { AuditAction } from "../entities/audit-log.entity";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeQb(overrides: any = {}) {
  const qb: any = {
    andWhere: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    addGroupBy: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    getRawMany: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
  return qb;
}

function makeRepo(overrides: any = {}) {
  const qb = makeQb();
  return {
    create: jest.fn().mockImplementation((data: any) => data),
    save: jest.fn().mockResolvedValue({}),
    find: jest.fn().mockResolvedValue([]),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    _qb: qb,
    ...overrides,
  };
}

function makeService(repoOverrides: any = {}) {
  const repo = makeRepo(repoOverrides);
  return { svc: new AuditService(repo as any), repo };
}

// ── log ───────────────────────────────────────────────────────────────────────

describe("AuditService.log", () => {
  it("creates and saves an audit entry for an admin action", async () => {
    const { svc, repo } = makeService();

    await svc.log({
      adminId: "admin-1",
      username: "adminuser",
      isAdmin: true,
      action: AuditAction.MARKET_CREATE,
      entityType: "market",
      entityId: "market-1",
    });

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        adminId: "admin-1",
        roleType: RoleType.ADMIN,
        action: AuditAction.MARKET_CREATE,
        entityType: "market",
        entityId: "market-1",
      }),
    );
    expect(repo.save).toHaveBeenCalled();
  });

  it("assigns RoleType.USER when isAdmin=false", async () => {
    const { svc, repo } = makeService();

    await svc.log({
      adminId: "user-1",
      isAdmin: false,
      action: "some_action",
    });

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ roleType: RoleType.USER }),
    );
  });

  it("includes before/after/meta in payload", async () => {
    const { svc, repo } = makeService();

    await svc.log({
      adminId: "admin-1",
      isAdmin: true,
      action: AuditAction.MARKET_UPDATE,
      before: { status: "open" },
      after: { status: "closed" },
      meta: { reason: "expired" },
    });

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          before: { status: "open" },
          after: { status: "closed" },
          meta: { reason: "expired" },
        },
      }),
    );
  });

  it("does not throw when save fails (fire-and-forget)", async () => {
    const repo = makeRepo();
    repo.save = jest.fn().mockRejectedValue(new Error("DB error"));
    const svc = new AuditService(repo as any);

    await expect(
      svc.log({ adminId: "admin-1", isAdmin: true, action: "test" }),
    ).resolves.not.toThrow();
  });
});

// ── findPaginated ─────────────────────────────────────────────────────────────

describe("AuditService.findPaginated", () => {
  it("returns paginated results with no filters", async () => {
    const logs = [{ id: "log-1" }, { id: "log-2" }];
    const repo = makeRepo();
    repo._qb.getManyAndCount.mockResolvedValue([logs, 2]);
    const svc = new AuditService(repo as any);

    const result = await svc.findPaginated({ page: 1, limit: 50 });

    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.page).toBe(1);
    expect(result.pages).toBe(1);
  });

  it("applies action filter (skips 'all' value)", async () => {
    const repo = makeRepo();
    const qb = repo._qb;
    const svc = new AuditService(repo as any);

    await svc.findPaginated({ action: AuditAction.MARKET_CREATE });

    expect(qb.andWhere).toHaveBeenCalledWith(
      "log.action = :action",
      expect.objectContaining({ action: AuditAction.MARKET_CREATE }),
    );
  });

  it("skips action filter when action is 'all'", async () => {
    const repo = makeRepo();
    const qb = repo._qb;
    const svc = new AuditService(repo as any);

    await svc.findPaginated({ action: "all" });

    expect(qb.andWhere).not.toHaveBeenCalledWith(
      "log.action = :action",
      expect.anything(),
    );
  });

  it("applies adminId filter", async () => {
    const repo = makeRepo();
    const qb = repo._qb;
    const svc = new AuditService(repo as any);

    await svc.findPaginated({ adminId: "admin-1" });

    expect(qb.andWhere).toHaveBeenCalledWith(
      "log.adminId = :adminId",
      { adminId: "admin-1" },
    );
  });

  it("applies date range filters", async () => {
    const repo = makeRepo();
    const qb = repo._qb;
    const svc = new AuditService(repo as any);

    await svc.findPaginated({ from: "2024-01-01", to: "2024-01-31" });

    expect(qb.andWhere).toHaveBeenCalledWith("log.createdAt >= :from", expect.anything());
    expect(qb.andWhere).toHaveBeenCalledWith("log.createdAt < :to", expect.anything());
  });

  it("caps limit at 100", async () => {
    const repo = makeRepo();
    const qb = repo._qb;
    const svc = new AuditService(repo as any);

    await svc.findPaginated({ limit: 9999, page: 1 });

    expect(qb.take).toHaveBeenCalledWith(100);
  });

  it("floors page at 1", async () => {
    const repo = makeRepo();
    const qb = repo._qb;
    const svc = new AuditService(repo as any);

    await svc.findPaginated({ page: -5 });

    expect(qb.skip).toHaveBeenCalledWith(0); // (1-1)*50 = 0
  });

  it("returns pages=1 when total=0", async () => {
    const repo = makeRepo();
    repo._qb.getManyAndCount.mockResolvedValue([[], 0]);
    const svc = new AuditService(repo as any);

    const result = await svc.findPaginated({});

    expect(result.pages).toBe(1);
  });

  it("applies search filter using LOWER LIKE", async () => {
    const repo = makeRepo();
    const qb = repo._qb;
    const svc = new AuditService(repo as any);

    await svc.findPaginated({ search: "Admin" });

    expect(qb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining("LOWER"),
      expect.objectContaining({ s: "%admin%" }),
    );
  });
});

// ── findDistinctAdmins ────────────────────────────────────────────────────────

describe("AuditService.findDistinctAdmins", () => {
  it("returns list of distinct admins", async () => {
    const repo = makeRepo();
    repo._qb.getRawMany.mockResolvedValue([
      { adminId: "a1", adminUsername: "alice" },
      { adminId: "a2", adminUsername: "bob" },
    ]);
    const svc = new AuditService(repo as any);

    const result = await svc.findDistinctAdmins();

    expect(result).toHaveLength(2);
    expect(result[0].adminId).toBe("a1");
  });
});

// ── Legacy helpers ────────────────────────────────────────────────────────────

describe("AuditService legacy helpers", () => {
  it("findAll returns up to 200 records (capped at 500)", async () => {
    const repo = makeRepo();
    repo.find.mockResolvedValue([{ id: "log-1" }]);
    const svc = new AuditService(repo as any);

    const result = await svc.findAll(200);

    expect(repo.find).toHaveBeenCalledWith({
      order: { createdAt: "DESC" },
      take: 200,
    });
    expect(result).toHaveLength(1);
  });

  it("findAll caps take at 500", async () => {
    const repo = makeRepo();
    const svc = new AuditService(repo as any);

    await svc.findAll(9999);

    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({ take: 500 }),
    );
  });

  it("findByAdmin returns logs for given admin", async () => {
    const repo = makeRepo();
    const svc = new AuditService(repo as any);

    await svc.findByAdmin("admin-1");

    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { adminId: "admin-1" } }),
    );
  });

  it("findByEntity returns logs for given entity", async () => {
    const repo = makeRepo();
    const svc = new AuditService(repo as any);

    await svc.findByEntity("entity-1");

    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { entityId: "entity-1" } }),
    );
  });
});

// ── getRoleTypeFromIsAdmin ────────────────────────────────────────────────────

describe("AuditService.getRoleTypeFromIsAdmin", () => {
  it("returns ADMIN for true", () => {
    const { svc } = makeService();
    expect(svc.getRoleTypeFromIsAdmin(true)).toBe(RoleType.ADMIN);
  });

  it("returns USER for false", () => {
    const { svc } = makeService();
    expect(svc.getRoleTypeFromIsAdmin(false)).toBe(RoleType.USER);
  });
});
