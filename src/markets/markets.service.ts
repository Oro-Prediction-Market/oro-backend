import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";
import { Repository, DataSource } from "typeorm";
import { RedisService } from "../redis/redis.service";
import { CreateMarketDto } from "./dto/create-market.dto";
import { UpdateMarketDto } from "./dto/update-market.dto";
import { OpenPositionDto } from "./dto/open-position.dto";
import { SubmitDisputeDto } from "./dto/submit-dispute.dto";
import {
  Market,
  MarketStatus,
  MarketMechanism,
  MarketCategory,
} from "../entities/market.entity";
import { Outcome } from "../entities/outcome.entity";
import { Dispute } from "../entities/dispute.entity";
import { DisputeBondStatus } from "../entities/dispute.entity";
import { Position, PositionStatus } from "../entities/position.entity";
import { User } from "../entities/user.entity";
import { Transaction, TransactionType } from "../entities/transaction.entity";
import { ParimutuelEngine } from "./parimutuel.engine";
import { LMSRService } from "./lmsr.service";
import { ReputationService } from "./reputation.service";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";
export { CreateMarketDto } from "./dto/create-market.dto";
export { UpdateMarketDto } from "./dto/update-market.dto";
export { OpenPositionDto } from "./dto/open-position.dto";
export { SubmitDisputeDto } from "./dto/submit-dispute.dto";

@Injectable()
export class MarketsService {
  constructor(
    @InjectRepository(Market) private marketRepo: Repository<Market>,
    @InjectRepository(Outcome) private outcomeRepo: Repository<Outcome>,
    @InjectRepository(Dispute) private disputeRepo: Repository<Dispute>,
    @InjectRepository(User) private userRepo: Repository<User>,
    private engine: ParimutuelEngine,
    private lmsrService: LMSRService,
    @InjectDataSource() private dataSource: DataSource,
    private redis: RedisService,
    private reputationService: ReputationService,
    private telegram: TelegramSimpleService,
  ) {}

  /**
   * Returns the last N position events for the live activity ticker.
   * Each item has enough info to render "Tashi just bet Nu 200 on Yes in <market>"
   * or "Karma won Nu 450 on Germany in <market>".
   *
   * Returns both pending (bets) and won (payouts) positions so the ticker
   * shows a mix of activity.
   */
  async getRecentActivity(limit = 20): Promise<
    {
      type: "bet" | "win";
      userName: string;
      outomeLabel: string;
      marketTitle: string;
      amount: number;
      placedAt: Date;
    }[]
  > {
    const positions = await this.dataSource
      .getRepository(Position)
      .createQueryBuilder("p")
      .leftJoinAndSelect("p.user", "u")
      .leftJoinAndSelect("p.outcome", "o")
      .leftJoinAndSelect("p.market", "m")
      .where("p.status IN (:...statuses)", { statuses: ["pending", "won"] })
      .orderBy("p.placedAt", "DESC")
      .limit(limit)
      .getMany();

    return positions.map((p) => {
      const displayName = p.user?.username
        ? `@${p.user.username}`
        : p.user?.firstName
          ? p.user.firstName
          : "Someone";

      return {
        type: p.status === "won" ? "win" : "bet",
        userName: displayName,
        outomeLabel: p.outcome?.label ?? "an outcome",
        marketTitle: p.market?.title ?? "a market",
        amount: Number(p.status === "won" ? (p.payout ?? p.amount) : p.amount),
        placedAt: p.placedAt,
      };
    });
  }

  private async invalidateMarketCache(marketId?: string): Promise<void> {
    const keys = ["oro:cache:markets:all"];
    if (marketId) keys.push(`oro:cache:market:${marketId}`);
    await this.redis.del(...keys);
  }

