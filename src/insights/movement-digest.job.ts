import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, In, MoreThanOrEqual } from "typeorm";
import { Position } from "../entities/position.entity";
import { FreeCall } from "../entities/free-call.entity";
import { RedisService } from "../redis/redis.service";
import { ConfigService } from "@nestjs/config";
import { UserNotificationService } from "../users/user-notification.service";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";
import { ProbabilityHistoryService, Mover } from "./probability-history.service";

/** A move smaller than this is not news. */
const MIN_DELTA = 0.07;
const DIGEST_LIMIT = 5;

@Injectable()
export class MovementDigestJob {
  private readonly logger = new Logger(MovementDigestJob.name);

  constructor(
    @InjectRepository(Position)
    private readonly positionRepo: Repository<Position>,
    @InjectRepository(FreeCall)
    private readonly freeCallRepo: Repository<FreeCall>,
    private readonly history: ProbabilityHistoryService,
    private readonly redis: RedisService,
    private readonly userNotifications: UserNotificationService,
    private readonly telegram: TelegramSimpleService,
    private readonly config: ConfigService,
  ) {}

  /**
   * "What changed today" — 1:00 PM UTC (≈ 7 PM Bhutan), when people are on
   * their phones rather than asleep.
   *
   * Two audiences, deliberately different. The public channel gets the whole
   * digest, because a list of moves is the product: it is the reason to open
   * Oro when you have no money on anything. Individual users only get a bell
   * notification about markets they actually have a call on — a broadcast to
   * every user about a market they have never looked at is spam, and trains
   * people to ignore the bell.
   */
  @Cron("0 13 * * *")
  async postDailyMovement(): Promise<void> {
    const lock = await this.redis.acquireLock("cron:movement-digest", 600);
    if (!lock) return;
    try {
      const movers = await this.history.getMovers({
        hours: 24,
        limit: DIGEST_LIMIT,
        minDelta: MIN_DELTA,
      });

      if (movers.length === 0) {
        this.logger.log("[Digest] nothing moved enough to report");
        return;
      }

      await this.postToChannel(movers);
      await this.notifyInterestedUsers(movers);
    } catch (err: any) {
      this.logger.error(`[Digest] failed: ${err.message}`);
    } finally {
      await this.redis.releaseLock("cron:movement-digest", lock);
    }
  }

  /**
   * Posts through TelegramSimpleService rather than the channel service in
   * `telegram-channel.service.ts`: that class is not registered as a provider in
   * any module, so injecting it would fail Nest's dependency resolution at boot,
   * and wiring it up would also drag in its unregistered TelegramService plus an
   * init path that posts a welcome message to the channel.
   */
  private async postToChannel(movers: Mover[]): Promise<void> {
    const channelId = this.config.get<string>("TELEGRAM_CHANNEL_ID") || "";
    if (!channelId) {
      this.logger.warn("[Digest] TELEGRAM_CHANNEL_ID unset — no channel post");
      return;
    }

    const lines = movers.map((m) => {
      const arrow = m.delta > 0 ? "▲" : "▼";
      const pts = Math.round(Math.abs(m.delta) * 100);
      const to = Math.round(m.to * 100);
      return (
        `${arrow} <b>${to}%</b> ${m.outcomeLabel} — ${m.title}\n` +
        `   ${arrow} ${pts}pp in 24h`
      );
    });

    const message =
      `📊 <b>What changed today</b>\n\n` +
      `The crowd moved on ${movers.length} question${movers.length === 1 ? "" : "s"}:\n\n` +
      lines.join("\n\n");

    // A numeric channel id must be sent as a number; an "@name" stays a string.
    const target = /^-?\d+$/.test(channelId) ? Number(channelId) : channelId;

    await this.telegram
      .sendMessage(target, message)
      .catch((err: Error) =>
        this.logger.warn(`[Digest] channel post failed: ${err.message}`),
      );
  }

  /**
   * Bell notification for users with a stake or a free call on something that
   * moved. One notification per user covering every market they are in, not one
   * per market — five separate buzzes about the same digest is how a bell gets
   * muted.
   */
  private async notifyInterestedUsers(movers: Mover[]): Promise<void> {
    const marketIds = movers.map((m) => m.marketId);
    const byMarket = new Map(movers.map((m) => [m.marketId, m]));

    // Only people who called recently enough to still care.
    const since = new Date(Date.now() - 90 * 86400_000);

    const [positions, calls] = await Promise.all([
      this.positionRepo.find({
        where: { marketId: In(marketIds), placedAt: MoreThanOrEqual(since) },
        select: ["userId", "marketId"],
      }),
      this.freeCallRepo.find({
        where: { marketId: In(marketIds), calledAt: MoreThanOrEqual(since) },
        select: ["userId", "marketId"],
      }),
    ]);

    const marketsByUser = new Map<string, Set<string>>();
    for (const row of [...positions, ...calls]) {
      const set = marketsByUser.get(row.userId) ?? new Set<string>();
      set.add(row.marketId);
      marketsByUser.set(row.userId, set);
    }

    let sent = 0;
    for (const [userId, ids] of marketsByUser) {
      const mine = [...ids]
        .map((id) => byMarket.get(id))
        .filter((m): m is Mover => !!m)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      if (mine.length === 0) continue;

      const lead = mine[0];
      const pts = Math.round(Math.abs(lead.delta) * 100);
      const dir = lead.delta > 0 ? "up" : "down";
      const to = Math.round(lead.to * 100);

      const body =
        mine.length === 1
          ? `${lead.outcomeLabel} moved ${dir} ${pts}pp to ${to}% on "${lead.title}".`
          : `${lead.outcomeLabel} moved ${dir} ${pts}pp to ${to}% on "${lead.title}", ` +
            `plus ${mine.length - 1} other question${mine.length === 2 ? "" : "s"} you called.`;

      await this.userNotifications.create(userId, {
        type: "movement",
        title: "The crowd moved on your call",
        body,
        metadata: {
          markets: mine.map((m) => ({
            marketId: m.marketId,
            delta: m.delta,
            to: m.to,
          })),
        },
      });
      sent++;
    }

    this.logger.log(
      `[Digest] ${movers.length} mover(s) — channel posted, ${sent} user(s) notified`,
    );
  }
}
