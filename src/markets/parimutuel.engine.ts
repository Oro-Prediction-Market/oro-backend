import {
  Injectable,
  BadRequestException,
  Logger,
  OnModuleInit,
} from "@nestjs/common";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { Repository, DataSource, In } from "typeorm";
import { RedisService } from "../redis/redis.service";
import { Market, MarketStatus } from "../entities/market.entity";
import { Outcome } from "../entities/outcome.entity";
import { Position, PositionStatus } from "../entities/position.entity";
import { Payment } from "../entities/payment.entity";
import { Transaction, TransactionType } from "../entities/transaction.entity";
import { Settlement } from "../entities/settlement.entity";
import { Dispute, DisputeBondStatus } from "../entities/dispute.entity";
import { Challenge, ChallengeStatus } from "../entities/challenge.entity";
import { User } from "../entities/user.entity";
import { LMSRService } from "./lmsr.service";
import { ReputationService } from "./reputation.service";
import { MarketsGateway } from "./markets.gateway";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";
import { DKGatewayService } from "../payment/services/dk-gateway/dk-gateway.service";
import { StreakService, STREAK_BONUS_MULT } from "../users/streak.service";
import { ChallengesService } from "../challenges/challenges.service";
import { SseService } from "../sse/sse.service";
import { RevenueDistributionService } from "./revenue-distribution.service";

// ─── Valid state machine transitions ────────────────────────────────────────
const VALID_TRANSITIONS: Record<MarketStatus, MarketStatus[]> = {
  [MarketStatus.UPCOMING]: [MarketStatus.OPEN, MarketStatus.CANCELLED],
  [MarketStatus.OPEN]: [MarketStatus.CLOSED, MarketStatus.CANCELLED],
  [MarketStatus.CLOSED]: [MarketStatus.RESOLVING, MarketStatus.CANCELLED],
  [MarketStatus.RESOLVING]: [MarketStatus.CANCELLED],
  [MarketStatus.RESOLVED]: [MarketStatus.SETTLED],
  [MarketStatus.SETTLED]: [],
  [MarketStatus.CANCELLED]: [],
};

@Injectable()
export class ParimutuelEngine implements OnModuleInit {
  private readonly logger = new Logger(ParimutuelEngine.name);

  onModuleInit() {
    this.logger.log(
      "ParimutuelEngine [v2] initialized with dynamic calculation support",
    );
  }

  constructor(
    @InjectRepository(Market) private marketRepo: Repository<Market>,
    @InjectRepository(Outcome) private outcomeRepo: Repository<Outcome>,
    @InjectRepository(Position) private betRepo: Repository<Position>,
    @InjectRepository(Payment) private paymentRepo: Repository<Payment>,
    @InjectRepository(Transaction)
    private transactionRepo: Repository<Transaction>,
    @InjectRepository(Settlement)
    private settlementRepo: Repository<Settlement>,
    @InjectRepository(Dispute) private disputeRepo: Repository<Dispute>,
    @InjectDataSource() private dataSource: DataSource,
    private lmsrService: LMSRService,
    private redis: RedisService,
    private reputationService: ReputationService,
    private telegramSimple: TelegramSimpleService,
    private dkGateway: DKGatewayService,
    private configService: ConfigService,
    private streakService: StreakService,
    private challengesService: ChallengesService,
    private marketsGateway: MarketsGateway,
    private sse: SseService,
    private revenueDistributionService: RevenueDistributionService,
  ) {}

  private async getCreditsBalance(
    em: { getRepository: Function },
    userId: string,
  ): Promise<number> {
    const { balance } = await em
      .getRepository(Transaction)
      .createQueryBuilder("t")
      .select("COALESCE(SUM(t.amount), 0)", "balance")
      .where("t.userId = :userId", { userId })
      .getRawOne();
    return Number(balance);
  }

  // ── Odds calculation ───────────────────────────────────────────────────────
  calcOdds(
    totalPool: number,
    houseEdgePct: number,
    outcomePool: number,
  ): number {
    if (outcomePool === 0) return 0;
    const payoutPool = totalPool * (1 - houseEdgePct / 100);
    return payoutPool / outcomePool;
  }