  async create(dto: CreateMarketDto): Promise<Market> {
    if (!dto.outcomes || !Array.isArray(dto.outcomes)) {
      throw new Error("Outcomes are required and must be an array");
    }

    try {
      // 1. Create outcome objects and initialize them
      const outcomes = dto.outcomes.map((item) =>
        this.outcomeRepo.create({
          label: typeof item === "string" ? item : item.label,
          imageUrl: typeof item === "string" ? null : (item.imageUrl ?? null),
          totalBetAmount: 0,
          currentOdds: 0,
          lmsrProbability: 0,
          isWinner: false,
        }),
      );

      // 2. Calculate initial LMSR probabilities
      const liquidityParam = Number(dto.liquidityParam ?? 1000);
      const initialProbs = this.lmsrService.calculateProbabilities(
        outcomes,
        liquidityParam,
      );
      outcomes.forEach((o, i) => {
        o.lmsrProbability = initialProbs[i];
      });

      // 3. Create market and link outcomes (cascade will handle saving them)
      const market = this.marketRepo.create({
        title: dto.title,
        description: dto.description,
        imageUrl: dto.imageUrl,
        imageUrlAlt: dto.imageUrlAlt,
        resolutionCriteria: dto.resolutionCriteria ?? undefined,
        opensAt: dto.opensAt ? new Date(dto.opensAt) : undefined,
        closesAt: dto.closesAt ? new Date(dto.closesAt) : undefined,
        houseEdgePct: dto.houseEdgePct ?? 8,
        mechanism: MarketMechanism.PARIMUTUEL,
        liquidityParam: liquidityParam,
        outcomes: outcomes,
        totalPool: 0,
        status: MarketStatus.UPCOMING,
        externalMatchId: dto.externalMatchId ?? null,
        externalSource: dto.externalSource ?? null,
        externalMarketType: dto.externalMarketType ?? null,
      });

      const saved = await this.marketRepo.save(market);
      await this.invalidateMarketCache();
      const full = await this.findOne(saved.id);
      this.telegram
        .postToChannel(
          `New market: <b>${full.title}</b>\nCloses: ${new Date(full.closesAt).toLocaleString()}\nOutcomes: ${full.outcomes.map((o) => o.label).join(" vs ")}`,
        )
        .catch(() => undefined);
      return full;
    } catch (err) {
      console.error("❌ Error in MarketsService.create:", err);
      throw err;
    }
  }

  async findAll(q?: string): Promise<Market[]> {
    const cacheKey = q
      ? `oro:cache:markets:search:${q.toLowerCase().trim()}`
      : "oro:cache:markets:all";
    const cached = await this.redis.getJson<Market[]>(cacheKey);
    if (cached) return cached;

    const qb = this.marketRepo
      .createQueryBuilder("market")
      .leftJoinAndSelect("market.outcomes", "outcome")
      .orderBy("market.createdAt", "DESC");

    if (q && q.trim()) {
      const safe = q
        .trim()
        .toLowerCase()
        .replace(/[%_\\]/g, "\\$&");
      const term = `%${safe}%`;
      qb.where(
        "LOWER(market.title) LIKE :term ESCAPE '\\' OR LOWER(market.description) LIKE :term ESCAPE '\\'",
        { term },
      );
    }

    const markets = await qb.getMany();
    // Attach reputation signal to each market's outcomes (fire in parallel)
    await Promise.all(markets.map((m) => this.attachSignal(m)));
    await this.redis.setJsonEx(cacheKey, 30, markets);
    return markets;
  }

  async findOne(id: string): Promise<Market> {
    const cacheKey = `oro:cache:market:${id}`;
    const cached = await this.redis.getJson<Market>(cacheKey);
    if (cached) return cached;
    const market = await this.marketRepo.findOne({
      where: { id },
      relations: ["outcomes"],
    });
    if (!market) throw new NotFoundException("Market not found");
    await this.attachSignal(market);
    await this.redis.setJsonEx(cacheKey, 30, market);
    return market;
  }

