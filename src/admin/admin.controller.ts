import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Query,
  UseGuards,
  Patch,
  HttpCode,
  Delete,
  Request,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiProperty,
} from "@nestjs/swagger";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";
import { IsNumber, IsOptional, IsString, Min } from "class-validator";
import { Repository, DataSource } from "typeorm";
import { JwtAuthGuard, AdminGuard } from "../auth/guards";
import {
  MarketsService,
  CreateMarketDto,
  UpdateMarketDto,
} from "../markets/markets.service";
import { KeeperService } from "../markets/keeper.service";
import { FixturesService } from "./fixtures.service";
import { AuditService } from "./audit.service";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";
import { RedisService } from "../redis/redis.service";
import { AuditAction } from "../entities/audit-log.entity";
import { Market, MarketStatus } from "../entities/market.entity";
import { Outcome } from "../entities/outcome.entity";
import { Settlement } from "../entities/settlement.entity";
import { Dispute } from "../entities/dispute.entity";
import { Position } from "../entities/position.entity";
import { User } from "../entities/user.entity";
import { Payment } from "../entities/payment.entity";
import { Transaction, TransactionType } from "../entities/transaction.entity";
import { TransitionDto } from "./dto/transition.dto";
import { ResolveDto } from "./dto/resolve.dto";
import { ProposeResolutionDto } from "./dto/propose-resolution.dto";
import { GetUsersQueryDto } from "./dto/get-users-query.dto";
import { ToggleAdminDto } from "./dto/toggle-admin.dto";
import { HealthCheckResponse } from "./dto/health-check.dto";

class CreditUserDto {
  @ApiProperty({ example: 500, description: "Amount to credit (BTN)" })
  @IsNumber()
  @Min(1)
  amount: number;

  @ApiProperty({ required: false, example: "Staging DK top-up" })
  @IsOptional()
  @IsString()
  note?: string;
}

@ApiTags("admin")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller("admin")
export class AdminController {
  constructor(
    private marketsService: MarketsService,
    private keeperService: KeeperService,
    private fixturesService: FixturesService,
    private auditService: AuditService,
    private telegramSimple: TelegramSimpleService,
    @InjectDataSource() private dataSource: DataSource,
    private redis: RedisService,
    @InjectRepository(Settlement)
    private settlementRepo: Repository<Settlement>,
    @InjectRepository(Dispute) private disputeRepo: Repository<Dispute>,
    @InjectRepository(Position) private betRepo: Repository<Position>,
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectRepository(Payment) private paymentRepo: Repository<Payment>,
    @InjectRepository(Transaction)
    private transactionRepo: Repository<Transaction>,
  ) {}

  // ── Health Check ──────────────────────────────────────────────────────────
  @Get("health")
  @ApiOperation({ summary: "System health check - database, redis, memory" })
  @ApiResponse({ status: 200, type: HealthCheckResponse })
  async healthCheck(): Promise<HealthCheckResponse> {
    const startTime = Date.now();
    const status: HealthCheckResponse = {
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: { status: "disconnected" },
      redis: { status: "disconnected" },
      memory: { used: 0, total: 0, percentage: 0 },
      apiResponseTime: 0,
    };

    // Check database connection
    try {
      const dbStart = Date.now();
      await this.dataSource.query("SELECT 1");
      status.database = {
        status: "connected",
        responseTime: Date.now() - dbStart,
      };
    } catch (error) {
      status.database = { status: "disconnected" };
      status.status = "unhealthy";
    }

    // Check Redis connection
    try {
      const redisStart = Date.now();
      await this.redis.get("oro:health:ping");
      status.redis = {
        status: "connected",
        responseTime: Date.now() - redisStart,
      };
    } catch (error) {
      status.redis = { status: "disconnected" };
      status.status = status.status === "unhealthy" ? "unhealthy" : "degraded";
    }

    // Memory usage
    const memUsage = process.memoryUsage();
    const totalMem = memUsage.heapTotal;
    const usedMem = memUsage.heapUsed;
    const rss = memUsage.rss; // Resident Set Size - actual memory used by the process

    status.memory = {
      used: Math.round(rss / 1024 / 1024), // MB - actual memory in use (RSS)
      total: Math.round(totalMem / 1024 / 1024), // MB - allocated heap
      percentage: Math.round((usedMem / totalMem) * 100), // heap usage percentage
    };

    // Warn if memory is concerning (>500MB RSS or heap is consistently full)
    if (rss > 500 * 1024 * 1024 || status.memory.percentage > 95) {
      if (status.status === "healthy") {
        status.status = "degraded";
      }
    }

    status.apiResponseTime = Date.now() - startTime;
    return status;
  }

