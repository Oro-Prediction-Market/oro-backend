/**
 * Tests for RedisService — get/set, rate limiting, and distributed locks.
 * All tests mock the ioredis client directly.
 */
import { RedisService } from "../redis/redis.service";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRedisClient(overrides: any = {}) {
  return {
    get: jest.fn().mockResolvedValue(null),
    setex: jest.fn().mockResolvedValue("OK"),
    del: jest.fn().mockResolvedValue(1),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    set: jest.fn().mockResolvedValue("OK"),
    eval: jest.fn().mockResolvedValue(1),
    disconnect: jest.fn(),
    on: jest.fn(),
    ...overrides,
  };
}

function makeService(clientOverrides: any = {}) {
  const config = { get: jest.fn().mockReturnValue("redis://localhost:6379") };
  const svc = new RedisService(config as any);
  // Inject mock client directly
  (svc as any).client = makeRedisClient(clientOverrides);
  return { svc, client: (svc as any).client as ReturnType<typeof makeRedisClient> };
}

// ── get ───────────────────────────────────────────────────────────────────────

describe("RedisService.get", () => {
  it("returns value from Redis", async () => {
    const { svc, client } = makeService();
    client.get.mockResolvedValue("hello");

    const result = await svc.get("mykey");

    expect(result).toBe("hello");
    expect(client.get).toHaveBeenCalledWith("mykey");
  });

  it("returns null when key does not exist", async () => {
    const { svc, client } = makeService();
    client.get.mockResolvedValue(null);

    const result = await svc.get("missing");

    expect(result).toBeNull();
  });

  it("returns null when Redis throws (graceful degradation)", async () => {
    const { svc, client } = makeService();
    client.get.mockRejectedValue(new Error("Redis connection error"));

    const result = await svc.get("mykey");

    expect(result).toBeNull();
  });
});

// ── getJson ───────────────────────────────────────────────────────────────────

describe("RedisService.getJson", () => {
  it("parses JSON value from Redis", async () => {
    const { svc, client } = makeService();
    client.get.mockResolvedValue(JSON.stringify({ foo: "bar" }));

    const result = await svc.getJson<{ foo: string }>("mykey");

    expect(result).toEqual({ foo: "bar" });
  });

  it("returns null when key not found", async () => {
    const { svc, client } = makeService();
    client.get.mockResolvedValue(null);

    const result = await svc.getJson("missing");

    expect(result).toBeNull();
  });

  it("returns null for malformed JSON (parse error)", async () => {
    const { svc, client } = makeService();
    client.get.mockResolvedValue("not-valid-json{{");

    const result = await svc.getJson("badkey");

    expect(result).toBeNull();
  });
});

// ── setEx ─────────────────────────────────────────────────────────────────────

describe("RedisService.setEx", () => {
  it("calls setex with the correct arguments", async () => {
    const { svc, client } = makeService();

    await svc.setEx("mykey", 60, "myvalue");

    expect(client.setex).toHaveBeenCalledWith("mykey", 60, "myvalue");
  });

  it("does not throw when Redis fails", async () => {
    const { svc, client } = makeService();
    client.setex.mockRejectedValue(new Error("Redis error"));

    await expect(svc.setEx("mykey", 60, "value")).resolves.not.toThrow();
  });
});

// ── setJsonEx ─────────────────────────────────────────────────────────────────

describe("RedisService.setJsonEx", () => {
  it("serializes value to JSON before storing", async () => {
    const { svc, client } = makeService();

    await svc.setJsonEx("mykey", 120, { count: 42 });

    expect(client.setex).toHaveBeenCalledWith("mykey", 120, '{"count":42}');
  });
});

// ── del ───────────────────────────────────────────────────────────────────────

describe("RedisService.del", () => {
  it("deletes specified keys", async () => {
    const { svc, client } = makeService();

    await svc.del("key1", "key2");

    expect(client.del).toHaveBeenCalledWith("key1", "key2");
  });

  it("does not call del when no keys provided", async () => {
    const { svc, client } = makeService();

    await svc.del();

    expect(client.del).not.toHaveBeenCalled();
  });

  it("does not throw when Redis fails", async () => {
    const { svc, client } = makeService();
    client.del.mockRejectedValue(new Error("Redis error"));

    await expect(svc.del("key1")).resolves.not.toThrow();
  });
});

// ── rateLimit ─────────────────────────────────────────────────────────────────

