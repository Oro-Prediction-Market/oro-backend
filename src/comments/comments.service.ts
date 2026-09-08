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
import { MarketCommentLike } from "../entities/market-comment-like.entity";
import { Market, MarketStatus } from "../entities/market.entity";
import { User } from "../entities/user.entity";
import { UserNotificationService } from "../users/user-notification.service";
import { findBlockedTerm } from "./blocklist";
import { COMMENT_MAX_LENGTH } from "./dto/create-comment.dto";

/** Postgres unique-violation. Relied on instead of a racy read-then-write. */
const PG_UNIQUE_VIOLATION = "23505";

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;
/** A reply thread is shown whole rather than paged; this is the safety stop. */
const MAX_REPLIES = 200;

/**
 * How long an author may rewrite their own comment.
 *
 * Long enough to fix a typo or a mangled sentence, short enough that nobody
 * can rewrite a call after the result is known — the whole point of a
 * prediction thread is that what you said is still there afterwards. Measured
 * from `createdAt`, never from the last edit, so editing cannot extend it.
 */
export const EDIT_WINDOW_MS = 15 * 60 * 1000;

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
  /** Null for a top-level comment; the parent's id for a reply. */
  parentId: string | null;
  /** Live replies under this comment. Always 0 on a reply — depth is capped at 1. */
  replyCount: number;
  /** Hearts on this comment. */
  likeCount: number;
  /** Whether the caller is one of them. False when signed out. */
  hasLiked: boolean;
  /** True once the author has rewritten it, so the apps can mark it. */
  edited: boolean;
  /**
   * When the caller's own edit window shuts. Null on anyone else's comment, on
   * a removed one, and once the window has passed.
   *
   * An absolute deadline rather than a boolean so a page left open does not go
   * on offering Edit after the window closes — the client compares it against
   * the clock, and the server re-checks on the write regardless.
   */
  editableUntil: Date | null;
}

@Injectable()
export class CommentsService {
  private readonly logger = new Logger(CommentsService.name);

  constructor(
    @InjectRepository(MarketComment)
    private readonly repo: Repository<MarketComment>,
    @InjectRepository(MarketCommentFlag)
    private readonly flagRepo: Repository<MarketCommentFlag>,
    @InjectRepository(MarketCommentLike)
    private readonly likeRepo: Repository<MarketCommentLike>,
    @InjectRepository(Market)
    private readonly marketRepo: Repository<Market>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly notifications: UserNotificationService,
    private readonly dataSource: DataSource,
  ) {}

  // ── Reading ────────────────────────────────────────────────────────────────

