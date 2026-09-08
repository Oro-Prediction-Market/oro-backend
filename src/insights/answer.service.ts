import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Market, MarketStatus } from "../entities/market.entity";
import { Position } from "../entities/position.entity";
import { FreeCall } from "../entities/free-call.entity";
import {
  ProbabilityHistoryService,
  OutcomeHistory,
} from "./probability-history.service";

export interface AnswerOutcome {
  outcomeId: string;
  label: string;
  /** 0–1. */
  probability: number;
  /** Rounded whole percent, for the headline and share text. */
  percent: number;
  isWinner: boolean;
}

export interface MarketAnswer {
  marketId: string;
  question: string;
  category: string;
  status: MarketStatus;
  /** The one-line answer: "Oro says 73%" — the leading outcome, or the result. */
  headline: string;
  /** Short share/OG description. */
  summary: string;
  settled: boolean;
  /**
   * False when the market carries no crowd view at all (unfunded, all
   * probabilities zero). The client should render "no answer yet" rather than a
   * row of 0% bars.
   */
  hasAnswer: boolean;
  outcomes: AnswerOutcome[];
  /** Movement over the last 24h for the leading outcome, in probability points. */
  change24h: number | null;
  resolutionCriteria: string | null;
  evidenceUrl: string | null;
  evidenceNote: string | null;
  closesAt: Date | null;
  resolvedAt: Date | null;
  totalPool: number;
  /** Distinct people who have taken a side — stakers plus free callers. */
  predictorCount: number;
  history: OutcomeHistory[];
}

@Injectable()
export class AnswerService {
  constructor(
    @InjectRepository(Market) private readonly marketRepo: Repository<Market>,
    @InjectRepository(Position)
    private readonly positionRepo: Repository<Position>,
    @InjectRepository(FreeCall)
    private readonly freeCallRepo: Repository<FreeCall>,
    private readonly history: ProbabilityHistoryService,
  ) {}

  /**
   * The public, no-login answer to one question.
   *
   * This is the page a link resolves to and the payload a share card renders
   * from: the number, how it got there, and — the part that makes it citable —
   * exactly what will decide it and what evidence settled it.
   */
  async getAnswer(marketId: string): Promise<MarketAnswer> {
    const market = await this.marketRepo.findOne({
      where: { id: marketId },
      relations: ["outcomes"],
    });
    if (!market) throw new NotFoundException("Market not found");

    const outcomes: AnswerOutcome[] = (market.outcomes ?? [])
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((o) => {
        const probability = Number(o.lmsrProbability);
        return {
          outcomeId: o.id,
          label: o.label,
          probability,
          percent: Math.round(probability * 100),
          isWinner: o.isWinner,
        };
      });

    const settled =
      market.status === MarketStatus.RESOLVED ||
      market.status === MarketStatus.SETTLED;

    // An unfunded market carries zeroes, not a distribution: the auto-created
    // TER/BTC markets sit at 0 for every outcome until the first stake lands.
    // Reporting "Oro says 0% UP" there states a crowd view that does not exist
    // — worse than saying nothing, because a reader cannot tell it apart from a
    // genuine 0% call. Anything that does not sum to roughly 1 is treated as no
    // answer at all.
    const probabilityMass = outcomes.reduce((a, o) => a + o.probability, 0);
    const hasAnswer = outcomes.length > 0 && probabilityMass > 0.5;

    const leader = hasAnswer
      ? outcomes.reduce<AnswerOutcome | null>(
          (best, o) => (!best || o.probability > best.probability ? o : best),
          null,
        )
      : null;
    const winner = outcomes.find((o) => o.isWinner) ?? null;

    const [history, predictorCount] = await Promise.all([
      this.history.getHistory(marketId, { hours: 24 * 90 }),
      this.countPredictors(marketId),
    ]);

    // 24h movement for whichever outcome the headline is about.
    const focus = settled ? winner : leader;
    const change24h = focus
      ? this.changeOverWindow(history, focus.outcomeId, 24)
      : null;

    const headline = settled
      ? winner
        ? `Resolved: ${winner.label}`
        : "Resolved"
      : leader
        ? `Oro says ${leader.percent}% ${leader.label}`
        : "No answer yet";

    const summary = settled
      ? winner
        ? `${market.title} — resolved ${winner.label}.`
        : `${market.title} — resolved.`
      : leader
        ? `${predictorCount} predictor${predictorCount === 1 ? "" : "s"} put ` +
          `${leader.label} at ${leader.percent}%.`
        : `${market.title} — open, nobody has taken a side yet.`;

    return {
      marketId: market.id,
      question: market.title,
      category: String(market.category),
      status: market.status,
      headline,
      summary,
      settled,
      hasAnswer,
      outcomes,
      change24h,
      resolutionCriteria: market.resolutionCriteria ?? null,
      evidenceUrl: market.evidenceUrl ?? null,
      evidenceNote: market.evidenceNote ?? null,
      closesAt: market.closesAt ?? null,
      resolvedAt: market.resolvedAt ?? null,
      totalPool: Number(market.totalPool ?? 0),
      predictorCount,
      history,
    };
  }

  /**
   * Everyone who has taken a side, stake or no stake. Free callers count: they
   * are participants in the forecast even though they have no money on it.
   */
  private async countPredictors(marketId: string): Promise<number> {
    const [staked, free] = await Promise.all([
      this.positionRepo
        .createQueryBuilder("p")
        .select("COUNT(DISTINCT p.userId)", "c")
        .where("p.marketId = :marketId", { marketId })
        .getRawOne<{ c: string }>()
        .then((r) => Number(r?.c ?? 0))
        .catch(() => 0),
      this.freeCallRepo
        .createQueryBuilder("f")
        .select("COUNT(DISTINCT f.userId)", "c")
        .where("f.marketId = :marketId", { marketId })
        .getRawOne<{ c: string }>()
        .then((r) => Number(r?.c ?? 0))
        .catch(() => 0),
    ]);
    // Someone with both a stake and a free call is double-counted here at worst
    // by one; free calls are blocked once a stake exists, so in practice the
    // sets are disjoint.
    return staked + free;
  }

  /** Signed probability-point change for one outcome over the last N hours. */
  private changeOverWindow(
    history: OutcomeHistory[],
    outcomeId: string,
    hours: number,
  ): number | null {
    const series = history.find((h) => h.outcomeId === outcomeId);
    if (!series || series.points.length < 2) return null;
    const since = Date.now() - hours * 3600_000;
    const inWindow = series.points.filter(
      (p) => new Date(p.capturedAt).getTime() >= since,
    );
    // Anchor on the last point before the window when there is one, so a market
    // whose only movement predates the window still reports 0 rather than null.
    const anchor =
      inWindow.length >= 2
        ? inWindow[0]
        : series.points[series.points.length - 2];
    const latest = series.points[series.points.length - 1];
    if (!anchor || !latest) return null;
    return Number((latest.probability - anchor.probability).toFixed(6));
  }
}
