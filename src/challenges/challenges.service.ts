import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";
import { Repository, DataSource, EntityManager, In } from "typeorm";
import { SseService } from "../sse/sse.service";
import {
  Challenge,
  ChallengeStatus,
  CardType,
} from "../entities/challenge.entity";
import { Position, PositionStatus } from "../entities/position.entity";
import { Market, MarketStatus } from "../entities/market.entity";
import {
  Transaction,
  TransactionType,
  BTN_CURRENCY,
} from "../entities/transaction.entity";
import { User } from "../entities/user.entity";
import { RevenueDistributionService } from "../markets/revenue-distribution.service";
import { RedisService } from "../redis/redis.service";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";

const MIN_PREDICTIONS_REQUIRED = 5;
const PLATFORM_FEE_PCT = 0.1;

const CARD_MILESTONES: Record<number, CardType> = {
  3: CardType.DOUBLE_DOWN,
  7: CardType.SHIELD,
  15: CardType.GHOST,
};
import { ledgerBalance } from "../shared/utils/ledger.util";

@Injectable()
export class ChallengesService {
  constructor(
    @InjectRepository(Challenge)
    private challengeRepo: Repository<Challenge>,
    @InjectRepository(Position)
    private positionRepo: Repository<Position>,
    @InjectRepository(Market)
    private marketRepo: Repository<Market>,
    @InjectDataSource() private dataSource: DataSource,
    private sse: SseService,
    private revenueDistribution: RevenueDistributionService,
    private redis: RedisService,
    private telegram: TelegramSimpleService,
  ) {}

  // ── Ledger helpers ─────────────────────────────────────────────────────────
  //
  // Duels are settled in ngultrum only. `Challenge.currency` is never set at
  // create time, so every duel row takes the BTN column default — and both
  // helpers below therefore read AND write the BTN book explicitly.
  //
  // They used to read `ledgerBalanceForAccount`, which scopes to the *account's*
  // currency, while writing a row with no currency at all — which falls to the
  // BTN default. For a USDT account that is a mint: the wager check passes
  // against the USDT book, the debit lands in the BTN book (driving it negative),
  // and a win pays out real ngultrum that was never staked. Reading and writing
  // the same book closes it — a USDT-only account now correctly fails the
  // balance check instead. See the same warning at admin.controller.ts.

  private async debit(
    userId: string,
    amount: number,
    note: string,
    referenceId: string | null,
    em?: EntityManager,
  ): Promise<void> {

    const run = async (m: EntityManager): Promise<void> => {
      const user = await m
        .getRepository(User)
        .createQueryBuilder("u")
        .setLock("pessimistic_write")
        .where("u.id = :id", { id: userId })
        .getOne();
      if (!user) throw new NotFoundException("User not found");

      const balanceBefore = await ledgerBalance(m, userId, BTN_CURRENCY);
      if (balanceBefore < amount) {
        throw new BadRequestException("Insufficient balance for wager");
      }

      const txRepo = m.getRepository(Transaction);
      await txRepo.save(
        txRepo.create({
          userId,
          type: TransactionType.DUEL_WAGER,
          amount: -amount,
          currency: BTN_CURRENCY,
          balanceBefore,
          balanceAfter: balanceBefore - amount,
          note,
          positionId: referenceId ?? undefined,
        }),
      );
    };

    if (em) {
      await run(em);
    } else {
      await this.dataSource.transaction(run);
    }
    this.sse.emit(userId, "balance:updated", {});
  }

