import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  OnModuleInit,
} from "@nestjs/common";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";
import { Repository, DataSource, In } from "typeorm";
import { RedisService } from "../redis/redis.service";
import { randomUUID } from "crypto";
import { CreateMarketDto } from "./dto/create-market.dto";
import { DEFAULT_HOUSE_EDGE_PCT } from "./fee.constants";
import { isEplUclSubcategory } from "./market-notify.util";
import { CreateMarketGroupDto } from "./dto/create-market-group.dto";
import { UpdateMarketDto } from "./dto/update-market.dto";
import { UpdateMarketGroupDto } from "./dto/update-market-group.dto";
import { OpenPositionDto } from "./dto/open-position.dto";
import { SubmitDisputeDto } from "./dto/submit-dispute.dto";
import { ReopenMarketDto } from "./dto/reopen-market.dto";
import {
  Market,
  MarketStatus,
  MarketMechanism,
  MarketCategory,
} from "../entities/market.entity";
import { Settlement } from "../entities/settlement.entity";
import { Outcome } from "../entities/outcome.entity";
import { Dispute } from "../entities/dispute.entity";
import { DisputeBondStatus, DisputeSide } from "../entities/dispute.entity";
import { Position, PositionStatus } from "../entities/position.entity";
import { User } from "../entities/user.entity";
import { MarketBook } from "../entities/market-book.entity";
import { OutcomeBook } from "../entities/outcome-book.entity";
import { btnMinStakeFor, usdtMinStake } from "./market-book.util";
import { BTN_CURRENCY } from "../shared/utils/money.util";
import { USDT as USDT_CURRENCY } from "../shared/utils/wallet.util";
import { Transaction, TransactionType } from "../entities/transaction.entity";
import { ParimutuelEngine } from "./parimutuel.engine";
import { LMSRService } from "./lmsr.service";
import { ledgerBalanceForAccount } from "../shared/utils/ledger.util";
import { ReputationService } from "./reputation.service";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";
import { bracketAdvance, WC_KICKOFFS } from "./wc-knockout";
export { CreateMarketDto } from "./dto/create-market.dto";
export { UpdateMarketDto } from "./dto/update-market.dto";
export { OpenPositionDto } from "./dto/open-position.dto";
export { SubmitDisputeDto } from "./dto/submit-dispute.dto";
export { ReopenMarketDto } from "./dto/reopen-market.dto";

@Injectable()
export class MarketsService implements OnModuleInit {
  constructor(
    @InjectRepository(Market) private marketRepo: Repository<Market>,
    @InjectRepository(Outcome) private outcomeRepo: Repository<Outcome>,
    @InjectRepository(Dispute) private disputeRepo: Repository<Dispute>,
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectRepository(MarketBook)
    private marketBookRepo: Repository<MarketBook>,
    @InjectRepository(OutcomeBook)
    private outcomeBookRepo: Repository<OutcomeBook>,
    private engine: ParimutuelEngine,
    private lmsrService: LMSRService,
    @InjectDataSource() private dataSource: DataSource,
    private redis: RedisService,
    private reputationService: ReputationService,
    private telegram: TelegramSimpleService,
  ) {}

