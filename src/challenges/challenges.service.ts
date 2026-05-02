import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";
import { Repository, DataSource } from "typeorm";
import {
  Challenge,
  ChallengeStatus,
  CardType,
} from "../entities/challenge.entity";
import { Position, PositionStatus } from "../entities/position.entity";
import { Market, MarketStatus } from "../entities/market.entity";
import { Transaction, TransactionType } from "../entities/transaction.entity";
import { User } from "../entities/user.entity";

const MIN_PREDICTIONS_REQUIRED = 5;
const PLATFORM_FEE_PCT = 0.1;

const CARD_MILESTONES: Record<number, CardType> = {
  3: CardType.DOUBLE_DOWN,
  7: CardType.SHIELD,
  15: CardType.GHOST,
};

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
  ) {}

  // ── Balance helper ─────────────────────────────────────────────────────────

  private async getBalance(userId: string): Promise<number> {
    const { balance } = await this.dataSource
      .getRepository(Transaction)
      .createQueryBuilder("t")
      .select("COALESCE(SUM(t.amount), 0)", "balance")
      .where("t.userId = :userId", { userId })
      .getRawOne();
    return Number(balance);
  }

  private async debit(
    userId: string,
    amount: number,
    note: string,
    referenceId: string | null,
  ): Promise<void> {
    const balanceBefore = await this.getBalance(userId);
    if (balanceBefore < amount) {
      throw new BadRequestException("Insufficient balance for wager");
    }
    const tx = this.dataSource.getRepository(Transaction).create({
      userId,
      type: TransactionType.DUEL_WAGER,
      amount: -amount,
      balanceBefore,
      balanceAfter: balanceBefore - amount,
      note,
      positionId: referenceId ?? undefined,
    });
    await this.dataSource.getRepository(Transaction).save(tx);
  }

  private async credit(
    userId: string,
    amount: number,
    note: string,
    referenceId: string | null,
  ): Promise<void> {
    const balanceBefore = await this.getBalance(userId);
    const tx = this.dataSource.getRepository(Transaction).create({
      userId,
      type: TransactionType.DUEL_PAYOUT,
      amount,
      balanceBefore,
      balanceAfter: balanceBefore + amount,
      note,
      positionId: referenceId ?? undefined,
    });
    await this.dataSource.getRepository(Transaction).save(tx);
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
    const challenge = await this.challengeRepo.findOne({
      where: { id: challengeId },
    });
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

    // Deduct wager from joiner
    if (Number(challenge.wagerAmount) > 0) {
      await this.debit(
        joiningUserId,
        Number(challenge.wagerAmount),
        `Duel wager locked — challenge ${challengeId}`,
        challengeId,
      );
    }

    challenge.participantCount += 1;
    challenge.joinerId = joiningUserId;
    challenge.status = ChallengeStatus.ACTIVE;
    return this.challengeRepo.save(challenge);
  }

  // ── Settle by market ───────────────────────────────────────────────────────
  // Called by ParimutuelEngine (fire-and-forget) after a market resolves.

  async settleByMarket(
    marketId: string,
    winningOutcomeId: string | null,
  ): Promise<void> {
    const challenges = await this.challengeRepo.find({
      where: [
        { marketId, status: ChallengeStatus.ACTIVE },
        { marketId, status: ChallengeStatus.OPEN },
      ],
    });

    for (const ch of challenges) {
      const wager = Number(ch.wagerAmount);
      const now = new Date();

      if (!winningOutcomeId || !ch.joinerId) {
        // Market voided OR no one joined — refund creator
        ch.status = ChallengeStatus.VOID;
        ch.settledAt = now;
        if (wager > 0) {
          await this.credit(
            ch.creatorId,
            wager,
            `Duel void refund — challenge ${ch.id}`,
            ch.id,
          );
          // Also refund joiner if they had joined
          if (ch.joinerId) {
            await this.credit(
              ch.joinerId,
              wager,
              `Duel void refund — challenge ${ch.id}`,
              ch.id,
            );
          }
        }
      } else {
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

          // Loser already had their wager debited at join/create — nothing more to do
          void loserId; // referenced to avoid lint unused-var
        }

        // Award milestone cards to the winner (fire-and-forget errors are non-fatal)
        await this.awardMilestoneCards(winnerId).catch(() => {});
      }

      await this.challengeRepo.save(ch);
    }
  }

  // ── Expire stale open challenges & refund wagers ───────────────────────────

  async expireStale(): Promise<number> {
    const stale = await this.challengeRepo.find({
      where: { status: ChallengeStatus.OPEN },
    });
    const now = new Date();
    let count = 0;

    for (const ch of stale) {
      if (ch.expiresAt >= now) continue;
      ch.status = ChallengeStatus.EXPIRED;
      ch.settledAt = now;

      if (Number(ch.wagerAmount) > 0) {
        await this.credit(
          ch.creatorId,
          Number(ch.wagerAmount),
          `Duel expired refund — challenge ${ch.id}`,
          ch.id,
        );
      }

      await this.challengeRepo.save(ch);
      count++;
    }

    return count;
  }

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

  // ── Shield check ──────────────────────────────────────────────────────────
  // Called by ParimutuelEngine before resetting telegramStreak on a market loss.
  // Returns true if the user is the creator of an ACTIVE duel on this market
  // with a Shield card equipped — meaning their streak should be preserved.

  async hasShieldActive(userId: string, marketId: string): Promise<boolean> {
    const ch = await this.challengeRepo.findOne({
      where: {
        creatorId: userId,
        marketId,
        status: ChallengeStatus.ACTIVE,
        equippedCard: CardType.SHIELD,
      },
    });
    return ch !== null;
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