  /**
   * Credit a duel participant.
   *
   * `em` lets a caller fold the credit into its own transaction — a void has to
   * claim the challenge row and pay both sides atomically, or a crash between
   * the two leaves money stranded. Without `em` this opens its own transaction,
   * so existing callers are unchanged.
   *
   * `type` is DUEL_PAYOUT for winnings and REFUND for a void — the same
   * distinction the duel-expiry cron already makes in engagement.job.ts.
   */
  private async credit(
    userId: string,
    amount: number,
    note: string,
    referenceId: string | null,
    em?: EntityManager,
    type: TransactionType = TransactionType.DUEL_PAYOUT,
  ): Promise<void> {
    const run = async (m: EntityManager): Promise<void> => {
      const balanceBefore = await ledgerBalance(m, userId, BTN_CURRENCY);
      const txRepo = m.getRepository(Transaction);
      await txRepo.save(
        txRepo.create({
          userId,
          type,
          amount,
          currency: BTN_CURRENCY,
          balanceBefore,
          balanceAfter: balanceBefore + amount,
          note,
          positionId: referenceId ?? undefined,
        }),
      );
    };

    if (em) {
      await run(em);
    } else {
      await this.dataSource.transaction(run);
    }
    this.sse.emit(userId, "balance:updated", {});
  }

