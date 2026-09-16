import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import { Queue } from "bullmq";
import { createHash } from "crypto";
import { DataSource, Repository } from "typeorm";
import { Announcement } from "../entities/announcement.entity";
import { User } from "../entities/user.entity";
import { JobName, NOTIFICATION_QUEUE } from "../jobs/notification.queue";
import { RedisService } from "../redis/redis.service";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";
import { UserNotificationService } from "../users/user-notification.service";
import {
  readCounters,
  readErrorSamples,
} from "../shared/utils/announcement-stats.util";
import {
  evaluateFanOut,
  runtimeFingerprint,
} from "../shared/utils/broadcast-guard.util";

/**
 * Refuse an identical announcement sent again within this window. Catches the
 * admin who reloads the page (losing the request id) and retypes the same notice
 * because the first attempt "looked stuck".
 */
const DUPLICATE_CONTENT_WINDOW_MS = 10 * 60 * 1000;

/**
 * An audience larger than this means the process is pointed at a database it
 * should not be. At ~2,200 users, a query returning 200,000 rows is not growth.
 */
const MAX_PLAUSIBLE_AUDIENCE = 25_000;

/** A broadcast still `sending` after this long is treated as dead, not in flight. */
const STALE_SENDING_MS = 30 * 60 * 1000;

/** Telegram's queue-wide limiter is 25/s, shared with settlement DMs. */
const DM_PER_SECOND = 25;

@Injectable()
export class AnnouncementsService {
  private readonly logger = new Logger(AnnouncementsService.name);

