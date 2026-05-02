import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";
import { LessThan, Repository } from "typeorm";
import { Market, MarketStatus } from "../entities/market.entity";
import { Dispute } from "../entities/dispute.entity";
import { AuditLog, AuditAction, RoleType } from "../entities/audit-log.entity";
import { ParimutuelEngine } from "../markets/parimutuel.engine";
import { DataSource } from "typeorm";

/**
 * Auto-resolution cron job.
 *
 * Every 5 minutes: scan all RESOLVING markets whose objection window has expired.
 *
 * ─ Zero objections → auto-settle immediately using the proposed outcome.
 *   This is the happy path — admin proposes, no one objects, market settles
 *   automatically without any further admin action.
 *
 * ─ One or more objections → leave as RESOLVING. Admin must review the
 *   objections and manually call POST /admin/markets/:id/resolve.
 *   The admin portal will show a badge on disputed markets.
 */
@Injectable()
export class AutoResolveMarketsJob {
  private readonly logger = new Logger(AutoResolveMarketsJob.name);

  constructor(
    @InjectRepository(Market) private marketRepo: Repository<Market>,
    @InjectRepository(Dispute) private disputeRepo: Repository<Dispute>,
    @InjectRepository(AuditLog) private auditRepo: Repository<AuditLog>,
    private engine: ParimutuelEngine,
    @InjectDataSource() private dataSource: DataSource,
  ) {}

  /**
   * Runs every 5 minutes. Finds markets where:
   *   1. status = RESOLVING
   *   2. disputeDeadlineAt has passed
   *   3. zero objections filed
   *
   * For each such market, auto-resolves using proposedOutcomeId.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async autoResolveExpiredWindows(): Promise<void> {
    const now = new Date();

    // Find all RESOLVING markets whose window has closed
    const candidates = await this.marketRepo.find({
      where: {
        status: MarketStatus.RESOLVING,
        disputeDeadlineAt: LessThan(now),
      },
    });

    if (candidates.length === 0) return;

    this.logger.log(
      `[AutoResolve] ${candidates.length} market(s) with expired objection windows found`,
    );

    for (const market of candidates) {
      try {
        // Count objections
        const objectionCount = await this.disputeRepo.count({
          where: { marketId: market.id },
        });

        if (objectionCount > 0) {
          // Has unreviewed objections — skip; admin must review
          this.logger.log(
            `[AutoResolve] Skipping market ${market.id} ("${market.title}") — ` +
              `${objectionCount} objection(s) need admin review`,
          );
          continue;
        }

        if (!market.proposedOutcomeId) {
          this.logger.warn(
            `[AutoResolve] Market ${market.id} has no proposedOutcomeId — cannot auto-resolve`,
          );
          continue;
        }

        this.logger.log(
          `[AutoResolve] Auto-settling market ${market.id} ("${market.title}") ` +
            `→ outcome ${market.proposedOutcomeId} (0 objections, window expired)`,
        );

        // resolveMarket with special system adminId
        await this.engine.resolveMarket(
          market.id,
          market.proposedOutcomeId,
          "system:auto-resolve",
        );

        // Write an audit log entry so admins have full traceability
        const entry = this.auditRepo.create({
          adminId: "system",
          username: "auto-resolve-cron",
          roleType: RoleType.ADMIN,
          action: AuditAction.MARKET_AUTO_RESOLVED,
          entityType: "market",
          entityId: market.id,
          payload: {
            meta: {
              title: market.title,
              winningOutcomeId: market.proposedOutcomeId,
              objectionCount: 0,
              windowExpiredAt: market.disputeDeadlineAt,
            },
          },
        });
        await this.auditRepo
          .save(entry)
          .catch((err) =>
            this.logger.warn(
              `[AutoResolve] Failed to write audit log for market ${market.id}: ${err.message}`,
            ),
          );

        this.logger.log(
          `[AutoResolve] ✅ Market ${market.id} auto-settled successfully`,
        );
      } catch (err: any) {
        this.logger.error(
          `[AutoResolve] ❌ Failed to auto-resolve market ${market.id}: ${err.message}`,
          err.stack,
        );
        // Continue with next market — don't let one failure block the rest
      }
    }
  }
}