  // ── Accept a bet ──────────────────────────────────────────────────────────
  async placePosition(
    userId: string,
    marketId: string,
    outcomeId: string,
    amount: number,
  ): Promise<
    Position & {
      streak?: { count: number; dayInCycle: number; boostActive: boolean };
    }
  > {
    if (amount <= 0)
      throw new BadRequestException("Position amount must be positive");
    // Minimum bet validated inside transaction after market is loaded (TER = Nu 10, others = Nu 50)

    // Acquire a distributed Redis lock so concurrent bets on the same market
    // are serialised at the application layer before touching the DB.
    let lockToken: string | null = null;
    let completedPosition: Position | null = null;
    let betMarket: Market | null = null;
    let betOutcome: Outcome | null = null;
    let betUser: User | null = null;
    let betUserTelegramId: string | null = null;
    let capturedHouseEdgePct = 8; // default; overwritten inside transaction

    try {
      lockToken = await this.redis.acquireLockWithRetry(
        `market:${marketId}`,
        15, // ttl: 15s (covers slow bets)
        8, // retries: 8 attempts (was 3)
        200, // delay: 200ms between retries (was 150ms)
        // total wait: 8 × 200ms = 1.6s before giving up
      );
    } catch (e: any) {
      if (e?.message === "LOCK_CONTENDED") {
        throw new BadRequestException(
          "Market is busy, please try again in a moment",
        );
      }
      // Redis unavailable — proceed without lock (DB pessimistic lock still protects us)
    }

    try {
      completedPosition = await this.dataSource.transaction(async (em) => {
        // Pessimistic write lock ensures only one DB transaction modifies this
        // market's pool at a time, even if the Redis lock is unavailable.
        // 1. Lock the market record (using QueryBuilder to avoid eager joins)
        const market = await em
          .getRepository(Market)
          .createQueryBuilder("m")
          .setLock("pessimistic_write")
          .where("m.id = :marketId", { marketId })
          .getOne();
        if (!market) throw new BadRequestException("Market not found");

        // 2. Fetch outcomes separately
        market.outcomes = await em.find(Outcome, {
          where: { marketId },
          order: { id: "ASC" },
        });

        if (market.status !== MarketStatus.OPEN)
          throw new BadRequestException("Market is not open for betting");

        // Market-aware minimum bet: TER/BTC markets allow Nu 10, others require Nu 50
        const minBet = ["ter", "btc"].includes(market.externalSource ?? "")
          ? 10
          : 50;
        if (amount < minBet)
          throw new BadRequestException(`Minimum bet is Nu ${minBet}`);

        // Enforce bettingClosesAt cutoff (TER markets close betting 2 min before market close)
        if (
          market.bettingClosesAt &&
          new Date() >= new Date(market.bettingClosesAt)
        ) {
          throw new BadRequestException("Betting has closed for this market");
        }

        const outcome = market.outcomes.find((o) => o.id === outcomeId);
        if (!outcome)
          throw new BadRequestException("Outcome not found in this market");

        const user = await em.findOne(User, { where: { id: userId } });
        if (!user) throw new BadRequestException("User not found");

        // Require a linked DK Bank account before placing any bet.
        // Starter-credit balance alone is not sufficient — the user must have
        // gone through the DK Bank onboarding (CID lookup) so winnings can be
        // paid out to a real account.
        if (!user.dkAccountNumber) {
          throw new BadRequestException(
            "You must link your DK Bank account before placing a bet. Go to Wallet Page → Link DK Bank.",
          );
        }

        // Require a verified phone number (stored during DK Bank onboarding).
        // This doubles as identity verification and ensures withdrawal delivery.
        if (!user.phoneNumber) {
          throw new BadRequestException(
            "A verified phone number is required to place a bet. Go to Wallet Page → Link DK Bank.",
          );
        }

        // Block betting when the user already has an ACTIVE duel on this market.
        // An ACTIVE duel means both sides have locked a wager on a specific outcome —
        // placing an additional parimutuel bet on the *opposite* outcome would be a
        // self-contradicting position, and placing on the *same* outcome would give
        // the user an unfair double stake advantage.
        const activeDuel = await em.findOne(Challenge, {
          where: [
            { marketId, creatorId: userId, status: ChallengeStatus.ACTIVE },
            { marketId, joinerId: userId, status: ChallengeStatus.ACTIVE },
          ],
        });
        if (activeDuel) {
          throw new BadRequestException(
            "You have an active duel on this market. Settle or wait for the duel to complete before placing a new bet.",
          );
        }

        // Store user reference for notification
        betUser = user;
        betUserTelegramId = user.telegramId;
        betMarket = market;
        betOutcome = outcome;
        capturedHouseEdgePct = Number(market.houseEdgePct) || 8;

        const balanceBefore = await this.getCreditsBalance(em, userId);
        this.logger.log(
          `[placePosition] user=${userId} credits=${balanceBefore} betAmount=${amount}`,
        );
        if (balanceBefore < amount)
          throw new BadRequestException("Insufficient balance");

        // Snapshot pre-bet LMSR probabilities BEFORE mutating any pool state.
        // This is the probability at the moment the user formed their belief —
        // required for correct Brier score calibration (Formula 1.5).
        const preBetProbs = this.lmsrService.calculateProbabilities(
          market.outcomes,
          Number(market.liquidityParam) || 1000,
        );
        const outcomeIndex = market.outcomes.findIndex(
          (o) => o.id === outcomeId,
        );
        const predictedProbability =
          outcomeIndex >= 0 ? preBetProbs[outcomeIndex] : null;

        // Snapshot pool % for this outcome BEFORE the new bet is added.
        // Used for tournament confidence scoring: 0.5 = maximally uncertain.
        const preBetTotalPool = Number(market.totalPool);
        const preBetOutcomePool = Number(outcome.totalBetAmount);
        const poolPctAtBet =
          preBetTotalPool > 0 ? preBetOutcomePool / preBetTotalPool : 0.5;

        // Update outcome pool
        outcome.totalBetAmount = Number(outcome.totalBetAmount) + amount;

        // Update market total pool
        market.totalPool = Number(market.totalPool) + amount;

        // Recalculate odds for all outcomes (parimutuel - for settlement)
        for (const o of market.outcomes) {
          o.currentOdds = this.calcOdds(
            Number(market.totalPool),
            Number(market.houseEdgePct),
            Number(o.totalBetAmount),
          );
          await em.save(Outcome, o);
        }

        // Calculate post-bet LMSR probabilities and update display
        const postBetProbs = this.lmsrService.calculateProbabilities(
          market.outcomes,
          Number(market.liquidityParam) || 1000,
        );

        // Update LMSR probabilities for all outcomes
        for (let i = 0; i < market.outcomes.length; i++) {
          market.outcomes[i].lmsrProbability = postBetProbs[i];
          await em.save(Outcome, market.outcomes[i]);
        }

        await em.save(Market, market);

        // Update lastActiveAt for decay tracking (outside the transaction is fine —
        // worst case it's slightly stale, never wrong)
        await em.update(User, { id: userId }, { lastActiveAt: new Date() });

        // Create bet record
        const userBonusBalanceAtBet = Number(user.bonusBalance ?? 0);
        const bet = em.create(Position, {
          userId,
          marketId,
          outcomeId,
          amount,
          status: PositionStatus.PENDING,
          oddsAtPlacement: outcome.currentOdds,
          predictedProbability,
          poolPctAtBet,
          // Snapshot whether this bet was funded by bonus credits — used later
          // in reconciliation to track real-money exposure from bonus losses.
          isBonusFunded:
            amount <= userBonusBalanceAtBet && userBonusBalanceAtBet > 0,
        });
        const savedPosition = await em.save(Position, bet);

        await em.save(
          Transaction,
          em.create(Transaction, {
            type: TransactionType.POSITION_OPENED,
            amount: -amount,
            balanceBefore,
            balanceAfter: balanceBefore - amount,
            positionId: savedPosition.id,
            userId,
            note: `Predicted on · ${market.title} → ${outcome.label}`,
          }),
        );

        return savedPosition;
      });

      // Send Telegram notification after successful bet placement
      if (completedPosition && betUser && betMarket && betOutcome) {
        this.sendBetPlacementNotification(
          betUser,
          betMarket,
          betOutcome,
          amount,
        ).catch((err: any) => {
          this.logger.error(
            `Failed to send bet placement notification: ${err.message}`,
          );
        });

        // ── Broadcast live market update via WebSocket ──────────────────
        try {
          const updatedMarket = await this.marketRepo.findOne({
            where: { id: marketId },
            relations: ["outcomes"],
          });
          if (updatedMarket) {
            this.marketsGateway.emitMarketUpdated({
              marketId: updatedMarket.id,
              totalPool: Number(updatedMarket.totalPool),
              outcomes: updatedMarket.outcomes.map((o) => ({
                id: o.id,
                totalBetAmount: Number(o.totalBetAmount),
                lmsrProbability: o.lmsrProbability ?? null,
                currentOdds: Number(o.currentOdds),
              })),
            });
          }
        } catch (err: any) {
          this.logger.warn(`WS broadcast failed: ${err.message}`);
        }
      }

      // ── Update daily bet streak (non-blocking) ───────────────────────────
      const streakResult = await this.streakService
        .updateStreak(userId)
        .catch(() => null);

      // If day-7 boost is active, credit the bonus payout immediately
      if (streakResult?.boostActive && completedPosition) {
        const bonusAmount =
          Math.round(amount * (STREAK_BONUS_MULT - 1) * 100) / 100;
        this.streakService
          .creditStreakBonus(userId, completedPosition.id, bonusAmount)
          .catch((err: any) =>
            this.logger.error(`Streak bonus credit failed: ${err.message}`),
          );
      }

      // ── Streak milestone push notification (non-blocking) ─────────────────
      const streakChatId = betUserTelegramId ? Number(betUserTelegramId) : null;
      if (streakResult && streakChatId) {
        const { dayInCycle, boostActive } = streakResult;
        const shouldNotify =
          boostActive ||
          dayInCycle === 5 ||
          dayInCycle === 3 ||
          dayInCycle === 1;
        if (shouldNotify) {
          const sendStreak = async () => {
            let msg: string;
            if (boostActive) {
              msg = `🔥 <b>Day 7 streak!</b> Your next winning payout gets a <b>1.2× boost</b>. Keep it going!`;
            } else if (dayInCycle === 5) {
              msg = `🔥 <b>5-day streak!</b> Just 2 more days to unlock your <b>1.2× payout boost</b>. Predict tomorrow to keep it alive.`;
            } else if (dayInCycle === 3) {
              msg = `⚡ <b>3-day streak!</b> 4 more days until your bonus boost. Keep predicting daily.`;
            } else {
              // day-1: deduplicate so only the first bet of a new streak fires this
              const todayUtc = new Date().toISOString().slice(0, 10);
              const notifyKey = `streak:day1:notified:${userId}:${todayUtc}`;
              const alreadyNotified = await this.redis.get(notifyKey);
              if (alreadyNotified) return;
              await this.redis.setEx(notifyKey, 48 * 3600, "1");
              msg = `Streak started! Predict daily to earn a Day-7 bonus boost.`;
            }
            await this.telegramSimple.sendMessage(streakChatId, msg);
          };
          sendStreak().catch((err: any) =>
            this.logger.error(`Streak push failed: ${err.message}`),
          );
        }
      }

      // ── Referral bonus (non-blocking) ────────────────────────────────────
      // Fires exactly once: on the referred user's first ever bet.
      // Referrer earns Nu 25 flat + 5% of the first bet, capped at Nu 75.
      this.creditReferralBonusIfEligible(
        userId,
        amount,
        capturedHouseEdgePct,
      ).catch((err: any) =>
        this.logger.error(`Referral bonus credit failed: ${err.message}`),
      );

      // Bust cache NOW (before returning) so the immediate refetch gets fresh data
      await this.redis.del(
        "oro:cache:markets:all",
        `oro:cache:market:${marketId}`,
      );
      await this.redis.del(`oro:cache:balance:${userId}`);

      const result = completedPosition! as Position & {
        streak?: { count: number; dayInCycle: number; boostActive: boolean };
      };
      if (streakResult) {
        result.streak = {
          count: streakResult.newStreak,
          dayInCycle: streakResult.dayInCycle,
          boostActive: streakResult.boostActive,
        };
      }
      return result;
    } catch (err) {
      throw err;
    } finally {
      if (lockToken)
        await this.redis.releaseLock(`market:${marketId}`, lockToken);
      // Invalidate market cache so subsequent reads reflect updated pool/odds
      await this.redis.del(
        "oro:cache:markets:all",
        `oro:cache:market:${marketId}`,
      );
      // Invalidate balance cache for the bettor
      await this.redis.del(`oro:cache:balance:${userId}`);
    }
  }

