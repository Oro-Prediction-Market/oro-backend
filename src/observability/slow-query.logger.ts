import { Logger as NestLogger } from "@nestjs/common";
import type { Logger as TypeOrmLogger } from "typeorm";

const MAX_SQL_CHARS = 500;

function clip(sql: string): string {
  const flat = sql.replace(/\s+/g, " ").trim();
  return flat.length > MAX_SQL_CHARS
    ? `${flat.slice(0, MAX_SQL_CHARS)}…`
    : flat;
}

/**
 * TypeORM logger that reports only slow and timed-out queries — the SQL text,
 * clipped, and how long it took. Never the parameters: they carry user ids,
 * KYC fields and amounts, and logs leave the cluster.
 *
 * Everything else stays silent, as with `logging: false`.
 */
export class SlowQueryLogger implements TypeOrmLogger {
  private readonly logger = new NestLogger("SlowQuery");

  logQuerySlow(time: number, query: string): void {
    this.logger.warn(`${Math.round(time)}ms ${clip(query)}`);
  }

  /**
   * Only statement timeouts: those are the slow queries that never finish, so
   * logQuerySlow never sees them. Other errors already surface to the caller.
   */
  logQueryError(error: string | Error, query: string): void {
    const message = typeof error === "string" ? error : (error?.message ?? "");
    if (/statement timeout|canceling statement/i.test(message)) {
      this.logger.warn(`timeout ${clip(query)}`);
    }
  }

  logQuery(): void {}
  logSchemaBuild(): void {}
  logMigration(): void {}
  log(): void {}
}
