import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  Post,
  Request,
  Res,
  UseGuards,
  Query,
} from "@nestjs/common";
import type { Response } from "express";
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
import { In, Repository } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { JwtAuthGuard, PreKycJwtAuthGuard, Public } from "../auth/guards";
import { User } from "../entities/user.entity";
import { CryptoWithdrawal } from "../entities/crypto-withdrawal.entity";
import { Payment } from "../entities/payment.entity";
import { Transaction, TransactionType } from "../entities/transaction.entity";
import { Position, PositionStatus } from "../entities/position.entity";
import { RedisService } from "../redis/redis.service";
import { StreakService } from "./streak.service";
import { SeasonService } from "./season.service";
import { OnboardService } from "./onboard.service";
import { ParimutuelEngine } from "../markets/parimutuel.engine";
import { DKGatewayService } from "../payment/services/dk-gateway/dk-gateway.service";
import { UserNotificationService } from "./user-notification.service";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";
import {
  ledgerBalance,
  ledgerBalanceForAccount,
} from "../shared/utils/ledger.util";
import {
  allowedCurrencies,
  usdtIdentityVerified,
} from "../shared/utils/wallet.util";

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

/**
 * Football season windows for the season-specific collectible badges.
 *
 * A badge (e.g. "Premier League 2026/27") is earned from performance INSIDE its
 * season only: we count a user's settled EPL/UCL predictions whose market closes
 * within the window below. Because a past window can never receive a new market,
 * the count freezes when the season ends — so the badge is obtainable only during
 * that season and a later season's play can never top it up. Next season: add a
 * sibling entry here + a new badge on the client, nothing else.
 */
const FOOTBALL_SEASONS = [
  { key: "2026-27", start: "2026-08-01T00:00:00Z", end: "2027-07-01T00:00:00Z" },
] as const;

@ApiTags("users")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("users")
export class UsersController {
  private readonly logger = new Logger(UsersController.name);

  constructor(
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectRepository(Payment) private paymentRepo: Repository<Payment>,
    @InjectRepository(Transaction)
    private transactionRepo: Repository<Transaction>,
    @InjectRepository(Position) private betRepo: Repository<Position>,
    @InjectRepository(CryptoWithdrawal)
    private cryptoWithdrawalRepo: Repository<CryptoWithdrawal>,
    private readonly redis: RedisService,
    private readonly streakService: StreakService,
    private readonly config: ConfigService,
    private readonly seasonService: SeasonService,
    private readonly onboardService: OnboardService,
    private readonly dkGateway: DKGatewayService,
    private readonly userNotifications: UserNotificationService,
    private readonly telegramSimple: TelegramSimpleService,
  ) {}

  /**
   * Per-season EPL/UCL prediction tallies driving the season collectible badges.
   * Counts only SETTLED positions (won+lost) in markets tagged with an epl-/ucl-
   * subcategory (mirrors the app's isEplMarket/isUclMarket, whose category check
   * can never fire since MarketCategory has no league values) whose market closes
   * inside each season window. Shape:
   *   { "2026-27": { eplSettled, eplWins, uclSettled, uclWins }, ... }
   * The client reads a badge's season key and unlocks at settled>=15 && winrate>=60%.
   */
  private async footballSeasonBadgeStats(userId: string): Promise<
    Record<
      string,
      { eplSettled: number; eplWins: number; uclSettled: number; uclWins: number }
    >
  > {
    const out: Record<
      string,
      { eplSettled: number; eplWins: number; uclSettled: number; uclWins: number }
    > = {};
    for (const season of FOOTBALL_SEASONS) {
      const row = await this.betRepo
        .createQueryBuilder("p")
        .innerJoin("p.market", "m")
        .select(
          "COUNT(*) FILTER (WHERE LOWER(m.subcategory) LIKE '%epl%')",
          "eplSettled",
        )
        .addSelect(
          "COUNT(*) FILTER (WHERE LOWER(m.subcategory) LIKE '%epl%' AND p.status = 'won')",
          "eplWins",
        )
        .addSelect(
          "COUNT(*) FILTER (WHERE LOWER(m.subcategory) LIKE '%ucl%')",
          "uclSettled",
        )
        .addSelect(
          "COUNT(*) FILTER (WHERE LOWER(m.subcategory) LIKE '%ucl%' AND p.status = 'won')",
          "uclWins",
        )
        .where("p.userId = :userId", { userId })
        .andWhere("p.status IN (:...settled)", {
          settled: [PositionStatus.WON, PositionStatus.LOST],
        })
        .andWhere('m."closesAt" >= :start AND m."closesAt" < :end', {
          start: season.start,
          end: season.end,
        })
        .getRawOne<{
          eplSettled: string;
          eplWins: string;
          uclSettled: string;
          uclWins: string;
        }>();
      out[season.key] = {
        eplSettled: Number(row?.eplSettled ?? 0),
        eplWins: Number(row?.eplWins ?? 0),
        uclSettled: Number(row?.uclSettled ?? 0),
        uclWins: Number(row?.uclWins ?? 0),
      };
    }
    return out;
  }