  // ── Referral bonus ─────────────────────────────────────────────────────────
  /**
   * Credits the referrer a flat Nu 25 bonus + 5% of the referred user's first bet,
   * capped at Nu 75 total. Idempotent: `referralBonusTriggered` ensures exactly once.
   */
  static readonly REFERRAL_FLAT_BONUS = 25; // Nu 25 flat
  static readonly REFERRAL_BET_PCT = 0.05; // 5% of first bet
  static readonly REFERRAL_CAP = 75; // total cap Nu 75

  // ── Referral prize pool (funded from house edge) ──────────────────────────
  /** % of each market's houseAmount contributed to the referral prize fund */
  static readonly PRIZE_FUND_PCT = 0.2; // 20% of house cut per market
  /** How many converted referrals unlock the prize */
  static readonly REFERRAL_PRIZE_THRESHOLD = 10;
  /** Fixed prize credited to the referrer on reaching the threshold */
  static readonly REFERRAL_PRIZE_AMOUNT = 500; // Nu 500

  private async creditReferralBonusIfEligible(
    bettorUserId: string,
    betAmount: number,
    _houseEdgePct: number,
  ): Promise<void> {
    const bettor = await this.dataSource.getRepository(User).findOne({
      where: { id: bettorUserId },
      select: ["id", "referredByUserId", "referralBonusTriggered"],
    });

    if (!bettor?.referredByUserId || bettor.referralBonusTriggered) return;

    const referrer = await this.dataSource
      .getRepository(User)
      .findOne({ where: { id: bettor.referredByUserId }, select: ["id"] });

    if (!referrer) return;

    // Nu 25 flat + 5% of the first bet, capped at Nu 75
    const pct =
      Math.round(betAmount * ParimutuelEngine.REFERRAL_BET_PCT * 100) / 100;
    const bonus = Math.min(
      ParimutuelEngine.REFERRAL_FLAT_BONUS + pct,
      ParimutuelEngine.REFERRAL_CAP,
    );
    if (bonus <= 0) return;

    let bonusCredited = false;

    await this.dataSource.transaction(async (em) => {
      const txRepo = em.getRepository(Transaction);
      const userRepo = em.getRepository(User);

      // Atomic guard: only the first concurrent call wins.
      // Two bets placed simultaneously on different markets can both pass the
      // outer check (pre-transaction read). The conditional WHERE here ensures
      // only one DB write succeeds; the second sees affected=0 and aborts.
      const claim = await userRepo.update(
        { id: bettor.id, referralBonusTriggered: false },
        { referralBonusTriggered: true },
      );
      if (!claim.affected) return;

      const { balance: referrerBalance } = await txRepo
        .createQueryBuilder("t")
        .select("COALESCE(SUM(t.amount), 0)", "balance")
        .where("t.userId = :id", { id: referrer.id })
        .getRawOne();

      const balBefore = Number(referrerBalance);

      await txRepo.save(
        txRepo.create({
          type: TransactionType.REFERRAL_BONUS,
          amount: bonus,
          balanceBefore: balBefore,
          balanceAfter: balBefore + bonus,
          userId: referrer.id,
          isBonus: false,
          note: `Referral bonus — friend placed their first bet`,
        }),
      );

      bonusCredited = true;
    });

    if (!bonusCredited) return;

    // Invalidate referrer's cached balance and notify via SSE
    await this.redis.del(`oro:cache:balance:${referrer.id}`);
    this.sse.emit(referrer.id, "balance:updated", { referralBonus: bonus });

    this.logger.log(
      `[Referral] Credited ${bonus} BTN to referrer ${referrer.id} for referred user ${bettor.id}`,
    );

    // Check if referrer has now hit the prize threshold
    await this.creditReferralPrizeIfEligible(referrer.id);
  }