  /**
   * Attaches reputationSignal (0–1) to each outcome in-place, and attaches
   * signalMeta (composite confidence dimensions) to the market itself.
   * Signal is null when there are fewer than 3 unique bettors.
   */
  private async attachSignal(market: Market): Promise<void> {
    if (!market.outcomes?.length || Number(market.totalPool) === 0) return;
    const ids = market.outcomes.map((o) => o.id);
    const [signal, signalMeta, weightedShares] = await Promise.all([
      this.reputationService.computeMarketSignal(
        market.id,
        ids,
        market.category,
      ),
      this.reputationService.computeSignalConfidence(
        market.id,
        market.category,
      ),
      this.reputationService.computeReputationWeightedShares(market.id),
    ]);

    // Reputation-weighted LMSR probabilities (Feature 1)
    // Run LMSR on effective shares keyed by outcome order
    const b = Number(market.liquidityParam) || 1000;
    const effectiveAmounts = ids.map((id) => weightedShares[id] ?? 0);
    const hasWeightedData = effectiveAmounts.some((a) => a > 0);
    let repWeightedProbs: number[] = [];
    if (hasWeightedData) {
      const maxA = Math.max(...effectiveAmounts);
      const exps = effectiveAmounts.map((a) => Math.exp((a - maxA) / b));
      const sumExp = exps.reduce((s, e) => s + e, 0);
      repWeightedProbs = exps.map((e) => parseFloat((e / sumExp).toFixed(6)));
    }

    for (let i = 0; i < market.outcomes.length; i++) {
      const outcome = market.outcomes[i];
      (outcome as any).reputationSignal =
        signal[outcome.id] != null ? signal[outcome.id] : null;
      // intelligenceProb: rep-weighted LMSR (null when no data)
      (outcome as any).intelligenceProb = hasWeightedData
        ? repWeightedProbs[i]
        : null;
    }
    (market as any).signalMeta = signalMeta;
  }

  async update(id: string, dto: UpdateMarketDto): Promise<Market> {
    const market = await this.findOne(id);

    if (dto.title !== undefined) market.title = dto.title;
    if (dto.description !== undefined) market.description = dto.description;
    if (dto.category !== undefined)
      market.category = dto.category as MarketCategory;
    if (dto.imageUrl !== undefined) market.imageUrl = dto.imageUrl;
    if (dto.imageUrlAlt !== undefined) market.imageUrlAlt = dto.imageUrlAlt;
    if (dto.resolutionCriteria !== undefined)
      market.resolutionCriteria = dto.resolutionCriteria;
    if (dto.opensAt) market.opensAt = new Date(dto.opensAt);
    if (dto.closesAt) market.closesAt = new Date(dto.closesAt);
    if (dto.houseEdgePct !== undefined) market.houseEdgePct = dto.houseEdgePct;
    if (dto.liquidityParam !== undefined)
      market.liquidityParam = dto.liquidityParam;

    // Rename outcome labels matched by ID — order-independent, safe
    if (dto.outcomes && dto.outcomes.length > 0) {
      // Validate shape: each element must be { id: string, label: string }
      for (const item of dto.outcomes) {
        if (
          typeof item !== "object" ||
          typeof item.id !== "string" ||
          typeof item.label !== "string"
        ) {
          throw new BadRequestException(
            "Each outcome must be an object with { id: string, label: string }",
          );
        }
      }
      const existing = await this.outcomeRepo.find({
        where: { marketId: id },
      });
      if (dto.outcomes.length !== existing.length) {
        throw new BadRequestException(
          `outcomes array length (${dto.outcomes.length}) must match existing outcome count (${existing.length})`,
        );
      }
      await Promise.all(
        dto.outcomes.map((rename) => {
          const outcome = existing.find((o) => o.id === rename.id);
          if (!outcome)
            throw new BadRequestException(
              `Outcome id "${rename.id}" does not belong to market "${id}"`,
            );
          outcome.label = rename.label;
          if ("imageUrl" in rename) outcome.imageUrl = rename.imageUrl ?? null;
          return this.outcomeRepo.save(outcome);
        }),
      );
      // Sync market.outcomes with the updated entities so the cascade save
      // in marketRepo.save() below does not overwrite the new labels.
      market.outcomes = existing;
    }

    const saved = await this.marketRepo.save(market);
    await this.invalidateMarketCache(id);
    return saved;
  }

