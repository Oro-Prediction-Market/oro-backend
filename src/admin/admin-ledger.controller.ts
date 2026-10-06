import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Optional,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { JwtAuthGuard, AdminGuard } from "../auth/guards";
import { AuditService } from "./audit.service";
import { RedisService } from "../redis/redis.service";
import { AuditAction } from "../entities/audit-log.entity";
import { rebuildRunningBalances } from "../shared/utils/ledger.util";

const CURRENCIES = new Set(["BTN", "USDT"]);

/**
 * Below this, a stored running balance and the ledger sum are the same number.
 * `transactions` stores nine decimal places, so arithmetic done in JS before a
 * row is written leaves noise far below a chhertum or a micro-USDT.
 */
const TOLERANCE_SQL = `CASE WHEN s.currency = 'USDT' THEN 0.0000005 ELSE 0.005 END`;

const LIST_LIMIT = 200;

/**
 * Is every wallet's money where the app says it is?
 *
 * A wallet's balance is not stored: the app shows SUM(transactions.amount)
 * for the user and currency. Each row also stores the running balance at the
 * time it was written (`balanceBefore`/`balanceAfter`), and that is the figure
 * the transaction history prints beside each line. A correction made directly
 * in the database — inserting, deleting or backdating a row — leaves those
 * running figures stale, and nothing noticed: after the September corrections
 * this was checked by hand with a query.
 *
 * Two problems are reported:
 *  - overdrawn: the wallet sums below zero. Money was spent that was never
 *    there. This one is about money.
 *  - stale history: the newest row's stored balance disagrees with the sum.
 *    The spendable balance is still right (it is the sum); the history the
 *    user scrolls through shows wrong running totals. Display only.
 *
 * The one write here rebuilds a wallet's running figures from its own rows.
 * It never changes an amount, so it cannot move money.
 */
@ApiTags("admin")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller("admin/ledger")
export class AdminLedgerController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  @Get("health")
  @ApiOperation({
    summary:
      "Wallets that are overdrawn, or whose stored running balance disagrees with the ledger sum",
  })
  async health() {
    // One pass over the ledger: each wallet's sum, and whether ANY row at its
    // newest timestamp carries that sum as its balanceAfter. "Any", because a
    // settlement writes a payout and a streak bonus in one transaction with
    // one now(), and only the later of the two ends on the full balance.
    const rows: any[] = await this.dataSource.query(
      `WITH sums AS (
         SELECT t."userId", t.currency,
                SUM(t.amount)      AS balance,
                MAX(t."createdAt") AS "lastAt",
                COUNT(*)::int      AS rows
           FROM transactions t
          GROUP BY t."userId", t.currency
       ),
       tail AS (
         SELECT s."userId", s.currency, s.balance, s."lastAt", s.rows,
                bool_or(ABS(t."balanceAfter" - s.balance) < ${TOLERANCE_SQL}) AS "tailOk",
                MAX(t."balanceAfter") AS "shownBalance"
           FROM sums s
           JOIN transactions t
             ON t."userId" = s."userId"
            AND t.currency = s.currency
            AND t."createdAt" = s."lastAt"
          GROUP BY s."userId", s.currency, s.balance, s."lastAt", s.rows
       )
       SELECT tail."userId", tail.currency, tail.balance, tail."shownBalance",
              tail."lastAt", tail.rows,
              (tail.balance < 0)   AS overdrawn,
              (NOT tail."tailOk")  AS "staleHistory",
              u.username, u."firstName"
         FROM tail
         JOIN users u ON u.id = tail."userId"
        WHERE tail.balance < 0 OR NOT tail."tailOk"
        ORDER BY (tail.balance < 0) DESC, tail."lastAt" DESC`,
    );

    const num = (v: unknown) => Number(v) || 0;
    const wallets = rows.map((r) => ({
      userId: r.userId,
      username: r.username ?? null,
      firstName: r.firstName ?? null,
      currency: r.currency,
      balance: num(r.balance),
      shownBalance: num(r.shownBalance),
      difference: num(r.balance) - num(r.shownBalance),
      rows: num(r.rows),
      lastAt: r.lastAt,
      overdrawn: !!r.overdrawn,
      staleHistory: !!r.staleHistory,
    }));

    return {
      checkedAt: new Date().toISOString(),
      overdrawn: wallets.filter((w) => w.overdrawn).length,
      staleHistory: wallets.filter((w) => w.staleHistory).length,
      wallets: wallets.slice(0, LIST_LIMIT),
      truncated: wallets.length > LIST_LIMIT,
    };
  }

  @Post("rebuild/:userId")
  @HttpCode(200)
  @ApiOperation({
    summary:
      "Recompute one wallet's stored running balances from its own rows (no amount changes)",
  })
  async rebuild(
    @Param("userId", ParseUUIDPipe) userId: string,
    @Query("currency") currency: string,
    @Request() req: any,
  ) {
    if (!CURRENCIES.has(currency)) {
      throw new BadRequestException("currency must be BTN or USDT");
    }

    const result = await this.dataSource.transaction(async (em) => {
      // Same first lock as every ledger writer, so a bet or payout landing
      // mid-rebuild waits rather than reading half-updated running figures.
      const user = await em.query(
        `SELECT id FROM users WHERE id = $1 FOR UPDATE`,
        [userId],
      );
      if (!user.length) throw new NotFoundException("User not found");

      const rowsUpdated = await rebuildRunningBalances(em, userId, currency);

      const [{ balance }] = await em.query(
        `SELECT COALESCE(SUM(amount), 0) AS balance
           FROM transactions WHERE "userId" = $1 AND currency = $2`,
        [userId, currency],
      );
      return { rowsUpdated, balance: Number(balance) };
    });

    // The balance itself did not change, but the history endpoint may be
    // cached alongside it; clearing is cheap and removes the question.
    await this.redis?.del(`oro:cache:balance:${userId}`).catch(() => undefined);

    await this.audit.log({
      adminId: req.user.userId,
      isAdmin: true,
      action: AuditAction.LEDGER_REBUILD,
      entityType: "user",
      entityId: userId,
      after: { currency, ...result },
      ipAddress: req.ip,
    });

    return { userId, currency, ...result };
  }
}
