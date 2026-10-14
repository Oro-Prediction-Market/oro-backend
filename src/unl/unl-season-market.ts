import { CreateMarketDto } from "../markets/dto/create-market.dto";

/**
 * The Nations League season market: "who wins it?".
 *
 * Built from the draw already in `unl_teams`, so an admin does not type every
 * nation and flag into the generic form. Only League A is listed — its four
 * group winners play the Finals, so no other nation can lift the trophy, and
 * listing them would put 38 options on the market that cannot win.
 */
export const UNL_SEASON_SUBCATEGORY = "unl-season";

/** League A's groups. Must match `TIERS` in the apps' Nations League hub. */
export const LEAGUE_A_GROUPS = ["A", "B", "C", "D"];

export interface UnlSeasonTeam {
  groupKey: string;
  name: string;
  flagUrl: string | null;
}

/** League A nations, in the order `listTeams` returns them (group, then draw). */
export function leagueATeams<T extends UnlSeasonTeam>(teams: T[]): T[] {
  return teams.filter((t) =>
    LEAGUE_A_GROUPS.includes((t.groupKey ?? "").toUpperCase()),
  );
}

/** "2026-27" → "2026/27". Anything else is used as it is. */
export function seasonLabel(season: string): string {
  return season.replace(/^(\d{4})-(\d{2})$/, "$1/$2");
}

/** Build the CreateMarketDto for the season market from League A's teams. */
export function buildUnlSeasonMarketDto(
  season: string,
  teams: UnlSeasonTeam[],
  closesAt: string,
): CreateMarketDto {
  const label = seasonLabel(season);
  return {
    title: `Who wins the ${label} UEFA Nations League?`,
    description: `Pick the nation that lifts the ${label} UEFA Nations League trophy.`,
    category: "sports",
    subcategory: UNL_SEASON_SUBCATEGORY,
    resolutionCriteria:
      `Resolved to the nation that wins the ${label} UEFA Nations League Finals, ` +
      `per UEFA's official result.`,
    opensAt: new Date().toISOString(),
    closesAt,
    // Settled by a person, like every other market in this competition. The
    // same externalSource keeps it out of the auto-settlers without a new rule.
    externalSource: "unl-manual",
    settlementSource: "Official UEFA Nations League",
    outcomes: leagueATeams(teams).map((t) => ({
      label: t.name,
      imageUrl: t.flagUrl,
    })),
  };
}
