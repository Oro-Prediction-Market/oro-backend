import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { MarketsService } from "./markets.service";
import { Market, MarketStatus } from "../entities/market.entity";
import { Dispute } from "../entities/dispute.entity";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";
import { RedisService } from "../redis/redis.service";
import { EplService } from "../epl/epl.service";
import {
  EPL_STAT_MARKET_META,
  EplStatKey,
  buildEplStatMarketDto,
} from "../epl/epl-stat-markets";
import { UclService } from "../ucl/ucl.service";
import {
  UCL_STAT_MARKET_META,
  UclStatKey,
  buildUclStatMarketDto,
} from "../ucl/ucl-stat-markets";
import { CreateMarketDto } from "./dto/create-market.dto";
import { statNamesMatch } from "./stat-outcome-match.util";

export interface KeeperLogEntry {
  id: number;
  time: string;
  type: "info" | "success" | "error" | "warn";
  msg: string;
}

export interface KeeperStatus {
  isActive: boolean;
  lastRunAt: string | null;
  logs: KeeperLogEntry[];
  stats: {
    marketsClosedToday: number;
    disputeWindowsOpened: number;
    marketsAutoSettled: number;
  };
}

@Injectable()
export class KeeperService {
  private readonly logger = new Logger(KeeperService.name);

  private isActive = true;
  private lastRunAt: Date | null = null;
  private logBuffer: KeeperLogEntry[] = [];
  private logIdCounter = 1;
  private expiryRunning = false;
  private disputeRunning = false;

  // Short-key store now lives in TelegramSimpleService to be accessible by BotPollingService
  // Daily counters (reset each day by the cron)
  private marketsClosedToday = 0;
  private disputeWindowsOpened = 0;
  private marketsAutoSettled = 0;

  constructor(
    private readonly marketsService: MarketsService,
    private readonly telegram: TelegramSimpleService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    @InjectRepository(Market) private readonly marketRepo: Repository<Market>,
    @InjectRepository(Dispute) private readonly disputeRepo: Repository<Dispute>,
    private readonly epl: EplService,
    private readonly ucl: UclService,
  ) {}

  /**
   * Run `fn` only if this pod wins a cluster-wide Redis lock — guarantees the cron
   * body runs on exactly ONE pod per tick (prevents double market transitions /
   * double settlement when the backend runs multiple replicas). If Redis is
   * unavailable the tick is skipped (safe: never run unguarded on all pods).
   */
  private async withClusterLock(
    key: string,
    ttlSec: number,
    fn: () => Promise<void>,
  ): Promise<void> {
    let token: string | null = null;
    try {
      token = await this.redis.acquireLock(key, ttlSec);
    } catch (e) {
      this.logger.warn(
        `[Keeper] lock acquire failed for ${key}; skipping tick: ${(e as Error).message}`,
      );
      return;
    }
    if (!token) return; // another pod owns this tick (or Redis unavailable)
    try {
      await fn();
    } finally {
      await this.redis.releaseLock(key, token).catch(() => undefined);
    }
  }

  // ── Public control API ────────────────────────────────────────────────────

  setActive(active: boolean) {
    this.isActive = active;
    this.addLog(
      active ? "info" : "warn",
      `Keeper ${active ? "started" : "paused"} by admin.`,
    );
  }

  getStatus(): KeeperStatus {
    return {
      isActive: this.isActive,
      lastRunAt: this.lastRunAt?.toISOString() ?? null,
      logs: [...this.logBuffer].reverse().slice(0, 100),
      stats: {
        marketsClosedToday: this.marketsClosedToday,
        disputeWindowsOpened: this.disputeWindowsOpened,
        marketsAutoSettled: this.marketsAutoSettled,
      },
    };
  }

  /** Manual trigger for a specific job from the admin UI. */
  async triggerJob(job: "expiry" | "dispute" | "liquidity"): Promise<void> {
    this.addLog("info", `Manual trigger: Running ${job} job...`);
    if (job === "expiry") await this.handleMarketExpirations();
    else if (job === "dispute") await this.handleDisputeWindowExpiry();
    else if (job === "liquidity") await this.simulateActivity();
  }

  // ── Cron: auto-open UPCOMING markets + close expired OPEN markets (every minute) ──

  @Cron(CronExpression.EVERY_MINUTE)
  async handleMarketExpirations() {
    if (!this.isActive) return;
    await this.withClusterLock("keeper:expiry", 55, () =>
      this.handleMarketExpirationsImpl(),
    );
  }

