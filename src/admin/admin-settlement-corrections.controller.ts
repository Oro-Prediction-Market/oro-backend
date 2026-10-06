import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
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
import { IsHexadecimal, IsIn, IsString, IsUUID, Length, MaxLength, MinLength } from "class-validator";
import { JwtAuthGuard, AdminGuard } from "../auth/guards";
import { AuditService } from "./audit.service";
import { AuditAction } from "../entities/audit-log.entity";
import { SettlementCorrectionService } from "./settlement-correction.service";

export class ApplyCorrectionDto {
  @IsUUID()
  marketId!: string;

  @IsUUID()
  toOutcomeId!: string;

  @IsIn(["clawback", "keep"])
  mode!: "clawback" | "keep";

  /** Why, and what the result really was. Required: this is the record. */
  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  note!: string;

  /** From the preview the admin approved; a mismatch means the market moved. */
  @IsHexadecimal()
  @Length(64, 64)
  fingerprint!: string;
}

/**
 * Correct a settled market's result after it has paid out.
 *
 * Preview first, always: it lists every wallet that moves, by how much, and
 * whether taking the payout back would overdraw anyone. Applying requires the
 * preview's fingerprint, so what is written is what was looked at.
 */
@ApiTags("admin")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller("admin/settlement-corrections")
export class AdminSettlementCorrectionsController {
  constructor(
    private readonly corrections: SettlementCorrectionService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  @Get("preview")
  @ApiOperation({ summary: "What re-settling a market on another outcome would do" })
  preview(
    @Query("marketId", ParseUUIDPipe) marketId: string,
    @Query("toOutcomeId", ParseUUIDPipe) toOutcomeId: string,
  ) {
    return this.corrections.preview(marketId, toOutcomeId);
  }

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: "Re-settle a market on the correct outcome" })
  async apply(@Body() dto: ApplyCorrectionDto, @Request() req: any) {
    const note = dto.note.trim();
    const { correctionId, plan } = await this.corrections.apply(
      { ...dto, note },
      req.user.userId,
    );

    await this.audit.log({
      adminId: req.user.userId,
      isAdmin: true,
      action: AuditAction.MARKET_SETTLEMENT_CORRECTED,
      entityType: "market",
      entityId: dto.marketId,
      before: { outcome: plan.from },
      after: {
        outcome: plan.to,
        mode: dto.mode,
        note,
        correctionId,
        wallets: plan.users.length,
      },
      ipAddress: req.ip,
    });

    return { correctionId, from: plan.from, to: plan.to, mode: dto.mode };
  }

  @Get()
  @ApiOperation({ summary: "Past corrections, newest first" })
  async list(@Query("marketId") marketId?: string) {
    const params: unknown[] = [];
    let where = "";
    if (marketId) {
      params.push(marketId);
      where = `WHERE c."marketId" = $1::uuid`;
    }
    const rows: any[] = await this.dataSource.query(
      `SELECT c.id, c."marketId", c.mode, c.note, c.summary, c."createdAt",
              m.title, fo.label AS "fromLabel", t.label AS "toLabel",
              a.username AS "adminUsername", a."firstName" AS "adminFirstName"
         FROM settlement_corrections c
         JOIN markets m ON m.id = c."marketId"
         LEFT JOIN outcomes fo ON fo.id = c."fromOutcomeId"
         LEFT JOIN outcomes t ON t.id = c."toOutcomeId"
         LEFT JOIN users a ON a.id = c."adminId"
         ${where}
        ORDER BY c."createdAt" DESC
        LIMIT 100`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      marketId: r.marketId,
      title: r.title,
      from: r.fromLabel,
      to: r.toLabel,
      mode: r.mode,
      note: r.note,
      summary: r.summary,
      admin: r.adminUsername ? `@${r.adminUsername}` : (r.adminFirstName ?? null),
      createdAt: r.createdAt,
    }));
  }

  @Get(":id")
  @ApiOperation({ summary: "One correction, including the snapshot of what it overwrote" })
  async one(@Param("id", ParseUUIDPipe) id: string) {
    const [row] = await this.dataSource.query(
      `SELECT * FROM settlement_corrections WHERE id = $1`,
      [id],
    );
    if (!row) throw new NotFoundException("Correction not found");
    return row;
  }
}