  // ── Finance Stats ───────────────────────────────────────────────────────────
  @Get("finance-stats")
  @ApiOperation({ summary: "Platform financial summary: house income, pools" })
  async financeStats() {
    // Total pool from ALL settled markets
    const settledResult = await this.dataSource.query(`
      SELECT COALESCE(SUM("totalPool"), 0) AS "settledPool",
             COUNT(*) AS "settledCount"
      FROM markets WHERE status = 'settled'
    `);
    // House income = sum(totalPool * houseEdgePct / 100) for settled markets
    const houseResult = await this.dataSource.query(`
      SELECT COALESCE(SUM("totalPool" * "houseEdgePct" / 100), 0) AS "houseIncome"
      FROM markets WHERE status = 'settled'
    `);
    // Active pool (open + closed + resolving + resolved)
    const activeResult = await this.dataSource.query(`
      SELECT COALESCE(SUM("totalPool"), 0) AS "activePool",
             COUNT(*) AS "activeCount"
      FROM markets WHERE status IN ('open','closed','resolving','resolved')
    `);
    // Total all-time volume
    const allTimeResult = await this.dataSource.query(`
      SELECT COALESCE(SUM("totalPool"), 0) AS "allTimeVolume",
             COUNT(*) AS "totalMarkets"
      FROM markets
    `);
    // Bonus liability metrics:
    // "Bonus Exposure Realised" = sum of real payouts paid to WINNING bettors
    // that came from pools containing bonus-funded LOSING bets.
    //
    // Calculation: for each settled market, if any losing position was bonus-funded,
    // the pro-rata share of the payout pool attributable to those losing positions
    // is real Nu the platform had to fund from nothing.
    //
    // Approximation via POSITION_PAYOUT transactions on markets that had bonus-funded
    // losing positions: SUM of POSITION_PAYOUT (isBonus=false) for markets where
    // at least one LOST position had isBonusFunded=true.
    const bonusResult = await this.dataSource.query(`
      SELECT
        COALESCE(SUM(CASE WHEN t.type = 'free_credit' AND t."isBonus" = true THEN t.amount ELSE 0 END), 0) AS "totalBonusIssued",
        -- Real payouts on markets that had at least one bonus-funded LOSING position
        COALESCE((
          SELECT SUM(pt.amount)
          FROM transactions pt
          WHERE pt.type = 'bet_payout'
            AND pt."isBonus" = false
            AND pt.amount > 0
            AND pt."positionId" IN (
              SELECT p_win.id FROM positions p_win
              WHERE p_win.status = 'won'
                AND p_win."marketId" IN (
                  SELECT DISTINCT p_loss."marketId"
                  FROM positions p_loss
                  WHERE p_loss.status IN ('lost', 'refunded')
                    AND EXISTS (
                      SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'positions' AND column_name = 'isBonusFunded'
                    )
                    AND p_loss."isBonusFunded" = true
                )
            )
        ), 0) AS "bonusFundedRealPayouts"
      FROM transactions t
    `);
    // Current outstanding bonus balance across all users
    const bonusBalanceResult = await this.dataSource.query(`
      SELECT COALESCE(SUM("bonusBalance"), 0) AS "outstandingBonusBalance"
      FROM users
    `);

    return {
      houseIncome: parseFloat(houseResult[0].houseIncome),
      settledPool: parseFloat(settledResult[0].settledPool),
      settledCount: parseInt(settledResult[0].settledCount),
      activePool: parseFloat(activeResult[0].activePool),
      activeCount: parseInt(activeResult[0].activeCount),
      allTimeVolume: parseFloat(allTimeResult[0].allTimeVolume),
      totalMarkets: parseInt(allTimeResult[0].totalMarkets),
      bonus: {
        // Total bonus credits ever created (welcome bonuses + payout-overflow credits)
        totalIssued: parseFloat(bonusResult[0].totalBonusIssued),
        // Current unspent bonus balance sitting in user wallets
        outstandingBalance: parseFloat(
          bonusBalanceResult[0].outstandingBonusBalance,
        ),
        // Real Nu paid out to OTHER users because a bonus bettor lost
        // This is the platform's actual bonus exposure realised as real money
        realPayoutsFundedByBonus: parseFloat(
          bonusResult[0].bonusFundedRealPayouts,
        ),
      },
    };
  }

