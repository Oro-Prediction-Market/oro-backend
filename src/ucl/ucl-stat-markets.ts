import { CreateMarketDto } from "../markets/dto/create-market.dto";

// Shared definition of the four UCL "stat" markets, used by BOTH the manual
// admin endpoint and the auto-create keeper cron so they never drift apart.
// NOTE: only goals & assists have a free-tier data source for the Champions
// League — yellow/red boards come back empty, so the keeper skips creating
// those two automatically. They remain here so admin can create them by hand.
export type UclStatKey = "goals" | "assists" | "yellow" | "red";

export interface UclStatMarketMeta {
  board: UclStatKey; // which getStats() board feeds the outcomes
  subcategory: string; // must match the app's Stats-tab routing
  title: string;
  word: string; // used in copy: "most <word>"
}

export const UCL_STAT_MARKET_META: Record<UclStatKey, UclStatMarketMeta> = {
  goals: { board: "goals", subcategory: "ucl-topscorer", title: "Champions League — Top Scorer", word: "goals" },
  assists: { board: "assists", subcategory: "ucl-assists", title: "Champions League — Most Assists", word: "assists" },
  yellow: { board: "yellow", subcategory: "ucl-yellowcards", title: "Champions League — Most Yellow Cards", word: "yellow cards" },
  red: { board: "red", subcategory: "ucl-redcards", title: "Champions League — Most Red Cards", word: "red cards" },
};

export const UCL_STAT_SUBCATEGORIES = Object.values(UCL_STAT_MARKET_META).map(
  (m) => m.subcategory,
);

/** Default close: the Champions League final window (late May/early June, next
 *  year if we're already past June). */
export function uclStatMarketCloseDate(now = new Date()): string {
  const year = now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear();
  return `${year}-05-30T12:00:00.000Z`;
}

export interface UclStatPlayer {
  player: string;
  face: string;
  faceBackup: string;
}

/** Build the CreateMarketDto for a stat market from a leaderboard slice. */
export function buildUclStatMarketDto(
  stat: UclStatKey,
  players: UclStatPlayer[],
  closesAt?: string,
): CreateMarketDto {
  const meta = UCL_STAT_MARKET_META[stat];
  return {
    title: meta.title,
    description: `Which player finishes the Champions League season with the most ${meta.word}?`,
    category: "sports",
    subcategory: meta.subcategory,
    resolutionCriteria: `Resolved to the player with the most ${meta.word} in the UEFA Champions League season, per official UEFA statistics.`,
    opensAt: new Date().toISOString(),
    closesAt: closesAt || uclStatMarketCloseDate(),
    settlementSource: "manual",
    outcomes: players.map((p) => ({
      label: p.player,
      imageUrl: p.face || p.faceBackup || null,
    })),
  };
}