  private async handleMarketExpirationsImpl() {
    if (!this.isActive) return;
    if (this.expiryRunning) {
      this.addLog(
        "warn",
        "Expiry Watcher: skipped (previous run still in progress).",
      );
      return;
    }
    this.expiryRunning = true;
    this.lastRunAt = new Date();
    this.addLog("info", `Expiry Watcher: Scanning markets...`);

    // Safety: force-release the lock after 55s so a hung run never blocks the next tick
    const lockTimeout = setTimeout(() => {
      if (this.expiryRunning) {
        this.logger.warn(
          "[Keeper] Expiry Watcher force-released after timeout",
        );
        this.expiryRunning = false;
      }
    }, 55_000);

    // Track markets opened this tick so we never close them in the same run
    const justOpenedIds = new Set<string>();

    try {
      // ── Step 1: Auto-open UPCOMING markets whose opensAt has passed ──────────
      // NOTE: markets with no opensAt are NOT auto-opened — they require an
      // explicit admin action (transition) or a set opensAt date.
      const upcomingMarkets = await this.marketRepo.find({
        where: { status: MarketStatus.UPCOMING },
      });

      for (const market of upcomingMarkets) {
        // Only open if opensAt is explicitly set AND has passed
        if (!market.opensAt) continue;
        const shouldOpen = new Date() >= new Date(market.opensAt);
        if (shouldOpen) {
          try {
            await this.marketsService.transition(market.id, MarketStatus.OPEN);
            justOpenedIds.add(market.id);
            this.addLog("success", `✅ Market "${market.title}" auto-opened.`);
            if (!["ter", "btc"].includes(market.externalSource ?? "")) {
              await this.notifyAdmin(
                `🤖 <b>Keeper: Market Opened</b>\n\n` +
                  `📊 <b>${market.title}</b>\n` +
                  `Status: UPCOMING → <b>OPEN</b>\n` +
                  (market.closesAt
                    ? `⏱ Closes at: ${new Date(market.closesAt).toLocaleString()}`
                    : `⚠️ No closing time set — close manually when ready.`),
              );
            }
          } catch (err: any) {
            this.addLog(
              "error",
              `❌ Failed to open market "${market.title}": ${err.message}`,
            );
          }
        }
      }

      // ── Step 2: Auto-close OPEN markets whose closesAt has passed ────────────
      // Skip any market that was just opened this tick — prevents same-tick
      // open→close when closesAt is accidentally in the past.
      const openMarkets = await this.marketRepo.find({
        where: { status: MarketStatus.OPEN },
        relations: ["outcomes"],
      });

      let closed = 0;
      for (const market of openMarkets) {
        if (!market.closesAt) continue;
        // TER/BTC markets are managed by their own service — skip them entirely
        if (["ter", "btc"].includes(market.externalSource ?? "")) continue;
        // Never close a market that was opened in this same cron tick
        if (justOpenedIds.has(market.id)) {
          this.addLog(
            "warn",
            `⚠️ Market "${market.title}" was just opened — skipping auto-close this tick. closesAt appears to be in the past; please update it.`,
          );
          continue;
        }
        if (new Date() > new Date(market.closesAt)) {
          try {
            await this.marketsService.transition(
              market.id,
              MarketStatus.CLOSED,
            );
            this.marketsClosedToday++;
            closed++;
            this.addLog(
              "success",
              `✅ Market "${market.title}" auto-closed at deadline.`,
            );
            // Send admin a DM with one button per outcome so they can propose
            // the winner directly from Telegram — no admin panel needed.
            // Skip for TER/BTC markets — they auto-resolve without admin intervention.
            if (!["ter", "btc"].includes(market.externalSource ?? "")) {
              await this.notifyAdminPropose(market);
            }
          } catch (err: any) {
            this.addLog(
              "error",
              `❌ Failed to close market "${market.title}": ${err.message}`,
            );
            this.logger.error(
              `Keeper close failed for ${market.id}: ${err.message}`,
            );
          }
        }
      }

      if (closed === 0) {
        this.addLog(
          "info",
          `Expiry Watcher: No expired markets (${openMarkets.length} open, ${upcomingMarkets.length} upcoming).`,
        );
      }
    } finally {
      clearTimeout(lockTimeout);
      this.expiryRunning = false;
    }
  }

  // ── Cron: auto-settle markets whose dispute window has expired (every minute) ──

  @Cron(CronExpression.EVERY_MINUTE)
  async handleDisputeWindowExpiry() {
    if (!this.isActive) return;
    await this.withClusterLock("keeper:dispute", 55, () =>
      this.handleDisputeWindowExpiryImpl(),
    );
  }

