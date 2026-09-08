import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { IsUUID } from "class-validator";
import { JwtAuthGuard, Public } from "../auth/guards";
import { FreeCallsService } from "./free-calls.service";

export class CreateFreeCallDto {
  @IsUUID()
  marketId: string;

  @IsUUID()
  outcomeId: string;
}

@ApiTags("free-calls")
@Controller("free-calls")
export class FreeCallsController {
  constructor(private readonly freeCalls: FreeCallsService) {}

  @Post()
  @HttpCode(201)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Make a no-stake call on an open market. One per market, and not " +
      "available if you already have a staked prediction on it.",
  })
  async call(@Request() req: any, @Body() dto: CreateFreeCallDto) {
    return this.freeCalls.call(req.user.userId, dto.marketId, dto.outcomeId);
  }

  @Get("mine")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "The current user's free calls, newest first" })
  @ApiQuery({ name: "limit", required: false, description: "Default 50, max 200" })
  async mine(@Request() req: any, @Query("limit") limit?: string) {
    const parsed = limit ? Number(limit) : undefined;
    return this.freeCalls.listMine(
      req.user.userId,
      Number.isFinite(parsed) ? (parsed as number) : undefined,
    );
  }

  @Get("mine/:marketId")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "The current user's call on one market, or null — drives button state",
  })
  async mineForMarket(
    @Request() req: any,
    @Param("marketId", ParseUUIDPipe) marketId: string,
  ) {
    return this.freeCalls.findMineForMarket(req.user.userId, marketId);
  }

  @Get("leaderboard")
  @Public()
  @ApiOperation({
    summary:
      "Free-call accuracy leaderboard, best calibration (lowest Brier) first. " +
      "Public — being right in the open is the point.",
  })
  @ApiQuery({ name: "limit", required: false, description: "Default 25, max 100" })
  async leaderboard(@Query("limit") limit?: string) {
    const parsed = limit ? Number(limit) : undefined;
    return this.freeCalls.leaderboard(
      Number.isFinite(parsed) ? (parsed as number) : undefined,
    );
  }
}