describe("RedisService.rateLimit", () => {
  it("allows request when under the limit", async () => {
    const { svc, client } = makeService();
    client.incr.mockResolvedValue(1); // first request

    const result = await svc.rateLimit("user:1", 10, 60);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9); // 10 - 1 = 9
  });

  it("sets TTL on first request (count === 1)", async () => {
    const { svc, client } = makeService();
    client.incr.mockResolvedValue(1);

    await svc.rateLimit("user:1", 10, 60);

    expect(client.expire).toHaveBeenCalledWith(expect.any(String), 120); // windowSec * 2
  });

  it("does NOT set TTL on subsequent requests (count > 1)", async () => {
    const { svc, client } = makeService();
    client.incr.mockResolvedValue(5); // 5th request

    await svc.rateLimit("user:1", 10, 60);

    expect(client.expire).not.toHaveBeenCalled();
  });

  it("allows the last request exactly at the limit (count === max)", async () => {
    const { svc, client } = makeService();
    client.incr.mockResolvedValue(10); // exactly at limit

    const result = await svc.rateLimit("user:1", 10, 60);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it("blocks request when over the limit", async () => {
    const { svc, client } = makeService();
    client.incr.mockResolvedValue(15); // over limit

    const result = await svc.rateLimit("user:1", 10, 60);

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0); // clamps to 0, not negative
  });

  it("gracefully allows all requests when Redis throws", async () => {
    const { svc, client } = makeService();
    client.incr.mockRejectedValue(new Error("Redis down"));

    const result = await svc.rateLimit("user:1", 10, 60);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(10); // max
  });
});

// ── acquireLock ───────────────────────────────────────────────────────────────

describe("RedisService.acquireLock", () => {
  it("returns token when lock is acquired (Redis returns OK)", async () => {
    const { svc, client } = makeService();
    client.set.mockResolvedValue("OK");

    const token = await svc.acquireLock("my-resource", 30);

    expect(token).toBeTruthy();
    expect(typeof token).toBe("string");
    expect(client.set).toHaveBeenCalledWith(
      "oro:lock:my-resource",
      expect.any(String),
      "EX",
      30,
      "NX",
    );
  });

  it("returns null when lock is already held (Redis returns null)", async () => {
    const { svc, client } = makeService();
    client.set.mockResolvedValue(null); // lock contended

    const token = await svc.acquireLock("my-resource", 30);

    expect(token).toBeNull();
  });

  it("returns null when Redis throws (graceful degradation)", async () => {
    const { svc, client } = makeService();
    client.set.mockRejectedValue(new Error("Redis down"));

    const token = await svc.acquireLock("my-resource", 30);

    expect(token).toBeNull();
  });
});

// ── releaseLock ───────────────────────────────────────────────────────────────

describe("RedisService.releaseLock", () => {
  it("executes Lua script to release the lock atomically", async () => {
    const { svc, client } = makeService();

    await svc.releaseLock("my-resource", "my-token");

    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call"),
      1,
      "oro:lock:my-resource",
      "my-token",
    );
  });

  it("does not throw when Redis fails", async () => {
    const { svc, client } = makeService();
    client.eval.mockRejectedValue(new Error("Redis error"));

    await expect(svc.releaseLock("my-resource", "token")).resolves.not.toThrow();
  });
});

// ── acquireLockWithRetry ──────────────────────────────────────────────────────

describe("RedisService.acquireLockWithRetry", () => {
  it("returns token on first attempt when lock is free", async () => {
    const { svc, client } = makeService();
    client.set.mockResolvedValue("OK");

    const token = await svc.acquireLockWithRetry("res", 10);

    expect(token).toBeTruthy();
    expect(client.set).toHaveBeenCalledTimes(1);
  });

  it("returns null immediately when Redis is unavailable (throws)", async () => {
    const { svc, client } = makeService();
    client.set.mockRejectedValue(new Error("Connection refused"));

    const token = await svc.acquireLockWithRetry("res", 10, 3, 0);

    expect(token).toBeNull();
    // Should break on first error (no retry when Redis is down)
    expect(client.set).toHaveBeenCalledTimes(1);
  });

  it("throws LOCK_CONTENDED when Redis is up but lock held after all retries", async () => {
    const { svc, client } = makeService();
    client.set.mockResolvedValue(null); // lock always contended

    await expect(
      svc.acquireLockWithRetry("res", 10, 3, 0), // 3 retries, 0 delay
    ).rejects.toThrow("LOCK_CONTENDED");

    expect(client.set).toHaveBeenCalledTimes(3);
  });

  it("succeeds on retry when lock becomes free on second attempt", async () => {
    const { svc, client } = makeService();
    client.set
      .mockResolvedValueOnce(null) // first attempt: contended
      .mockResolvedValueOnce("OK"); // second attempt: acquired

    const token = await svc.acquireLockWithRetry("res", 10, 3, 0);

    expect(token).toBeTruthy();
    expect(client.set).toHaveBeenCalledTimes(2);
  });
});