  async placeBet(userId: string, marketId: string, dto: OpenPositionDto) {
    return this.engine.placePosition(
      userId,
      marketId,
      dto.outcomeId,
      dto.amount,
    );
    // cache invalidation handled inside ParimutuelEngine.placeBet
  }

  async transition(marketId: string, to: MarketStatus) {
    const result = await this.engine.transitionMarket(marketId, to);
    await this.invalidateMarketCache(marketId);
    return result;
  }

  async proposeResolution(
    marketId: string,
    proposedOutcomeId: string,
    windowMinutes: number = 60,
  ) {
    const result = await this.engine.proposeResolution(
      marketId,
      proposedOutcomeId,
      windowMinutes,
    );
    await this.invalidateMarketCache(marketId);
    return result;
  }

  async resolve(
    marketId: string,
    winningOutcomeId: string,
    adminId?: string,
    evidenceUrl?: string,
    evidenceNote?: string,
  ) {
    const market = await this.marketRepo.findOne({ where: { id: marketId } });
    const result = await this.engine.resolveMarket(
      marketId,
      winningOutcomeId,
      adminId,
      evidenceUrl,
      evidenceNote,
    );
    await this.invalidateMarketCache(marketId);
    if (market) {
      const winner = market.outcomes?.find((o: any) => o.id === winningOutcomeId);
      this.telegram
        .postToChannel(
          `✅ <b>Market Resolved: ${market.title}</b>\n\nWinner: <b>${winner?.label ?? winningOutcomeId}</b>`,
        )
        .catch(() => undefined);
    }
    return result;
  }

  async cancel(marketId: string) {
    // Load market + affected positions BEFORE cancelling so we can notify bettors
    const market = await this.marketRepo.findOne({
      where: { id: marketId },
    });

    // Collect all pending positions for this market to know who to notify
    const pendingPositions = market
      ? await this.dataSource
          .getRepository(Position)
          .createQueryBuilder("p")
          .innerJoinAndSelect("p.user", "u")
          .where("p.marketId = :marketId", { marketId })
          .andWhere("p.status = :status", { status: PositionStatus.PENDING })
          .getMany()
      : [];

    const result = await this.engine.cancelMarket(marketId);
    await this.invalidateMarketCache(marketId);

    if (market) {
      // 1. Channel announcement
      this.telegram
        .postToChannel(
          `❌ <b>Market Cancelled: ${market.title}</b>\n\nAll pending bets have been fully refunded.`,
        )
        .catch(() => undefined);

      // 2. Individual DM to every unique bettor whose position was refunded
      const seenUsers = new Set<string>();
      for (const pos of pendingPositions) {
        const user = (pos as any).user as User | undefined;
        if (!user?.telegramId || seenUsers.has(user.id)) continue;
        seenUsers.add(user.id);
        this.telegram
          .sendMessage(
            Number(user.telegramId),
            `❌ <b>Market Cancelled</b>\n\n` +
              `📊 <b>${market.title}</b>\n\n` +
              `Your bet of <b>Nu ${Number(pos.amount).toLocaleString()}</b> has been fully refunded to your balance.`,
          )
          .catch(() => undefined);
      }
    }

    return result;
  }

  // ─── Dispute / Objection System ─────────────────────────────────────────────
  // Objectors must lock a bond equal to their full position in this market.
  // ✓ Correct objection  → bond returned + pro-rata share of the forfeit pool
  // ✗ Wrong objection    → bond forfeited to reward pool for correct objectors
  // ○ Auto-settled (0 objections) → bonds irrelevant, no deductions ever

  // Fixed dispute bond — high enough to deter casual/abusive objections
  // while still being accessible to bettors with genuine grievances.
  private static readonly DISPUTE_BOND = 5_000;

  private calcBond(_positionAmount: number): number {
    return MarketsService.DISPUTE_BOND;
  }