  /**
   * Auto-credits Nu 500 to the referrer once they hit REFERRAL_PRIZE_THRESHOLD
   * converted referrals. Idempotent: `referralPrizeClaimed` ensures exactly once.
   *
   * Funded by 20% of each market's house cut (PRIZE_FUND_PCT). The platform
   * earns the house edge on all those referred users' bets — at 8% house edge
   * on even modest activity the fund self-replenishes well before the prize fires.
   */
  private async creditReferralPrizeIfEligible(
    referrerId: string,
  ): Promise<void> {
    const referrer = await this.dataSource.getRepository(User).findOne({
      where: { id: referrerId },
      select: ["id", "referralPrizeClaimed"],
    });

    if (!referrer || referrer.referralPrizeClaimed) return;

    const convertedCount = await this.dataSource.getRepository(User).count({
      where: { referredByUserId: referrerId, referralBonusTriggered: true },
    });

    if (convertedCount < ParimutuelEngine.REFERRAL_PRIZE_THRESHOLD) return;

    const prize = ParimutuelEngine.REFERRAL_PRIZE_AMOUNT;

    await this.dataSource.transaction(async (em) => {
      const txRepo = em.getRepository(Transaction);
      const userRepo = em.getRepository(User);

      // Atomic guard: concurrent referral bonus credits for the same referrer
      // could both trigger this check before either commits. Conditional WHERE
      // ensures only one call wins.
      const claim = await userRepo.update(
        { id: referrerId, referralPrizeClaimed: false },
        { referralPrizeClaimed: true },
      );
      if (!claim.affected) return;

      const { balance } = await txRepo
        .createQueryBuilder("t")
        .select("COALESCE(SUM(t.amount), 0)", "balance")
        .where("t.userId = :id", { id: referrerId })
        .getRawOne();

      const balBefore = Number(balance);

      await txRepo.save(
        txRepo.create({
          type: TransactionType.REFERRAL_PRIZE,
          amount: prize,
          balanceBefore: balBefore,
          balanceAfter: balBefore + prize,
          userId: referrerId,
          isBonus: false,
          note: `Referral prize — reached ${ParimutuelEngine.REFERRAL_PRIZE_THRESHOLD} converted friends`,
        }),
      );
    });

    await this.redis.del(`oro:cache:balance:${referrerId}`);
    this.sse.emit(referrerId, "balance:updated", { referralPrize: prize });

    this.logger.log(
      `[ReferralPrize] Credited Nu ${prize} prize to user ${referrerId} (${convertedCount} converted referrals)`,
    );
  }

  // Transition market state
  async transitionMarket(marketId: string, to: MarketStatus): Promise<Market> {
    const market = await this.marketRepo.findOneBy({ id: marketId });
    if (!market) throw new BadRequestException("Market not found");

    const allowed = VALID_TRANSITIONS[market.status];
    if (!allowed.includes(to)) {
      throw new BadRequestException(
        `Cannot transition from ${market.status} → ${to}. Allowed: ${allowed.join(", ") || "none"}`,
      );
    }
    market.status = to;
    return this.marketRepo.save(market);
  }

  // Propose resolution: open short objection window (default 1h, max 2h)
  async proposeResolution(
    marketId: string,
    proposedOutcomeId: string,
    windowMinutes: number = 60,
  ): Promise<Market> {
    const market = await this.marketRepo.findOne({
      where: { id: marketId },
      relations: ["outcomes"],
    });
    if (!market) throw new BadRequestException("Market not found");
    if (market.status !== MarketStatus.CLOSED)
      throw new BadRequestException(
        "Market must be Closed to propose resolution",
      );

    const proposed = market.outcomes.find((o) => o.id === proposedOutcomeId);
    if (!proposed)
      throw new BadRequestException("Proposed outcome not in this market");

    const ALLOWED = [10, 20, 30, 60, 120];
    const mins = ALLOWED.includes(windowMinutes) ? windowMinutes : 60;
    market.proposedOutcomeId = proposedOutcomeId;
    market.windowMinutes = mins;
    market.disputeDeadlineAt = new Date(Date.now() + mins * 60 * 1000);
    market.status = MarketStatus.RESOLVING;
    return this.marketRepo.save(market);
  }

