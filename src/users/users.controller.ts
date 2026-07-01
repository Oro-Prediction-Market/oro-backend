import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Request,
  UseGuards,
  Query,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { IsOptional, IsString, Length, Matches } from "class-validator";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { JwtAuthGuard, PreKycJwtAuthGuard, Public } from "../auth/guards";
import { User } from "../entities/user.entity";
import { Payment } from "../entities/payment.entity";
import { Transaction, TransactionType } from "../entities/transaction.entity";
import { Position, PositionStatus } from "../entities/position.entity";
import { RedisService } from "../redis/redis.service";
import { StreakService } from "./streak.service";
import { SeasonService } from "./season.service";
import { OnboardService } from "./onboard.service";
import { ParimutuelEngine } from "../markets/parimutuel.engine";
import { DKGatewayService } from "../payment/services/dk-gateway/dk-gateway.service";

class SendOnboardOtpDto {
  @ApiProperty({ description: "Phone number (E.164)", required: false })
  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @ApiProperty({ description: "Email address", required: false })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiProperty({
    description: "CID to validate against DK Bank phone",
    required: false,
  })
  @IsOptional()
  @IsString()
  cid?: string;
}

class RegisterTelegramUserDto {
  @ApiProperty({
    example: "sonam_t",
    description: "3–50 chars, letters/numbers/underscores",
  })
  @IsString()
  @Length(3, 50)
  @Matches(/^[a-zA-Z0-9_]+$/, {
    message: "Letters, numbers and underscores only",
  })
  username: string;

  @ApiProperty({ example: "Sonam Tenzin" })
  @IsString()
  @Length(1, 255)
  fullName: string;

  @ApiProperty({
    example: "123456",
    description: "6-digit code from Telegram bot",
  })
  @IsString()
  @Length(6, 6)
  otp: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiProperty({
    required: false,
    description: "Referral code from startParam",
  })
  @IsOptional()
  @IsString()
  referralCode?: string;

  @ApiProperty({ required: false, description: "Telegram profile photo URL" })
  @IsOptional()
  @IsString()
  photoUrl?: string;
}

// ─── Response schemas for Swagger ────────────────────────────────────────────

class ProfileResponse {
  @ApiProperty({ example: "uuid-1234" }) id: string;
  @ApiProperty({ example: "Sonam" }) firstName: string;
  @ApiPropertyOptional({ example: "Tenzin" }) lastName: string;
  @ApiPropertyOptional({ example: "sonam_t" }) username: string;
  @ApiPropertyOptional({ example: "https://cdn.example.com/photo.jpg" })
  photoUrl: string;
  @ApiProperty({ example: false }) isAdmin: boolean;
  @ApiProperty({
    example: 1500.5,
    description: "Credits balance computed from transaction ledger",
  })
  creditsBalance: number;
  @ApiProperty() createdAt: Date;
}

class TransactionResponse {
  @ApiProperty({ example: "uuid-5678" }) id: string;
  @ApiProperty({
    enum: TransactionType,
    example: TransactionType.POSITION_OPENED,
  })
  type: TransactionType;
  @ApiProperty({
    example: -100.0,
    description: "Negative = debit, positive = credit",
  })
  amount: number;
  @ApiProperty({ example: 1600.0 }) balanceBefore: number;
  @ApiProperty({ example: 1500.0 }) balanceAfter: number;
  @ApiPropertyOptional({ example: "Position on outcome: Team A" }) note: string;
  @ApiPropertyOptional({ example: "uuid-position" }) positionId: string;
  @ApiPropertyOptional({ example: "uuid-payment" }) paymentId: string;
  @ApiProperty() createdAt: Date;
}

class PositionResponse {
  @ApiProperty({ example: "uuid-bet" }) id: string;
  @ApiProperty({ example: 100.0 }) amount: number;
  @ApiProperty({ enum: PositionStatus, example: PositionStatus.PENDING })
  status: PositionStatus;
  @ApiPropertyOptional({
    example: 1.8,
    description: "Parimutuel odds at time of placement",
  })
  oddsAtPlacement: number;
  @ApiPropertyOptional({
    example: 180.0,
    description: "Payout amount (only set after settlement)",
  })
  payout: number;
  @ApiProperty() placedAt: Date;
  @ApiProperty({ example: "uuid-market" }) marketId: string;
  @ApiProperty({ example: "uuid-outcome" }) outcomeId: string;
  @ApiPropertyOptional({ description: "Market details (eager loaded)" })
  market: any;
  @ApiPropertyOptional({ description: "Outcome details (eager loaded)" })
  outcome: any;
}