  /**
   * File an objection against the proposed outcome.
   * Only bettors with an active position can object.
   * A bond of max(10, 2% of position) is locked immediately.
   * Bond is forfeited if wrong, or returned + rewarded if right.
   */
  async submitDispute(
    userId: string,
    marketId: string,
    dto: SubmitDisputeDto,
  ): Promise<Dispute & { bondAmount: number; bondNote: string }> {
    const market = await this.findOne(marketId);

    if (market.status !== MarketStatus.RESOLVING)
      throw new BadRequestException(
        "Objections can only be raised during the resolution window",
      );

    if (market.disputeDeadlineAt && new Date() > market.disputeDeadlineAt)
      throw new BadRequestException(
        "The objection window for this market has closed",
      );

    // Must hold an active position to object
    const position = await this.dataSource.getRepository(Position).findOne({
      where: { userId, marketId, status: PositionStatus.PENDING },
    });
    if (!position)
      throw new BadRequestException(
        "You must have an active position in this market to raise an objection",
      );

    // One objection per user per market
    const alreadyObjected = await this.disputeRepo.findOne({
      where: { userId, marketId },
    });
    if (alreadyObjected)
      throw new BadRequestException(
        "You have already raised an objection for this market",
      );

    const bondAmount = this.calcBond(Number(position.amount));

    // Lock the bond in a single DB transaction
    const saved = await this.dataSource.transaction(async (em) => {
      const user = await em.findOne(User, { where: { id: userId } });
      if (!user) throw new BadRequestException("User not found");

      const { balance } = await em
        .getRepository(Transaction)
        .createQueryBuilder("t")
        .select("COALESCE(SUM(t.amount), 0)", "balance")
        .where("t.userId = :userId", { userId })
        .getRawOne();
      const currentBalance = Number(balance);

      if (currentBalance < bondAmount)
        throw new BadRequestException(
          `You need at least Nu ${bondAmount.toLocaleString()} available to raise an objection. ` +
            `This bond is non-refundable if the admin upholds their decision. ` +
            `Your current balance is Nu ${currentBalance.toFixed(0)}.`,
        );

      // Deduct the bond
      const txn = em.getRepository(Transaction).create({
        userId,
        type: TransactionType.DISPUTE_BOND_LOCK,
        amount: -bondAmount,
        balanceBefore: currentBalance,
        balanceAfter: currentBalance - bondAmount,
        note: `Bond locked for objection on market "${market.title}"`,
      });
      await em.getRepository(Transaction).save(txn);

      const dispute = em.getRepository(Dispute).create({
        userId,
        marketId,
        reason: dto.reason,
        upheld: null,
        bondAmount,
        bondStatus: DisputeBondStatus.LOCKED,
      });
      return em.getRepository(Dispute).save(dispute);
    });

    // Bust balance cache
    await this.redis.del(`oro:cache:balance:${userId}`);

    // Notify admin channel
    this.telegram
      .postToChannel(
        `⚠️ <b>New Objection — Bond Locked</b>\n` +
          `Market: <i>${market.title}</i>\n` +
          `User: ${userId}\n` +
          `Bond: <b>Nu ${bondAmount}</b>\n` +
          `Reason: ${dto.reason.slice(0, 200)}`,
      )
      .catch(() => undefined);

    await this.invalidateMarketCache(marketId);
    return {
      ...saved,
      bondAmount,
      bondNote: `Nu ${bondAmount.toLocaleString()} has been locked as a bond. You will get it back (plus a reward) if the admin agrees the outcome was wrong. If the admin upholds their decision, you lose the bond.`,
    };
  }

