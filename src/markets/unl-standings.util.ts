/**
 * Turning Nations League fixtures into a group table.
 *
 * This competition has no provider — football-data.org's plan does not include
 * it — so every score here was typed in by a person. That shapes two decisions
 * in this file.
 *
 * **A missing score is missing, not nil-nil.** A fixture counts only when both
 * scores are numbers. Reading an absent score as zero is precisely what settled
 * Nottingham Forest v Coventry as a draw in September 2026, via
 * `score.fullTime.home ?? 0`. An unplayed, abandoned or postponed match
 * therefore needs no special case: it simply does not count.
 *
 * **The order is UEFA's, not the convenient one.** Teams level on points are
 * separated by their record against each other *before* goal difference. In a
 * four-team group playing six matches, two teams finishing level on points is
 * the ordinary case rather than a rare one, so a plain points → GD → GF sort
 * would disagree with the published table regularly, not occasionally.
 *
 * These tables are **display-only**. Nothing settles from them. If a "group
 * winner" market is ever added, revisit this file first — at that point an
 * ordering bug stops being cosmetic and starts paying the wrong person.
 */

/** Structurally identical to `EplStandingRow`, so the app's table markup is a copy. */
export interface UnlStandingRow {
  position: number;
  teamName: string;
  teamBadge: string;
  played: number;
  won: number;
  draw: number;
  lost: number;
  gf: number;
  ga: number;
  gd: number;
  points: number;
}

/** Only what the maths needs, so this is testable without a database. */
export interface StandingsTeam {
  id: string;
  name: string;
  flagUrl: string | null;
  sortOrder: number;
}

export interface StandingsFixture {
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number | null;
  awayScore: number | null;
}

interface Tally {
  played: number;
  won: number;
  draw: number;
  lost: number;
  gf: number;
  ga: number;
  points: number;
}

const WIN_POINTS = 3;
const DRAW_POINTS = 1;

const emptyTally = (): Tally => ({
  played: 0,
  won: 0,
  draw: 0,
  lost: 0,
  gf: 0,
  ga: 0,
  points: 0,
});

/**
 * A fixture is playable into the table only with two real numbers.
 *
 * `typeof x === "number"` rather than a truthiness or null check on purpose: a
 * legitimate 0 must pass, and a string "2" from a careless JSON body must not.
 */
function isCounted(f: StandingsFixture): boolean {
  return typeof f.homeScore === "number" && typeof f.awayScore === "number";
}

/** Accumulate a set of fixtures into per-team tallies, restricted to `ids`. */
function tallyFor(
  ids: Set<string>,
  fixtures: StandingsFixture[],
): Map<string, Tally> {
  const table = new Map<string, Tally>();
  for (const id of ids) table.set(id, emptyTally());

  for (const f of fixtures) {
    if (!isCounted(f)) continue;
    if (!ids.has(f.homeTeamId) || !ids.has(f.awayTeamId)) continue;

    const home = table.get(f.homeTeamId)!;
    const away = table.get(f.awayTeamId)!;
    const hs = f.homeScore as number;
    const as = f.awayScore as number;

    home.played++;
    away.played++;
    home.gf += hs;
    home.ga += as;
    away.gf += as;
    away.ga += hs;

    if (hs > as) {
      home.won++;
      away.lost++;
      home.points += WIN_POINTS;
    } else if (hs < as) {
      away.won++;
      home.lost++;
      away.points += WIN_POINTS;
    } else {
      home.draw++;
      away.draw++;
      home.points += DRAW_POINTS;
      away.points += DRAW_POINTS;
    }
  }

  return table;
}

const gdOf = (t: Tally) => t.gf - t.ga;

/**
 * Order a set of teams that are level on points, by UEFA's criteria.
 *
 * Head-to-head is a *mini-table* over only the matches between the tied teams —
 * not a pairwise comparison — so with three teams level it is their results
 * against each other that rank them, ignoring everything else in the group.
 *
 * Where the mini-table separates some teams but leaves a smaller set still
 * level, UEFA re-applies the same criteria to that smaller set. That is the
 * recursion here, and it terminates because it only recurses when the subset is
 * strictly smaller than what came in; otherwise head-to-head has said all it
 * can and we fall through to the group-wide criteria.
 */