  private async handleDisputeWindowExpiryImpl() {
    if (!this.isActive) return;
    if (this.disputeRunning) {
      this.addLog(
        "warn",
        "Dispute Guard: skipped (previous run still in progress).",
      );
      return;
    }
    this.disputeRunning = true;
    // Safety: force-release the lock after 55s so a hung run never blocks the next tick
    const lockTimeout = setTimeout(() => {
      if (this.disputeRunning) {
        this.logger.warn("[Keeper] Dispute Guard force-released after timeout");
        this.disputeRunning = false;
      }
    }, 55_000);
    try {
      // Find RESOLVING markets whose dispute deadline has passed and have a proposed outcome
      const resolvingMarkets = await this.marketRepo.find({
        where: { status: MarketStatus.RESOLVING },
        relations: ["outcomes"],
      });

      for (const market of resolvingMarkets) {
        if (!market.disputeDeadlineAt || !market.proposedOutcomeId) continue;
        if (new Date() < new Date(market.disputeDeadlineAt)) continue; // window still open
        if (["ter", "btc"].includes(market.externalSource ?? "")) continue; // auto-resolving markets manage themselves

        // Never auto-settle a market that has objections — a disputed result
        // must be reviewed by a human admin. This keeper runs every minute and
        // would otherwise beat the 5-minute AutoResolveMarketsJob to disputed
        // markets, upholding the proposal and forfeiting objector bonds with no
        // human review. Leave it RESOLVING for the admin to resolve manually.
        const objectionCount = await this.disputeRepo.count({
          where: { marketId: market.id },
        });
        if (objectionCount > 0) {
          this.addLog(
            "info",
            `Skipping auto-settle for "${market.title}" — ${objectionCount} objection(s) awaiting admin review.`,
          );
          continue;
        }

        try {
          this.addLog(
            "info",
            `Dispute window expired for "${market.title}". Auto-settling...`,
          );

          const proposedOutcome = market.outcomes.find(
            (o) => o.id === market.proposedOutcomeId,
          );
          const outcomeLabel = proposedOutcome?.label ?? "Unknown";

          await this.marketsService.resolve(
            market.id,
            market.proposedOutcomeId,
          );
          this.marketsAutoSettled++;

          this.addLog(
            "success",
            `✅ Market "${market.title}" auto-settled. Winner: ${outcomeLabel}`,
          );
          await this.notifyAdmin(
            `✅ <b>Keeper: Market Auto-Settled</b>\n\n` +
              `📊 <b>${market.title}</b>\n` +
              `🏆 Winner: <b>${outcomeLabel}</b>\n` +
              `Status: RESOLVING → <b>SETTLED</b>\n\n` +
              `Dispute window expired with no valid disputes. Payouts have been processed automatically.`,
          );
        } catch (err: any) {
          this.addLog(
            "error",
            `❌ Auto-settle failed for "${market.title}": ${err.message}`,
          );
          this.logger.error(
            `Keeper settle failed for ${market.id}: ${err.message}`,
          );
          await this.notifyAdmin(
            `⚠️ <b>Keeper: Auto-Settle Failed</b>\n\n` +
              `📊 <b>${market.title}</b>\n` +
              `Error: ${err.message}\n\n` +
              `Please resolve this market manually in the admin panel.`,
          );
        }
      }
    } finally {
      clearTimeout(lockTimeout);
      this.disputeRunning = false;
    }
  }

  // ── Cron: reset daily counters at midnight ────────────────────────────────

  @Cron("0 0 * * *")
  resetDailyCounters() {
    this.marketsClosedToday = 0;
    this.disputeWindowsOpened = 0;
    this.marketsAutoSettled = 0;
    this.addLog("info", "Daily counters reset at midnight.");
  }

  // ── Cron: auto-create the EPL stat markets once the season is underway ──────
  // Runs daily. Fires as soon as the current PL season has played its first
  // gameweek (tunable via EPL_AUTO_MARKET_MIN_GW), then creates the four season
  // stat markets from the live board. Fires ONCE per season (Redis flag keyed by
  // season year) so it never spams or re-creates a market an admin deliberately
  // cancelled. Notifies the admin on Telegram when it does.
  @Cron("0 7 * * *")
  async handleEplSeasonAutoMarkets() {
    if (!this.isActive) return;
    await this.withClusterLock("keeper:epl-automarkets", 280, () =>
      this.runEplSeasonAutoMarkets(),
    );
  }

  private async runEplSeasonAutoMarkets(): Promise<void> {
    let info: { started: boolean; seasonStart: string | null; maxPlayed: number };
    try {
      info = await this.epl.getSeasonInfo();
    } catch (e) {
      this.logger.warn(`[Keeper] EPL season check failed: ${(e as Error).message}`);
      return;
    }
    if (!info.started) return; // off-season — boards show last season, do nothing

    const seasonKey = (info.seasonStart ?? "").slice(0, 4) || "current";
    const flagKey = `oro:epl:auto-markets:${seasonKey}`;
    if (await this.redis.getJson(flagKey)) return; // already handled this season

    // Maturity gate: create the season-long stat markets as soon as the first
    // gameweek has been played. Override with EPL_AUTO_MARKET_MIN_GW to wait for
    // a more settled leaderboard before opening them.
    const minGw = Number(this.config.get<string>("EPL_AUTO_MARKET_MIN_GW") ?? 1);
    if (info.maxPlayed < minGw) return;

    const allStats = Object.keys(EPL_STAT_MARKET_META) as EplStatKey[];
    const stats = await this.epl.getStats();
    const created: string[] = [];
    let covered = 0; // stat markets that now exist (already there or created)
    for (const stat of allStats) {
      const meta = EPL_STAT_MARKET_META[stat];
      // Skip if an active market for this stat already exists.
      const existing = await this.marketRepo.findOne({
        where: {
          subcategory: meta.subcategory,
          status: In([
            MarketStatus.UPCOMING,
            MarketStatus.OPEN,
            MarketStatus.CLOSED,
            MarketStatus.RESOLVING,
          ]),
        },
      });
      if (existing) {
        covered++;
        continue;
      }

      const players = stats[meta.board];
      if (players.length < 2) continue; // board not populated enough yet
      try {
        const dto = buildEplStatMarketDto(stat, players);
        const market = await this.marketsService.create(dto);
        created.push(meta.title);
        covered++;
        this.addLog("success", `Auto-created EPL market: ${meta.title} (${market.id}).`);
      } catch (e) {
        this.logger.error(`[Keeper] auto-create ${meta.subcategory} failed: ${(e as Error).message}`);
      }
    }

    // Only lock the season once EVERY stat market exists. Firing at gameweek 1
    // can catch a board too thin to build (e.g. a goalless opener), so if any
    // are still missing we leave the flag unset and let a later daily run fill
    // them in — the existing-market check above keeps that from duplicating.
    if (covered >= allStats.length) {
      await this.redis.setJsonEx(flagKey, 400 * 24 * 3600, {
        done: true,
        at: new Date().toISOString(),
        created,
      });
    }

    if (created.length) {
      const adminId = Number(this.config.get<string>("ADMIN_TELEGRAM_ID"));
      if (adminId) {
        await this.telegram
          .sendMessage(
            adminId,
            `🏆 Premier League season is underway — I auto-created ${created.length} stat market(s):\n• ${created.join("\n• ")}\n\nReview close dates in Admin → Markets. Betting is live on the app's Stats tab.`,
          )
          .catch(() => undefined);
      }
    }
  }