  async getResolvedMarkets(): Promise<object[]> {
    const markets = await this.marketRepo
      .createQueryBuilder("market")
      .leftJoinAndSelect("market.outcomes", "outcome")
      .where("market.status IN (:...statuses)", {
        statuses: [MarketStatus.RESOLVED, MarketStatus.SETTLED],
      })
      .orderBy("market.resolvedAt", "DESC")
      .getMany();

    if (!markets.length) return [];

    // Single query to get participant counts for all markets at once (avoids N+1)
    const marketIds = markets.map((m) => m.id);
    const participantRows: { marketId: string; count: string }[] =
      await this.dataSource
        .getRepository(Position)
        .createQueryBuilder("p")
        .select("p.marketId", "marketId")
        .addSelect("COUNT(DISTINCT p.userId)", "count")
        .where("p.marketId IN (:...marketIds)", { marketIds })
        .groupBy("p.marketId")
        .getRawMany();

    const participantMap = new Map(
      participantRows.map((r) => [r.marketId, Number(r.count)]),
    );

    // Objection counts per market
    const objectionRows: { marketId: string; count: string }[] =
      await this.dataSource
        .getRepository(Dispute)
        .createQueryBuilder("d")
        .select("d.marketId", "marketId")
        .addSelect("COUNT(*)", "count")
        .where("d.marketId IN (:...marketIds)", { marketIds })
        .groupBy("d.marketId")
        .getRawMany();
    const objectionMap = new Map(
      objectionRows.map((r) => [r.marketId, Number(r.count)]),
    );

    return markets.map((m) => {
      const winner =
        m.outcomes.find((o) => o.id === m.resolvedOutcomeId) ?? null;
      const outcomeChanged =
        !!m.proposedOutcomeId && m.resolvedOutcomeId !== m.proposedOutcomeId;
      return {
        id: m.id,
        title: m.title,
        description: m.description,
        imageUrl: m.imageUrl,
        imageUrlAlt: m.imageUrlAlt,
        category: m.category,
        status: m.status,
        totalPool: m.totalPool,
        resolutionCriteria: m.resolutionCriteria ?? null,
        createdAt: m.createdAt,
        opensAt: m.opensAt,
        closesAt: m.closesAt,
        resolvedAt: m.resolvedAt,
        participantCount: participantMap.get(m.id) ?? 0,
        winner: winner ? { id: winner.id, label: winner.label } : null,
        objectionCount: objectionMap.get(m.id) ?? 0,
        outcomeChanged,
        evidence: {
          url: m.evidenceUrl ?? null,
          note: m.evidenceNote ?? null,
          submittedAt: m.evidenceSubmittedAt ?? null,
        },
      };
    });
  }

