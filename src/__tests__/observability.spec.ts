import {
  BUCKET_EDGES_MS,
  OVERFLOW_BUCKET,
  bucketFor,
  emptyHistogram,
  merge,
  percentile,
  record,
  summarize,
} from "../observability/latency-histogram";
import {
  PerfRecorderService,
  fromHashes,
  minuteKey,
  toFlushArgs,
} from "../observability/perf-recorder.service";
import {
  RequestTimingMiddleware,
  routeKey,
} from "../observability/request-timing.middleware";
import { SlowQueryLogger } from "../observability/slow-query.logger";
import { Logger } from "@nestjs/common";
import { EventEmitter } from "events";

afterEach(() => jest.restoreAllMocks());

describe("latency histogram", () => {
  it("puts a value in the first bucket whose edge it does not exceed", () => {
    expect(bucketFor(0)).toBe(0);
    expect(bucketFor(10)).toBe(0);
    expect(bucketFor(10.1)).toBe(1);
    expect(bucketFor(10_000)).toBe(BUCKET_EDGES_MS.length - 1);
    expect(bucketFor(10_001)).toBe(OVERFLOW_BUCKET);
  });

  it("reads percentiles as bucket upper edges", () => {
    const h = emptyHistogram();
    for (let i = 0; i < 90; i++) record(h, 20); // bucket ≤25
    for (let i = 0; i < 10; i++) record(h, 400); // bucket ≤500
    expect(percentile(h, 50)).toBe(25);
    expect(percentile(h, 90)).toBe(25);
    expect(percentile(h, 95)).toBe(500);
    expect(summarize("GET /x", h)).toMatchObject({
      count: 100,
      avgMs: 58,
      maxMs: 400,
    });
  });

  it("reports the observed max for the overflow bucket", () => {
    const h = emptyHistogram();
    record(h, 12_345);
    expect(percentile(h, 99)).toBe(12_345);
  });

  it("merges by adding counts and keeping the larger max", () => {
    const a = emptyHistogram();
    const b = emptyHistogram();
    record(a, 5);
    record(b, 700);
    record(b, 800);
    merge(a, b);
    expect(a.count).toBe(3);
    expect(a.maxMs).toBe(800);
    expect(percentile(a, 100)).toBe(1_000);
  });

  it("returns zeros for an empty histogram", () => {
    expect(summarize("GET /x", emptyHistogram())).toMatchObject({
      count: 0,
      avgMs: 0,
      p95Ms: 0,
    });
  });
});

describe("perf storage round trip", () => {
  it("names minute keys in UTC to the minute", () => {
    expect(minuteKey(new Date("2026-10-13T09:41:59.999Z"))).toBe(
      "oro:perf:202610130941",
    );
  });

  it("rebuilds the same per-route histograms it flattened, across minutes", () => {
    const h = emptyHistogram();
    record(h, 30);
    record(h, 3_000);
    const args = toFlushArgs(new Map([["GET /api/markets", h]]));
    const hash: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 2) hash[args[i]] = args[i + 1];

    const merged = fromHashes([hash, hash, null]).get("GET /api/markets")!;
    expect(merged.count).toBe(4);
    expect(merged.maxMs).toBe(3_000);
    expect(merged.sumMs).toBe(2 * 3_030);
    expect(percentile(merged, 50)).toBe(50);
    expect(percentile(merged, 95)).toBe(5_000);
  });

  it("ignores fields it does not recognise", () => {
    const out = fromHashes([
      { junk: "4", "GET /a\tnope": "3", "GET /a\t99": "1" },
    ]);
    expect(out.get("GET /a")?.count ?? 0).toBe(0);
  });
});

describe("PerfRecorderService", () => {
  const config = (vals: Record<string, string> = {}) =>
    ({ get: (k: string, d?: unknown) => vals[k] ?? d }) as any;

  it("records nothing when PERF_TIMING=off", async () => {
    const svc = new PerfRecorderService(
      config({ PERF_TIMING: "off" }),
      {} as any,
      {} as any,
    );
    svc.record("GET /a", 5, 200);
    expect(svc.enabled).toBe(false);
  });

  it("flushes counts to Redis and swallows Redis failures", async () => {
    const evalFn = jest.fn().mockRejectedValue(new Error("down"));
    const svc = new PerfRecorderService(
      config(),
      { redis: { eval: evalFn } } as any,
      {
        driver: { master: { totalCount: 15, idleCount: 2, waitingCount: 7 } },
      } as any,
    );
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    svc.record("GET /a", 5, 200);
    await expect(
      svc.flush(new Date("2026-10-13T09:42:00.200Z")),
    ).resolves.toBeUndefined();
    expect(evalFn).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "oro:perf:202610130941",
      String(24 * 60 * 60),
      "GET /a\t0",
      "1",
      "GET /a\tsum",
      "5",
      "GET /a\tmax",
      "5",
    );
    expect(svc.poolStats()).toEqual({ total: 15, idle: 2, waiting: 7 });
  });

  it("logs a slow request immediately", () => {
    const warn = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
    const svc = new PerfRecorderService(
      config({ SLOW_REQUEST_MS: "100" }),
      {} as any,
      {} as any,
    );
    svc.record("GET /slow", 150, 200);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("GET /slow 150ms"),
    );
  });
});

describe("RequestTimingMiddleware", () => {
  function run(contentType?: string) {
    const perf = { enabled: true, record: jest.fn() } as any;
    const res = Object.assign(new EventEmitter(), {
      statusCode: 201,
      getHeader: () => contentType,
    });
    const req = {
      method: "POST",
      baseUrl: "",
      route: { path: "/api/markets/:id/bet" },
    };
    const next = jest.fn();
    new RequestTimingMiddleware(perf).use(req, res, next);
    expect(next).toHaveBeenCalled();
    res.emit("finish");
    return perf.record as jest.Mock;
  }

  it("keys by method and route template", () => {
    expect(run("application/json")).toHaveBeenCalledWith(
      "POST /api/markets/:id/bet",
      expect.any(Number),
      201,
    );
  });

  it("skips server-sent event streams", () => {
    expect(run("text/event-stream")).not.toHaveBeenCalled();
  });

  it("labels requests no route matched", () => {
    expect(routeKey({ method: "GET" })).toBe("GET (unmatched)");
  });
});

describe("SlowQueryLogger", () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it("logs slow SQL and time but never the parameters", () => {
    const logger = new SlowQueryLogger() as any;
    logger.logQuerySlow(812.4, 'SELECT *\n  FROM users WHERE "dkCid" = $1', [
      "11510000123",
    ]);
    const line = warn.mock.calls[0][0] as string;
    expect(line).toBe('812ms SELECT * FROM users WHERE "dkCid" = $1');
    expect(line).not.toContain("11510000123");
  });

  it("clips very long SQL", () => {
    new SlowQueryLogger().logQuerySlow(600, "SELECT " + "x,".repeat(1000));
    expect((warn.mock.calls[0][0] as string).length).toBeLessThan(520);
  });

  it("reports statement timeouts and ignores other errors", () => {
    const logger = new SlowQueryLogger();
    logger.logQueryError("duplicate key value", "INSERT ...");
    expect(warn).not.toHaveBeenCalled();
    logger.logQueryError(
      new Error("canceling statement due to statement timeout"),
      "SELECT 1",
    );
    expect(warn).toHaveBeenCalledWith("timeout SELECT 1");
  });
});
