import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from "@nestjs/swagger";
import { IsNumber, IsString, IsUUID, Min, IsOptional, IsEnum } from "class-validator";
import { Type } from "class-transformer";
import { JwtAuthGuard, Public } from "../auth/guards";
import { ChallengesService } from "./challenges.service";
import { CardType } from "../entities/challenge.entity";

class CreateChallengeDto {
  @ApiProperty()
  @IsString()
  @IsUUID()
  marketId: string;

  @ApiProperty()
  @IsString()
  @IsUUID()
  outcomeId: string;

  @ApiProperty({ description: "Oro credits to wager (0 = bragging rights only)", required: false, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  wagerAmount?: number;

  @ApiProperty({ description: "Power card to equip for this duel", enum: CardType, required: false })
  @IsOptional()
  @IsEnum(CardType)
  equippedCard?: CardType;
}

@ApiTags("challenges")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("challenges")
export class ChallengesController {
  constructor(private readonly challengesService: ChallengesService) {}

  @Get("cards")
  @ApiOperation({ summary: "My power card inventory" })
  getCards(@Req() req: any) {
    return this.challengesService.getCardInventory(req.user.userId);
  }

  @Post()
  @ApiOperation({ summary: "Create a prediction duel" })
  async create(@Req() req: any, @Body() dto: CreateChallengeDto) {
    const challenge = await this.challengesService.create(
      req.user.userId,
      dto.marketId,
      dto.outcomeId,
      dto.wagerAmount ?? 0,
      dto.equippedCard,
    );
    return this.toResponse(challenge, req.user.userId);
  }

  @Get()
  @ApiOperation({ summary: "My active duels (created + joined)" })
  async findAll(@Req() req: any) {
    const challenges = await this.challengesService.findForUser(req.user.userId);
    return challenges.map((c) => this.toResponse(c, req.user.userId));
  }

  @Get("open")
  @ApiOperation({ summary: "Community open duels anyone can accept" })
  async findOpen(@Req() req: any) {
    const challenges = await this.challengesService.findOpen(req.user.userId);
    return challenges.map((c) => this.toResponse(c, req.user.userId));
  }

  @Get("leaderboard")
  @ApiOperation({ summary: "Weekly duel leaderboard — most wins" })
  getLeaderboard() {
    return this.challengesService.getLeaderboard();
  }

  @Post(":id/join")
  @ApiOperation({ summary: "Accept and join a duel" })
  async join(@Req() req: any, @Param("id") id: string) {
    const challenge = await this.challengesService.join(id, req.user.userId);
    return this.toResponse(challenge, req.user.userId);
  }

  @Public()
  @Get(":id/preview")
  @ApiOperation({
    summary:
      "Public challenge preview — powers the landing page a challenge deep link opens before sign-in",
  })
  getPreview(@Param("id") id: string) {
    return this.challengesService.getPublicPreview(id);
  }

  private toResponse(challenge: any, currentUserId: string) {
    const botUsername = process.env.BOT_USERNAME ?? "OroPredictBot";
    const link = `https://t.me/${botUsername}?startapp=challenge_${challenge.id}`;

    const isOwner = challenge.creatorId === currentUserId;
    // Ghost card: hide wager amount from non-owners while challenge is still OPEN
    const ghostActive =
      challenge.equippedCard === CardType.GHOST &&
      challenge.status === "open" &&
      !isOwner;

    return {
      id: challenge.id,
      marketId: challenge.marketId,
      marketTitle: challenge.market?.title ?? null,
      outcomeId: challenge.outcomeId,
      outcomeLabel: challenge.outcome?.label ?? null,
      creatorId: challenge.creatorId,
      // Never expose raw telegramId (a directly-resolvable account handle) to
      // other users — fall back to first name, then a generic label.
      creatorName:
        challenge.creator?.username ??
        challenge.creator?.firstName ??
        "Anonymous",
      joinerId: challenge.joinerId ?? null,
      joinerName:
        challenge.joiner?.username ??
        challenge.joiner?.firstName ??
        null,
      winnerId: challenge.winnerId ?? null,
      wagerAmount: ghostActive ? null : Number(challenge.wagerAmount ?? 0),
      isOwner,
      participantCount: challenge.participantCount,
      status: challenge.status,
      equippedCard: challenge.equippedCard ?? null,
      expiresAt: challenge.expiresAt,
      settledAt: challenge.settledAt ?? null,
      createdAt: challenge.createdAt,
      link,
    };
  }
}