@ApiTags("users")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("users")
export class UsersController {
  constructor(
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectRepository(Payment) private paymentRepo: Repository<Payment>,
    @InjectRepository(Transaction)
    private transactionRepo: Repository<Transaction>,
    @InjectRepository(Position) private betRepo: Repository<Position>,
    private readonly redis: RedisService,
    private readonly streakService: StreakService,
    private readonly config: ConfigService,
    private readonly seasonService: SeasonService,
    private readonly onboardService: OnboardService,
    private readonly dkGateway: DKGatewayService,
  ) {}

  // ── Onboarding ────────────────────────────────────────────────────────────

  @Get("check/username/:username")
  @Public()
  @ApiOperation({ summary: "Check whether a username is available" })
  @ApiOkResponse({ schema: { properties: { available: { type: "boolean" } } } })
  async checkUsername(@Param("username") username: string) {
    const available = await this.onboardService.isUsernameAvailable(username);
    return { available };
  }

  @Post("send-onboard-otp")
  @HttpCode(200)
  @UseGuards(PreKycJwtAuthGuard)
  @ApiOperation({
    summary:
      "Send OTP via Telegram bot during onboarding (pre-KYC token required)",
  })
  @ApiBody({ type: SendOnboardOtpDto })
  @ApiOkResponse({ schema: { properties: { sent: { type: "boolean" } } } })
  async sendOnboardOtp(@Body() dto: SendOnboardOtpDto, @Request() req: any) {
    if (!dto.phoneNumber && !dto.email) {
      throw new BadRequestException("phoneNumber or email is required");
    }

    // If CID and phone are provided, validate they match in DK Bank before sending OTP
    if (dto.cid && dto.phoneNumber) {
      const cleanCid = dto.cid.trim().replace(/\D/g, "");
      if (cleanCid.length === 11) {
        try {
          const result = await this.dkGateway.lookupAccountByCID(cleanCid);
          const bankPhone = result.phoneNumber;
          if (bankPhone) {
            const stripToLocal = (p: string) => {
              let c = p.replace(/[\s\-()+ ]/g, "");
              if (c.startsWith("975") && c.length === 11) c = c.substring(3);
              return c;
            };
            const normalizedUser = stripToLocal(dto.phoneNumber);
            const normalizedBank = stripToLocal(bankPhone);
            if (normalizedUser !== normalizedBank) {
              throw new BadRequestException(
                `Phone number does not match your DK Bank account. The phone registered with CID ${cleanCid.slice(0, 3)}***${cleanCid.slice(-3)} is different from what you entered.`,
              );
            }
          }
        } catch (e: any) {
          if (e instanceof BadRequestException) throw e;
          // If DK lookup fails, let it pass — bank linking will catch it later
        }
      }
    }

    await this.onboardService.sendOnboardOtp(
      req.user.telegramId,
      dto.phoneNumber,
      dto.email,
    );
    return { sent: true };
  }

  @Post("telegram/register")
  @HttpCode(200)
  @UseGuards(PreKycJwtAuthGuard)
  @ApiOperation({
    summary:
      "Complete Telegram onboarding — verify OTP and create user account",
  })
  @ApiBody({ type: RegisterTelegramUserDto })
  async registerTelegramUser(
    @Body() dto: RegisterTelegramUserDto,
    @Request() req: any,
  ) {
    const { token, user } = await this.onboardService.registerTelegramUser(
      req.user.telegramId,
      dto,
    );
    const {
      phoneNumber: _p,
      pwaPasswordHash: _pw,
      telegramPhoneHash: _tp,
      dkPhoneHash: _dk,
      ...safeUser
    } = user as any;
    return { token, user: safeUser };
  }