  // ── Markets ────────────────────────────────────────────────────────────────
  @Post("markets")
  @ApiOperation({ summary: "Create a new market with outcomes" })
  async createMarket(@Body() dto: CreateMarketDto, @Request() req: any) {
    const market = await this.marketsService.create(dto);
    await this.auditService.log({
      adminId: req.user.userId,
      isAdmin: true, // Admin controller - all users are admins
      action: AuditAction.MARKET_CREATE,
      entityType: "market",
      entityId: market.id,
      after: {
        title: market.title,
        outcomes: dto.outcomes,
        closesAt: dto.closesAt,
      },
      ipAddress: req.ip,
    });
    const miniAppUrl = process.env.TELEGRAM_MINI_APP_URL || "";
    const outcomes = (market.outcomes ?? [])
      .map((o) => `• ${o.label}`)
      .join("\n");
    const closesAt = market.closesAt
      ? new Date(market.closesAt).toLocaleString("en-US", {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "TBD";
    await this.telegramSimple.postToChannel(
      `🚀 <b>NEW MARKET</b>\n\n📊 <b>${market.title}</b>\n\n🎲 <b>Outcomes:</b>\n${outcomes}\n\n⏰ Closes: ${closesAt}\n\n👉 <a href="${miniAppUrl}">Predict Now</a>`,
    );
    return market;
  }

  @Get("markets")
  @ApiOperation({ summary: "List all markets (admin view) with pagination" })
  @ApiQuery({ name: "page", required: false, type: Number })
  @ApiQuery({ name: "limit", required: false, type: Number })
  @ApiQuery({ name: "status", required: false, type: String })
  async listMarkets(
    @Query("page") page = "1",
    @Query("limit") limit = "20",
    @Query("status") status?: string,
  ) {
    const take = Math.min(Number(limit) || 20, 500);
    const skip = (Math.max(Number(page), 1) - 1) * take;
    const qb = this.dataSource
      .getRepository(Market)
      .createQueryBuilder("market")
      .leftJoinAndSelect("market.outcomes", "outcome")
      .orderBy("market.createdAt", "DESC")
      .skip(skip)
      .take(take);
    if (status && status.toLowerCase() !== "all") {
      qb.where("market.status = :status", { status: status.toLowerCase() });
    }
    const [data, total] = await qb.getManyAndCount();
    return {
      data,
      total,
      page: Math.max(Number(page), 1),
      pages: Math.ceil(total / take) || 1,
    };
  }

  @Get("markets/:id")
  @ApiOperation({ summary: "Get market details" })
  getMarket(@Param("id") id: string) {
    return this.marketsService.findOne(id);
  }

  @Patch("markets/:id")
  @ApiOperation({
    summary: "Update market metadata and/or rename outcome labels",
  })
  async updateMarket(
    @Param("id") id: string,
    @Body() dto: UpdateMarketDto,
    @Request() req: any,
  ) {
    const before = await this.marketsService.findOne(id);
    const result = await this.marketsService.update(id, dto);
    await this.auditService.log({
      adminId: req.user.userId,
      isAdmin: true,
      action: AuditAction.MARKET_TRANSITION, // reuse closest action; no MARKET_UPDATE exists
      entityType: "market",
      entityId: id,
      before: {
        title: before.title,
        outcomes: before.outcomes?.map((o) => o.label),
      },
      after: { title: result.title, outcomes: dto.outcomes },
      meta: {
        fields: Object.keys(dto).filter((k) => (dto as any)[k] !== undefined),
      },
      ipAddress: req.ip,
    });
    return result;
  }

  @Patch("markets/:id/status")
  @ApiOperation({
    summary: "Transition market state (Upcoming→Open→Closed→Cancelled)",
  })
  async transitionMarket(
    @Param("id") id: string,
    @Body() dto: TransitionDto,
    @Request() req: any,
  ) {
    const before = await this.marketsService.findOne(id);
    const result = await this.marketsService.transition(id, dto.status);
    await this.auditService.log({
      adminId: req.user.userId,
      isAdmin: true, // Admin controller - all users are admins
      action: AuditAction.MARKET_TRANSITION,
      entityType: "market",
      entityId: id,
      before: { status: before.status },
      after: { status: dto.status },
      meta: { title: before.title },
      ipAddress: req.ip,
    });
    return result;
  }

  @Post("markets/:id/propose")
  @HttpCode(200)
  @ApiOperation({
    summary:
      "Propose winning outcome — opens 1–2h objection window (Closed → Resolving). " +
      "Admin must include evidenceUrl and evidenceNote when calling /resolve immediately after.",
  })
  @ApiResponse({ status: 200, type: Market })
  async proposeResolution(
    @Param("id") id: string,
    @Body() dto: ProposeResolutionDto,
    @Request() req: any,
  ) {
    const before = await this.marketsService.findOne(id);
    const windowMinutes = dto.windowMinutes ?? 60;
    const result = await this.marketsService.proposeResolution(
      id,
      dto.proposedOutcomeId,
      windowMinutes,
    );
    const proposedOutcome = before.outcomes?.find(
      (o) => o.id === dto.proposedOutcomeId,
    );
    await this.auditService.log({
      adminId: req.user.userId,
      isAdmin: true,
      action: AuditAction.MARKET_PROPOSE,
      entityType: "market",
      entityId: id,
      before: { status: before.status, proposedOutcomeId: null },
      after: { status: "resolving", proposedOutcomeId: dto.proposedOutcomeId },
      meta: {
        title: before.title,
        proposedOutcomeLabel: proposedOutcome?.label,
        windowMinutes,
      },
      ipAddress: req.ip,
    });
    const miniAppUrl = process.env.TELEGRAM_MINI_APP_URL || "";
    const marketDeepLink = miniAppUrl ? `${miniAppUrl}?startapp=m_${id}` : "";
    const windowLabel =
      windowMinutes >= 60
        ? `${windowMinutes / 60} hour${windowMinutes > 60 ? "s" : ""}`
        : `${windowMinutes} minutes`;
    await this.telegramSimple.postToChannel(
      `⚖️ <b>OBJECTION WINDOW OPEN</b>\n\n` +
        `📊 <b>${before.title}</b>\n\n` +
        `🔖 <b>Proposed Winner:</b> ${proposedOutcome?.label ?? "N/A"}\n` +
        `⏳ Window: ${windowLabel} — object if you disagree\n` +
        `💡 Evidence will be published when the market is settled.\n\n` +
        `👉 <a href="${marketDeepLink || miniAppUrl}">View Market</a>`,
    );
    return result;
  }

  @Post("markets/:id/resolve")
  @HttpCode(200)
  @ApiOperation({
    summary:
      "Final resolution — set winner, publish mandatory evidence, settle payouts. " +
      "evidenceUrl and evidenceNote are REQUIRED. If the window is still open and " +
      "no objections exist, this will be rejected (cron auto-settles it). " +
      "You may resolve early only when objections exist and have been reviewed.",
  })
  async resolveMarket(
    @Param("id") id: string,
    @Body() dto: ResolveDto,
    @Request() req: any,
  ) {
    const before = await this.marketsService.findOne(id);
    const result = await this.marketsService.resolve(
      id,
      dto.winningOutcomeId,
      req.user.userId,
      dto.evidenceUrl,
      dto.evidenceNote,
    );
    const winningOutcome = before.outcomes?.find(
      (o) => o.id === dto.winningOutcomeId,
    );
    const totalPositions =
      before.outcomes?.reduce((s, o) => s + Number(o.totalBetAmount), 0) ?? 0;

    const objections = await this.marketsService.getDisputesByMarket(id);
    const hadObjections = objections.length > 0;
    const proposalChanged = before.proposedOutcomeId !== dto.winningOutcomeId;

    await this.auditService.log({
      adminId: req.user.userId,
      isAdmin: true,
      action: hadObjections
        ? AuditAction.MARKET_RESOLVE_DISPUTED
        : AuditAction.MARKET_RESOLVE,
      entityType: "market",
      entityId: id,
      before: { status: before.status },
      after: { status: "settled", winningOutcomeId: dto.winningOutcomeId },
      meta: {
        title: before.title,
        winningOutcomeLabel: winningOutcome?.label,
        totalPool: before.totalPool,
        totalPositions,
        objectionCount: objections.length,
        proposalChanged,
        evidenceUrl: dto.evidenceUrl,
      },
      ipAddress: req.ip,
    });

    const miniAppUrl = process.env.TELEGRAM_MINI_APP_URL || "";
    const objectionNote =
      objections.length > 0
        ? `\n⚠️ <b>${objections.length} objection(s) reviewed</b> — ${proposalChanged ? "outcome updated after review" : "original proposal confirmed"}\n` +
          (proposalChanged
            ? `✅ Correct objectors: bonds returned + rewarded\n`
            : `❌ Wrong objectors: bonds forfeited`)
        : "";
    await this.telegramSimple.postToChannel(
      `✅ <b>MARKET SETTLED</b>\n\n` +
        `📊 <b>${before.title}</b>\n\n` +
        `🏆 <b>Winner:</b> ${winningOutcome?.label ?? "N/A"}\n` +
        `💰 <b>Pool:</b> Nu ${Number(before.totalPool).toLocaleString()}` +
        `${objectionNote}\n\n` +
        `🔍 <b>Evidence:</b> <a href="${dto.evidenceUrl}">View Source</a>\n` +
        `📝 ${dto.evidenceNote.slice(0, 200)}\n\n` +
        `👉 <a href="${miniAppUrl}">View Results & Proof</a>`,
    );
    return result;
  }

  @Get("markets/:id/disputes")
  @ApiOperation({ summary: "List disputes for a specific market" })
  @ApiResponse({ status: 200, type: [Dispute] })
  getMarketDisputes(@Param("id") id: string) {
    return this.marketsService.getDisputesByMarket(id);
  }

  @Get("disputes")
  @ApiOperation({ summary: "List all disputes across all markets" })
  @ApiResponse({ status: 200, type: [Dispute] })
  async getAllDisputes() {
    const data = await this.disputeRepo.find({
      order: { createdAt: "DESC" },
      take: 500,
    });
    return { data, total: data.length };
  }

  /**
   * Public admin accountability scoreboard.
   * Returns every admin user with their resolution accuracy stats.
   * Intentionally public (no admin guard on the GET) — users deserve to see this.
   */
  @Get("resolution-accuracy")
  @ApiOperation({
    summary:
      "Public scoreboard of admin resolution accuracy. Shows how often each admin was overturned by objectors.",
  })
  async getResolutionAccuracy() {
    const admins = await this.userRepo.find({
      where: { isAdmin: true },
      select: [
        "id",
        "username",
        "firstName",
        "adminTotalResolutions",
        "adminWrongResolutions",
      ],
    });

    return admins
      .filter((a) => a.adminTotalResolutions > 0)
      .map((a) => {
        const total = a.adminTotalResolutions ?? 0;
        const wrong = a.adminWrongResolutions ?? 0;
        const correct = total - wrong;
        const accuracyPct =
          total > 0 ? Math.round((correct / total) * 100) : null;
        const overturnPct =
          total > 0 ? Math.round((wrong / total) * 100) : null;

        return {
          adminId: a.id,
          name: a.username ? `@${a.username}` : (a.firstName ?? "Admin"),
          totalResolutions: total,
          correctResolutions: correct,
          wrongResolutions: wrong,
          accuracyPct,
          overturnPct,
          // Flag for the UI — > 20% overturn rate is a red flag
          flagged: overturnPct !== null && overturnPct > 20,
        };
      })
      .sort((a, b) => b.totalResolutions - a.totalResolutions);
  }

  @Post("markets/:id/cancel")
  @HttpCode(200)
  @ApiOperation({ summary: "Cancel market & refund all positions" })
  async cancelMarket(@Param("id") id: string, @Request() req: any) {
    const before = await this.marketsService.findOne(id);
    const result = await this.marketsService.cancel(id);
    await this.auditService.log({
      adminId: req.user.userId,
      isAdmin: true, // Admin controller - all users are admins
      action: AuditAction.MARKET_CANCEL,
      entityType: "market",
      entityId: id,
      before: { status: before.status, totalPool: before.totalPool },
      after: { status: "cancelled" },
      meta: { title: before.title },
      ipAddress: req.ip,
    });
    return result;
  }

  @HttpCode(204)
  @Delete("markets/:id")
  @ApiOperation({ summary: "Delete a market" })
  async deleteMarket(@Param("id") id: string, @Request() req: any) {
    const before = await this.marketsService.findOne(id);
    await this.auditService.log({
      adminId: req.user.userId,
      isAdmin: true, // Admin controller - all users are admins
      action: AuditAction.MARKET_DELETE,
      entityType: "market",
      entityId: id,
      before: { title: before.title, status: before.status },
      ipAddress: req.ip,
    });
    return this.marketsService.delete(id);
  }

  @Delete("markets/cleanup/zero-pool")
  @ApiOperation({
    summary: "Delete all markets with zero pool volume (no bets placed)",
  })
  async purgeEmptyMarkets(@Request() req: any) {
    const count = await this.marketsService.deleteZeroPool();
    await this.auditService.log({
      adminId: req.user.userId,
      isAdmin: true,
      action: AuditAction.MARKET_DELETE,
      entityType: "market",
      entityId: "bulk-zero-pool",
      before: { count },
      ipAddress: req.ip,
    });
    return { deleted: count };
  }

  // ── Fixtures ──────────────────────────────────────────────────────────────
  @Get("fixtures")
  @ApiOperation({
    summary: "Fetch upcoming football fixtures from football-data.org",
  })
  getFixtures(@Query("q") q?: string) {
    return this.fixturesService.getFixtures(q);
  }

  // ── Pool view ─────────────────────────────────────────────────────────────
  @Get("markets/:id/pool")
  @ApiOperation({ summary: "View pool breakdown per outcome" })
  async viewPool(@Param("id") id: string) {
    const market = await this.marketsService.findOne(id);
    const totalPool = Number(market.totalPool);
    const houseEdge = Number(market.houseEdgePct);
    return {
      marketId: id,
      title: market.title,
      status: market.status,
      totalPool,
      houseEdgePct: houseEdge,
      houseAmount: totalPool * (houseEdge / 100),
      payoutPool: totalPool * (1 - houseEdge / 100),
      outcomes: market.outcomes.map((o) => ({
        id: o.id,
        label: o.label,
        totalBetAmount: Number(o.totalBetAmount),
        currentOdds: Number(o.currentOdds),
        impliedProbability:
          totalPool > 0
            ? ((Number(o.totalBetAmount) / totalPool) * 100).toFixed(2) + "%"
            : "0%",
        isWinner: o.isWinner,
      })),
    };
  }

  // ── Settlements ───────────────────────────────────────────────────────────
  @Get("settlements")
  @ApiOperation({ summary: "List settlements with pagination" })
  @ApiQuery({ name: "page", required: false, type: Number })
  @ApiQuery({ name: "limit", required: false, type: Number })
  async listSettlements(
    @Query("page") page = "1",
    @Query("limit") limit = "20",
  ) {
    const take = Math.min(Number(limit) || 20, 100);
    const pageNum = Math.max(Number(page), 1);
    const skip = (pageNum - 1) * take;

    // Exclude orphaned settlements (deleted markets) and deduplicate:
    // keep only the earliest settlement row per market.
    const [data, total] = await this.settlementRepo
      .createQueryBuilder("settlement")
      .innerJoinAndMapOne(
        "settlement.market",
        Market,
        "market",
        "market.id = settlement.marketId",
      )
      .leftJoinAndMapOne(
        "settlement.outcome",
        Outcome,
        "outcome",
        "outcome.id = settlement.winningOutcomeId",
      )
      .where((qb) => {
        const sub = qb
          .subQuery()
          .select('MIN(s2."settledAt")')
          .from("settlements", "s2")
          .where('s2."marketId" = settlement."marketId"')
          .getQuery();
        return `settlement."settledAt" = (${sub})`;
      })
      .orderBy("settlement.settledAt", "DESC")
      .skip(skip)
      .take(take)
      .getManyAndCount();

    return {
      data,
      total,
      page: pageNum,
      pages: Math.ceil(total / take) || 1,
    };
  }

  // ── Users ─────────────────────────────────────────────────────────────────
  @Get("users")
  @ApiOperation({
    summary: "List users with search, filters, sort and pagination",
  })
  @ApiQuery({ name: "search", required: false, type: String })
  @ApiQuery({ name: "role", required: false, enum: ["all", "admin", "user"] })
  @ApiQuery({
    name: "dkStatus",
    required: false,
    enum: ["all", "linked", "unlinked"],
  })
  @ApiQuery({
    name: "sortField",
    required: false,
    enum: ["name", "balance", "streak", "joined"],
  })
  @ApiQuery({ name: "sortDir", required: false, enum: ["asc", "desc"] })
  @ApiQuery({ name: "page", required: false, type: Number })
  @ApiQuery({ name: "limit", required: false, type: Number })
  async listUsers(@Query() query: GetUsersQueryDto) {
    const {
      search,
      role = "all",
      dkStatus = "all",
      sortField = "joined",
      sortDir = "desc",
      page = 1,
      limit = 20,
    } = query;

    const qb = this.userRepo
      .createQueryBuilder("u")
      .select([
        "u.id",
        "u.firstName",
        "u.lastName",
        "u.username",
        "u.photoUrl",
        "u.isAdmin",
        "u.telegramId",
        "u.telegramChatId",
        "u.telegramStreak",
        "u.telegramLinkedAt",
        "u.dkCid",
        "u.dkAccountNumber",
        "u.dkAccountName",
        "u.reputationTier",
        "u.totalPredictions",
        "u.createdAt",
        "u.updatedAt",
      ]);

    // ── Full-text search ────────────────────────────────────────────────────
    if (search && search.trim()) {
      // Escape LIKE special chars so user input cannot wildcard-scan arbitrary data
      const safe = search
        .trim()
        .toLowerCase()
        .replace(/[%_\\]/g, "\\$&");
      const term = `%${safe}%`;
      qb.andWhere(
        `(
          LOWER(COALESCE(u.firstName,'')  || ' ' || COALESCE(u.lastName,'')) LIKE :term ESCAPE '\\'
          OR LOWER(COALESCE(u.username,''))      LIKE :term ESCAPE '\\'
          OR LOWER(COALESCE(u.telegramId,''))    LIKE :term ESCAPE '\\'
          OR LOWER(COALESCE(u.dkCid,''))         LIKE :term ESCAPE '\\'
          OR LOWER(COALESCE(u.dkAccountName,'')) LIKE :term ESCAPE '\\'
          OR LOWER(u.id::text)                   LIKE :term ESCAPE '\\'
        )`,
        { term },
      );
    }

    // ── Role filter ─────────────────────────────────────────────────────────
    if (role === "admin")
      qb.andWhere("u.isAdmin = :isAdmin", { isAdmin: true });
    if (role === "user")
      qb.andWhere("u.isAdmin = :isAdmin", { isAdmin: false });

    // ── DK-link filter ──────────────────────────────────────────────────────
    if (dkStatus === "linked") qb.andWhere("u.dkCid IS NOT NULL");
    if (dkStatus === "unlinked") qb.andWhere("u.dkCid IS NULL");

    // ── Sort ────────────────────────────────────────────────────────────────
    const dir = sortDir.toUpperCase() as "ASC" | "DESC";
    if (sortField === "name") {
      qb.orderBy(
        "LOWER(COALESCE(u.firstName,'') || ' ' || COALESCE(u.lastName,''))",
        dir,
      );
    } else if (sortField === "streak") {
      qb.orderBy("COALESCE(u.telegramStreak, 0)", dir);
    } else {
      // joined (default)
      qb.orderBy("u.createdAt", dir);
    }

    // ── Pagination ──────────────────────────────────────────────────────────
    const take = Math.min(Number(limit), 100);
    const skip = (Math.max(Number(page), 1) - 1) * take;

    qb.skip(skip).take(take);

    const [data, total] = await qb.getManyAndCount();

    return {
      data,
      total,
      page: Math.max(Number(page), 1),
      limit: take,
      pages: Math.ceil(total / take),
    };
  }

  @Patch("users/:userId/admin")
  @ApiOperation({ summary: "Grant or revoke admin role for a user" })
  async toggleAdmin(
    @Param("userId") userId: string,
    @Body() dto: ToggleAdminDto,
    @Request() req: any,
  ) {
    const user = await this.userRepo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException("User not found");

    await this.userRepo.update(userId, { isAdmin: dto.isAdmin });
    await this.auditService.log({
      adminId: req.user.userId,
      isAdmin: true, // Admin controller - all users are admins
      action: AuditAction.USER_ADMIN_TOGGLE,
      entityType: "user",
      entityId: userId,
      before: { isAdmin: user.isAdmin },
      after: { isAdmin: dto.isAdmin },
      ipAddress: req.ip,
    });

    return { userId, isAdmin: dto.isAdmin };
  }

  @Post("users/:userId/credit")
  @HttpCode(200)
  @ApiOperation({
    summary:
      "Manually credit a user's wallet with a DEPOSIT transaction (staging use)",
  })
  async creditUser(
    @Param("userId") userId: string,
    @Body() dto: CreditUserDto,
    @Request() req: any,
  ) {
    const user = await this.userRepo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException("User not found");

    if (dto.amount <= 0) throw new BadRequestException("Amount must be > 0");

    const note = dto.note ?? "Admin manual credit";

    const tx = await this.dataSource.transaction(async (em) => {
      const { balance } = await em
        .getRepository(Transaction)
        .createQueryBuilder("t")
        .select("COALESCE(SUM(t.amount), 0)", "balance")
        .where("t.userId = :userId", { userId })
        .getRawOne();
      const balanceBefore = Number(balance);
      const balanceAfter = balanceBefore + dto.amount;

      return em.save(
        Transaction,
        em.create(Transaction, {
          type: TransactionType.DEPOSIT,
          amount: dto.amount,
          balanceBefore,
          balanceAfter,
          userId,
          note,
        }),
      );
    });

    // Bust the cached balance so the next /me call reflects immediately
    await this.redis.del(`oro:cache:balance:${userId}`);

    await this.auditService.log({
      adminId: req.user.userId,
      isAdmin: true,
      action: AuditAction.USER_ADMIN_TOGGLE, // closest existing action; rename later if needed
      entityType: "user",
      entityId: userId,
      after: { creditAmount: dto.amount, note, transactionId: tx.id },
      ipAddress: req.ip,
    });

    return {
      transactionId: tx.id,
      userId,
      credited: dto.amount,
      newBalance: tx.balanceAfter,
      note,
    };
  }

  // ── Reconciliation ────────────────────────────────────────────────────────
  @Get("reconciliation")
  @ApiOperation({ summary: "Financial reconciliation snapshot" })
  async getReconciliation() {
    const em = this.dataSource.manager;

    const depositRow = await em
      .getRepository(Payment)
      .createQueryBuilder("p")
      .select("COALESCE(SUM(p.amount), 0)", "total")
      .addSelect("COUNT(*)", "count")
      .where("p.type = :type AND p.status = :status", {
        type: "deposit",
        status: "success",
      })
      .getRawOne();

    const withdrawalRow = await em
      .getRepository(Payment)
      .createQueryBuilder("p")
      .select("COALESCE(SUM(p.amount), 0)", "total")
      .addSelect("COUNT(*)", "count")
      .where("p.type = :type AND p.status = :status", {
        type: "withdrawal",
        status: "success",
      })
      .getRawOne();

    const pendingDepositRow = await em
      .getRepository(Payment)
      .createQueryBuilder("p")
      .select("COALESCE(SUM(p.amount), 0)", "total")
      .addSelect("COUNT(*)", "count")
      .where("p.type = :type AND p.status = :status", {
        type: "deposit",
        status: "pending",
      })
      .getRawOne();

    const realBalanceRow = await em
      .getRepository(Transaction)
      .createQueryBuilder("t")
      .select("COALESCE(SUM(t.amount), 0)", "total")
      .where("t.isBonus = :isBonus", { isBonus: false })
      .getRawOne();

    const bonusBalanceRow = await em
      .getRepository(Transaction)
      .createQueryBuilder("t")
      .select("COALESCE(SUM(t.amount), 0)", "total")
      .where("t.isBonus = :isBonus", { isBonus: true })
      .getRawOne();

    const txBreakdown = await em
      .getRepository(Transaction)
      .createQueryBuilder("t")
      .select("t.type", "type")
      .addSelect("COALESCE(SUM(t.amount), 0)", "total")
      .addSelect("COUNT(*)", "count")
      .groupBy("t.type")
      .orderBy("t.type")
      .getRawMany();

    // Deduplicate settlements: the race condition that was fixed created multiple
    // settlement rows per market. Use DISTINCT ON to count only the first (canonical)
    // settlement per market so house earnings and counts are not inflated.
    // Deduplicate settlements: join to markets so orphaned rows (deleted markets)
    // are excluded, and DISTINCT ON picks the first canonical row per market.
    const settlementRow = await em
      .getRepository(Settlement)
      .query(
        `
      SELECT
        COALESCE(SUM(s."totalPool"), 0)    AS "totalPool",
        COALESCE(SUM(s."houseAmount"), 0)  AS "houseAmount",
        COALESCE(SUM(s."payoutPool"), 0)   AS "payoutPool",
        COALESCE(SUM(s."totalPaidOut"), 0) AS "totalPaidOut",
        COUNT(*)                           AS count
      FROM (
        SELECT DISTINCT ON (sel."marketId") sel.*
        FROM settlements sel
        INNER JOIN markets m ON m.id = sel."marketId"
        ORDER BY sel."marketId", sel."settledAt" ASC
      ) s
    `,
      )
      .then((rows: any[]) => rows[0]);

    const pendingBetsRow = await em
      .getRepository(Position)
      .createQueryBuilder("pos")
      .select("COALESCE(SUM(pos.amount), 0)", "total")
      .addSelect("COUNT(*)", "count")
      .where("pos.status = :status", { status: "pending" })
      .getRawOne();

    const totalDeposits = Number(depositRow.total);
    const depositCount = Number(depositRow.count);
    const totalWithdrawals = Number(withdrawalRow.total);
    const withdrawalCount = Number(withdrawalRow.count);
    const pendingDeposits = Number(pendingDepositRow.total);
    const pendingDepositCount = Number(pendingDepositRow.count);
    const totalRealBalance = Number(realBalanceRow.total);
    const totalBonusBalance = Number(bonusBalanceRow.total);
    const totalPool = Number(settlementRow.totalPool);
    const houseEarnings = Number(settlementRow.houseAmount);
    const payoutPool = Number(settlementRow.payoutPool);
    const totalPaidOut = Number(settlementRow.totalPaidOut);
    const settlementCount = Number(settlementRow.count);
    const breakage = payoutPool - totalPaidOut;
    const pendingBetsAmount = Number(pendingBetsRow.total);
    const pendingBetsCount = Number(pendingBetsRow.count);

    const netExternalFlow = totalDeposits - totalWithdrawals;
    // Net flow − house − breakage − active bets (already deducted from wallets,
    // not yet returned) = liquid balance users should currently hold
    // IMPORTANT: bonus-funded real payouts inflate user balances beyond external
    // flow — they represent platform liability that was never deposited.
    // We must add them to expected balances so reconciliation correctly flags
    // the real shortfall rather than masking it as "discrepancy".
    const bonusFundedRealPayoutsRow = await em
      .getRepository(Transaction)
      .query(
        `
      SELECT COALESCE(SUM(pt.amount), 0)::float AS total
      FROM transactions pt
      WHERE pt.type = 'bet_payout'
        AND pt."isBonus" = false
        AND pt.amount > 0
        AND pt."positionId" IN (
          SELECT p_win.id FROM positions p_win
          WHERE p_win.status = 'won'
            AND p_win."marketId" IN (
              SELECT DISTINCT p_loss."marketId"
              FROM positions p_loss
              WHERE p_loss.status IN ('lost', 'refunded')
                AND EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'positions' AND column_name = 'isBonusFunded'
                )
                AND p_loss."isBonusFunded" = true
            )
        )
    `,
      )
      .then((r: any[]) => parseFloat(r[0].total));

    const totalBonusIssuedRow = await em
      .getRepository(Transaction)
      .query(
        `
      SELECT COALESCE(SUM(amount), 0)::float AS total
      FROM transactions
      WHERE type = 'free_credit' AND "isBonus" = true
    `,
      )
      .then((r: any[]) => parseFloat(r[0].total));

    // expectedUserBalances = what users SHOULD hold based purely on external money
    // + bonus real payouts (real Nu that entered wallets from bonus-loss events)
    const expectedUserBalances =
      netExternalFlow -
      houseEarnings -
      breakage -
      pendingBetsAmount +
      bonusFundedRealPayoutsRow;
    const discrepancy = totalRealBalance - expectedUserBalances;

    return {
      snapshot: new Date().toISOString(),
      externalFlow: {
        totalDeposits,
        depositCount,
        totalWithdrawals,
        withdrawalCount,
        pendingDeposits,
        pendingDepositCount,
        netExternalFlow,
      },
      settlements: {
        count: settlementCount,
        totalPool,
        houseEarnings,
        payoutPool,
        totalPaidOut,
        breakage,
      },
      userWallets: {
        totalRealBalance,
        totalBonusBalance,
      },
      activeBets: {
        pendingCount: pendingBetsCount,
        pendingAmount: pendingBetsAmount,
      },
      reconciliation: {
        netExternalFlow,
        houseEarnings,
        breakage,
        bonusFundedRealPayouts: bonusFundedRealPayoutsRow,
        totalBonusIssued: totalBonusIssuedRow,
        expectedUserBalances,
        actualUserBalances: totalRealBalance,
        discrepancy,
        isBalanced: Math.abs(discrepancy) < 0.01,
      },
      transactionBreakdown: txBreakdown.map((r) => ({
        type: r.type,
        total: Number(r.total),
        count: Number(r.count),
      })),
    };
  }

  // ── Payments ───────────────────────────────────────────────────────────────
  @Get("payments")
  @ApiOperation({ summary: "List all payments (admin view)" })
  async listPayments() {
    const data = await this.paymentRepo.find({
      relations: ["user"],
      order: { createdAt: "DESC" },
      take: 500,
    });
    return { data, total: data.length };
  }

  // ── Transactions (full ledger) ─────────────────────────────────────────────
  @Get("transactions")
  @ApiOperation({ summary: "List all transactions — full financial ledger" })
  @ApiQuery({ name: "type", required: false })
  @ApiQuery({ name: "limit", required: false, type: Number })
  async listTransactions(
    @Query("type") type?: string,
    @Query("limit") limit = "1000",
  ) {
    const take = Math.min(Number(limit) || 1000, 2000);
    const qb = this.transactionRepo
      .createQueryBuilder("t")
      .leftJoinAndSelect("t.user", "user")
      .orderBy("t.createdAt", "DESC")
      .take(take);

    if (type && type !== "all") {
      qb.where("t.type = :type", { type });
    }

    const [data, total] = await qb.getManyAndCount();
    return { data, total };
  }

  // ── Audit Logs ─────────────────────────────────────────────────────────────
  @Get("audit-logs")
  @ApiOperation({ summary: "Paginated, server-side filterable audit trail" })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "limit", required: false })
  @ApiQuery({ name: "action", required: false })
  @ApiQuery({ name: "adminId", required: false })
  @ApiQuery({ name: "entityType", required: false })
  @ApiQuery({ name: "search", required: false })
  @ApiQuery({ name: "from", required: false, description: "YYYY-MM-DD" })
  @ApiQuery({
    name: "to",
    required: false,
    description: "YYYY-MM-DD inclusive",
  })
  getAuditLogs(
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("action") action?: string,
    @Query("adminId") adminId?: string,
    @Query("entityType") entityType?: string,
    @Query("search") search?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.auditService.findPaginated({
      page: Number(page) || 1,
      limit: Number(limit) || 50,
      action,
      adminId: adminId || undefined,
      entityType,
      search: search || undefined,
      from: from || undefined,
      to: to || undefined,
    });
  }