  constructor(
    @InjectRepository(Announcement)
    private readonly repo: Repository<Announcement>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly notifications: UserNotificationService,
    private readonly telegram: TelegramSimpleService,
    private readonly redis: RedisService,
    @InjectQueue(NOTIFICATION_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Compose the DM exactly as the recipient will see it.
   *
   * The body is HTML-escaped because sendMessage uses `parse_mode: "HTML"`. An
   * admin who types a bare `<`, an unmatched `&`, or pastes "<3" would otherwise
   * get `400 can't parse entities` for EVERY recipient — the most likely way
   * this feature fails in production, and it fails uniformly.
   */
  static composeMessage(title: string, body: string): string {
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<b>${esc(title)}</b>\n\n${esc(body)}`;
  }

  /**
   * Length-prefixed rather than newline-joined.
   *
   * A plain `title + "\n" + body` collides whenever the title contains a
   * newline: ("a\nb", "c") and ("a", "b\nc") both hash "a\nb\nc". Two unrelated
   * announcements sharing a hash would have one of them spuriously refused by
   * the duplicate-content cooldown.
   */
  static contentHash(title: string, body: string): string {
    return createHash("sha256")
      .update(`${title.length}:${title}${body.length}:${body}`)
      .digest("hex");
  }

  /**
   * Send an announcement to every user: an in-app notification each, plus a
   * Telegram DM to everyone reachable.
   *
   * The work is done inline rather than handed to a background job. At this
   * scale the whole thing is one chunked insert and one `addBulk` — a couple of
   * seconds — and doing it here removes a real hazard: BullMQ's global
   * `attempts: 3` would otherwise re-run a fan-out job that had already enqueued
   * half the DMs. The individual DMs are still jobs, so delivery is still
   * rate-limited and still survives a restart.
   */
  async send(args: {
    adminId: string;
    title: string;
    body: string;
    clientRequestId: string;
    force?: boolean;
    ipAddress?: string;
  }): Promise<{ id: string; status: string; duplicate?: boolean }> {
    const verdict = evaluateFanOut();
    const runtime = runtimeFingerprint();
    const contentHash = AnnouncementsService.contentHash(args.title, args.body);

    // The JWT carries isAdmin and lives for 8 hours. For this one capability
    // that is too long a leash: re-read it.
    const admin = await this.userRepo.findOne({
      where: { id: args.adminId },
      select: ["id", "isAdmin", "telegramChatId", "telegramId"],
    });
    if (!admin?.isAdmin) {
      throw new BadRequestException("Admin privileges are required");
    }
    const adminChatId = this.resolveChatId(admin);

    if (!verdict.allowed) {
      // Record the attempt. A laptop holding the production bot token trying to
      // message every user is exactly the event you want a row for.
      const blocked = await this.repo.save(
        this.repo.create({
          clientRequestId: args.clientRequestId,
          contentHash,
          title: args.title,
          body: args.body,
          createdByAdminId: args.adminId,
          mode: "live",
          status: "blocked",
          error: verdict.reason,
          runtime,
          finishedAt: new Date(),
        }),
      );
      this.logger.error(`[announcement] REFUSED: ${verdict.reason}`);
      throw new ServiceUnavailableException({
        message: verdict.reason,
        announcementId: blocked.id,
      });
    }

    if (!args.force) {
      const recent = await this.repo
        .createQueryBuilder("a")
        .where("a.contentHash = :hash", { hash: contentHash })
        .andWhere("a.status NOT IN ('blocked','failed')")
        .andWhere("a.createdAt > :since", {
          since: new Date(Date.now() - DUPLICATE_CONTENT_WINDOW_MS),
        })
        .orderBy("a.createdAt", "DESC")
        .getOne();
      if (recent) {
        throw new ConflictException({
          message:
            "An identical announcement was sent in the last 10 minutes. Send anyway with force.",
          announcementId: recent.id,
          status: recent.status,
        });
      }
    }

    // Insert FIRST, do not check-then-insert: a SELECT followed by an INSERT
    // leaves the double-click race wide open, because both requests see nothing.
    let id: string;
    try {
      const inserted: Array<{ id: string }> = await this.dataSource.query(
        `INSERT INTO announcements
           ("clientRequestId","contentHash","title","body","createdByAdminId","mode","status","runtime")
         VALUES ($1,$2,$3,$4,$5,$6,'queued',$7)
         ON CONFLICT ("clientRequestId") DO NOTHING
         RETURNING id`,
        [
          args.clientRequestId,
          contentHash,
          args.title,
          args.body,
          args.adminId,
          verdict.mode,
          JSON.stringify(runtime),
        ],
      );

      if (!inserted.length) {
        // Same compose form, sent twice. Report the original; send nothing.
        const existing = await this.repo.findOneBy({
          clientRequestId: args.clientRequestId,
        });
        return {
          id: existing!.id,
          status: existing!.status,
          duplicate: true,
        };
      }
      id = inserted[0].id;
    } catch (err: any) {
      // The partial unique index allowing only one queued/sending row at a time.
      if (err?.code === "23505") {
        throw new ConflictException(
          "A broadcast is already in progress. Wait for it to finish.",
        );
      }
      throw err;
    }

    try {
      const message = AnnouncementsService.composeMessage(args.title, args.body);

      // Pre-flight: send the finished message to the composing admin and require
      // it to work, BEFORE touching the audience. One API call that catches
      // every formatting error, and doubles as a real preview.
      if (adminChatId) {
        const probe = await this.telegram.sendMessageChecked(
          adminChatId,
          message,
        );
        if (!probe.ok) {
          await this.repo.update(
            { id },
            {
              status: "failed",
              error: `Pre-flight failed: ${probe.description ?? probe.code}`,
              finishedAt: new Date(),
            },
          );
          throw new BadRequestException(
            `Telegram rejected this message: ${probe.description ?? `code ${probe.code}`}`,
          );
        }
      }

      const audience = await this.loadAudience(
        verdict.mode === "test" ? verdict.maxRecipients : undefined,
      );

      if (audience.users.length > MAX_PLAUSIBLE_AUDIENCE) {
        throw new ServiceUnavailableException(
          `Refusing to send to ${audience.users.length} users — this process looks pointed at the wrong database.`,
        );
      }

      // In-app rows and the counts commit together. The enqueue is deliberately
      // outside: if it ran inside and the transaction then rolled back, the DMs
      // would already be gone while no notification row and no record existed.
      await this.dataSource.transaction(async (m) => {
        await this.notifications.createBulk(
          m,
          audience.users.map((u) => ({
            userId: u.id,
            type: "announcement",
            title: args.title,
            body: args.body,
            // The handle that makes a retraction possible.
            metadata: { announcementId: id },
          })),
        );
        await m.getRepository(Announcement).update(
          { id },
          {
            status: "sending",
            audienceCount: audience.users.length,
            telegramRecipients: audience.chatIds.length,
            enqueuedCount: audience.chatIds.length,
            startedAt: new Date(),
          },
        );
      });

      await this.enqueueDms(id, audience.chatIds, message, adminChatId);

      this.logger.log(
        `[announcement] ${id} mode=${verdict.mode} inApp=${audience.users.length} dms=${audience.chatIds.length}`,
      );
      return { id, status: "sending" };
    } catch (err: any) {
      await this.repo
        .update(
          { id },
          {
            status: "failed",
            error: err?.message ?? String(err),
            finishedAt: new Date(),
          },
        )
        .catch(() => {});
      throw err;
    }
  }

  /**
   * Everyone, in one pass.
   *
   * One query rather than two: reading the audience twice would let a user
   * created in between get a DM with no in-app row, or the reverse. Raw rows
   * rather than hydrated entities — `User` has ~60 columns including several
   * jsonb, and this needs three of them.
   */
  private async loadAudience(limit?: number): Promise<{
    users: Array<{ id: string }>;
    chatIds: number[];
  }> {
    const qb = this.userRepo
      .createQueryBuilder("u")
      .select(["u.id AS id", "u.telegramChatId AS chat", "u.telegramId AS tg"])
      .orderBy("u.id", "ASC");
    if (limit) qb.limit(limit);
    const rows: Array<{ id: string; chat: string | null; tg: string | null }> =
      await qb.getRawMany();

    const seen = new Set<number>();
    const chatIds: number[] = [];
    for (const r of rows) {
      const n = this.resolveChatId({ telegramChatId: r.chat, telegramId: r.tg });
      if (n === null) continue;
      // Two accounts sharing one Telegram id is one human. Account merges leave
      // these behind, and one person should get one DM.
      if (seen.has(n)) continue;
      seen.add(n);
      chatIds.push(n);
    }
    return { users: rows.map((r) => ({ id: r.id })), chatIds };
  }

  /**
   * Prefer `telegramChatId`, fall back to `telegramId` — the same reconciliation
   * as auth.service.ts:345. Both columns are varchar and hold junk in places, so
   * the result is validated rather than trusted.
   */
  private resolveChatId(u: {
    telegramChatId?: string | null;
    telegramId?: string | null;
  }): number | null {
    const n = Number(u.telegramChatId ?? u.telegramId);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  private async enqueueDms(
    announcementId: string,
    chatIds: number[],
    message: string,
    adminChatId: number | null,
  ): Promise<void> {
    if (!chatIds.length) {
      // Nothing to deliver; finalise straight away so the row does not sit in
      // `sending` forever blocking the next broadcast.
      await this.queue.add(
        JobName.ANNOUNCEMENT_FINALIZE,
        { announcementId, adminChatId },
        { attempts: 1, removeOnComplete: true },
      );
      return;
    }

    await this.queue.addBulk(
      chatIds.map((telegramChatId) => ({
        name: JobName.ANNOUNCEMENT_DM,
        data: {
          announcementId,
          telegramChatId,
          message,
          total: chatIds.length,
          adminChatId,
        },
        opts: {
          // Lower than settlement and payment DMs (which use the default 0), so
          // a market settling during an 88-second broadcast is not stuck behind
          // 2,199 jobs on the shared 25/s limiter.
          priority: 10,
          // Two, not the global three: a blocked user is terminal and handled
          // explicitly, so extra attempts only spend the rate limit.
          attempts: 2,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: true,
        },
      })),
    );

    // Backstop. The last DM to finish normally triggers finalisation; this
    // catches the case where a worker dies and that moment never comes.
    await this.queue.add(
      JobName.ANNOUNCEMENT_FINALIZE,
      { announcementId, adminChatId },
      {
        delay: Math.ceil((chatIds.length / DM_PER_SECOND) * 1000) + 60_000,
        attempts: 1,
        removeOnComplete: true,
      },
    );
  }

  /** One announcement, with live counters merged over the stored row. */
  async findOne(id: string): Promise<Record<string, unknown>> {
    const row = await this.repo.findOneBy({ id });
    if (!row) throw new NotFoundException();

    if (row.status !== "sending") return { ...row };

    const counters = await readCounters(this.redis.redis, id);
    const stale =
      row.startedAt && Date.now() - row.startedAt.getTime() > STALE_SENDING_MS;

    if (stale) {
      // Computed here rather than by a cron. Another unguarded scheduled job is
      // the category of problem this feature is trying not to add to — and a
      // stuck row would otherwise block every future broadcast via the
      // one-in-flight index.
      await this.repo.update(
        { id },
        {
          status: "failed",
          error: "Timed out — delivery stopped reporting progress.",
          sentCount: counters.sent,
          blockedCount: counters.blocked,
          failedCount: counters.failed,
          finishedAt: new Date(),
        },
      );
      return { ...row, status: "failed", ...counters, stalled: true };
    }

    const remaining = Math.max(0, row.enqueuedCount - counters.done);
    return {
      ...row,
      sentCount: counters.sent,
      blockedCount: counters.blocked,
      failedCount: counters.failed,
      etaSeconds: Math.ceil(remaining / DM_PER_SECOND),
    };
  }

  async list(page = 1, limit = 20) {
    const [data, total] = await this.repo.findAndCount({
      order: { createdAt: "DESC" },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
  }

  /**
   * Take back the in-app half of a broadcast.
   *
   * The DMs are gone the moment they land — nothing can recall those. The
   * notification rows can still be removed, which is the difference between a
   * mistake that lingers in everyone's bell and one that does not.
   */
  async retract(id: string): Promise<{ removed: number }> {
    const row = await this.repo.findOneBy({ id });
    if (!row) throw new NotFoundException();
    const removed = await this.notifications.removeByAnnouncement(id);
    await this.repo.update({ id }, { audienceCount: 0 });
    this.logger.warn(`[announcement] ${id} retracted — ${removed} rows removed`);
    return { removed };
  }

  /** Error samples, for the admin detail view. */
  async errorSamples(id: string) {
    return readErrorSamples(this.redis.redis, id);
  }
}
