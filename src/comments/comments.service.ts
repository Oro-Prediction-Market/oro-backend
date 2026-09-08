import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, In, IsNull, Repository } from "typeorm";
import {
  CommentDeletedBy,
  MarketComment,
} from "../entities/market-comment.entity";
import {
  CommentFlagReason,
  MarketCommentFlag,
} from "../entities/market-comment-flag.entity";
import { Market, MarketStatus } from "../entities/market.entity";
import { User } from "../entities/user.entity";
import { UserNotificationService } from "../users/user-notification.service";
import { findBlockedTerm } from "./blocklist";
import { COMMENT_MAX_LENGTH } from "./dto/create-comment.dto";

/** Postgres unique-violation. Relied on instead of a racy read-then-write. */
const PG_UNIQUE_VIOLATION = "23505";

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

/** One comment as the apps render it. */
export interface CommentView {
  id: string;
  body: string;
  createdAt: Date;
  author: {
    id: string;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
    photoUrl: string | null;
    reputationTier: string;
  } | null;
  /**
   * The outcome this author is backing in this market, resolved live rather
   * than snapshotted — see resolveSides(). Null when they have no position.
   */
  side: { outcomeId: string; label: string } | null;
  isMine: boolean;
  hasFlagged: boolean;
  deleted: boolean;
  deletedBy: CommentDeletedBy | null;
}

@Injectable()
export class CommentsService {
  private readonly logger = new Logger(CommentsService.name);

  constructor(
    @InjectRepository(MarketComment)
    private readonly repo: Repository<MarketComment>,
    @InjectRepository(MarketCommentFlag)
    private readonly flagRepo: Repository<MarketCommentFlag>,
    @InjectRepository(Market)
    private readonly marketRepo: Repository<Market>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly notifications: UserNotificationService,
    private readonly dataSource: DataSource,
  ) {}

  // ── Reading ────────────────────────────────────────────────────────────────

