import { DataSource } from "typeorm";

/**
 * Who actually bet on a market, and where their money went.
 *
 * The admin screens showed pool amounts only, which answers "how much" but not
 * "how many". Nu 50,000 sitting on one outcome means something very different
 * when it came from 200 people than when it came from one — the first is a
 * crowd, the second is a whale the settlement has to pay.
 *
 * Counts are of DISTINCT users, not positions: a person who bets five times is
 * one person. `betCount` keeps the position tally alongside, because the gap
 * between the two is itself the signal (few people, many bets = concentrated).
 */
export interface MarketParticipation {
  /** Distinct users holding at least one position on the market. */
  bettorCount: number;
  /** Positions placed. One person betting five times counts five. */
  betCount: number;
  /** Distinct users per outcome id. */
  byOutcome: Record<string, number>;
  /**
   * Currency the pool is denominated in. Markets carry no currency column —
   * the pool takes whatever the bettors used, and a user's currency is fixed
   * at signup, so a market is single-currency in practice. MIN() collapses the
   * group; a market that somehow mixed shows its alphabetically-first.
   */
  poolCurrency: string;
}

/** One row of the per-market aggregate. */
export interface ParticipationMarketRow {
  marketId: string;
  bettors: number | string;
  bets: number | string;
  currency: string | null;
}

/** One row of the per-outcome aggregate. */
export interface ParticipationOutcomeRow {
  marketId: string;
  outcomeId: string;
  bettors: number | string;
}

const int = (v: number | string | null | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
};

/**
 * Fold the two aggregates into one map, keyed by market id.
 *
 * Split out from the query so the assembly is unit-tested without a database —
 * the same shape `late-money.util.ts` uses.
 *
 * NOTE the per-outcome counts do NOT sum to `bettorCount`. A user who backs
 * three outcomes of the same market is counted once in the market total and
 * once under each outcome. That is not a bug in either number: "how many people
 * are on this outcome" and "how many people are in this market" are different
 * questions, and on the 2026 World Cup market they answer 982 and 441. Anything
 * displaying both must say so rather than let an admin add the column up.
 */
export function buildParticipation(
  markets: ParticipationMarketRow[],
  outcomes: ParticipationOutcomeRow[],
): Map<string, MarketParticipation> {
  const map = new Map<string, MarketParticipation>();
  for (const r of markets) {
    map.set(r.marketId, {
      bettorCount: int(r.bettors),
      betCount: int(r.bets),
      byOutcome: {},
      // No positions yet → nothing staked, so the label is cosmetic. BTN is
      // the platform default and matches users.currency's default.
      poolCurrency: r.currency || "BTN",
    });
  }
  for (const r of outcomes) {
    // A market with outcome rows but no market row cannot happen (both come
    // from the same table), but a defensive create keeps the counts rather
    // than dropping them if that ever changes.
    let entry = map.get(r.marketId);
    if (!entry) {
      entry = {
        bettorCount: 0,
        betCount: 0,
        byOutcome: {},
        poolCurrency: "BTN",
      };
      map.set(r.marketId, entry);
    }
    entry.byOutcome[r.outcomeId] = int(r.bettors);
  }
  return map;
}

/**
 * Participation for a set of markets, in two grouped queries.
 *
 * Both are covered by `IDX_positions_market_placedAt`. Measured on the live
 * database at the admin list's maximum page size — the 500 busiest markets,
 * 19,583 positions — the per-outcome aggregate runs in 12 ms.
 *
 * Every position counts, whatever its status: `refunded` and `lost` bettors
 * still bet. Positions are hard-deleted when a market is cancelled or cleaned
 * up as zero-pool, so such a market reads zero — which is accurate, nobody has
 * money in it any more.
 */
export async function fetchMarketParticipation(
  ds: DataSource,
  marketIds: string[],
): Promise<Map<string, MarketParticipation>> {
  if (marketIds.length === 0) return new Map();

  const [marketRows, outcomeRows] = await Promise.all([
    ds.query(
      `SELECT "marketId",
              COUNT(DISTINCT "userId")::int AS bettors,
              COUNT(*)::int                 AS bets,
              MIN(currency)                 AS currency
         FROM positions
        WHERE "marketId" = ANY($1)
        GROUP BY "marketId"`,
      [marketIds],
    ) as Promise<ParticipationMarketRow[]>,
    ds.query(
      `SELECT "marketId",
              "outcomeId",
              COUNT(DISTINCT "userId")::int AS bettors
         FROM positions
        WHERE "marketId" = ANY($1)
        GROUP BY "marketId", "outcomeId"`,
      [marketIds],
    ) as Promise<ParticipationOutcomeRow[]>,
  ]);

  return buildParticipation(marketRows, outcomeRows);
}

/** The market shape this decorates — anything with an id and outcomes. */
interface DecoratableMarket {
  id: string;
  outcomes?: { id: string }[] | null;
}

/**
 * Attach participation to markets in place, for the admin list and detail
 * responses. Markets with no bets get explicit zeroes rather than undefined, so
 * the client never has to distinguish "no bets" from "not loaded".
 */
export async function attachParticipationTo(
  ds: DataSource,
  markets: DecoratableMarket[],
): Promise<void> {
  if (markets.length === 0) return;
  const byMarket = await fetchMarketParticipation(
    ds,
    markets.map((m) => m.id),
  );

  for (const m of markets) {
    const p = byMarket.get(m.id);
    const target = m as DecoratableMarket & {
      bettorCount: number;
      betCount: number;
      poolCurrency: string;
    };
    target.bettorCount = p?.bettorCount ?? 0;
    target.betCount = p?.betCount ?? 0;
    target.poolCurrency = p?.poolCurrency ?? "BTN";
    for (const o of m.outcomes ?? []) {
      (o as { id: string; bettorCount: number }).bettorCount =
        p?.byOutcome[o.id] ?? 0;
    }
  }
}