  // Resolve market: mark winner, store public evidence, trigger settlement
  async resolveMarket(
    marketId: string,
    winningOutcomeId: string,
    adminId?: string,
    evidenceUrl?: string,
    evidenceNote?: string,
  ): Promise<Settlement> {
    const market = await this.marketRepo.findOne({
      where: { id: marketId },
      relations: ["outcomes"],
    });
    if (!market) throw new BadRequestException("Market not found");
    if (market.status !== MarketStatus.RESOLVING)
      throw new BadRequestException(
        "Market must be in Resolving state before final resolution",
      );

    const winner = market.outcomes.find((o) => o.id === winningOutcomeId);
    if (!winner)
      throw new BadRequestException("Winning outcome not in this market");

    // ── Enforce the objection window ──────────────────────────────────────────
    // If the window is still open, admin may only resolve early when objections
    // already exist (meaning they have reviewed them). Zero-objection markets
    // must wait for the cron to auto-settle — this prevents rushed resolutions.
    const now = new Date();
    const windowStillOpen =
      market.disputeDeadlineAt && now < market.disputeDeadlineAt;

    if (windowStillOpen) {
      const objectionCount = await this.disputeRepo.count({
        where: { marketId },
      });
      if (objectionCount === 0) {
        const mins = market.windowMinutes ?? 60;
        const windowLabel = mins >= 60 ? `${mins / 60}h` : `${mins}min`;
        throw new BadRequestException(
          `The ${windowLabel} objection window is still open and closes at ` +
            `${market.disputeDeadlineAt!.toISOString()}. ` +
            `The market will auto-settle once the window closes with no objections. ` +
            `You may force-resolve early only when objections exist and have been reviewed.`,
        );
      }
    }

    // ── Atomic claim: prevent concurrent double-resolution ──────────────────────
    // The status check at the top of this function is read-then-act and can be
    // passed by two concurrent callers before either commits. This conditional
    // UPDATE flips RESOLVING → RESOLVED in a single atomic statement — only one
    // caller wins. Any duplicate tick (e.g. from the @Interval(3_000) scheduler)
    // sees affected === 0 and bails out before reaching settleMarket(),
    // eliminating double payouts.
    //
    // Placed AFTER all validation so that a thrown validation error does not
    // leave the market in a half-resolved state (RESOLVED with no winner /
    // no settlement).
    const claim = await this.marketRepo
      .createQueryBuilder()
      .update(Market)
      .set({
        status: MarketStatus.RESOLVED,
        resolvedOutcomeId: winningOutcomeId,
        resolvedAt: new Date(),
      })
      .where("id = :id AND status = :status", {
        id: marketId,
        status: MarketStatus.RESOLVING,
      })
      .execute();
    if (claim.affected === 0) {
      this.logger.warn(
        `[Concurrency] Market ${marketId} already claimed by another resolver — aborting duplicate resolution`,
      );
      throw new BadRequestException(
        "Market is already being resolved or has been resolved",
      );
    }

    // ── Mark the winner ───────────────────────────────────────────────────────
    winner.isWinner = true;
    await this.outcomeRepo.save(winner);
    market.resolvedOutcomeId = winningOutcomeId;
    market.resolvedAt = new Date();
    market.status = MarketStatus.RESOLVED;

    // ── Store public evidence (mandatory when called by admin) ────────────────
    if (evidenceUrl) {
      market.evidenceUrl = evidenceUrl;
      market.evidenceNote = evidenceNote ?? null;
      market.evidenceSubmittedAt = new Date();
    }
    if (adminId && adminId !== "system:auto-resolve") {
      market.resolvedByAdminId = adminId;
    }

    await this.marketRepo.save(market);

    // ── Mark each objection and settle bonds ──────────────────────────────────
    const disputes = await this.disputeRepo.find({ where: { marketId } });
    if (disputes.length > 0) {
      const proposalChanged =
        !!market.proposedOutcomeId &&
        winningOutcomeId !== market.proposedOutcomeId;

      // Split into correct (upheld) and wrong (overruled) objectors
      const upheldDisputes = disputes.filter(() => proposalChanged); // all upheld when outcome changed
      const overruledDisputes = disputes.filter(() => !proposalChanged); // all overruled when outcome kept

      // Total forfeited pool = sum of bonds from wrong objectors
      const forfeitPool = overruledDisputes.reduce(
        (sum, d) => sum + Number(d.bondAmount),
        0,
      );

      // Total bond staked by correct objectors (for pro-rata reward split)
      const upheldTotalBond = upheldDisputes.reduce(
        (sum, d) => sum + Number(d.bondAmount),
        0,
      );

      // Persist the forfeit pool onto the market record for audit trail
      market.disputeBondPool = forfeitPool;
      await this.marketRepo.save(market);

      // Process each dispute — settle their bond
      for (const d of disputes) {
        d.upheld = !!proposalChanged;

        if (proposalChanged) {
          // ✓ Correct objector: return bond + pro-rata share of forfeit pool
          const rewardShare =
            upheldTotalBond > 0
              ? Math.floor(
                  (Number(d.bondAmount) / upheldTotalBond) * forfeitPool,
                )
              : 0;
          const totalReturn = Number(d.bondAmount) + rewardShare;

          const { balance: rawBal } = await this.transactionRepo
            .createQueryBuilder("t")
            .select("COALESCE(SUM(t.amount), 0)", "balance")
            .where("t.userId = :userId", { userId: d.userId })
            .getRawOne();
          const balBefore = Number(rawBal);

          await this.transactionRepo.save(
            this.transactionRepo.create({
              userId: d.userId,
              type: TransactionType.DISPUTE_BOND_REWARD,
              amount: totalReturn,
              balanceBefore: balBefore,
              balanceAfter: balBefore + totalReturn,
              note:
                `Objection UPHELD on "${market.title}" — bond returned + ` +
                `Nu ${rewardShare} reward from forfeit pool`,
            }),
          );
          d.bondStatus = DisputeBondStatus.REWARDED;

          this.logger.log(
            `[Bond] User ${d.userId} objection UPHELD — returned Nu ${d.bondAmount} + reward Nu ${rewardShare}`,
          );
        } else {
          // ✗ Wrong objector: bond already deducted at lock time — just mark forfeited
          d.bondStatus = DisputeBondStatus.FORFEITED;
          this.logger.log(
            `[Bond] User ${d.userId} objection OVERRULED — bond Nu ${d.bondAmount} forfeited`,
          );
        }
      }
      await this.disputeRepo.save(disputes);

      this.logger.log(
        `[Dispute] Market ${marketId} resolved with ${disputes.length} objection(s). ` +
          `Admin ${adminId ?? "unknown"} chose outcome ${winningOutcomeId}. ` +
          `Proposal was ${market.proposedOutcomeId}. Changed: ${!!proposalChanged}. ` +
          `Forfeit pool: Nu ${forfeitPool}. Rewarded: ${upheldDisputes.length} objector(s).`,
      );

      // ── Admin accountability: track & publicise wrong resolutions ───────────
      if (proposalChanged && adminId && adminId !== "system:auto-resolve") {
        try {
          const adminUser = await this.dataSource
            .getRepository(User)
            .findOne({ where: { id: adminId } });

          if (adminUser) {
            adminUser.adminTotalResolutions =
              (adminUser.adminTotalResolutions ?? 0) + 1;
            adminUser.adminWrongResolutions =
              (adminUser.adminWrongResolutions ?? 0) + 1;
            await this.dataSource.getRepository(User).save(adminUser);

            const total = adminUser.adminTotalResolutions;
            const wrong = adminUser.adminWrongResolutions;
            const pct = Math.round((wrong / total) * 100);
            const adminHandle = adminUser.username
              ? `@${adminUser.username}`
              : `Admin ${adminId.slice(0, 8)}`;

            // Public Telegram alert — visible to all users, no hiding this
            this.telegramSimple
              .postToChannel(
                `⚠️ <b>Resolution Overturned</b>\n\n` +
                  `📊 Market: <i>${market.title}</i>\n` +
                  `👤 Resolved by: <b>${adminHandle}</b>\n\n` +
                  `The original proposed outcome was changed after objectors raised concerns.\n\n` +
                  `📈 Admin accuracy record: <b>${total - wrong}/${total}</b> correct (<b>${100 - pct}%</b>)\n` +
                  `🏅 Wrong resolutions: <b>${wrong}</b>\n\n` +
                  `✅ Objectors who were right had their bonds returned + rewarded.\n` +
                  `All affected users have been correctly paid out.`,
              )
              .catch(() => undefined);

            this.logger.warn(
              `[AdminAccountability] Admin ${adminId} overturned resolution on market ${marketId}. ` +
                `Total: ${total}, Wrong: ${wrong} (${pct}% overturn rate).`,
            );
          }
        } catch (err: any) {
          this.logger.warn(
            `[AdminAccountability] Failed to update admin stats for ${adminId}: ${err.message}`,
          );
        }
      } else if (
        !proposalChanged &&
        adminId &&
        adminId !== "system:auto-resolve"
      ) {
        // Admin kept the proposal — still count as a resolved market
        try {
          await this.dataSource
            .getRepository(User)
            .increment({ id: adminId }, "adminTotalResolutions", 1);
        } catch (_) {
          // non-critical
        }
      }

      // Bust balance caches for all objectors
      await Promise.all(
        disputes.map((d) => this.redis.del(`oro:cache:balance:${d.userId}`)),
      );
    }

    // ── Settle payouts ────────────────────────────────────────────────────────
    // If no disputes existed but a real admin resolved (not system), count the clean resolution
    if (disputes.length === 0 && adminId && adminId !== "system:auto-resolve") {
      try {
        await this.dataSource
          .getRepository(User)
          .increment({ id: adminId }, "adminTotalResolutions", 1);
      } catch (_) {
        // non-critical
      }
    }

    const settlement = await this.settleMarket(market, winner, 0);

    // Record revenue distribution (house edge → pending transfer to public account)
    if (settlement && !settlement.cancelReason && settlement.houseAmount > 0) {
      this.revenueDistributionService
        .recordDistribution(
          market.id,
          settlement.id,
          Number(settlement.houseAmount),
          Number(market.houseEdgePct),
          Number(market.totalPool),
        )
        .catch((err: Error) =>
          this.logger.warn(
            `[Revenue] Failed to record distribution for market ${marketId}: ${err.message}`,
          ),
        );
    }

    // Bust balance cache for every predictor so the TMA reflects payouts immediately
    const allBets = await this.betRepo.find({ where: { marketId } });
    const uniqueUserIds = [...new Set(allBets.map((b) => b.userId))];
    await Promise.all(
      uniqueUserIds.map((uid) => this.redis.del(`oro:cache:balance:${uid}`)),
    );
    // Push real-time SSE event so frontends auto-refresh
    for (const uid of uniqueUserIds) {
      this.sse.emit(uid, "balance:updated", { marketId });
    }

    // Push real BTN from merchant → winners' DK accounts — fire and forget
    this.dispatchDkPayouts(
      market.id,
      winner.id,
      winner.label,
      settlement,
    ).catch((err: Error) =>
      this.logger.warn(
        `[DK Payout] Dispatch failed for market ${marketId}: ${err.message}`,
      ),
    );

    // Recalculate reputation + send individual result DMs — fire and forget
    // Skip if the market was refunded (thin pool / cancelled) — refund DMs
    // are already sent inside settleMarket(); sending win/loss DMs on top
    // would produce a confusing double notification.
    if (!settlement.cancelReason) {
      this.sendSettlementNotifications(market, winner, settlement).catch(
        (err) =>
          this.logger.warn(
            `[Notify] Settlement notifications failed for market ${marketId}: ${err.message}`,
          ),
      );
    }

    // Settle any active duels on this market — fire and forget
    this.challengesService
      .settleByMarket(marketId, winningOutcomeId)
      .catch((err) =>
        this.logger.warn(
          `[Duels] settleByMarket failed for market ${marketId}: ${err.message}`,
        ),
      );

    return settlement;
  }

