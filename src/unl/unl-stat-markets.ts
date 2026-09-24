import { CreateMarketDto } from "../markets/dto/create-market.dto";

/**
 * The two Nations League "stat" markets.
 *
 * Mirrors `ucl-stat-markets.ts`, with one difference that matters: there is no
 * provider behind either board. The UCL builder is fed by football-data's
 * /scorers; both of these are fed by rows an admin typed into
 * `stat_board_overrides`. So there is no auto-create cron here — an admin
 * publishes the board first, then creates the market from it.
 */
export type UnlStatKey = "goals" | "assists";

export interface UnlStatMarketMeta {
  board: UnlStatKey;
  /** Must match the app's Stats-tab routing. */
  subcategory: string;
  title: string;
  /** Used in copy: "most <word>". */
  word: string;
}

export const UNL_STAT_MARKET_META: Record<UnlStatKey, UnlStatMarketMeta> = {
  goals: {
    board: "goals",
    subcategory: "unl-topscorer",
    title: "Nations League — Top Scorer",
    word: "goals",
  },
  assists: {
    board: "assists",
    subcategory: "unl-assists",
    title: "Nations League — Most Assists",
    word: "assists",
  },
};

export const UNL_STAT_SUBCATEGORIES = Object.values(UNL_STAT_MARKET_META).map(
  (m) => m.subcategory,
);

/**
 * Default close: the end of the group stage.
 *
 * Not the finals in June, unlike the UCL market. The Nations League finals are
 * four teams playing two matches; a "top scorer" settled across them would be
 * decided by which two nations qualified rather than by the campaign the
 * market was opened on. The group stage runs September to November, so a
 * market opened in that window closes the same year, and one opened afterwards
 * belongs to the next edition.
 */
export function unlStatMarketCloseDate(now = new Date()): string {
  const year = now.getMonth() >= 11 ? now.getFullYear() + 1 : now.getFullYear();
  return `${year}-11-20T12:00:00.000Z`;
}

export interface UnlStatPlayer {
  player: string;
  face: string;
  faceBackup: string;
}

/** Build the CreateMarketDto for a stat market from a published board. */
export function buildUnlStatMarketDto(
  stat: UnlStatKey,
  players: UnlStatPlayer[],
  closesAt?: string,
): CreateMarketDto {
  const meta = UNL_STAT_MARKET_META[stat];
  return {
    title: meta.title,
    description: `Which player finishes the Nations League group stage with the most ${meta.word}?`,
    category: "sports",
    subcategory: meta.subcategory,
    resolutionCriteria:
      `Resolved to the player with the most ${meta.word} in the UEFA Nations League ` +
      `group stage, per official UEFA statistics. Ties are split by matches played, ` +
      `then minutes played.`,
    opensAt: new Date().toISOString(),
    closesAt: closesAt || unlStatMarketCloseDate(),
    // Both the source and the settlement are a person. Deliberately the same
    // externalSource as the match markets, so the never-auto-settle guard
    // covers these too without a second rule.
    externalSource: "unl-manual",
    settlementSource: "Official UEFA Nations League statistics",
    outcomes: players.map((p) => ({
      label: p.player,
      imageUrl: p.face || p.faceBackup || null,
    })),
  };
}