  /** Unseen in-app notifications for the current user (popped on app open). */
  @Get("me/notifications")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List the current user's unseen notifications" })
  async myNotifications(@Request() req: any) {
    return this.userNotifications.listUnseen(req.user.userId);
  }

  /** Mark notifications seen (by id, or all unseen when ids omitted). */
  @Post("me/notifications/seen")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Mark the current user's notifications as seen" })
  async markNotificationsSeen(
    @Request() req: any,
    @Body() body: { ids?: string[] },
  ): Promise<{ ok: boolean }> {
    await this.userNotifications.markSeen(req.user.userId, body?.ids);
    return { ok: true };
  }

  /** Full notification history for the center, newest first (cursor by `before`). */
  @Get("me/notifications/list")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List all of the current user's notifications" })
  async listNotifications(
    @Request() req: any,
    @Query("limit") limit?: string,
    @Query("before") before?: string,
  ) {
    return this.userNotifications.listAll(req.user.userId, {
      limit: limit ? Number(limit) : undefined,
      before,
    });
  }

  /** Unread (unseen) count — drives the header bell badge. */
  @Get("me/notifications/unread-count")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Count the current user's unread notifications" })
  async unreadNotificationCount(
    @Request() req: any,
  ): Promise<{ count: number }> {
    return { count: await this.userNotifications.unreadCount(req.user.userId) };
  }

  /** Mark the given notification ids as unread (null their seenAt). */
  @Post("me/notifications/unread")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Mark the current user's notifications as unread" })
  async markNotificationsUnread(
    @Request() req: any,
    @Body() body: { ids?: string[] },
  ): Promise<{ ok: boolean }> {
    await this.userNotifications.markUnread(req.user.userId, body?.ids ?? []);
    return { ok: true };
  }

  /** Delete notifications by id, or clear all when `ids` is omitted. */
  @Post("me/notifications/delete")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Delete the current user's notifications" })
  async deleteNotifications(
    @Request() req: any,
    @Body() body: { ids?: string[] },
  ): Promise<{ ok: boolean }> {
    await this.userNotifications.remove(req.user.userId, body?.ids);
    return { ok: true };
  }

  /**
   * Reconcile achievement-badge unlocks into notifications. The client computes
   * its unlocked badges (single source of truth) and reports them; the backend
   * creates a one-time notification per new badge. `seenIds` carries the
   * client's existing localStorage "seen" set so pre-earned badges are
   * baselined silently instead of all popping at once.
   */
  @Post("me/achievements/sync")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Sync unlocked achievement badges into notifications" })
  async syncAchievements(
    @Request() req: any,
    @Body()
    body: {
      badges?: { id: string; name: string; requirement?: string }[];
      seenIds?: string[];
    },
  ): Promise<{ ok: boolean }> {
    await this.userNotifications.syncAchievements(
      req.user.userId,
      body?.badges ?? [],
      body?.seenIds ?? [],
    );
    return { ok: true };
  }

