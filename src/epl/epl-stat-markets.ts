import { CreateMarketDto } from "../markets/dto/create-market.dto";

// Shared definition of the four EPL "stat" markets, used by BOTH the manual
// admin endpoint and the auto-create keeper cron so they never drift apart.
export type EplStatKey = "goals" | "assists" | "yellow" | "red";

export interface EplStatMarketMeta {
  board: EplStatKey; // which getStats() board feeds the outcomes
  subcategory: string; // must match the app's Stats-tab routing
  title: string;
  word: string; // used in copy: "most <word>"
}

export const EPL_STAT_MARKET_META: Record<EplStatKey, EplStatMarketMeta> = {
  goals: { board: "goals", subcategory: "epl-topscorer", title: "Premier League — Top Scorer", word: "goals" },
  assists: { board: "assists", subcategory: "epl-assists", title: "Premier League — Most Assists", word: "assists" },
  yellow: { board: "yellow", subcategory: "epl-yellowcards", title: "Premier League — Most Yellow Cards", word: "yellow cards" },
  red: { board: "red", subcategory: "epl-redcards", title: "Premier League — Most Red Cards", word: "red cards" },
};

export const EPL_STAT_SUBCATEGORIES = Object.values(EPL_STAT_MARKET_META).map(
  (m) => m.subcategory,
);

/** Default close: end of the PL season window (late May, next year if we're
 *  already past June). */
export function eplStatMarketCloseDate(now = new Date()): string {
  const year = now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear();
  return `${year}-05-24T12:00:00.000Z`;
}

export interface EplStatPlayer {
  player: string;
  face: string;
  faceBackup: string;
}

/** Build the CreateMarketDto for a stat market from a leaderboard slice. */
export function buildEplStatMarketDto(
  stat: EplStatKey,
  players: EplStatPlayer[],
  closesAt?: string,
): CreateMarketDto {
  const meta = EPL_STAT_MARKET_META[stat];
  return {
    title: meta.title,
    description: `Which player finishes the Premier League season with the most ${meta.word}?`,
    category: "sports",
    subcategory: meta.subcategory,
    resolutionCriteria: `Resolved to the player with the most ${meta.word} in the Premier League season, per official Premier League statistics.`,
    opensAt: new Date().toISOString(),
    closesAt: closesAt || eplStatMarketCloseDate(),
    settlementSource: "manual",
    outcomes: players.map((p) => ({
      label: p.player,
      imageUrl: p.face || p.faceBackup || null,
    })),
  };
}
