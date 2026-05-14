import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { MarketsService } from "./markets.service";
import { Market, MarketStatus } from "../entities/market.entity";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";

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
    @InjectRepository(Market) private readonly marketRepo: Repository<Market>,
  ) {}

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

  // ── Cron: auto-propose results for fixture-linked markets (every 5 minutes) ──

  private autoProposalRunning = false;

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleAutoProposal() {
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
