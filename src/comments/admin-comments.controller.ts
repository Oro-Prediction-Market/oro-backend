import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AdminGuard, JwtAuthGuard } from "../auth/guards";
import { CommentsService } from "./comments.service";
import {
  AdminDeleteCommentDto,
  AdminlistCommentsDto,
  AdminMuteUserDto,
} from "./dto/admin-comment.dto";

/**
 * The moderation surface, kept in its own controller so the user-facing routes
 * stay free of admin guards.
 */
@ApiTags("admin")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller("admin")
export class AdminCommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get("comments")
  @ApiOperation({ summary: "Moderation queue — most-reported first" })
  async list(@Query() query: AdminlistCommentsDto) {
    return this.comments.adminList({
      flagged: query.flagged === "true",
      marketId: query.marketId,
      userId: query.userId,
      page: query.page,
      limit: query.limit,
    });
  }

  @Delete("comments/:id")
  @ApiOperation({ summary: "Remove a comment and tell its author why" })
  async remove(
    @Param("id", ParseUUIDPipe) commentId: string,
    @Body() dto: AdminDeleteCommentDto,
  ) {
    return this.comments.adminRemove(commentId, dto.reason);
  }

  @Post("users/:id/comment-mute")
  @HttpCode(200)
  @ApiOperation({ summary: "Pause a user's commenting for a number of hours" })
  async mute(
    @Param("id", ParseUUIDPipe) userId: string,
    @Body() dto: AdminMuteUserDto,
  ) {
    return this.comments.adminMute(userId, dto.hours, dto.reason ?? null);
  }

  @Delete("users/:id/comment-mute")
  @ApiOperation({ summary: "Lift a commenting pause early" })
  async unmute(@Param("id", ParseUUIDPipe) userId: string) {
    return this.comments.adminUnmute(userId);
  }
}
