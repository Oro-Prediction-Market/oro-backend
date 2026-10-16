import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Market, MarketStatus } from "../entities/market.entity";
import { KeeperService } from "../markets/keeper.service";
import { MarketsService } from "../markets/markets.service";
import { RedisService } from "../redis/redis.service";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";
import {
  ESPN_NBA_SOURCE,
  NbaGame,
  bhutanDate,
  fetchNbaGame,
  nbaFinalResult,
} from "./espn-nba.util";
import {
  buildNbaMatchMarketDto,
  nbaWinnerOutcome,
  wantsNbaMarket,
} from "./nba-markets";
import { NbaService } from "./nba.service";

/**
 * A final must read the same this long apart before it is proposed. One hour,
 * the same quiet period football waits for before trusting a result.
 */
export const NBA_FINAL_STABLE_MS = 60 * 60 * 1000;
/** Statuses that mean the game will not finish as scheduled. */
const NOT_PLAYED = new Set([
  "STATUS_POSTPONED",
  "STATUS_CANCELED",
  "STATUS_CANCELLED",
  "STATUS_SUSPENDED",
  "STATUS_FORFEIT",
]);

/**
 * Makes and settles NBA game markets from ESPN.
 *
 * Its own module and its own crons, rather than more branches in the keeper:
 * the keeper's football auto-proposal reads football-data.org for any market
 * with an externalMatchId, and NBA markets have none (see nba-markets.ts).
 * What it shares with everything else is the back half: it only PROPOSES the
 * winner; the objection window and the usual settlers do the paying, and the
 * keeper re-reads ESPN before money moves (recheckProposal).
 *
 * On whenever the keeper is, like EPL and UCL; pausing the keeper pauses it.
 */
