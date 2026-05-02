import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { User } from "../entities/user.entity";
import { Position, PositionStatus } from "../entities/position.entity";
import { Market } from "../entities/market.entity";

/**
 * ReputationService — Intelligence Layer
 *
 * Four interlocking mechanisms:
 *
 * 1. REPUTATION-WEIGHTED LMSR
 *    Each bettor's effective share = bet.amount × reputationMultiplier
 *    reputationMultiplier = 0.5 + score   (range ~0.5x–1.5x)
 *    High-rep users move displayed probabilities more; low-rep less.
 *
 * 2. TIME-DECAY
 *    Influence decays with inactivity:
 *      decayFactor = exp(−ln2 × daysSinceLastActive / DECAY_HALF_LIFE)
 *    At 365 days inactive a user's weight halves; at 730 days, quarters.
 *    Stored score is unchanged — only real-time signal weighting is decayed.
 *
 * 3. BRIER SCORE CALIBRATION
 *    Brier = (predictedProbability − actual)²   lower is better (0–1)
 *    Rolling average stored per user as brierScore / brierCount.
 *    calibrationMultiplier = 1 − brierScore × 0.5   (penalises overconfidence)
 *    Full weight multiplier: reputationMultiplier × decayFactor × calibrationMultiplier
 *
 * 4. COLD-START BOOTSTRAP (CID-verified users)
 *    Users with a verified DK CID get a prior of CID_PRIOR = 0.52
 *    instead of the neutral 0.5, giving a slight accuracy head-start
 *    that erodes as actual predictions accumulate.
 *
 * Score formula (unchanged for storage):
 *   raw        = correctPredictions / totalPredictions
 *   confidence = min(totalPredictions / CONFIDENCE_THRESHOLD, 1.0)
 *   prior      = 0.52 if CID-verified, else 0.50
 *   adjusted   = raw × confidence + prior × (1 − confidence)
 */
@Injectable()
export class ReputationService {
  private readonly logger = new Logger(ReputationService.name);

  /** Predictions needed before score reaches full confidence. */
  private readonly CONFIDENCE_THRESHOLD = 30;

  /** Inactivity half-life in days for decay. */
  private readonly DECAY_HALF_LIFE_DAYS = 365;