  /**
   * Public resolution transparency log.
   * Returns every settled/resolved market with full evidence, objection counts,
   * and whether the final decision matched the original proposal.
   * Used by the public "Resolution Log" dashboard in the TMA.
   */
  async getResolutionLog(): Promise<object[]> {
    const markets = await this.marketRepo
      .createQueryBuilder("market")
      .leftJoinAndSelect("market.outcomes", "outcome")
      .where("market.status IN (:...statuses)", {
        statuses: [MarketStatus.RESOLVED, MarketStatus.SETTLED],
      })
      .orderBy("market.resolvedAt", "DESC")
      .getMany();

    if (!markets.length) return [];

    const marketIds = markets.map((m) => m.id);

    // Participant counts
    const participantRows: { marketId: string; count: string }[] =
      await this.dataSource
        .getRepository(Position)
        .createQueryBuilder("p")
        .select("p.marketId", "marketId")
        .addSelect("COUNT(DISTINCT p.userId)", "count")
        .where("p.marketId IN (:...marketIds)", { marketIds })
        .groupBy("p.marketId")
        .getRawMany();
    const participantMap = new Map(
      participantRows.map((r) => [r.marketId, Number(r.count)]),
    );

    // Objection counts per market
    const objectionRows: { marketId: string; count: string }[] =
      await this.dataSource
        .getRepository(Dispute)
        .createQueryBuilder("d")
        .select("d.marketId", "marketId")
        .addSelect("COUNT(*)", "count")
        .where("d.marketId IN (:...marketIds)", { marketIds })
        .groupBy("d.marketId")
        .getRawMany();
    const objectionMap = new Map(
      objectionRows.map((r) => [r.marketId, Number(r.count)]),
    );

    // Upheld objection counts (objector was right = admin changed outcome)
    const upheldRows: { marketId: string; count: string }[] =
      await this.dataSource
        .getRepository(Dispute)
        .createQueryBuilder("d")
        .select("d.marketId", "marketId")
        .addSelect("COUNT(*)", "count")
        .where("d.marketId IN (:...marketIds)", { marketIds })
        .andWhere("d.upheld = true")
        .groupBy("d.marketId")
        .getRawMany();
    const upheldMap = new Map(
      upheldRows.map((r) => [r.marketId, Number(r.count)]),
    );

    return markets.map((m) => {
      const winner =
        m.outcomes.find((o) => o.id === m.resolvedOutcomeId) ?? null;
      const proposed =
        m.outcomes.find((o) => o.id === m.proposedOutcomeId) ?? null;
      const objections = objectionMap.get(m.id) ?? 0;
      const upheld = upheldMap.get(m.id) ?? 0;
      const outcomeChanged =
        !!m.proposedOutcomeId && m.resolvedOutcomeId !== m.proposedOutcomeId;

      return {
        id: m.id,
        title: m.title,
        description: m.description,
        category: m.category,
        status: m.status,
        totalPool: Number(m.totalPool),
        participantCount: participantMap.get(m.id) ?? 0,
        opensAt: m.opensAt,
        closesAt: m.closesAt,
        resolvedAt: m.resolvedAt,
        windowMinutes: m.windowMinutes ?? 60,
        // Transparency fields
        proposedOutcome: proposed
          ? { id: proposed.id, label: proposed.label }
          : null,
        winner: winner ? { id: winner.id, label: winner.label } : null,
        outcomeChanged, // true = admin overrode their own proposal after objections
        objectionCount: objections,
        uppheldObjectionCount: upheld,
        resolutionCriteria: m.resolutionCriteria ?? null,
        evidence: {
          url: m.evidenceUrl ?? null,
          note: m.evidenceNote ?? null,
          submittedAt: m.evidenceSubmittedAt ?? null,
        },
        resolvedBySystem: !m.resolvedByAdminId, // true = auto-settled by cron (zero objections)
      };
    });
  }

  getDisputesByMarket(marketId: string): Promise<Dispute[]> {
    return this.disputeRepo.find({
      where: { marketId },
      order: { createdAt: "DESC" },
    });
  }

  /** Returns objection count, window info, and the bond cost for this user to object. */
  async getDisputeInfo(
    marketId: string,
    userId?: string,
  ): Promise<{
    objectionCount: number;
    windowOpen: boolean;
    windowClosesAt: Date | null;
    windowMinutes: number;
    canObject: boolean;
    bondRequired: number | null;
    bondNote: string;
  }> {
    const market = await this.findOne(marketId);
    const objectionCount = await this.disputeRepo.count({
      where: { marketId },
    });
    const now = new Date();
    const windowOpen =
      market.status === MarketStatus.RESOLVING &&
      !!market.disputeDeadlineAt &&
      now < market.disputeDeadlineAt;

    let bondRequired: number | null = null;
    if (userId && windowOpen) {
      const position = await this.dataSource.getRepository(Position).findOne({
        where: { userId, marketId, status: PositionStatus.PENDING },
      });
      if (position) {
        bondRequired = this.calcBond(Number(position.amount));
      }
    }

    return {
      objectionCount,
      windowOpen,
      windowClosesAt: market.disputeDeadlineAt ?? null,
      windowMinutes: market.windowMinutes ?? 60,
      canObject: windowOpen,
      bondRequired,
      bondNote:
        bondRequired !== null
          ? `Raising an objection requires a Nu ${bondRequired.toLocaleString()} bond. ` +
            `You get it back + a reward share if the admin agrees with you. ` +
            `You lose it if the admin upholds their original decision.`
          : `Raising an objection requires a fixed Nu ${MarketsService.DISPUTE_BOND.toLocaleString()} bond. ` +
            `Returned + rewarded if correct, forfeited if wrong.`,
    };
  }

  async delete(id: string): Promise<void> {
    const market = await this.findOne(id);
    await this.marketRepo.remove(market);
    await this.invalidateMarketCache(id);
  }
}
