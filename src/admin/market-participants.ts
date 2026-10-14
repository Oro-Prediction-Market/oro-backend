import { DataSource } from "typeorm";

/**
 * Who bet on each outcome of one market, how much, and who was paid what.
 *
 * The admin market view showed only per-outcome totals, so "Nu 550 from 8
 * people" could not be traced to the people. This lists them: one row per
 * person per outcome (repeat bets summed, with a count), the winners with what
 * they were paid, and the refunds when the market was refunded.
 *
 * Read-only. Identity is the name fields only — no CID, phone or email; the
 * admin opens the user dossier for more.
 */

/** One row of the per-(user, outcome, currency) aggregate. */
export interface ParticipantRow {
  userId: string;
  outcomeId: string;
  currency: string | null;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  stake: number | string;
  bets: number | string;
  firstBetAt: Date | string | null;
  lastBetAt: Date | string | null;
  won: boolean;
  payout: number | string | null;
  refunded: number | string | null;
  bonusFunded: boolean;
  streakBonus: number | string | null;
}

export interface OutcomeInfo {
  id: string;
  label: string;
  isWinner: boolean;
}

interface Person {
  userId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
}

export interface Backer extends Person {
  stake: string;
  bets: number;
  firstBetAt: string | null;
  lastBetAt: string | null;
  bonusFunded: boolean;
}

export interface OutcomeBackers {
  outcomeId: string;
  label: string;
  isWinner: boolean;
  currency: string;
  people: number;
  totalStake: string;
  backers: Backer[];
}

export interface Winner extends Person {
  outcomeId: string;
  outcomeLabel: string;
  currency: string;
  stake: string;
  payout: string;
  streakBonus: string;
  totalPaid: string;
}

export interface Refund extends Person {
  outcomeId: string;
  outcomeLabel: string;
  currency: string;
  refunded: string;
}

export interface MarketParticipants {
  marketId: string;
  status: string;
  currencies: string[];
  outcomes: OutcomeBackers[];
  winners: Winner[];
  refunds: Refund[];
  /** Per currency — BTN and USDT are never added together. */
  totals: Record<
    string,
    {
      people: number;
      positions: number;
      staked: string;
      paidOut: string;
      refunded: string;
    }
  >;
}

