import { UnauthorizedException } from "@nestjs/common";
import { Pay21WebhookGuard } from "../payment/guards/pay21-webhook.guard";
import {
  readWebhookRejections,
  recordWebhookRejection,
} from "../payment/guards/pay21-webhook-health";

/**
 * The guard decides whether real money moves. Counting rejections for the
 * admin page must never be able to change that decision — in either direction.
 */
describe("Pay21WebhookGuard rejection counting", () => {
  const ctx = (rawBody = Buffer.from("{}")) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ headers: {}, rawBody }) }),
    }) as any;

  function fakeRedis() {
    const store = new Map<string, string>();
    const client = {
      incr: jest.fn(async (k: string) => {
        const n = Number(store.get(k) ?? 0) + 1;
        store.set(k, String(n));
        return n;
      }),
      expire: jest.fn(async () => 1),
      set: jest.fn(async (k: string, v: string) => {
        store.set(k, v);
        return "OK";
      }),
      get: jest.fn(async (k: string) => store.get(k) ?? null),
      mget: jest.fn(async (...ks: string[]) => ks.map((k) => store.get(k) ?? null)),
    };
    return { redis: { redis: client } as any, client };
  }

  it("still rejects an invalid webhook, and counts it", async () => {
    const { redis, client } = fakeRedis();
    const guard = new Pay21WebhookGuard({ verifyWebhook: () => false } as any, redis);

    expect(() => guard.canActivate(ctx())).toThrow(UnauthorizedException);
    await new Promise((r) => setImmediate(r));

    expect(client.incr).toHaveBeenCalledTimes(1);
    expect((await readWebhookRejections(redis)).today).toBe(1);
  });

  it("does not count, or touch Redis at all, on an accepted webhook", () => {
    const { redis, client } = fakeRedis();
    const guard = new Pay21WebhookGuard({ verifyWebhook: () => true } as any, redis);

    expect(guard.canActivate(ctx())).toBe(true);
    expect(client.incr).not.toHaveBeenCalled();
  });

  /** A Redis outage must not turn a rejection into an acceptance, or crash. */
  it("still rejects when Redis is failing", async () => {
    const { redis, client } = fakeRedis();
    client.incr.mockRejectedValue(new Error("redis down"));
    const guard = new Pay21WebhookGuard({ verifyWebhook: () => false } as any, redis);

    expect(() => guard.canActivate(ctx())).toThrow(UnauthorizedException);
    await new Promise((r) => setImmediate(r));
  });

  it("still rejects with no Redis provided at all", () => {
    const guard = new Pay21WebhookGuard({ verifyWebhook: () => false } as any);
    expect(() => guard.canActivate(ctx())).toThrow(UnauthorizedException);
  });

  it("sums a week of daily counters and remembers the last rejection", async () => {
    const { redis } = fakeRedis();
    const now = new Date("2026-10-06T12:00:00Z");
    const yesterday = new Date("2026-10-05T12:00:00Z");
    await recordWebhookRejection(redis, yesterday);
    await recordWebhookRejection(redis, now);
    await recordWebhookRejection(redis, now);

    const r = await readWebhookRejections(redis, now);
    expect(r).toEqual({ today: 2, last7Days: 3, lastRejectedAt: now.toISOString() });
  });
});