  // ── Cron: keep season stat markets' fields current (daily) ──────────────────
  // The season stat markets (top scorer, assists, …) are created once from the
  // leaderboard as it stood that day, so a market opened after GW1 only lists the
  // handful of players who had scored. This cron tops up the field: each day it
  // reads the current top STAT_FIELD_SIZE of each board and adds any player not
  // already an outcome, so new scorers become bettable and the eventual season
  // winner is guaranteed to be in the list. Outcomes are only ever added, never
  // removed, and only while the market is still open for betting.
  private static readonly STAT_FIELD_SIZE = 25;

  @Cron("30 7 * * *")
  async handleEplStatMarketSync() {
    if (!this.isActive) return;
    await this.withClusterLock("keeper:epl-stat-sync", 280, () =>
      this.syncStatMarketOutcomes(
        "EPL",
        () => this.epl.getSeasonInfo(),
        () => this.epl.getStats(),
        Object.values(EPL_STAT_MARKET_META),
      ),
    );
  }

  @Cron("35 7 * * *")
  async handleUclStatMarketSync() {
    if (!this.isActive) return;
    await this.withClusterLock("keeper:ucl-stat-sync", 280, () =>
      this.syncStatMarketOutcomes(
        "UCL",
        () => this.ucl.getSeasonInfo(),
        () => this.ucl.getStats(),
        Object.values(UCL_STAT_MARKET_META),
      ),
    );
  }

  private async syncStatMarketOutcomes(
    tag: string,
    getSeasonInfo: () => Promise<{ started: boolean }>,
    getStats: () => Promise<any>,
    metas: readonly { board: string; subcategory: string; title: string }[],
  ): Promise<void> {
    let info: { started: boolean };
    try {
      info = await getSeasonInfo();
    } catch (e) {
      this.logger.warn(
        `[Keeper] ${tag} stat-sync season check failed: ${(e as Error).message}`,
      );
      return;
    }
    if (!info.started) return; // off-season — boards show last season, do nothing

    let stats: any;
    try {
      stats = await getStats();
    } catch (e) {
      this.logger.warn(
        `[Keeper] ${tag} stat-sync stats fetch failed: ${(e as Error).message}`,
      );
      return;
    }

    for (const meta of metas) {
      // Only sync a market that still exists and is open for betting.
      const market = await this.marketRepo.findOne({
        where: {
          subcategory: meta.subcategory,
          status: In([MarketStatus.UPCOMING, MarketStatus.OPEN]),
        },
        relations: ["outcomes"],
      });
      if (!market) continue;

      const board: {
        player: string;
        face?: string;
        faceBackup?: string;
      }[] = (stats?.[meta.board] ?? []).slice(0, KeeperService.STAT_FIELD_SIZE);
      if (board.length === 0) continue;

      const additions = board
        .filter(
          (p) =>
            p.player &&
            !(market.outcomes ?? []).some((o) =>
              statNamesMatch(o.label, p.player),
            ),
        )
        .map((p) => ({
          label: p.player,
          imageUrl: p.face || p.faceBackup || null,
        }));
      if (additions.length === 0) continue;

      try {
        const added = await this.marketsService.addOutcomes(
          market.id,
          additions,
        );
        if (added > 0) {
          this.addLog(
            "success",
            `${tag} stat sync: added ${added} new player(s) to ${meta.title}.`,
          );
        }
      } catch (e) {
        this.logger.error(
          `[Keeper] ${tag} stat-sync ${meta.subcategory} failed: ${(e as Error).message}`,
        );
      }
    }
  }

  // ── Cron: auto-create EPL match markets for upcoming fixtures (daily) ────────
  // Reads the next ~7 days of PL fixtures and creates a match-winner market per
  // fixture, linked to the football-data fixture id so the auto-proposal cron
  // resolves it automatically after the match. Deduped by fixture id, so it
  // rolls forward each day without duplicating. Self-gating: off-season there
  // are no fixtures in the window, so nothing is created.
  @Cron("0 8 * * *")
  async handleEplFixtureMarkets() {
    if (!this.isActive) return;
    await this.withClusterLock("keeper:epl-fixtures", 280, () =>
      this.runEplFixtureMarkets(),
    );
  }

