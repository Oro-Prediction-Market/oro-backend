import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { EntityManager, In, IsNull, Repository } from "typeorm";
import { UserNotification } from "../entities/user-notification.entity";
import { User } from "../entities/user.entity";

export interface CreateNotificationInput {
  type?: string;
  title: string;
  body: string;
  metadata?: Record<string, any> | null;
}

export interface AchievementInput {
  id: string;
  name: string;
  requirement?: string;
}

@Injectable()
export class UserNotificationService {
  private readonly logger = new Logger(UserNotificationService.name);

  constructor(
    @InjectRepository(UserNotification)
    private readonly repo: Repository<UserNotification>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  /**
   * Store an in-app notification. Never throws — a failed write must not break
   * the caller (e.g. season prize crediting), only skip the popup.
   */
  async create(userId: string, input: CreateNotificationInput): Promise<void> {
    try {
      await this.repo.save(
        this.repo.create({
          userId,
          type: input.type ?? "system",
          title: input.title,
          body: input.body,
          metadata: input.metadata ?? null,
        }),
      );
    } catch (err: any) {
      this.logger.warn(
        `Failed to create notification for ${userId}: ${err.message}`,
      );
    }
  }

  /**
   * Insert one notification per user, in chunks.
   *
   * **Unlike every other method on this service, this one THROWS.** The rest
   * swallow errors because a failed notification must not break the write that
   * triggered it. Here the caller is a transaction that has to roll back: a
   * broadcast which silently wrote half its rows would leave `audienceCount`
   * claiming a number that never happened, and no way to tell which users were
   * missed.
   *
   * Pass the transaction's `EntityManager` so the inserts join it. 500 rows per
   * statement matches TX_CHUNK in parimutuel.engine.ts; at ~7 parameters a row
   * that is roughly 19x under Postgres's 65,535-parameter ceiling, so the size
   * is conservative by choice rather than by necessity. `insert()` does not
   * chunk on its own (only `save()` takes a `chunk` option), hence the loop.
   */
  async createBulk(
    manager: EntityManager,
    rows: Array<{
      userId: string;
      type: string;
      title: string;
      body: string;
      metadata?: Record<string, any> | null;
    }>,
  ): Promise<number> {
    if (!rows.length) return 0;
    const repo = manager.getRepository(UserNotification);
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await repo.insert(
        rows.slice(i, i + CHUNK).map((r) => ({
          userId: r.userId,
          type: r.type,
          title: r.title,
          body: r.body,
          metadata: r.metadata ?? null,
        })),
      );
    }
    return rows.length;
  }

  /**
   * Delete every notification belonging to one broadcast.
   *
   * The only undo a broadcast has. The DMs are gone the moment they land, but
   * the in-app half can still be taken back.
   */
  async removeByAnnouncement(announcementId: string): Promise<number> {
    const res = await this.repo
      .createQueryBuilder()
      .delete()
      .from(UserNotification)
      .where("metadata->>'announcementId' = :id", { id: announcementId })
      .execute();
    return res.affected ?? 0;
  }

  /**
   * Like {@link create}, but folds into an existing UNSEEN notification that
   * carries the same `dedupeKey` instead of adding another row.
   *
   * For things that happen repeatedly to the same object — twenty people
   * liking one comment — where twenty rows is not twenty pieces of news, it is
   * one piece of news twenty times. Once the user has seen the notification
   * the key stops matching and the next event starts a fresh one, so activity
   * after they looked is not silently swallowed.
   *
   * `createdAt` is bumped on a fold so the notification returns to the top of
   * the list, which is where a thing that just happened again belongs.
   *
   * Never throws, for the same reason create() does not: a notification is not
   * worth failing the write that triggered it.
   */
  async createOrRefresh(
    userId: string,
    dedupeKey: string,
    input: CreateNotificationInput,
  ): Promise<void> {
    try {
      const existing = await this.repo
        .createQueryBuilder("n")
        .where("n.userId = :userId", { userId })
        .andWhere("n.seenAt IS NULL")
        .andWhere("n.metadata->>'dedupeKey' = :key", { key: dedupeKey })
        .orderBy("n.createdAt", "DESC")
        .getOne();

      const metadata = { ...(input.metadata ?? {}), dedupeKey };

      if (existing) {
        // save() rather than update(): TypeORM's partial-update typing rejects
        // a plain object for a jsonb column, and this row is already loaded.
        existing.title = input.title;
        existing.body = input.body;
        existing.metadata = metadata;
        existing.createdAt = new Date();
        await this.repo.save(existing);
        return;
      }

      await this.repo.save(
        this.repo.create({
          userId,
          type: input.type ?? "system",
          title: input.title,
          body: input.body,
          metadata,
        }),
      );
    } catch (err: any) {
      this.logger.warn(
        `Failed to upsert notification for ${userId}: ${err.message}`,
      );
    }
  }

