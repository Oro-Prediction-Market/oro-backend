import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export interface FixtureMatch {
  id: number;
  competition: string;
  date: string;
  homeTeam: string;
  awayTeam: string;
  venue: string;
  status: "scheduled" | "live" | "completed";
  score?: { home: number; away: number };
}

export interface FixtureMarket {
  id: string;
  title: string;
  category: string;
  source: string;
  outcomes: string[];
  matchData: FixtureMatch;
  closesAt: string;
}

@Injectable()
export class FixturesService {
  private readonly logger = new Logger(FixturesService.name);
  private readonly BASE_URL = "https://api.football-data.org/v4";

  constructor(private readonly config: ConfigService) {}

  // Free-tier competitions available on football-data.org
  private readonly COMPETITIONS = ["PL", "BL1", "SA", "PD", "FL1", "CL", "WC", "EC"];

  async getFixtures(query?: string): Promise<FixtureMarket[]> {
    const apiKey = this.config.get<string>("FOOTBALL_DATA_API_KEY");
    if (!apiKey) {
      this.logger.warn("FOOTBALL_DATA_API_KEY not set — returning empty fixtures");
      return [];
    }

    const allMatches: FixtureMatch[] = [];

    for (const competition of this.COMPETITIONS) {
      const url = new URL(`${this.BASE_URL}/competitions/${competition}/matches`);
      url.searchParams.set("status", "SCHEDULED,LIVE,IN_PLAY,PAUSED");

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);

      try {
        const res = await fetch(url.toString(), {
          headers: { "X-Auth-Token": apiKey },
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!res.ok) {
          this.logger.warn(`football-data.org HTTP ${res.status} for ${competition} — skipping`);
          continue;
        }
        const data: any = await res.json();
        const matches = (data.matches || []).map((m: any) => this.transform(m));
        allMatches.push(...matches);
      } catch (err: any) {
        clearTimeout(timeout);
        this.logger.warn(`Failed to fetch ${competition} fixtures: ${err.message} — skipping`);
      }
    }

    if (allMatches.length === 0) {
      this.logger.warn("No fixtures found across all competitions");
      return [];
    }

    const markets = this.toMarkets(allMatches);

    if (!query) return markets;

    const q = query.toLowerCase();
    return markets.filter(
      (mk) =>
        mk.title.toLowerCase().includes(q) ||
        mk.matchData.homeTeam.toLowerCase().includes(q) ||
        mk.matchData.awayTeam.toLowerCase().includes(q),
    );
  }

  private transform(m: any): FixtureMatch {
    const homeScore = m.score?.fullTime?.home ?? m.score?.halfTime?.home;
    const awayScore = m.score?.fullTime?.away ?? m.score?.halfTime?.away;
    return {
      id: m.id,
      competition: m.competition?.name ?? "FIFA World Cup",
      date: m.utcDate,
      homeTeam: m.homeTeam?.name ?? "Team A",
      awayTeam: m.awayTeam?.name ?? "Team B",
      venue: m.venue ?? "TBD",
      status: this.mapStatus(m.status),
      score:
        homeScore != null && awayScore != null
          ? { home: homeScore, away: awayScore }
          : undefined,
    };
  }

  private mapStatus(s: string): "scheduled" | "live" | "completed" {
    if (["TIMED", "SCHEDULED"].includes(s)) return "scheduled";
    if (["IN_PLAY", "PAUSED", "LIVE"].includes(s)) return "live";
    if (["FINISHED", "AWARDED"].includes(s)) return "completed";
    return "scheduled";
  }

  private toMarkets(matches: FixtureMatch[]): FixtureMarket[] {
    const markets: FixtureMarket[] = [];
    for (const match of matches) {
      markets.push({
        id: `match-winner-${match.id}`,
        title: `${match.homeTeam} vs ${match.awayTeam} - Match Winner`,
        category: match.competition,
        source: "football-data.org",
        outcomes: [match.homeTeam, "Draw", match.awayTeam],
        matchData: match,
        closesAt: match.date,
      });
      markets.push({
        id: `over-under-${match.id}`,
        title: `${match.homeTeam} vs ${match.awayTeam} - Over/Under 2.5 Goals`,
        category: match.competition,
        source: "football-data.org",
        outcomes: ["Over 2.5", "Under 2.5"],
        matchData: match,
        closesAt: match.date,
      });
    }
    return markets.sort(
      (a, b) => new Date(a.closesAt).getTime() - new Date(b.closesAt).getTime(),
    );
  }
}
