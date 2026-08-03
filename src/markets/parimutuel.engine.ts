import {
  Injectable,
  BadRequestException,
  Logger,
  OnModuleInit,
} from "@nestjs/common";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { Repository, DataSource, In, EntityManager } from "typeorm";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { RedisService } from "../redis/redis.service";
import { Market, MarketStatus } from "../entities/market.entity";
import { Outcome } from "../entities/outcome.entity";
import { Position, PositionStatus } from "../entities/position.entity";
import { Payment } from "../entities/payment.entity";
import { Transaction, TransactionType } from "../entities/transaction.entity";
import { Settlement } from "../entities/settlement.entity";
import {
  Dispute,
  DisputeBondStatus,
  DisputeSide,
} from "../entities/dispute.entity";
import { User } from "../entities/user.entity";
import { LMSRService } from "./lmsr.service";
import { DEFAULT_HOUSE_EDGE_PCT } from "./fee.constants";
import { ReputationService } from "./reputation.service";
import { MarketsGateway } from "./markets.gateway";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";
import { DKGatewayService } from "../payment/services/dk-gateway/dk-gateway.service";
import { StreakService, STREAK_BONUS_MULT } from "../users/streak.service";
import { ChallengesService } from "../challenges/challenges.service";
import { SseService } from "../sse/sse.service";
import { RevenueDistributionService } from "./revenue-distribution.service";
import {
  NOTIFICATION_QUEUE,
  JobName,
  SettlementNotifyJobData,
} from "../jobs/notification.queue";

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
    @InjectQueue(NOTIFICATION_QUEUE) private notificationQueue: Queue,
  ) {}

  private async getCreditsBalance(
    em: EntityManager,
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
    let capturedHouseEdgePct = DEFAULT_HOUSE_EDGE_PCT; // default; overwritten inside transaction

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

        if (outcome.isEliminated)
          throw new BadRequestException(
            `No longer accepting bets on "${outcome.label}" — this outcome has been eliminated.`,
          );

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

        // Store user reference for notification
        betUser = user;
        betUserTelegramId = user.telegramId;
        betMarket = market;
        betOutcome = outcome;
        capturedHouseEdgePct = Number(market.houseEdgePct) || DEFAULT_HOUSE_EDGE_PCT;

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
        // A prediction is only bonus-funded if the user's real (non-bonus) balance
        // cannot cover the bet on its own. realBalance is clamped to 0 to handle
        // stale/overcounted bonusBalance values that exceed the ledger balance.
        const realBalance = Math.max(0, balanceBefore - userBonusBalanceAtBet);
        const isBonusFunded =
          userBonusBalanceAtBet > 0 &&
          amount <= userBonusBalanceAtBet &&
          realBalance < amount;
        const bet = em.create(Position, {
          userId,
          marketId,
          outcomeId,
          amount,
          status: PositionStatus.PENDING,
          oddsAtPlacement: outcome.currentOdds,
          predictedProbability,
          poolPctAtBet,
          isBonusFunded,
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
            isBonus: savedPosition.isBonusFunded ?? false,
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

      // If the day-7 boost is active, ARM this bet. The +20% bonus is NOT paid
      // now — it's credited at settlement only if this bet WINS (see settleMarket),
      // as 20% of the actual payout. This matches the user-facing promise that
      // "your next winning payout gets a 1.2× boost".
      if (streakResult?.boostActive && completedPosition) {
        await this.betRepo
          .update(completedPosition.id, { streakBoostArmed: true })
          .catch((err: any) =>
            this.logger.error(`Arming streak boost failed: ${err.message}`),
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

  async reopenMarket(marketId: string, newClosesAt: Date): Promise<Market> {
    const market = await this.marketRepo.findOneBy({ id: marketId });
    if (!market) throw new BadRequestException("Market not found");

    if (!market.subcategory?.startsWith("wc-")) {
      throw new BadRequestException(
        "Only World Cup hub markets can be reopened",
      );
    }
    if (market.status !== MarketStatus.CLOSED) {
      throw new BadRequestException(
        `Only a Closed market can be reopened (current status: ${market.status})`,
      );
    }
    if (market.proposedOutcomeId) {
      throw new BadRequestException(
        "Cannot reopen a market that already has a proposed resolution",
      );
    }
    if (!(newClosesAt instanceof Date) || isNaN(newClosesAt.getTime())) {
      throw new BadRequestException("closesAt must be a valid date");
    }
    if (newClosesAt.getTime() <= Date.now()) {
      throw new BadRequestException(
        "closesAt must be in the future, otherwise the keeper will immediately re-close the market",
      );
    }

    market.status = MarketStatus.OPEN;
    market.closesAt = newClosesAt;
    // Clear any stale proposal/dispute-window state
    market.proposedOutcomeId = null as unknown as string;
    market.disputeDeadlineAt = null as unknown as Date;

    const saved = await this.marketRepo.save(market);
    this.logger.log(
      `Market ${marketId} ("${market.title}") reopened until ${newClosesAt.toISOString()}`,
    );
    return saved;
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

    // Normal path: the market is RESOLVING. Recovery path: an earlier resolution
    // atomically claimed RESOLVING → RESOLVED but then failed before a Settlement
    // row was written, leaving the market stuck (RESOLVED can only transition to
    // SETTLED, so the normal call could never retry it). Allow re-entry when the
    // market is RESOLVED-but-unsettled so this same call can finish the job. The
    // downstream work (dispute payouts + settleMarket) is idempotent, so a retry
    // never double-pays.
    let isRecovery = false;
    if (market.status !== MarketStatus.RESOLVING) {
      const existingSettlement =
        market.status === MarketStatus.RESOLVED
          ? await this.settlementRepo.findOne({ where: { marketId } })
          : null;
      isRecovery =
        market.status === MarketStatus.RESOLVED && !existingSettlement;
      if (!isRecovery) {
        throw new BadRequestException(
          market.status === MarketStatus.RESOLVED
            ? "Market is already resolved and settled"
            : "Market must be in Resolving state before final resolution",
        );
      }
      // On recovery the winner was already fixed by the earlier claim — a retry
      // must settle the SAME outcome, never silently switch it.
      if (market.resolvedOutcomeId !== winningOutcomeId) {
        throw new BadRequestException(
          "Market was already resolved to a different outcome; cannot change it during recovery",
        );
      }
    }

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

    // On recovery the window was already satisfied by the original resolution;
    // re-enforcing it would wrongly block the retry.
    if (windowStillOpen && !isRecovery) {
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
    //
    // Skipped on recovery: the market is already RESOLVED (the earlier pass
    // claimed it), so this conditional UPDATE would match zero rows and wrongly
    // abort the retry. Concurrency during recovery is instead guarded by the
    // idempotent, row-locked dispute payouts and settleMarket's own guard.
    if (!isRecovery) {
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

    // ── Settle the two-sided resolution contest ───────────────────────────────
    // OBJECT participants win iff the admin changed the proposal; SUPPORT
    // (defenders) win iff the proposal was kept. The winning side gets each
    // bond back plus a pro-rata (here: equal, since all bonds match) share of
    // the losing side's forfeited bonds. Any forfeited money with no winning
    // side — objectors lost and nobody defended — plus floor-rounding dust is
    // booked as house revenue via settleMarket()'s houseForfeit, so it flows
    // through the normal revenue-distribution mechanism instead of leaking.
    const disputes = await this.disputeRepo.find({ where: { marketId } });
    let unclaimedForfeit = 0;
    if (disputes.length > 0) {
      const proposalChanged =
        !!market.proposedOutcomeId &&
        winningOutcomeId !== market.proposedOutcomeId;

      // The side that was right about the resolution wins the contest.
      const winningSide = proposalChanged
        ? DisputeSide.OBJECT
        : DisputeSide.SUPPORT;
      const winners = disputes.filter((d) => d.side === winningSide);
      const losers = disputes.filter((d) => d.side !== winningSide);

      // Forfeited pool = sum of the losing side's bonds.
      const forfeitPool = losers.reduce((s, d) => s + Number(d.bondAmount), 0);
      const winnerTotalBond = winners.reduce(
        (s, d) => s + Number(d.bondAmount),
        0,
      );

      // Persist the forfeit pool onto the market record for audit trail
      market.disputeBondPool = forfeitPool;
      await this.marketRepo.save(market);

      // Pay the winning side: bond back + share of the forfeit pool.
      //
      // `distributedReward` accumulates every winner's (deterministic) share so
      // the house-forfeit remainder is correct on both a first pass and a retry.
      // The actual PAYMENT is idempotent: each winner's reward transaction and
      // its REWARDED status are written together inside a row-locked transaction,
      // and a winner already marked REWARDED (by an earlier, possibly failed,
      // pass) is skipped — so re-running resolveMarket never double-pays a bond.
      let distributedReward = 0;
      for (const d of winners) {
        const rewardShare =
          winnerTotalBond > 0
            ? Math.floor((Number(d.bondAmount) / winnerTotalBond) * forfeitPool)
            : 0;
        distributedReward += rewardShare;
        const totalReturn = Number(d.bondAmount) + rewardShare;

        // Already paid on a previous pass — count the share (above) but don't
        // pay again.
        if (d.bondStatus !== DisputeBondStatus.LOCKED) continue;

        await this.dataSource.transaction(async (em) => {
          // Re-read the dispute under a write lock and re-check LOCKED so two
          // concurrent resolvers can't both pay the same bond.
          const locked = await em
            .getRepository(Dispute)
            .createQueryBuilder("d")
            .setLock("pessimistic_write")
            .where("d.id = :id", { id: d.id })
            .getOne();
          if (!locked || locked.bondStatus !== DisputeBondStatus.LOCKED) return;

          const { balance: rawBal } = await em
            .getRepository(Transaction)
            .createQueryBuilder("t")
            .select("COALESCE(SUM(t.amount), 0)", "balance")
            .where("t.userId = :userId", { userId: d.userId })
            .getRawOne();
          const balBefore = Number(rawBal);

          await em.save(
            Transaction,
            em.create(Transaction, {
              userId: d.userId,
              type: TransactionType.DISPUTE_BOND_REWARD,
              amount: totalReturn,
              balanceBefore: balBefore,
              balanceAfter: balBefore + totalReturn,
              note:
                `Resolution ${d.side === DisputeSide.OBJECT ? "objection" : "defence"} ` +
                `WON on "${market.title}" — bond returned + Nu ${rewardShare} from the losing side`,
            }),
          );
          locked.upheld = true;
          locked.bondStatus = DisputeBondStatus.REWARDED;
          await em.save(Dispute, locked);
          // Mirror onto the in-memory copy for the bulk save + logging below.
          d.upheld = true;
          d.bondStatus = DisputeBondStatus.REWARDED;
        });

        this.logger.log(
          `[Bond] User ${d.userId} (${d.side}) WON — returned Nu ${d.bondAmount} + reward Nu ${rewardShare}`,
        );
      }

      // The losing side forfeits — bond was already deducted at lock time.
      for (const d of losers) {
        d.upheld = false;
        d.bondStatus = DisputeBondStatus.FORFEITED;
        this.logger.log(
          `[Bond] User ${d.userId} (${d.side}) LOST — bond Nu ${d.bondAmount} forfeited`,
        );
      }

      // Whatever wasn't paid to a winning side (no winners, or floor-rounding
      // dust) is booked as house revenue instead of disappearing.
      unclaimedForfeit = parseFloat(
        (forfeitPool - distributedReward).toFixed(2),
      );

      await this.disputeRepo.save(disputes);

      this.logger.log(
        `[Dispute] Market ${marketId} resolved with ${disputes.length} contest entr${
          disputes.length === 1 ? "y" : "ies"
        }. ` +
          `Admin ${adminId ?? "unknown"} chose outcome ${winningOutcomeId} ` +
          `(proposal ${market.proposedOutcomeId}, changed: ${proposalChanged}). ` +
          `Winners: ${winners.length}, losers: ${losers.length}, ` +
          `forfeit pool: Nu ${forfeitPool}, booked to house revenue: Nu ${unclaimedForfeit}.`,
      );

      // ── Admin accountability: track & publicise wrong resolutions ───────────
      // Skipped on recovery so a retry never double-counts the admin's stats.
      if (
        proposalChanged &&
        adminId &&
        adminId !== "system:auto-resolve" &&
        !isRecovery
      ) {
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
        adminId !== "system:auto-resolve" &&
        !isRecovery
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
    // If no disputes existed but a real admin resolved (not system), count the
    // clean resolution. Skipped on recovery so a retry never double-counts.
    if (
      disputes.length === 0 &&
      adminId &&
      adminId !== "system:auto-resolve" &&
      !isRecovery
    ) {
      try {
        await this.dataSource
          .getRepository(User)
          .increment({ id: adminId }, "adminTotalResolutions", 1);
      } catch (_) {
        // non-critical
      }
    }

    const settlement = await this.settleMarket(market, winner, unclaimedForfeit);

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

    // Bust balance cache for every predictor so the TMA reflects payouts immediately.
    // Use a Redis pipeline so all DEL commands are sent in ONE round-trip
    // instead of firing 100k individual calls which would saturate the connection.
    const allBets = await this.betRepo.find({ where: { marketId } });
    const uniqueUserIds = [...new Set(allBets.map((b) => b.userId))];
    if (uniqueUserIds.length > 0) {
      const pipe = this.redis.pipeline();
      for (const uid of uniqueUserIds) {
        pipe.del(`oro:cache:balance:${uid}`);
      }
      await pipe.exec();
    }

    // Push real-time SSE events in a non-blocking setImmediate loop so the
    // settlement response is returned to the caller immediately instead of
    // waiting for all 100k emit() calls to finish synchronously.
    setImmediate(() => {
      for (const uid of uniqueUserIds) {
        this.sse.emit(uid, "balance:updated", { marketId });
      }
    });

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
    // Forfeited dispute bonds with no winning side to reward. Booked as house
    // revenue so they flow through the normal revenue-distribution mechanism
    // (recordDistribution) instead of being kept off-ledger.
    houseForfeit = 0,
  ): Promise<Settlement> {
    return await this.dataSource.transaction(async (em) => {
      // ── Idempotency guard — prevent double settlement ─────────────────────────
      // If a Settlement record already exists for this market, return it immediately.
      // This protects against: admin retry after a partial failure, scheduler ticks
      // overlapping with a manual resolve, or any other double-call scenario.
      const existing = await em.findOne(Settlement, {
        where: { marketId: market.id },
      });
      if (existing) {
        this.logger.warn(
          `[Settlement] Market ${market.id} already has a settlement record — skipping duplicate settle`,
        );
        return existing;
      }

      const totalPool = Number(market.totalPool);
      // Configured edge; the amount actually booked can be lower when the payout
      // floor has to be subsidised (see the funding guard and bookedHouseAmount).
      const houseAmount = totalPool * (Number(market.houseEdgePct) / 100);
      const payoutPool = totalPool - houseAmount;

      const winnerPool = Number(winner.totalBetAmount);
      // Only settle PENDING positions — never re-process already-settled bets.
      // This is the second line of defence against double payouts (the first is
      // the idempotency guard above; the third is the RESOLVING→RESOLVED atomic claim).
      const bets = await em.find(Position, {
        where: { marketId: market.id, status: PositionStatus.PENDING },
      });

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

        // Load all unique bettors in chunked queries to avoid PG 65,535-param limit
        const uniqueBetUserIds = [...new Set(bets.map((b) => b.userId))];
        const THIN_USER_CHUNK = 1000;
        const thinPoolUsersArr: User[] = [];
        for (let i = 0; i < uniqueBetUserIds.length; i += THIN_USER_CHUNK) {
          const chunk = uniqueBetUserIds.slice(i, i + THIN_USER_CHUNK);
          const rows = await em.find(User, {
            where: { id: In(chunk) },
            select: ["id", "telegramId"],
          });
          thinPoolUsersArr.push(...rows);
        }
        const thinPoolUserMap = new Map(thinPoolUsersArr.map((u) => [u.id, u]));
        // Sum up refund amount per user (they may have multiple bets)
        const refundByUser = new Map<string, number>();
        for (const bet of bets) {
          refundByUser.set(
            bet.userId,
            (refundByUser.get(bet.userId) ?? 0) + Number(bet.amount),
          );
        }
        for (const [uid, totalRefund] of refundByUser.entries()) {
          const user = thinPoolUserMap.get(uid);
          if (user?.telegramId) {
            this.telegramSimple
              .sendRefundNotification(
                Number(user.telegramId),
                market.title,
                totalRefund,
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
          // Bets are refunded, but any forfeited dispute bonds are still booked
          // as revenue for the audit trail.
          houseAmount: houseForfeit,
          payoutPool: 0,
          totalPaidOut: 0,
          cancelReason: "thin_pool",
        });
        return em.save(Settlement, settlement);
      }
      // ── End thin-pool guard ───────────────────────────────────────────────────

      // ── BULK settlement — O(bets) queries replaced with O(1) queries ─────────
      //
      // OLD approach: for each of N bets → 4 individual SQL calls = 4N queries.
      // For 100k bets that was ~400k queries inside one transaction → timeout.
      //
      // NEW approach:
      //   1. Load ALL users with bonus fields in ONE query (IN clause).
      //   2. Load ALL current balances in ONE aggregated query (GROUP BY userId).
      //   3. Compute every payout in memory.
      //   4. Bulk INSERT all Transaction rows in one statement.
      //   5. Bulk UPDATE Position statuses in one statement.
      //   6. Bulk UPDATE bonus fields per affected user in batches.
      // Total: ~6 queries regardless of bet count.

      const betUserIds = [...new Set(bets.map((b) => b.userId))];
      const USER_CHUNK = 1000;

      // 1. Load all users involved in this market — chunked to avoid PG 65,535-param limit
      const usersArr: User[] = [];
      for (let i = 0; i < betUserIds.length; i += USER_CHUNK) {
        const chunk = betUserIds.slice(i, i + USER_CHUNK);
        const rows = await em.find(User, {
          where: { id: In(chunk) },
          select: ["id", "bonusBalance", "bonusRealPayoutRemaining"],
        });
        usersArr.push(...rows);
      }
      const userMap = new Map(usersArr.map((u) => [u.id, u]));

      // 2. Load current ledger balance for every involved user — chunked
      const balanceMap = new Map<string, number>();
      for (let i = 0; i < betUserIds.length; i += USER_CHUNK) {
        const chunk = betUserIds.slice(i, i + USER_CHUNK);
        const rows: { userId: string; balance: string }[] = await em
          .getRepository(Transaction)
          .createQueryBuilder("t")
          .select("t.userId", "userId")
          .addSelect("COALESCE(SUM(t.amount), 0)", "balance")
          .where("t.userId IN (:...ids)", { ids: chunk })
          .groupBy("t.userId")
          .getRawMany();
        for (const r of rows) {
          balanceMap.set(r.userId, Number(r.balance));
        }
      }

      // ── Payout-floor funding guard ───────────────────────────────────────────
      // Winners are guaranteed max(parimutuel share, 1.05× stake). That floor can
      // total more than the parimutuel pool (`payoutPool`), which would create an
      // unfunded payout if we still booked the full house edge. So:
      //   1. Fund the overflow by giving up house edge, down to zero.
      //   2. If even a 0% edge can't cover the floor (winning side > ~95% of the
      //      pool), scale every winner's payout down pro-rata so the total never
      //      exceeds the money actually in the pool.
      // maxBudget is all the money available to winners if the edge is fully
      // waived: the pool plus any dispute-bond bonus (= payoutPool + houseAmount).
      const maxBudget = payoutPool + houseAmount;
      let desiredWinnerTotal = 0;
      for (const bet of bets) {
        if (bet.outcomeId !== winner.id) continue;
        const share = winnerPool > 0 ? Number(bet.amount) / winnerPool : 0;
        const raw = parseFloat((payoutPool * share).toFixed(2));
        const floor = parseFloat((Number(bet.amount) * 1.05).toFixed(2));
        desiredWinnerTotal += Math.max(raw, floor);
      }
      const floorOverflow = Math.max(0, desiredWinnerTotal - payoutPool);
      const houseSubsidy = Math.min(houseAmount, floorOverflow);
      // Only scale down when the floor can't be funded even with a zero edge.
      const payoutScale =
        desiredWinnerTotal > maxBudget ? maxBudget / desiredWinnerTotal : 1;

      let totalPaidOut = 0;
      let winningPositions = 0;

      // Accumulators for bulk writes
      const txToInsert: Partial<Transaction>[] = [];
      // Track per-user running balance delta so each tx's balanceBefore/After is correct
      const balanceDelta = new Map<string, number>();
      const getBalance = (uid: string) =>
        (balanceMap.get(uid) ?? 0) + (balanceDelta.get(uid) ?? 0);

      // Bonus field updates: accumulate per user, apply in one bulk UPDATE per user
      const bonusUpdates = new Map<
        string,
        { bonusBalance: number; bonusRealPayoutRemaining: number }
      >();

      for (const bet of bets) {
        if (bet.outcomeId === winner.id) {
          const share = winnerPool > 0 ? Number(bet.amount) / winnerPool : 0;
          const rawPayout = parseFloat((payoutPool * share).toFixed(2));
          const stake = Number(bet.amount);
          // Guaranteed floor, scaled down only in the extreme case where even a
          // waived house edge can't fund it (payoutScale < 1).
          const effectivePayout = parseFloat(
            (Math.max(rawPayout, stake * 1.05) * payoutScale).toFixed(2),
          );

          const user = userMap.get(bet.userId);
          const userBonusBalance = Number(user?.bonusBalance ?? 0);
          const bonusRealPayoutRemaining = Number(
            user?.bonusRealPayoutRemaining ?? 0,
          );
          const betIsBonusFunded = bet.isBonusFunded ?? false;

          let withdrawablePayout = effectivePayout;
          if (betIsBonusFunded) {
            // Use the accumulating remaining for this user (handles multiple bonus bets)
            const currentRemaining =
              bonusUpdates.get(bet.userId)?.bonusRealPayoutRemaining ??
              bonusRealPayoutRemaining;
            withdrawablePayout = parseFloat(
              Math.min(effectivePayout, currentRemaining).toFixed(2),
            );
            if (withdrawablePayout === 0) {
              withdrawablePayout = stake;
              this.logger.warn(
                `[Settlement] bonusRealPayoutRemaining=0 for user ${bet.userId} on bet ${bet.id} — flooring payout to stake ${stake}`,
              );
            }
            const prevBonus =
              bonusUpdates.get(bet.userId)?.bonusBalance ?? userBonusBalance;
            bonusUpdates.set(bet.userId, {
              bonusBalance: Math.max(0, prevBonus - stake),
              bonusRealPayoutRemaining: Math.max(
                0,
                currentRemaining - withdrawablePayout,
              ),
            });
          }

          bet.payout = withdrawablePayout;
          bet.status = PositionStatus.WON;
          totalPaidOut += withdrawablePayout;
          winningPositions++;

          const balanceBefore = getBalance(bet.userId);
          balanceDelta.set(
            bet.userId,
            (balanceDelta.get(bet.userId) ?? 0) + withdrawablePayout,
          );
          txToInsert.push({
            type: TransactionType.POSITION_PAYOUT,
            amount: withdrawablePayout,
            balanceBefore,
            balanceAfter: balanceBefore + withdrawablePayout,
            positionId: bet.id,
            userId: bet.userId,
            isBonus: false,
            stakeAmount: stake,
            note: `Payout for winning prediction on: ${winner.label}`,
          });

          // ── Day-7 streak boost ──────────────────────────────────────────────
          // If this bet armed the boost at placement AND it won, credit an extra
          // 20% of the actual payout as a separate streak-bonus transaction.
          if (bet.streakBoostArmed) {
            const boostBonus = parseFloat(
              (withdrawablePayout * (STREAK_BONUS_MULT - 1)).toFixed(2),
            );
            if (boostBonus > 0) {
              const boostBefore = getBalance(bet.userId);
              balanceDelta.set(
                bet.userId,
                (balanceDelta.get(bet.userId) ?? 0) + boostBonus,
              );
              // NB: deliberately NOT added to `totalPaidOut` — that figure tracks
              // pool distribution (drives Settlement.totalPaidOut / breakage). The
              // streak boost is platform-funded extra, tracked via its own
              // STREAK_BONUS ledger row instead.
              txToInsert.push({
                type: TransactionType.STREAK_BONUS,
                amount: boostBonus,
                balanceBefore: boostBefore,
                balanceAfter: boostBefore + boostBonus,
                positionId: bet.id,
                userId: bet.userId,
                isBonus: false,
                // Keep the key set identical to the payout row above so the bulk
                // INSERT's column list is uniform regardless of chunk ordering.
                stakeAmount: null,
                note: `🔥 Day-7 streak bonus (+${Math.round(
                  (STREAK_BONUS_MULT - 1) * 100,
                )}% of payout)`,
              });
            }
          }
        } else {
          bet.status = PositionStatus.LOST;
          if (bet.isBonusFunded) {
            const user = userMap.get(bet.userId);
            const currentBonusBalance =
              bonusUpdates.get(bet.userId)?.bonusBalance ??
              Number(user?.bonusBalance ?? 0);
            if (currentBonusBalance > 0) {
              const prev = bonusUpdates.get(bet.userId);
              bonusUpdates.set(bet.userId, {
                bonusBalance: Math.max(
                  0,
                  currentBonusBalance - Number(bet.amount),
                ),
                bonusRealPayoutRemaining:
                  prev?.bonusRealPayoutRemaining ??
                  Number(user?.bonusRealPayoutRemaining ?? 0),
              });
            }
          }
        }
      }

      // 3. Bulk INSERT all transaction rows — chunked at 500 rows per statement
      // to stay well within PostgreSQL's parameter and memory limits.
      const TX_CHUNK = 500;
      for (let i = 0; i < txToInsert.length; i += TX_CHUNK) {
        const chunk = txToInsert.slice(i, i + TX_CHUNK);
        await em
          .createQueryBuilder()
          .insert()
          .into(Transaction)
          .values(chunk)
          .execute();
      }

      // 4. Bulk UPDATE position statuses + payouts
      // Process in chunks of 1000 to avoid:
      //   a) PostgreSQL's 65,535-parameter limit on IN (:...ids)
      //   b) Multi-MB CASE WHEN query strings for large winner sets
      const CHUNK_SIZE = 1000;

      const wonBets = bets.filter((b) => b.status === PositionStatus.WON);
      const lostIds = bets
        .filter((b) => b.status === PositionStatus.LOST)
        .map((b) => b.id);
      const refundedIds = bets
        .filter((b) => b.status === PositionStatus.REFUNDED)
        .map((b) => b.id);

      // WON: use UPDATE ... FROM (VALUES ...) AS v(id, payout) for safe bulk payout update
      for (let i = 0; i < wonBets.length; i += CHUNK_SIZE) {
        const chunk = wonBets.slice(i, i + CHUNK_SIZE);
        const wonIds = chunk.map((b) => b.id);
        const caseClause = chunk
          .map((b) => `WHEN id = '${b.id}' THEN ${Number(b.payout)}`)
          .join(" ");
        await em
          .createQueryBuilder()
          .update(Position)
          .set({
            status: PositionStatus.WON,
            payout: () => `CASE ${caseClause} END`,
          })
          .where("id IN (:...ids)", { ids: wonIds })
          .execute();
      }

      // LOST: chunk to stay under the 65,535 PG parameter limit
      for (let i = 0; i < lostIds.length; i += CHUNK_SIZE) {
        const chunk = lostIds.slice(i, i + CHUNK_SIZE);
        await em
          .createQueryBuilder()
          .update(Position)
          .set({ status: PositionStatus.LOST })
          .where("id IN (:...ids)", { ids: chunk })
          .execute();
      }

      // REFUNDED: same chunking
      for (let i = 0; i < refundedIds.length; i += CHUNK_SIZE) {
        const chunk = refundedIds.slice(i, i + CHUNK_SIZE);
        await em
          .createQueryBuilder()
          .update(Position)
          .set({ status: PositionStatus.REFUNDED })
          .where("id IN (:...ids)", { ids: chunk })
          .execute();
      }

      // 5. Apply bonus field updates — one UPDATE per affected user
      for (const [uid, fields] of bonusUpdates.entries()) {
        await em.update(User, { id: uid }, fields);
      }

      market.status = MarketStatus.SETTLED;
      await em.save(Market, market);

      // Book the house edge actually kept after subsidising the payout floor,
      // plus any forfeited dispute bonds routed to revenue.
      const bookedHouseAmount = parseFloat(
        (houseAmount - houseSubsidy + houseForfeit).toFixed(2),
      );

      const settlement = em.create(Settlement, {
        marketId: market.id,
        winningOutcomeId: winner.id,
        totalPositions: bets.length,
        winningPositions,
        totalPool,
        houseAmount: bookedHouseAmount,
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
  //
  // IMPORTANT: This method is intentionally NOT awaited by the caller.
  // All work here is background / fire-and-forget so the settlement response
  // is returned to the admin panel immediately.
  //
  // Telegram DMs are now enqueued to BullMQ (NOTIFICATION_QUEUE) with a
  // 25-msg/sec limiter on the processor, so 100k DMs drain safely over
  // ~66 minutes without ever hitting Telegram's rate limit or blocking Node.js.
  //
  // Reputation recalc is also deferred here (called after DMs are queued)
  // so it doesn't block the event loop.

  private async sendSettlementNotifications(
    market: Market,
    winner: Outcome,
    settlement: Settlement,
  ): Promise<void> {
    // 1. Load all bets + user relation for tier snapshot
    const bets = await this.betRepo.find({
      where: { marketId: market.id },
      relations: ["user"],
    });

    const tiersBefore: Record<string, string> = {};
    for (const bet of bets) {
      if (bet.user)
        tiersBefore[bet.userId] = bet.user.reputationTier ?? "rookie";
    }

    // 2. Recalculate reputation for all bettors (deferred off the hot path,
    //    but still awaited here since this whole method is already fire-and-forget)
    await this.reputationService.recalculateForMarket(market.id);

    // 2b. Contrarian badge tracking
    for (const bet of bets) {
      if (
        bet.status === PositionStatus.WON ||
        bet.status === PositionStatus.LOST
      ) {
        await this.reputationService
          .recordContrarianOutcome(
            bet.userId,
            bet.predictedProbability != null
              ? Number(bet.predictedProbability)
              : null,
            bet.status === PositionStatus.WON,
          )
          .catch(() => {});
      }
    }

    // 3. Reload updated users
    const userIds = [...new Set(bets.map((b) => b.userId))];
    const users = await this.dataSource
      .getRepository(User)
      .findBy({ id: In(userIds) });
    const userMap: Record<string, User> = {};
    for (const u of users) userMap[u.id] = u;

    const payoutPool = Number(settlement.payoutPool);
    const winnerPool = Number(winner.totalBetAmount);

    const betsByUser: Record<string, typeof bets> = {};
    for (const bet of bets) {
      if (!betsByUser[bet.userId]) betsByUser[bet.userId] = [];
      betsByUser[bet.userId].push(bet);
    }

    // 4. Build messages and enqueue — one BullMQ job per user.
    //    The NotificationProcessor runs them at ≤25/sec so Telegram is never flooded.
    const dmJobs: { name: string; data: SettlementNotifyJobData }[] = [];

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

      const hasWon = userBets.some((b) => b.status === PositionStatus.WON);

      if (hasWon) {
        let totalStake = 0;
        let totalPayout = 0;
        for (const bet of userBets) {
          if (bet.status === PositionStatus.WON) {
            // Use the actual stored payout — NOT a recalculation.
            // The stored value reflects the minimum-payout floor (stake × 1.05)
            // and any bonus-cap adjustments applied during settlement.
            totalStake += Number(bet.amount);
            totalPayout += Number(bet.payout ?? 0);
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

        // Contrarian badge
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

        dmJobs.push({
          name: JobName.SETTLEMENT_NOTIFY,
          data: { telegramChatId: chatId, message: msg },
        });

        // Streak update (DB write — keep here, not a Telegram call)
        const currentStreak = (user.telegramStreak ?? 0) + 1;
        await this.dataSource
          .getRepository(User)
          .update(user.id, { telegramStreak: currentStreak })
          .catch(() => {});
        if (currentStreak >= 3) {
          dmJobs.push({
            name: JobName.SETTLEMENT_NOTIFY,
            data: {
              telegramChatId: chatId,
              message: `🔥 <b>${currentStreak} correct in a row, ${firstName}!</b> You're on fire.`,
            },
          });
        }
      } else {
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

        dmJobs.push({
          name: JobName.SETTLEMENT_NOTIFY,
          data: { telegramChatId: chatId, message: msg },
        });

        // Shield card check
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

        // Consecutive loss consolation DM (also queued)
        await this.enqueueLosingStreakConsolation(
          userId,
          chatId,
          user.firstName,
          dmJobs,
        ).catch(() => {});
      }
    }

    // Bulk-enqueue all DMs in one BullMQ addBulk call — one round-trip to Redis
    if (dmJobs.length > 0) {
      await this.notificationQueue
        .addBulk(dmJobs)
        .catch((err: Error) =>
          this.logger.warn(
            `[Notify] Failed to enqueue settlement DMs: ${err.message}`,
          ),
        );
    }

    this.logger.log(
      `[Notify] Queued ${dmJobs.length} settlement DMs for market ${market.id} ` +
        `(${Object.keys(betsByUser).length} predictors, ${bets.length} positions)`,
    );
  }

  // ── Consecutive-loss consolation ──────────────────────────────────────────
  private async enqueueLosingStreakConsolation(
    userId: string,
    chatId: number,
    firstName: string | null | undefined,
    dmJobs: { name: string; data: SettlementNotifyJobData }[],
  ): Promise<void> {
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

    dmJobs.push({
      name: JobName.SETTLEMENT_NOTIFY,
      data: { telegramChatId: chatId, message: tipMsg },
    });
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
   *
   * Uses a single bulk balance pre-load + bulk INSERT so it scales to large
   * markets without issuing one query per bet.
   */
  private async refundPositions(
    em: EntityManager,
    bets: Position[],
    note: string,
  ): Promise<void> {
    const pendingBets = bets.filter((b) => b.status === PositionStatus.PENDING);
    if (pendingBets.length === 0) return;

    const userIds = [...new Set(pendingBets.map((b) => b.userId))];

    // Load all balances in chunked aggregation queries (avoid PG 65535 param limit)
    const REFUND_USER_CHUNK = 1000;
    const balanceMap = new Map<string, number>();
    for (let i = 0; i < userIds.length; i += REFUND_USER_CHUNK) {
      const chunk = userIds.slice(i, i + REFUND_USER_CHUNK);
      const rows: { userId: string; balance: string }[] = await em
        .getRepository(Transaction)
        .createQueryBuilder("t")
        .select("t.userId", "userId")
        .addSelect("COALESCE(SUM(t.amount), 0)", "balance")
        .where("t.userId IN (:...ids)", { ids: chunk })
        .groupBy("t.userId")
        .getRawMany();
      for (const r of rows) balanceMap.set(r.userId, Number(r.balance));
    }
    const balanceDelta = new Map<string, number>();
    const getBalance = (uid: string): number =>
      (balanceMap.get(uid) ?? 0) + (balanceDelta.get(uid) ?? 0);

    const txToInsert: Partial<Transaction>[] = [];

    for (const bet of pendingBets) {
      const refundAmt = Number(bet.amount);
      const balanceBefore = getBalance(bet.userId);
      balanceDelta.set(
        bet.userId,
        (balanceDelta.get(bet.userId) ?? 0) + refundAmt,
      );
      txToInsert.push({
        type: TransactionType.REFUND,
        amount: refundAmt,
        balanceBefore,
        balanceAfter: balanceBefore + refundAmt,
        positionId: bet.id,
        userId: bet.userId,
        isBonus: bet.isBonusFunded ?? false,
        note,
      });
      bet.status = PositionStatus.REFUNDED;
    }

    // Bulk INSERT all refund transactions — chunked at 500 rows per statement
    const TX_CHUNK = 500;
    for (let i = 0; i < txToInsert.length; i += TX_CHUNK) {
      const chunk = txToInsert.slice(i, i + TX_CHUNK);
      await em
        .getRepository(Transaction)
        .createQueryBuilder()
        .insert()
        .into(Transaction)
        .values(chunk)
        .execute();
    }

    // Bulk UPDATE position statuses — chunked to avoid PG 65,535-param limit
    const refundedIds = pendingBets.map((b) => b.id);
    const CHUNK = 1000;
    for (let i = 0; i < refundedIds.length; i += CHUNK) {
      const chunk = refundedIds.slice(i, i + CHUNK);
      await em
        .getRepository(Position)
        .createQueryBuilder()
        .update(Position)
        .set({ status: PositionStatus.REFUNDED })
        .where("id IN (:...ids)", { ids: chunk })
        .execute();
    }
  }
}