  /** Unseen notifications, newest first (the client pops these on next open). */
  async listUnseen(userId: string): Promise<UserNotification[]> {
    return this.repo
      .find({
        where: { userId, seenAt: IsNull() },
        order: { createdAt: "DESC" },
        take: 20,
      })
      .catch(() => []);
  }

  /** Mark the given ids (or all unseen when omitted) as seen. */
  async markSeen(userId: string, ids?: string[]): Promise<void> {
    const where: Record<string, unknown> = { userId, seenAt: IsNull() };
    if (ids?.length) where.id = In(ids);
    await this.repo.update(where, { seenAt: new Date() }).catch(() => undefined);
  }

  /**
   * All notifications for the center, newest first, cursor-paginated by
   * createdAt. `before` (an ISO timestamp from the last row of the previous
   * page) fetches the next page; omit it for the first page.
   */
  async listAll(
    userId: string,
    opts: { limit?: number; before?: string } = {},
  ): Promise<UserNotification[]> {
    const take = Math.min(Math.max(opts.limit ?? 30, 1), 100);
    const qb = this.repo
      .createQueryBuilder("n")
      .where("n.userId = :userId", { userId })
      .orderBy("n.createdAt", "DESC")
      .take(take);
    if (opts.before) {
      const before = new Date(opts.before);
      if (!Number.isNaN(before.getTime())) {
        qb.andWhere("n.createdAt < :before", { before });
      }
    }
    return qb.getMany().catch(() => []);
  }

  /** Count of unread (unseen) notifications — drives the bell badge. */
  async unreadCount(userId: string): Promise<number> {
    return this.repo
      .count({ where: { userId, seenAt: IsNull() } })
      .catch(() => 0);
  }

  /** Mark the given ids as unread (null their seenAt) for this user. */
  async markUnread(userId: string, ids: string[]): Promise<void> {
    if (!ids?.length) return;
    await this.repo
      .update({ userId, id: In(ids) }, { seenAt: null })
      .catch(() => undefined);
  }

  /** Delete the given ids, or every notification for the user when omitted. */
  async remove(userId: string, ids?: string[]): Promise<void> {
    const where: Record<string, unknown> = { userId };
    if (ids?.length) where.id = In(ids);
    await this.repo.delete(where).catch(() => undefined);
  }

  /**
   * Turn newly-unlocked achievement badges into notifications, deduped by
   * badgeId against rows this user already has — so each badge is only ever
   * celebrated once, reliably and cross-device (replaces the old localStorage
   * tracking). Badge definitions stay single-sourced on the client, which just
   * reports what it computed.
   *
   * `seenIds` seeds the baseline: badges already acknowledged on the client
   * (its localStorage "seen" set) are stored pre-seen so an existing user isn't
   * flooded with every badge they earned before this shipped. Never throws.
   */
  async syncAchievements(
    userId: string,
    badges: AchievementInput[],
    seenIds: string[] = [],
  ): Promise<void> {
    if (!badges?.length) return;
    try {
      const user = await this.userRepo.findOne({
        where: { id: userId },
        select: ["id", "notifiedAchievementIds"],
      });
      if (!user) return;

      // The durable dedupe key: badges we've already notified about. Persisted
      // on the user, so deleting/clearing an achievement notification does NOT
      // resurrect it here on the next sync. Baseline it with any existing
      // achievement rows too, so users who earned badges before this column
      // existed don't get a duplicate notification on the first run.
      const persisted = new Set(
        (user.notifiedAchievementIds ?? []).filter(
          (x): x is string => !!x,
        ),
      );
      const existing = await this.repo.find({
        where: { userId, type: "achievement" },
        select: ["metadata"],
      });
      const notified = new Set<string>([
        ...persisted,
        ...existing
          .map((n) => (n.metadata as any)?.badgeId)
          .filter((x): x is string => !!x),
      ]);
      const seenSet = new Set(seenIds);

      const fresh = badges.filter((b) => b.id && !notified.has(b.id));

      if (fresh.length) {
        await this.repo.save(
          fresh.map((b) =>
            this.repo.create({
              userId,
              type: "achievement",
              title: `Achievement Unlocked: ${b.name}`,
              body: b.requirement || "New badge earned!",
              metadata: { badgeId: b.id, name: b.name },
              // Already-acknowledged badges are baselined as seen so they never
              // pop; only genuinely new unlocks are left unseen to celebrate.
              seenAt: seenSet.has(b.id) ? new Date() : null,
            }),
          ),
        );
      }

      // Persist everything now considered notified (baseline rows + fresh) so
      // the memory survives future deletions. Only write when it grew.
      const toPersist = new Set<string>([
        ...notified,
        ...fresh.map((b) => b.id),
      ]);
      if (toPersist.size !== persisted.size) {
        await this.userRepo.update(
          { id: userId },
          { notifiedAchievementIds: [...toPersist] },
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `syncAchievements failed for ${userId}: ${err.message}`,
      );
    }
  }
}
