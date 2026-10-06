import { JobHealthService, JOBS } from "../job-health/job-health.service";

/**
 * Job health is observability only. It must never change what a job does,
 * and its verdicts must be right about the cases that matter: failing,
 * stopped, and switched off on purpose.
 */
describe("JobHealthService", () => {
  function fakeRedis() {
    const hashes = new Map<string, Record<string, string>>();
    const client = {
      hset: jest.fn(async (k: string, f: Record<string, string>) => {
        hashes.set(k, { ...(hashes.get(k) ?? {}), ...f });
        return 1;
      }),
      expire: jest.fn(async () => 1),
      hgetall: jest.fn(async (k: string) => hashes.get(k) ?? {}),
    };
    return { redis: { redis: client } as any, client };
  }
  const flush = () => new Promise((r) => setImmediate(r));

  describe("track", () => {
    it("returns the job's own result", async () => {
      const svc = new JobHealthService(fakeRedis().redis);
      await expect(svc.track("auto-resolve", async () => 42)).resolves.toBe(42);
    });

    it("rethrows the job's own error unchanged", async () => {
      const svc = new JobHealthService(fakeRedis().redis);
      const boom = new Error("boom");
      await expect(
        svc.track("auto-resolve", async () => {
          throw boom;
        }),
      ).rejects.toBe(boom);
    });

    /** A Redis outage must not fail a job that itself succeeded. */
    it("does not fail a successful job when Redis is down", async () => {
      const { redis, client } = fakeRedis();
      client.hset.mockRejectedValue(new Error("redis down"));
      const svc = new JobHealthService(redis);
      await expect(svc.track("auto-resolve", async () => "ok")).resolves.toBe("ok");
      await flush();
    });

    it("works with no Redis at all", async () => {
      const svc = new JobHealthService();
      await expect(svc.track("auto-resolve", async () => 1)).resolves.toBe(1);
      expect(await svc.snapshot()).toHaveLength(Object.keys(JOBS).length);
    });
  });

  describe("snapshot verdicts", () => {
    const status = async (setup: (svc: JobHealthService, t0: number) => void, at: number) => {
      const { redis } = fakeRedis();
      const svc = new JobHealthService(redis);
      const t0 = Date.parse("2026-10-06T00:00:00Z");
      setup(svc, t0);
      await flush();
      return (await svc.snapshot(t0 + at)).find((j) => j.key === "auto-resolve")!;
    };

    it("ok shortly after a success", async () => {
      expect((await status((s, t) => s.ok("auto-resolve", t), 60_000)).status).toBe("ok");
    });

    it("never when nothing has been recorded", async () => {
      expect((await status(() => undefined, 0)).status).toBe("never");
    });

    it("stale once a success is older than the job's threshold", async () => {
      const r = await status((s, t) => s.ok("auto-resolve", t), JOBS["auto-resolve"].staleAfterMs + 1);
      expect(r.status).toBe("stale");
    });

    it("failing when the latest outcome is a failure, with the message", async () => {
      const r = await status((s, t) => {
        s.ok("auto-resolve", t);
        s.fail("auto-resolve", new Error("db gone"), t + 1000);
      }, 2000);
      expect(r.status).toBe("failing");
      expect(r.lastError).toBe("db gone");
    });

    it("recovers to ok on the first success after a failure", async () => {
      const r = await status((s, t) => {
        s.fail("auto-resolve", new Error("x"), t);
        s.ok("auto-resolve", t + 1000);
      }, 2000);
      expect(r.status).toBe("ok");
    });

    it("disabled — not stale — when deliberately switched off", async () => {
      const r = await status((s, t) => s.skip("auto-resolve", "USDT disabled", t), 1000);
      expect(r.status).toBe("disabled");
      expect(r.lastSkipReason).toBe("USDT disabled");
    });
  });

  /** The TER/BTC loops tick every 3s; recording each tick would be pure noise. */
  it("debounces repeated successes to one write per 30s", async () => {
    const { redis, client } = fakeRedis();
    const svc = new JobHealthService(redis);
    const t0 = Date.parse("2026-10-06T00:00:00Z");
    for (let i = 0; i < 10; i++) svc.ok("ter-rounds", t0 + i * 3000);
    await flush();
    expect(client.hset).toHaveBeenCalledTimes(1);
  });
});
