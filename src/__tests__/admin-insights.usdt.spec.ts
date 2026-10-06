import { AdminInsightsController } from "../admin/admin-insights.controller";

describe("AdminInsightsController — USDT", () => {
  describe("usdtDeposits", () => {
    function run(status?: string) {
      const query = jest
        .fn()
        .mockResolvedValueOnce([{ id: "i1", amountUsdt: "25.5", detectedAmountUsdt: null, status: "confirmed" }])
        .mockResolvedValueOnce([{ status: "confirmed", count: 3 }])
        .mockResolvedValueOnce([{ count: 2, amount: "40" }]);
      const ctrl = new AdminInsightsController({ query } as any);
      return { promise: ctrl.usdtDeposits("50", status), query };
    }

    /** Money the chain confirmed but nobody credited — the alarm figure. */
    it("reports confirmed-but-uncredited deposits", async () => {
      const { promise } = run();
      const out = await promise;
      expect(out.uncredited).toEqual({ count: 2, amountUsdt: 40 });
      expect(out.deposits[0].amountUsdt).toBe(25.5);
    });

    it("ignores a status filter that is not a real intent status", async () => {
      const { promise, query } = run("'; drop table users; --");
      await promise;
      expect(query.mock.calls[0][1]).toEqual([50, null]);
    });

    it("passes a real status through as a parameter", async () => {
      const { promise, query } = run("expired");
      await promise;
      expect(query.mock.calls[0][1]).toEqual([50, "expired"]);
    });
  });

  describe("pay21Webhooks", () => {
    function run(env: Record<string, string | undefined>, redisCounts: (string | null)[] = []) {
      const query = jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ lastReceivedAt: null, received7d: 0, failed7d: 0, unprocessed: 0 }]);
      const config = { get: (k: string) => env[k] };
      const redis = {
        redis: {
          mget: jest.fn(async () => [...redisCounts, ...Array(7).fill(null)].slice(0, 7)),
          get: jest.fn(async () => null),
        },
      };
      return new AdminInsightsController({ query } as any, config as any, redis as any).pay21Webhooks();
    }

    /**
     * The production failure this exists to catch: the deploy renamed the
     * secret, the code still reads TWENTYONE_PAY_WEBHOOK_SECRET, so it is
     * unset — and the accepted-events table just looks quiet.
     */
    it("reports the secret as missing when only the renamed variable is set", async () => {
      const out = await run({ USDT_ENABLED: "true", TWENTYONE_PAY_WEBHOOK: "x" });
      expect(out.health.usdtEnabled).toBe(true);
      expect(out.health.secretConfigured).toBe(false);
    });

    it("reports it as configured under the name the code reads", async () => {
      const out = await run({ TWENTYONE_PAY_WEBHOOK_SECRET: "x" });
      expect(out.health.secretConfigured).toBe(true);
    });

    it("never returns the secret's value", async () => {
      const out = await run({ TWENTYONE_PAY_WEBHOOK_SECRET: "super-secret-value" });
      expect(JSON.stringify(out)).not.toContain("super-secret-value");
    });

    it("surfaces rejections the events table cannot see", async () => {
      const out = await run({}, ["12", "30"]);
      expect(out.health.rejectedToday).toBe(12);
      expect(out.health.rejected7d).toBe(42);
    });
  });
});