  /** Must come BEFORE /audit-logs/admin/:adminId to avoid route shadowing */
  @Get("audit-logs/admins")
  @ApiOperation({ summary: "Distinct admins for filter dropdowns" })
  getAuditAdmins() {
    return this.auditService.findDistinctAdmins();
  }

  @Get("audit-logs/admin/:adminId")
  @ApiOperation({ summary: "Audit trail for a specific admin account" })
  getAuditLogsByAdmin(@Param("adminId") adminId: string) {
    return this.auditService.findByAdmin(adminId);
  }

  @Get("audit-logs/entity/:entityId")
  @ApiOperation({
    summary: "Audit trail for a specific entity (market, user, etc.)",
  })
  getAuditLogsByEntity(@Param("entityId") entityId: string) {
    return this.auditService.findByEntity(entityId);
  }

  // ── Keeper Bot ────────────────────────────────────────────────────────────

  @Get("keeper/status")
  @ApiOperation({ summary: "Get keeper bot status and recent logs" })
  getKeeperStatus() {
    return this.keeperService.getStatus();
  }

  @Post("keeper/active")
  @HttpCode(200)
  @ApiOperation({ summary: "Start or pause the keeper bot" })
  setKeeperActive(@Body() body: { active: boolean }) {
    this.keeperService.setActive(body.active);
    return { active: body.active };
  }