const num = (v: number | string | null | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const money = (n: number): string => n.toFixed(2);
const iso = (v: Date | string | null): string | null =>
  v == null ? null : new Date(v).toISOString();

/**
 * Fold the aggregate rows into the response. Pure, so it is tested without a
 * database (the shape `market-participation.ts` and `late-money.util.ts` use).
 *
 * Winners are rows holding a `won` position — not "backed the winning
 * outcome". A settlement correction in keep mode leaves wrongly-paid people
 * `won` on a losing outcome; they were paid, so they are listed.
 */
export function buildMarketParticipants(
  marketId: string,
  status: string,
  outcomes: OutcomeInfo[],
  rows: ParticipantRow[],
): MarketParticipants {
  const label = new Map(outcomes.map((o) => [o.id, o.label]));
  const currencies = [...new Set(rows.map((r) => r.currency ?? "BTN"))].sort();
  const person = (r: ParticipantRow): Person => ({
    userId: r.userId,
    username: r.username,
    firstName: r.firstName,
    lastName: r.lastName,
  });

  // One block per (outcome, currency) that has bets; outcomes nobody backed
  // still get an empty block in the market's currency so every option shows.
  const blocks: OutcomeBackers[] = [];
  for (const o of outcomes) {
    const forOutcome = rows.filter((r) => r.outcomeId === o.id);
    const inCurrencies = forOutcome.length
      ? [...new Set(forOutcome.map((r) => r.currency ?? "BTN"))].sort()
      : [currencies[0] ?? "BTN"];
    for (const currency of inCurrencies) {
      const mine = forOutcome
        .filter((r) => (r.currency ?? "BTN") === currency)
        .sort((a, b) => num(b.stake) - num(a.stake));
      blocks.push({
        outcomeId: o.id,
        label: o.label,
        isWinner: o.isWinner,
        currency,
        people: new Set(mine.map((r) => r.userId)).size,
        totalStake: money(mine.reduce((s, r) => s + num(r.stake), 0)),
        backers: mine.map((r) => ({
          ...person(r),
          stake: money(num(r.stake)),
          bets: Math.trunc(num(r.bets)),
          firstBetAt: iso(r.firstBetAt),
          lastBetAt: iso(r.lastBetAt),
          bonusFunded: !!r.bonusFunded,
        })),
      });
    }
  }

  const winners: Winner[] = rows
    .filter((r) => r.won)
    .map((r) => {
      const payout = num(r.payout);
      const streak = num(r.streakBonus);
      return {
        ...person(r),
        outcomeId: r.outcomeId,
        outcomeLabel: label.get(r.outcomeId) ?? "(removed outcome)",
        currency: r.currency ?? "BTN",
        stake: money(num(r.stake)),
        payout: money(payout),
        streakBonus: money(streak),
        totalPaid: money(payout + streak),
      };
    })
    .sort((a, b) => num(b.totalPaid) - num(a.totalPaid));

  const refunds: Refund[] = rows
    .filter((r) => num(r.refunded) > 0)
    .map((r) => ({
      ...person(r),
      outcomeId: r.outcomeId,
      outcomeLabel: label.get(r.outcomeId) ?? "(removed outcome)",
      currency: r.currency ?? "BTN",
      refunded: money(num(r.refunded)),
    }))
    .sort((a, b) => num(b.refunded) - num(a.refunded));

  const totals: MarketParticipants["totals"] = {};
  for (const currency of currencies) {
    const inC = rows.filter((r) => (r.currency ?? "BTN") === currency);
    totals[currency] = {
      people: new Set(inC.map((r) => r.userId)).size,
      positions: inC.reduce((s, r) => s + Math.trunc(num(r.bets)), 0),
      staked: money(inC.reduce((s, r) => s + num(r.stake), 0)),
      paidOut: money(
        winners
          .filter((w) => w.currency === currency)
          .reduce((s, w) => s + num(w.totalPaid), 0),
      ),
      refunded: money(inC.reduce((s, r) => s + num(r.refunded), 0)),
    };
  }

  return {
    marketId,
    status,
    currencies,
    outcomes: blocks,
    winners,
    refunds,
    totals,
  };
}

/**
 * One grouped query over the market's positions (served by the
 * (marketId, placedAt) index), joined to the user's name fields, with each
 * group's streak bonus from the ledger: settlement pays it as a separate
 * transaction, not inside positions.payout.
 */
export const PARTICIPANTS_SQL = `
  SELECT p."userId", p."outcomeId", p.currency,
         u.username, u."firstName", u."lastName",
         SUM(p.amount) AS stake,
         COUNT(*) AS bets,
         MIN(p."placedAt") AS "firstBetAt",
         MAX(p."placedAt") AS "lastBetAt",
         bool_or(p.status = 'won') AS won,
         SUM(p.payout) FILTER (WHERE p.status = 'won') AS payout,
         SUM(p.amount) FILTER (WHERE p.status = 'refunded') AS refunded,
         bool_or(p."isBonusFunded") AS "bonusFunded",
         COALESCE(SUM(sb.amount), 0) AS "streakBonus"
    FROM positions p
    JOIN users u ON u.id = p."userId"
    LEFT JOIN (
      SELECT t."positionId", SUM(t.amount) AS amount
        FROM transactions t
       WHERE t.type = 'streak_bonus'
         AND t."positionId" IN (SELECT id FROM positions WHERE "marketId" = $1)
       GROUP BY t."positionId"
    ) sb ON sb."positionId" = p.id
   WHERE p."marketId" = $1
   GROUP BY p."userId", p."outcomeId", p.currency,
            u.username, u."firstName", u."lastName"`;

export async function fetchMarketParticipants(
  dataSource: DataSource,
  marketId: string,
): Promise<MarketParticipants | null> {
  const [market] = await dataSource.query(
    `SELECT id, status FROM markets WHERE id = $1`,
    [marketId],
  );
  if (!market) return null;
  const outcomes: OutcomeInfo[] = (
    await dataSource.query(
      `SELECT id, label, "isWinner" FROM outcomes
        WHERE "marketId" = $1 ORDER BY "sortOrder" ASC, label ASC`,
      [marketId],
    )
  ).map((o: any) => ({ id: o.id, label: o.label, isWinner: !!o.isWinner }));
  const rows: ParticipantRow[] = await dataSource.query(PARTICIPANTS_SQL, [
    marketId,
  ]);
  return buildMarketParticipants(marketId, market.status, outcomes, rows);
}