function orderLevelTeams(
  ids: string[],
  overall: Map<string, Tally>,
  fixtures: StandingsFixture[],
  teamById: Map<string, StandingsTeam>,
): string[] {
  if (ids.length <= 1) return ids;

  const idSet = new Set(ids);
  const mini = tallyFor(idSet, fixtures);

  const key = (id: string) => {
    const m = mini.get(id)!;
    return `${m.points}|${gdOf(m)}|${m.gf}`;
  };

  const sorted = [...ids].sort((a, b) => {
    const ma = mini.get(a)!;
    const mb = mini.get(b)!;
    return (
      mb.points - ma.points ||
      gdOf(mb) - gdOf(ma) ||
      mb.gf - ma.gf ||
      0
    );
  });

  // Re-group by identical head-to-head record, preserving the order above.
  const buckets: string[][] = [];
  for (const id of sorted) {
    const last = buckets[buckets.length - 1];
    if (last && key(last[0]) === key(id)) last.push(id);
    else buckets.push([id]);
  }

  return buckets.flatMap((bucket) => {
    if (bucket.length === 1) return bucket;
    // Head-to-head separated nothing at this level — stop recursing or we loop.
    if (bucket.length === ids.length) return fallbackOrder(bucket, overall, teamById);
    return orderLevelTeams(bucket, overall, fixtures, teamById);
  });
}

/**
 * The group-wide criteria, used once head-to-head has nothing left to say.
 *
 * Ends on `sortOrder` then `id` so the comparison is *total*: UEFA's remaining
 * tiebreakers are disciplinary points and national-team coefficient, neither of
 * which we hold, and a table that reorders itself between two reads of
 * unchanged data would look like a bug even when the data is fine.
 */
function fallbackOrder(
  ids: string[],
  overall: Map<string, Tally>,
  teamById: Map<string, StandingsTeam>,
): string[] {
  return [...ids].sort((a, b) => {
    const ta = overall.get(a)!;
    const tb = overall.get(b)!;
    return (
      gdOf(tb) - gdOf(ta) ||
      tb.gf - ta.gf ||
      (teamById.get(a)?.sortOrder ?? 0) - (teamById.get(b)?.sortOrder ?? 0) ||
      a.localeCompare(b)
    );
  });
}

/**
 * The group table.
 *
 * The team list comes from `teams`, never from the fixtures, so all four
 * nations appear on zero before a ball is kicked — which is what the group
 * screens show for most of a Nations League cycle.
 *
 * Fixtures involving a team not in `teams` are ignored rather than trusted,
 * so a stray row from another group or season cannot leak into a table.
 */
export function computeGroupTable(
  teams: StandingsTeam[],
  fixtures: StandingsFixture[],
): UnlStandingRow[] {
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const ids = new Set(teamById.keys());
  const overall = tallyFor(ids, fixtures);

  // Points first, then everything else within each level set.
  const byPoints = new Map<number, string[]>();
  for (const id of ids) {
    const p = overall.get(id)!.points;
    if (!byPoints.has(p)) byPoints.set(p, []);
    byPoints.get(p)!.push(id);
  }

  const ordered = [...byPoints.keys()]
    .sort((a, b) => b - a)
    .flatMap((p) =>
      orderLevelTeams(byPoints.get(p)!, overall, fixtures, teamById),
    );

  return ordered.map((id, i) => {
    const t = overall.get(id)!;
    const team = teamById.get(id)!;
    return {
      position: i + 1,
      teamName: team.name,
      teamBadge: team.flagUrl ?? "",
      played: t.played,
      won: t.won,
      draw: t.draw,
      lost: t.lost,
      gf: t.gf,
      ga: t.ga,
      gd: gdOf(t),
      points: t.points,
    };
  });
}