  /**
   * A page of a market's thread, newest first.
   *
   * Cursor paginated on createdAt (`before` = the ISO timestamp of the last row
   * you saw), matching the newest convention in the codebase — see
   * UserNotificationService.listAll.
   *
   * `viewerId` is optional because the route is public: JwtAuthGuard still
   * decodes a present token on @Public() routes, so a signed-in caller gets
   * isMine/hasFlagged populated and a signed-out one simply does not.
   */
  async list(
    marketId: string,
    viewerId: string | null,
    opts: { limit?: number; before?: string } = {},
  ): Promise<CommentView[]> {
    const take = Math.min(
      Math.max(opts.limit ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );

    const qb = this.repo
      .createQueryBuilder("c")
      .leftJoinAndSelect("c.user", "u")
      .where("c.marketId = :marketId", { marketId })
      // A comment the author removed disappears entirely. One a moderator
      // removed stays as a tombstone, so a thread that was moderated does not
      // silently reshape itself and look like nothing happened.
      .andWhere("(c.deletedAt IS NULL OR c.deletedBy = :admin)", {
        admin: CommentDeletedBy.ADMIN,
      })
      .orderBy("c.createdAt", "DESC")
      .take(take);

    if (opts.before) {
      const before = new Date(opts.before);
      if (!Number.isNaN(before.getTime())) {
        qb.andWhere("c.createdAt < :before", { before });
      }
    }

    const rows = await qb.getMany();
    if (rows.length === 0) return [];

    const authorIds = [...new Set(rows.map((r) => r.userId))];
    const [sides, flagged] = await Promise.all([
      this.resolveSides(marketId, authorIds),
      this.flaggedByViewer(
        rows.map((r) => r.id),
        viewerId,
      ),
    ]);

    return rows.map((row) => this.toView(row, viewerId, sides, flagged));
  }

  /**
   * Which outcome each author is backing, by total stake in this market.
   *
   * Resolved at read time rather than stored on the comment: a snapshot goes
   * stale the moment someone adds to their position, and showing a side they no
   * longer hold is worse than showing none at all.
   *
   * A user holding several outcomes shows the largest. `amount` is a decimal
   * column, which pg returns as a string, so the sum is done in SQL — adding
   * these up in JS would concatenate strings.
   */
  private async resolveSides(
    marketId: string,
    userIds: string[],
  ): Promise<Map<string, { outcomeId: string; label: string }>> {
    const out = new Map<string, { outcomeId: string; label: string }>();
    if (userIds.length === 0) return out;

    type Row = { userId: string; outcomeId: string; label: string };
    let rows: Row[] = [];
    try {
      rows = await this.dataSource.query(
        `
        SELECT DISTINCT ON (p."userId")
               p."userId"    AS "userId",
               p."outcomeId" AS "outcomeId",
               o."label"     AS "label"
        FROM positions p
        JOIN outcomes o ON o."id" = p."outcomeId"
        WHERE p."marketId" = $1 AND p."userId" = ANY($2)
        GROUP BY p."userId", p."outcomeId", o."label"
        ORDER BY p."userId", SUM(p."amount") DESC
        `,
        [marketId, userIds],
      );
    } catch (err: any) {
      // A missing side badge is cosmetic; it must never take down the thread.
      this.logger.warn(`Could not resolve comment sides: ${err.message}`);
      return out;
    }

    for (const r of rows) {
      out.set(r.userId, { outcomeId: r.outcomeId, label: r.label });
    }
    return out;
  }

  /** The subset of `commentIds` this viewer has already reported. */
  private async flaggedByViewer(
    commentIds: string[],
    viewerId: string | null,
  ): Promise<Set<string>> {
    if (!viewerId || commentIds.length === 0) return new Set();
    const rows = await this.flagRepo.find({
      where: { userId: viewerId, commentId: In(commentIds) },
      select: { commentId: true },
    });
    return new Set(rows.map((r) => r.commentId));
  }

  private toView(
    row: MarketComment,
    viewerId: string | null,
    sides: Map<string, { outcomeId: string; label: string }>,
    flagged: Set<string>,
  ): CommentView {
    const removed = row.deletedAt != null;
    return {
      id: row.id,
      // A removed comment's text is never sent to clients — the row is kept for
      // the moderation record, not for reading.
      body: removed ? "" : row.body,
      createdAt: row.createdAt,
      author: removed
        ? null
        : {
            id: row.userId,
            username: row.user?.username ?? null,
            firstName: row.user?.firstName ?? null,
            lastName: row.user?.lastName ?? null,
            photoUrl: row.user?.photoUrl ?? null,
            reputationTier: row.user?.reputationTier ?? "rookie",
          },
      side: removed ? null : (sides.get(row.userId) ?? null),
      isMine: viewerId != null && row.userId === viewerId,
      hasFlagged: flagged.has(row.id),
      deleted: removed,
      deletedBy: row.deletedBy ?? null,
    };
  }

  // ── Writing ────────────────────────────────────────────────────────────────

  async create(
    marketId: string,
    userId: string,
    rawBody: string,
  ): Promise<CommentView> {
    const market = await this.marketRepo.findOne({
      where: { id: marketId },
      select: { id: true, status: true },
    });
    if (!market) throw new NotFoundException("Market not found");

    if (market.status === MarketStatus.CANCELLED) {
      throw new BadRequestException(
        "This market was cancelled, so its thread is closed.",
      );
    }
    // The lock. Settled threads stay readable as a record of who called it
    // right, but they stop accepting new comments — a decided bet is where
    // arguments start, and a dead market should stop generating moderation.
    if (market.status === MarketStatus.SETTLED) {
      throw new BadRequestException(
        "This market has settled — its comments are closed.",
      );
    }

    const author = await this.userRepo.findOne({
      where: { id: userId },
      select: { id: true, commentsBlockedUntil: true },
    });
    if (!author) throw new NotFoundException("User not found");
    if (
      author.commentsBlockedUntil &&
      author.commentsBlockedUntil.getTime() > Date.now()
    ) {
      throw new ForbiddenException(
        "Your commenting is paused by a moderator. Try again later.",
      );
    }

    // Trim in the service as well as capping in the DTO — the DTO measures the
    // untrimmed string, so " ".repeat(600) passes @MaxLength but is empty.
    const body = rawBody.trim();
    if (body.length === 0) {
      throw new BadRequestException("A comment cannot be empty.");
    }
    if (body.length > COMMENT_MAX_LENGTH) {
      throw new BadRequestException(
        `A comment cannot be longer than ${COMMENT_MAX_LENGTH} characters.`,
      );
    }

    const blocked = findBlockedTerm(body);
    if (blocked) {
      // Log the term, never the comment — the body is the user's, and it does
      // not belong in the application log.
      this.logger.log(`Blocked comment from ${userId} (term: ${blocked})`);
      throw new BadRequestException(
        "That comment contains language we don't allow. Please rephrase it.",
      );
    }

    const saved = await this.repo.save(
      this.repo.create({ marketId, userId, body }),
    );

    const [user, sides] = await Promise.all([
      this.userRepo.findOne({ where: { id: userId } }),
      this.resolveSides(marketId, [userId]),
    ]);
    saved.user = user as User;

    return this.toView(saved, userId, sides, new Set());
  }

  /** Author-initiated removal. The row survives; the text stops being served. */
  async remove(commentId: string, userId: string): Promise<{ ok: true }> {
    const comment = await this.repo.findOne({ where: { id: commentId } });
    if (!comment) throw new NotFoundException("Comment not found");
    if (comment.userId !== userId) {
      throw new ForbiddenException("You can only delete your own comments.");
    }
    if (comment.deletedAt) return { ok: true };

    await this.repo.update(commentId, {
      deletedAt: new Date(),
      deletedBy: CommentDeletedBy.AUTHOR,
    });
    return { ok: true };
  }

  /**
   * Report a comment. One flag per user per comment, enforced by the unique
   * constraint rather than a read-then-write check.
   */
  async flag(
    commentId: string,
    userId: string,
    reason: CommentFlagReason,
    note: string | null,
  ): Promise<{ ok: true; alreadyFlagged: boolean }> {
    const comment = await this.repo.findOne({
      where: { id: commentId },
      select: { id: true, userId: true, deletedAt: true },
    });
    if (!comment) throw new NotFoundException("Comment not found");
    if (comment.deletedAt) {
      throw new BadRequestException("That comment has already been removed.");
    }
    if (comment.userId === userId) {
      throw new BadRequestException("You cannot report your own comment.");
    }

    try {
      await this.flagRepo.insert({
        commentId,
        userId,
        reason,
        note: note?.trim() || null,
      });
    } catch (err: any) {
      // Already reported by this user — not an error worth showing them.
      if (err?.code === PG_UNIQUE_VIOLATION) {
        return { ok: true, alreadyFlagged: true };
      }
      throw err;
    }

    await this.repo.increment({ id: commentId }, "flagCount", 1);
    return { ok: true, alreadyFlagged: false };
  }

  // ── Moderation ─────────────────────────────────────────────────────────────

  /** The moderation queue: most-reported first, then newest. */
  async adminList(opts: {
    flagged?: boolean;
    marketId?: string;
    userId?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(opts.page ?? 1, 1);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

    const qb = this.repo
      .createQueryBuilder("c")
      .leftJoinAndSelect("c.user", "u")
      .leftJoin("c.market", "m")
      .addSelect(["m.id", "m.title"]);

    if (opts.flagged) qb.andWhere("c.flagCount > 0");
    if (opts.marketId) qb.andWhere("c.marketId = :mid", { mid: opts.marketId });
    if (opts.userId) qb.andWhere("c.userId = :uid", { uid: opts.userId });

    const [rows, total] = await qb
      .orderBy("c.flagCount", "DESC")
      .addOrderBy("c.createdAt", "DESC")
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    const flags =
      rows.length > 0
        ? await this.flagRepo.find({
            where: { commentId: In(rows.map((r) => r.id)) },
            order: { createdAt: "DESC" },
          })
        : [];

    const byComment = new Map<string, MarketCommentFlag[]>();
    for (const f of flags) {
      const list = byComment.get(f.commentId) ?? [];
      list.push(f);
      byComment.set(f.commentId, list);
    }

    return {
      data: rows.map((r) => ({
        id: r.id,
        body: r.body,
        createdAt: r.createdAt,
        flagCount: r.flagCount,
        deletedAt: r.deletedAt,
        deletedBy: r.deletedBy,
        deletedReason: r.deletedReason,
        market: r.market ? { id: r.market.id, title: r.market.title } : null,
        author: r.user
          ? {
              id: r.user.id,
              username: r.user.username,
              firstName: r.user.firstName,
              lastName: r.user.lastName,
              reputationTier: r.user.reputationTier,
              commentsBlockedUntil: r.user.commentsBlockedUntil,
            }
          : null,
        flags: (byComment.get(r.id) ?? []).map((f) => ({
          reason: f.reason,
          note: f.note,
          createdAt: f.createdAt,
        })),
      })),
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
    };
  }

  /** Moderator removal. Tells the author what happened rather than silently hiding it. */
  async adminRemove(commentId: string, reason: string): Promise<{ ok: true }> {
    const comment = await this.repo.findOne({ where: { id: commentId } });
    if (!comment) throw new NotFoundException("Comment not found");

    if (!comment.deletedAt) {
      await this.repo.update(commentId, {
        deletedAt: new Date(),
        deletedBy: CommentDeletedBy.ADMIN,
        deletedReason: reason.trim(),
      });

      await this.notifications.create(comment.userId, {
        type: "comment_removed",
        title: "A comment was removed",
        body: `One of your market comments was removed by a moderator. Reason: ${reason.trim()}`,
        metadata: { commentId, marketId: comment.marketId },
      });
    }
    return { ok: true };
  }

  /** Pause a user's commenting for `hours`. The only per-user restriction we have. */
  async adminMute(
    userId: string,
    hours: number,
    reason: string | null,
  ): Promise<{ ok: true; until: Date }> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");

    const until = new Date(Date.now() + hours * 60 * 60 * 1000);
    await this.userRepo.update(userId, { commentsBlockedUntil: until });

    await this.notifications.create(userId, {
      type: "comment_removed",
      title: "Commenting paused",
      body: reason?.trim()
        ? `You cannot post comments for ${hours}h. Reason: ${reason.trim()}`
        : `You cannot post comments for the next ${hours} hours.`,
      metadata: { until: until.toISOString() },
    });

    return { ok: true, until };
  }

  /** Lift a mute early. */
  async adminUnmute(userId: string): Promise<{ ok: true }> {
    await this.userRepo.update(userId, { commentsBlockedUntil: null });
    return { ok: true };
  }

  /** Thread size for a market, used to label the section header. */
  async count(marketId: string): Promise<number> {
    return this.repo.count({
      where: { marketId, deletedAt: IsNull() },
    });
  }
}
