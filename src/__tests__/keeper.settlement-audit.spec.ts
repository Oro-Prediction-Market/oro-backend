import {
  KeeperService,
  SETTLEMENT_AUDIT_LAST_KEY,
  SETTLEMENT_AUDIT_RUNS_KEY,
  formatAuditMismatch,
  type SettlementAuditMismatch,
} from "../markets/keeper.service";

/**
 * The daily settlement audit used to speak only through a Telegram DM, so "no
 * DM this morning" meant either "all correct" or "never ran" and nobody could
 * tell which. Every run is now recorded for the dashboard.
 */
describe("KeeperService — settlement audit record", () => {
  const mismatch: SettlementAuditMismatch = {
    source: "football",
    marketId: "m-forest",
    title: "Nottingham Forest FC vs Coventry City FC",
    settledAs: { id: "o-draw", label: "Draw" },
    shouldBe: { id: "o-cov", label: "Coventry City FC" },
    detail: "0-1",
  };

  function build(opts: { resolvedNow?: string } = {}) {
    const store = new Map<string, unknown>();
    const list: string[] = [];
    const redis: any = {
      acquireLock: jest.fn().mockResolvedValue("tok"),
      releaseLock: jest.fn().mockResolvedValue(undefined),
      setJsonEx: jest.fn(async (k: string, _t: number, v: unknown) => {
        store.set(k, JSON.parse(JSON.stringify(v)));
      }),
      getJson: jest.fn(async (k: string) => store.get(k) ?? null),
      redis: {
        lpush: jest.fn(async (_k: string, v: string) => list.unshift(v)),
        ltrim: jest.fn(async () => "OK"),
        expire: jest.fn(async () => 1),
        lrange: jest.fn(async () => [...list]),
      },
    };
    const telegram: any = { sendMessage: jest.fn().mockResolvedValue(undefined) };
    const marketRepo: any = {
      find: jest.fn().mockResolvedValue([
        { id: "m-forest", resolvedOutcomeId: opts.resolvedNow ?? "o-draw" },
      ]),
    };
    const jobHealth: any = {
      track: jest.fn((_k: string, fn: () => Promise<unknown>) => fn()),
      skip: jest.fn(),
    };
    const svc = new KeeperService(
      {} as any,
      telegram,
      { get: jest.fn() } as any,
      redis,
      marketRepo,
      {} as any,
      {} as any,
      {} as any,
      jobHealth,
    );
    const notify = jest
      .spyOn(svc as any, "notifyAdmin")
      .mockResolvedValue(undefined);
    return { svc, store, list, notify, jobHealth };
  }

  function stubSources(svc: KeeperService, mismatches: SettlementAuditMismatch[], unavailable?: string) {
    (svc as any).auditFootballSettlements = jest
      .fn()
      .mockResolvedValue({ checked: 5, mismatches, unavailable });
    (svc as any).auditUclSettlements = jest
      .fn()
      .mockResolvedValue({ checked: 0, mismatches: [] });
  }

  it("records a clean run, so 'ran and found nothing' is visible", async () => {
    const { svc, store, list, notify } = build();
    stubSources(svc, []);

    await svc.runSettlementAuditNow();

    const last: any = store.get(SETTLEMENT_AUDIT_LAST_KEY);
    expect(last).toMatchObject({ checked: 5, mismatches: [], trigger: "manual" });
    expect(JSON.parse(list[0])).toMatchObject({ checked: 5, mismatchCount: 0 });
    expect(notify).not.toHaveBeenCalled();
  });

  it("records a source it could not check, rather than reporting all-clear", async () => {
    const { svc, store } = build();
    stubSources(svc, [], "League results: FOOTBALL_DATA_API_KEY not set");

    await svc.runSettlementAuditNow();

    expect((store.get(SETTLEMENT_AUDIT_LAST_KEY) as any).unavailable).toEqual([
      "League results: FOOTBALL_DATA_API_KEY not set",
    ]);
  });

  it("keeps the mismatch details and still sends the same DM", async () => {
    const { svc, store, notify } = build();
    stubSources(svc, [mismatch]);

    await svc.runSettlementAuditNow();

    expect((store.get(SETTLEMENT_AUDIT_LAST_KEY) as any).mismatches).toEqual([mismatch]);
    const dm = notify.mock.calls[0][0] as string;
    expect(dm).toContain("Wrong Settlement Detected");
    expect(dm).toContain(formatAuditMismatch(mismatch));
    expect(dm).toContain("settled as: <b>Draw</b>");
    expect(dm).toContain("now reads:  <b>Coventry City FC</b> (0-1)");
  });

  it("shows a mismatch as still open while the market is unchanged", async () => {
    const { svc } = build({ resolvedNow: "o-draw" });
    stubSources(svc, [mismatch]);
    await svc.runSettlementAuditNow();

    const { last } = await svc.getSettlementAuditHistory();
    expect(last!.mismatches[0].corrected).toBe(false);
  });

  it("shows it as corrected once the market's result has been fixed", async () => {
    const { svc } = build({ resolvedNow: "o-cov" });
    stubSources(svc, [mismatch]);
    await svc.runSettlementAuditNow();

    const { last } = await svc.getSettlementAuditHistory();
    expect(last!.mismatches[0].corrected).toBe(true);
  });

  it("marks the scheduled run skipped when the keeper is paused", async () => {
    const { svc, jobHealth } = build();
    svc.setActive(false);

    await svc.auditRecentSettlements();

    expect(jobHealth.skip).toHaveBeenCalledWith("settlement-audit", "keeper paused");
  });

  it("returns an empty history when nothing has run yet", async () => {
    const { svc } = build();
    const h = await svc.getSettlementAuditHistory();
    expect(h).toEqual({ last: null, runs: [] });
    expect(SETTLEMENT_AUDIT_RUNS_KEY).toBe("oro:settlement-audit:runs");
  });
});
