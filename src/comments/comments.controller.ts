import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard, Public } from "../auth/guards";
import { CommentsService } from "./comments.service";
import {
  CreateCommentDto,
  EditCommentDto,
} from "./dto/create-comment.dto";
import { FlagCommentDto } from "./dto/flag-comment.dto";

@ApiTags("comments")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  /**
   * Public so a thread renders before sign-in. JwtAuthGuard still decodes a
   * present token on @Public() routes, so a signed-in caller gets isMine and
   * hasFlagged populated without a second endpoint.
   */
  @Public()
  @Get("markets/:id/comments")
  @ApiOperation({ summary: "A market's comments, newest first" })
  async list(
    @Request() req: any,
    @Param("id", ParseUUIDPipe) marketId: string,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
    @Query("order") order?: string,
  ) {
    return this.comments.list(marketId, req.user?.userId ?? null, {
      limit: limit ? parseInt(limit, 10) : undefined,
      cursor,
      order: order === "oldest" ? "oldest" : "newest",
    });
  }

  // The most spam-prone surface on the platform, and open to anyone signed in.
  // The global default is 120/min; the tightest existing write is the public
  // feedback form at 3/min. 5/min sits just above that.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("markets/:id/comments")
  @ApiOperation({ summary: "Post a comment on a market" })
  async create(
    @Request() req: any,
    @Param("id", ParseUUIDPipe) marketId: string,
    @Body() dto: CreateCommentDto,
  ) {
    return this.comments.create(
      marketId,
      req.user.userId,
      dto.body,
      dto.parentId ?? null,
    );
  }

  /**
   * Every reply under one comment, oldest first. Public for the same reason
   * the thread is: a reader should not have to sign in to follow it.
   */
  @Public()
  @Get("comments/:id/replies")
  @ApiOperation({ summary: "Replies to a comment, oldest first" })
  async replies(
    @Request() req: any,
    @Param("id", ParseUUIDPipe) commentId: string,
  ) {
    return this.comments.listReplies(commentId, req.user?.userId ?? null);
  }

  /**
   * Rewrite your own comment, inside the edit window. Throttled like posting:
   * an edit publishes text to the same audience a new comment does.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Patch("comments/:id")
  @ApiOperation({ summary: "Edit your own comment, shortly after posting" })
  async edit(
    @Request() req: any,
    @Param("id", ParseUUIDPipe) commentId: string,
    @Body() dto: EditCommentDto,
  ) {
    return this.comments.edit(commentId, req.user.userId, dto.body);
  }

  @Delete("comments/:id")
  @ApiOperation({ summary: "Delete your own comment" })
  async remove(
    @Request() req: any,
    @Param("id", ParseUUIDPipe) commentId: string,
  ) {
    return this.comments.remove(commentId, req.user.userId);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("comments/:id/flag")
  @HttpCode(200)
  @ApiOperation({ summary: "Report a comment for moderation" })
  async flag(
    @Request() req: any,
    @Param("id", ParseUUIDPipe) commentId: string,
    @Body() dto: FlagCommentDto,
  ) {
    return this.comments.flag(
      commentId,
      req.user.userId,
      dto.reason,
      dto.note ?? null,
    );
  }
}