  /**
   * Public avatar proxy. Telegram's photo hosts (t.me/i/userpic and
   * api.telegram.org/file) don't send CORS headers on the actual image, so a
   * <canvas> can't draw them with crossOrigin without tainting (which breaks
   * the share card's PNG export). We re-serve the user's stored photo from our
   * own origin with `Access-Control-Allow-Origin: *` so the card can draw AND
   * export it.
   *
   * This endpoint ALWAYS answers with an image, never a 404: the clients render
   * an <img> whenever `photoUrl` is set, so an error status paints a broken-image
   * icon rather than falling back to initials. When no real photo can be
   * resolved we draw the initials ourselves — see {@link initialsAvatarSvg}.
   */
  @Get("avatar/:id")
  @Public()
  @ApiOperation({ summary: "Proxy a user's profile photo with CORS headers" })
  async avatar(@Param("id") id: string, @Res() res: Response) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const user = await this.userRepo
      .findOne({
        where: { id },
        select: ["id", "telegramId", "photoUrl", "firstName", "username"],
      })
      .catch(() => null);

    if (!user) {
      res.status(404).end();
      return;
    }

    const photo = await this.resolveRealPhoto(user).catch(() => null);
    if (photo) {
      res.setHeader("Content-Type", photo.contentType);
      res.setHeader("Cache-Control", "public, max-age=1800");
      res.end(photo.body);
      return;
    }

