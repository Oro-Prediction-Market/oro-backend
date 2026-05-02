import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const url = this.config.get<string>("REDIS_URL", "redis://localhost:6379");
    this.client = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: true });
    this.client.on("connect", () => this.logger.log("Redis connected"));
    this.client.on("error", (err) => this.logger.error(`Redis error: ${err.message}`));
  }

  onModuleDestroy() {
    this.client?.disconnect();
  }

  get redis(): Redis {
    return this.client;
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch {
      return null;
    }
  }

  async getJson<T>(key: string): Promise<T | null> {
    const val = await this.get(key);
    if (!val) return null;
    try {
      return JSON.parse(val) as T;
    } catch {
      return null;
    }
  }

  async setEx(key: string, ttlSeconds: number, value: string): Promise<void> {
    try {
      await this.client.setex(key, ttlSeconds, value);
    } catch {}
  }

  async setJsonEx<T>(key: string, ttlSeconds: number, value: T): Promise<void> {
    await this.setEx(key, ttlSeconds, JSON.stringify(value));
  }

  async del(...keys: string[]): Promise<void> {
    try {
      if (keys.length) await this.client.del(...keys);
    } catch {}
  }

  /**
   * Fixed-window rate limiter.
   * Returns { allowed: true } when under the limit, { allowed: false } when over.
   * Gracefully allows all requests if Redis is unavailable.
   */
  async rateLimit(
    key: string,
    max: number,
    windowSec: number,
  ): Promise<{ allowed: boolean; remaining: number }> {
    try {
      const windowKey = `oro:rate:${key}:${Math.floor(Date.now() / (windowSec * 1000))}`;
      const count = await this.client.incr(windowKey);
      if (count === 1) await this.client.expire(windowKey, windowSec * 2);
      return { allowed: count <= max, remaining: Math.max(0, max - count) };
    } catch {
      return { allowed: true, remaining: max };
    }
  }

  /**
   * Acquire a distributed lock using SET NX EX.
   * Returns a lock token string on success, null if the lock is held by another process.
   * Returns null on Redis failure (graceful degradation).
   */
  async acquireLock(resource: string, ttlSec: number): Promise<string | null> {
    try {
      const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const result = await this.client.set(
        `oro:lock:${resource}`,
        token,
        "EX",
        ttlSec,
        "NX",
      );
      return result === "OK" ? token : null;
    } catch {
      return null;
    }
  }

  /**
   * Release a lock only if the token matches (atomic via Lua).
   * Silently no-ops if the lock has already expired or belongs to another holder.
   */
  async releaseLock(resource: string, token: string): Promise<void> {
    try {
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      await this.client.eval(script, 1, `oro:lock:${resource}`, token);
    } catch {}
  }

  /**
   * Try to acquire a lock, retrying up to `retries` times with `delayMs` between attempts.
   * Returns the lock token, or null if Redis is down (caller should proceed without lock).
   * Throws if Redis is up but the lock is contended after all retries.
   */
  async acquireLockWithRetry(
    resource: string,
    ttlSec: number,
    retries = 3,
    delayMs = 150,
  ): Promise<string | null> {
    let redisAvailable = false;
    for (let i = 0; i < retries; i++) {
      try {
        const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const result = await this.client.set(
          `oro:lock:${resource}`,
          token,
          "EX",
          ttlSec,
          "NX",
        );
        if (result === "OK") return token;
        redisAvailable = true; // Redis responded; lock is just contended
      } catch {
        // Redis unavailable — break and signal graceful degradation
        return null;
      }
      if (i < retries - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
    if (redisAvailable) {
      // Redis is up but lock is held — tell the caller to retry
      throw new Error("LOCK_CONTENDED");
    }
    return null;
  }
}