  private async runEplFixtureMarkets(): Promise<void> {
    const days = Number(this.config.get<string>("EPL_FIXTURE_LOOKAHEAD_DAYS") ?? 7);
    let fixtures: Awaited<ReturnType<EplService["getUpcomingFixtures"]>>;
    try {
      fixtures = await this.epl.getUpcomingFixtures(days);
    } catch (e) {
      this.logger.warn(`[Keeper] EPL fixtures fetch failed: ${(e as Error).message}`);
      return;
    }
    if (!fixtures.length) return;

    let created = 0;
    for (const f of fixtures) {
      // Dedup: one market per fixture, any status (respects admin cancels too).
      const existing = await this.marketRepo.findOne({
        where: { externalMatchId: f.id },
      });
      if (existing) continue;
      try {
        const dto: CreateMarketDto = {
          title: `${f.homeTeam} vs ${f.awayTeam}`,
          description: "Premier League — who wins the match?",
          category: "sports",
          subcategory: "epl-match",
          externalMatchId: f.id,
          externalMarketType: "match-winner",
          externalSource: "football-data.org",
          settlementSource: "football-data.org",
          opensAt: new Date().toISOString(),
          closesAt: f.utcDate, // betting closes at kickoff
          resolutionCriteria:
            "Resolved to the full-time result (Home win / Draw / Away win) per the official Premier League match result.",
          outcomes: [
            { label: f.homeTeam, imageUrl: f.homeCrest || null },
            { label: "Draw", imageUrl: null },
            { label: f.awayTeam, imageUrl: f.awayCrest || null },
          ],
        };
        const market = await this.marketsService.create(dto);
        created++;
        this.addLog("success", `Auto-created EPL fixture market: ${dto.title} (${market.id}).`);
      } catch (e) {
        this.logger.error(`[Keeper] auto-create fixture ${f.id} failed: ${(e as Error).message}`);
      }
    }
    if (created) {
      this.addLog("info", `EPL fixtures: created ${created} match market(s) for the next ${days} days.`);
    }
  }

  // ── Cron: auto-create UCL stat markets once the season is underway ──────────
  // Mirrors the EPL flow. Only goals & assists have a free-tier CL data source,
  // so yellow/red boards come back empty and are skipped automatically (admin
  // can still create those by hand). Fires ONCE per season (Redis flag).
  @Cron("0 7 * * *")
  async handleUclSeasonAutoMarkets() {
    if (!this.isActive) return;
    await this.withClusterLock("keeper:ucl-automarkets", 280, () =>
      this.runUclSeasonAutoMarkets(),
    );
  }

  private async runUclSeasonAutoMarkets(): Promise<void> {
    let info: { started: boolean; seasonStart: string | null; maxPlayed: number };
    try {
      info = await this.ucl.getSeasonInfo();
    } catch (e) {
      this.logger.warn(`[Keeper] UCL season check failed: ${(e as Error).message}`);
      return;
    }
    if (!info.started) return; // off-season — do nothing

    const seasonKey = (info.seasonStart ?? "").slice(0, 4) || "current";
    const flagKey = `oro:ucl:auto-markets:${seasonKey}`;
    if (await this.redis.getJson(flagKey)) return; // already handled this season

    // Maturity gate: don't bake a matchday-1 field into a season-long market.
    const minGw = Number(this.config.get<string>("UCL_AUTO_MARKET_MIN_GW") ?? 2);
    if (info.maxPlayed < minGw) return;

    const stats = await this.ucl.getStats();
    const created: string[] = [];
    for (const stat of Object.keys(UCL_STAT_MARKET_META) as UclStatKey[]) {
      const meta = UCL_STAT_MARKET_META[stat];
      // Skip if an active market for this stat already exists.
      const existing = await this.marketRepo.findOne({
        where: {
          subcategory: meta.subcategory,
          status: In([
            MarketStatus.UPCOMING,
            MarketStatus.OPEN,
            MarketStatus.CLOSED,
            MarketStatus.RESOLVING,
          ]),
        },
      });
      if (existing) continue;

      const players = stats[meta.board];
      if (players.length < 2) continue; // board not populated (e.g. cards → empty)
      try {
        const dto = buildUclStatMarketDto(stat, players);
        const market = await this.marketsService.create(dto);
        created.push(meta.title);
        this.addLog("success", `Auto-created UCL market: ${meta.title} (${market.id}).`);
      } catch (e) {
        this.logger.error(`[Keeper] auto-create ${meta.subcategory} failed: ${(e as Error).message}`);
      }
    }

    // Mark this season handled so we never re-create (respects admin cancels).
    await this.redis.setJsonEx(flagKey, 400 * 24 * 3600, {
      done: true,
      at: new Date().toISOString(),
      created,
    });

    if (created.length) {
      const adminId = Number(this.config.get<string>("ADMIN_TELEGRAM_ID"));
      if (adminId) {
        await this.telegram
          .sendMessage(
            adminId,
            `🏆 Champions League is underway — I auto-created ${created.length} stat market(s):\n• ${created.join("\n• ")}\n\nReview close dates in Admin → Markets. Betting is live on the app's Stats tab.`,
          )
          .catch(() => undefined);
      }
    }
  }

  // ── Cron: auto-create UCL match markets for upcoming fixtures (daily) ────────
  // All CL matches (league phase + knockouts) get a 3-way match-winner market,
  // linked to the football-data fixture id so the generic auto-proposal cron
  // settles it on the full-time result. Deduped by fixture id.
  @Cron("0 8 * * *")
  async handleUclFixtureMarkets() {
    if (!this.isActive) return;
    await this.withClusterLock("keeper:ucl-fixtures", 280, () =>
      this.runUclFixtureMarkets(),
    );
  }