  @Get("me")
  @ApiOperation({ summary: "Get my profile & balance" })
  @ApiResponse({ status: 200, type: ProfileResponse })
  async getMe(@Request() req: any) {
    const userId: string = req.user.userId;

    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: [
        "id",
        "firstName",
        "lastName",
        "username",
        "photoUrl",
        "isAdmin",
        "createdAt",
        "telegramId",
        "dkCid",
        "dkAccountName",
        "telegramLinkedAt",
        // reputation fields
        "reputationScore",
        "reputationTier",
        "totalPredictions",
        "correctPredictions",
        "categoryScores",
        // contrarian badge
        "contrarianBadge",
        "contrarianWins",
        "contrarianAttempts",
        // streak
        "telegramStreak",
        // hashes loaded only for boolean derivation — never forwarded to client
        "dkPhoneHash",
        "telegramPhoneHash",
        "dkLinkVerifiedAt",
      ],
    });

    const balanceCacheKey = `oro:cache:balance:${userId}`;
    let creditsBalance: number | null =
      await this.redis.getJson<number>(balanceCacheKey);

    if (creditsBalance === null) {
      const { creditsBalance: raw } = await this.transactionRepo
        .createQueryBuilder("t")
        .select("COALESCE(SUM(t.amount), 0)", "creditsBalance")
        .where("t.userId = :userId", { userId })
        .getRawOne();
      creditsBalance = Number(raw);
      await this.redis.setJsonEx(balanceCacheKey, 15, creditsBalance);
    }

    // Derive boolean flags — never send raw hashes to the client
    const { dkPhoneHash, telegramPhoneHash, ...safeUser } = user as any;

    // Streak info (cached key reused from balance; separate small query)
    const streakInfo = await this.streakService.getStreakInfo(userId);

    // Count referred users who have triggered their first-bet bonus
    const referralCount = await this.userRepo.count({
      where: { referredByUserId: userId, referralBonusTriggered: true },
    });

    const verifiedByPhone = !!(
      telegramPhoneHash &&
      dkPhoneHash &&
      telegramPhoneHash === dkPhoneHash
    );
    const verifiedByAccountNumber = !!user?.dkLinkVerifiedAt;

    return {
      ...safeUser,
      creditsBalance,
      isDkPhoneLinked: !!dkPhoneHash,
      isPhoneVerified: verifiedByPhone || verifiedByAccountNumber,
      referralCount,
      ...streakInfo,
    };
  }

  @Get("me/payments")
  @ApiOperation({ summary: "Get my payment history" })
  getPayments(@Request() req: any) {
    return this.paymentRepo.find({
      where: { userId: req.user.userId },
      order: { createdAt: "DESC" },
      take: 50,
    });
  }

  // ── Wallet: transaction ledger ────────────────────────────────────────────

  @Get("me/transactions")
  @ApiOperation({ summary: "Get my transaction ledger (wallet history)" })
  @ApiQuery({
    name: "limit",
    required: false,
    example: 50,
    description: "Max rows to return (default 50)",
  })
  @ApiQuery({
    name: "type",
    required: false,
    enum: TransactionType,
    description: "Filter by transaction type",
  })
  @ApiResponse({ status: 200, type: [TransactionResponse] })
  getTransactions(
    @Request() req: any,
    @Query("limit") limit?: string,
    @Query("type") type?: TransactionType,
  ) {
    const take = Math.min(Number(limit) || 50, 200);
    const where: any = { userId: req.user.userId };
    if (type) where.type = type;
    return this.transactionRepo.find({
      where,
      order: { createdAt: "DESC" },
      take,
    });
  }

  // ── My Predictions ────────────────────────────────────────────────────────

  @Get("me/bets")
  @ApiOperation({ summary: "Get my predictions (all bets)" })
  @ApiQuery({
    name: "status",
    required: false,
    enum: PositionStatus,
    description: "Filter by bet status",
  })
  @ApiResponse({ status: 200, type: [PositionResponse] })
  getMyPositions(
    @Request() req: any,
    @Query("status") status?: PositionStatus,
  ) {
    const where: any = { userId: req.user.userId };
    if (status) where.status = status;
    return this.betRepo.find({
      where,
      relations: ["market", "outcome"],
      order: { placedAt: "DESC" },
    });
  }

  // ── Results: settled bets ─────────────────────────────────────────────────

  @Get("me/results")
  @ApiOperation({
    summary: "Get my results — bets that have been won, lost, or refunded",
  })
  @ApiResponse({ status: 200, type: [PositionResponse] })
  getResults(@Request() req: any) {
    return this.betRepo
      .createQueryBuilder("bet")
      .leftJoinAndSelect("bet.market", "market")
      .leftJoinAndSelect("bet.outcome", "outcome")
      .where("bet.userId = :userId", { userId: req.user.userId })
      .andWhere("bet.status IN (:...statuses)", {
        statuses: [
          PositionStatus.WON,
          PositionStatus.LOST,
          PositionStatus.REFUNDED,
        ],
      })
      .orderBy("bet.placedAt", "DESC")
      .getMany();
  }

  // ── Referral ──────────────────────────────────────────────────────────────

  @Get("me/referral")
  @ApiOperation({ summary: "Get referral link and earnings stats" })
  async getReferral(@Request() req: any) {
    const userId: string = req.user.userId;
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: ["id", "telegramId"],
    });

    const botUsername =
      this.config.get<string>("TELEGRAM_BOT_USERNAME") ?? "OroPredictBot";
    const referralLink = `https://t.me/${botUsername}/app?startapp=ref_${user?.telegramId ?? userId}`;

    // Total bonus credited across all referrals
    const { total } = await this.transactionRepo
      .createQueryBuilder("t")
      .select("COALESCE(SUM(t.amount), 0)", "total")
      .where("t.userId = :userId", { userId })
      .andWhere("t.type = :type", { type: TransactionType.REFERRAL_BONUS })
      .getRawOne();

    const referredCount = await this.userRepo.count({
      where: { referredByUserId: userId },
    });
    const convertedCount = await this.userRepo.count({
      where: { referredByUserId: userId, referralBonusTriggered: true },
    });

    return {
      referralLink,
      referredCount,
      convertedCount,
      totalEarned: Number(total),
      flatBonus: ParimutuelEngine.REFERRAL_FLAT_BONUS,
      betPct: ParimutuelEngine.REFERRAL_BET_PCT * 100,
      cap: ParimutuelEngine.REFERRAL_CAP,
    };
  }

  // ── Leaderboard ───────────────────────────────────────────────────────────

  @Get("leaderboard")
  @Public()
  @ApiOperation({ summary: "Global leaderboard — top 50 predictors" })
  @ApiQuery({ name: "period", enum: ["all", "week"], required: false })
  async getLeaderboard(
    @Request() req: any,
    @Query("period") period: "all" | "week" = "all",
  ) {
    const myId: string | null = req.user?.userId ?? null;
    const anon = myId == null;

    if (period === "week") {
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);

      const weeklyRows = await this.betRepo
        .createQueryBuilder("p")
        .select("u.id", "id")
        .addSelect("u.firstName", "firstName")
        .addSelect("u.lastName", "lastName")
        .addSelect("u.username", "username")
        .addSelect("u.photoUrl", "photoUrl")
        .addSelect("u.reputationScore", "reputationScore")
        .addSelect("u.reputationTier", "reputationTier")
        .addSelect("u.totalPredictions", "totalPredictions")
        .addSelect("u.correctPredictions", "correctPredictions")
        .addSelect("COUNT(p.id)", "weeklyPredictions")
        .addSelect(
          "SUM(CASE WHEN p.status = 'won' THEN 1 ELSE 0 END)",
          "weeklyWins",
        )
        .addSelect("COALESCE(SUM(p.amount), 0)", "weeklyBetAmount")
        .innerJoin("p.user", "u")
        .where("p.placedAt >= :monthStart", { monthStart })
        .andWhere("p.status IN ('won', 'lost')")
        .groupBy("u.id")
        .having("COUNT(p.id) >= 15")
        .orderBy(
          "SUM(CASE WHEN p.status = 'won' THEN 1 ELSE 0 END)::float / COUNT(p.id)",
          "DESC",
        )
        .addOrderBy("COUNT(p.id)", "DESC")
        .limit(50)
        .getRawMany();

      const board = weeklyRows.map((r, i) => {
        const wp = Number(r.weeklyPredictions);
        const ww = Number(r.weeklyWins);
        return {
          rank: i + 1,
          id: r.id,
          firstName: anon ? "Predictor" : r.firstName,
          lastName: anon ? null : r.lastName,
          username: anon ? null : r.username,
          photoUrl: anon ? null : r.photoUrl,
          reputationScore:
            r.reputationScore !== null ? Number(r.reputationScore) : null,
          reputationTier: r.reputationTier,
          totalPredictions: Number(r.totalPredictions),
          correctPredictions: Number(r.correctPredictions),
          winRate: wp > 0 ? Math.round((ww / wp) * 100) : 0,
          totalBetAmount: Math.round(Number(r.weeklyBetAmount)),
          weeklyPredictions: wp,
          weeklyWins: ww,
          isMe: myId != null && r.id === myId,
        };
      });

      // One row per qualifying user (>=10 monthly predictions); count the rows.
      // NB: GROUP BY u.id + COUNT(DISTINCT u.id) + getRawOne() always returns 1,
      // because each group is a single user — hence the old "1 ranked" bug.
      const totalRankedRows = await this.betRepo
        .createQueryBuilder("p")
        .innerJoin("p.user", "u")
        .where("p.placedAt >= :monthStart", { monthStart })
        .andWhere("p.status IN ('won', 'lost')")
        .groupBy("u.id")
        .having("COUNT(p.id) >= 15")
        .select("u.id", "id")
        .getRawMany();
      const totalRanked = totalRankedRows.length;

      const meInBoard = board.find((r) => r.isMe);
      return {
        board,
        myRank: meInBoard ? meInBoard.rank : null,
        totalRanked,
      };
    }

    // ── All-time ──────────────────────────────────────────────────────────────
    const rows = await this.userRepo
      .createQueryBuilder("u")
      .select([
        "u.id",
        "u.firstName",
        "u.lastName",
        "u.username",
        "u.photoUrl",
        "u.reputationScore",
        "u.reputationTier",
        "u.totalPredictions",
        "u.correctPredictions",
      ])
      .addSelect(
        `(SELECT COALESCE(SUM(p.amount), 0) FROM positions p WHERE p."userId" = u.id)`,
        "totalBetAmount",
      )
      .where("u.totalPredictions >= 10")
      .orderBy("u.reputationScore", "DESC", "NULLS LAST")
      .addOrderBy("u.correctPredictions", "DESC")
      .limit(50)
      .getRawAndEntities();

    const board = rows.entities.map((u, i) => ({
      rank: i + 1,
      id: u.id,
      firstName: anon ? "Predictor" : u.firstName,
      lastName: anon ? null : u.lastName,
      username: anon ? null : u.username,
      photoUrl: anon ? null : u.photoUrl,
      reputationScore: u.reputationScore,
      reputationTier: u.reputationTier,
      totalPredictions: u.totalPredictions,
      correctPredictions: u.correctPredictions,
      winRate:
        u.totalPredictions > 0
          ? Math.round((u.correctPredictions / u.totalPredictions) * 100)
          : 0,
      totalBetAmount: Math.round(Number(rows.raw[i]?.totalBetAmount ?? 0)),
      isMe: myId != null && u.id === myId,
    }));

    let myRank: number | null = null;
    if (myId) {
      const meInBoard = board.find((r) => r.isMe);
      if (meInBoard) {
        myRank = meInBoard.rank;
      } else {
        const above = await this.userRepo
          .createQueryBuilder("u")
          .where("u.totalPredictions >= 10")
          .andWhere(
            '(u.reputationScore > (SELECT "reputationScore" FROM users WHERE id = :myId) OR (u.reputationScore = (SELECT "reputationScore" FROM users WHERE id = :myId) AND u.correctPredictions > (SELECT "correctPredictions" FROM users WHERE id = :myId)))',
            { myId },
          )
          .getCount();
        myRank = above + 1;
      }
    }

    const totalRanked = await this.userRepo
      .createQueryBuilder("u")
      .where("u.totalPredictions >= 10")
      .getCount();

    return { board, myRank, totalRanked };
  }

  // ── Seasons ───────────────────────────────────────────────────────────────

  @Get("seasons/current")
  @ApiOperation({ summary: "Current active season metadata" })
  async getCurrentSeason() {
    return this.seasonService.getCurrentSeason();
  }

  @Get("seasons/history")
  @ApiOperation({ summary: "Past seasons with winners snapshot" })
  async getSeasonHistory(@Query("limit") limit?: string) {
    return this.seasonService.getSeasonHistory(
      Math.min(Number(limit) || 10, 52),
    );
  }
}
