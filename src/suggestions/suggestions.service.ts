import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { Repository, DataSource, In } from "typeorm";
import {
  MarketSuggestion,
  SuggestionStatus,
} from "../entities/market-suggestion.entity";
import { MarketSuggestionVote } from "../entities/market-suggestion-vote.entity";
import { MarketCategory } from "../entities/market.entity";
import { User } from "../entities/user.entity";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";
import { SuggestionsGateway } from "./suggestions.gateway";

/** How many suggestions a user may submit per calendar month. */
export const SUGGESTIONS_PER_MONTH = 1;

/** Postgres unique-violation. A duplicate vote is expected traffic, not an error. */
const PG_UNIQUE_VIOLATION = "23505";

export interface SuggestionView {
  id: string;
  title: string;
  description: string | null;
  category: MarketCategory;
  votes: number;
  creator: string;
  createdAt: Date;
  /** True when the caller has already voted on this suggestion. */
  votedByMe: boolean;
  /** Set once the suggestion has become a real market. */
  marketId: string | null;
}

@Injectable()
export class SuggestionsService {
  private readonly logger = new Logger(SuggestionsService.name);

  constructor(
    @InjectRepository(MarketSuggestion)
    private readonly suggestionRepo: Repository<MarketSuggestion>,
    @InjectRepository(MarketSuggestionVote)
    private readonly voteRepo: Repository<MarketSuggestionVote>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly telegram: TelegramSimpleService,
    private readonly gateway: SuggestionsGateway,
  ) {}

  // ── Reads ──────────────────────────────────────────────────────────────────

