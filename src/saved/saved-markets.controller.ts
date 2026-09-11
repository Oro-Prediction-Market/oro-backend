import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard, Public } from "../auth/guards";
import { SavedMarketsService } from "./saved-markets.service";

/**
 * Saved markets — a predictor's public watchlist.
 *
 * Writing is yours alone: only the owner can add to or remove from a list.
 * Reading is open, because a saved list is part of a predictor's public
 * profile — the same place their record, tier and recent calls already live.
 * Anyone who can see the profile can see what that predictor is watching.
 */
@ApiTags("saved")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class SavedMarketsController {
  constructor(private readonly saved: SavedMarketsService) {}

  @Post("markets/:id/save")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Save a market to your list" })
  save(@Request() req: any, @Param("id", ParseUUIDPipe) marketId: string) {
    return this.saved.save(req.user.userId, marketId);
  }

  @Delete("markets/:id/save")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Remove a market from your list" })
  unsave(@Request() req: any, @Param("id", ParseUUIDPipe) marketId: string) {
    return this.saved.unsave(req.user.userId, marketId);
  }

  /**
   * The ids alone. Every surface that draws a bookmark icon asks for this once
   * on load rather than asking per card.
   */
  @Get("users/me/saved-markets/ids")
  @ApiOperation({ summary: "The ids of the markets you have saved" })
  ids(@Request() req: any) {
    return this.saved.listIds(req.user.userId);
  }

  @Get("users/me/saved-markets")
  @ApiOperation({ summary: "Your saved markets, most recently saved first" })
  list(@Request() req: any) {
    return this.saved.list(req.user.userId);
  }

  /**
   * Another predictor's list, for their public profile.
   *
   * Public for the same reason their record and recent calls are: a profile is
   * a page about how someone predicts, and what they are watching is part of
   * that. Capped, so a profile page cannot be made to serve thousands of
   * hydrated markets in one request.
   *
   * Declared after the "users/me/..." routes above so "me" is never read as an
   * id — Nest matches in declaration order.
   */
  @Public()
  @Get("users/:id/saved-markets")
  @ApiOperation({ summary: "A predictor's saved markets, most recent first" })
  listFor(@Param("id", ParseUUIDPipe) userId: string) {
    return this.saved.list(userId, SavedMarketsController.PUBLIC_LIMIT);
  }

  private static readonly PUBLIC_LIMIT = 30;
}