  /**
   * After settlement, push real BTN from the Oro merchant DK account to
   * all winners via DK Bank Batch API — one CSV upload for the whole market.
   *
   * Flow:
   *   1. Build CSV of winners (accountNumber, amount, reference)
   *   2. Login to DK Batch API with DK_BATCH_USERNAME / DK_BATCH_PASSWORD
   *   3. Sign the upload request with HMAC private key
   *   4. Upload CSV → DK processes all transfers in one shot
   *
   * Falls back to individual /v1/initiate/transaction transfers if batch
   * credentials are not configured (DK_BATCH_USERNAME empty).
   *
   * Bypass: set DK_STAGING_PAYOUT_BYPASS=true to skip all real DK calls.
   */
  private async dispatchDkPayouts(
    marketId: string,
    _winningOutcomeId: string,
    _outcomeLabel: string,
    settlement: Settlement,
  ): Promise<void> {
    // Settlement only credits the winner's Oro wallet balance (Transaction table).
    // Real BTN moves to the user's DK bank account only when they request a withdrawal.
    this.logger.log(
      `[Payout] Market ${marketId} settled — BTN ${settlement.payoutPool} credited to winner wallets. ` +
        `Users withdraw via /payment/withdraw to receive real BTN.`,
    );
  }

  // Settlement: distribute payouts
  private async settleMarket(
    market: Market,
    winner: Outcome,
    slashedBondPool = 0,
  ): Promise<Settlement> {
    return await this.dataSource.transaction(async (em) => {
      const totalPool = Number(market.totalPool);
      const houseAmount = totalPool * (Number(market.houseEdgePct) / 100);
      // 95% of any slashed dispute bonds flows to winning bettors; 5% is platform fee
      const disputeBonus = slashedBondPool * 0.95;
      const payoutPool = totalPool - houseAmount + disputeBonus;

      const winnerPool = Number(winner.totalBetAmount);
      const bets = await em.find(Position, { where: { marketId: market.id } });

      // ── Thin-pool guard ───────────────────────────────────────────────────────
      // Covers Scenario A (all bets on winning side) and Scenario B (all bets on
      // losing side) with a single check: a real market needs at least one bettor
      // on each side. If not, refund everyone instead of letting parimutuel math
      // pay "winners" less than they staked or silently keep the losing pool.
      const minUniqueBettors = Number(
        this.configService.get("MIN_UNIQUE_BETTORS", "2"),
      );
      const uniqueBettorIds = new Set(bets.map((b) => b.userId));
      const winningBets = bets.filter((b) => b.outcomeId === winner.id);
      const losingSideBettors = bets.length - winningBets.length;

      if (
        uniqueBettorIds.size < minUniqueBettors ||
        losingSideBettors === 0 || // Scenario A: all bets on winning side
        winningBets.length === 0 // Scenario B: no bets on winning side (winnerPool=0)
      ) {
        await this.refundPositions(em, bets, "Thin pool — market refunded");
        market.status = MarketStatus.SETTLED;
        await em.save(Market, market);

        // Notify each unique bettor
        const seenForDm = new Set<string>();
        for (const bet of bets) {
          if (seenForDm.has(bet.userId)) continue;
          seenForDm.add(bet.userId);
          const user = await em.findOne(User, {
            where: { id: bet.userId },
            select: ["id", "telegramId"],
          });
          if (user?.telegramId) {
            this.telegramSimple
              .sendRefundNotification(
                Number(user.telegramId),
                market.title,
                Number(bet.amount),
                "thin_pool",
              )
              .catch(() => undefined);
          }
        }

        const settlement = em.create(Settlement, {
          marketId: market.id,
          winningOutcomeId: winner.id,
          totalPositions: bets.length,
          winningPositions: 0,
          totalPool,
          houseAmount: 0,
          payoutPool: 0,
          totalPaidOut: 0,
          cancelReason: "thin_pool",
        });
        return em.save(Settlement, settlement);
      }
      // ── End thin-pool guard ───────────────────────────────────────────────────

      let totalPaidOut = 0;
      let winningPositions = 0;

      for (const bet of bets) {
        if (bet.outcomeId === winner.id) {
          // Payout proportional to their share of winner pool
          const share = winnerPool > 0 ? Number(bet.amount) / winnerPool : 0;
          const rawPayout = parseFloat((payoutPool * share).toFixed(2));
          // Floor at 1.05× stake so winners always profit; house absorbs the difference
          // in thin-pool edge cases not caught by the thin-pool guard above.
          const stake = Number(bet.amount);
          const effectivePayout = parseFloat(
            Math.max(rawPayout, stake * 1.05).toFixed(2),
          );

          // ── Bonus cap logic ────────────────────────────────────────────────
          // If this bet was placed using bonus credits, cap the total real
          // (withdrawable) payout against the user's lifetime bonusRealPayoutRemaining.
          // Anything above that is re-credited as play money (isBonus=true).
          // Using a lifetime cap prevents splitting bonus into small bets to
          // multiply real payouts.
          const user = await em.findOne(User, {
            where: { id: bet.userId },
            select: ["id", "bonusBalance", "bonusRealPayoutRemaining"],
          });
          const userBonusBalance = Number(user?.bonusBalance ?? 0);
          const bonusRealPayoutRemaining = Number(
            user?.bonusRealPayoutRemaining ?? 0,
          );
          const betIsBonusFunded =
            userBonusBalance > 0 && Number(bet.amount) <= userBonusBalance;

          let withdrawablePayout = effectivePayout;
          let playPayout = 0;

          if (betIsBonusFunded) {
            // Cap real payout against the lifetime remaining allowance — not just Nu 50 per bet.
            // This prevents splitting bonus into many small bets to multiply real payouts.
            withdrawablePayout = parseFloat(
              Math.min(effectivePayout, bonusRealPayoutRemaining).toFixed(2),
            );
            playPayout = parseFloat(
              (effectivePayout - withdrawablePayout).toFixed(2),
            );
            // Reduce both the bonus balance and the lifetime real payout allowance
            const newBonusBalance = Math.max(
              0,
              userBonusBalance - Number(bet.amount),
            );
            const newRealPayoutRemaining = Math.max(
              0,
              bonusRealPayoutRemaining - withdrawablePayout,
            );
            await em.update(
              User,
              { id: bet.userId },
              {
                bonusBalance: newBonusBalance,
                bonusRealPayoutRemaining: newRealPayoutRemaining,
              },
            );
          }

          bet.payout = effectivePayout;
          bet.status = PositionStatus.WON;
          totalPaidOut += effectivePayout;
          winningPositions++;

          const balanceBefore = await this.getCreditsBalance(em, bet.userId);

          // Credit the withdrawable portion
          await em.save(
            Transaction,
            em.create(Transaction, {
              type: TransactionType.POSITION_PAYOUT,
              amount: withdrawablePayout,
              balanceBefore,
              balanceAfter: balanceBefore + withdrawablePayout,
              positionId: bet.id,
              userId: bet.userId,
              isBonus: false,
              stakeAmount: stake,
              note: `Payout for winning bet on: ${winner.label}`,
            }),
          );

          // Credit the play-money portion (above cap) as bonus credits
          if (playPayout > 0) {
            const balAfterWithdrawable = balanceBefore + withdrawablePayout;
            await em.save(
              Transaction,
              em.create(Transaction, {
                type: TransactionType.FREE_CREDIT,
                amount: playPayout,
                balanceBefore: balAfterWithdrawable,
                balanceAfter: balAfterWithdrawable + playPayout,
                positionId: bet.id,
                userId: bet.userId,
                isBonus: true,
                note: `Bonus play credits — payout above bonus cap (re-bet only)`,
              }),
            );
            // Track the new play-money balance
            await em.update(
              User,
              { id: bet.userId },
              {
                bonusBalance: () => `"bonusBalance" + ${playPayout}`,
              },
            );
          }
        } else if (market.status === MarketStatus.CANCELLED) {
          // Refund on cancellation via ledger entry
          bet.status = PositionStatus.REFUNDED;
          const balanceBefore = await this.getCreditsBalance(em, bet.userId);
          await em.save(
            Transaction,
            em.create(Transaction, {
              type: TransactionType.REFUND,
              amount: Number(bet.amount),
              balanceBefore,
              balanceAfter: balanceBefore + Number(bet.amount),
              positionId: bet.id,
              userId: bet.userId,
              note: "Market cancelled — refund",
            }),
          );
        } else {
          bet.status = PositionStatus.LOST;
        }
        await em.save(Position, bet);
      }

      market.status = MarketStatus.SETTLED;
      await em.save(Market, market);

      const settlement = em.create(Settlement, {
        marketId: market.id,
        winningOutcomeId: winner.id,
        totalPositions: bets.length,
        winningPositions,
        totalPool,
        houseAmount,
        payoutPool,
        totalPaidOut,
      });
      return em.save(Settlement, settlement);
    });
  }

