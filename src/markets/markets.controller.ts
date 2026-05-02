import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
} from "@nestjs/swagger";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Dispute } from "../entities/dispute.entity";
import { User } from "../entities/user.entity";
import { JwtAuthGuard, Public, AdminGuard } from "../auth/guards";
import {
  MarketsService,
  OpenPositionDto,
  UpdateMarketDto,
  SubmitDisputeDto,
} from "./markets.service";
import { RedisService } from "../redis/redis.service";

@ApiTags("markets")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("markets")
export class MarketsController {
  constructor(
    private marketsService: MarketsService,
    @InjectRepository(User) private userRepo: Repository<User>,
    private redis: RedisService,
  ) {}

  @Get()
  @Public()
  @ApiOperation({
    summary: "List all markets, optionally filtered by search query",
  })
  @ApiQuery({
    name: "q",
    required: false,
    description: "Search term to filter markets by title or description",
  })
  findAll(@Query("q") q?: string) {
    return this.marketsService.findAll(q);
  }

  @Get("resolved")
  @Public()
  @ApiOperation({
    summary:
      "List resolved/settled markets with winner, resolution criteria and evidence",
  })
  getResolved() {
    return this.marketsService.getResolvedMarkets();
  }

  @Get("resolution-log")
  @Public()
  @ApiOperation({
    summary:
      "Public resolution transparency log — every past market with its decision, " +
      "evidence URL, objection count, and whether the outcome was changed after objections. " +
      "Used for the public trust dashboard.",
  })
  getResolutionLog() {
    return this.marketsService.getResolutionLog();
  }

  @Get("admin-accuracy")
  @Public()
  @ApiOperation({
    summary:
      "Public admin accountability scoreboard. Shows how often each admin's resolution " +
      "was overturned by objectors. Admins with >20% overturn rate are flagged.",
  })
  async getAdminAccuracy() {
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
      .filter((a) => (a.adminTotalResolutions ?? 0) > 0)
      .map((a) => {
        const total = a.adminTotalResolutions ?? 0;
        const wrong = a.adminWrongResolutions ?? 0;
        const correct = total - wrong;
        const accuracyPct =
          total > 0 ? Math.round((correct / total) * 100) : null;
        const overturnPct =
          total > 0 ? Math.round((wrong / total) * 100) : null;
        return {
          name: a.username ? `@${a.username}` : (a.firstName ?? "Admin"),
          totalResolutions: total,
          correctResolutions: correct,
          wrongResolutions: wrong,
          accuracyPct,
          overturnPct,
          flagged: overturnPct !== null && overturnPct > 20,
        };
      })
      .sort((a, b) => b.totalResolutions - a.totalResolutions);
  }

  @Get("activity")
  @Public()
  @ApiOperation({
    summary: "Recent bet/win events for the live activity ticker",
  })
  getRecentActivity() {
    return this.marketsService.getRecentActivity(20);
  }

  @Get(":id")
  @Public()
  @ApiOperation({ summary: "Get market by ID with outcomes & live odds" })
  findOne(@Param("id") id: string) {
    return this.marketsService.findOne(id);
  }

  @Patch(":id")
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiOperation({ summary: "Update market metadata (admin)" })
  update(@Param("id") id: string, @Body() dto: UpdateMarketDto) {
    return this.marketsService.update(id, dto);
  }

  @Post(":id/bets")
  @ApiOperation({ summary: "Place a bet on a market outcome" })
  async placeBet(
    @Param("id") id: string,
    @Body() dto: OpenPositionDto,
    @Request() req: any,
  ) {
    // Rate limit: max 5 bets per user per 60s across all markets
    const { allowed } = await this.redis.rateLimit(
      `bet:${req.user.userId}`,
      5,
      60,
    );
    if (!allowed) {
      throw new BadRequestException(
        "Too many bets placed. Please wait a moment before trying again.",
      );
    }
    return this.marketsService.placeBet(req.user.userId, id, dto);
  }

  @Get(":id/disputes")
  @Public()
  @ApiOperation({ summary: "Get disputes for a market" })
  @ApiResponse({ status: 200, type: [Dispute] })
  getDisputes(@Param("id") id: string) {
    return this.marketsService.getDisputesByMarket(id);
  }

  @Get(":id/dispute-info")
  @Public()
  @ApiOperation({
    summary:
      "Get objection count, window status, deadline, and your bond cost to object (if authenticated)",
  })
  getDisputeInfo(@Param("id") id: string, @Request() req: any) {
    const userId = req?.user?.userId as string | undefined;
    return this.marketsService.getDisputeInfo(id, userId);
  }

  @Post(":id/disputes")
  @ApiOperation({
    summary:
      "Submit an objection during the resolution window. A fixed bond of Nu 5,000 is locked. Bond is returned + rewarded if you are right, forfeited if wrong.",
  })
  @ApiResponse({ status: 201, type: Dispute })
  submitDispute(
    @Param("id") id: string,
    @Body() dto: SubmitDisputeDto,
    @Request() req: any,
  ) {
    return this.marketsService.submitDispute(req.user.userId, id, dto);
  }

  @Post(":id/bets/wallet")
  @Public()
  @ApiOperation({ summary: "Place a bet using TON wallet (no login required)" })
  async placeBetWithWallet(
    @Param("id") id: string,
    @Body()
    dto: {
      outcomeId: string;
      amount: number;
      walletAddress: string;
      txHash?: string;
    },
  ) {
    // TODO: Verify TON transaction on-chain before accepting bet
    return {
      message:
        "Wallet betting endpoint - TODO: implement on-chain verification",
      dto,
    };
  }
}