  private async runUclFixtureMarkets(): Promise<void> {
    const days = Number(this.config.get<string>("UCL_FIXTURE_LOOKAHEAD_DAYS") ?? 7);
    let fixtures: Awaited<ReturnType<UclService["getUpcomingFixtures"]>>;
    try {
      fixtures = await this.ucl.getUpcomingFixtures(days);
    } catch (e) {
      this.logger.warn(`[Keeper] UCL fixtures fetch failed: ${(e as Error).message}`);
      return;
    }
    if (!fixtures.length) return;

    let created = 0;
    for (const f of fixtures) {
      // Dedup: one market per fixture, any status (respects admin cancels too).
      const existing = await this.marketRepo.findOne({
        where: { externalMatchId: f.id },
      });
      if (existing) continue;
      try {
        const dto: CreateMarketDto = {
          title: `${f.homeTeam} vs ${f.awayTeam}`,
          description: "Champions League — who wins the match?",
          category: "sports",
          subcategory: "ucl-match",
          externalMatchId: f.id,
          externalMarketType: "match-winner",
          externalSource: "football-data.org",
          settlementSource: "football-data.org",
          opensAt: new Date().toISOString(),
          closesAt: f.utcDate, // betting closes at kickoff
          resolutionCriteria:
            "Resolved to the full-time result (Home win / Draw / Away win) per the official UEFA match result.",
          outcomes: [
            { label: f.homeTeam, imageUrl: f.homeCrest || null },
            { label: "Draw", imageUrl: null },
            { label: f.awayTeam, imageUrl: f.awayCrest || null },
          ],
        };
        const market = await this.marketsService.create(dto);
        created++;
        this.addLog("success", `Auto-created UCL fixture market: ${dto.title} (${market.id}).`);
      } catch (e) {
        this.logger.error(`[Keeper] auto-create UCL fixture ${f.id} failed: ${(e as Error).message}`);
      }
    }
    if (created) {
      this.addLog("info", `UCL fixtures: created ${created} match market(s) for the next ${days} days.`);
    }
  }

  // ── Cron: auto-create UCL knockout "who advances" markets (daily) ───────────
  // One 2-outcome market per upcoming knockout tie (R16 → Final), betting closes
  // at the tie's first leg. Deduped by title. NOT linked via externalMatchId so
  // the match-result auto-proposal ignores it — advancement is settled by the
  // dedicated resolution cron below.
  @Cron("0 9 * * *")
  async handleUclBracketMarkets() {
    if (!this.isActive) return;
    await this.withClusterLock("keeper:ucl-bracket", 280, () =>
      this.runUclBracketMarkets(),
    );
  }

  private async runUclBracketMarkets(): Promise<void> {
    const days = Number(this.config.get<string>("UCL_BRACKET_LOOKAHEAD_DAYS") ?? 12);
    let ties: Awaited<ReturnType<UclService["getUpcomingKnockoutTies"]>>;
    try {
      ties = await this.ucl.getUpcomingKnockoutTies(days);
    } catch (e) {
      this.logger.warn(`[Keeper] UCL bracket ties fetch failed: ${(e as Error).message}`);
      return;
    }
    if (!ties.length) return;

    let created = 0;
    for (const t of ties) {
      const title = `${t.a.name} vs ${t.b.name} — Who advances?`;
      const existing = await this.marketRepo.findOne({
        where: { subcategory: "ucl-bracket", title },
      });
      if (existing) continue;
      try {
        const dto: CreateMarketDto = {
          title,
          description: "Champions League knockout — which club advances to the next round?",
          category: "sports",
          subcategory: "ucl-bracket",
          externalSource: "ucl-bracket",
          settlementSource: "ucl-bracket",
          bracketSlot: t.stage,
          opensAt: new Date().toISOString(),
          closesAt: t.firstKickoff, // betting closes at the tie's first leg
          resolutionCriteria:
            "Resolved to the club that advances to the next round per official UEFA results.",
          outcomes: [
            { label: t.a.name, imageUrl: t.a.crest || null },
            { label: t.b.name, imageUrl: t.b.crest || null },
          ],
        };
        const market = await this.marketsService.create(dto);
        created++;
        this.addLog("success", `Auto-created UCL bracket market: ${title} (${market.id}).`);
      } catch (e) {
        this.logger.error(`[Keeper] auto-create UCL bracket tie failed: ${(e as Error).message}`);
      }
    }
    if (created) this.addLog("info", `UCL bracket: created ${created} advance market(s).`);
  }

  // ── Cron: settle UCL "who advances" markets by advancement (every 30 min) ───
  // Reads the live bracket and, once a tie's winner is known (the advancing team
  // appears in the next round, or the final's score decides it), proposes that
  // outcome and opens the standard dispute window.
  @Cron("*/30 * * * *")
  async handleUclBracketResolution() {
    if (!this.isActive) return;
    await this.withClusterLock("keeper:ucl-bracket-resolve", 280, () =>
      this.runUclBracketResolution(),
    );
  }

