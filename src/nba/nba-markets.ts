import { CreateMarketDto } from "../markets/dto/create-market.dto";
import {
  ESPN_NBA_SOURCE,
  NBA_SEASON_TYPE,
  NbaGame,
  nbaFinalResult,
} from "./espn-nba.util";

/** Subcategory of an NBA game market. The "nba-" prefix is what the apps, the
 *  admin pin rule and the channel mute key on. */
export const NBA_MATCH_SUBCATEGORY = "nba-match";

/** Season types that get markets: regular season, play-in, playoffs. */
export const NBA_MARKET_SEASON_TYPES: readonly number[] = [
  // Preseason too: teams rest starters so results are near coin-flips, but
  // users want to predict them. They settle exactly like the rest.
  NBA_SEASON_TYPE.PRE,
  NBA_SEASON_TYPE.REGULAR,
  NBA_SEASON_TYPE.PLAY_IN,
  NBA_SEASON_TYPE.POST,
];

export function nbaMatchLabel(seasonType: number): string {
  if (seasonType === NBA_SEASON_TYPE.PLAY_IN) return "Play-In";
  if (seasonType === NBA_SEASON_TYPE.POST) return "Playoffs";
  if (seasonType === NBA_SEASON_TYPE.PRE) return "Preseason";
  return "Regular Season";
}

/** Whether a game should get a market now: a counted game that has not tipped off. */
export function wantsNbaMarket(game: NbaGame, now = Date.now()): boolean {
  return (
    NBA_MARKET_SEASON_TYPES.includes(game.seasonType) &&
    game.state === "pre" &&
    game.statusName === "STATUS_SCHEDULED" &&
    Date.parse(game.tipoff) > now
  );
}

/**
 * The market for one game: home vs away, no draw (overtime decides every NBA
 * game), betting closes at tip-off.
 *
 * `externalMatchId` is deliberately left empty. The keeper's football
 * auto-proposal picks up ANY market with one and looks it up on
 * football-data.org, so an ESPN id there would be sent to the wrong provider.
 * The ESPN id lives in `metadata.espnGameId` instead.
 */
export function buildNbaMatchMarketDto(
  game: NbaGame,
  now = new Date(),
): CreateMarketDto {
  return {
    title: `${game.home.name} vs ${game.away.name}`,
    description: `NBA ${nbaMatchLabel(game.seasonType)} — ${game.away.name} at ${game.home.name}. Who wins?`,
    category: "sports",
    subcategory: NBA_MATCH_SUBCATEGORY,
    externalSource: ESPN_NBA_SOURCE,
    settlementSource: ESPN_NBA_SOURCE,
    externalMarketType: "match-winner",
    espnGameId: game.id,
    matchLabel: nbaMatchLabel(game.seasonType),
    opensAt: now.toISOString(),
    closesAt: game.tipoff,
    resolutionCriteria:
      "Resolved to the winner of the game, including overtime, per the final score published by ESPN. A game that is not played to a final result is refunded.",
    outcomes: [
      { label: game.home.name, imageUrl: game.home.logo },
      { label: game.away.name, imageUrl: game.away.logo },
    ],
  } as CreateMarketDto;
}

/**
 * The outcome that won, or null if the game has no payable result yet or the
 * market's outcomes do not name the winning team.
 *
 * Matched on the exact team name we created the outcome with. There is no
 * fallback to "the first outcome is home": outcome order is not guaranteed
 * when read back, and a renamed outcome is for a human to look at, not for
 * this function to guess.
 */
export function nbaWinnerOutcome(
  outcomes: { id: string; label: string }[],
  game: NbaGame | null,
): { id: string; label: string } | null {
  const result = nbaFinalResult(game);
  if (!result || !game) return null;
  const name = (result.winner === "home" ? game.home : game.away).name;
  const norm = (s: string) => s.trim().toLowerCase();
  const hits = outcomes.filter((o) => norm(o.label) === norm(name));
  return hits.length === 1 ? hits[0] : null;
}
