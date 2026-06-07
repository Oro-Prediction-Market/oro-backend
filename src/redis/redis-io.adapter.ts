import { INestApplicationContext, Logger } from "@nestjs/common";
import { IoAdapter } from "@nestjs/platform-socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import type { ServerOptions } from "socket.io";
import { RedisService } from "./redis.service";

/**
 * socket.io adapter backed by Redis pub/sub so `market_updated` (and any other
 * broadcast) reaches clients connected to ALL backend pods, not just the local one.
 * Required once the backend runs >1 replica.
 *
 * Defensive by design: if Redis is unreachable at boot, we log and fall back to the
 * default in-memory adapter — the app still starts and serves HTTP + single-pod WS.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger("RedisIoAdapter");
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  constructor(app: INestApplicationContext) {
    super(app);
  }

  async connectToRedis(redis: RedisService): Promise<void> {
    try {
      // Dedicated pub/sub pair from the shared RedisService — must NOT share the
      // app's cache/lock client (a subscriber connection can't run normal commands).
      const pubClient = redis.createConnection();
      const subClient = pubClient.duplicate();
      pubClient.on("error", (e) => this.logger.error(`pub error: ${e.message}`));
      subClient.on("error", (e) => this.logger.error(`sub error: ${e.message}`));
      this.adapterConstructor = createAdapter(pubClient, subClient);
      this.logger.log("Redis pub/sub clients created for socket.io adapter");
    } catch (e) {
      this.logger.error(
        `Failed to set up Redis socket.io adapter (${(e as Error).message}); ` +
          `falling back to in-memory adapter`,
      );
    }
  }

  createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
      this.logger.log("socket.io Redis adapter ENABLED (cross-pod broadcasts)");
    } else {
      this.logger.warn("socket.io using in-memory adapter (single-pod only)");
    }
    return server;
  }
}
