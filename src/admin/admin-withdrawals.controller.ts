import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { JwtAuthGuard, AdminGuard } from "../auth/guards";
import { AuditService } from "./audit.service";
import { AuditAction } from "../entities/audit-log.entity";
import { DKWithdrawalReconciler } from "../payment/dk-withdrawal.reconciler";

export class ResolveWithdrawalDto {
  /** What DK's statement shows: the money reached the user's bank, or it did not. */
  @IsIn(["sent", "not_sent"])
  verdict!: "sent" | "not_sent";

  /** Why — e.g. "Not on DK statement for 20–24 Sep". Required: this is the record. */
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  note!: string;

  @IsOptional()
  @IsBoolean()
  notifyUser?: boolean;
}

/**
 * DK failure texts that do not actually say the transfer failed. A withdrawal
 * that failed with one of these was refunded, but DK may have paid it anyway —
 * which is exactly what happened with "Payment Engine transaction is
 * validating" in September. Worth a look against the statement.
 */
const UNCERTAIN_FAILURE =
  /validat|pending|process|timeout|timed out|ambiguous|threw|no response|internal/i;

const AGE_HOURS_SQL = `EXTRACT(EPOCH FROM (now() - p."createdAt")) / 3600`;

/**
 * Withdrawals a human has to look at.
 *
 * A DK withdrawal in PROCESSING has had the user's money taken out of their
 * wallet and DK has not said whether it arrived. The reconciler asks DK every
 * few minutes and finishes most of these on its own; the ones left are those
 * DK gave no handle for, or keeps answering ambiguously. In September four
 * users waited four days in that state because nothing showed them to anyone.
 */
@ApiTags("admin")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller("admin/withdrawals")
export class AdminWithdrawalsController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly reconciler: DKWithdrawalReconciler,
    private readonly audit: AuditService,
  ) {}

  @Get("attention")
  @ApiOperation({
    summary:
      "DK withdrawals holding user money with no outcome, and recent failures DK may have paid anyway",
  })
  async attention() {
    const processing: any[] = await this.dataSource.query(
      `SELECT p.id, p."userId", p.amount, p."createdAt", p."failureReason",
              ${AGE_HOURS_SQL} AS "ageHours",
              p.metadata::jsonb -> 'dkTransfer' ->> 'status'      AS "dkStatus",
              p.metadata::jsonb -> 'dkTransfer' ->> 'statusDesc'  AS "dkStatusDesc",
              p.metadata::jsonb ->> 'dkReconcileLastStatus'       AS "lastCheckStatus",
              p.metadata::jsonb ->> 'dkReconcileLastError'        AS "lastCheckError",
              (p.metadata::jsonb ->> 'dkReconcileCheckedAt')::bigint AS "lastCheckedAt",
              (p.metadata::jsonb ->> 'dkReconcileWarnedAt') IS NOT NULL AS "noHandle",
              p.metadata::jsonb ->> 'dkAccountNumber'             AS "accountNumber",
              u.username, u."firstName",
              -- The debit actually held for this withdrawal. Expected to equal
              -- the amount; anything else is worth knowing before deciding.
              (SELECT COALESCE(SUM(-t.amount), 0) FROM transactions t
                WHERE t."paymentId" = p.id AND t.type = 'withdrawal'
                  AND t.currency = 'BTN') AS held,
              (SELECT COUNT(*) FROM transactions t
                WHERE t."paymentId" = p.id AND t.type = 'refund'
                  AND t.currency = 'BTN')::int AS "refundRows"
         FROM payments p
         JOIN users u ON u.id = p."userId"
        WHERE p.type = 'withdrawal' AND p.method = 'dkbank'
          AND p.status = 'processing'
        ORDER BY p."createdAt" ASC`,
    );

    const failed: any[] = await this.dataSource.query(
      `SELECT p.id, p."userId", p.amount, p."createdAt", p."confirmedAt",
              p."failureReason",
              p.metadata::jsonb -> 'dkTransfer' ->> 'statusDesc' AS "dkStatusDesc",
              p.metadata::jsonb -> 'manualReconcile'              AS "manual",
              u.username, u."firstName"
         FROM payments p
         JOIN users u ON u.id = p."userId"
        WHERE p.type = 'withdrawal' AND p.method = 'dkbank'
          AND p.status = 'failed'
          AND p."createdAt" > now() - interval '30 days'
        ORDER BY p."createdAt" DESC
        LIMIT 200`,
    );

    const num = (v: unknown) => Number(v) || 0;
    const name = (r: any) => ({
      userId: r.userId,
      username: r.username ?? null,
      firstName: r.firstName ?? null,
    });

    return {
      processing: processing.map((r) => ({
        id: r.id,
        ...name(r),
        amount: num(r.amount),
        held: num(r.held),
        refundRows: num(r.refundRows),
        createdAt: r.createdAt,
        ageHours: Math.round(num(r.ageHours) * 10) / 10,
        reason: r.failureReason ?? r.dkStatusDesc ?? null,
        dkStatus: r.dkStatus ?? null,
        lastCheck: r.lastCheckedAt
          ? {
              at: new Date(num(r.lastCheckedAt)).toISOString(),
              status: r.lastCheckStatus ?? null,
              error: r.lastCheckError ?? null,
            }
          : null,
        // DK never gave an id to ask about, so the reconciler cannot finish
        // it — this one only closes by hand.
        noHandle: !!r.noHandle,
        accountLast4: r.accountNumber ? String(r.accountNumber).slice(-4) : null,
      })),
      failed: failed.map((r) => {
        const reason: string | null = r.failureReason ?? r.dkStatusDesc ?? null;
        return {
          id: r.id,
          ...name(r),
          amount: num(r.amount),
          createdAt: r.createdAt,
          closedAt: r.confirmedAt,
          reason,
          uncertain: !r.manual && !!reason && UNCERTAIN_FAILURE.test(reason),
          manual: r.manual ?? null,
        };
      }),
      totals: {
        processingCount: processing.length,
        processingHeld: processing.reduce((s, r) => s + num(r.held), 0),
        uncertainFailures: failed.filter(
          (r) =>
            !r.manual &&
            UNCERTAIN_FAILURE.test(r.failureReason ?? r.dkStatusDesc ?? ""),
        ).length,
      },
    };
  }

  @Post(":id/resolve")
  @HttpCode(200)
  @ApiOperation({
    summary:
      "Close a processing DK withdrawal from DK's statement: sent (debit stands) or not_sent (money returned)",
  })
  async resolve(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ResolveWithdrawalDto,
    @Request() req: any,
  ) {
    const note = dto.note.trim();
    const outcome = await this.reconciler.resolveManually(
      id,
      dto.verdict,
      { adminId: req.user.userId, note },
      dto.notifyUser === true,
    );

    await this.audit.log({
      adminId: req.user.userId,
      isAdmin: true,
      action: AuditAction.WITHDRAWAL_MANUAL_RESOLVE,
      entityType: "payment",
      entityId: id,
      after: {
        verdict: dto.verdict,
        outcome,
        note,
        notifiedUser: dto.notifyUser === true,
      },
      ipAddress: req.ip,
    });

    return { id, verdict: dto.verdict, status: outcome };
  }
}