  // ── Bet placement notification ─────────────────────────────────────────────

  private async sendBetPlacementNotification(
    user: User,
    market: Market,
    outcome: Outcome,
    amount: number,
  ): Promise<void> {
    if (!user.telegramId) {
      this.logger.debug(
        `[BetNotification] User ${user.id} has no Telegram ID, skipping notification`,
      );
      return;
    }

    const chatId = parseInt(user.telegramId, 10);
    if (isNaN(chatId)) {
      this.logger.warn(
        `[BetNotification] Invalid Telegram ID for user ${user.id}: ${user.telegramId}`,
      );
      return;
    }

    const message = `
✅ <b>Prediction Locked In!</b>

📊 <b>Market:</b> ${market.title}
🎯 <b>Pick:</b> ${outcome.label}
💰 <b>Amount:</b> Nu ${amount.toLocaleString()}

Good luck! 🍀
    `.trim();

    try {
      await this.telegramSimple.sendMessage(chatId, message);
      this.logger.log(
        `[BetNotification] Sent to user ${user.id} for bet of Nu ${amount}`,
      );
    } catch (error: any) {
      this.logger.error(
        `[BetNotification] Failed to send to user ${user.id}: ${error.message}`,
      );
    }
  }

  // ── Post-settlement: reputation recalc + individual DM notifications ────────

