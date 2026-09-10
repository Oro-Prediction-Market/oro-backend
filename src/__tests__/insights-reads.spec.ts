import { ProbabilityHistoryService } from "../insights/probability-history.service";
import { FreeCallsService } from "../free-calls/free-calls.service";
import { SuggestionsService } from "../suggestions/suggestions.service";
import { SuggestionStatus } from "../entities/market-suggestion.entity";

/**
 * The read paths and the prune cron — the parts the six feature suites leave
 * uncovered because they carry no arithmetic. They still carry SQL shape and
 * clamping, which is where a public endpoint gets hurt.
 */
describe("ProbabilityHistoryService.pruneOldSnapshots", () => {
  function build(lock: string | null = "t", result: any = ["", 42]) {
    const snapshotRepo: any = { query: jest.fn(async () => result) };
    const redis: any = {
      acquireLock: jest.fn().mockResolvedValue(lock),
      releaseLock: jest.fn().mockResolvedValue(undefined),
    };
    const logged: string[] = [];
    const svc = new ProbabilityHistoryService(
      snapshotRepo,
      {} as any,
      {} as any,
      redis,
    );
    (svc as any).logger = {
      log: (m: string) => logged.push(m),
      warn: () => {},
      error: (m: string) => logged.push(m),
      debug: () => {},
    };
    return { svc, snapshotRepo, redis, logged };
  }

  it("only deletes snapshots for markets that are actually finished", async () => {
    const { svc, snapshotRepo } = build();

    await svc.pruneOldSnapshots();

    const sql = snapshotRepo.query.mock.calls[0][0] as string;
    expect(sql).toContain("DELETE FROM");
    expect(sql).toContain("'settled', 'cancelled'");
    // An open market's history must never be prunable.
    expect(sql).not.toContain("'open'");
    // Bounded by age, passed as a parameter rather than interpolated.
    expect(sql).toContain('m."updatedAt" < $1');
    expect(snapshotRepo.query.mock.calls[0][1][0]).toBeInstanceOf(Date);
  });

  it("keeps roughly a year of settled history", async () => {
    const { svc, snapshotRepo } = build();

    await svc.pruneOldSnapshots();

    const cutoff: Date = snapshotRepo.query.mock.calls[0][1][0];
    const days = (Date.now() - cutoff.getTime()) / 86400_000;
    expect(days).toBeGreaterThan(360);
    expect(days).toBeLessThan(370);
  });

  it("releases the lock even when the delete throws", async () => {
    const { svc, snapshotRepo, redis } = build();
    snapshotRepo.query.mockRejectedValue(new Error("statement timeout"));

    await expect(svc.pruneOldSnapshots()).resolves.toBeUndefined();

    expect(redis.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the cron lock is held", async () => {
    const { svc, snapshotRepo } = build(null);

    await svc.pruneOldSnapshots();

    expect(snapshotRepo.query).not.toHaveBeenCalled();
  });
});

describe("FreeCallsService read paths", () => {
  function build(rows: any[] = []) {
    const captured: any = {};
    const callRepo: any = {
      find: jest.fn(async (args: any) => {
        captured.find = args;
        return rows;
      }),
      findOne: jest.fn(async (args: any) => {
        captured.findOne = args;
        return rows[0] ?? null;
      }),
    };
    const svc = new FreeCallsService(
      callRepo,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { svc, captured, callRepo };
  }

  it("returns a user's calls newest first with the market attached", async () => {
    const { svc, captured } = build([{ id: "fc1" }]);

    await svc.listMine("u1");

    expect(captured.find.where).toEqual({ userId: "u1" });
    expect(captured.find.order).toEqual({ calledAt: "DESC" });
    // The client renders the question, so the relations must come along.
    expect(captured.find.relations).toContain("market");
    expect(captured.find.relations).toContain("outcome");
  });

  it("clamps the page size in both directions", async () => {
    const big = build();
    await big.svc.listMine("u1", 10_000);
    expect(big.captured.find.take).toBe(200);

    const small = build();
    await small.svc.listMine("u1", -5);
    expect(small.captured.find.take).toBe(1);

    const dflt = build();
    await dflt.svc.listMine("u1");
    expect(dflt.captured.find.take).toBe(50);
  });

  it("scopes a per-market lookup to the calling user", async () => {
    const { svc, captured } = build();

    await svc.findMineForMarket("u1", "m1");

    // Never just by marketId — that would leak another user's call.
    expect(captured.findOne.where).toEqual({ userId: "u1", marketId: "m1" });
  });

  it("returns null rather than throwing when the user has not called", async () => {
    const { svc } = build([]);

    await expect(svc.findMineForMarket("u1", "m1")).resolves.toBeNull();
  });
});

describe("SuggestionsService.listQueued", () => {
  function build(rows: any[]) {
    const captured: any = {};
    const suggestionRepo: any = {
      find: jest.fn(async (args: any) => {
        captured.args = args;
        return rows;
      }),
    };
    const svc = new SuggestionsService(
      suggestionRepo,
      {} as any,
      {} as any,
      {} as any,
      { get: jest.fn() } as any,
      {} as any,
      {} as any,
    );
    return { svc, captured };
  }

  it("lists only queued questions, most-wanted first", async () => {
    const { svc, captured } = build([]);

    await svc.listQueued();

    expect(captured.args.where).toEqual({ status: SuggestionStatus.QUEUED });
    expect(captured.args.order).toEqual({
      voteCount: "DESC",
      promotedAt: "ASC",
    });
  });

  it("exposes only public fields — no proposer identity", async () => {
    const { svc } = build([
      {
        id: "s1",
        title: "Will the peg hold?",
        description: "INR parity",
        category: "economy",
        voteCount: 31,
        promotedAt: new Date("2026-09-01T00:00:00Z"),
        status: SuggestionStatus.QUEUED,
        userId: "u-secret",
        reviewedByTelegramId: "12345",
      },
    ]);

    const rows = await svc.listQueued();

    expect(rows[0]).toEqual({
      id: "s1",
      title: "Will the peg hold?",
      description: "INR parity",
      category: "economy",
      votes: 31,
      promotedAt: new Date("2026-09-01T00:00:00Z"),
    });
    // This endpoint is public; the proposer and the reviewer must not ride along.
    expect(rows[0]).not.toHaveProperty("userId");
    expect(rows[0]).not.toHaveProperty("reviewedByTelegramId");
  });

  it("clamps the page size", async () => {
    const big = build([]);
    await big.svc.listQueued(500);
    expect(big.captured.args.take).toBe(100);

    const dflt = build([]);
    await dflt.svc.listQueued();
    expect(dflt.captured.args.take).toBe(20);
  });
});