  /**
   * A page of a market's thread.
   *
   * Cursor paginated on createdAt: `cursor` is the timestamp of the last row
   * you saw, and the comparison flips with `order`, so the same cursor works in
   * both directions. Follows the convention in UserNotificationService.listAll.
   *
   * `viewerId` is optional because the route is public: JwtAuthGuard still
   * decodes a present token on @Public() routes, so a signed-in caller gets
   * isMine/hasFlagged populated and a signed-out one simply does not.
   */
  async list(
    marketId: string,
    viewerId: string | null,
    opts: {
      limit?: number;
      cursor?: string;
      order?: "newest" | "oldest";
    } = {},
  ): Promise<CommentView[]> {
    const take = Math.min(
      Math.max(opts.limit ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const newestFirst = opts.order !== "oldest";

    const qb = this.repo
      .createQueryBuilder("c")
      .leftJoinAndSelect("c.user", "u")
      .where("c.marketId = :marketId", { marketId })
      // A comment the author removed normally disappears entirely. Two
      // exceptions stay as tombstones: one a moderator removed (so a moderated
      // thread does not silently reshape itself), and one that has replies
      // hanging off it (removing it outright would orphan a conversation the
      // author does not own).
      .andWhere(
        "(c.deletedAt IS NULL OR c.deletedBy = :admin OR c.replyCount > 0)",
        { admin: CommentDeletedBy.ADMIN },
      )
      // Top level only. Replies hang off their parent and are fetched by
      // listReplies when the reader opens them.
      .andWhere("c.parentId IS NULL")
      // id is a tiebreaker, not decoration: two comments can land in the same
      // millisecond, and without a total order the cursor below would either
      // skip one or serve it twice.
      .orderBy("c.createdAt", newestFirst ? "DESC" : "ASC")
      .addOrderBy("c.id", newestFirst ? "DESC" : "ASC")
      .take(take);

    // Cursor is "<createdAt ISO>|<id>" — the row you last saw. Compared as a
    // tuple against the same two columns the ordering uses, so it is exact
    // even when several comments share a millisecond. The id half is optional
    // so a bare timestamp still works.
    if (opts.cursor) {
      const [rawTs, rawId] = opts.cursor.split("|");
      const cursorTs = new Date(rawTs);
      if (!Number.isNaN(cursorTs.getTime())) {
        if (rawId) {
          qb.andWhere(
            newestFirst
              ? `(c."createdAt", c."id") < (:cursorTs, :cursorId)`
              : `(c."createdAt", c."id") > (:cursorTs, :cursorId)`,
            { cursorTs, cursorId: rawId },
          );
        } else {
          qb.andWhere(
            newestFirst ? "c.createdAt < :cursorTs" : "c.createdAt > :cursorTs",
            { cursorTs },
          );
        }
      }
    }

    const rows = await qb.getMany();
    if (rows.length === 0) return [];

    const authorIds = [...new Set(rows.map((r) => r.userId))];
    const [sides, flagged, liked] = await Promise.all([
      this.resolveSides(marketId, authorIds),
      this.flaggedByViewer(
        rows.map((r) => r.id),
        viewerId,
      ),
      this.likedByViewer(
        rows.map((r) => r.id),
        viewerId,
      ),
    ]);

    return rows.map((row) =>
      this.toView(row, viewerId, sides, flagged, liked),
    );
  }

  /**
   * Every reply under one comment, oldest first.
   *
   * Not paginated and not sortable, unlike the top-level list. A reply thread
   * is a conversation: it reads in the order it happened, and it is bounded by
   * MAX_REPLIES rather than by a cursor, because a UI that pages inside an
   * expanded sub-thread is worse than one that simply shows all of them.
   */
  async listReplies(
    commentId: string,
    viewerId: string | null,
  ): Promise<CommentView[]> {
    const parent = await this.repo.findOne({
      where: { id: commentId },
      select: { id: true, marketId: true },
    });
    if (!parent) throw new NotFoundException("Comment not found");

    const rows = await this.repo
      .createQueryBuilder("c")
      .leftJoinAndSelect("c.user", "u")
      .where("c.parentId = :commentId", { commentId })
      // No replyCount clause here, unlike the top-level list: nothing hangs off
      // a reply, so an author-removed one has nothing to orphan and simply goes.
      .andWhere("(c.deletedAt IS NULL OR c.deletedBy = :admin)", {
        admin: CommentDeletedBy.ADMIN,
      })
      .orderBy("c.createdAt", "ASC")
      .addOrderBy("c.id", "ASC")
      .take(MAX_REPLIES)
      .getMany();

    if (rows.length === 0) return [];

    const [sides, flagged, liked] = await Promise.all([
      this.resolveSides(parent.marketId, [
        ...new Set(rows.map((r) => r.userId)),
      ]),
      this.flaggedByViewer(
        rows.map((r) => r.id),
        viewerId,
      ),
      this.likedByViewer(
        rows.map((r) => r.id),
        viewerId,
      ),
    ]);

    return rows.map((row) =>
      this.toView(row, viewerId, sides, flagged, liked),
    );
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

  /** Which of these comments the caller has already liked. */
  private likedByViewer(
    commentIds: string[],
    viewerId: string | null,
  ): Promise<Set<string>> {
    if (!viewerId || commentIds.length === 0) {
      return Promise.resolve(new Set<string>());
    }
    return this.likeRepo
      .find({
        where: { userId: viewerId, commentId: In(commentIds) },
        select: { commentId: true },
      })
      .then((rows) => new Set(rows.map((r) => r.commentId)));
  }

  private toView(
    row: MarketComment,
    viewerId: string | null,
    sides: Map<string, { outcomeId: string; label: string }>,
    flagged: Set<string>,
    liked: Set<string> = new Set(),
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
      likeCount: row.likeCount ?? 0,
      hasLiked: liked.has(row.id),
      deleted: removed,
      deletedBy: row.deletedBy ?? null,
      parentId: row.parentId ?? null,
      replyCount: row.replyCount ?? 0,
      edited: !removed && row.editedAt != null,
      editableUntil: this.editableUntil(row, viewerId),
    };
  }

  /** The caller's remaining edit window on this row, or null if they have none. */
  private editableUntil(row: MarketComment, viewerId: string | null): Date | null {
    if (row.deletedAt != null) return null;
    if (viewerId == null || row.userId !== viewerId) return null;
    const until = new Date(row.createdAt.getTime() + EDIT_WINDOW_MS);
    return until.getTime() > Date.now() ? until : null;
  }

  // ── Writing ────────────────────────────────────────────────────────────────

  async create(
    marketId: string,
    userId: string,
    rawBody: string,
    parentId: string | null = null,
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

    // Replying: the parent must be a live top-level comment on THIS market.
    // Checked before the write so a reply can never end up orphaned, on the
    // wrong thread, or nested two deep.
    if (parentId) {
      const parent = await this.repo.findOne({
        where: { id: parentId },
        select: {
          id: true,
          marketId: true,
          parentId: true,
          deletedAt: true,
        },
      });
      if (!parent) throw new NotFoundException("Comment not found");
      if (parent.marketId !== marketId) {
        throw new BadRequestException(
          "That comment belongs to a different market.",
        );
      }
      if (parent.deletedAt) {
        throw new BadRequestException("That comment has been removed.");
      }
      // Depth is capped at one: reply to the top-level comment, not to a reply.
      if (parent.parentId) {
        throw new BadRequestException(
          "You can only reply to a top-level comment.",
        );
      }
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
      this.repo.create({ marketId, userId, body, parentId }),
    );

    if (parentId) await this.repo.increment({ id: parentId }, "replyCount", 1);

    const [user, sides] = await Promise.all([
      this.userRepo.findOne({ where: { id: userId } }),
      this.resolveSides(marketId, [userId]),
    ]);
    saved.user = user as User;

    return this.toView(saved, userId, sides, new Set());
  }

  /**
   * Rewrite your own comment, inside the edit window.
   *
   * Every rule create() applies is re-applied: the blocklist, the length cap,
   * the trim, the settled-market lock and the moderator mute. An edit is a new
   * piece of public text and must not be a way around any of them.
   */
  async edit(
    commentId: string,
    userId: string,
    rawBody: string,
  ): Promise<CommentView> {
    const comment = await this.repo.findOne({ where: { id: commentId } });
    if (!comment) throw new NotFoundException("Comment not found");
    if (comment.userId !== userId) {
      throw new ForbiddenException("You can only edit your own comments.");
    }
    if (comment.deletedAt) {
      throw new BadRequestException("That comment has been removed.");
    }
    // From createdAt, not editedAt: editing must not buy another window.
    if (comment.createdAt.getTime() + EDIT_WINDOW_MS <= Date.now()) {
      throw new BadRequestException(
        "Comments can only be edited shortly after posting.",
      );
    }

    const market = await this.marketRepo.findOne({
      where: { id: comment.marketId },
      select: { id: true, status: true },
    });
    if (market?.status === MarketStatus.SETTLED) {
      throw new BadRequestException(
        "This market has settled — its comments are closed.",
      );
    }

    const author = await this.userRepo.findOne({
      where: { id: userId },
      select: { id: true, commentsBlockedUntil: true },
    });
    if (
      author?.commentsBlockedUntil &&
      author.commentsBlockedUntil.getTime() > Date.now()
    ) {
      throw new ForbiddenException(
        "Your commenting is paused by a moderator. Try again later.",
      );
    }

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
      this.logger.log(`Blocked edit from ${userId} (term: ${blocked})`);
      throw new BadRequestException(
        "That comment contains language we don't allow. Please rephrase it.",
      );
    }

    // Unchanged text is a no-op rather than a spurious "edited" marker.
    if (body === comment.body) {
      const [sides] = await Promise.all([
        this.resolveSides(comment.marketId, [userId]),
      ]);
      comment.user = (await this.userRepo.findOne({
        where: { id: userId },
      })) as User;
      return this.toView(comment, userId, sides, new Set());
    }

    const editedAt = new Date();
    await this.repo.update(commentId, { body, editedAt });
    comment.body = body;
    comment.editedAt = editedAt;
    comment.user = (await this.userRepo.findOne({
      where: { id: userId },
    })) as User;

    const sides = await this.resolveSides(comment.marketId, [userId]);
    return this.toView(comment, userId, sides, new Set());
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
    await this.releaseReplySlot(comment.parentId);
    return { ok: true };
  }

  /**
   * Drop the parent's replyCount by one when a reply goes away.
   *
   * Clamped at zero in SQL rather than with decrement(): the count is
   * cosmetic, but "-1 Replies" on a live page is the kind of thing nobody
   * ever goes back to fix.
   */
  private async releaseReplySlot(parentId: string | null): Promise<void> {
    if (!parentId) return;
    await this.repo.query(
      `UPDATE market_comments
          SET "replyCount" = GREATEST(0, "replyCount" - 1)
        WHERE id = $1`,
      [parentId],
    );
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

  /**
   * Toggle the caller's like on a comment.
   *
   * One endpoint rather than a like/unlike pair: the button is a toggle, and
   * two endpoints let a double tap leave the client's idea of the state and
   * the server's disagreeing.
   *
   * Idempotent under a race. Both directions lean on the DB rather than on a
   * read-then-write: inserting relies on UQ_comment_like rejecting a
   * duplicate, and deleting reads back the affected row count. Two
   * simultaneous taps therefore land on one row and one count change, not two.
   *
   * You may like your own comment. It is a bookmark as much as an endorsement,
   * and policing it costs more than it is worth — unlike reporting, where
   * self-reporting is meaningless.
   */
  async toggleLike(
    commentId: string,
    userId: string,
  ): Promise<{ liked: boolean; likeCount: number }> {
    const comment = await this.repo.findOne({
      where: { id: commentId },
      select: { id: true, deletedAt: true },
    });
    if (!comment) throw new NotFoundException("Comment not found");
    if (comment.deletedAt) {
      throw new BadRequestException("That comment has been removed.");
    }

    const existing = await this.likeRepo.findOne({
      where: { commentId, userId },
      select: { id: true },
    });

    if (existing) {
      const res = await this.likeRepo.delete({ commentId, userId });
      // Only move the count if this call is the one that removed the row.
      if (res.affected) {
        // Clamped in SQL rather than decrement(): the count is cosmetic, but
        // "-1" under a comment is the kind of thing nobody goes back to fix.
        await this.repo.query(
          `UPDATE market_comments
             SET "likeCount" = GREATEST("likeCount" - 1, 0)
           WHERE "id" = $1`,
          [commentId],
        );
      }
    } else {
      try {
        await this.likeRepo.insert({ commentId, userId });
        await this.repo.increment({ id: commentId }, "likeCount", 1);
      } catch (err: any) {
        // Someone else's tap won the race; the like already exists.
        if (err?.code !== PG_UNIQUE_VIOLATION) throw err;
      }
    }

    // Read the count back rather than computing it locally, so the number the
    // client renders is the one the database holds.
    const fresh = await this.repo.findOne({
      where: { id: commentId },
      select: { likeCount: true },
    });
    const liked = !existing;
    return { liked, likeCount: fresh?.likeCount ?? 0 };
  }

  // ── Moderation ─────────────────────────────────────────────────────────────

  /** The moderation queue: most-reported first, then newest. */
  async adminList(opts: {
    flagged?: boolean;
    q?: string;
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

    // Free-text search. `%` and `_` are escaped so a body containing them is
    // matched literally rather than turning into a wildcard — the needle is
    // moderator input, and "100%" should find "100%".
    const needle = (opts.q ?? "").trim();
    if (needle) {
      const like = `%${needle.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      qb.andWhere(
        `(c."body" ILIKE :like ESCAPE '\\'
          OR u."username" ILIKE :like ESCAPE '\\'
          OR u."firstName" ILIKE :like ESCAPE '\\'
          OR u."lastName" ILIKE :like ESCAPE '\\'
          OR m."title" ILIKE :like ESCAPE '\\')`,
        { like },
      );
    }

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
      await this.releaseReplySlot(comment.parentId);

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