  /** Prior accuracy for DK CID-verified users (vs neutral 0.5). */
  private readonly CID_PRIOR = 0.52;

  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Position) private readonly betRepo: Repository<Position>,
    @InjectRepository(Market) private readonly marketRepo: Repository<Market>,
  ) {}

  // ─── Settlement hook ────────────────────────────────────────────────────────

  /**
   * Called after every market settlement.
   * Recalculates reputation scores for all users who had a bet in this market.
   */
  async recalculateForMarket(marketId: string): Promise<void> {
    const market = await this.marketRepo.findOneBy({ id: marketId });
    if (!market) return;

    const bets = await this.betRepo.find({
      where: [
        { marketId, status: PositionStatus.WON },
        { marketId, status: PositionStatus.LOST },
      ],
    });

    if (bets.length === 0) return;

    const userIds = [...new Set(bets.map((b) => b.userId))];
    for (const userId of userIds) {
      await this.recalculateForUser(userId, market.category);
    }

    this.logger.log(
      `[Reputation] Recalculated ${userIds.length} users after market ${marketId}`,
    );
  }

  /**
   * Recalculates all reputation dimensions for one user.
   * Safe to call multiple times — always derives from canonical history.
   *
   * Deduplication: one market = one prediction decision.
   * When a user places multiple bets on the same market, only their LAST
   * position (by placedAt) is counted for accuracy and Brier score.
   * Splitting a stake into many small bets must not inflate prediction count
   * or skew calibration.
   */
  async recalculateForUser(
    userId: string,
    _triggeredByCategory?: string,
  ): Promise<void> {
    const user = await this.userRepo.findOneBy({ id: userId });
    if (!user) return;

    const allPositions = await this.betRepo
      .createQueryBuilder("b")
      .leftJoinAndSelect("b.market", "m")
      .where("b.userId = :userId", { userId })
      .andWhere("b.status IN (:...statuses)", {
        statuses: [PositionStatus.WON, PositionStatus.LOST],
      })
      .orderBy("b.placedAt", "ASC") // ASC so the last entry wins when deduplicating
      .getMany();

    // ── Deduplicate: one prediction per market (last bet placed wins) ─────────
    // Multiple bets on the same market are one decision, not many predictions.
    const perMarket = new Map<string, (typeof allPositions)[0]>();
    for (const bet of allPositions) {
      perMarket.set(bet.marketId, bet); // later entries overwrite earlier ones
    }
    const dedupedPositions = Array.from(perMarket.values());

    const totalPredictions = dedupedPositions.length;
    const correctPredictions = dedupedPositions.filter(
      (b) => b.status === PositionStatus.WON,
    ).length;

    // ── Per-category breakdown ───────────────────────────────────────────────
    const categoryScores: Record<string, { correct: number; total: number }> =
      {};
    for (const bet of dedupedPositions) {
      const cat = (bet.market as any)?.category ?? "other";
      if (!categoryScores[cat]) categoryScores[cat] = { correct: 0, total: 0 };
      categoryScores[cat].total += 1;
      if (bet.status === PositionStatus.WON) categoryScores[cat].correct += 1;
    }

    // ── Brier score calibration (Feature 3) ──────────────────────────────────
    // Only positions that have a recorded predictedProbability contribute.
    // Uses the deduplicated set — one Brier observation per market.
    const calibrated = dedupedPositions.filter(
      (b) => (b as any).predictedProbability != null,
    );
    let brierScore: number | null = null;
    const brierCount = calibrated.length;
    if (brierCount > 0) {
      const sumBrier = calibrated.reduce((acc, b) => {
        const p = Number((b as any).predictedProbability);
        const actual = b.status === PositionStatus.WON ? 1 : 0;
        return acc + Math.pow(p - actual, 2);
      }, 0);
      brierScore = parseFloat((sumBrier / brierCount).toFixed(4));
    }

    // ── Last active timestamp ─────────────────────────────────────────────────
    const allUserPositions = await this.betRepo.find({
      where: { userId },
      order: { placedAt: "DESC" },
      take: 1,
    });
    const lastActiveAt = allUserPositions[0]?.placedAt ?? null;

    // ── Confidence-adjusted overall score (Feature 4: CID prior) ────────────
    const isCidVerified = !!user.dkCid;
    const reputationScore =
      totalPredictions === 0
        ? isCidVerified
          ? this.CID_PRIOR
          : null
        : this.adjustedScore(
            correctPredictions,
            totalPredictions,
            isCidVerified,
          );

    // ── Tier ─────────────────────────────────────────────────────────────────
    const reputationTier = this.calcTier(totalPredictions, correctPredictions);

    await this.userRepo.update(userId, {
      totalPredictions,
      correctPredictions,
      reputationScore,
      reputationTier,
      brierScore,
      brierCount,
      lastActiveAt,
      categoryScores:
        Object.keys(categoryScores).length > 0 ? categoryScores : null,
    });

    this.logger.debug(
      `[Reputation] user=${userId} total=${totalPredictions} correct=${correctPredictions} ` +
        `score=${reputationScore?.toFixed(4) ?? "null"} tier=${reputationTier} ` +
        `brier=${brierScore?.toFixed(4) ?? "null"} cid=${isCidVerified}`,
    );
  }

  // ─── Signal computation ──────────────────────────────────────────────────────

  /**
   * Computes accuracy-weighted probability signal per outcome for a market.
   * Applies decay (Feature 2) and Brier calibration (Feature 3) to each voter's weight.
   * Deduplication: one vote per user (last bet wins).
   * Returns empty object when fewer than 3 unique bettors.
   */
  async computeMarketSignal(
    marketId: string,
    outcomeIds: string[],
    category?: string,
  ): Promise<Record<string, number>> {
    const rows = await this.betRepo
      .createQueryBuilder("b")
      .leftJoin("b.user", "u")
      .select("b.outcomeId", "outcomeId")
      .addSelect("u.reputationScore", "reputationScore")
      .addSelect("u.categoryScores", "categoryScores")
      .addSelect("u.brierScore", "brierScore")
      .addSelect("u.lastActiveAt", "lastActiveAt")
      .addSelect("b.userId", "userId")
      .where("b.marketId = :marketId", { marketId })
      .andWhere("b.status IN (:...statuses)", {
        statuses: [
          PositionStatus.PENDING,
          PositionStatus.WON,
          PositionStatus.LOST,
        ],
      })
      .orderBy("b.placedAt", "ASC") // ASC so last row per user overwrites earlier ones
      .getRawMany();

    const uniqueBettors = new Set(rows.map((r) => r.userId)).size;
    if (uniqueBettors < 3) return {};

    // Deduplicate: one vote per user (last bet wins)
    const userOutcomeMap: Record<
      string,
      { outcomeId: string; weight: number }
    > = {};
    for (const row of rows) {
      let score = Number(row.reputationScore ?? 0.5);

      // Category-specific score if available
      if (category && row.categoryScores) {
        const catScores =
          typeof row.categoryScores === "string"
            ? JSON.parse(row.categoryScores)
            : row.categoryScores;
        const cat = catScores?.[category];
        if (cat && cat.total >= 5) {
          score = this.adjustedScore(cat.correct, cat.total);
        }
      }

      // Feature 2: decay
      const decay = this.decayFactor(
        row.lastActiveAt ? new Date(row.lastActiveAt) : null,
      );

      // Feature 3: Brier calibration penalty
      const calibration = this.calibrationMultiplier(
        row.brierScore != null ? Number(row.brierScore) : null,
      );

      const weight = score * decay * calibration;
      userOutcomeMap[row.userId] = { outcomeId: row.outcomeId, weight };
    }

    const weightedSums: Record<string, number> = {};
    let totalWeight = 0;
    for (const { outcomeId, weight } of Object.values(userOutcomeMap)) {
      weightedSums[outcomeId] = (weightedSums[outcomeId] || 0) + weight;
      totalWeight += weight;
    }
    if (totalWeight === 0) return {};

    const signal: Record<string, number> = {};
    for (const id of outcomeIds) {
      signal[id] = parseFloat(
        ((weightedSums[id] || 0) / totalWeight).toFixed(4),
      );
    }
    return signal;
  }

  /**
   * Computes reputation-weighted effective shares per outcome.
   * Used to drive LMSR probability display (Feature 1).
   *
   * effectiveAmount = bet.amount × (0.5 + reputationScore) × decayFactor × calibrationMultiplier
   *
   * High-rep, recently-active, well-calibrated bettors contribute up to ~1.5×
   * their bet amount; rookies and inactive users contribute ~0.5–0.75×.
   */
  async computeReputationWeightedShares(
    marketId: string,
  ): Promise<Record<string, number>> {
    const rows = await this.betRepo
      .createQueryBuilder("b")
      .leftJoin("b.user", "u")
      .select("b.outcomeId", "outcomeId")
      .addSelect("b.amount", "amount")
      .addSelect("u.reputationScore", "reputationScore")
      .addSelect("u.brierScore", "brierScore")
      .addSelect("u.lastActiveAt", "lastActiveAt")
      .addSelect("b.userId", "userId")
      .where("b.marketId = :marketId", { marketId })
      .andWhere("b.status IN (:...statuses)", {
        statuses: [
          PositionStatus.PENDING,
          PositionStatus.WON,
          PositionStatus.LOST,
        ],
      })
      .getRawMany();

    // ── Step 1: aggregate total stake per user per outcome ────────────────────
    // A user who places 3 × Nu 200 bets on YES has staked Nu 600 total on YES.
    // The reputation multiplier is applied once to that total — not once per bet.
    // This prevents signal amplification from bet-splitting.
    const userOutcomeStake: Record<
      string,
      {
        outcomeId: string;
        totalAmount: number;
        reputationScore: number;
        brierScore: number | null;
        lastActiveAt: Date | null;
      }
    > = {};

    for (const row of rows) {
      const key = `${row.userId}:${row.outcomeId}`;
      if (!userOutcomeStake[key]) {
        userOutcomeStake[key] = {
          outcomeId: row.outcomeId,
          totalAmount: 0,
          reputationScore: Number(row.reputationScore ?? 0.5),
          brierScore: row.brierScore != null ? Number(row.brierScore) : null,
          lastActiveAt: row.lastActiveAt ? new Date(row.lastActiveAt) : null,
        };
      }
      userOutcomeStake[key].totalAmount += Number(row.amount);
    }

    // ── Step 2: apply reputation multiplier once per user-outcome pair ────────
    const weightedShares: Record<string, number> = {};
    for (const entry of Object.values(userOutcomeStake)) {
      const decay = this.decayFactor(entry.lastActiveAt);
      const calibration = this.calibrationMultiplier(entry.brierScore);
      // multiplier: 0.5 + score gives range [0.5, 1.5] for score in [0, 1]
      const multiplier = (0.5 + entry.reputationScore) * decay * calibration;
      const effective = entry.totalAmount * multiplier;
      weightedShares[entry.outcomeId] =
        (weightedShares[entry.outcomeId] || 0) + effective;
    }
    return weightedShares;
  }

  /**
   * Computes composite signal confidence dimensions.
   * Applies decay and Brier calibration to depth and maturity sub-scores.
   */
  async computeSignalConfidence(
    marketId: string,
    category?: string,
  ): Promise<{
    participantCount: number;
    reputationDepth: number;
    maturityScore: number;
    composite: number;
  }> {
    const rows = await this.betRepo
      .createQueryBuilder("b")
      .leftJoin("b.user", "u")
      .select("b.userId", "userId")
      .addSelect("u.reputationTier", "reputationTier")
      .addSelect("u.totalPredictions", "totalPredictions")
      .addSelect("u.categoryScores", "categoryScores")
      .addSelect("u.lastActiveAt", "lastActiveAt")
      .addSelect("u.brierScore", "brierScore")
      .where("b.marketId = :marketId", { marketId })
      .andWhere("b.status IN (:...statuses)", {
        statuses: [
          PositionStatus.PENDING,
          PositionStatus.WON,
          PositionStatus.LOST,
        ],
      })
      .getRawMany();

    // Deduplicate
    const seen = new Map<
      string,
      {
        tier: string;
        totalPredictions: number;
        catTotal: number;
        lastActiveAt: Date | null;
        brierScore: number | null;
      }
    >();
    for (const row of rows) {
      if (seen.has(row.userId)) continue;
      let catTotal = 0;
      if (category && row.categoryScores) {
        const catScores =
          typeof row.categoryScores === "string"
            ? JSON.parse(row.categoryScores)
            : row.categoryScores;
        catTotal = catScores?.[category]?.total ?? 0;
      }
      seen.set(row.userId, {
        tier: row.reputationTier ?? "rookie",
        totalPredictions: Number(row.totalPredictions ?? 0),
        catTotal,
        lastActiveAt: row.lastActiveAt ? new Date(row.lastActiveAt) : null,
        brierScore: row.brierScore != null ? Number(row.brierScore) : null,
      });
    }

    const participantCount = seen.size;
    if (participantCount === 0) {
      return {
        participantCount: 0,
        reputationDepth: 0,
        maturityScore: 0,
        composite: 0,
      };
    }

    const bettors = Array.from(seen.values());

    // reputationDepth — decay-weighted fraction of reliable/expert bettors
    const depthSum = bettors.reduce((sum, b) => {
      const isQualified = b.tier === "hot_hand" || b.tier === "legend" ? 1 : 0;
      return sum + isQualified * this.decayFactor(b.lastActiveAt);
    }, 0);
    const reputationDepth = parseFloat(
      (depthSum / participantCount).toFixed(4),
    );

    // maturityScore — average Bayesian confidence, decay-weighted
    const maturitySum = bettors.reduce((sum, b) => {
      const preds =
        category && b.catTotal > 0 ? b.catTotal : b.totalPredictions;
      const confidence = Math.min(preds / this.CONFIDENCE_THRESHOLD, 1.0);
      return sum + confidence * this.decayFactor(b.lastActiveAt);
    }, 0);
    const maturityScore = parseFloat(
      (maturitySum / participantCount).toFixed(4),
    );

    // volumeSignal — log-scaled, saturates around 50 bettors
    const volumeSignal = Math.min(
      Math.log(participantCount + 1) / Math.log(51),
      1.0,
    );

    const composite = parseFloat(
      (
        0.3 * volumeSignal +
        0.35 * reputationDepth +
        0.35 * maturityScore
      ).toFixed(4),
    );

    return { participantCount, reputationDepth, maturityScore, composite };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Confidence-adjusted accuracy score (0–1), with optional CID prior.
   * CID-verified users start at 0.52 instead of neutral 0.5.
   */
  adjustedScore(correct: number, total: number, isCidVerified = false): number {
    const prior = isCidVerified ? this.CID_PRIOR : 0.5;
    if (total === 0) return prior;
    const raw = correct / total;
    const confidence = Math.min(total / this.CONFIDENCE_THRESHOLD, 1.0);
    return parseFloat((raw * confidence + prior * (1 - confidence)).toFixed(4));
  }

  /**
   * Tier based on volume and accuracy (unchanged thresholds).
   *   rookie        < 10 predictions
   *   sharpshooter  10–49 predictions
   *   hot_hand      50+ predictions AND accuracy >= 65%
   *   legend        100+ predictions AND accuracy >= 75%
   */
  calcTier(total: number, correct: number): string {
    if (total < 10) return "rookie";
    const accuracy = correct / total;
    if (total >= 100 && accuracy >= 0.75) return "legend";
    if (total >= 50 && accuracy >= 0.65) return "hot_hand";
    return "sharpshooter";
  }

  /**
   * Contrarian badge tier based on number of contrarian wins and win-rate.
   *   bronze  ≥ 3 wins  AND win-rate ≥ 55%
   *   silver  ≥ 7 wins  AND win-rate ≥ 55%
   *   gold    ≥ 15 wins AND win-rate ≥ 55%
   */
  calcContrarianBadge(wins: number, attempts: number): string | null {
    if (attempts < 3) return null;
    const rate = wins / attempts;
    if (rate < 0.55) return null;
    if (wins >= 15) return "gold";
    if (wins >= 7) return "silver";
    if (wins >= 3) return "bronze";
    return null;
  }

  /**
   * Called at settlement for a single position.
   * Records whether this bet was contrarian (against the Expert signal)
   * and updates the user's contrarian counters + badge tier.
   *
   * A bet is "contrarian" if the intelligence-weighted signal for the
   * chosen outcome was BELOW 50% at placement time (i.e. the user went
   * against what Expert consensus implied was the likely winner).
   */
  async recordContrarianOutcome(
    userId: string,
    predictedProbability: number | null,
    won: boolean,
  ): Promise<void> {
    // Only count as contrarian if they bet on an outcome the signal said < 50%
    if (predictedProbability == null || predictedProbability >= 0.5) return;

    const user = await this.userRepo.findOneBy({ id: userId });
    if (!user) return;

    const newAttempts = (user.contrarianAttempts ?? 0) + 1;
    const newWins = (user.contrarianWins ?? 0) + (won ? 1 : 0);
    const newBadge = this.calcContrarianBadge(newWins, newAttempts);

    const prevBadge = user.contrarianBadge;
    await this.userRepo.update(userId, {
      contrarianAttempts: newAttempts,
      contrarianWins: newWins,
      contrarianBadge: newBadge,
    });

    // Notify on badge earn or upgrade
    if (newBadge && newBadge !== prevBadge) {
      this.logger.log(
        `[Contrarian] User ${userId} earned badge: ${newBadge} (${newWins}/${newAttempts})`,
      );
    }
  }

  /**
   * Exponential decay factor based on days since last active prediction.
   * Half-life = DECAY_HALF_LIFE_DAYS.  Returns 1.0 for brand-new users.
   */
  private decayFactor(lastActiveAt: Date | null): number {
    if (!lastActiveAt) return 1.0;
    const daysSince =
      (Date.now() - lastActiveAt.getTime()) / (1000 * 60 * 60 * 24);
    return Math.exp((-Math.LN2 * daysSince) / this.DECAY_HALF_LIFE_DAYS);
  }

  /**
   * Calibration multiplier from Brier score.
   * A Brier of 0 (perfect) → 1.0×. A Brier of 0.5 (random) → 0.75×.
   * Range: [0.5, 1.0] for scores in [1, 0].
   */
  private calibrationMultiplier(brierScore: number | null): number {
    if (brierScore == null) return 1.0;
    return 1 - brierScore * 0.5;
  }

  /**
   * Returns the effective reputation score for a user in a given category.
   * Falls back to overall score if category has fewer than 5 predictions.
   */
  scoreForCategory(user: User, category: string): number {
    const cat = user.categoryScores?.[category];
    if (cat && cat.total >= 5) {
      return this.adjustedScore(cat.correct, cat.total, !!user.dkCid);
    }
    return user.reputationScore ?? (user.dkCid ? this.CID_PRIOR : 0.5);
  }
}
