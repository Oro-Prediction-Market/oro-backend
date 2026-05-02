import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { TelegramGroup } from "../entities/telegram-group.entity";
import { GroupMembership } from "../entities/group-membership.entity";
import { User } from "../entities/user.entity";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  firstName: string | null;
  username: string | null;
  reputationScore: number | null;
  reputationTier: string | null;
  totalPredictions: number;
  winRate: number;
}

@Injectable()
export class LeaguesService {
  private readonly logger = new Logger(LeaguesService.name);

  constructor(
    @InjectRepository(TelegramGroup)
    private readonly groupRepo: Repository<TelegramGroup>,
    @InjectRepository(GroupMembership)
    private readonly membershipRepo: Repository<GroupMembership>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly telegramService: TelegramSimpleService,
  ) {}

  /** Returns true if the telegramId user is a registered member of the given chatId group. */
  async isGroupMember(chatId: string, telegramId: string): Promise<boolean> {
    const user = await this.userRepo.findOne({
      where: { telegramId },
      select: ["id"],
    });
    if (!user) return false;
    const count = await this.membershipRepo.count({
      where: { chatId, userId: user.id },
    });
    return count > 0;
  }

  /** Called when the bot is added to a group. Creates or reactivates the record. */
  async upsertGroup(chatId: string, title: string | null): Promise<void> {
    const existing = await this.groupRepo.findOne({ where: { chatId } });
    if (existing) {
      await this.groupRepo.update(existing.id, {
        isActive: true,
        title: title ?? existing.title,
      });
      this.logger.log(`[Leagues] Group ${chatId} reactivated`);
    } else {
      await this.groupRepo.save(
        this.groupRepo.create({ chatId, title, isActive: true }),
      );
      this.logger.log(`[Leagues] Group ${chatId} registered (${title})`);
    }
  }

  /** Called when the bot is removed from a group. */
  async deactivateGroup(chatId: string): Promise<void> {
    await this.groupRepo.update({ chatId }, { isActive: false });
    this.logger.log(`[Leagues] Group ${chatId} deactivated`);
  }

  /**
   * Auto-register an Oro user as a member of a group when they send a message.
   * Silently skips if the user has no Oro account.
   */
  async registerMember(chatId: string, telegramId: string): Promise<void> {
    const user = await this.userRepo.findOne({ where: { telegramId } });
    if (!user) return; // Not an Oro user — ignore

    // Ensure the group record exists (bot may have been added before we stored it)
    const group = await this.groupRepo.findOne({ where: { chatId } });
    if (!group) return;

    // Upsert membership — index on (chatId, userId) prevents duplicates
    const existing = await this.membershipRepo.findOne({
      where: { chatId, userId: user.id },
    });
    if (!existing) {
      await this.membershipRepo.save(
        this.membershipRepo.create({ chatId, userId: user.id }),
      );
      this.logger.debug(
        `[Leagues] Registered user ${user.id} in group ${chatId}`,
      );
    }
  }

  /** Returns top-10 members of a group sorted by reputationScore DESC. */
  async getGroupLeaderboard(chatId: string): Promise<LeaderboardEntry[]> {
    const rows = await this.membershipRepo
      .createQueryBuilder("m")
      .innerJoin("m.user", "u")
      .select([
        "u.id",
        "u.firstName",
        "u.username",
        "u.reputationScore",
        "u.reputationTier",
        "u.totalPredictions",
        "u.correctPredictions",
      ])
      .where("m.chatId = :chatId", { chatId })
      .andWhere("u.totalPredictions > 0")
      .orderBy("u.reputationScore", "DESC", "NULLS LAST")
      .addOrderBy("u.correctPredictions", "DESC")
      .limit(10)
      .getRawMany();

    return rows.map((r, i) => ({
      rank: i + 1,
      userId: r.u_id,
      firstName: r.u_firstName,
      username: r.u_username,
      reputationScore:
        r.u_reputationScore != null ? Number(r.u_reputationScore) : null,
      reputationTier: r.u_reputationTier,
      totalPredictions: Number(r.u_totalPredictions),
      winRate:
        Number(r.u_totalPredictions) > 0
          ? Math.round(
              (Number(r.u_correctPredictions) / Number(r.u_totalPredictions)) *
                100,
            )
          : 0,
    }));
  }

  /** Format and post the standings message for a single group. */
  async postStandingsToGroup(chatId: string): Promise<void> {
    const group = await this.groupRepo.findOne({ where: { chatId } });
    if (!group?.isActive) return;

    const board = await this.getGroupLeaderboard(chatId);
    if (!board.length) {
      await this.telegramService.sendMessage(
        Number(chatId),
        "📊 <b>Weekly Standings</b>\n\nNo predictions recorded yet this week. Start predicting to appear on the leaderboard!",
      );
      return;
    }

    const medals = ["🥇", "🥈", "🥉"];
    const lines = board.map((e) => {
      const medal = medals[e.rank - 1] ?? `${e.rank}.`;
      const name = e.username ? `@${e.username}` : (e.firstName ?? "Unknown");
      const tierLabel =
        e.reputationTier === "legend"
          ? "Legend"
          : e.reputationTier === "hot_hand"
            ? "Hot Hand"
            : e.reputationTier === "sharpshooter"
              ? "Sharpshooter"
              : "Rookie";
      const score =
        e.reputationScore != null
          ? `${Math.round(e.reputationScore * 100)}%`
          : "—";
      return `${medal} <b>${name}</b> · ${tierLabel} · ${score} accuracy · ${e.winRate}% win rate`;
    });

    const miniAppUrl = process.env.TELEGRAM_MINI_APP_URL ?? "";
    const text =
      `🏆 <b>Group Standings — ${group.title ?? "this group"}</b>\n\n` +
      lines.join("\n") +
      (miniAppUrl
        ? `\n\n👉 <a href="${miniAppUrl}">Make your predictions</a>`
        : "");

    await this.telegramService.sendMessage(Number(chatId), text);
  }

  /** Cron: every Sunday at 12:00 UTC — post standings to all active groups. */
  @Cron("0 12 * * 0")
  async postWeeklyStandings(): Promise<void> {
    this.logger.log("[Leagues] Posting weekly standings to all active groups…");
    const groups = await this.groupRepo.find({ where: { isActive: true } });
    for (const group of groups) {
      try {
        await this.postStandingsToGroup(group.chatId);
      } catch (err: any) {
        this.logger.error(
          `[Leagues] Failed to post standings to group ${group.chatId}: ${err.message}`,
        );
      }
    }
    this.logger.log(
      `[Leagues] Weekly standings posted to ${groups.length} group(s)`,
    );
  }
}