  @Post("keeper/trigger/:job")
  @HttpCode(200)
  @ApiOperation({
    summary: "Manually trigger a keeper job (expiry | dispute | liquidity)",
  })
  async triggerKeeperJob(@Param("job") job: string) {
    if (!["expiry", "dispute", "liquidity"].includes(job)) {
      throw new BadRequestException(
        "Unknown job. Valid: expiry, dispute, liquidity",
      );
    }
    await this.keeperService.triggerJob(
      job as "expiry" | "dispute" | "liquidity",
    );
    return { triggered: job };
  }

  // ── Behavioral Analytics ──────────────────────────────────────────────────
  @Get("behavioral-analytics")
  @ApiOperation({
    summary: "Aggregated user event metrics for admin dashboard",
  })
  async behavioralAnalytics() {
    const db = this.dataSource;

    const [
      eventBreakdown,
      dau,
      topPages,
      platformSplit,
      conversionFunnel,
      categoryStats,
    ] = await Promise.all([
      // Total events per type over last 30 days
      db.query(`
        SELECT "eventType", COUNT(*)::int AS count
        FROM user_events
        WHERE "createdAt" >= NOW() - INTERVAL '30 days'
        GROUP BY "eventType"
        ORDER BY count DESC
      `),

      // Daily active users (unique users who opened the app) — last 14 days
      db.query(`
        SELECT DATE("createdAt") AS date, COUNT(DISTINCT "userId")::int AS dau
        FROM user_events
        WHERE "eventType" = 'app.open'
          AND "createdAt" >= NOW() - INTERVAL '14 days'
        GROUP BY DATE("createdAt")
        ORDER BY date ASC
      `),

      // Most viewed pages (page.view events) — last 30 days
      // Exclude null pages and any that contain Telegram auth material
      db.query(`
        SELECT meta->>'page' AS page, COUNT(*)::int AS views
        FROM user_events
        WHERE "eventType" = 'page.view'
          AND "createdAt" >= NOW() - INTERVAL '30 days'
          AND meta->>'page' IS NOT NULL
          AND meta->>'page' NOT LIKE '%tgWebApp%'
          AND meta->>'page' NOT LIKE '%initData%'
          AND meta->>'page' NOT LIKE '%query_id%'
        GROUP BY meta->>'page'
        ORDER BY views DESC
        LIMIT 6
      `),

      // TMA vs PWA split — last 30 days
      db.query(`
        SELECT platform, COUNT(DISTINCT "userId")::int AS users
        FROM user_events
        WHERE "createdAt" >= NOW() - INTERVAL '30 days'
          AND platform IS NOT NULL
        GROUP BY platform
      `),

      // Onboarding funnel: app opens → market views → bet modal opens
      db.query(`
        SELECT
          COUNT(DISTINCT CASE WHEN "eventType" = 'app.open' THEN "userId" END)::int AS opened,
          COUNT(DISTINCT CASE WHEN "eventType" = 'market.view' THEN "userId" END)::int AS viewed_market,
          COUNT(DISTINCT CASE WHEN "eventType" = 'bet.modal.open' THEN "userId" END)::int AS opened_bet_modal
        FROM user_events
        WHERE "createdAt" >= NOW() - INTERVAL '30 days'
      `),

      // Category betting stats — bets placed, unique bettors, total volume per category
      db.query(`
        SELECT
          m.category,
          COUNT(p.id)::int                          AS bets,
          COUNT(DISTINCT p."userId")::int           AS bettors,
          COALESCE(SUM(p.amount), 0)::float         AS volume
        FROM positions p
        JOIN markets m ON m.id = p."marketId"
        WHERE p."placedAt" >= NOW() - INTERVAL '30 days'
        GROUP BY m.category
        ORDER BY volume DESC
      `),
    ]);

    return {
      eventBreakdown,
      dau,
      topPages,
      platformSplit,
      conversionFunnel: conversionFunnel[0] ?? {
        opened: 0,
        viewed_market: 0,
        opened_bet_modal: 0,
      },
      categoryStats,
    };
  }
}
