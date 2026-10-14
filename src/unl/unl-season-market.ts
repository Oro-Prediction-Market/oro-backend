import { CreateMarketDto } from "../markets/dto/create-market.dto";

/**
 * The Nations League season market: "who wins it?".
 *
 * Built from the draw already in `unl_teams`, so an admin ticks nations
 * instead of typing each one and its flag into the generic form. The admin
 * chooses which nations; the builder lists exactly those.
 */
export const UNL_SEASON_SUBCATEGORY = "unl-season";

/** League per group. Must match `TIERS` in the apps' Nations League hub. */
const LEAGUE_GROUPS: Record<string, string[]> = {
  A: ["A", "B", "C", "D"],
  B: ["E", "F", "G", "H"],
  C: ["I", "J", "K", "L"],
  D: ["M", "N"],
};

/** "A".."D" for a group letter, or null for one outside the four leagues. */
export function leagueOf(groupKey: string): string | null {
  const g = (groupKey ?? "").toUpperCase();
  for (const [league, groups] of Object.entries(LEAGUE_GROUPS)) {
    if (groups.includes(g)) return league;
  }
  return null;
}

export interface UnlSeasonTeam {
  groupKey: string;
  name: string;
  flagUrl: string | null;
}

/** "2026-27" → "2026/27". Anything else is used as it is. */
export function seasonLabel(season: string): string {
  return season.replace(/^(\d{4})-(\d{2})$/, "$1/$2");
}

/** Build the CreateMarketDto for the season market from the chosen nations. */
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
    outcomes: teams.map((t) => ({ label: t.name, imageUrl: t.flagUrl })),
  };
}
