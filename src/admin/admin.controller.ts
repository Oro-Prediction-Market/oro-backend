import {
  Controller,
  Post,
  Get,
  Put,
  Param,
  Body,
  Query,
  UseGuards,
  Patch,
  HttpCode,
  Delete,
  Request,
  Res,
  NotFoundException,
  BadRequestException,
  ParseUUIDPipe,
  HttpStatus,
} from "@nestjs/common";
import type { Response } from "express";
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
import { Repository, DataSource, In } from "typeorm";
import { JwtAuthGuard, AdminGuard } from "../auth/guards";
import {
  MarketsService,
  CreateMarketDto,
  UpdateMarketDto,
  ReopenMarketDto,
} from "../markets/markets.service";
import { isEplUclSubcategory } from "../markets/market-notify.util";
import { CreateMarketGroupDto } from "../markets/dto/create-market-group.dto";
import { UpdateMarketGroupDto } from "../markets/dto/update-market-group.dto";
import { SuggestionsService } from "../suggestions/suggestions.service";
import { SuggestionStatus } from "../entities/market-suggestion.entity";
import { KeeperService } from "../markets/keeper.service";
import { RevenueDistributionService } from "../markets/revenue-distribution.service";
import { EplService } from "../epl/epl.service";
import {
  EPL_STAT_MARKET_META,
  EPL_STAT_SUBCATEGORIES,
  buildEplStatMarketDto,
  EplStatKey,
} from "../epl/epl-stat-markets";
import { UclService } from "../ucl/ucl.service";
import {
  UCL_STAT_MARKET_META,
  UCL_STAT_SUBCATEGORIES,
  buildUclStatMarketDto,
  UclStatKey,
} from "../ucl/ucl-stat-markets";
import { DistributionStatus } from "../entities/revenue-distribution.entity";
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
import { AddOutcomeDto } from "./dto/add-outcome.dto";
import { SetOutcomeEliminatedDto } from "./dto/set-outcome-eliminated.dto";
import { ResolveDto } from "./dto/resolve.dto";
import { ProposeResolutionDto } from "./dto/propose-resolution.dto";
import { GetUsersQueryDto } from "./dto/get-users-query.dto";
import { ToggleAdminDto } from "./dto/toggle-admin.dto";
import { HealthCheckResponse } from "./dto/health-check.dto";
import { csvCell } from "../shared/utils/csv.util";
import { buildLateMoneyStats, LateMoneyStats } from "./late-money.util";
import { BTN_CURRENCY } from "../entities/transaction.entity";
import { MarketBookService } from "../markets/market-book.service";
import {
  accountCurrency,
  ledgerBalance,
} from "../shared/utils/ledger.util";

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
    private readonly marketBooks: MarketBookService,
    private marketsService: MarketsService,
    private suggestionsService: SuggestionsService,
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
    private revenueDistributionService: RevenueDistributionService,
    private eplService: EplService,
    private uclService: UclService,
  ) {}

  // ── Late-money monitor (REAL aggregation — no random/demo data) ────────────
  @Get("markets/:id/late-money")
  @ApiOperation({
    summary:
      "Real late-money stats for a market: share of bets (count & amount) in the final window before close",
  })
  @ApiQuery({ name: "windowMinutes", required: false, example: 1 })
  async getLateMoney(
    @Param("id") id: string,
    @Query("windowMinutes") windowMinutesRaw?: string,
  ): Promise<LateMoneyStats> {
    const market = await this.dataSource
      .getRepository(Market)
      .findOne({ where: { id } });
    if (!market) throw new NotFoundException("Market not found");

    // Clamp the window to a sane 1–60 minutes.
    const windowMinutes = Math.min(
      60,
      Math.max(1, Math.floor(Number(windowMinutesRaw)) || 1),
    );
    const closesAt = market.closesAt ? new Date(market.closesAt) : null;
    // Final window = the last N minutes before close; a bet with createdAt at or
    // after this boundary counts as "late". Null when the market has no close.
    const windowStart = closesAt
      ? new Date(closesAt.getTime() - windowMinutes * 60_000)
      : null;

    const qb = this.betRepo
      .createQueryBuilder("p")
      .select("COUNT(*)", "totalBets")
      .addSelect("COALESCE(SUM(p.amount), 0)", "totalAmount")
      .addSelect(
        windowStart
          ? "COUNT(*) FILTER (WHERE p.placedAt >= :windowStart)"
          : "0",
        "windowBets",
      )
      .addSelect(
        windowStart
          ? "COALESCE(SUM(p.amount) FILTER (WHERE p.placedAt >= :windowStart), 0)"
          : "0",
        "windowAmount",
      )
      .where("p.marketId = :id", { id });
    if (windowStart) qb.setParameter("windowStart", windowStart.toISOString());

    const row = await qb.getRawOne<{
      totalBets: string;
      totalAmount: string;
      windowBets: string;
      windowAmount: string;
    }>();

    return buildLateMoneyStats(
      {
        totalBets: Number(row?.totalBets ?? 0),
        totalAmount: Number(row?.totalAmount ?? 0),
        windowBets: Number(row?.windowBets ?? 0),
        windowAmount: Number(row?.windowAmount ?? 0),
      },
      {
        marketId: id,
        status: market.status,
        windowMinutes,
        closesAt,
        now: Date.now(),
        alertThresholdPct: 40,
      },
    );
  }

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
    // Settled pool and house income — sourced from settlements table (actual
    // recorded amounts) so this matches the Reconciliation panel exactly.
    // Thin-pool refunded markets have houseAmount=0 in settlements; using the
    // markets table formula (totalPool × houseEdgePct) would overstate by the
    // theoretical take on those refunded pools.
    const settledResult = await this.dataSource.query(`
      SELECT
        COALESCE(SUM(s."totalPool"), 0)   AS "settledPool",
        COALESCE(SUM(s."houseAmount"), 0) AS "houseIncome",
        COUNT(*)                          AS "settledCount"
      FROM (
        SELECT DISTINCT ON (sel."marketId") sel.*
        FROM settlements sel
        INNER JOIN markets m ON m.id = sel."marketId"
        WHERE sel.currency = 'BTN'
        ORDER BY sel."marketId", sel."settledAt" ASC, sel.id ASC
      ) s
    `);
    // Active pool (open + closed + resolving + resolved)
    const activeResult = await this.dataSource.query(`
      SELECT COALESCE(SUM("totalPool"), 0) AS "activePool",
             COUNT(*) AS "activeCount"
      FROM markets WHERE status IN ('open','closed','resolving','resolved')
    `);
    // Total all-time volume — exclude cancelled markets (pools were refunded, not real volume).
    // Count includes all markets ever created.
    const allTimeResult = await this.dataSource.query(`
      SELECT
        COALESCE(SUM(CASE WHEN status != 'cancelled' THEN "totalPool" ELSE 0 END), 0) AS "allTimeVolume",
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
          WHERE pt.currency = 'BTN'
            AND pt.type = 'bet_payout'
            AND pt."isBonus" = false
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
      WHERE t.currency = 'BTN'
    `);
    // Current outstanding bonus balance across all users
    const bonusBalanceResult = await this.dataSource.query(`
      SELECT COALESCE(SUM("bonusBalance"), 0) AS "outstandingBonusBalance"
      FROM users
    `);

    // Marketing cost: real Nu the platform hands out as promotional rewards.
    // These are credited to users as isBonus=false transactions (they spend like
    // real money) but have no external deposit backing — they are a pure platform
    // expense. Three programmes today:
    //   • referral  → referral_bonus (Nu 25 + 5% of first bet) + referral_prize
    //   • streak    → streak_bonus (Day-7 boost)
    //   • season    → season_prize
    const marketingResult = await this.dataSource.query(`
      SELECT
        COALESCE(SUM(CASE WHEN type IN ('referral_bonus','referral_prize') THEN amount ELSE 0 END), 0)::float AS "referral",
        COALESCE(SUM(CASE WHEN type = 'streak_bonus' THEN amount ELSE 0 END), 0)::float AS "streak",
        COALESCE(SUM(CASE WHEN type = 'season_prize' THEN amount ELSE 0 END), 0)::float AS "season",
        COUNT(*)::int AS "count"
      FROM transactions
      WHERE currency = 'BTN'
        AND type IN ('referral_bonus','referral_prize','streak_bonus','season_prize')
        AND "isBonus" = false
    `);
    const marketingReferral = parseFloat(marketingResult[0].referral);
    const marketingStreak = parseFloat(marketingResult[0].streak);
    const marketingSeason = parseFloat(marketingResult[0].season);

    // ── USDT book ─────────────────────────────────────────────────────────────
    // The BTN figures above come from markets.totalPool (the ngultrum book) and
    // BTN settlements. The USDT book is segregated: its pools live in
    // market_books (currency='USDT') and its house income in USDT settlements.
    const usdtSettled = await this.dataSource.query(`
      SELECT
        COALESCE(SUM(s."totalPool"), 0)   AS "settledPool",
        COALESCE(SUM(s."houseAmount"), 0) AS "houseIncome",
        COUNT(*)                          AS "settledCount"
      FROM (
        SELECT DISTINCT ON (sel."marketId") sel.*
        FROM settlements sel
        INNER JOIN markets m ON m.id = sel."marketId"
        WHERE sel.currency = 'USDT'
        ORDER BY sel."marketId", sel."settledAt" ASC, sel.id ASC
      ) s
    `);
    const usdtActive = await this.dataSource.query(`
      SELECT COALESCE(SUM(mb."totalPool"), 0) AS "activePool",
             COUNT(*) AS "activeCount"
      FROM market_books mb
      INNER JOIN markets m ON m.id = mb."marketId"
      WHERE mb.currency = 'USDT'
        AND m.status IN ('open','closed','resolving','resolved')
    `);
    const usdtAllTime = await this.dataSource.query(`
      SELECT
        COALESCE(SUM(CASE WHEN m.status != 'cancelled' THEN mb."totalPool" ELSE 0 END), 0) AS "allTimeVolume",
        COUNT(*) AS "totalMarkets"
      FROM market_books mb
      INNER JOIN markets m ON m.id = mb."marketId"
      WHERE mb.currency = 'USDT'
    `);

    return {
      houseIncome: parseFloat(settledResult[0].houseIncome),
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
      // Marketing cost: promotional rewards credited to users as real spendable
      // money (isBonus=false) with no deposit backing — a pure platform expense.
      marketing: {
        total: marketingReferral + marketingStreak + marketingSeason,
        referral: marketingReferral,
        streak: marketingStreak,
        season: marketingSeason,
        count: parseInt(marketingResult[0].count, 10),
      },
      // USDT book — same shape as the BTN figures above, in USDT.
      usdt: {
        houseIncome: parseFloat(usdtSettled[0].houseIncome),
        settledPool: parseFloat(usdtSettled[0].settledPool),
        settledCount: parseInt(usdtSettled[0].settledCount, 10),
        activePool: parseFloat(usdtActive[0].activePool),
        activeCount: parseInt(usdtActive[0].activeCount, 10),
        allTimeVolume: parseFloat(usdtAllTime[0].allTimeVolume),
        totalMarkets: parseInt(usdtAllTime[0].totalMarkets, 10),
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
    // NOTE: Channel announcement is no longer sent automatically on create.
    // Use POST /admin/markets/:id/announce to broadcast a market when desired.
    return market;
  }

  @Post("markets/group")
  @ApiOperation({
    summary:
      "Create a grouped multi-binary event: one Yes/No child market per candidate, sharing a groupId",
  })
  async createMarketGroup(
    @Body() dto: CreateMarketGroupDto,
    @Request() req: any,
  ) {
    const markets = await this.marketsService.createGroup(dto);
    await this.auditService.log({
      adminId: req.user.userId,
      isAdmin: true,
      action: AuditAction.MARKET_CREATE,
      entityType: "market-group",
      entityId: markets[0]?.groupId ?? "",
      after: {
        title: dto.title,
        candidates: dto.candidates.map((c) => c.name),
        closesAt: dto.closesAt,
        marketIds: markets.map((m) => m.id),
      },
      ipAddress: req.ip,
    });
    return markets;
  }

  @Get("markets/group/:groupId")
  @ApiOperation({
    summary: "Fetch all sibling candidate markets in a grouped event",
  })
  async getMarketGroup(@Param("groupId") groupId: string) {
    return this.marketsService.findGroup(groupId);
  }

  @Patch("markets/group/:groupId")
  @ApiOperation({
    summary:
      "Edit a grouped event at once: shared fields fan out to every candidate; per-candidate name/image applied individually",
  })
  async updateMarketGroup(
    @Param("groupId") groupId: string,
    @Body() dto: UpdateMarketGroupDto,
    @Request() req: any,
  ) {
    const before = await this.marketsService.findGroup(groupId);
    const markets = await this.marketsService.updateGroup(groupId, dto);
    await this.auditService.log({
      adminId: req.user.userId,
      isAdmin: true,
      action: AuditAction.MARKET_TRANSITION, // reuse closest action; no MARKET_UPDATE exists
      entityType: "market-group",
      entityId: groupId,
      before: {
        title: before[0]?.groupTitle,
        candidates: before.map((m) => m.title),
      },
      after: {
        title: markets[0]?.groupTitle,
        candidates: markets.map((m) => m.title),
      },
      meta: {
        fields: Object.keys(dto).filter((k) => (dto as any)[k] !== undefined),
      },
      ipAddress: req.ip,
    });
    return markets;
  }

  // ── Market suggestions (Oracle Orbit review + publish) ──────────────────────

  @Get("suggestions")
  @ApiOperation({
    summary:
      "List market suggestions with vote counts (optional ?status= and ?sort=votes|latest)",
  })
  async listSuggestions(
    @Query("status") status?: string,
    @Query("sort") sort?: string,
  ) {
    const valid = status
      ? (Object.values(SuggestionStatus) as string[]).includes(status)
        ? (status as SuggestionStatus)
        : undefined
      : undefined;
    const validSort = sort === "latest" ? "latest" : "votes";
    return this.suggestionsService.listForAdmin(valid, validSort);
  }

  @Patch("suggestions/:id/review")
  @ApiOperation({
    summary: "Approve or reject a market suggestion from the dashboard",
  })
  async reviewSuggestion(
    @Param("id") id: string,
    @Body("approve") approve: boolean,
    @Request() req: any,
  ) {
    const result = await this.suggestionsService.reviewByAdmin(id, !!approve);
    await this.auditService.log({
      adminId: req.user.userId,
      isAdmin: true,
      action: AuditAction.MARKET_TRANSITION,
      entityType: "market-suggestion",
      entityId: id,
      after: { status: result.status, title: result.title },
      ipAddress: req.ip,
    });
    return result;
  }

  @Post("suggestions/:id/publish")
  @ApiOperation({
    summary:
      "Create a real market from a suggestion and mark the suggestion published",
  })
  async publishSuggestion(
    @Param("id") id: string,
    @Body() dto: CreateMarketDto,
    @Request() req: any,
  ) {
    const market = await this.marketsService.create(dto);
    const suggestion = await this.suggestionsService.markPublished(
      id,
      market.id,
    );
    await this.auditService.log({
      adminId: req.user.userId,
      isAdmin: true,
      action: AuditAction.MARKET_CREATE,
      entityType: "market-suggestion",
      entityId: id,
      after: {
        marketId: market.id,
        title: market.title,
        suggestionStatus: suggestion.status,
      },
      ipAddress: req.ip,
    });
    return market;
  }

  // ⚠️ DO NOT DELETE THIS ENDPOINT.
  // Channel announcement was intentionally removed from createMarket so that
  // creating a market no longer spams the Telegram channel. This endpoint is
  // the *only* way to broadcast a market to the channel now — it is triggered
  // manually by an admin (the 📣 Announce button in Market Management). Removing
  // it would leave admins with no way to announce new markets at all.
  @Post("markets/:id/announce")
  @ApiOperation({ summary: "Announce a market to the Telegram channel" })
  async announceMarket(@Param("id") id: string, @Request() req: any) {
    const market = await this.marketsService.findOne(id);
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
    await this.auditService.log({
      adminId: req.user.userId,
      isAdmin: true,
      action: AuditAction.MARKET_UPDATE,
      entityType: "market",
      entityId: market.id,
      after: { announced: true, title: market.title },
      ipAddress: req.ip,
    });
    return { success: true };
  }

  @Get("markets")
  @ApiOperation({ summary: "List all markets (admin view) with pagination" })
  @ApiQuery({ name: "page", required: false, type: Number })
  @ApiQuery({ name: "limit", required: false, type: Number })
  @ApiQuery({ name: "status", required: false, type: String })
  @ApiQuery({
    name: "externalSource",
    required: false,
    type: String,
    description:
      "Filter by externalSource. Use 'none' to get markets with no externalSource.",
  })
  async listMarkets(
    @Query("page") page = "1",
    @Query("limit") limit = "20",
    @Query("status") status?: string,
    @Query("externalSource") externalSource?: string,
    @Query("excludeSources") excludeSources?: string,
    @Query("category") category?: string,
    @Query("subcategory") subcategory?: string,
    @Query("search") search?: string,
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
    if (category && category.toLowerCase() !== "all") {
      qb.andWhere("market.category = :category", { category });
    }
    if (subcategory && subcategory.toLowerCase() !== "all") {
      qb.andWhere("market.subcategory = :subcategory", { subcategory });
    }
    const q = search?.trim();
    if (q) {
      qb.andWhere("LOWER(market.title) LIKE :q", {
        q: `%${q.toLowerCase()}%`,
      });
    }
    if (status && status.toLowerCase() !== "all") {
      const s = status.toLowerCase();
      // Resolving a market immediately settles it (payout runs in the same step),
      // so every finished market ends up `settled` regardless of whether it was
      // disputed. Split the two finished-market tabs by whether an objection was
      // raised: "Resolved" = had a dispute that was adjudicated, "Settled" = clean
      // resolution with no objection. Each finished market shows in exactly one tab.
      const FINISHED = ["resolved", "settled"];
      const HAD_DISPUTE = `EXISTS (SELECT 1 FROM disputes d WHERE d."marketId" = market.id)`;
      if (s === "resolved") {
        qb.andWhere("market.status IN (:...statuses)", { statuses: FINISHED });
        qb.andWhere(HAD_DISPUTE);
      } else if (s === "settled") {
        qb.andWhere("market.status IN (:...statuses)", { statuses: FINISHED });
        qb.andWhere(`NOT ${HAD_DISPUTE}`);
      } else {
        qb.andWhere("market.status = :status", { status: s });
      }
    }
    if (externalSource === "none") {
      qb.andWhere("market.externalSource IS NULL");
    } else if (externalSource) {
      qb.andWhere("market.externalSource = :externalSource", {
        externalSource,
      });
    }
    // Hide specific auto-generated sources (e.g. btc,ter) while still showing
    // manual (NULL source) and imported markets — a NULL source is kept.
    const exclude = excludeSources
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (exclude?.length) {
      qb.andWhere(
        "(market.externalSource IS NULL OR market.externalSource NOT IN (:...exclude))",
        { exclude },
      );
    }
    const [data, total] = await qb.getManyAndCount();
    await this.marketsService.attachBooksTo(data);
    return {
      data,
      total,
      page: Math.max(Number(page), 1),
      pages: Math.ceil(total / take) || 1,
    };
  }

  @Get("markets/settled/zero-pool")
  @ApiOperation({ summary: "List settled markets with zero pool volume" })
  getZeroPoolSettledMarkets() {
    return this.marketsService.getZeroPoolSettled();
  }

  @Get("markets/stats")
  @ApiOperation({
    summary:
      "Dashboard KPIs aggregated over ALL markets (not a single page): open count, open pool volume, unsettled count",
  })
  async marketStats() {
    const repo = this.dataSource.getRepository(Market);
    // Exclude the algorithmic auto-markets (BTC / TER tickers). They open and
    // settle on their own every few minutes, so counting them makes these KPIs
    // noisy and makes them disagree with the market lists (which already hide
    // them via externalSource=none). NOTE: a NULL externalSource is a real,
    // admin-managed market and MUST be kept — so we can't use a bare NOT IN,
    // because `NULL NOT IN (...)` evaluates to NULL and would drop those rows.
    const AUTO_SOURCES = ["btc", "ter"];
    const excludeAuto =
      "(m.externalSource IS NULL OR m.externalSource NOT IN (:...auto))";

    const [activeMarkets, unsettledMarkets, poolRow] = await Promise.all([
      repo
        .createQueryBuilder("m")
        .where("m.status = :s", { s: MarketStatus.OPEN })
        .andWhere(excludeAuto, { auto: AUTO_SOURCES })
        .getCount(),
      // "Unsettled" = betting has stopped but the result isn't in yet: markets
      // waiting to be resolved. (Once resolved, payout runs in the same step.)
      repo
        .createQueryBuilder("m")
        .where("m.status IN (:...st)", {
          st: [MarketStatus.CLOSED, MarketStatus.RESOLVING],
        })
        .andWhere(excludeAuto, { auto: AUTO_SOURCES })
        .getCount(),
      repo
        .createQueryBuilder("m")
        .select("COALESCE(SUM(m.totalPool), 0)", "sum")
        .where("m.status = :s", { s: MarketStatus.OPEN })
        .andWhere(excludeAuto, { auto: AUTO_SOURCES })
        .getRawOne<{ sum: string }>(),
    ]);
    return {
      activeMarkets,
      unsettledMarkets,
      totalPoolVolume: Number(poolRow?.sum ?? 0),
    };
  }

  @Delete("markets/cleanup/zero-pool-settled")
  @ApiOperation({ summary: "Delete all settled markets with zero pool volume" })
  async purgeZeroPoolSettled(@Request() req: any) {
    const count = await this.marketsService.deleteZeroPoolSettled();
    await this.auditService.log({
      adminId: req.user.userId,
      isAdmin: true,
      action: AuditAction.MARKET_DELETE,
      entityType: "market",
      entityId: "bulk-zero-pool-settled",
      before: { count },
      ipAddress: req.ip,
    });
    return { deleted: count };
  }

  // Must stay above `markets/:id` — Nest matches in declaration order, so a
  // literal segment declared after the param route is swallowed by it.
  @Get("markets/stats")
  @ApiOperation({ summary: "Dashboard counters: active, unsettled, pool volume" })
  async getMarketStats() {
    const marketRepo = this.dataSource.getRepository(Market);
    const [activeMarkets, unsettledMarkets, poolRow] = await Promise.all([
      marketRepo.count({ where: { status: MarketStatus.OPEN } }),
      // Trading is over but money hasn't been paid out yet.
      marketRepo.count({
        where: [
          { status: MarketStatus.CLOSED },
          { status: MarketStatus.RESOLVING },
          { status: MarketStatus.RESOLVED },
        ],
      }),
      marketRepo
        .createQueryBuilder("m")
        .select("COALESCE(SUM(m.totalPool), 0)", "total")
        .where("m.status != :cancelled", {
          cancelled: MarketStatus.CANCELLED,
        })
        .getRawOne<{ total: string }>(),
    ]);

    return {
      activeMarkets,
      unsettledMarkets,
      totalPoolVolume: Number(poolRow?.total ?? 0),
    };
  }

  @Get("markets/:id")
  @ApiOperation({ summary: "Get market details" })
  getMarket(@Param("id", ParseUUIDPipe) id: string) {
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

  @Post("markets/:id/outcomes")
  @ApiOperation({
    summary:
      "Add a new outcome to a market (allowed while Upcoming or Open)",
  })
  async addOutcome(
    @Param("id") id: string,
    @Body() dto: AddOutcomeDto,
    @Request() req: any,
  ) {
    const before = await this.marketsService.findOne(id);
    const result = await this.marketsService.addOutcome(
      id,
      dto.label,
      dto.imageUrl ?? null,
    );
    await this.auditService.log({
      adminId: req.user.userId,
      isAdmin: true,
      action: AuditAction.MARKET_TRANSITION, // reuse closest action; no MARKET_UPDATE exists
      entityType: "market",
      entityId: id,
      before: { outcomes: before.outcomes?.map((o) => o.label) },
      after: { outcomes: result.outcomes?.map((o) => o.label) },
      meta: { addedOutcome: dto.label },
      ipAddress: req.ip,
    });
    return result;
  }

  @Patch("markets/:id/outcomes/:outcomeId/eliminated")
  @ApiOperation({
    summary:
      "Mark an outcome as eliminated (stops new bets on it) or restore it",
  })
  async setOutcomeEliminated(
    @Param("id") id: string,
    @Param("outcomeId") outcomeId: string,
    @Body() dto: SetOutcomeEliminatedDto,
    @Request() req: any,
  ) {
    const before = await this.marketsService.findOne(id);
    const beforeOutcome = before.outcomes?.find((o) => o.id === outcomeId);
    const result = await this.marketsService.setOutcomeEliminated(
      id,
      outcomeId,
      dto.isEliminated,
    );
    await this.auditService.log({
      adminId: req.user.userId,
      isAdmin: true,
      action: AuditAction.MARKET_TRANSITION, // reuse closest action; no MARKET_UPDATE exists
      entityType: "market",
      entityId: id,
      before: { outcomeId, isEliminated: beforeOutcome?.isEliminated },
      after: { outcomeId, isEliminated: dto.isEliminated },
      meta: { outcomeLabel: beforeOutcome?.label, outcomeId },
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

  @Post("markets/:id/reopen")
  @HttpCode(200)
  @ApiOperation({
    summary:
      "Reopen a closed World Cup hub market (subcategory wc-*) with a new future closesAt. " +
      "Only allowed from Closed, before any resolution is proposed.",
  })
  @ApiResponse({ status: 200, type: Market })
  async reopenMarket(
    @Param("id") id: string,
    @Body() dto: ReopenMarketDto,
    @Request() req: any,
  ) {
    const before = await this.marketsService.findOne(id);
    const result = await this.marketsService.reopen(id, dto);
    await this.auditService.log({
      adminId: req.user.userId,
      isAdmin: true,
      action: AuditAction.MARKET_TRANSITION,
      entityType: "market",
      entityId: id,
      before: { status: before.status, closesAt: before.closesAt },
      after: { status: "open", closesAt: dto.closesAt },
      meta: { title: before.title, reopened: true },
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
    // OBJECTION WINDOW ANNOUNCEMENT — intentionally disabled.
    // We no longer post to the Telegram channel when the objection window opens.
    // Proposing an outcome opens the window silently; the final outcome is still
    // announced when the market settles (see resolveMarket). Kept here (commented)
    // so it can be re-enabled if we ever want to announce the window again.
    // const miniAppUrl = process.env.TELEGRAM_MINI_APP_URL || "";
    // const marketDeepLink = miniAppUrl ? `${miniAppUrl}?startapp=m_${id}` : "";
    // const windowLabel =
    //   windowMinutes >= 60
    //     ? `${windowMinutes / 60} hour${windowMinutes > 60 ? "s" : ""}`
    //     : `${windowMinutes} minutes`;
    // await this.telegramSimple.postToChannel(
    //   `⚖️ <b>OBJECTION WINDOW OPEN</b>\n\n` +
    //     `📊 <b>${before.title}</b>\n\n` +
    //     `🔖 <b>Proposed Winner:</b> ${proposedOutcome?.label ?? "N/A"}\n` +
    //     `⏳ Window: ${windowLabel} — object if you disagree\n` +
    //     `💡 Evidence will be published when the market is settled.\n\n` +
    //     `👉 <a href="${marketDeepLink || miniAppUrl}">View Market</a>`,
    // );
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
    // WINNER ANNOUNCEMENT — intentional for admin-created / one-off markets.
    // Posting the final winner + evidence when a market settles is a deliberate,
    // one-time-per-market event triggered by the admin resolving it, so it is
    // not noisy and users expect it. Keep posting it automatically here. Do not
    // remove it along with the create-time announcement cleanup.
    //
    // EXCEPTION: EPL/UCL markets are excluded — they settle constantly (one per
    // fixture) and predictors already get an individual result DM, so a channel
    // post per football result is just noise.
    if (!isEplUclSubcategory(before.subcategory)) {
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
    }
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

  @Get("platform-accuracy")
  @ApiOperation({
    summary:
      "Platform accuracy trend: per-settlement ratio of winning-outcome pool to total pool, grouped by week.",
  })
  async getPlatformAccuracy() {
    // For each settled market (deduplicated), compute what fraction of the
    // total bet pool landed on the winning outcome. Average across all markets
    // gives the overall crowd accuracy; weekly grouping gives the trend line.
    const rows = await this.dataSource.query(`
      WITH canonical AS (
        SELECT DISTINCT ON (s."marketId")
          s."marketId",
          s."winningOutcomeId",
          s."totalPool",
          s."settledAt"
        FROM settlements s
        INNER JOIN markets m ON m.id = s."marketId"
        WHERE s."cancelReason" IS NULL
          AND s."totalPool" > 0
        ORDER BY s."marketId", s."settledAt" ASC
      ),
      with_winner AS (
        SELECT
          c."marketId",
          c."settledAt",
          c."totalPool",
          o."totalBetAmount" AS "winnerPool"
        FROM canonical c
        INNER JOIN outcomes o
          ON o.id = c."winningOutcomeId"
          AND o."marketId" = c."marketId"
      )
      SELECT
        TO_CHAR(DATE_TRUNC('week', "settledAt"), 'YYYY-MM-DD') AS week,
        COUNT(*)::int AS "marketCount",
        ROUND(AVG("winnerPool"::numeric / "totalPool"::numeric) * 100, 1) AS "avgAccuracyPct"
      FROM with_winner
      GROUP BY DATE_TRUNC('week', "settledAt")
      ORDER BY DATE_TRUNC('week', "settledAt") ASC
    `);

    const overall = await this.dataSource.query(`
      WITH canonical AS (
        SELECT DISTINCT ON (s."marketId")
          s."winningOutcomeId",
          s."totalPool",
          s."marketId"
        FROM settlements s
        INNER JOIN markets m ON m.id = s."marketId"
        WHERE s."cancelReason" IS NULL
          AND s."totalPool" > 0
        ORDER BY s."marketId", s."settledAt" ASC
      )
      SELECT
        COUNT(*)::int AS "totalMarkets",
        ROUND(AVG(o."totalBetAmount"::numeric / c."totalPool"::numeric) * 100, 1) AS "overallAccuracyPct"
      FROM canonical c
      INNER JOIN outcomes o
        ON o.id = c."winningOutcomeId"
        AND o."marketId" = c."marketId"
    `);

    return {
      overallAccuracyPct: Number(overall[0]?.overallAccuracyPct ?? 0),
      totalMarkets: Number(overall[0]?.totalMarkets ?? 0),
      trend: rows.map((r: any) => ({
        week: r.week,
        marketCount: r.marketCount,
        avgAccuracyPct: Number(r.avgAccuracyPct),
      })),
    };
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
      currency = "all",
      sortField = "joined",
      sortDir = "desc",
      page = 1,
      limit = 20,
    } = query;

    const qb = this.userRepo
      .createQueryBuilder("u")
      .leftJoin(
        "linked_bank_accounts",
        "lba",
        'lba."userId" = u.id AND lba."isDefault" = true AND lba."isVerified" = true',
      )
      .leftJoin("users", "ref", 'ref.id = u."referredByUserId"')
      .select([
        "u.id",
        "u.firstName",
        "u.lastName",
        "u.username",
        "u.photoUrl",
        "u.isAdmin",
        "u.telegramId",
        "u.telegramChatId",
        "u.betStreakCount",
        "u.telegramLinkedAt",
        "u.reputationTier",
        "u.totalPredictions",
        "u.referredByUserId",
        "u.createdAt",
        "u.updatedAt",
      ])
      .addSelect('COALESCE(lba.cid, u."dkCid")', "dkCid")
      .addSelect(
        'COALESCE(lba."accountNumber", u."dkAccountNumber")',
        "dkAccountNumber",
      )
      .addSelect(
        'COALESCE(lba."accountName", u."dkAccountName")',
        "dkAccountName",
      )
      .addSelect(
        `NULLIF(TRIM(COALESCE(ref."firstName", '') || ' ' || COALESCE(ref."lastName", '')), '')`,
        "referredByName",
      )
      .addSelect("ref.username", "referredByUsername")
      .addSelect("ref.telegramId", "referredByTelegramId");

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
          OR LOWER(COALESCE(lba.cid,''))         LIKE :term ESCAPE '\\'
          OR LOWER(COALESCE(lba."accountName",'')) LIKE :term ESCAPE '\\'
          OR LOWER(u.id::text)                   LIKE :term ESCAPE '\\'
        )`,
        { term },
      );
    }

    // ── Currency filter ─────────────────────────────────────────────────────
    // Older rows predate the column and were all ngultrum, so BTN has to
    // include NULL or the list loses everyone who joined before the USDT rail.
    if (currency === "BTN") {
      qb.andWhere("(u.currency = :cur OR u.currency IS NULL)", { cur: "BTN" });
    } else if (currency === "USDT") {
      qb.andWhere("u.currency = :cur", { cur: "USDT" });
    }

    // ── Role filter ─────────────────────────────────────────────────────────
    if (role === "admin")
      qb.andWhere("u.isAdmin = :isAdmin", { isAdmin: true });
    if (role === "user")
      qb.andWhere("u.isAdmin = :isAdmin", { isAdmin: false });

    // ── DK-link filter ──────────────────────────────────────────────────────
    if (dkStatus === "linked")
      qb.andWhere("(u.dkCid IS NOT NULL OR lba.cid IS NOT NULL)");
    if (dkStatus === "unlinked")
      qb.andWhere("u.dkCid IS NULL AND lba.cid IS NULL");

    // ── Sort ────────────────────────────────────────────────────────────────
    const dir = sortDir.toUpperCase() as "ASC" | "DESC";
    if (sortField === "name") {
      qb.orderBy(
        "LOWER(COALESCE(u.firstName,'') || ' ' || COALESCE(u.lastName,''))",
        dir,
      );
    } else if (sortField === "streak") {
      qb.orderBy("COALESCE(u.betStreakCount, 0)", dir);
    } else {
      // joined (default)
      qb.orderBy("u.createdAt", dir);
    }

    // ── Pagination ──────────────────────────────────────────────────────────
    const take = Math.min(Number(limit), 100);
    const skip = (Math.max(Number(page), 1) - 1) * take;

    qb.skip(skip).take(take);

    const total = await qb.getCount();
    const { entities, raw } = await qb.getRawAndEntities();

    // Merge COALESCE'd DK Bank fields from raw results into entity objects
    const data = entities.map((user, i) => ({
      ...user,
      dkCid: raw[i]?.dkCid ?? user.dkCid ?? null,
      dkAccountNumber: raw[i]?.dkAccountNumber ?? user.dkAccountNumber ?? null,
      dkAccountName: raw[i]?.dkAccountName ?? user.dkAccountName ?? null,
      // Referrer (who referred this user) — null for organic sign-ups
      referredByUserId: user.referredByUserId ?? null,
      referredByName: raw[i]?.referredByName ?? null,
      referredByUsername: raw[i]?.referredByUsername ?? null,
      referredByTelegramId: raw[i]?.referredByTelegramId ?? null,
    }));

    return {
      data,
      total,
      page: Math.max(Number(page), 1),
      limit: take,
      pages: Math.ceil(total / take),
    };
  }

  @Get("usdt/users")
  @ApiOperation({ summary: "Accounts holding or moving USDT, with balances" })
  async listUsdtUsers(@Query("limit") limit?: string) {
    const take = Math.min(Number(limit) || 100, 500);

    const rows = await this.dataSource.query(
      `
      SELECT
        u.id,
        u."firstName",
        u."lastName",
        u.email,
        u.currency                                   AS "nativeCurrency",
        u."kycStatus",
        u."createdAt",
        COALESCE(bal.balance, 0)                     AS "usdtBalance",
        COALESCE(dep.total, 0)                       AS "deposited",
        COALESCE(stake.total, 0)                     AS "staked",
        COALESCE(wd.completed, 0)                    AS "withdrawn",
        COALESCE(wd.in_flight, 0)                    AS "inFlight",
        COALESCE(wd.pending, 0)                      AS "pendingWithdrawal",
        COALESCE(wd.pending_count, 0)                AS "pendingWithdrawalCount"
      FROM users u
      LEFT JOIN (
        SELECT "userId", SUM(amount) AS balance
        FROM transactions WHERE currency = 'USDT' GROUP BY "userId"
      ) bal ON bal."userId" = u.id
      LEFT JOIN (
        SELECT "userId", SUM(amount) AS total
        FROM transactions WHERE currency = 'USDT' AND type = 'deposit'
        GROUP BY "userId"
      ) dep ON dep."userId" = u.id
      LEFT JOIN (
        SELECT "userId", SUM(ABS(amount)) AS total
        FROM transactions WHERE currency = 'USDT' AND type = 'bet_placed'
        GROUP BY "userId"
      ) stake ON stake."userId" = u.id
      LEFT JOIN (
        -- Three states, not two. An approved withdrawal that 21 Pay is still
        -- broadcasting has left our ledger but has not reached the user, so
        -- counting it as "withdrawn" overstates what actually landed and
        -- hides the window where a payout can still fail.
        SELECT "userId",
          SUM(CASE WHEN "approvalStatus" = 'approved' AND "remoteStatus" = 'completed'
                   THEN "amountUsdt" ELSE 0 END) AS completed,
          SUM(CASE WHEN "approvalStatus" = 'approved'
                    AND ("remoteStatus" IS DISTINCT FROM 'completed')
                   THEN "amountUsdt" ELSE 0 END) AS in_flight,
          SUM(CASE WHEN "approvalStatus" = 'pending_approval' THEN "amountUsdt" ELSE 0 END) AS pending,
          COUNT(*) FILTER (WHERE "approvalStatus" = 'pending_approval') AS pending_count
        FROM crypto_withdrawals GROUP BY "userId"
      ) wd ON wd."userId" = u.id
      WHERE u.currency = 'USDT'
         OR EXISTS (
              SELECT 1 FROM transactions t
              WHERE t."userId" = u.id AND t.currency = 'USDT'
            )
      ORDER BY COALESCE(bal.balance, 0) DESC, u."createdAt" DESC
      LIMIT $1
      `,
      [take],
    );

    const num = (v: unknown) => Number(v) || 0;
    return {
      users: rows,
      totals: {
        accounts: rows.length,
        held: rows.reduce((t: number, r: any) => t + num(r.usdtBalance), 0),
        deposited: rows.reduce((t: number, r: any) => t + num(r.deposited), 0),
        withdrawn: rows.reduce((t: number, r: any) => t + num(r.withdrawn), 0),
        inFlight: rows.reduce((t: number, r: any) => t + num(r.inFlight), 0),
        pendingWithdrawal: rows.reduce(
          (t: number, r: any) => t + num(r.pendingWithdrawal),
          0,
        ),
      },
    };
  }

  @Get("usdt/finance")
  @ApiOperation({ summary: "USDT-only financial position and custody check" })
  async usdtFinance() {
    const [settled] = await this.dataSource.query(`
      SELECT
        COALESCE(SUM(s."totalPool"), 0)   AS "settledPool",
        COALESCE(SUM(s."houseAmount"), 0) AS "houseIncome",
        COALESCE(SUM(s."totalPaidOut"), 0) AS "paidOut",
        COUNT(*)                          AS "settledCount"
      FROM settlements s
      WHERE s.currency = 'USDT'
    `);

    const [active] = await this.dataSource.query(`
      SELECT
        COALESCE(SUM(mb."totalPool"), 0) AS "activePool",
        COUNT(*) FILTER (WHERE mb."totalPool" > 0) AS "activeBooks"
      FROM market_books mb
      JOIN markets m ON m.id = mb."marketId"
      WHERE mb.currency = 'USDT'
        AND m.status IN ('open', 'closed', 'resolving', 'resolved')
    `);

    const [flow] = await this.dataSource.query(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'deposit'    THEN amount ELSE 0 END), 0) AS "deposits",
        COUNT(*) FILTER (WHERE type = 'deposit')                               AS "depositCount",
        COALESCE(SUM(CASE WHEN type = 'withdrawal' THEN -amount ELSE 0 END), 0) AS "withdrawals",
        COUNT(*) FILTER (WHERE type = 'withdrawal')                            AS "withdrawalCount",
        COALESCE(SUM(CASE WHEN type = 'bet_placed' THEN -amount ELSE 0 END), 0) AS "staked",
        -- bet_payout, not position_payout: comparing an enum column to a
        -- label that does not exist is a hard error, not an empty result.
        -- (No backticks in here — this is inside a template literal.)
        COALESCE(SUM(CASE WHEN type = 'bet_payout' THEN amount ELSE 0 END), 0) AS "payouts",
        COALESCE(SUM(amount), 0)                                               AS "heldForUsers"
      FROM transactions
      WHERE currency = 'USDT'
    `);

    const [wd] = await this.dataSource.query(`
      SELECT
        COALESCE(SUM(CASE WHEN "approvalStatus" = 'pending_approval'
                          THEN "amountUsdt" ELSE 0 END), 0) AS "pendingApproval",
        COALESCE(SUM(CASE WHEN "approvalStatus" = 'approved'
                           AND ("remoteStatus" IS DISTINCT FROM 'completed')
                          THEN "amountUsdt" ELSE 0 END), 0) AS "inFlight"
      FROM crypto_withdrawals
    `);

    const n = (v: unknown) => Number(v) || 0;

    const expectedCustody = n(flow.deposits) - n(flow.withdrawals);
    const accountedFor =
      n(flow.heldForUsers) + n(active.activePool) + n(settled.houseIncome);

    return {
      settled: {
        pool: n(settled.settledPool),
        houseIncome: n(settled.houseIncome),
        paidOut: n(settled.paidOut),
        count: n(settled.settledCount),
      },
      active: {
        pool: n(active.activePool),
        books: n(active.activeBooks),
      },
      flow: {
        deposits: n(flow.deposits),
        depositCount: n(flow.depositCount),
        withdrawals: n(flow.withdrawals),
        withdrawalCount: n(flow.withdrawalCount),
        staked: n(flow.staked),
        payouts: n(flow.payouts),
        heldForUsers: n(flow.heldForUsers),
        pendingApproval: n(wd.pendingApproval),
        inFlight: n(wd.inFlight),
      },
      custody: {
        expected: expectedCustody,
        accountedFor,
        // Should be zero. Anything else means money exists in one view and
        // not the other, which is the whole reason to compute both.
        difference: Number((expectedCustody - accountedFor).toFixed(6)),
      },
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
      // Read and write must name the same currency. Reading the account's
      // balance but writing a row that defaults to BTN would put the credit
      // somewhere the account's own balance query never looks.
      const currency = await accountCurrency(em, userId);
      const balanceBefore = await ledgerBalance(em, userId, currency);
      const balanceAfter = balanceBefore + dto.amount;

      return em.save(
        Transaction,
        em.create(Transaction, {
          type: TransactionType.DEPOSIT,
          amount: dto.amount,
          balanceBefore,
          balanceAfter,
          userId,
          currency,
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
      .where("t.currency = :currency", { currency: BTN_CURRENCY })
      .andWhere("t.isBonus = :isBonus", { isBonus: false })
      .getRawOne();

    const bonusBalanceRow = await em
      .getRepository(Transaction)
      .createQueryBuilder("t")
      .select("COALESCE(SUM(t.amount), 0)", "total")
      .where("t.currency = :currency", { currency: BTN_CURRENCY })
      .andWhere("t.isBonus = :isBonus", { isBonus: true })
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
        ORDER BY sel."marketId", sel."settledAt" ASC, sel.id ASC
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

    // Real-money portion of pending bets only (isBonus=false).
    // positions.amount includes bonus-funded bets, but totalRealBalance only
    // deducts the isBonus=false bet_placed transactions. Using the full
    // positions.amount over-subtracts by the bonus-funded pending portion.
    const pendingBetsRealRow = await em
      .getRepository(Transaction)
      .query(
        `
      SELECT COALESCE(SUM(ABS(bt.amount)), 0)::float AS total
      FROM transactions bt
      INNER JOIN positions p ON p.id = bt."positionId"
      WHERE bt.currency = 'BTN'
        AND bt.type = 'bet_placed'
        AND bt."isBonus" = false
        AND p.status = 'pending'
    `,
      )
      .then((r: any[]) => parseFloat(r[0].total))

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
    // Real-money pending bets (used in expected formula — matches totalRealBalance deduction)
    const pendingBetsRealAmount = pendingBetsRealRow;

    const netExternalFlow = totalDeposits - totalWithdrawals;

    // bonusFundedRealPayouts: real money that entered wallets without a backing
    // external deposit, due to bonus bets. Two sources:
    //
    // 1. LOSING bonus bets (isBonus=true) → their stake entered the pool and
    //    was distributed to real winners as real (isBonus=false) payouts.
    //    Query: SUM of lost bonus-tagged bet_placed amounts.
    //
    // 2. WINNING bonus bets → the bettor's own payout is tagged isBonus=false
    //    (the system does not propagate the bonus tag to payouts), so those
    //    payouts are real wallet credit with no corresponding real deposit.
    //    Query: SUM of bet_payout isBonus=false for positions that had a
    //    bonus bet_placed and ended up winning.
    //
    // Both parts represent unexplained real credits and must be added to expected.
    const bonusFundedRealPayoutsRow = await em
      .getRepository(Transaction)
      .query(
        `
      SELECT
        -- Part 1: lost bonus bets → funded real winners
        COALESCE((
          SELECT SUM(ABS(bt.amount))
          FROM transactions bt
          INNER JOIN positions p ON p.id = bt."positionId"
          WHERE bt.currency = 'BTN'
            AND bt.type = 'bet_placed'
            AND bt."isBonus" = true
            AND p.status = 'lost'
        ), 0)
        +
        -- Part 2: winning bonus bets → their own real-tagged payout
        COALESCE((
          SELECT SUM(pt.amount)
          FROM transactions pt
          INNER JOIN positions p ON p.id = pt."positionId"
          WHERE pt.currency = 'BTN'
            AND pt.type = 'bet_payout'
            AND pt."isBonus" = false
            AND p.status = 'won'
            AND EXISTS (
              SELECT 1 FROM transactions bt2
              WHERE bt2."positionId" = p.id
                AND bt2.type = 'bet_placed'
                AND bt2."isBonus" = true
            )
        ), 0)
      AS total
    `,
      )
      .then((r: any[]) => parseFloat(r[0].total))

    const totalBonusIssuedRow = await em
      .getRepository(Transaction)
      .query(
        `
      SELECT COALESCE(SUM(amount), 0)::float AS total
      FROM transactions
      WHERE currency = 'BTN' AND type = 'free_credit' AND "isBonus" = true
    `,
      )
      .then((r: any[]) => parseFloat(r[0].total));

    // Non-bonus free credits: platform-issued credits marked isBonus=false
    // These inflate totalRealBalance without a matching payment deposit
    const nonBonusFreeCreditsRow = await em
      .getRepository(Transaction)
      .query(
        `
      SELECT COALESCE(SUM(amount), 0)::float AS total
      FROM transactions
      WHERE currency = 'BTN' AND type = 'free_credit' AND "isBonus" = false
    `,
      )
      .then((r: any[]) => parseFloat(r[0].total));

    // Platform reward credits: referral bonus (Nu 25 + 5% of first bet, capped),
    // Day-7 streak boost, and season prizes. All are recorded isBonus=false (so they
    // count toward totalRealBalance) but are platform-funded — no external deposit and
    // NOT part of the settlement pool (the streak boost is deliberately excluded from
    // Settlement.totalPaidOut, see parimutuel.engine). They therefore inflate
    // totalRealBalance with no offsetting term and must be added to expected, exactly
    // like nonBonusFreeCredits. None of these types appear elsewhere in the formula, so
    // this cannot double-count.
    const platformRewardCreditsRow = await em
      .getRepository(Transaction)
      .query(
        `
      SELECT COALESCE(SUM(amount), 0)::float AS total
      FROM transactions
      WHERE currency = 'BTN'
        AND type IN ('referral_bonus', 'streak_bonus', 'season_prize', 'referral_prize')
        AND "isBonus" = false
    `,
      )
      .then((r: any[]) => parseFloat(r[0].total));

    // Bonus spent as real: bonus bets recorded as isBonus=false but funded from
    // bonusBalance. This deflates the real balance sum without a corresponding
    // real money event.
    // IMPORTANT: some bet_placed rows are already tagged isBonus=true — those are
    // already excluded from totalRealBalance and must NOT be counted here again.
    // Only the isBonus=false portion of bonus spending causes deflation.
    // Outstanding bonus = bonus still held by users. Derive it from the transaction
    // ledger (SUM of isBonus=true), NOT the users.bonusBalance column: that column is
    // never incremented on bonus grant (see auth.service welcome-credit path), so it
    // sits at 0 while the ledger holds the true bonus. Reading the stale column here
    // put the reconciliation's two sides on different sources of truth and produced a
    // large phantom discrepancy. totalBonusBalance is the isBonus=true ledger sum.
    const outstandingBonusRow = totalBonusBalance;

    // Bonus already tagged isBonus=true in transactions (already excluded from realBalance)
    const bonusAlreadyTaggedRow = await em
      .getRepository(Transaction)
      .query(
        `SELECT COALESCE(ABS(SUM(amount)), 0)::float AS total
         FROM transactions
         WHERE currency = 'BTN' AND type = 'bet_placed' AND "isBonus" = true`,
      )
      .then((r: any[]) => parseFloat(r[0].total));

    // Total bonus consumed = issued − outstanding bonus balances
    // Subtract already-tagged portion to avoid double-counting
    const totalBonusConsumed = totalBonusIssuedRow - outstandingBonusRow;
    const bonusSpentAsReal = Math.max(
      0,
      totalBonusConsumed - bonusAlreadyTaggedRow,
    );

    // expectedUserBalances = what users SHOULD hold based purely on external money
    // + bonus real payouts (real Nu that entered wallets from bonus-loss events)
    // + non-bonus free credits (platform credits with no payment backing)
    // + platform reward credits (referral bonus, streak boost, season prizes)
    // - bonus spent as real (bonus bets recorded as isBonus=false deflate real balance)
    const expectedUserBalances =
      netExternalFlow -
      houseEarnings -
      breakage -
      pendingBetsRealAmount +
      bonusFundedRealPayoutsRow +
      nonBonusFreeCreditsRow +
      platformRewardCreditsRow -
      bonusSpentAsReal;
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
        pendingRealAmount: pendingBetsRealAmount,
      },
      reconciliation: {
        netExternalFlow,
        houseEarnings,
        breakage,
        bonusFundedRealPayouts: bonusFundedRealPayoutsRow,
        totalBonusIssued: totalBonusIssuedRow,
        nonBonusFreeCredits: nonBonusFreeCreditsRow,
        platformRewardCredits: platformRewardCreditsRow,
        bonusSpentAsReal,
        outstandingBonus: outstandingBonusRow,
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
  @ApiQuery({ name: "search", required: false, type: String })
  @ApiQuery({
    name: "currency",
    required: false,
    description:
      "Restrict to one book. The two never mix and must never be summed — " +
      "there is no exchange rate between them — so a screen showing both is " +
      "a screen whose totals mean nothing.",
  })
  @ApiQuery({ name: "page", required: false, type: Number })
  @ApiQuery({ name: "limit", required: false, type: Number })
  async listTransactions(
    @Query("type") type?: string,
    @Query("search") search?: string,
    @Query("currency") currency?: string,
    @Query("page") page = "1",
    @Query("limit") limit = "50",
  ) {
    const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const pageNum = Math.max(Number(page) || 1, 1);
    const skip = (pageNum - 1) * take;

    const qb = this.transactionRepo
      .createQueryBuilder("t")
      .leftJoinAndSelect("t.user", "txUser")
      .orderBy("t.createdAt", "DESC")
      .skip(skip)
      .take(take);

    if (type && type !== "all") {
      qb.andWhere("t.type = :type", { type });
    }

    // Server-side search across id, username, first name and note so it spans
    // the whole ledger — not just the rows on the current page.
    if (search && search.trim()) {
      const safe = search.trim().toLowerCase().replace(/[%_\\]/g, "\\$&");
      const term = `%${safe}%`;
      qb.andWhere(
        `(
          LOWER(t.id::text)                        LIKE :term ESCAPE '\\'
          OR LOWER(COALESCE("txUser".username,''))  LIKE :term ESCAPE '\\'
          OR LOWER(COALESCE("txUser"."firstName",'')) LIKE :term ESCAPE '\\'
          OR LOWER(COALESCE(t.note,''))             LIKE :term ESCAPE '\\'
        )`,
        { term },
      );
    }

    if (currency === "BTN") {
      qb.andWhere("(t.currency = :cur OR t.currency IS NULL)", { cur: "BTN" });
    } else if (currency) {
      qb.andWhere("t.currency = :cur", { cur: currency });
    }

    const [data, total] = await qb.getManyAndCount();

    // Whole-ledger per-type counts for the summary cards (independent of the
    // active type filter / pagination, so the totals stay stable).
    const countsQb = this.transactionRepo
      .createQueryBuilder("t")
      .select("t.type", "type")
      .addSelect("COUNT(*)", "count")
      .addSelect("COALESCE(SUM(t.amount), 0)", "net")
      .groupBy("t.type");
    if (currency === "BTN") {
      countsQb.andWhere("(t.currency = :cur OR t.currency IS NULL)", {
        cur: "BTN",
      });
    } else if (currency) {
      countsQb.andWhere("t.currency = :cur", { cur: currency });
    }
    const rawCounts = await countsQb.getRawMany();
    const counts: Record<string, number> = {};
    const net: Record<string, number> = {};
    for (const r of rawCounts) {
      counts[r.type] = Number(r.count);
      net[r.type] = Number(r.net);
    }

    return {
      data,
      total,
      page: pageNum,
      limit: take,
      pages: Math.ceil(total / take),
      counts,
      net,
      currency: currency ?? null,
    };
  }

  @Get("transactions/export")
  @ApiOperation({ summary: "Export transactions as CSV — full financial ledger" })
  @ApiQuery({ name: "type", required: false })
  async exportTransactions(
    @Res() res: Response,
    @Query("type") type?: string,
  ) {
    const qb = this.transactionRepo
      .createQueryBuilder("t")
      .leftJoinAndSelect("t.user", "user")
      .orderBy("t.createdAt", "DESC")
      .take(50000);

    if (type && type !== "all") {
      qb.where("t.type = :type", { type });
    }

    const rows = await qb.getMany();

    const escape = csvCell;

    const header = [
      "Date",
      "Transaction ID",
      "User ID",
      "Username",
      "Type",
      "Amount",
      "Balance Before",
      "Balance After",
      "Bonus",
      "Note",
    ];
    const lines = rows.map((t) =>
      [
        t.createdAt.toISOString(),
        t.id,
        t.userId,
        t.user?.username ?? t.user?.firstName ?? "",
        t.type,
        t.amount,
        t.balanceBefore,
        t.balanceAfter,
        t.isBonus ? "yes" : "no",
        t.note ?? "",
      ]
        .map(escape)
        .join(","),
    );
    const csv = [header.join(","), ...lines].join("\r\n");

    const date = new Date().toISOString().slice(0, 10);
    const suffix = type && type !== "all" ? `-${type}` : "";
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="transactions${suffix}-${date}.csv"`,
    );
    res.send(csv);
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

  // ── Revenue Distribution ────────────────────────────────────────────────────

  @Get("revenue/summary")
  @ApiOperation({ summary: "Get revenue distribution summary" })
  async getRevenueSummary() {
    return this.revenueDistributionService.getSummary();
  }

  @Get("revenue/pending")
  @ApiOperation({ summary: "Get pending revenue distributions" })
  async getPendingDistributions() {
    return this.revenueDistributionService.getPending();
  }

  @Get("revenue/market/:marketId")
  @ApiOperation({ summary: "Get revenue distributions for a market" })
  async getRevenueByMarket(@Param("marketId") marketId: string) {
    return this.revenueDistributionService.getByMarket(marketId);
  }

  @Get("revenue/all")
  @ApiOperation({ summary: "Get all revenue distributions (paginated)" })
  async getAllRevenue(
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("status") status?: string,
  ) {
    return this.revenueDistributionService.getAll(
      page ? Number(page) : 1,
      limit ? Number(limit) : 20,
      status as DistributionStatus | undefined,
    );
  }

  @Get("revenue/account")
  @ApiOperation({ summary: "Get configured destination account number" })
  async getRevenueAccount() {
    return this.revenueDistributionService.getDestinationAccount();
  }

  @Get("revenue/account/balance")
  @ApiOperation({ summary: "Get destination account balance from DK Bank" })
  async getRevenueAccountBalance() {
    return this.revenueDistributionService.getAccountBalance();
  }

  @Put("revenue/account")
  @ApiOperation({
    summary: "Set destination account number for revenue transfers",
  })
  async setRevenueAccount(@Body() body: { accountNumber: string }) {
    return this.revenueDistributionService.setDestinationAccount(
      body.accountNumber,
    );
  }

  @Post("revenue/:id/transfer")
  @ApiOperation({ summary: "Execute DK Bank transfer: bene acc → public acc" })
  async executeRevenueTransfer(@Param("id") id: string) {
    return this.revenueDistributionService.executeTransfer(id);
  }

  @Post("revenue/process-all")
  @ApiOperation({
    summary:
      "Process all pending distributions (batch transfer to public account)",
  })
  async processAllRevenue() {
    return this.revenueDistributionService.processAllPending();
  }

  @Post("revenue/backfill")
  @ApiOperation({
    summary:
      "Backfill revenue distributions for all settled markets that don't have one yet",
  })
  async backfillRevenue() {
    // First: delete any duplicate distributions for markets (keep only the earliest per market).
    // Scoped to rows where marketId IS NOT NULL — duel distributions (challengeId only) must never be touched.
    await this.dataSource.query(`
      DELETE FROM revenue_distributions
      WHERE "marketId" IS NOT NULL
        AND id NOT IN (
          SELECT DISTINCT ON ("marketId") id
          FROM revenue_distributions
          WHERE "marketId" IS NOT NULL
          ORDER BY "marketId", "createdAt" ASC
        )
    `);

    // Find canonical (first) settlement per market that doesn't have a distribution yet
    const missing = await this.dataSource.query(`
      SELECT s.id as "settlementId", s."marketId", s."houseAmount", 
             m."houseEdgePct", s."totalPool"
      FROM (
        SELECT DISTINCT ON (sel."marketId") sel.*
        FROM settlements sel
        INNER JOIN markets m ON m.id = sel."marketId"
        ORDER BY sel."marketId", sel."settledAt" ASC, sel.id ASC
      ) s
      INNER JOIN markets m ON m.id = s."marketId"
      WHERE CAST(s."houseAmount" AS float) > 0
        AND NOT EXISTS (
          SELECT 1 FROM revenue_distributions rd WHERE rd."marketId" = s."marketId"
        )
      ORDER BY s."settledAt" ASC
    `);

    let created = 0;
    for (const row of missing) {
      try {
        await this.revenueDistributionService.recordDistribution(
          row.marketId,
          row.settlementId,
          Number(row.houseAmount),
          Number(row.houseEdgePct),
          Number(row.totalPool),
        );
        created++;
      } catch (err: any) {
        console.error(
          `Backfill failed for settlement ${row.settlementId}: ${err.message}`,
        );
      }
    }

    return { backfilled: created, total: missing.length };
  }

  // ── EPL stat markets ──────────────────────────────────────────────────────
  // Manual one-click creation of a season-long "stat" market (Top Scorer / Most
  // Assists / Yellows / Reds) with outcomes pre-filled from the live leaderboard
  // so names match and each outcome carries the player's photo. The keeper also
  // auto-creates these once the season is underway; both share the same builder
  // (epl-stat-markets.ts). The Stats tab overlays betting via the subcategory.
  @Get("epl/stat-market/preview")
  @ApiOperation({ summary: "Live EPL leaderboards + which stat markets already exist" })
  async previewEplStatMarkets() {
    const [stats, season] = await Promise.all([
      this.eplService.getStats(),
      this.eplService.getSeasonInfo(),
    ]);
    const existing = await this.dataSource.getRepository(Market).find({
      where: {
        subcategory: In(EPL_STAT_SUBCATEGORIES),
        status: In([
          MarketStatus.UPCOMING,
          MarketStatus.OPEN,
          MarketStatus.CLOSED,
          MarketStatus.RESOLVING,
        ]),
      },
      select: ["id", "title", "subcategory", "status"],
    });
    return { stats, existing, season };
  }

  @Post("epl/stat-market")
  @ApiOperation({ summary: "Create a season stat market from the live leaderboard" })
  async createEplStatMarket(
    @Body() body: { stat?: string; closesAt?: string; topN?: number },
    @Request() req: any,
  ) {
    const stat = body?.stat as EplStatKey;
    const meta = EPL_STAT_MARKET_META[stat];
    if (!meta) {
      throw new BadRequestException("stat must be one of: goals, assists, yellow, red");
    }

    // Safety: during the summer gap the boards show LAST season's data via the
    // fallback. Refuse to bake a stale-season leaderboard into a new market —
    // wait until the current season has actually kicked off.
    if (!(await this.eplService.seasonHasStarted())) {
      throw new BadRequestException(
        "The Premier League season hasn't started yet — the leaderboard is still showing last season's data. Wait until the new season is live before creating this market.",
      );
    }

    // Block a duplicate active market for the same stat.
    const dup = await this.dataSource.getRepository(Market).findOne({
      where: {
        subcategory: meta.subcategory,
        status: In([
          MarketStatus.UPCOMING,
          MarketStatus.OPEN,
          MarketStatus.CLOSED,
          MarketStatus.RESOLVING,
        ]),
      },
    });
    if (dup) {
      throw new BadRequestException(
        `An active "${meta.title}" market already exists (id ${dup.id}). Resolve or cancel it first.`,
      );
    }

    const stats = await this.eplService.getStats();
    const topN = Math.min(Math.max(Number(body?.topN ?? 15), 2), 25);
    const players = stats[meta.board].slice(0, topN);
    if (players.length < 2) {
      throw new BadRequestException(
        "The live leaderboard doesn't have enough players yet to open this market.",
      );
    }

    const dto = buildEplStatMarketDto(stat, players, body?.closesAt);
    const market = await this.marketsService.create(dto);
    await this.auditService.log({
      adminId: req.user.userId,
      isAdmin: true,
      action: AuditAction.MARKET_CREATE,
      entityType: "market",
      entityId: market.id,
      after: { title: market.title, subcategory: meta.subcategory, outcomes: players.length, closesAt: dto.closesAt },
      ipAddress: req.ip,
    });
    return market;
  }

  // ── UCL stat markets ──────────────────────────────────────────────────────
  // Champions League equivalent of the EPL stat markets above. Shares the same
  // one-click flow and builder (ucl-stat-markets.ts). Note: only goals & assists
  // have a free-tier CL data source, so the yellow/red boards come back empty and
  // their buttons stay disabled until a data source exists.
  @Get("ucl/stat-market/preview")
  @ApiOperation({ summary: "Live UCL leaderboards + which stat markets already exist" })
  async previewUclStatMarkets() {
    const [stats, season] = await Promise.all([
      this.uclService.getStats(),
      this.uclService.getSeasonInfo(),
    ]);
    const existing = await this.dataSource.getRepository(Market).find({
      where: {
        subcategory: In(UCL_STAT_SUBCATEGORIES),
        status: In([
          MarketStatus.UPCOMING,
          MarketStatus.OPEN,
          MarketStatus.CLOSED,
          MarketStatus.RESOLVING,
        ]),
      },
      select: ["id", "title", "subcategory", "status"],
    });
    return { stats, existing, season };
  }

  @Post("ucl/stat-market")
  @ApiOperation({ summary: "Create a season stat market from the live leaderboard" })
  async createUclStatMarket(
    @Body() body: { stat?: string; closesAt?: string; topN?: number },
    @Request() req: any,
  ) {
    const stat = body?.stat as UclStatKey;
    const meta = UCL_STAT_MARKET_META[stat];
    if (!meta) {
      throw new BadRequestException("stat must be one of: goals, assists, yellow, red");
    }

    // Safety: outside the season the boards show LAST season's data via the
    // fallback. Refuse to bake a stale-season leaderboard into a new market.
    if (!(await this.uclService.seasonHasStarted())) {
      throw new BadRequestException(
        "The Champions League season hasn't started yet — the leaderboard is still showing last season's data. Wait until the new season is live before creating this market.",
      );
    }

    // Block a duplicate active market for the same stat.
    const dup = await this.dataSource.getRepository(Market).findOne({
      where: {
        subcategory: meta.subcategory,
        status: In([
          MarketStatus.UPCOMING,
          MarketStatus.OPEN,
          MarketStatus.CLOSED,
          MarketStatus.RESOLVING,
        ]),
      },
    });
    if (dup) {
      throw new BadRequestException(
        `An active "${meta.title}" market already exists (id ${dup.id}). Resolve or cancel it first.`,
      );
    }

    const stats = await this.uclService.getStats();
    const topN = Math.min(Math.max(Number(body?.topN ?? 15), 2), 25);
    const players = (stats[meta.board] ?? []).slice(0, topN);
    if (players.length < 2) {
      throw new BadRequestException(
        "The live leaderboard doesn't have enough players yet to open this market. (Champions League card data isn't available on the free tier.)",
      );
    }

    const dto = buildUclStatMarketDto(stat, players, body?.closesAt);
    const market = await this.marketsService.create(dto);
    await this.auditService.log({
      adminId: req.user.userId,
      isAdmin: true,
      action: AuditAction.MARKET_CREATE,
      entityType: "market",
      entityId: market.id,
      after: { title: market.title, subcategory: meta.subcategory, outcomes: players.length, closesAt: dto.closesAt },
      ipAddress: req.ip,
    });
    return market;
  }

  // ── Per-currency market books ───────────────────────────────────────────────
  //
  // A BTN book appears on its own the first time someone stakes, because its
  // terms follow from the market. A USDT book does not: its platform cut and
  // minimum stake are decisions, so it is opened here deliberately. A market
  // with no USDT book simply refuses USDT stakes.

  @Get("markets/:id/books")
  @ApiOperation({ summary: "Currency books on a market" })
  async listMarketBooks(@Param("id") id: string) {
    return { books: await this.marketBooks.listBooks(id) };
  }

  @Post("markets/:id/books")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Open a currency book on a market" })
  async openMarketBook(
    @Request() req: any,
    @Param("id") id: string,
    @Body() body: { currency: string; houseEdgePct: number; minStake: number },
  ) {
    const book = await this.marketBooks.openBook(id, body);
    await this.auditService.log({
      adminId: req.user.userId,
      isAdmin: true,
      action: AuditAction.MARKET_UPDATE,
      entityType: "market_book",
      entityId: book.id,
      after: {
        marketId: id,
        currency: book.currency,
        houseEdgePct: book.houseEdgePct,
        minStake: book.minStake,
      },
      ipAddress: req.ip,
    });
    return book;
  }

  @Patch("markets/books/:bookId")
  @ApiOperation({ summary: "Change a book's terms — refused once it has stakes" })
  async updateMarketBook(
    @Request() req: any,
    @Param("bookId") bookId: string,
    @Body() body: { houseEdgePct?: number; minStake?: number },
  ) {
    const book = await this.marketBooks.updateTerms(bookId, body);
    await this.auditService.log({
      adminId: req.user.userId,
      isAdmin: true,
      action: AuditAction.MARKET_UPDATE,
      entityType: "market_book",
      entityId: bookId,
      after: { houseEdgePct: book.houseEdgePct, minStake: book.minStake },
      ipAddress: req.ip,
    });
    return book;
  }

  @Post("markets/books/:bookId/enabled")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Open or close a book to new stakes" })
  async setMarketBookEnabled(
    @Request() req: any,
    @Param("bookId") bookId: string,
    @Body() body: { enabled: boolean },
  ) {
    const book = await this.marketBooks.setEnabled(bookId, !!body?.enabled);
    await this.auditService.log({
      adminId: req.user.userId,
      isAdmin: true,
      action: AuditAction.MARKET_UPDATE,
      entityType: "market_book",
      entityId: bookId,
      after: { isEnabled: book.isEnabled },
      ipAddress: req.ip,
    });
    return book;
  }
}
