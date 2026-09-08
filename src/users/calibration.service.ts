import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, In } from "typeorm";
import { User } from "../entities/user.entity";
import { Position, PositionStatus } from "../entities/position.entity";
import { FreeCall, FreeCallStatus } from "../entities/free-call.entity";

/** Ten-point probability buckets: 0–10%, 10–20%, … 90–100%. */
const BUCKET_COUNT = 10;

export interface CalibrationBucket {
  /** Bucket floor as a percent (0, 10, 20 …). */
  bucket: number;
  label: string;
  /** Mean probability the user actually assigned inside this bucket, 0–1. */
  predicted: number;
  /** Share of those calls that came true, 0–1. */
  actual: number;
  count: number;
}

export interface CalibrationRecord {
  /** Lower is better; 0 is perfect. Null until there is something to score. */
  brierScore: number | null;
  scored: number;
  correct: number;
  accuracy: number | null;
  curve: CalibrationBucket[];
}

export interface CalibrationProfile {
  userId: string;
  tier: string | null;
  /** Money on the line. */
  staked: CalibrationRecord;
  /** No stake. */
  free: CalibrationRecord;
  /**
   * Mean assigned probability minus realised accuracy across everything scored.
   * Positive means overconfident, negative means underconfident. Null until
   * there are enough observations for the number to mean anything.
   */
  confidenceGap: number | null;
  /** Plain-language read of the record. */
  verdict: string;
  strongestCategory: { category: string; accuracy: number; total: number } | null;
  weakestCategory: { category: string; accuracy: number; total: number } | null;
}

/** Below this, a calibration number is noise and is reported as such. */
const MIN_FOR_VERDICT = 10;

