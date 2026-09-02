import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, IsNull, Repository } from "typeorm";
import { UserNotification } from "../entities/user-notification.entity";

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
      const existing = await this.repo.find({
        where: { userId, type: "achievement" },
        select: ["metadata"],
      });
      const notified = new Set(
        existing
          .map((n) => (n.metadata as any)?.badgeId)
          .filter((x): x is string => !!x),
      );
      const seenSet = new Set(seenIds);

      const fresh = badges.filter((b) => b.id && !notified.has(b.id));
      if (!fresh.length) return;

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
    } catch (err: any) {
      this.logger.warn(
        `syncAchievements failed for ${userId}: ${err.message}`,
      );
    }
  }
}
