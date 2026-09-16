import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AdminGuard, JwtAuthGuard } from "../auth/guards";
import { AuditAction } from "../entities/audit-log.entity";
import { AuditService } from "./audit.service";
import { AnnouncementsService } from "./announcements.service";
import { SendAnnouncementDto } from "./dto/send-announcement.dto";

/**
 * Admin broadcasts: a notice written in the dashboard and sent to every user.
 *
 * Deliberately its own file rather than another 100 lines in admin.controller.ts
 * (~1,700 lines already). This is the only endpoint in the codebase that reaches
 * every user at once and cannot be undone, so it should be readable on one
 * screen by whoever reviews it next.
 */
@ApiTags("admin")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller("admin/announcements")
export class AnnouncementsController {
  constructor(
    private readonly announcements: AnnouncementsService,
    private readonly auditService: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List past announcements, newest first" })
  async list(
    @Query("page", new ParseIntPipe({ optional: true })) page = 1,
    @Query("limit", new ParseIntPipe({ optional: true })) limit = 20,
  ) {
    return this.announcements.list(page, Math.min(limit, 100));
  }

  @Get(":id")
  @ApiOperation({ summary: "One announcement, with live delivery progress" })
  async findOne(@Param("id") id: string) {
    return this.announcements.findOne(id);
  }

  @Get(":id/errors")
  @ApiOperation({ summary: "A bounded sample of delivery failures" })
  async errors(@Param("id") id: string) {
    return this.announcements.errorSamples(id);
  }

  /**
   * Send to everyone.
   *
   * Throttled hard — three an hour. The global limit is 120/min, which is the
   * right number for reading a list and the wrong one for an irreversible action
   * against the entire user base.
   */
  @Post()
  @HttpCode(200)
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  @ApiOperation({ summary: "Send an announcement to every user (in-app + Telegram DM)" })
  async send(@Request() req: any, @Body() dto: SendAnnouncementDto) {
    let result: { id: string; status: string; duplicate?: boolean };
    try {
      result = await this.announcements.send({
        adminId: req.user.userId,
        title: dto.title,
        body: dto.body,
        clientRequestId: dto.clientRequestId,
        force: dto.force,
        ipAddress: req.ip,
      });
    } catch (err: any) {
      // A refusal by the fan-out guard means a machine outside the production
      // cluster, holding the production bot token, tried to message every user.
      // That is worth a permanent record even though nothing was sent.
      const blockedId = err?.response?.announcementId;
      if (blockedId) {
        await this.auditService
          .log({
            adminId: req.user.userId,
            isAdmin: true,
            action: AuditAction.ANNOUNCEMENT_BLOCKED,
            entityType: "announcement",
            entityId: blockedId,
            after: { reason: err?.response?.message },
            ipAddress: req.ip,
          })
          .catch(() => {});
      }
      throw err;
    }

    // A duplicate is a no-op, so it is not an event worth an audit row.
    if (!result.duplicate) {
      await this.auditService.log({
        adminId: req.user.userId,
        isAdmin: true,
        action: AuditAction.ANNOUNCEMENT_BROADCAST,
        entityType: "announcement",
        entityId: result.id,
        after: { title: dto.title, bodyLength: dto.body.length },
        ipAddress: req.ip,
      });
    }

    return result;
  }

  @Post(":id/retract")
  @HttpCode(200)
  @ApiOperation({
    summary: "Delete the in-app notifications for an announcement (DMs cannot be recalled)",
  })
  async retract(@Request() req: any, @Param("id") id: string) {
    const result = await this.announcements.retract(id);
    await this.auditService.log({
      adminId: req.user.userId,
      isAdmin: true,
      action: AuditAction.ANNOUNCEMENT_RETRACT,
      entityType: "announcement",
      entityId: id,
      after: { removed: result.removed },
      ipAddress: req.ip,
    });
    return result;
  }
}