    // No real photo anywhere. Serve generated initials so the <img> still
    // renders, on a shorter TTL so a newly-set photo appears reasonably soon.
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.end(
      this.initialsAvatarSvg(user.firstName || user.username || "", user.id),
    );
  }

  /**
   * The user's actual photo bytes, or null when they have none.
   *
   * Telegram serves a generated SVG placeholder (rather than a 404) for users
   * with no public photo, so an SVG response counts as "no real photo" — the
   * same rule `AuthService.isRealPhoto` applies to `photo_url`. Either that or
   * an expired Bot API file link then triggers one Bot API re-resolve, whose
   * result is persisted so the next request skips the round trip.
   */
  private async resolveRealPhoto(
    user: Pick<User, "id" | "telegramId" | "photoUrl">,
  ): Promise<{ body: Buffer; contentType: string } | null> {
    const fetchImage = async (url: string) => {
      const upstream = await fetch(url, {
        signal: AbortSignal.timeout(8000),
      }).catch(() => null);
      if (!upstream?.ok) return null;
      const contentType = upstream.headers.get("content-type") || "image/jpeg";
      if (/svg/i.test(contentType)) return null; // placeholder, not a photo
      return {
        body: Buffer.from(await upstream.arrayBuffer()),
        contentType,
      };
    };

    if (user.photoUrl) {
      const stored = await fetchImage(user.photoUrl);
      if (stored) return stored;
    }

    if (!user.telegramId) return null;

    const fresh = await this.telegramSimple
      .getUserProfilePhotoUrl(Number(user.telegramId))
      .catch(() => null);
    if (!fresh || fresh === user.photoUrl) return null;

    await this.userRepo.update(user.id, { photoUrl: fresh }).catch(() => {});
    return fetchImage(fresh);
  }

  /**
   * A circular initial on a colour derived from the user id, so the same person
   * always gets the same colour and two people side by side rarely collide.
   */
  private initialsAvatarSvg(name: string, seed: string): string {
    const initial = (name.trim().match(/[A-Za-z0-9]/)?.[0] ?? "?").toUpperCase();
    let hash = 0;
    for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) % 360;
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">` +
      `<circle cx="80" cy="80" r="80" fill="hsl(${hash} 55% 42%)"/>` +
      `<text x="80" y="80" fill="#fff" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif" ` +
      `font-size="76" font-weight="700" text-anchor="middle" dominant-baseline="central">${initial}</text>` +
      `</svg>`
    );
  }

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

    // If CID and phone are provided, validate they match in DK Bank before
    // sending OTP. The lookup is advisory: a DK outage must not block onboarding
    // (bank linking re-checks the phone later), so the lookup failing and the
    // phone genuinely mismatching have to stay separate — a single try/catch
    // around both turns every DK-side error into a hard 400 for the user.
    if (dto.cid && dto.phoneNumber) {
      const cleanCid = dto.cid.trim().replace(/\D/g, "");
      if (cleanCid.length === 11) {
        let bankPhone: string | null = null;
        try {
          bankPhone = (await this.dkGateway.lookupAccountByCID(cleanCid))
            .phoneNumber;
        } catch (e: any) {
          // DK unreachable / CID unknown / adapter error — let it pass.
          this.logger.warn(
            `Onboard CID phone pre-check skipped for ${cleanCid.slice(0, 3)}***${cleanCid.slice(-3)}: ${e?.message}`,
          );
        }

        if (bankPhone) {
          const stripToLocal = (p: string) => {
            let c = p.replace(/[\s\-()+ ]/g, "");
            if (c.startsWith("975") && c.length === 11) c = c.substring(3);
            return c;
          };
          if (stripToLocal(dto.phoneNumber) !== stripToLocal(bankPhone)) {
            throw new BadRequestException(
              `Phone number does not match your DK Bank account. The phone registered with CID ${cleanCid.slice(0, 3)}***${cleanCid.slice(-3)} is different from what you entered.`,
            );
          }
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
        // The account's currency decides which rail the client renders — DK
        // Bank for BTN, 21 Pay for USDT. Omitting it here made the wallet page
        // treat every account as BTN, so a USDT user saw a Top Up button that
        // could never work.
        "currency",
        "kycStatus",
        "dkAccountNumber",
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
        "featuredAchievementIds",
        "monthlyPodiums",
        "contrarianAttempts",
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
      creditsBalance = await ledgerBalanceForAccount(
        this.transactionRepo,
        userId,
      );
      await this.redis.setJsonEx(balanceCacheKey, 15, creditsBalance);
    }

    // A second wallet, when the account may hold one.
    //
    // `creditsBalance` above is deliberately untouched: it stays the native
    // currency's balance, which is what every existing screen renders. The
    // USDT wallet is reported separately and never added to it — there is no
    // rate between them, so a combined figure would be meaningless.
    const canHoldUsdt = allowedCurrencies(user as any).includes("USDT");
    // Two different questions, and the client needs both. An account created
    // through Google *may* hold USDT — it is the only currency it has — but it
    // cannot fund that wallet until a reviewer has approved a document. Showing
    // it a deposit form would earn it a 403.
    const usdtVerified = usdtIdentityVerified(user as any);
    const usdtBalance =
      canHoldUsdt && (user as any).currency !== "USDT"
        ? await ledgerBalance(this.transactionRepo, userId, "USDT")
        : null;

    // Derive boolean flags — never send raw hashes to the client. The raw
    // monthlyPodiums array is stripped too; only its derived counts go out.
    const { dkPhoneHash, telegramPhoneHash, monthlyPodiums, ...safeUser } =
      user as any;

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

    // Season-scoped EPL/UCL tallies for the collectible season badges.
    const seasonBadgeStats = await this.footballSeasonBadgeStats(userId);

    return {
      ...safeUser,
      creditsBalance,
      canHoldUsdt,
      usdtVerified,
      usdtBalance,
      isDkPhoneLinked: !!dkPhoneHash,
      isPhoneVerified: verifiedByPhone || verifiedByAccountNumber,
      referralCount,
      seasonBadgeStats,
      monthlyPodiumStats: this.podiumStats(monthlyPodiums),
      ...streakInfo,
    };
  }

  /** Count monthly podium finishes by rank for the Champion/Runner-Up/Third badges. */
  private podiumStats(
    podiums?: Array<{ rank: number }> | null,
  ): { gold: number; silver: number; bronze: number } {
    const p = Array.isArray(podiums) ? podiums : [];
    return {
      gold: p.filter((x) => Number(x?.rank) === 1).length,
      silver: p.filter((x) => Number(x?.rank) === 2).length,
      bronze: p.filter((x) => Number(x?.rank) === 3).length,
    };
  }

  @Post("me/featured-achievements")
  @HttpCode(200)
  @ApiOperation({ summary: "Choose up to three achievements to display publicly" })
  async setFeaturedAchievements(@Request() req: any, @Body() body: { achievementIds?: unknown }) {
    const ids = Array.isArray(body?.achievementIds) ? body.achievementIds : [];
    if (ids.length > 3 || ids.some((id) => typeof id !== "string" || id.length > 80)) {
      throw new BadRequestException("Choose up to three valid achievements");
    }
    const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    if (unique.length > 3) throw new BadRequestException("Choose up to three achievements");
    await this.userRepo.update(req.user.userId, { featuredAchievementIds: unique });
    return { featuredAchievementIds: unique };
  }

  @Get("profiles/:id")
  @ApiOperation({ summary: "Public predictor profile (safe leaderboard data only)" })
  async getPublicProfile(@Param("id") id: string) {
    const user = await this.userRepo.findOne({
      where: { id },
      select: [
        "id", "firstName", "lastName", "username", "photoUrl", "createdAt",
        "reputationScore", "reputationTier", "totalPredictions", "correctPredictions",
        "contrarianBadge", "contrarianWins",
        "betStreakCount", "betStreakLastAt",
        "featuredAchievementIds",
        "monthlyPodiums",
      ],
    });
    if (!user) throw new NotFoundException("Predictor not found");

    const rank =
      (await this.userRepo
        .createQueryBuilder("u")
        .where("u.totalPredictions >= 10")
        .andWhere("(u.reputationScore > :score OR (u.reputationScore = :score AND u.correctPredictions > :wins))", {
          score: user.reputationScore ?? 0,
          wins: user.correctPredictions,
        })
        .getCount()) + 1;

    const recentCalls = await this.betRepo.find({
      where: {
        userId: id,
        status: In([PositionStatus.WON, PositionStatus.LOST, PositionStatus.REFUNDED]),
      },
      relations: ["market", "outcome"],
      order: { placedAt: "DESC" },
      take: 3,
    });

    const seasonBadgeStats = await this.footballSeasonBadgeStats(id);

    return {
      id: user.id,
      seasonBadgeStats,
      monthlyPodiumStats: this.podiumStats(user.monthlyPodiums),
      firstName: user.firstName,
      lastName: user.lastName,
      username: user.username,
      photoUrl: user.photoUrl,
      reputationTier: user.reputationTier,
      reputationScore: user.reputationScore,
      totalPredictions: user.totalPredictions,
      correctPredictions: user.correctPredictions,
      winRate: user.totalPredictions
        ? Math.round((user.correctPredictions / user.totalPredictions) * 100)
        : 0,
      rank: user.totalPredictions >= 10 ? rank : null,
      betStreak: this.effectiveBetStreak(
        user.betStreakCount,
        user.betStreakLastAt,
      ),
      contrarianBadge: user.contrarianBadge,
      contrarianWins: user.contrarianWins ?? 0,
      featuredAchievementIds: user.featuredAchievementIds ?? [],
      recentCalls: recentCalls.map((call) => ({
        id: call.id,
        marketTitle: call.market?.title ?? "Prediction market",
        outcomeLabel: call.outcome?.label ?? "Selected outcome",
        status: call.status,
        payout: call.payout,
        placedAt: call.placedAt,
      })),
      joinedAt: user.createdAt,
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
  async getTransactions(
    @Request() req: any,
    @Query("limit") limit?: string,
    @Query("type") type?: TransactionType,
  ) {
    const take = Math.min(Number(limit) || 50, 200);
    const where: any = { userId: req.user.userId };
    if (type) where.type = type;
    const rows = await this.transactionRepo.find({
      where,
      order: { createdAt: "DESC" },
      take,
    });

    // Mark the debits that are still in flight.
    //
    // A USDT withdrawal debits immediately — the money is reserved the moment
    // it is requested — but it is not *sent* until an admin approves it and
    // 21Pay confirms. Showing that row identically to a completed cash-out
    // tells the user their money has gone out when it has not, and the first
    // thing they do is look for it on chain and not find it.
    const pending = await this.cryptoWithdrawalRepo.find({
      where: {
        userId: req.user.userId,
        debitTransactionId: In(rows.map((r) => r.id)),
      },
      select: ["debitTransactionId", "approvalStatus", "remoteStatus"],
    });
    const stateByTx = new Map(
      pending.map((w: CryptoWithdrawal) => [
        w.debitTransactionId,
        {
          approvalStatus: w.approvalStatus,
          remoteStatus: w.remoteStatus ?? null,
        },
      ]),
    );

    return rows.map((row) => {
      const state = stateByTx.get(row.id);
      if (!state) return row;
      const settled =
        state.approvalStatus === "rejected" ||
        state.remoteStatus === "completed";
      return Object.assign(row, {
        withdrawalState: state.approvalStatus,
        // One flag the client can render without knowing our state machine.
        isPending: !settled,
      });
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
    const referralLink = `https://t.me/${botUsername}?startapp=ref_${user?.telegramId ?? userId}`;

    // Browser/PWA share link — opens oro.fun with the ref code in the query
    // string, which the PWA reads on load and forwards as referralCode at login.
    const refId = user?.telegramId ?? userId;
    const webBase = (
      this.config.get<string>("FRONTEND_URL") ?? "https://oro.fun"
    ).replace(/\/+$/, "");
    const webReferralLink = `${webBase}/?ref=${refId}`;

    // Total bonus credited across all referrals
    // Scoped to the account's own currency, like every other ledger read.
    const { total } = await this.transactionRepo
      .createQueryBuilder("t")
      .select("COALESCE(SUM(t.amount), 0)", "total")
      .where(
        "t.userId = :userId AND t.type = :type AND t.currency = " +
          "(SELECT u.currency FROM users u WHERE u.id = :userId)",
        { userId, type: TransactionType.REFERRAL_BONUS },
      )
      .getRawOne();

    const referredCount = await this.userRepo.count({
      where: { referredByUserId: userId },
    });
    const convertedCount = await this.userRepo.count({
      where: { referredByUserId: userId, referralBonusTriggered: true },
    });

    return {
      referralLink,
      webReferralLink,
      referredCount,
      convertedCount,
      totalEarned: Number(total),
      flatBonus: ParimutuelEngine.REFERRAL_FLAT_BONUS,
      betPct: ParimutuelEngine.REFERRAL_BET_PCT * 100,
      cap: ParimutuelEngine.REFERRAL_CAP,
    };
  }

  // ── Leaderboard ───────────────────────────────────────────────────────────

  // Effective daily-bet streak for the board: the stored betStreakCount goes
  // stale (it isn't reset until the user's next bet), so mirror getStreakInfo —
  // a streak only counts while the last bet was today or yesterday (UTC),
  // otherwise report 0 so the board hides a broken streak like the profile does.
  private effectiveBetStreak(
    count: number,
    lastAt: string | Date | null,
  ): number {
    if (!count || !lastAt) return 0;
    const last =
      typeof lastAt === "string"
        ? lastAt.slice(0, 10)
        : new Date(lastAt).toISOString().slice(0, 10);
    const todayUtc = new Date().toISOString().slice(0, 10);
    const y = new Date();
    y.setUTCDate(y.getUTCDate() - 1);
    const yesterdayUtc = y.toISOString().slice(0, 10);
    return last === todayUtc || last === yesterdayUtc ? count : 0;
  }

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
        .addSelect("u.betStreakCount", "betStreakCount")
        .addSelect("u.betStreakLastAt", "betStreakLastAt")
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
          betStreak: this.effectiveBetStreak(
            Number(r.betStreakCount),
            r.betStreakLastAt,
          ),
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
        "u.betStreakCount",
        "u.betStreakLastAt",
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
      betStreak: this.effectiveBetStreak(u.betStreakCount, u.betStreakLastAt),
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
