import { CreateMarketDto } from "../markets/dto/create-market.dto";

/**
 * Nations League season markets, built from the draw.
 *
 * The nations come from `unl_teams`, so an admin ticks them instead of typing
 * each one and its flag into the generic form. The admin chooses the nations,
 * the name and the dates; the builder lists exactly the nations chosen.
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

/** What the admin types in before the market is created. */
export interface UnlSeasonMarketInput {
  title: string;
  opensAt: string;
  closesAt: string;
}

/** Build the CreateMarketDto for a season market from the chosen nations. */
export function buildUnlSeasonMarketDto(
  season: string,
  teams: UnlSeasonTeam[],
  input: UnlSeasonMarketInput,
): CreateMarketDto {
  return {
    // The admin names it, so it can be any season question — "who wins it",
    // "who tops Group A", "who is relegated from League A" — not just one.
    title: input.title,
    description: `${input.title} (UEFA Nations League ${seasonLabel(season)})`,
    category: "sports",
    subcategory: UNL_SEASON_SUBCATEGORY,
    resolutionCriteria:
      `Resolved to the nation that answers "${input.title}", per UEFA's official ` +
      `${seasonLabel(season)} Nations League results.`,
    opensAt: input.opensAt,
    closesAt: input.closesAt,
    // Settled by a person, like every other market in this competition. The
    // same externalSource keeps it out of the auto-settlers without a new rule.
    externalSource: "unl-manual",
    settlementSource: "Official UEFA Nations League",
    outcomes: teams.map((t) => ({ label: t.name, imageUrl: t.flagUrl })),
  };
}