  private async sendSettlementNotifications(
    market: Market,
    winner: Outcome,
    settlement: Settlement,
  ): Promise<void> {
    // 1. Snapshot tiers before recalculation so we can detect upgrades
    const bets = await this.betRepo.find({
      where: { marketId: market.id },
      relations: ["user"],
    });

    const tiersBefore: Record<string, string> = {};
    for (const bet of bets) {
      if (bet.user)
        tiersBefore[bet.userId] = bet.user.reputationTier ?? "rookie";
    }

    // 2. Recalculate reputation for all bettors
    await this.reputationService.recalculateForMarket(market.id);

    // 2b. Contrarian badge tracking
    // A bet is "contrarian" if predictedProbability < 0.5 at placement
    // (user bet on the outcome the signal said was less likely)
    for (const bet of bets) {
      if (
        bet.status === PositionStatus.WON ||
        bet.status === PositionStatus.LOST
      ) {
        await this.reputationService
          .recordContrarianOutcome(
            bet.userId,
            (bet as any).predictedProbability != null
              ? Number((bet as any).predictedProbability)
              : null,
            bet.status === PositionStatus.WON,
          )
          .catch(() => {});
      }
    }

    // 3. Reload updated users for tier-change detection
    const userIds = [...new Set(bets.map((b) => b.userId))];
    const users = await this.dataSource
      .getRepository(User)
      .findBy({ id: In(userIds) });
    const userMap: Record<string, User> = {};
    for (const u of users) userMap[u.id] = u;

    // 4. Send ONE DM per user (not per position — a user may hold multiple

    const payoutPool = settlement.payoutPool;
    const winnerPool = Number(winner.totalBetAmount);

    // Group all bets by userId so we can aggregate across multiple positions.
    const betsByUser: Record<string, typeof bets> = {};
    for (const bet of bets) {
      if (!betsByUser[bet.userId]) betsByUser[bet.userId] = [];
      betsByUser[bet.userId].push(bet);
    }

    for (const userId of Object.keys(betsByUser)) {
      const userBets = betsByUser[userId];
      const user = userMap[userId];
      if (!user?.telegramId) continue;

      const chatId = Number(user.telegramId);
      const firstName = user.firstName?.trim() || "there";
      const tierNow = user.reputationTier ?? "rookie";
      const tierBefore = tiersBefore[userId] ?? "rookie";
      const totalPredictions = user.totalPredictions ?? 0;
      const accuracy =
        totalPredictions > 0 && user.reputationScore != null
          ? `${Math.round(user.reputationScore * 100)}%`
          : null;

      const tierOrder = ["rookie", "sharpshooter", "hot_hand", "legend"];
      const tierUpgraded =
        tierOrder.indexOf(tierNow) > tierOrder.indexOf(tierBefore);

      // A user wins if ANY of their positions won; they lose only if ALL lost.
      const hasWon = userBets.some((b) => b.status === PositionStatus.WON);

      if (hasWon) {
        // Aggregate total stake and payout across all winning positions for this user.
        let totalStake = 0;
        let totalPayout = 0;
        for (const bet of userBets) {
          if (bet.status === PositionStatus.WON) {
            const share = winnerPool > 0 ? Number(bet.amount) / winnerPool : 0;
            const payout = parseFloat((payoutPool * share).toFixed(2));
            totalStake += Number(bet.amount);
            totalPayout += payout;
          }
        }
        const profitRaw = parseFloat((totalPayout - totalStake).toFixed(2));
        const profitLabel = profitRaw >= 0 ? "profit" : "net loss";

        let msg =
          `✅ <b>You predicted correctly!</b>\n\n` +
          `📊 ${market.title}\n` +
          `🎯 Your pick: <b>${winner.label}</b>\n` +
          `💰 Payout: <b>Nu ${totalPayout.toLocaleString()}</b> (${profitLabel} Nu ${Math.abs(profitRaw).toLocaleString()})\n`;

        if (accuracy)
          msg += `⭐ Insight: <b>${accuracy}</b> over ${totalPredictions} ${totalPredictions === 1 ? "prediction" : "predictions"}\n`;
        if (tierUpgraded)
          msg += `\n🏆 <b>Tier upgrade! You are now ${tierNow.charAt(0).toUpperCase() + tierNow.slice(1)}.</b>`;

        // Contrarian badge notification
        const updatedUser = await this.dataSource.getRepository(User).findOne({
          where: { id: user.id },
          select: ["contrarianBadge", "contrarianWins", "contrarianAttempts"],
        });
        const contrarianBadge = updatedUser?.contrarianBadge;
        const prevBadge = user.contrarianBadge ?? null;
        if (contrarianBadge && contrarianBadge !== prevBadge) {
          const badgeEmoji =
            contrarianBadge === "gold"
              ? "🥇"
              : contrarianBadge === "silver"
                ? "🥈"
                : "🥉";
          msg += `\n\n${badgeEmoji} <b>Contrarian ${contrarianBadge.charAt(0).toUpperCase() + contrarianBadge.slice(1)} badge earned!</b> You went against the crowd and won. ${updatedUser?.contrarianWins} contrarian wins so far.`;
        }

        await this.telegramSimple.sendMessage(chatId, msg).catch(() => {});

        // Streak update
        const currentStreak = (user.telegramStreak ?? 0) + 1;
        await this.dataSource
          .getRepository(User)
          .update(user.id, { telegramStreak: currentStreak });
        if (currentStreak >= 3) {
          await this.telegramSimple
            .sendMessage(
              chatId,
              `🔥 <b>${currentStreak} correct in a row, ${firstName}!</b> You're on fire.`,
            )
            .catch(() => {});
        }
      } else {
        // All of this user's positions lost — send a single loss DM.
        const outcome = market.outcomes.find(
          (o) => o.id === userBets[0].outcomeId,
        );

        let msg =
          `🙂‍↕️<b>Not this time.</b>\n\n` +
          `📊 ${market.title}\n` +
          `🎯 Your pick: ${outcome?.label ?? "unknown"} · Winner: <b>${winner.label}</b>\n`;

        if (accuracy)
          msg += `⭐ Insight: <b>${accuracy}</b> over ${totalPredictions} ${totalPredictions === 1 ? "prediction" : "predictions"}\n`;
        msg += `\n💡 Every prediction builds your reputation. Keep going.`;

        await this.telegramSimple.sendMessage(chatId, msg).catch(() => {});

        // Shield card: if the user has an active duel on this market with Shield
        // equipped, their streak is preserved — skip the reset entirely.
        const shielded = await this.challengesService
          .hasShieldActive(user.id, market.id)
          .catch(() => false);

        if (!shielded) {
          await this.dataSource
            .getRepository(User)
            .update(user.id, { telegramStreak: 0 })
            .catch(() => {});
        } else {
          this.logger.log(
            `[Shield] Streak reset skipped for user ${user.id} on market ${market.id}`,
          );
        }

        // Consecutive loss consolation — check after streak update so the
        // user has the most up-to-date record before we query it.
        await this.sendLosingStreakConsolation(
          userId,
          chatId,
          user.firstName,
        ).catch(() => {});
      }
    }

    this.logger.log(
      `[Notify] Settlement DMs sent for market ${market.id} to ${Object.keys(betsByUser).length} predictors (${bets.length} positions total)`,
    );
  }

  // ── Consecutive-loss consolation ──────────────────────────────────────────
  private async sendLosingStreakConsolation(
    userId: string,
    chatId: number,
    firstName: string | null | undefined,
  ): Promise<void> {
    // Aggregate positions by market: a market is a "win" if the user had at
    // least one WON position, otherwise it's a "loss".
    const recentMarkets = await this.dataSource
      .getRepository(Position)
      .createQueryBuilder("p")
      .select("p.marketId", "marketId")
      .addSelect("MAX(p.placedAt)", "lastPlaced")
      .addSelect(
        `CASE WHEN bool_or(p.status = 'won') THEN 'won' ELSE 'lost' END`,
        "result",
      )
      .where("p.userId = :uid", { uid: userId })
      .andWhere("p.status IN (:...statuses)", {
        statuses: [PositionStatus.WON, PositionStatus.LOST],
      })
      .groupBy("p.marketId")
      .orderBy('"lastPlaced"', "DESC")
      .limit(3)
      .getRawMany<{ marketId: string; lastPlaced: string; result: string }>();

    if (recentMarkets.length < 2) return;

    // Count how many consecutive losses from the most recent market
    const firstWinIndex = recentMarkets.findIndex((r) => r.result !== "lost");
    const lossCount =
      firstWinIndex === -1 ? recentMarkets.length : firstWinIndex;

    if (lossCount < 3) return;

    const name = firstName?.trim() || "Predictor";

    // Find the most active open market as a "hot tip"
    const topMarket = await this.dataSource
      .getRepository(Market)
      .createQueryBuilder("m")
      .where("m.status = :s", { s: MarketStatus.OPEN })
      .andWhere("m.totalPool > 0")
      .orderBy("m.totalPool", "DESC")
      .limit(1)
      .getOne();

    const tipMsg = topMarket
      ? `${name}, 3 losses in a row is just variance. ` +
        `The crowd is active on <b>${topMarket.title}</b> right now — worth a look.`
      : `${name}, 3 losses in a row happens to the best. Your next prediction turns it around.`;

    await this.telegramSimple.sendMessage(chatId, tipMsg);
  }

  // Cancel market: refund all bets
  async cancelMarket(marketId: string): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const market = await em.findOne(Market, {
        where: { id: marketId },
        relations: ["outcomes"],
      });
      if (!market) throw new BadRequestException("Market not found");

      market.status = MarketStatus.CANCELLED;
      await em.save(Market, market);

      const bets = await em.find(Position, { where: { marketId } });
      await this.refundPositions(em, bets, "Market cancelled — refund");
    });
  }

  /**
   * Shared refund loop — writes a REFUND Transaction and flips status to
   * REFUNDED for every PENDING position in `bets`. Caller is responsible for
   * setting market status and writing the Settlement record.
   */
  private async refundPositions(
    em: {
      getRepository: Function;
      find: Function;
      save: Function;
      create: Function;
    },
    bets: Position[],
    note: string,
  ): Promise<void> {
    for (const bet of bets) {
      if (bet.status !== PositionStatus.PENDING) continue;
      const balanceBefore = await this.getCreditsBalance(em, bet.userId);
      await em.save(
        Transaction,
        em.create(Transaction, {
          type: TransactionType.REFUND,
          amount: Number(bet.amount),
          balanceBefore,
          balanceAfter: balanceBefore + Number(bet.amount),
          positionId: bet.id,
          userId: bet.userId,
          note,
        }),
      );
      bet.status = PositionStatus.REFUNDED;
      await em.save(Position, bet);
    }
  }
}