  /** The orbit: approved (and already-created) suggestions, most-wanted first. */
  async listVisible(viewerId?: string): Promise<SuggestionView[]> {
    const suggestions = await this.suggestionRepo.find({
      where: {
        status: In([SuggestionStatus.APPROVED, SuggestionStatus.CREATED]),
      },
      relations: ["user"],
      order: { voteCount: "DESC", createdAt: "DESC" },
      take: 50,
    });
    if (suggestions.length === 0) return [];

    // One query for the viewer's votes rather than one per suggestion.
    let votedIds = new Set<string>();
    if (viewerId) {
      const mine = await this.voteRepo.find({
        where: {
          userId: viewerId,
          suggestionId: In(suggestions.map((s) => s.id)),
        },
        select: ["suggestionId"],
      });
      votedIds = new Set(mine.map((v) => v.suggestionId));
    }

    return suggestions.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      category: s.category,
      votes: s.voteCount,
      creator: this.displayName(s.user),
      createdAt: s.createdAt,
      votedByMe: votedIds.has(s.id),
      marketId: s.marketId,
    }));
  }

  /** Whether this user may submit right now, and when their quota next resets. */
  async getQuota(
    userId: string,
  ): Promise<{ canSuggest: boolean; used: number; limit: number; resetsAt: Date }> {
    const { start, next } = this.currentMonthWindow();
    const used = await this.suggestionRepo
      .createQueryBuilder("s")
      .where("s.userId = :userId", { userId })
      .andWhere("s.createdAt >= :start", { start })
      // A rejected suggestion still consumes the month — otherwise a user can
      // retry endlessly and the admin's DMs become the rate limit.
      .getCount();

    return {
      canSuggest: used < SUGGESTIONS_PER_MONTH,
      used,
      limit: SUGGESTIONS_PER_MONTH,
      resetsAt: next,
    };
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  /**
   * Submit a suggestion. It lands as PENDING and is invisible until the admin
   * approves it from Telegram. The proposer's own vote is cast at the same
   * time, so an approved suggestion enters the orbit with one vote, not zero.
   */
  async create(
    userId: string,
    title: string,
    description: string | null,
    category: MarketCategory,
  ): Promise<{ id: string; status: SuggestionStatus }> {
    const cleanTitle = title.trim();
    if (cleanTitle.length < 10) {
      throw new BadRequestException(
        "Give your question at least 10 characters so others know what they're voting on",
      );
    }

    const quota = await this.getQuota(userId);
    if (!quota.canSuggest) {
      throw new BadRequestException(
        `You've used your suggestion for this month. You can suggest another from ${quota.resetsAt.toISOString().slice(0, 10)}.`,
      );
    }

    const saved = await this.dataSource.transaction(async (em) => {
      const suggestion = em.getRepository(MarketSuggestion).create({
        userId,
        title: cleanTitle,
        description: description?.trim() || null,
        category,
        status: SuggestionStatus.PENDING,
        voteCount: 1, // the proposer's own vote
      });
      const row = await em.getRepository(MarketSuggestion).save(suggestion);
      await em
        .getRepository(MarketSuggestionVote)
        .save(
          em
            .getRepository(MarketSuggestionVote)
            .create({ suggestionId: row.id, userId }),
        );
      return row;
    });

    // Notification must never fail the submission.
    this.notifyApprover(saved.id).catch((err) =>
      this.logger.error(`Approver notify failed for ${saved.id}: ${err.message}`),
    );

    return { id: saved.id, status: saved.status };
  }

  /**
   * Cast this user's single vote. Idempotent: voting twice is a no-op rather
   * than an error, so a double-tap can't inflate the count. The unique index —
   * not a read-then-write check — is what makes this safe under concurrency.
   */
  async vote(
    suggestionId: string,
    userId: string,
  ): Promise<{ votes: number; votedByMe: boolean }> {
    const suggestion = await this.suggestionRepo.findOne({
      where: { id: suggestionId },
    });
    if (!suggestion) throw new NotFoundException("Suggestion not found");
    if (
      suggestion.status !== SuggestionStatus.APPROVED &&
      suggestion.status !== SuggestionStatus.CREATED
    ) {
      throw new BadRequestException("This suggestion is not open for votes");
    }

    let counted = true;
    try {
      await this.dataSource.transaction(async (em) => {
        await em
          .getRepository(MarketSuggestionVote)
          .insert({ suggestionId, userId });
        await em
          .getRepository(MarketSuggestion)
          .increment({ id: suggestionId }, "voteCount", 1);
      });
    } catch (err: any) {
      if (err?.code !== PG_UNIQUE_VIOLATION) throw err;
      // Already voted — fall through and return the current count.
      counted = false;
    }

    const fresh = await this.suggestionRepo.findOne({
      where: { id: suggestionId },
      select: ["voteCount"],
    });
    const votes = fresh?.voteCount ?? suggestion.voteCount;

    // Only a vote that actually changed the count is worth a broadcast — a
    // double-tap must not make every other orbit re-render for nothing.
    if (counted) {
      this.gateway.emitVoted({ id: suggestionId, votes });
    }

    return { votes, votedByMe: true };
  }

  // ── Admin review (driven from Telegram) ────────────────────────────────────

  /** True when this Telegram id is the configured ADMIN_TELEGRAM_ID. */
  isApprover(telegramId: string | number | undefined): boolean {
    const configured = this.approverId();
    return !!configured && String(telegramId) === configured;
  }

  async review(
    suggestionId: string,
    approve: boolean,
    reviewerTelegramId: string,
  ): Promise<MarketSuggestion> {
    const suggestion = await this.suggestionRepo.findOne({
      where: { id: suggestionId },
      relations: ["user"],
    });
    if (!suggestion) throw new NotFoundException("Suggestion not found");
    if (suggestion.status !== SuggestionStatus.PENDING) {
      throw new BadRequestException(
        `Already ${suggestion.status} — nothing to do`,
      );
    }

    suggestion.status = approve
      ? SuggestionStatus.APPROVED
      : SuggestionStatus.REJECTED;
    suggestion.reviewedByTelegramId = reviewerTelegramId;
    suggestion.reviewedAt = new Date();
    const saved = await this.suggestionRepo.save(suggestion);

    if (saved.status === SuggestionStatus.APPROVED) {
      this.gateway.emitAdded({
        id: saved.id,
        title: saved.title,
        description: saved.description,
        category: saved.category,
        votes: saved.voteCount,
        creator: this.displayName(saved.user),
        createdAt: saved.createdAt.toISOString(),
        marketId: saved.marketId,
      });
    }

    this.notifyProposer(saved).catch(() => {});
    return saved;
  }

  async findById(id: string): Promise<MarketSuggestion | null> {
    return this.suggestionRepo.findOne({ where: { id }, relations: ["user"] });
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** The reviewer's Telegram id — the same admin who resolves markets from a DM. */
  private approverId(): string | null {
    return this.config.get<string>("ADMIN_TELEGRAM_ID") ?? null;
  }

  /** First instant of this calendar month, and of the next one, in UTC. */
  private currentMonthWindow(): { start: Date; next: Date } {
    const now = new Date();
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
    );
    const next = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0),
    );
    return { start, next };
  }

  private displayName(user?: User | null): string {
    if (!user) return "A predictor";
    if (user.username) return `@${user.username}`;
    return user.firstName?.trim() || "A predictor";
  }

  private async notifyApprover(suggestionId: string): Promise<void> {
    const adminId = this.approverId();
    if (!adminId) {
      this.logger.warn(
        "ADMIN_TELEGRAM_ID unset — suggestion cannot be reviewed from Telegram",
      );
      return;
    }
    const suggestion = await this.findById(suggestionId);
    if (!suggestion) return;

    const text =
      `💡 <b>New market suggestion</b>\n\n` +
      `<b>${this.escape(suggestion.title)}</b>\n` +
      (suggestion.description
        ? `<i>${this.escape(suggestion.description)}</i>\n`
        : "") +
      `\nCategory: ${suggestion.category}\n` +
      `From: ${this.escape(this.displayName(suggestion.user))}`;

    await this.telegram.sendMessageWithButtons(Number(adminId), text, [
      [
        { text: "✅ Approve", callbackData: `sg:a:${suggestion.id}` },
        { text: "❌ Reject", callbackData: `sg:r:${suggestion.id}` },
      ],
    ]);
  }

  private async notifyProposer(suggestion: MarketSuggestion): Promise<void> {
    const telegramId = suggestion.user?.telegramId;
    if (!telegramId) return;
    const text =
      suggestion.status === SuggestionStatus.APPROVED
        ? `✅ Your market suggestion is live in Ask the Crowd:\n\n<b>${this.escape(suggestion.title)}</b>\n\nShare it — the most-voted questions become real markets.`
        : `Your market suggestion wasn't approved this time:\n\n<b>${this.escape(suggestion.title)}</b>\n\nYou can suggest another one next month.`;
    await this.telegram.sendMessage(Number(telegramId), text);
  }

  private escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}