  private async runUclBracketResolution(): Promise<void> {
    const pending = await this.marketRepo.find({
      where: { status: MarketStatus.CLOSED, subcategory: "ucl-bracket" },
      relations: ["outcomes"],
    });
    const todo = pending.filter((m) => !m.proposedOutcomeId);
    if (!todo.length) return;

    let bracket: Awaited<ReturnType<UclService["getBracket"]>>;
    try {
      bracket = await this.ucl.getBracket();
    } catch (e) {
      this.logger.warn(`[Keeper] UCL bracket fetch failed: ${(e as Error).message}`);
      return;
    }
    if (!bracket?.hasData) return;

    const norm = (s: string) =>
      (s ?? "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[^a-z ]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const like = (x: string, y: string) =>
      x === y || (x.length > 2 && (x.includes(y) || y.includes(x)));

    // Decided ties: the set of name/short tokens for the two clubs → winner name.
    const decided: { names: string[]; winner: string }[] = [];
    for (const round of bracket.rounds) {
      for (const mt of round.matches) {
        if (mt.a && mt.b && mt.winner) {
          const winnerTeam = mt.winner === "a" ? mt.a : mt.b;
          decided.push({
            names: [norm(mt.a.name), norm(mt.a.short), norm(mt.b.name), norm(mt.b.short)],
            winner: winnerTeam.name,
          });
        }
      }
    }

    for (const market of todo) {
      const outs = market.outcomes ?? [];
      if (outs.length < 2) continue;
      const labels = outs.map((o) => norm(o.label));
      const tie = decided.find((t) =>
        labels.every((l) => t.names.some((n) => like(n, l))),
      );
      if (!tie) continue;
      const winNorm = norm(tie.winner);
      const winningOutcome = outs.find((o) => like(norm(o.label), winNorm));
      if (!winningOutcome) continue;
      try {
        await this.marketsService.proposeResolution(market.id, winningOutcome.id);
        this.disputeWindowsOpened++;
        this.addLog(
          "success",
          `UCL bracket: proposed "${winningOutcome.label}" advances for "${market.title}"`,
        );
        await this.notifyAdmin(
          `🤖 <b>Keeper: UCL Bracket</b>\n\n` +
            `📊 <b>${market.title}</b>\n` +
            `🏆 Advances: <b>${winningOutcome.label}</b>\n` +
            `⏳ 24h dispute window now open.`,
        );
      } catch (e) {
        this.addLog(
          "error",
          `UCL bracket resolve failed for "${market.title}": ${(e as Error).message}`,
        );
      }
    }
  }

  // ── Cron: auto-propose results for fixture-linked markets (every 5 minutes) ──

  private autoProposalRunning = false;

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleAutoProposal() {
    if (!this.isActive) return;
    await this.withClusterLock("keeper:autoproposal", 280, () =>
      this.handleAutoProposalImpl(),
    );
  }

  private async handleAutoProposalImpl() {
    if (!this.isActive) return;
    if (this.autoProposalRunning) return;
    this.autoProposalRunning = true;
    try {
      await this.runAutoProposal();
    } finally {
      this.autoProposalRunning = false;
    }
  }

  private async runAutoProposal() {
    const apiKey = this.config.get<string>("FOOTBALL_DATA_API_KEY");
    if (!apiKey) return;

    // Find CLOSED markets that are linked to an external match and haven't
    // had an outcome proposed yet.
    const candidates = await this.marketRepo
      .createQueryBuilder("m")
      .leftJoinAndSelect("m.outcomes", "o")
      .where("m.status = :status", { status: MarketStatus.CLOSED })
      .andWhere("m.externalMatchId IS NOT NULL")
      .andWhere("m.proposedOutcomeId IS NULL")
      .getMany();

    if (candidates.length === 0) return;

    this.addLog(
      "info",
      `Auto-Proposal: checking ${candidates.length} fixture-linked closed market(s)...`,
    );

    // Group by match ID so we only fetch each match once.
    const byMatchId = new Map<number, Market[]>();
    for (const m of candidates) {
      const mid = m.externalMatchId!;
      if (!byMatchId.has(mid)) byMatchId.set(mid, []);
      byMatchId.get(mid)!.push(m);
    }

    for (const [matchId, markets] of byMatchId) {
      let matchData: any;
      try {
        const res = await fetch(
          `https://api.football-data.org/v4/matches/${matchId}`,
          {
            headers: { "X-Auth-Token": apiKey },
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!res.ok) {
          this.addLog(
            "warn",
            `Auto-Proposal: HTTP ${res.status} for match ${matchId}`,
          );
          continue;
        }
        matchData = await res.json();
      } catch (err: any) {
        this.addLog(
          "error",
          `Auto-Proposal: fetch failed for match ${matchId}: ${err.message}`,
        );
        continue;
      }

      const status: string = matchData.status ?? "";
      if (!["FINISHED", "AWARDED"].includes(status)) {
        this.addLog(
          "info",
          `Auto-Proposal: match ${matchId} not finished yet (${status})`,
        );
        continue;
      }

      const homeScore: number = matchData.score?.fullTime?.home ?? 0;
      const awayScore: number = matchData.score?.fullTime?.away ?? 0;
      const homeTeam: string = matchData.homeTeam?.name ?? "";
      const awayTeam: string = matchData.awayTeam?.name ?? "";
      const totalGoals = homeScore + awayScore;

      for (const market of markets) {
        try {
          const winningOutcomeId = this.resolveOutcome(
            market,
            homeTeam,
            awayTeam,
            homeScore,
            awayScore,
            totalGoals,
          );
          if (!winningOutcomeId) {
            this.addLog(
              "warn",
              `Auto-Proposal: could not resolve outcome for "${market.title}" (match ${matchId})`,
            );
            continue;
          }
          await this.marketsService.proposeResolution(
            market.id,
            winningOutcomeId,
          );
          this.disputeWindowsOpened++;
          const label =
            market.outcomes.find((o) => o.id === winningOutcomeId)?.label ??
            winningOutcomeId;
          this.addLog(
            "success",
            `Auto-Proposal: proposed "${label}" for "${market.title}"`,
          );
          await this.notifyAdmin(
            `🤖 <b>Keeper: Auto-Proposal</b>\n\n` +
              `📊 <b>${market.title}</b>\n` +
              `🏆 Proposed Winner: <b>${label}</b>\n` +
              `⏳ 24h dispute window now open.`,
          );
        } catch (err: any) {
          this.addLog(
            "error",
            `Auto-Proposal: failed for "${market.title}": ${err.message}`,
          );
        }
      }
    }
  }

  /**
   * Match the real-world result to one of the market's outcome labels.
   * Supports "match-winner" (Home / Draw / Away) and "over-under" markets.
   */
  private resolveOutcome(
    market: Market,
    homeTeam: string,
    awayTeam: string,
    homeScore: number,
    awayScore: number,
    totalGoals: number,
  ): string | null {
    const type = market.externalMarketType ?? "match-winner";

    if (type === "over-under") {
      const label = totalGoals > 2.5 ? "Over 2.5" : "Under 2.5";
      return market.outcomes.find((o) => o.label === label)?.id ?? null;
    }

    // match-winner: find outcome whose label matches home team, away team, or "Draw"
    let targetLabel: string;
    if (homeScore > awayScore) targetLabel = homeTeam;
    else if (awayScore > homeScore) targetLabel = awayTeam;
    else targetLabel = "Draw";

    // Exact match first, then partial match (team names may be shortened)
    const exact = market.outcomes.find((o) => o.label === targetLabel);
    if (exact) return exact.id;

    const partial = market.outcomes.find(
      (o) =>
        targetLabel.toLowerCase().includes(o.label.toLowerCase()) ||
        o.label.toLowerCase().includes(targetLabel.toLowerCase()),
    );
    return partial?.id ?? null;
  }

  // ── Demo liquidity bot (every 10 minutes) ─────────────────────────────────

  @Cron(CronExpression.EVERY_10_MINUTES)
  async simulateActivity() {
    if (!this.isActive) return;
    this.addLog(
      "info",
      "Liquidity Bot: Simulation tick (no-op in production).",
    );
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private addLog(type: KeeperLogEntry["type"], msg: string) {
    const now = new Date();
    const time = now.toLocaleTimeString("en-US", { hour12: false });
    const entry: KeeperLogEntry = { id: this.logIdCounter++, time, type, msg };
    this.logBuffer.push(entry);
    // Keep only the last 200 log entries in memory
    if (this.logBuffer.length > 200) this.logBuffer.shift();
    this.logger.log(`[Keeper] ${msg}`);
  }

  private async notifyAdmin(message: string): Promise<void> {
    const adminTelegramId = this.config.get<string>("ADMIN_TELEGRAM_ID");
    if (!adminTelegramId) {
      this.logger.warn("ADMIN_TELEGRAM_ID not set — skipping admin DM");
      return;
    }
    try {
      await this.telegram.sendMessage(Number(adminTelegramId), message);
    } catch (err: any) {
      this.logger.error(`Failed to DM admin: ${err.message}`);
    }
  }

  /**
   * Resolve a short propose key — delegates to TelegramSimpleService
   * so BotPollingService can also call it without a circular dep.
   */
  async resolveProposeKey(
    key: number,
  ): Promise<{ marketId: string; outcomeId: string } | undefined> {
    return this.telegram.resolveProposeKey(key);
  }

  /**
   * Send admin a DM with one inline button per outcome.
   * Uses a short numeric key ("p:<n>") via TelegramSimpleService to stay
   * under Telegram's 64-byte callback_data limit.
   */
  private async notifyAdminPropose(market: Market): Promise<void> {
    const adminTelegramId = this.config.get<string>("ADMIN_TELEGRAM_ID");
    if (!adminTelegramId) {
      this.logger.warn("ADMIN_TELEGRAM_ID not set — skipping admin propose DM");
      return;
    }
    // Default window used when proposing via bot button (matches admin panel default)
    const DEFAULT_WINDOW_MINS = 60;
    const closedAt = market.closesAt
      ? new Date(market.closesAt).toLocaleString()
      : "now";
    const text =
      `🔔 <b>Keeper: Market Closed</b>\n\n` +
      `📊 <b>${market.title}</b>\n` +
      `⏱ Closed at: ${closedAt}\n\n` +
      `👇 <b>Tap the winning outcome</b> to open the 1-hour dispute window:`;

    // Register each outcome as a short key — run sequentially to guarantee unique keys
    const buttons: { text: string; callbackData: string }[][] = [];
    for (const o of market.outcomes ?? []) {
      const key = await this.telegram.registerProposeKey(
        market.id,
        o.id,
        DEFAULT_WINDOW_MINS,
      );
      buttons.push([{ text: o.label, callbackData: `p:${key}` }]);
    }

    try {
      await this.telegram.sendMessageWithButtons(
        Number(adminTelegramId),
        text,
        buttons,
      );
    } catch (err: any) {
      this.logger.error(`Failed to send propose DM to admin: ${err.message}`);
    }
  }
}