@Injectable()
export class NbaJobsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(NbaJobsService.name);

  constructor(
    private readonly nba: NbaService,
    private readonly marketsService: MarketsService,
    private readonly keeper: KeeperService,
    private readonly telegram: TelegramSimpleService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    @InjectRepository(Market) private readonly marketRepo: Repository<Market>,
  ) {}

  /** Runs whenever the keeper does, like the EPL and UCL jobs. */
  enabled(): boolean {
    return this.keeper.getStatus().isActive;
  }

  private lookaheadDays(): number {
    const n = Number(this.config.get<string>("NBA_LOOKAHEAD_DAYS") ?? 7);
    return Number.isFinite(n) && n >= 1 && n <= 14 ? Math.floor(n) : 7;
  }

  /** Run `fn` on exactly one pod per tick, like KeeperService.withClusterLock. */
  private async locked(key: string, ttlSec: number, fn: () => Promise<void>) {
    let token: string | null = null;
    try {
      token = await this.redis.acquireLock(key, ttlSec);
    } catch (e) {
      this.logger.warn(`lock ${key} failed; skipping: ${(e as Error).message}`);
      return;
    }
    if (!token) return;
    try {
      await fn();
    } finally {
      await this.redis.releaseLock(key, token).catch(() => undefined);
    }
  }

  private async alertAdmin(message: string, onceKey?: string): Promise<void> {
    if (onceKey) {
      try {
        if (await this.redis.get(onceKey)) return;
        await this.redis.setEx(onceKey, 3 * 24 * 60 * 60, "1");
      } catch {
        /* alert anyway */
      }
    }
    const adminId = Number(this.config.get<string>("ADMIN_TELEGRAM_ID"));
    if (!adminId) return;
    await this.telegram.sendMessage(adminId, message).catch(() => undefined);
  }

  // ── Market creation (daily, and once at start-up) ──────────────────────────

  onApplicationBootstrap(): void {
    // Not awaited: start-up must not wait on ESPN.
    setTimeout(() => void this.handleCreateMarkets(), 30_000).unref?.();
  }

  @Cron("0 8 * * *", { timeZone: "Asia/Thimphu" })
  async handleCreateMarkets(): Promise<void> {
    if (!this.enabled()) return;
    await this.locked("nba:create-markets", 280, async () => {
      await this.runCreateMarkets();
    });
  }

  async runCreateMarkets(
    now = new Date(),
  ): Promise<{ created: number; moved: number }> {
    const days = this.lookaheadDays();
    const games = await this.nba.getGames(bhutanDate(now), days + 1);
    const wanted = games.filter((g) => wantsNbaMarket(g, now.getTime()));
    if (!wanted.length) return { created: 0, moved: 0 };

    const existing = await this.marketRepo
      .createQueryBuilder("m")
      .select(["m.id", "m.status", "m.closesAt", "m.metadata", "m.title"])
      .where("m.externalSource = :src", { src: ESPN_NBA_SOURCE })
      .andWhere("m.metadata->>'espnGameId' IN (:...ids)", {
        ids: wanted.map((g) => g.id),
      })
      .getMany();
    const byGame = new Map(
      existing.map((m) => [String(m.metadata?.espnGameId), m] as const),
    );

    let created = 0;
    let moved = 0;
    for (const game of wanted) {
      const market = byGame.get(game.id);
      if (market) {
        // Tip-off moved: follow it while betting is still open. Any status
        // counts as "exists" — a market an admin cancelled is not remade.
        const open =
          market.status === MarketStatus.OPEN ||
          market.status === MarketStatus.UPCOMING;
        if (
          open &&
          Math.abs(
            new Date(market.closesAt).getTime() - Date.parse(game.tipoff),
          ) > 60_000
        ) {
          // A column update, not MarketsService.update (which saves the whole
          // row from a possibly stale cached copy).
          await this.marketRepo.update(market.id, {
            closesAt: new Date(game.tipoff),
          });
          moved++;
          this.logger.log(
            `NBA tip-off moved: ${market.title} → ${game.tipoff}`,
          );
        }
        continue;
      }
      try {
        await this.marketsService.create(buildNbaMatchMarketDto(game, now));
        created++;
      } catch (e) {
        this.logger.error(
          `NBA market for game ${game.id} failed: ${(e as Error).message}`,
        );
      }
    }
    if (created || moved) {
      this.logger.log(
        `NBA markets: created ${created}, moved ${moved} (next ${days} days)`,
      );
    }
    return { created, moved };
  }

  // ── Results (every 5 minutes) ───────────────────────────────────────────────

  @Cron("*/5 * * * *")
  async handleProposeResults(): Promise<void> {
    if (!this.enabled()) return;
    await this.locked("nba:propose", 280, async () => {
      await this.runProposeResults();
    });
  }

  async runProposeResults(now = Date.now()): Promise<number> {
    const pending = await this.marketRepo.find({
      where: {
        externalSource: ESPN_NBA_SOURCE,
        status: MarketStatus.CLOSED,
      },
      relations: ["outcomes"],
    });
    let proposed = 0;
    for (const market of pending) {
      if (market.proposedOutcomeId) continue;
      const gameId = market.metadata?.espnGameId;
      if (!gameId) continue;
      const game = await fetchNbaGame(String(gameId));
      if (!game) continue; // ESPN unreachable: try again next tick

      if (NOT_PLAYED.has(game.statusName)) {
        await this.alertAdmin(
          `🏀 NBA game not played as scheduled (${game.statusDetail || game.statusName}):\n${market.title}\n\nThe market is closed and waiting. Refund it from Admin → Markets, or leave it if the game is rescheduled.`,
          `oro:nba:alerted:${market.id}:${game.statusName}`,
        );
        continue;
      }

      const result = nbaFinalResult(game);
      if (!result) continue;
      if (!(await this.isStable(game, result, now))) continue;

      const outcome = nbaWinnerOutcome(market.outcomes ?? [], game);
      if (!outcome) {
        await this.alertAdmin(
          `🏀 NBA result needs a human: ${market.title}\nFinal ${game.away.abbr} ${result.away} – ${game.home.abbr} ${result.home}, but no outcome is named exactly "${(result.winner === "home" ? game.home : game.away).name}". Resolve it in Admin → Markets.`,
          `oro:nba:alerted:${market.id}:no-outcome`,
        );
        continue;
      }
      try {
        await this.marketsService.proposeResolution(market.id, outcome.id);
        proposed++;
        this.logger.log(
          `NBA: proposed "${outcome.label}" for "${market.title}" (${game.away.abbr} ${result.away}–${result.home} ${game.home.abbr})`,
        );
      } catch (e) {
        this.logger.error(
          `NBA propose ${market.id} failed: ${(e as Error).message}`,
        );
      }
    }
    return proposed;
  }

  /**
   * True once the same final (winner and both scores) has been read twice at
   * least NBA_FINAL_STABLE_MS apart. The first read is remembered in Redis;
   * a different result restarts the clock. Football settled two markets on a
   * score that was corrected after it was first read — this is the guard
   * against the same thing here.
   */
  private async isStable(
    game: NbaGame,
    result: { winner: string; home: number; away: number },
    now: number,
  ): Promise<boolean> {
    const key = `oro:nba:final:${game.id}`;
    const sig = `${result.winner}:${result.home}:${result.away}`;
    try {
      const seen = await this.redis.get(key);
      if (seen) {
        const [at, prev] = [Number(seen.split("|")[0]), seen.split("|")[1]];
        if (prev === sig) return now - at >= NBA_FINAL_STABLE_MS;
      }
      await this.redis.setEx(key, 2 * 24 * 60 * 60, `${now}|${sig}`);
    } catch {
      /* no Redis: never stable, so never proposed — safe side */
    }
    return false;
  }
}