@Injectable()
export class CalibrationService {
  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Position)
    private readonly positionRepo: Repository<Position>,
    @InjectRepository(FreeCall)
    private readonly freeCallRepo: Repository<FreeCall>,
  ) {}

  /**
   * A user's accuracy record, as a thing to get better at.
   *
   * This is the retention mechanic that costs nothing and exploits nobody: "how
   * well do I actually understand the world" is intrinsically motivating,
   * improves with practice, and rewards being right rather than staking more.
   * The Brier score was already being computed for internal tiering — this
   * turns it into something the user owns.
   */
  async getProfile(userId: string): Promise<CalibrationProfile> {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: [
        "id",
        "reputationTier",
        "brierScore",
        "brierCount",
        "totalPredictions",
        "correctPredictions",
        "freeCallBrierScore",
        "freeCallCount",
        "freeCallCorrect",
        "categoryScores",
      ],
    });
    if (!user) throw new NotFoundException("User not found");

    const [stakedObs, freeObs] = await Promise.all([
      this.stakedObservations(userId),
      this.freeObservations(userId),
    ]);

    const staked: CalibrationRecord = {
      brierScore: user.brierScore != null ? Number(user.brierScore) : null,
      scored: user.totalPredictions ?? 0,
      correct: user.correctPredictions ?? 0,
      accuracy: user.totalPredictions
        ? parseFloat(
            ((user.correctPredictions ?? 0) / user.totalPredictions).toFixed(4),
          )
        : null,
      curve: this.buildCurve(stakedObs),
    };

    const free: CalibrationRecord = {
      brierScore:
        user.freeCallBrierScore != null
          ? Number(user.freeCallBrierScore)
          : null,
      scored: user.freeCallCount ?? 0,
      correct: user.freeCallCorrect ?? 0,
      accuracy: user.freeCallCount
        ? parseFloat(
            ((user.freeCallCorrect ?? 0) / user.freeCallCount).toFixed(4),
          )
        : null,
      curve: this.buildCurve(freeObs),
    };

    const all = [...stakedObs, ...freeObs];
    const confidenceGap = all.length
      ? parseFloat(
          (
            all.reduce((a, o) => a + o.probability, 0) / all.length -
            all.reduce((a, o) => a + (o.hit ? 1 : 0), 0) / all.length
          ).toFixed(4),
        )
      : null;

    const categories = Object.entries(user.categoryScores ?? {})
      .map(([category, s]) => ({
        category,
        total: s.total,
        accuracy: s.total ? parseFloat((s.correct / s.total).toFixed(4)) : 0,
      }))
      // One lucky call in a category is not a strength.
      .filter((c) => c.total >= 3)
      .sort((a, b) => b.accuracy - a.accuracy);

    return {
      userId: user.id,
      tier: user.reputationTier ?? null,
      staked,
      free,
      confidenceGap,
      verdict: this.verdict(all.length, confidenceGap),
      strongestCategory: categories[0] ?? null,
      weakestCategory:
        categories.length > 1 ? categories[categories.length - 1] : null,
    };
  }

  /** One scored staked prediction: the probability assigned, and whether it hit. */
  private async stakedObservations(
    userId: string,
  ): Promise<{ probability: number; hit: boolean }[]> {
    const rows = await this.positionRepo.find({
      where: {
        userId,
        status: In([PositionStatus.WON, PositionStatus.LOST]),
      },
      select: ["marketId", "status", "predictedProbability", "placedAt"],
      order: { placedAt: "ASC" },
    });

    // One market is one decision — mirrors ReputationService, where splitting a
    // stake across several bets must not inflate the observation count.
    const perMarket = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      if (r.predictedProbability == null) continue;
      perMarket.set(r.marketId, r);
    }

    return [...perMarket.values()].map((r) => ({
      probability: Number(r.predictedProbability),
      hit: r.status === PositionStatus.WON,
    }));
  }

  private async freeObservations(
    userId: string,
  ): Promise<{ probability: number; hit: boolean }[]> {
    const rows = await this.freeCallRepo.find({
      where: {
        userId,
        status: In([FreeCallStatus.CORRECT, FreeCallStatus.INCORRECT]),
      },
      select: ["status", "probabilityAtCall"],
    });
    return rows.map((r) => ({
      probability: Number(r.probabilityAtCall),
      hit: r.status === FreeCallStatus.CORRECT,
    }));
  }

  /**
   * The calibration curve: for calls made at ~70% confidence, how often was the
   * user right? A well-calibrated predictor's points sit on the diagonal.
   * Empty buckets are dropped rather than reported as 0% — no data is not the
   * same as being wrong.
   */
  private buildCurve(
    obs: { probability: number; hit: boolean }[],
  ): CalibrationBucket[] {
    const buckets = Array.from({ length: BUCKET_COUNT }, () => ({
      sumP: 0,
      hits: 0,
      count: 0,
    }));

    for (const o of obs) {
      const clamped = Math.min(Math.max(o.probability, 0), 1);
      // 1.0 belongs in the top bucket, not an eleventh one.
      const idx = Math.min(Math.floor(clamped * BUCKET_COUNT), BUCKET_COUNT - 1);
      buckets[idx].sumP += clamped;
      buckets[idx].hits += o.hit ? 1 : 0;
      buckets[idx].count += 1;
    }

    return buckets
      .map((b, i) => ({
        bucket: i * 10,
        label: `${i * 10}–${(i + 1) * 10}%`,
        predicted: b.count ? parseFloat((b.sumP / b.count).toFixed(4)) : 0,
        actual: b.count ? parseFloat((b.hits / b.count).toFixed(4)) : 0,
        count: b.count,
      }))
      .filter((b) => b.count > 0);
  }

  private verdict(observations: number, gap: number | null): string {
    if (observations === 0) {
      return "No scored calls yet. Your accuracy record starts with your first one.";
    }
    if (observations < MIN_FOR_VERDICT || gap == null) {
      return `${observations} scored call${observations === 1 ? "" : "s"} so far — ` +
        `${MIN_FOR_VERDICT} is where calibration starts to mean something.`;
    }
    if (gap > 0.1) {
      return "You back your calls harder than the results justify — reading the same, staked lower, would score better.";
    }
    if (gap < -0.1) {
      return "You are right more often than you back yourself for. Your reads are better than your confidence in them.";
    }
    return "Well calibrated — when you say 70%, it lands about 70% of the time.";
  }
}
