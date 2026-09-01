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
import { AuthMethod, AuthProvider } from "../entities/auth-method.entity";
import { LMSRService } from "./lmsr.service";
import { DEFAULT_HOUSE_EDGE_PCT } from "./fee.constants";
import { ReputationService } from "./reputation.service";
import { MarketsGateway } from "./markets.gateway";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";
import { DKGatewayService } from "../payment/services/dk-gateway/dk-gateway.service";
import { StreakService, STREAK_BONUS_MULT } from "../users/streak.service";
import {
  ledgerBalance,
  ledgerBalanceForAccount,
  balanceKey,
  ledgerBalancesByAccountCurrency,
  ledgerBalancesForAccounts,
} from "../shared/utils/ledger.util";
import { BTN_CURRENCY } from "../entities/transaction.entity";
import { roundMoney, floorMoney, formatMoney } from "../shared/utils/money.util";
import { MarketBook } from "../entities/market-book.entity";
import { OutcomeBook } from "../entities/outcome-book.entity";
import { resolveWalletCurrency } from "../shared/utils/wallet.util";
import {
  btnMinStakeFor,
  ensureBook,
  ensureBtnBook,
  ensureOutcomeBooks,
} from "./market-book.util";
import { ChallengesService } from "../challenges/challenges.service";
import { SseService } from "../sse/sse.service";
import { RevenueDistributionService } from "./revenue-distribution.service";
import {
  NOTIFICATION_QUEUE,
  JobName,
  SettlementNotifyJobData,
  BhutanAppNotifyJobData,
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
    currency?: string,
  ): Promise<number> {
    // A wallet's balance, not "the account's balance". An account can hold two
    // and they are never added together.
    return currency
      ? ledgerBalance(em, userId, currency)
      : ledgerBalanceForAccount(em, userId);
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
    /**
     * Which wallet this stake comes from. Omitted means the account's native
     * currency, so every existing caller behaves exactly as before.
     */
    requestedCurrency?: string,
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

        // ── Payout-route prerequisites, per currency ─────────────────────────
        //
        // These exist so winnings can actually be paid out, so what they
        // require depends on the rail the account withdraws through.
        //
        // A BTN account is paid to a Bhutanese bank account, hence the DK Bank
        // linkage and the verified phone captured during that onboarding.
        //
        // A USDT account is paid to a crypto address and will never have
        // either — requiring them would make it impossible for an
        // international user to place a single bet. Their equivalent gate is
        // KYC approval, enforced on the deposit path: an account that has not
        // been approved cannot have funded itself, so it has nothing to stake.
        // Which wallet is being spent. An account may hold ngultrum natively
        // and USDT beside it; the stake says which, and anything the account
        // cannot hold is refused here rather than deeper in.
        const { currency: stakeCurrency, allowed } = resolveWalletCurrency(
          user,
          requestedCurrency,
        );
        if (!allowed) {
          throw new BadRequestException(
            `This account cannot stake in ${stakeCurrency}.`,
          );
        }

        // Keyed on the wallet being spent, not on the account. A Bhutanese
        // user staking USDT is paid out to a crypto address, so DK Bank and a
        // Bhutanese phone number are not prerequisites for that bet — they are
        // prerequisites for a ngultrum one.
        if (stakeCurrency === BTN_CURRENCY) {
          if (!user.dkAccountNumber) {
            throw new BadRequestException(
              "You must link your DK Bank account before placing a bet. Go to Wallet Page → Link DK Bank.",
            );
          }

          // Doubles as identity verification and ensures withdrawal delivery.
          if (!user.phoneNumber) {
            throw new BadRequestException(
              "A verified phone number is required to place a bet. Go to Wallet Page → Link DK Bank.",
            );
          }
        }

        // Resolve the book this stake belongs to. A stake enters the book
        // matching the staker's own currency and no other — this is the
        // segregation boundary, and it is enforced here rather than in the
        // market list, because a query filter is a UX affordance and this is
        // the actual money path.
        //
        // Deliberately placed after the DK-account and phone guards: those
        // messages are what an existing BTN user sees today, and a book check
        // in front of them would change the error for everybody.
        const bookCurrency = stakeCurrency;

        // Created on demand in either currency. A user who has deposited USDT
        // can stake it on any open market without an admin opening a book
        // first — that step existed, and it meant a funded account could not
        // bet on anything.
        const book = await ensureBook(em, market, bookCurrency);

        // A book can still be disabled deliberately, which is how a market is
        // closed to one currency without being closed to the other.
        if (!book.isEnabled) {
          throw new BadRequestException(
            `This market does not accept ${bookCurrency} stakes.`,
          );
        }

        const minBet = Number(book.minStake);
        if (amount < minBet)
          throw new BadRequestException(
            `Minimum bet is ${minBet} ${bookCurrency}`,
          );

        // Store user reference for notification
        betUser = user;
        betUserTelegramId = user.telegramId;
        betMarket = market;
        betOutcome = outcome;
        // The platform cut is a property of the book: BTN and USDT can carry
        // different rates on the same event.
        capturedHouseEdgePct =
          Number(book.houseEdgePct) || DEFAULT_HOUSE_EDGE_PCT;

        const balanceBefore = await this.getCreditsBalance(
          em,
          userId,
          stakeCurrency,
        );
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

        // Per-outcome rows for THIS book. Ordered to match market.outcomes,
        // because the LMSR service pairs probabilities positionally.
        const outcomeBooks = await ensureOutcomeBooks(em, market, bookCurrency);
        const outcomeBookFor = new Map(
          outcomeBooks.map((ob) => [ob.outcomeId, ob]),
        );
        const stakedOutcomeBook = outcomeBookFor.get(outcomeId)!;

        // Snapshot pool % for this outcome BEFORE the new bet is added.
        // Used for tournament confidence scoring: 0.5 = maximally uncertain.
        // Taken from the book, so a USDT stake is scored against the USDT pool
        // rather than against a total it is not part of.
        const preBetTotalPool = Number(book.totalPool);
        const preBetOutcomePool = Number(stakedOutcomeBook.totalBetAmount);
        const poolPctAtBet =
          preBetTotalPool > 0 ? preBetOutcomePool / preBetTotalPool : 0.5;

        // ── Pool state lives on the book ─────────────────────────────────────
        stakedOutcomeBook.totalBetAmount =
          Number(stakedOutcomeBook.totalBetAmount) + amount;
        book.totalPool = Number(book.totalPool) + amount;

        // Odds are recomputed within this book only, at this book's edge. A
        // USDT stake cannot move a single BTN number, and vice versa.
        for (const ob of outcomeBooks) {
          ob.currentOdds = this.calcOdds(
            Number(book.totalPool),
            Number(book.houseEdgePct),
            Number(ob.totalBetAmount),
          );
        }

        const postBetProbs = this.lmsrService.calculateProbabilities(
          outcomeBooks as unknown as Outcome[],
          Number(market.liquidityParam) || 1000,
        );
        outcomeBooks.forEach((ob, i) => {
          ob.lmsrProbability = postBetProbs[i];
        });

        await em.save(OutcomeBook, outcomeBooks);
        await em.save(MarketBook, book);

        // ── Legacy mirror ────────────────────────────────────────────────────
        // `markets.totalPool` and the `outcomes` pool columns are still read by
        // settlement, reporting and the clients. Until those move to books
        // (C9b onward) they are maintained as a mirror of the BTN book — which
        // is exactly what those readers mean today, since every one of them is
        // a ngultrum figure. A USDT stake deliberately leaves them untouched.
        if (bookCurrency === BTN_CURRENCY) {
          market.totalPool = Number(book.totalPool);
          for (const o of market.outcomes) {
            const ob = outcomeBookFor.get(o.id)!;
            o.totalBetAmount = Number(ob.totalBetAmount);
            o.currentOdds = Number(ob.currentOdds);
            o.lmsrProbability = Number(ob.lmsrProbability);
            await em.save(Outcome, o);
          }
          await em.save(Market, market);
        }

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
          currency: bookCurrency,
          oddsAtPlacement: Number(stakedOutcomeBook.currentOdds),
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
            currency: bookCurrency,
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
        const { dayInCycle, boostActive, shieldSaved, newStreak } =
          streakResult;
        const shouldNotify =
          shieldSaved ||
          boostActive ||
          dayInCycle === 5 ||
          dayInCycle === 3 ||
          dayInCycle === 1;
        if (shouldNotify) {
          const sendStreak = async () => {
            let msg: string;
            if (shieldSaved) {
              msg = `🛡️ <b>Shield used!</b> A Shield card saved your <b>${newStreak}-day</b> bet streak after a missed day. Keep it going!`;
            } else if (boostActive) {
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

      const balBefore = await ledgerBalanceForAccount(
        txRepo,
        referrer.id,
      );

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

    // ── Settle the two-sided resolution contest, one book at a time ───────────
    // OBJECT participants win iff the admin changed the proposal; SUPPORT
    // (defenders) win iff the proposal was kept. That verdict is market-wide —
    // there is one outcome and one fact to be right about — but the MONEY is
    // per book: the winning side in a book gets each bond back plus a pro-rata
    // (here: equal, since all bonds in a book match) share of the losing side's
    // forfeited bonds IN THAT SAME CURRENCY. Nothing is pooled across books,
    // because no exchange rate exists anywhere in this system and inventing one
    // for a forfeit split would be inventing one for real money.
    //
    // Any forfeited money with no winning side — objectors lost and nobody
    // defended — plus floor-rounding dust is booked as that book's house
    // revenue, so it flows through the normal revenue-distribution mechanism
    // instead of leaking.
    const disputes = await this.disputeRepo.find({ where: { marketId } });
    // Both keyed by currency and consumed by settleMarket, which hands each
    // book only the entries belonging to it.
    const unclaimedForfeitByCurrency = new Map<string, number>();
    // Winning objectors to reward from a book's house cut when the admin's
    // proposal was OVERTURNED but nobody in that book defended it (no losing
    // side, so no forfeited bonds to reward from). The reward itself is paid
    // inside settleBook, where the real house residual is known and can cap it.
    const challengerRewardsByCurrency = new Map<
      string,
      { userId: string; bondAmount: number }[]
    >();
    if (disputes.length > 0) {
      const proposalChanged =
        !!market.proposedOutcomeId &&
        winningOutcomeId !== market.proposedOutcomeId;

      // The side that was right about the resolution wins the contest.
      const winningSide = proposalChanged
        ? DisputeSide.OBJECT
        : DisputeSide.SUPPORT;

      // One contest per book. Rows written before books existed carry the
      // 'BTN' column default, so the fallback here is a statement of fact
      // rather than a guess.
      const byCurrency = new Map<string, Dispute[]>();
      for (const d of disputes) {
        const ccy = d.currency ?? BTN_CURRENCY;
        const group = byCurrency.get(ccy);
        if (group) group.push(d);
        else byCurrency.set(ccy, [d]);
      }

      for (const [currency, group] of byCurrency) {
        const winners = group.filter((d) => d.side === winningSide);
        const losers = group.filter((d) => d.side !== winningSide);

        // Forfeited pool = sum of this book's losing bonds, at this book's
        // precision.
        const forfeitPool = roundMoney(
          losers.reduce((s, d) => s + Number(d.bondAmount), 0),
          currency,
        );
        const winnerTotalBond = winners.reduce(
          (s, d) => s + Number(d.bondAmount),
          0,
        );

        // Admin overturned with NO defending side in this book: the correct
        // objectors would otherwise get only their bond back (empty forfeit
        // pool). Fund a reward from this book's house cut instead — paid and
        // capped in settleBook.
        if (proposalChanged && winners.length > 0 && losers.length === 0) {
          challengerRewardsByCurrency.set(
            currency,
            winners.map((d) => ({
              userId: d.userId,
              bondAmount: Number(d.bondAmount),
            })),
          );
        }

        // Persist the forfeit pool onto the book for the audit trail. A
        // targeted UPDATE rather than saving an entity, so it cannot carry
        // stale pool or edge columns along with it.
        await this.dataSource
          .getRepository(MarketBook)
          .update({ marketId, currency }, { disputeBondPool: forfeitPool });

        // Pay the winning side: bond back + share of this book's forfeit pool.
        //
        // `distributedReward` accumulates every winner's (deterministic) share
        // so the house-forfeit remainder is correct on both a first pass and a
        // retry. The actual PAYMENT is idempotent: each winner's reward
        // transaction and its REWARDED status are written together inside a
        // row-locked transaction, and a winner already marked REWARDED (by an
        // earlier, possibly failed, pass) is skipped — so re-running
        // resolveMarket never double-pays a bond.
        let distributedReward = 0;
        for (const d of winners) {
          // Floored at the book's own precision. A bare Math.floor() truncated
          // to whole units, which is invisible on ngultrum bonds and would
          // erase a 6dp USDT share entirely.
          const rewardShare =
            winnerTotalBond > 0
              ? floorMoney(
                  (Number(d.bondAmount) / winnerTotalBond) * forfeitPool,
                  currency,
                )
              : 0;
          distributedReward = roundMoney(
            distributedReward + rewardShare,
            currency,
          );
          const totalReturn = roundMoney(
            Number(d.bondAmount) + rewardShare,
            currency,
          );

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
            if (!locked || locked.bondStatus !== DisputeBondStatus.LOCKED)
              return;

            // Scoped to the bond's own currency: a return must be sized against
            // the same ledger the lock was debited from.
            const balBefore = await ledgerBalance(em, d.userId, currency);

            await em.save(
              Transaction,
              em.create(Transaction, {
                userId: d.userId,
                type: TransactionType.DISPUTE_BOND_REWARD,
                amount: totalReturn,
                // The bond came out of this book and goes back into it. Stated
                // rather than left to the column default so the return of a
                // bond can never be denominated differently from its lock.
                currency,
                balanceBefore: balBefore,
                balanceAfter: balBefore + totalReturn,
                note:
                  `Resolution ${d.side === DisputeSide.OBJECT ? "objection" : "defence"} ` +
                  `WON on "${market.title}" — bond returned + ${formatMoney(rewardShare, currency)} from the losing side`,
              }),
            );
            locked.upheld = true;
            locked.bondStatus = DisputeBondStatus.REWARDED;
            locked.rewardAmount = rewardShare;
            await em.save(Dispute, locked);
            // Mirror onto the in-memory copy for the bulk save + logging below.
            d.upheld = true;
            d.bondStatus = DisputeBondStatus.REWARDED;
            d.rewardAmount = rewardShare;
          });

          this.logger.log(
            `[Bond] User ${d.userId} (${d.side}, ${currency}) WON — returned ${formatMoney(Number(d.bondAmount), currency)} + reward ${formatMoney(rewardShare, currency)}`,
          );
        }

        // The losing side forfeits — bond was already deducted at lock time.
        for (const d of losers) {
          d.upheld = false;
          d.bondStatus = DisputeBondStatus.FORFEITED;
          this.logger.log(
            `[Bond] User ${d.userId} (${d.side}, ${currency}) LOST — bond ${formatMoney(Number(d.bondAmount), currency)} forfeited`,
          );
        }

        // Whatever wasn't paid to a winning side in this book (no winners, or
        // floor-rounding dust) is booked as that book's house revenue instead
        // of disappearing.
        unclaimedForfeitByCurrency.set(
          currency,
          roundMoney(forfeitPool - distributedReward, currency),
        );

        this.logger.log(
          `[Dispute] Market ${marketId} ${currency} contest: ` +
            `winners ${winners.length}, losers ${losers.length}, ` +
            `forfeit pool ${formatMoney(forfeitPool, currency)}, ` +
            `booked to house revenue ${formatMoney(unclaimedForfeitByCurrency.get(currency)!, currency)}.`,
        );
      }

      await this.disputeRepo.save(disputes);

      this.logger.log(
        `[Dispute] Market ${marketId} resolved with ${disputes.length} contest entr${
          disputes.length === 1 ? "y" : "ies"
        } across ${byCurrency.size} book(s). ` +
          `Admin ${adminId ?? "unknown"} chose outcome ${winningOutcomeId} ` +
          `(proposal ${market.proposedOutcomeId}, changed: ${proposalChanged}).`,
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

    const settlements = await this.settleMarket(
      market,
      winner,
      unclaimedForfeitByCurrency,
      challengerRewardsByCurrency,
    );

    // Callers downstream of this point predate books and speak in a single
    // ngultrum settlement. The BTN book is that settlement; the others are
    // handled per book where it matters (revenue distribution below) and are
    // deliberately out of scope for the DK payout path, which is a BTN rail.
    const settlement =
      settlements.find((st) => st.currency === BTN_CURRENCY) ?? settlements[0];

    // Record revenue distribution (house edge → pending transfer to public
    // account). Awaited so "settled" implies "revenue booked" on the happy path.
    // If it fails, the settlement is already committed, so we do NOT fail the
    // resolve — we log LOUDLY (error) and let reconcileMissingDistributions()
    // book it on the next cron tick. recordDistribution is idempotent, so this
    // never double-books.
    // One distribution per book: revenue is earned in the currency the book
    // collected, and there is no rate at which two books could be combined.
    for (const st of settlements) {
      if (!st || st.cancelReason || Number(st.houseAmount) <= 0) continue;
      try {
        await this.revenueDistributionService.recordDistribution(
          market.id,
          st.id,
          Number(st.houseAmount),
          Number(st.totalPool) > 0
            ? (Number(st.houseAmount) / Number(st.totalPool)) * 100
            : Number(market.houseEdgePct),
          Number(st.totalPool),
          st.currency,
        );
      } catch (err) {
        this.logger.error(
          `[Revenue] Failed to record distribution for market ${marketId} ` +
            `book ${st.currency} at settlement time; reconcile cron will ` +
            `retry: ${(err as Error).message}`,
        );
      }
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
  /**
   * Settle every book on a market.
   *
   * The market resolves once — one winning outcome, one resolution — and then
   * each currency book settles independently against it, out of its own pool,
   * at its own platform cut, crediting its own currency. Two books on one event
   * never share money, so a payout is always a share of a pot denominated in a
   * single currency.
   *
   * All books settle inside one transaction: a market is either settled or it
   * is not, never half.
   *
   * Returns one Settlement per book that had positions. The BTN settlement is
   * first when present, because callers that predate books expect a single
   * ngultrum-shaped result.
   */
  private async settleMarket(
    market: Market,
    winner: Outcome,
    // Both keyed by currency. A resolution contest is settled inside the book
    // its bonds were locked in, so each book receives only its own forfeited
    // dust and its own objectors — never another book's.
    unclaimedForfeitByCurrency: Map<string, number> = new Map(),
    challengerRewardsByCurrency: Map<
      string,
      { userId: string; bondAmount: number }[]
    > = new Map(),
  ): Promise<Settlement[]> {
    return await this.dataSource.transaction(async (em) => {
      const books = await em.find(MarketBook, {
        where: { marketId: market.id },
      });

      // A market that predates the books migration, or was created by a path
      // that never took a stake, still needs a BTN book to settle against.
      // Built from the market's own figures, which are exactly what the book
      // would have mirrored.
      if (books.length === 0) {
        books.push(
          await em.save(
            MarketBook,
            em.create(MarketBook, {
              marketId: market.id,
              currency: BTN_CURRENCY,
              totalPool: Number(market.totalPool) || 0,
              houseEdgePct: Number(market.houseEdgePct),
              minStake: btnMinStakeFor(market),
            }),
          ),
        );
      }

      // BTN first, so a caller that predates books still reads the ngultrum
      // settlement out of `settlements[0]`. Bond routing no longer depends on
      // this order — each book is handed its own contest by currency below.
      books.sort((a, b) =>
        a.currency === BTN_CURRENCY ? -1 : b.currency === BTN_CURRENCY ? 1 : 0,
      );

      const settlements: Settlement[] = [];
      for (const book of books) {
        settlements.push(
          await this.settleBook(
            em,
            market,
            winner,
            book,
            unclaimedForfeitByCurrency.get(book.currency) ?? 0,
            challengerRewardsByCurrency.get(book.currency) ?? [],
          ),
        );
      }

      // ── Nothing contested a book that is not here ────────────────────────────
      // A bond can only be locked by someone holding a position in that book,
      // and taking a stake creates the book — so a contest without its book
      // should be impossible. If it ever happens, that book's forfeited bonds
      // have nowhere to be booked and would silently vanish, which is the one
      // outcome worth making loud rather than trusting the invariant.
      const settledCurrencies = new Set(books.map((b) => b.currency));
      for (const currency of unclaimedForfeitByCurrency.keys()) {
        if (settledCurrencies.has(currency)) continue;
        this.logger.error(
          `[Dispute] Market ${market.id} has a ${currency} contest but no ${currency} book — ` +
            `${formatMoney(unclaimedForfeitByCurrency.get(currency)!, currency)} of forfeited bonds ` +
            `could not be booked as revenue. Investigate before settling further markets.`,
        );
      }

      // The market itself is settled once, after every book has been.
      market.status = MarketStatus.SETTLED;
      await em.save(Market, market);

      return settlements;
    });
  }

  /**
   * Settle one currency book of a market.
   *
   * This is the algorithm that has always run on `markets.totalPool`, now
   * reading its pool, edge and winning-side total from a book instead. The
   * arithmetic — thin-pool guard, 1.05x payout floor, edge subsidy, pro-rata
   * scale-down, residual-derived house revenue — is unchanged.
   *
   * `houseForfeit` and `challengerRewardObjectors` describe THIS book's
   * resolution contest and nothing else. The caller keys both by currency and
   * hands each book only its own, so a ngultrum forfeit can never fund a USDT
   * reward — the boundary is kept by construction rather than by a BTN-only
   * special case.
   */
  private async settleBook(
    em: EntityManager,
    market: Market,
    winner: Outcome,
    book: MarketBook,
    // Forfeited dispute bonds with no winning side to reward. Booked as house
    // revenue so they flow through the normal revenue-distribution mechanism
    // (recordDistribution) instead of being kept off-ledger.
    houseForfeit = 0,
    // Winning objectors IN THIS BOOK to reward from its house cut, when the
    // admin was overturned with NO defenders here (empty forfeit pool). Their
    // bonds are returned by the caller; here they receive a configured fraction
    // of this book's house cut, split pro-rata by bond and CAPPED at the real
    // house residual so the pool still balances exactly. Skipped entirely on a
    // refunded (thin-pool) market.
    challengerRewardObjectors: { userId: string; bondAmount: number }[] = [],
  ): Promise<Settlement> {
    {
      // ── Idempotency guard — prevent double settlement ─────────────────────────
      // Per book: one book already being settled must not block its sibling.
      const existing = await em.findOne(Settlement, {
        where: { marketId: market.id, currency: book.currency },
      });
      if (existing) {
        this.logger.warn(
          `[Settlement] Market ${market.id} already has a settlement record — skipping duplicate settle`,
        );
        return existing;
      }

      const currency = book.currency;
      const totalPool = Number(book.totalPool);
      // Configured edge; the amount actually booked can be lower when the payout
      // floor has to be subsidised (see the funding guard and bookedHouseAmount).
      const houseAmount = totalPool * (Number(book.houseEdgePct) / 100);
      const payoutPool = totalPool - houseAmount;

      // The winning side's stake within THIS book.
      //
      // Derived from the positions being settled rather than read from
      // `outcome_books`, because the payout shares below divide by it: taking
      // both from the same source makes `sum(share) === 1` true by
      // construction. The book's running total also counts stakes from any
      // earlier partial settlement, which is not what this divisor means.

      // Only settle PENDING positions — never re-process already-settled bets.
      // This is the second line of defence against double payouts (the first is
      // the idempotency guard above; the third is the RESOLVING→RESOLVED atomic claim).
      const bets = await em.find(Position, {
        where: {
          marketId: market.id,
          status: PositionStatus.PENDING,
          currency,
        },
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
      const winnerPool = winningBets.reduce(
        (sum, b) => sum + Number(b.amount),
        0,
      );

      if (
        uniqueBettorIds.size < minUniqueBettors ||
        losingSideBettors === 0 || // Scenario A: all bets on winning side
        winningBets.length === 0 // Scenario B: no bets on winning side (winnerPool=0)
      ) {
        return this.refundAndRecordSettlement(
          em,
          market,
          winner,
          bets,
          totalPool,
          "thin_pool",
          "Thin pool — market refunded",
          "thin_pool",
          currency,
        );
      }

      const payoutFloorTotal = winningBets.reduce(
        (sum, bet) => sum + roundMoney(Number(bet.amount) * 1.05, currency),
        0,
      );
      const floorShortfall = roundMoney(payoutFloorTotal - payoutPool, currency);
      if (floorShortfall > 0) {
        this.logger.warn(
          `[Settlement] Market ${market.id} refunded: 1.05x floor requires Nu ${payoutFloorTotal}, ` +
            `but post-rake payout pool is Nu ${payoutPool}. Shortfall Nu ${floorShortfall}.`,
        );
        return this.refundAndRecordSettlement(
          em,
          market,
          winner,
          bets,
          totalPool,
          "payout_floor_underfunded",
          "Payout floor could not be funded — market refunded",
          "payout_floor_underfunded",
          currency,
        );
      }

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
        // Keyed by currency: this book pays in `currency`, and a Bhutanese
        // account settling a USDT book has a ngultrum balance that has nothing
        // to do with the row being written.
        const chunkBalances = await ledgerBalancesByAccountCurrency(em, chunk);
        for (const uid of chunk) {
          balanceMap.set(uid, chunkBalances.get(balanceKey(uid, currency)) ?? 0);
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
        const raw = roundMoney(payoutPool * share, currency);
        const floor = roundMoney(Number(bet.amount) * 1.05, currency);
        desiredWinnerTotal += Math.max(raw, floor);
      }
      // Only scale down when the floor can't be funded even with a zero edge.
      // (A bound floor simply raises totalPaidOut; house revenue is derived from
      // the actual residual below, so no explicit subsidy figure is needed here.)
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
          const rawPayout = roundMoney(payoutPool * share, currency);
          const stake = Number(bet.amount);
          // Guaranteed floor, scaled down only in the extreme case where even a
          // waived house edge can't fund it (payoutScale < 1).
          const effectivePayout = roundMoney(
            Math.max(rawPayout, stake * 1.05) * payoutScale,
            currency,
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
            withdrawablePayout = roundMoney(
              Math.min(effectivePayout, currentRemaining),
              currency,
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
            currency,
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
            const boostBonus = roundMoney(
              withdrawablePayout * (STREAK_BONUS_MULT - 1),
              currency,
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
                currency,
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

      // The market's status is set once by settleMarket, after every book.

      // Book house revenue as the EXACT residual of the pool: whatever was not
      // paid out to winners (totalPaidOut), plus any forfeited dispute bonds
      // routed to revenue. Deriving revenue from the money actually paid —
      // rather than the theoretical edge — makes the books balance to the
      // chhertum by construction:
      //     totalPool === totalPaidOut + (bookedHouseAmount − houseForfeit)
      // and deterministically assigns all rounding breakage (the standard
      // parimutuel treatment) to house revenue instead of leaving unaccounted
      // fractions. A subsidised payout floor is captured automatically: it
      // raises totalPaidOut, which lowers this residual.
      const poolResidual = Math.max(
        0,
        roundMoney(totalPool - totalPaidOut, currency),
      );

      // ── Overturned-with-no-defenders challenger reward ────────────────────────
      // Reward correct objectors a fraction of the market's house cut when the
      // admin was overturned and there was no defending side to forfeit bonds.
      // The fraction is configurable via CHALLENGER_REWARD_HOUSE_CUT_FRACTION
      // (default 0.2 = 20% of the house cut ≈ 2% of the pool at a 10% edge).
      // Funded from — and capped at — the house residual, so it can never pay out
      // money the pool does not hold, and the conservation identity below holds:
      //     totalPool === totalPaidOut + challengerRewardPaid
      //                   + (bookedHouseAmount − houseForfeit)
      let challengerRewardPaid = 0;
      if (challengerRewardObjectors.length > 0) {
        const houseCut = roundMoney(
          (totalPool * Number(book.houseEdgePct)) / 100,
          currency,
        );
        // Clamp to [0, 1]; fall back to 0.2 for a missing/garbage config value.
        const rawFraction = Number(
          this.configService.get("CHALLENGER_REWARD_HOUSE_CUT_FRACTION", "0.2"),
        );
        const rewardFraction =
          Number.isFinite(rawFraction) && rawFraction >= 0 && rawFraction <= 1
            ? rawFraction
            : 0.2;
        const rewardPool = Math.min(
          roundMoney(houseCut * rewardFraction, currency),
          poolResidual,
        );
        const totalBond = challengerRewardObjectors.reduce(
          (s, o) => s + o.bondAmount,
          0,
        );
        if (rewardPool > 0 && totalBond > 0) {
          for (const o of challengerRewardObjectors) {
            const share = roundMoney(
              (o.bondAmount / totalBond) * rewardPool,
              currency,
            );
            if (share <= 0) continue;
            const balBefore = await ledgerBalanceForAccount(em, o.userId);
            await em.save(
              Transaction,
              em.create(Transaction, {
                userId: o.userId,
                type: TransactionType.DISPUTE_BOND_REWARD,
                amount: share,
                // Funded from this book's house cut, so it is denominated in
                // this book's currency. Only the BTN book receives objectors
                // today (see settleMarket), but the row should not rely on it.
                currency,
                balanceBefore: balBefore,
                balanceAfter: balBefore + share,
                note:
                  `Objection UPHELD on "${market.title}" — admin overturned with ` +
                  `no defenders; rewarded Nu ${share} from the house cut`,
              }),
            );
            challengerRewardPaid = roundMoney(
              challengerRewardPaid + share,
              currency,
            );
            // Record the reward on the objector's dispute row so the UI can show
            // exactly what they won. resolveMarket already marked it REWARDED with
            // rewardAmount 0 (no defenders → empty forfeit pool); set the real
            // house-cut figure here. Idempotent: a retry writes the same value.
            await em.getRepository(Dispute).update(
              {
                marketId: market.id,
                userId: o.userId,
                side: DisputeSide.OBJECT,
              },
              { rewardAmount: share },
            );
            await this.redis
              .del(`oro:cache:balance:${o.userId}`)
              .catch(() => undefined);
          }
        }
      }

      // Book house revenue as the residual MINUS anything paid to challengers
      // from the house cut (a bound floor already lowered the residual by
      // raising totalPaidOut). Cannot go negative because the reward is capped
      // at poolResidual above.
      const bookedHouseAmount = Math.max(
        0,
        roundMoney(poolResidual + houseForfeit - challengerRewardPaid, currency),
      );

      const settlement = em.create(Settlement, {
        marketId: market.id,
        currency,
        winningOutcomeId: winner.id,
        totalPositions: bets.length,
        winningPositions,
        totalPool,
        houseAmount: bookedHouseAmount,
        payoutPool,
        totalPaidOut,
      });
      return em.save(Settlement, settlement);
    }
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

    // Map each bettor to their BhutanApp external id (PWA users have no Telegram
    // chat, so they're notified via BhutanApp push instead). One batched query.
    const bhutanAuths = await this.dataSource.getRepository(AuthMethod).findBy({
      provider: AuthProvider.BHUTANAPP,
      userId: In(userIds),
    });
    const bhutanExternalIdByUser: Record<string, string> = {};
    for (const am of bhutanAuths) {
      const ext = (am.metadata as any)?.externalUserId ?? am.providerId;
      if (ext) bhutanExternalIdByUser[am.userId] = String(ext);
    }

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
    const bhutanJobs: { name: string; data: BhutanAppNotifyJobData }[] = [];

    // Telegram HTML → plain text for push bodies (BhutanApp push has no markup).
    const toPlain = (s: string) => s.replace(/<[^>]+>/g, "").trim();

    // Enqueue a notification to whichever channel(s) the user has: Telegram DM
    // (TMA), BhutanApp push (PWA), or both if the account is linked to each.
    const notifyUser = (
      chatId: number | null,
      externalUserId: string | null,
      telegramMsg: string,
      pushTitle: string,
    ) => {
      if (chatId != null) {
        dmJobs.push({
          name: JobName.SETTLEMENT_NOTIFY,
          data: { telegramChatId: chatId, message: telegramMsg },
        });
      }
      if (externalUserId) {
        bhutanJobs.push({
          name: JobName.BHUTANAPP_NOTIFY,
          data: { externalUserId, title: pushTitle, body: toPlain(telegramMsg) },
        });
      }
    };

    for (const userId of Object.keys(betsByUser)) {
      const userBets = betsByUser[userId];
      const user = userMap[userId];
      if (!user) continue;

      const chatId = user.telegramId ? Number(user.telegramId) : null;
      const externalUserId = bhutanExternalIdByUser[userId] ?? null;
      // No reachable channel (neither Telegram nor BhutanApp) — skip.
      if (chatId == null && !externalUserId) continue;
      const tierNow = user.reputationTier ?? "rookie";
      const tierBefore = tiersBefore[userId] ?? "rookie";
      const totalPredictions = user.totalPredictions ?? 0;
      // This is the literal resolved record — unlike reputationScore it is not
      // confidence-smoothed, so it must always agree with the count a user sees.
      const correctPredictions = user.correctPredictions ?? 0;
      const record =
        totalPredictions > 0
          ? `${correctPredictions}/${totalPredictions} correct`
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

        if (record) msg += `⭐ Record: <b>${record}</b>\n`;
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

        notifyUser(chatId, externalUserId, msg, "🎉 You won!");
      } else {
        const outcome = market.outcomes.find(
          (o) => o.id === userBets[0].outcomeId,
        );

        let msg =
          `🙂‍↕️<b>Not this time.</b>\n\n` +
          `📊 ${market.title}\n` +
          `🎯 Your pick: ${outcome?.label ?? "unknown"} · Winner: <b>${winner.label}</b>\n`;

        if (record) msg += `⭐ Record: <b>${record}</b>\n`;

        notifyUser(chatId, externalUserId, msg, "Market settled");
      }
    }

    // Bulk-enqueue all notifications in one BullMQ addBulk call per channel —
    // one round-trip to Redis each.
    if (dmJobs.length > 0) {
      await this.notificationQueue
        .addBulk(dmJobs)
        .catch((err: Error) =>
          this.logger.warn(
            `[Notify] Failed to enqueue settlement DMs: ${err.message}`,
          ),
        );
    }
    if (bhutanJobs.length > 0) {
      await this.notificationQueue
        .addBulk(bhutanJobs)
        .catch((err: Error) =>
          this.logger.warn(
            `[Notify] Failed to enqueue BhutanApp pushes: ${err.message}`,
          ),
        );
    }

    this.logger.log(
      `[Notify] Queued ${dmJobs.length} Telegram DMs + ${bhutanJobs.length} BhutanApp pushes ` +
        `for market ${market.id} (${Object.keys(betsByUser).length} predictors, ${bets.length} positions)`,
    );
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
      await this.releaseLockedDisputeBonds(em, market);
    });
  }

  /**
   * Return every still-locked dispute bond on a market that will never be
   * resolved.
   *
   * Bonds are debited at lock time and only ever returned by resolveMarket, so
   * without this a cancelled market kept its objectors' and defenders' bonds
   * permanently — real money with no code path back to the user. There is no
   * contest to win or lose once the market is void, so nobody forfeits and
   * nobody is rewarded: every bond goes back at face value.
   *
   * Runs inside the caller's transaction, so the release either commits with
   * the cancellation or not at all. Idempotent by construction — it only ever
   * touches LOCKED rows and flips them in the same transaction, so a second
   * cancel finds nothing to release.
   */
  private async releaseLockedDisputeBonds(
    em: EntityManager,
    market: Market,
  ): Promise<void> {
    const locked = await em.find(Dispute, {
      where: { marketId: market.id, bondStatus: DisputeBondStatus.LOCKED },
    });
    if (locked.length === 0) return;

    for (const d of locked) {
      const bond = Number(d.bondAmount);
      // The book the bond was locked in. A release must land in the same one,
      // or a cancelled market becomes a currency conversion nobody priced.
      const currency = d.currency ?? BTN_CURRENCY;
      if (bond <= 0) {
        // Nothing to give back, but the row must not stay LOCKED or the next
        // reconciliation run reads it as an outstanding liability.
        d.bondStatus = DisputeBondStatus.NOT_APPLICABLE;
        continue;
      }
      // One dispute row per user per market, so no two iterations touch the
      // same balance; re-reading per row is still correct because the
      // transaction sees its own writes.
      const balBefore = await ledgerBalance(em, d.userId, currency);
      await em.save(
        Transaction,
        em.create(Transaction, {
          userId: d.userId,
          type: TransactionType.DISPUTE_REFUND,
          amount: bond,
          currency,
          balanceBefore: balBefore,
          balanceAfter: balBefore + bond,
          note: `Market "${market.title}" was cancelled — resolution bond of ${formatMoney(bond, currency)} returned in full`,
        }),
      );
      // NOT_APPLICABLE, not REWARDED: no side won. `upheld` stays null because
      // the objection was never ruled on.
      d.bondStatus = DisputeBondStatus.NOT_APPLICABLE;
    }

    await em.save(Dispute, locked);

    await Promise.all(
      locked.map((d) =>
        this.redis.del(`oro:cache:balance:${d.userId}`).catch(() => undefined),
      ),
    );

    // Totalled per currency: summing a ngultrum bond and a USDT bond into one
    // figure would be the exact mistake this whole change removes.
    const totals = new Map<string, number>();
    for (const d of locked) {
      const ccy = d.currency ?? BTN_CURRENCY;
      totals.set(ccy, roundMoney((totals.get(ccy) ?? 0) + Number(d.bondAmount), ccy));
    }
    this.logger.log(
      `[Bond] Market ${market.id} cancelled — released ${locked.length} locked bond(s) ` +
        `totalling ${[...totals]
          .map(([ccy, amount]) => formatMoney(amount, ccy))
          .join(" + ")}`,
    );
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
      // A cancelled market can hold positions in both books, so the balance
      // has to be per (user, currency) rather than per user.
      const chunkBalances = await ledgerBalancesByAccountCurrency(em, chunk);
      for (const [key, bal] of chunkBalances) balanceMap.set(key, bal);
    }
    const balanceDelta = new Map<string, number>();
    // Both maps are keyed `${userId}|${currency}`: one refund run can touch a
    // user's ngultrum and USDT wallets, and they must not be added together.
    const getBalance = (uid: string, ccy: string): number =>
      (balanceMap.get(balanceKey(uid, ccy)) ?? 0) +
      (balanceDelta.get(balanceKey(uid, ccy)) ?? 0);

    const txToInsert: Partial<Transaction>[] = [];

    for (const bet of pendingBets) {
      const refundAmt = Number(bet.amount);
      const betCurrency = bet.currency ?? BTN_CURRENCY;
      const balanceBefore = getBalance(bet.userId, betCurrency);
      balanceDelta.set(
        balanceKey(bet.userId, betCurrency),
        (balanceDelta.get(balanceKey(bet.userId, betCurrency)) ?? 0) + refundAmt,
      );
      txToInsert.push({
        type: TransactionType.REFUND,
        amount: refundAmt,
        // A refund returns the stake to the book it came from. Taken from the
        // position rather than a parameter so it is right even when a caller
        // refunds a mixed set.
        currency: betCurrency,
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

  /**
   * Refund one book and record its settlement.
   *
   * Per book, deliberately: a thin USDT pool refunds on its own while the BTN
   * book on the same event pays out normally. Same market, different outcome
   * for the two cohorts — correct, because each book can only ever pay from
   * money its own bettors put in.
   *
   * The market's own status is set once by settleMarket after every book has
   * been handled, not here.
   */
  private async refundAndRecordSettlement(
    em: EntityManager,
    market: Market,
    winner: Outcome,
    bets: Position[],
    totalPool: number,
    cancelReason: "thin_pool" | "payout_floor_underfunded",
    note: string,
    notificationReason: "thin_pool" | "payout_floor_underfunded",
    currency: string = BTN_CURRENCY,
  ): Promise<Settlement> {
    await this.refundPositions(em, bets, note);

    await this.sendMarketRefundNotifications(
      em,
      bets,
      market.title,
      notificationReason,
    );

    const settlement = em.create(Settlement, {
      marketId: market.id,
      currency,
      winningOutcomeId: winner.id,
      totalPositions: bets.length,
      winningPositions: 0,
      totalPool,
      houseAmount: 0,
      payoutPool: 0,
      totalPaidOut: 0,
      cancelReason,
    });
    return em.save(Settlement, settlement);
  }

  private async sendMarketRefundNotifications(
    em: EntityManager,
    bets: Position[],
    marketTitle: string,
    reason: "thin_pool" | "payout_floor_underfunded",
  ): Promise<void> {
    const uniqueBetUserIds = [...new Set(bets.map((b) => b.userId))];
    const USER_CHUNK = 1000;
    const usersArr: User[] = [];
    for (let i = 0; i < uniqueBetUserIds.length; i += USER_CHUNK) {
      const chunk = uniqueBetUserIds.slice(i, i + USER_CHUNK);
      const rows = await em.find(User, {
        where: { id: In(chunk) },
        select: ["id", "telegramId"],
      });
      usersArr.push(...rows);
    }
    const userMap = new Map(usersArr.map((u) => [u.id, u]));

    const refundByUser = new Map<string, number>();
    for (const bet of bets) {
      refundByUser.set(
        bet.userId,
        (refundByUser.get(bet.userId) ?? 0) + Number(bet.amount),
      );
    }

    for (const [uid, totalRefund] of refundByUser.entries()) {
      const user = userMap.get(uid);
      if (user?.telegramId) {
        this.telegramSimple
          .sendRefundNotification(
            Number(user.telegramId),
            marketTitle,
            totalRefund,
            reason,
          )
          .catch(() => undefined);
      }
    }
  }
}