  async onModuleInit() {
    // Backfill sortOrder for outcomes that were created before the sortOrder column existed.
    // Uses ctid (physical row order) as a proxy for insertion order within each market.
    await this.dataSource.query(`
      WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (PARTITION BY "marketId" ORDER BY ctid) - 1 AS rn
        FROM outcomes
        WHERE "sortOrder" = 0
      )
      UPDATE outcomes
      SET "sortOrder" = ranked.rn
      FROM ranked
      WHERE outcomes.id = ranked.id
    `);
  }

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
      marketId: string;
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
        marketId: p.market?.id ?? "",
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
      const outcomes = dto.outcomes.map((item, idx) =>
        this.outcomeRepo.create({
          label: typeof item === "string" ? item : item.label,
          imageUrl: typeof item === "string" ? null : (item.imageUrl ?? null),
          totalBetAmount: 0,
          currentOdds: 0,
          lmsrProbability: 0,
          isWinner: false,
          sortOrder: idx,
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

      const category = Object.values(MarketCategory).includes(
        dto.category as MarketCategory,
      )
        ? (dto.category as MarketCategory)
        : MarketCategory.OTHER;

      const metadata: Record<string, any> = {};
      if (dto.bracketSlot) metadata.bracketSlot = dto.bracketSlot;
      if (dto.candidate) metadata.candidate = dto.candidate;
      if (dto.matchLabel) metadata.matchLabel = dto.matchLabel;

      // 3. Create market and link outcomes (cascade will handle saving them)
      const market = this.marketRepo.create({
        title: dto.title,
        description: dto.description,
        imageUrl: dto.imageUrl,
        imageUrlAlt: dto.imageUrlAlt,
        resolutionCriteria: dto.resolutionCriteria ?? undefined,
        opensAt: dto.opensAt ? new Date(dto.opensAt) : undefined,
        closesAt: dto.closesAt ? new Date(dto.closesAt) : undefined,
        houseEdgePct: dto.houseEdgePct ?? DEFAULT_HOUSE_EDGE_PCT,
        mechanism: MarketMechanism.PARIMUTUEL,
        liquidityParam: liquidityParam,
        outcomes: outcomes,
        totalPool: 0,
        status: MarketStatus.UPCOMING,
        externalMatchId: dto.externalMatchId ?? null,
        externalSource: dto.externalSource ?? null,
        externalMarketType: dto.externalMarketType ?? null,
        settlementSource: dto.settlementSource ?? null,
        category,
        subcategory: dto.subcategory ?? null,
        groupId: dto.groupId ?? null,
        groupTitle: dto.groupTitle ?? null,
        metadata: Object.keys(metadata).length ? metadata : null,
      });

      const saved = await this.marketRepo.save(market);
      await this.invalidateMarketCache();
      const full = await this.findOne(saved.id);
      return full;
    } catch (err) {
      console.error("❌ Error in MarketsService.create:", err);
      throw err;
    }
  }

  /**
   * Append new outcomes to an existing market. Used to keep season-long "stat"
   * markets (top scorer, assists, …) current as new players enter the
   * leaderboard over the season. Only allowed while the market is still open for
   * betting. New outcomes start at a zero pool; their per-currency books are
   * created lazily on the first bet (ensureOutcomeBooks), so this stays safe
   * alongside the multi-currency engine and never touches existing bets.
   *
   * Deduped by exact (case-insensitive) label — callers that need fuzzy
   * name-matching should pre-filter with statNamesMatch. Returns how many were
   * actually added.
   */
  async addOutcomes(
    marketId: string,
    items: { label: string; imageUrl?: string | null }[],
  ): Promise<number> {
    if (!items || items.length === 0) return 0;

    const market = await this.marketRepo.findOne({
      where: { id: marketId },
      relations: ["outcomes"],
    });
    if (!market) throw new NotFoundException("Market not found");
    if (
      market.status !== MarketStatus.UPCOMING &&
      market.status !== MarketStatus.OPEN
    ) {
      throw new BadRequestException(
        "Outcomes can only be added while the market is open for betting",
      );
    }

    const seen = new Set(
      (market.outcomes ?? []).map((o) => o.label.trim().toLowerCase()),
    );
    let nextSort =
      (market.outcomes ?? []).reduce((m, o) => Math.max(m, o.sortOrder), -1) + 1;

    const fresh = items.filter((it) => {
      const key = (it.label ?? "").trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (fresh.length === 0) return 0;

    const rows = fresh.map((it) =>
      this.outcomeRepo.create({
        label: it.label.trim(),
        imageUrl: it.imageUrl ?? null,
        totalBetAmount: 0,
        currentOdds: 0,
        lmsrProbability: 0,
        isWinner: false,
        marketId: market.id,
        sortOrder: nextSort++,
      }),
    );
    await this.outcomeRepo.save(rows);
    await this.invalidateMarketCache();
    return rows.length;
  }

  async createGroup(dto: CreateMarketGroupDto): Promise<Market[]> {
    const groupId = randomUUID();
    const markets: Market[] = [];
    for (const candidate of dto.candidates) {
      const market = await this.create({
        title: `${dto.title} — ${candidate.name}`,
        description: dto.description,
        imageUrl: candidate.imageUrl ?? dto.imageUrl,
        resolutionCriteria: dto.resolutionCriteria,
        opensAt: dto.opensAt,
        closesAt: dto.closesAt,
        houseEdgePct: dto.houseEdgePct,
        liquidityParam: dto.liquidityParam,
        category: dto.category ?? MarketCategory.POLITICAL,
        subcategory: dto.subcategory,
        settlementSource: dto.settlementSource,
        outcomes: [
          { label: "Yes", imageUrl: null },
          { label: "No", imageUrl: null },
        ],
        groupId,
        groupTitle: dto.title,
        candidate: candidate.name,
      });
      markets.push(market);
    }
    return markets;
  }

  /** All sibling candidate markets in a group, oldest first. */
  async findGroup(groupId: string): Promise<Market[]> {
    const markets = await this.marketRepo.find({
      where: { groupId },
      order: { createdAt: "ASC" },
    });
    if (!markets.length) {
      throw new NotFoundException(`No market group with id "${groupId}"`);
    }
    return markets;
  }

  /**
   * Edit a whole grouped event at once. Shared fields fan out to every sibling;
   * per-candidate name/image are applied individually. Renaming the umbrella
   * title also rewrites each sibling's "{group} — {candidate}" title so the
   * stored titles never drift from the displayed group title.
   */
  async updateGroup(
    groupId: string,
    dto: UpdateMarketGroupDto,
  ): Promise<Market[]> {
    const markets = await this.findGroup(groupId);
    const newGroupTitle =
      dto.title?.trim() || markets[0].groupTitle || markets[0].title;
    const overrides = new Map(
      (dto.candidates ?? []).map((c) => [c.id, c]),
    );

    for (const m of markets) {
      // ── shared fields (applied to every candidate market) ──
      if (dto.description !== undefined) m.description = dto.description;
      if (dto.resolutionCriteria !== undefined)
        m.resolutionCriteria = dto.resolutionCriteria;
      if (dto.category !== undefined)
        m.category = dto.category as MarketCategory;
      if (dto.subcategory !== undefined)
        m.subcategory = dto.subcategory || null;
      if (dto.settlementSource !== undefined)
        m.settlementSource = dto.settlementSource ?? null;
      if (dto.opensAt) m.opensAt = new Date(dto.opensAt);
      if (dto.closesAt) m.closesAt = new Date(dto.closesAt);
      if (dto.houseEdgePct !== undefined) m.houseEdgePct = dto.houseEdgePct;
      if (dto.liquidityParam !== undefined)
        m.liquidityParam = dto.liquidityParam;

      // ── per-candidate name + avatar image ──
      const override = overrides.get(m.id);
      const candidateName =
        override?.name?.trim() ||
        (m.metadata?.candidate as string | undefined) ||
        m.title.split("—").pop()?.trim() ||
        m.title;
      if (override && "imageUrl" in override)
        // entity column is nullable; the TS type omits null (pre-existing)
        m.imageUrl = (override.imageUrl ?? null) as unknown as string;

      // ── keep groupTitle, candidate metadata and title prefix in sync ──
      m.groupTitle = newGroupTitle;
      m.metadata = { ...(m.metadata ?? {}), candidate: candidateName };
      m.title = `${newGroupTitle} — ${candidateName}`;

      await this.marketRepo.save(m);
    }

    // ── add brand-new candidates (entries with no id) as fresh Yes/No siblings ──
    const template = markets[0];
    const newCandidates = (dto.candidates ?? []).filter(
      (c) => !c.id && c.name?.trim(),
    );
    for (const nc of newCandidates) {
      const name = nc.name!.trim();
      const created = await this.create({
        title: `${newGroupTitle} — ${name}`,
        description: dto.description ?? template.description ?? undefined,
        imageUrl: nc.imageUrl ?? undefined,
        resolutionCriteria:
          dto.resolutionCriteria ?? template.resolutionCriteria ?? undefined,
        opensAt: dto.opensAt ?? template.opensAt?.toISOString(),
        closesAt: dto.closesAt ?? template.closesAt?.toISOString(),
        houseEdgePct: dto.houseEdgePct ?? Number(template.houseEdgePct),
        liquidityParam: Number(template.liquidityParam),
        category: template.category,
        subcategory: template.subcategory ?? undefined,
        settlementSource:
          dto.settlementSource ?? template.settlementSource ?? undefined,
        outcomes: [
          { label: "Yes", imageUrl: null },
          { label: "No", imageUrl: null },
        ],
        groupId,
        groupTitle: newGroupTitle,
        candidate: name,
      });
      // A new candidate defaults to UPCOMING; if the race is already live, open
      // it too so it's immediately bettable alongside its siblings.
      if (
        template.status === MarketStatus.OPEN &&
        created.status !== MarketStatus.OPEN
      ) {
        await this.marketRepo.update(created.id, {
          status: MarketStatus.OPEN,
        });
      }
    }

    await this.invalidateMarketCache();
    return this.findGroup(groupId);
  }

  async findAll(q?: string): Promise<Market[]> {
    const cacheKey = q
      ? `oro:cache:markets:search:${q.toLowerCase().trim()}`
      : "oro:cache:markets:all";
    const cached = await this.redis.getJson<Market[]>(cacheKey);
    if (cached) return cached;

    const activeStatuses = [
      MarketStatus.UPCOMING,
      MarketStatus.OPEN,
      MarketStatus.CLOSED,
      MarketStatus.RESOLVING,
      MarketStatus.RESOLVED,
      MarketStatus.SETTLED,
    ];

    const qb = this.marketRepo
      .createQueryBuilder("market")
      .leftJoinAndSelect("market.outcomes", "outcome")
      .where("market.status IN (:...activeStatuses)", { activeStatuses })
      .orderBy("market.createdAt", "DESC")
      .addOrderBy("outcome.sortOrder", "ASC");

    if (q && q.trim()) {
      const safe = q
        .trim()
        .toLowerCase()
        .replace(/[%_\\]/g, "\\$&");
      const term = `%${safe}%`;
      qb.andWhere(
        "LOWER(market.title) LIKE :term ESCAPE '\\' OR LOWER(market.description) LIKE :term ESCAPE '\\'",
        { term },
      );
    }

    const markets = await qb.getMany();
    // Attach reputation signal to each market's outcomes (fire in parallel)
    await Promise.all(markets.map((m) => this.attachSignal(m)));
    await this.attachBooksToMany(markets);
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
    market.outcomes?.sort((a, b) => a.sortOrder - b.sortOrder);
    await this.attachSignal(market);
    await this.attachBooks(market);
    await this.redis.setJsonEx(cacheKey, 30, market);
    return market;
  }

  /**
   * {@link attachBooks} across a list, in two queries rather than two per
   * market.
   *
   * The feed returns dozens of markets; doing this per market would turn one
   * page load into a hundred round trips. Same output, same synthesis rules.
   */
  /**
   * Public entry point for callers outside this service — the admin listing
   * builds its own query and would otherwise render ngultrum-only pools on a
   * screen where both books are being resolved.
   */
  async attachBooksTo(markets: Market[]): Promise<void> {
    return this.attachBooksToMany(markets);
  }

  private async attachBooksToMany(markets: Market[]): Promise<void> {
    if (!markets.length) return;

    const rows = await this.marketBookRepo.find({
      where: { marketId: In(markets.map((m) => m.id)) },
    });
    const byMarket = new Map<string, typeof rows>();
    for (const row of rows) {
      if (!row.isEnabled) continue;
      const list = byMarket.get(row.marketId) ?? [];
      list.push(row);
      byMarket.set(row.marketId, list);
    }

    for (const market of markets) {
      (market as Market & { books?: unknown }).books = this.withDefaultBooks(
        market,
        (byMarket.get(market.id) ?? []).map((b) => ({
          currency: b.currency,
          minStake: Number(b.minStake),
          houseEdgePct: Number(b.houseEdgePct),
          totalPool: Number(b.totalPool),
        })),
      );
    }

    await this.attachOutcomePools(markets);
  }

  /**
   * Fill in the books a market accepts but has no row for yet.
   *
   * Both currencies open their book on the first stake into them, so "no row"
   * means "empty", never "not accepted". Terms match what the engine would
   * actually apply, so what a client renders is what a stake would meet.
   */
  private withDefaultBooks(
    market: Market,
    books: {
      currency: string;
      minStake: number;
      houseEdgePct: number;
      totalPool: number;
    }[],
  ) {
    const edge = Number(market.houseEdgePct) || DEFAULT_HOUSE_EDGE_PCT;
    if (!books.some((b) => b.currency === BTN_CURRENCY)) {
      books.push({
        currency: BTN_CURRENCY,
        minStake: btnMinStakeFor(market),
        houseEdgePct: edge,
        totalPool: Number(market.totalPool) || 0,
      });
    }
    if (!books.some((b) => b.currency === USDT_CURRENCY)) {
      books.push({
        currency: USDT_CURRENCY,
        minStake: usdtMinStake(),
        houseEdgePct: edge,
        totalPool: 0,
      });
    }
    return books;
  }

  /**
   * Attach the currency books so a client knows what this market accepts.
   *
   * Without this the bet form has no way to tell a USDT market from a BTN-only
   * one, so it either offers a stake that the engine then refuses, or hides a
   * wallet that would have worked. Both were happening.
   *
   * Terms only — pool totals are already carried per outcome, and a book's
   * `minStake` and `houseEdgePct` are what a stake screen has to render.
   */
  private async attachBooks(market: Market): Promise<void> {
    const rows = await this.marketBookRepo.find({
      where: { marketId: market.id },
    });
    const books = rows
      .filter((b) => b.isEnabled)
      .map((b) => ({
        currency: b.currency,
        minStake: Number(b.minStake),
        houseEdgePct: Number(b.houseEdgePct),
        totalPool: Number(b.totalPool),
      }));

    (market as Market & { books?: unknown }).books = this.withDefaultBooks(
      market,
      books,
    );

    await this.attachOutcomePools([market]);
  }

  /**
   * Per-outcome pools, per currency, across a list of markets in one query.
   *
   * `outcome.totalBetAmount` is the BTN book's figure and nothing else, so a
   * client computing odds or a payout from it quotes a USDT stake against a
   * pool that stake will never join. Every card and every bet screen needs
   * this, and the feed needs it as much as the detail page — attaching it only
   * on the single-market path left every card in the feed with nothing to
   * compute from, silently falling back to ngultrum figures.
   */
  private async attachOutcomePools(markets: Market[]): Promise<void> {
    const outcomeIds = markets.flatMap((m) => (m.outcomes ?? []).map((o) => o.id));
    if (!outcomeIds.length) return;

    const rows = await this.outcomeBookRepo.find({
      where: { outcomeId: In(outcomeIds) },
    });
    const byOutcome = new Map<string, Record<string, number>>();
    const lmsrByOutcome = new Map<string, Record<string, number>>();
    for (const row of rows) {
      const pools = byOutcome.get(row.outcomeId) ?? {};
      pools[row.currency] = Number(row.totalBetAmount) || 0;
      byOutcome.set(row.outcomeId, pools);

      // Each book keeps its own LMSR probability. `outcome.lmsrProbability`
      // is written only for the BTN book — it is the legacy mirror — so a
      // client with no per-currency value falls back to ngultrum-derived
      // odds on a market where the viewer's own book is empty.
      const lmsr = lmsrByOutcome.get(row.outcomeId) ?? {};
      lmsr[row.currency] = Number(row.lmsrProbability) || 0;
      lmsrByOutcome.set(row.outcomeId, lmsr);
    }

    for (const market of markets) {
      // Currencies this market accepts, so a book with no stakes still reports
      // a zero rather than being absent — a missing key reads as "unknown" to
      // a client and sends it back to the ngultrum field.
      const currencies = (
        (market as Market & { books?: { currency: string }[] }).books ?? []
      ).map((b) => b.currency);

      for (const outcome of market.outcomes ?? []) {
        const found = byOutcome.get(outcome.id) ?? {};
        const pools: Record<string, number> = {
          [BTN_CURRENCY]: Number(outcome.totalBetAmount) || 0,
        };
        for (const currency of currencies) {
          if (currency === BTN_CURRENCY) continue;
          pools[currency] = found[currency] ?? 0;
        }
        (outcome as Outcome & { poolsByCurrency?: unknown }).poolsByCurrency =
          pools;

        const lmsrFound = lmsrByOutcome.get(outcome.id) ?? {};
        const lmsr: Record<string, number> = {
          [BTN_CURRENCY]: Number(outcome.lmsrProbability) || 0,
        };
        for (const currency of currencies) {
          if (currency === BTN_CURRENCY) continue;
          lmsr[currency] = lmsrFound[currency] ?? 0;
        }
        (outcome as Outcome & { lmsrByCurrency?: unknown }).lmsrByCurrency =
          lmsr;
      }
    }
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
    if (dto.settlementSource !== undefined)
      market.settlementSource = dto.settlementSource ?? null;
    if (dto.subcategory !== undefined)
      market.subcategory = dto.subcategory || null;
    if (dto.opensAt) market.opensAt = new Date(dto.opensAt);
    if (dto.closesAt) market.closesAt = new Date(dto.closesAt);
    if (dto.houseEdgePct !== undefined) market.houseEdgePct = dto.houseEdgePct;
    if (dto.liquidityParam !== undefined)
      market.liquidityParam = dto.liquidityParam;
    if (dto.isFeatured !== undefined) market.isFeatured = dto.isFeatured;
    if (dto.bracketSlot !== undefined)
      market.metadata = {
        ...(market.metadata ?? {}),
        bracketSlot: dto.bracketSlot || undefined,
      };
    if (dto.matchLabel !== undefined)
      market.metadata = {
        ...(market.metadata ?? {}),
        matchLabel: dto.matchLabel || undefined,
      };

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

  /**
   * Add a new outcome to an existing market. Only allowed while the market is
   * still accepting bets (UPCOMING or OPEN) — once it is CLOSED or beyond,
   * the outcome set is frozen so settlement math stays sound.
   *
   * In a parimutuel market each outcome has its own independent pool, so a
   * late-added outcome simply starts at a zero pool; existing positions are
   * unaffected. LMSR probabilities are recomputed across all outcomes.
   */
  async addOutcome(
    marketId: string,
    label: string,
    imageUrl?: string | null,
  ): Promise<Market> {
    const market = await this.findOne(marketId);

    if (
      market.status !== MarketStatus.UPCOMING &&
      market.status !== MarketStatus.OPEN
    ) {
      throw new BadRequestException(
        `Cannot add an outcome to a market in "${market.status}" state. ` +
          `Outcomes can only be added while the market is Upcoming or Open.`,
      );
    }

    const cleanLabel = (label ?? "").trim();
    if (!cleanLabel) {
      throw new BadRequestException("Outcome label is required");
    }

    const existing = await this.outcomeRepo.find({ where: { marketId } });
    if (
      existing.some(
        (o) => o.label.trim().toLowerCase() === cleanLabel.toLowerCase(),
      )
    ) {
      throw new BadRequestException(
        `An outcome labelled "${cleanLabel}" already exists on this market`,
      );
    }

    const nextSortOrder =
      existing.reduce((max, o) => Math.max(max, o.sortOrder), -1) + 1;

    const outcome = this.outcomeRepo.create({
      marketId,
      label: cleanLabel,
      imageUrl: imageUrl ?? null,
      totalBetAmount: 0,
      currentOdds: 0,
      lmsrProbability: 0,
      isWinner: false,
      sortOrder: nextSortOrder,
    });
    await this.outcomeRepo.save(outcome);

    // Recompute LMSR probabilities across the full (now larger) outcome set
    const all = await this.outcomeRepo.find({ where: { marketId } });
    const probs = this.lmsrService.calculateProbabilities(
      all,
      Number(market.liquidityParam) || 1000,
    );
    await Promise.all(
      all.map((o, i) => {
        o.lmsrProbability = probs[i];
        return this.outcomeRepo.save(o);
      }),
    );

    await this.invalidateMarketCache(marketId);
    return this.findOne(marketId);
  }

  async setOutcomeEliminated(
    marketId: string,
    outcomeId: string,
    isEliminated: boolean,
  ): Promise<Market> {
    const outcome = await this.outcomeRepo.findOne({
      where: { id: outcomeId, marketId },
    });
    if (!outcome) {
      throw new BadRequestException("Outcome not found in this market");
    }
    if (outcome.isWinner) {
      throw new BadRequestException(
        "Cannot eliminate an outcome that is already marked as a winner",
      );
    }

    outcome.isEliminated = isEliminated;
    await this.outcomeRepo.save(outcome);

    await this.invalidateMarketCache(marketId);
    return this.findOne(marketId);
  }

  async placeBet(userId: string, marketId: string, dto: OpenPositionDto) {
    return this.engine.placePosition(
      userId,
      marketId,
      dto.outcomeId,
      dto.amount,
      dto.currency,
    );
    // cache invalidation handled inside ParimutuelEngine.placeBet
  }

  async transition(marketId: string, to: MarketStatus) {
    const result = await this.engine.transitionMarket(marketId, to);
    await this.invalidateMarketCache(marketId);
    return result;
  }
  async reopen(marketId: string, dto: ReopenMarketDto): Promise<Market> {
    const result = await this.engine.reopenMarket(
      marketId,
      new Date(dto.closesAt),
    );
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
    if (market && !isEplUclSubcategory(market.subcategory)) {
      // EPL/UCL markets settle constantly (one per fixture, plus the stat
      // boards), so a channel "Market Resolved" post for each is just noise —
      // every predictor already gets their own result DM. Silence the channel
      // broadcast for those; keep it for admin-created / one-off markets.
      const winner = market.outcomes?.find(
        (o: any) => o.id === winningOutcomeId,
      );
      this.telegram
        .postToChannel(
          `✅ <b>Market Resolved: ${market.title}</b>\n\nWinner: <b>${winner?.label ?? winningOutcomeId}</b>`,
        )
        .catch(() => undefined);
    }
    // Knockout: once this match is decided, advance the winner into the next
    // round and open that fixture for betting (no-op for non-bracket markets).
    await this.maybeAdvanceBracket(marketId);
    return result;
  }

  private async maybeAdvanceBracket(resolvedMarketId: string): Promise<void> {
    try {
      const market = await this.findOne(resolvedMarketId);
      if (!market || market.subcategory !== "wc-match") return;
      const slotId = (market.metadata as any)?.bracketSlot as
        | string
        | undefined;
      if (!slotId) return;

      const adv = bracketAdvance(slotId);
      if (!adv) return; // final, or unrecognised slot id

      // Load all wc-match markets once so we can resolve siblings + dedupe.
      const wcMatches = await this.marketRepo.find({
        where: { subcategory: "wc-match" },
        relations: ["outcomes"],
      });
      const bySlot = (sid: string) =>
        wcMatches.find((m) => (m.metadata as any)?.bracketSlot === sid);

      // Already created (by a prior feeder's resolution or by an admin)? Stop.
      if (bySlot(adv.nextSlotId)) return;

      const isResolved = (m?: Market) =>
        !!m &&
        (m.status === MarketStatus.RESOLVED ||
          m.status === MarketStatus.SETTLED);
      const winnerLabel = (m: Market) =>
        m.outcomes?.find((o) => o.id === m.resolvedOutcomeId)?.label;

      const feederA = bySlot(adv.feeders[0]);
      const feederB = bySlot(adv.feeders[1]);
      // Both feeders must be decided before the next fixture is known.
      if (!isResolved(feederA) || !isResolved(feederB)) return;

      const teamA = winnerLabel(feederA!);
      const teamB = winnerLabel(feederB!);
      if (!teamA || !teamB) return;

      const kickoff = WC_KICKOFFS[adv.nextSlotId] ?? undefined;
      const created = await this.create({
        title: `${teamA} vs ${teamB}`,
        subcategory: "wc-match",
        bracketSlot: adv.nextSlotId,
        outcomes: [{ label: teamA }, { label: teamB }],
        opensAt: new Date().toISOString(),
        closesAt: kickoff,
      } as CreateMarketDto);

      // Open right away so bettors don't wait for the keeper's next tick.
      await this.transition(created.id, MarketStatus.OPEN);

      this.telegram
        .postToChannel(
          `🏆 <b>Knockout advance:</b> ${teamA} vs ${teamB} — prediction is now open!`,
        )
        .catch(() => undefined);
    } catch (err) {
      console.error("maybeAdvanceBracket failed:", err);
    }
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
          `❌ <b>Market Cancelled: ${market.title}</b>\n\nAll pending predictions have been fully refunded.`,
        )
        .catch(() => undefined);

      // 2. Individual DM to every unique bettor whose position was refunded
      const seenUsers = new Set<string>();
      for (const pos of pendingPositions) {
        const user = (pos as any).user as User | undefined;
        if (!user?.telegramId || seenUsers.has(user.id)) continue;
        seenUsers.add(user.id);
        this.telegram
          .sendRefundNotification(
            Number(user.telegramId),
            market.title,
            Number(pos.amount),
            "market_cancelled",
          )
          .catch(() => undefined);
      }
    }

    return result;
  }

  // ─── Dispute / Objection System ─────────────────────────────────────────────
  // A market's resolution is a two-sided contest. Participants lock an equal
  // bond and pick a side:
  //   OBJECT  → the admin's proposed outcome is wrong
  //   SUPPORT → the proposed outcome is right (defends it against objectors)
  // The FIRST participant must OBJECT and chooses the per-head bond (min Nu 10);
  // everyone after matches that exact amount. On resolution the winning side
  // gets its bonds back plus an equal split of the losing side's forfeited bonds.

  // Floor for the objector-chosen bond — high enough to deter casual/abusive
  // objections while still being accessible to bettors with genuine grievances.
  private static readonly MIN_DISPUTE_BOND = 10;

  /**
   * Join a market's resolution contest during the objection window.
   * Only bettors with an active position can participate. The first objector
   * sets the per-head bond (≥ Nu 10); later participants must match it exactly.
   * The bond is forfeited if your side loses, or returned + rewarded if it wins.
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

    // Must hold an active position to participate
    const position = await this.dataSource.getRepository(Position).findOne({
      where: { userId, marketId, status: PositionStatus.PENDING },
    });
    if (!position)
      throw new BadRequestException(
        "You must have an active position in this market to raise an objection",
      );

    // One entry per user per market
    const alreadyObjected = await this.disputeRepo.findOne({
      where: { userId, marketId },
    });
    if (alreadyObjected)
      throw new BadRequestException(
        "You have already raised an objection for this market",
      );

    const side = dto.side ?? DisputeSide.OBJECT;

    // Determine the contest bond + lock it in one DB transaction. The "first
    // participant" check is re-evaluated inside the transaction so two racing
    // objectors can't disagree on the amount.
    const { saved, bondAmount } = await this.dataSource.transaction(
      async (em) => {
        const user = await em.findOne(User, { where: { id: userId } });
        if (!user) throw new BadRequestException("User not found");

        const existingCount = await em
          .getRepository(Dispute)
          .count({ where: { marketId } });
        const isFirst = existingCount === 0;

        let bond: number;
        if (isFirst) {
          if (side !== DisputeSide.OBJECT)
            throw new BadRequestException(
              "You can only defend a proposal after someone has objected to it. Raise an objection instead.",
            );
          const requested =
            dto.bondAmount ?? MarketsService.MIN_DISPUTE_BOND;
          bond =
            Math.round(
              Math.max(MarketsService.MIN_DISPUTE_BOND, requested) * 100,
            ) / 100;
        } else {
          const required = Number(
            market.disputeBondAmount ?? MarketsService.MIN_DISPUTE_BOND,
          );
          if (
            dto.bondAmount != null &&
            Math.abs(Number(dto.bondAmount) - required) > 0.001
          )
            throw new BadRequestException(
              `This contest's bond is fixed at Nu ${required.toLocaleString()}. ` +
                `Everyone who joins — objecting or defending — must lock exactly that amount.`,
            );
          bond = required;
        }

        const currentBalance = await ledgerBalanceForAccount(em, userId);

        if (currentBalance < bond)
          throw new BadRequestException(
            `You need at least Nu ${bond.toLocaleString()} available to join this objection. ` +
              `This bond is non-refundable if your side loses. ` +
              `Your current balance is Nu ${currentBalance.toFixed(0)}.`,
          );

        // The first objector stamps the per-head bond onto the market so every
        // later participant matches it.
        if (isFirst) {
          market.disputeBondAmount = bond;
          await em.getRepository(Market).save(market);
        }

        // Deduct the bond
        const verb =
          side === DisputeSide.SUPPORT ? "defending" : "objecting to";
        const txn = em.getRepository(Transaction).create({
          userId,
          type: TransactionType.DISPUTE_BOND_LOCK,
          amount: -bond,
          balanceBefore: currentBalance,
          balanceAfter: currentBalance - bond,
          note: `Bond locked for ${verb} the outcome of "${market.title}"`,
        });
        await em.getRepository(Transaction).save(txn);

        const dispute = em.getRepository(Dispute).create({
          userId,
          marketId,
          reason: dto.reason,
          side,
          upheld: null,
          bondAmount: bond,
          bondStatus: DisputeBondStatus.LOCKED,
        });
        const savedDispute = await em.getRepository(Dispute).save(dispute);
        return { saved: savedDispute, bondAmount: bond };
      },
    );

    // Bust balance cache
    await this.redis.del(`oro:cache:balance:${userId}`);

    await this.invalidateMarketCache(marketId);

    const winCondition =
      side === DisputeSide.SUPPORT
        ? "the admin keeps the proposed outcome"
        : "the admin agrees the outcome was wrong";
    return {
      ...saved,
      bondAmount,
      bondNote: `Nu ${bondAmount.toLocaleString()} has been locked as a bond. You get it back — plus a share of the other side's bonds — if ${winCondition}. If your side loses, you forfeit the bond.`,
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
      .addOrderBy("outcome.sortOrder", "ASC")
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

    // Objection counts per market (OBJECT side only — defenders aren't objections)
    const objectionRows: { marketId: string; count: string }[] =
      await this.dataSource
        .getRepository(Dispute)
        .createQueryBuilder("d")
        .select("d.marketId", "marketId")
        .addSelect("COUNT(*)", "count")
        .where("d.marketId IN (:...marketIds)", { marketIds })
        .andWhere("d.side = :objectSide", { objectSide: DisputeSide.OBJECT })
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
      .addOrderBy("outcome.sortOrder", "ASC")
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

    // Objection counts per market (OBJECT side only — defenders don't count as objections)
    const objectionRows: { marketId: string; count: string }[] =
      await this.dataSource
        .getRepository(Dispute)
        .createQueryBuilder("d")
        .select("d.marketId", "marketId")
        .addSelect("COUNT(*)", "count")
        .where("d.marketId IN (:...marketIds)", { marketIds })
        .andWhere("d.side = :objectSide", { objectSide: DisputeSide.OBJECT })
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
        .andWhere("d.side = :objectSide", { objectSide: DisputeSide.OBJECT })
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

  /** Full objection records incl. objector identity — for ADMIN review use only. */
  getDisputesByMarket(marketId: string): Promise<Dispute[]> {
    return this.disputeRepo.find({
      where: { marketId },
      order: { createdAt: "DESC" },
    });
  }

  /**
   * Public-safe view of a market's objections — `userId`/`user` are deliberately
   * omitted so an unauthenticated caller cannot enumerate which users objected
   * to which markets. Used by the @Public() markets endpoint only.
   */
  async getPublicDisputesByMarket(marketId: string) {
    const disputes = await this.getDisputesByMarket(marketId);
    return disputes.map((d) => ({
      id: d.id,
      reason: d.reason,
      side: d.side,
      upheld: d.upheld,
      bondAmount: d.bondAmount,
      bondStatus: d.bondStatus,
      rewardAmount: d.rewardAmount,
      createdAt: d.createdAt,
    }));
  }

  /**
   * The authenticated caller's own dispute record for a market — used to show
   * "you challenged this and won/lost" plus the exact bond and reward. Returns
   * null when the user did not object. Only ever exposes the caller's own row,
   * so (unlike the public list) it may safely include the settlement result.
   */
  async getMyDispute(marketId: string, userId: string) {
    const d = await this.disputeRepo.findOne({
      where: { marketId, userId },
      order: { createdAt: "DESC" },
    });
    if (!d) return null;
    return {
      id: d.id,
      reason: d.reason,
      side: d.side,
      upheld: d.upheld,
      bondAmount: d.bondAmount,
      bondStatus: d.bondStatus,
      rewardAmount: d.rewardAmount,
      createdAt: d.createdAt,
    };
  }

  /**
   * Every dispute the caller has raised, across all markets — used to flag which
   * settled markets they disputed (and the result) in the results list. Only the
   * caller's own rows, so it may include the settlement outcome + reward.
   */
  async getMyDisputes(userId: string) {
    const disputes = await this.disputeRepo.find({
      where: { userId },
      relations: { market: true },
      order: { createdAt: "DESC" },
    });
    return disputes.map((d) => ({
      id: d.id,
      marketId: d.marketId,
      marketTitle: d.market?.title ?? null,
      side: d.side,
      upheld: d.upheld,
      bondAmount: d.bondAmount,
      bondStatus: d.bondStatus,
      rewardAmount: d.rewardAmount,
      createdAt: d.createdAt,
    }));
  }

  /**
   * Returns objection counts per side, window info, and the bond this user must
   * lock to join the resolution contest. The first objector may choose any
   * amount ≥ minBond; once set, everyone matches `bondRequired`.
   */
  async getDisputeInfo(
    marketId: string,
    userId?: string,
  ): Promise<{
    objectionCount: number;
    objectCount: number;
    supportCount: number;
    windowOpen: boolean;
    windowClosesAt: Date | null;
    windowMinutes: number;
    canObject: boolean;
    /** Fixed bond every participant must lock, once the first objector set it. Null until then. */
    bondRequired: number | null;
    /** Whether the per-head bond is already locked in (true after the first objection). */
    bondFixed: boolean;
    /** Floor for the first objector's chosen bond. */
    minBond: number;
    bondNote: string;
  }> {
    const market = await this.findOne(marketId);
    const [objectCount, supportCount] = await Promise.all([
      this.disputeRepo.count({ where: { marketId, side: DisputeSide.OBJECT } }),
      this.disputeRepo.count({
        where: { marketId, side: DisputeSide.SUPPORT },
      }),
    ]);
    const objectionCount = objectCount + supportCount;
    const now = new Date();
    const windowOpen =
      market.status === MarketStatus.RESOLVING &&
      !!market.disputeDeadlineAt &&
      now < market.disputeDeadlineAt;

    // Once the first objection is filed, the bond is fixed for everyone.
    const bondFixed = market.disputeBondAmount != null;
    const bondRequired = bondFixed ? Number(market.disputeBondAmount) : null;

    let canObject = windowOpen;
    if (userId && windowOpen) {
      const position = await this.dataSource.getRepository(Position).findOne({
        where: { userId, marketId, status: PositionStatus.PENDING },
      });
      canObject = !!position;
    }

    return {
      objectionCount,
      objectCount,
      supportCount,
      windowOpen,
      windowClosesAt: market.disputeDeadlineAt ?? null,
      windowMinutes: market.windowMinutes ?? 60,
      canObject,
      bondRequired,
      bondFixed,
      minBond: MarketsService.MIN_DISPUTE_BOND,
      bondNote: bondFixed
        ? `Joining this contest requires a Nu ${bondRequired!.toLocaleString()} bond (matching the first objector). ` +
          `You get it back + a share of the losing side's bonds if your side wins, or forfeit it if it loses.`
        : `The first objector sets the bond (minimum Nu ${MarketsService.MIN_DISPUTE_BOND}). ` +
          `Returned + rewarded if your side wins, forfeited if it loses.`,
    };
  }

  async delete(id: string): Promise<void> {
    const market = await this.findOne(id);
    const hasNoBets = parseFloat(String(market.totalPool ?? 0)) === 0;

    if (
      !hasNoBets &&
      market.status !== MarketStatus.CANCELLED &&
      market.status !== MarketStatus.UPCOMING
    ) {
      throw new ForbiddenException(
        "Cannot delete a market that has bets placed on it.",
      );
    }

    // Remove positions for zero-pool, cancelled, or upcoming markets
    // (cancelled markets have already had bets refunded; zero-pool have none)
    await this.dataSource.getRepository(Position).delete({ marketId: id });

    await this.marketRepo.remove(market);
    await this.invalidateMarketCache(id);
  }

  async deleteZeroPool(): Promise<number> {
    const emptyMarkets = await this.marketRepo
      .createQueryBuilder("m")
      .where("m.totalPool = :zero OR m.totalPool IS NULL", { zero: 0 })
      .getMany();

    if (emptyMarkets.length === 0) return 0;

    for (const market of emptyMarkets) {
      await this.dataSource
        .getRepository(Position)
        .delete({ marketId: market.id });
      await this.marketRepo.remove(market);
      await this.invalidateMarketCache(market.id);
    }

    return emptyMarkets.length;
  }

  async getZeroPoolSettled(): Promise<Market[]> {
    return this.marketRepo
      .createQueryBuilder("m")
      .where("m.status = :status", { status: MarketStatus.SETTLED })
      .andWhere("(m.totalPool = :zero OR m.totalPool IS NULL)", { zero: 0 })
      .orderBy("m.createdAt", "DESC")
      .getMany();
  }

  async deleteZeroPoolSettled(): Promise<number> {
    const markets = await this.getZeroPoolSettled();
    if (markets.length === 0) return 0;

    const settlementRepo = this.dataSource.getRepository(Settlement);
    const positionRepo = this.dataSource.getRepository(Position);

    for (const market of markets) {
      await positionRepo.delete({ marketId: market.id });
      await settlementRepo.delete({ marketId: market.id });
      await this.marketRepo.remove(market);
      await this.invalidateMarketCache(market.id);
    }

    return markets.length;
  }
}