  /**
   * Drop the cached balance so the next /me reflects the ledger immediately.
   *
   * The cache has a 15s TTL, so this self-heals — but a void DMs the player
   * "your wager has been refunded", and that DM lands inside the window.
   */
  private async bustBalanceCache(...userIds: (string | null)[]): Promise<void> {
    const keys = userIds
      .filter((id): id is string => !!id)
      .map((id) => `oro:cache:balance:${id}`);
    if (keys.length) await this.redis.del(...keys).catch(() => {});
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  async create(
    creatorId: string,
    marketId: string,
    outcomeId: string,
    wagerAmount: number = 0,
    equippedCard?: CardType,
  ): Promise<Challenge> {
    if (wagerAmount < 0)
      throw new BadRequestException("Wager cannot be negative");

    // Shield is a passive card that auto-saves the daily bet streak after a
    // missed day — it is not equippable on a duel (that would just burn it).
    if (equippedCard === CardType.SHIELD) {
      throw new BadRequestException(
        "Shield cards protect your daily streak automatically and can't be equipped on a duel",
      );
    }

    // 1. Eligibility — must have ≥ 5 predictions
    const totalBets = await this.positionRepo.count({
      where: { userId: creatorId },
    });
    if (totalBets < MIN_PREDICTIONS_REQUIRED) {
      throw new BadRequestException(
        `You need at least ${MIN_PREDICTIONS_REQUIRED} bets to create a challenge (you have ${totalBets})`,
      );
    }

    // 2. Market must be open
    const market = await this.marketRepo.findOne({ where: { id: marketId } });
    if (!market) throw new NotFoundException("Market not found");
    if (market.status !== MarketStatus.OPEN) {
      throw new BadRequestException("Market is not open for challenges");
    }

    // 3. Creator must have a pending position on this market
    const position = await this.positionRepo.findOne({
      where: { userId: creatorId, marketId, status: PositionStatus.PENDING },
    });
    if (!position) {
      throw new BadRequestException(
        "You must have an active bet on this market to create a challenge",
      );
    }

    // 4. No duplicate open challenge on same market
    const existing = await this.challengeRepo.findOne({
      where: { creatorId, marketId, status: ChallengeStatus.OPEN },
    });
    if (existing) {
      throw new BadRequestException(
        "You already have an open challenge on this market",
      );
    }

    // 5. Deduct wager from creator's balance (if > 0) — must happen before
    //    consuming the card so a failed balance check never silently burns a card.
    if (wagerAmount > 0) {
      await this.debit(
        creatorId,
        wagerAmount,
        `Duel wager locked — market ${marketId}`,
        null, // challenge ID not yet assigned at this point
      );
    }

    // 6. Consume equipped card from inventory (if provided)
    if (equippedCard) {
      await this.consumeCard(creatorId, equippedCard);
    }

    const expiresAt = new Date(market.closesAt);
    const challenge = this.challengeRepo.create({
      creatorId,
      marketId,
      outcomeId,
      status: ChallengeStatus.OPEN,
      participantCount: 0,
      wagerAmount,
      joinerId: null,
      winnerId: null,
      settledAt: null,
      equippedCard: equippedCard ?? null,
      expiresAt,
    });

    return this.challengeRepo.save(challenge);
  }

  // ── Card helpers ───────────────────────────────────────────────────────────

  /**
   * Normalize raw cardInventory from DB.
   * The original CreateUsersTable migration set DEFAULT '[]' (an array) instead
   * of an object, so existing rows may have [] instead of null. Treat both as zeros.
   */
  private normalizeInventory(
    raw: { doubleDown: number; shield: number; ghost: number } | null,
  ): { doubleDown: number; shield: number; ghost: number } {
    if (!raw || Array.isArray(raw)) return { doubleDown: 0, shield: 0, ghost: 0 };
    return {
      doubleDown: raw.doubleDown ?? 0,
      shield: raw.shield ?? 0,
      ghost: raw.ghost ?? 0,
    };
  }

  /** Return the caller's current card inventory (zeros if never earned any). */
  async getCardInventory(
    userId: string,
  ): Promise<{ doubleDown: number; shield: number; ghost: number }> {
    const user = await this.dataSource
      .getRepository(User)
      .findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    return this.normalizeInventory(user.cardInventory);
  }

  /** Decrement one card of the given type from the user's inventory, or throw. */
  private async consumeCard(userId: string, card: CardType): Promise<void> {
    const userRepo = this.dataSource.getRepository(User);
    const user = await userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");

    const inv = this.normalizeInventory(user.cardInventory);
    if ((inv[card] ?? 0) < 1) {
      throw new BadRequestException(
        `You don't have a ${card} card in your inventory`,
      );
    }
    inv[card] -= 1;
    user.cardInventory = inv;
    await userRepo.save(user);
  }

  /**
   * Award a card to a user when they cross a win milestone.
   * Milestones: 3 → doubleDown, 7 → shield, 15 → ghost.
   * Every 10 wins after 15 → random card.
   * Each threshold fires exactly once (the count check is the gate).
   */
  private async awardMilestoneCards(userId: string): Promise<CardType | null> {
    const totalWins = await this.challengeRepo.count({
      where: { winnerId: userId, status: ChallengeStatus.SETTLED },
    });

    let awarded: CardType | null = null;

    if (CARD_MILESTONES[totalWins]) {
      awarded = CARD_MILESTONES[totalWins];
    } else if (totalWins > 15 && (totalWins - 15) % 10 === 0) {
      const cards = [CardType.DOUBLE_DOWN, CardType.SHIELD, CardType.GHOST];
      awarded = cards[Math.floor(Math.random() * cards.length)];
    }

    if (awarded) {
      const userRepo = this.dataSource.getRepository(User);
      const user = await userRepo.findOne({ where: { id: userId } });
      if (user) {
        const inv = this.normalizeInventory(user.cardInventory);
        inv[awarded] = (inv[awarded] ?? 0) + 1;
        user.cardInventory = inv;
        await userRepo.save(user);
      }
    }

    return awarded;
  }

  // ── Join ───────────────────────────────────────────────────────────────────

  async join(challengeId: string, joiningUserId: string): Promise<Challenge> {
    // Run the whole join in one transaction with the challenge row locked, so
    // two users can't both pass the OPEN check and join the same duel: the
    // second waits on the lock, then sees status ACTIVE and is rejected. The
    // wager debit shares this transaction (via `em`), so locking + debit +
    // status flip commit atomically.
    return this.dataSource.transaction(async (em) => {
      const challengeRepo = em.getRepository(Challenge);

      const challenge = await challengeRepo
        .createQueryBuilder("c")
        .setLock("pessimistic_write")
        .where("c.id = :id", { id: challengeId })
        .getOne();
      if (!challenge) throw new NotFoundException("Challenge not found");
      if (
        challenge.status === ChallengeStatus.EXPIRED ||
        challenge.expiresAt < new Date()
      ) {
        throw new BadRequestException("This challenge has expired");
      }
      if (challenge.status !== ChallengeStatus.OPEN) {
        throw new BadRequestException("This challenge is no longer open");
      }
      if (challenge.creatorId === joiningUserId) {
        throw new BadRequestException("You cannot join your own challenge");
      }

      // Deduct wager from joiner (inside this transaction)
      if (Number(challenge.wagerAmount) > 0) {
        await this.debit(
          joiningUserId,
          Number(challenge.wagerAmount),
          `Duel wager locked — challenge ${challengeId}`,
          challengeId,
          em,
        );
      }

      challenge.participantCount += 1;
      challenge.joinerId = joiningUserId;
      challenge.status = ChallengeStatus.ACTIVE;
      return challengeRepo.save(challenge);
    });
  }

  // ── Void & refund ──────────────────────────────────────────────────────────

  /**
   * Call the duel off and return every wager.
   *
   * Used when the market a duel rides on will never produce an answer: it was
   * cancelled, or it settled as a refund. Nobody wins, so nobody pays the
   * platform fee either — each side simply gets its stake back.
   *
   * Exactly-once by construction. The conditional UPDATE is the claim: only the
   * caller whose UPDATE reports `affected = 1` proceeds to credit anyone, and
   * the claim shares a transaction with both credits, so there is no window in
   * which a challenge reads VOID with the money still held. That matters
   * because two paths can now reach the same row — cancelMarket() and the
   * hourly expiry cron in engagement.job.ts — and a duel wager refunded twice
   * is money invented.
   *
   * Returns null when another caller got there first.
   */
  async voidChallenge(
    challengeId: string,
    note: string,
  ): Promise<{
    challenge: Challenge;
    refunds: { userId: string; amount: number }[];
  } | null> {
    const challenge = await this.challengeRepo.findOne({
      where: { id: challengeId },
      relations: ["creator", "joiner", "market"],
    });
    if (!challenge) return null;

    const wager = Number(challenge.wagerAmount);
    const now = new Date();
    const refunds: { userId: string; amount: number }[] = [];

    const claimed = await this.dataSource.transaction(async (em) => {
      const claim = await em.getRepository(Challenge).update(
        {
          id: challengeId,
          status: In([ChallengeStatus.OPEN, ChallengeStatus.ACTIVE]),
        },
        { status: ChallengeStatus.VOID, settledAt: now },
      );
      if (!claim.affected) return false;

      if (wager > 0) {
        // A bragging-rights duel (wager 0) writes no ledger rows at all.
        for (const userId of [challenge.creatorId, challenge.joinerId]) {
          if (!userId) continue;
          await this.credit(
            userId,
            wager,
            note,
            challengeId,
            em,
            TransactionType.REFUND,
          );
          refunds.push({ userId, amount: wager });
        }
      }
      return true;
    });

    if (!claimed) return null;

    challenge.status = ChallengeStatus.VOID;
    challenge.settledAt = now;
    await this.bustBalanceCache(challenge.creatorId, challenge.joinerId);
    return { challenge, refunds };
  }

  /**
   * Tell both players their duel was called off. Fire-and-forget, after commit.
   * Telegram only — matching the duel-expiry cron. PWA/BhutanApp users get no
   * push and no bell entry; the ledger note is their only trace.
   */
  private async notifyVoided(
    challenge: Challenge,
    wager: number,
    reason: string,
  ): Promise<void> {
    const marketTitle = challenge.market?.title ?? "The market";
    const refundLine =
      wager > 0 ? ` Your Nu ${wager} wager has been returned in full.` : "";

    for (const user of [challenge.creator, challenge.joiner]) {
      if (!user?.telegramId) continue;
      await this.telegram
        .sendMessage(
          Number(user.telegramId),
          `🚫 <b>Your duel has been called off.</b>${refundLine}\n\n` +
            `${reason} on <b>${marketTitle}</b>, so there was no result to settle on.`,
        )
        .catch(() => {});
    }
  }

  // ── Settle by market ───────────────────────────────────────────────────────
  // Called by ParimutuelEngine after a market resolves, and with a null outcome
  // when the market was cancelled or settled as a refund.

  async settleByMarket(
    marketId: string,
    winningOutcomeId: string | null,
  ): Promise<void> {
    const challenges = await this.challengeRepo.find({
      where: [
        { marketId, status: ChallengeStatus.ACTIVE },
        { marketId, status: ChallengeStatus.OPEN },
      ],
      // creator/joiner/market are needed by the void DM. Without them
      // `ch.creator` is undefined and the notification silently never fires.
      relations: ["creator", "joiner", "market"],
    });

    for (const ch of challenges) {
      const wager = Number(ch.wagerAmount);
      const now = new Date();

      // Market voided OR no one joined — refund every side.
      // voidChallenge owns the status write and both credits in one guarded
      // transaction, so `continue` past the shared save() at the end of the
      // loop, which would otherwise clobber it with this stale in-memory copy.
      if (!winningOutcomeId || !ch.joinerId) {
        const result = await this.voidChallenge(
          ch.id,
          `Duel void refund — challenge ${ch.id}`,
        );
        if (result) {
          await this.notifyVoided(
            result.challenge,
            wager,
            winningOutcomeId
              ? "Nobody accepted your challenge"
              : "The market was called off",
          );
        }
        continue;
      }

      // Determine winner: creator wins if winning outcome matches their outcomeId
      const creatorWins = ch.outcomeId === winningOutcomeId;
      const winnerId = creatorWins ? ch.creatorId : ch.joinerId;
      const loserId = creatorWins ? ch.joinerId : ch.creatorId;

      ch.status = ChallengeStatus.SETTLED;
      ch.winnerId = winnerId;
      ch.settledAt = now;

      if (wager > 0) {
        const totalPot = wager * 2;
        // Double Down card: creator equipped it → fee waived for this duel
        const feeWaived = ch.equippedCard === CardType.DOUBLE_DOWN;
        const platformCut = feeWaived ? 0 : totalPot * PLATFORM_FEE_PCT;
        const winnerPayout = totalPot - platformCut;

        await this.credit(
          winnerId,
          winnerPayout,
          `Duel win payout${feeWaived ? " (Double Down — no fee)" : ""} — challenge ${ch.id}`,
          ch.id,
        );

        // Record platform fee for revenue tracking and DK Bank transfer
        if (platformCut > 0) {
          await this.revenueDistribution
            .recordDuelDistribution(
              ch.id,
              platformCut,
              totalPot,
              PLATFORM_FEE_PCT * 100,
            )
            .catch(() => {}); // non-fatal: settlement must not be blocked by fee tracking
        }

        // Loser already had their wager debited at join/create — nothing more to do
        void loserId; // referenced to avoid lint unused-var
      }

      // Award milestone cards to the winner (fire-and-forget errors are non-fatal)
      await this.awardMilestoneCards(winnerId).catch(() => {});

      await this.challengeRepo.save(ch);
    }
  }

  // Duel expiry lives in EngagementJob.expireAndNotifyStaleDuels() — the hourly
  // cron that actually runs. A second copy of it lived here (`expireStale`),
  // called by nothing but its own tests, booking the refund as DUEL_PAYOUT
  // rather than REFUND and claiming no row before paying. Two unguarded
  // implementations of "refund this wager" is how a duel gets paid twice, so it
  // is gone rather than left as a trap.

  // ── Community open feed ────────────────────────────────────────────────────

  async findOpen(requestingUserId: string): Promise<Challenge[]> {
    return this.challengeRepo
      .createQueryBuilder("c")
      .leftJoinAndSelect("c.market", "m")
      .leftJoinAndSelect("c.outcome", "o")
      .leftJoinAndSelect("c.creator", "u")
      .where("c.status = :status", { status: ChallengeStatus.OPEN })
      .andWhere("c.expiresAt > NOW()")
      .andWhere("c.creatorId != :uid", { uid: requestingUserId })
      .andWhere("m.status = :mStatus", { mStatus: MarketStatus.OPEN })
      .orderBy("c.wagerAmount", "DESC")
      .addOrderBy("c.createdAt", "DESC")
      .limit(30)
      .getMany();
  }

  // ── Public preview (no auth) ──────────────────────────────────────────────
  // Powers the landing page a `challenge_<id>` deep link opens for someone who
  // is not signed in yet. Returns only what's safe to show a stranger — never a
  // raw telegramId, and the wager is hidden while a Ghost card is active.

  async getPublicPreview(id: string): Promise<{
    id: string;
    marketId: string;
    marketTitle: string | null;
    marketStatus: MarketStatus | null;
    outcomeId: string;
    outcomeLabel: string | null;
    creatorName: string;
    wagerAmount: number | null;
    status: ChallengeStatus;
    expiresAt: Date | null;
  }> {
    const c = await this.challengeRepo
      .createQueryBuilder("c")
      .leftJoinAndSelect("c.market", "m")
      .leftJoinAndSelect("c.outcome", "o")
      .leftJoinAndSelect("c.creator", "u")
      .where("c.id = :id", { id })
      .getOne();

    if (!c) throw new NotFoundException("Challenge not found");

    const ghostActive =
      c.equippedCard === CardType.GHOST && c.status === ChallengeStatus.OPEN;

    return {
      id: c.id,
      marketId: c.marketId,
      marketTitle: c.market?.title ?? null,
      marketStatus: c.market?.status ?? null,
      outcomeId: c.outcomeId,
      outcomeLabel: c.outcome?.label ?? null,
      creatorName:
        c.creator?.username ?? c.creator?.firstName ?? "Someone",
      wagerAmount: ghostActive ? null : Number(c.wagerAmount ?? 0),
      status: c.status,
      expiresAt: c.expiresAt ?? null,
    };
  }

  // ── My challenges (created + joined) ──────────────────────────────────────

  async findForUser(userId: string): Promise<Challenge[]> {
    return this.challengeRepo
      .createQueryBuilder("c")
      .leftJoinAndSelect("c.market", "m")
      .leftJoinAndSelect("c.outcome", "o")
      .leftJoinAndSelect("c.creator", "u")
      .leftJoinAndSelect("c.joiner", "j")
      .where("(c.creatorId = :uid OR c.joinerId = :uid)", { uid: userId })
      .andWhere("c.status IN (:...statuses)", {
        statuses: [ChallengeStatus.OPEN, ChallengeStatus.ACTIVE],
      })
      .orderBy("c.createdAt", "DESC")
      .limit(20)
      .getMany();
  }

  // ── Weekly leaderboard (most duel wins this week) ─────────────────────────

  async getLeaderboard(): Promise<
    {
      userId: string;
      username: string | null;
      wins: number;
      wagerWon: number;
    }[]
  > {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const rows = await this.challengeRepo
      .createQueryBuilder("c")
      .leftJoin("c.creator", "creator")
      .leftJoin("c.joiner", "joiner")
      .select("c.winnerId", "userId")
      .addSelect(
        `CASE WHEN c.winnerId = c.creatorId THEN creator.username ELSE joiner.username END`,
        "username",
      )
      .addSelect("COUNT(*)", "wins")
      .addSelect("SUM(c.wagerAmount * 2 * 0.9)", "wagerWon")
      .where("c.status = :status", { status: ChallengeStatus.SETTLED })
      .andWhere("c.settledAt >= :weekAgo", { weekAgo })
      .andWhere("c.winnerId IS NOT NULL")
      .groupBy("c.winnerId")
      .addGroupBy("c.creatorId")
      .addGroupBy("c.joinerId")
      .addGroupBy("creator.username")
      .addGroupBy("joiner.username")
      .orderBy("wins", "DESC")
      .addOrderBy('"wagerWon"', "DESC")
      .limit(20)
      .getRawMany();

    return rows.map((r) => ({
      userId: r.userId,
      username: r.username ?? null,
      wins: Number(r.wins),
      wagerWon: Number(r.wagerWon ?? 0),
    }));
  }
}
