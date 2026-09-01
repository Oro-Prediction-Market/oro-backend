import { EntityManager } from "typeorm";
import { Market } from "../entities/market.entity";
import { MarketBook } from "../entities/market-book.entity";
import { OutcomeBook } from "../entities/outcome-book.entity";
import { BTN_CURRENCY } from "../entities/transaction.entity";
import { USDT } from "../shared/utils/wallet.util";

/**
 * Minimum stake for the ngultrum book of a market.
 *
 * Mirrors the rule the engine has always applied: TER and BTC markets take
 * Nu 10, everything else Nu 50. It lives here so the migration backfill, the
 * lazy book creation below, and the engine cannot drift apart.
 *
 * A USDT book's minimum is not a conversion of this — no exchange rate exists
 * in this system — so it is a separate number, {@link usdtMinStake}.
 */
export function btnMinStakeFor(market: Pick<Market, "externalSource">): number {
  return ["ter", "btc"].includes(market.externalSource ?? "") ? 10 : 50;
}

/**
 * Minimum stake for a USDT book.
 *
 * A chosen number, never a conversion: no exchange rate exists anywhere in
 * this system. `USDT_MIN_STAKE` overrides it per deployment; the default of 1
 * is the smallest amount worth the chain fee to have deposited in the first
 * place.
 */
export function usdtMinStake(): number {
  const raw = Number(process.env.USDT_MIN_STAKE);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/**
 * Floor for the first objector's chosen bond, per currency.
 *
 * A resolution contest is settled inside the book its bonds were locked in, so
 * each book needs its own floor. Like the stake minimums above these are chosen
 * numbers and never conversions — no exchange rate exists anywhere in this
 * system, and inventing one here would be inventing one for the forfeit pool
 * too.
 *
 * The floor exists to deter casual and abusive objections while staying
 * reachable for a bettor with a genuine grievance, which is a judgement about
 * each cohort separately: Nu 10 against a Nu 50 minimum stake, and 0.5 against
 * a 1 USDT minimum stake. Both are overridable per deployment.
 */
export function btnMinDisputeBond(): number {
  const raw = Number(process.env.BTN_MIN_DISPUTE_BOND);
  return Number.isFinite(raw) && raw > 0 ? raw : 10;
}

export function usdtMinDisputeBond(): number {
  const raw = Number(process.env.USDT_MIN_DISPUTE_BOND);
  return Number.isFinite(raw) && raw > 0 ? raw : 0.5;
}

/**
 * The bond floor for one book's contest.
 *
 * Throws rather than defaulting on an unrecognised currency: a silent fallback
 * to the ngultrum floor would quote a bettor a number from the wrong cohort,
 * and the same mistake in the other direction is how bonds ended up crossing
 * books in the first place.
 */
export function minDisputeBondFor(currency: string): number {
  switch (currency) {
    case BTN_CURRENCY:
      return btnMinDisputeBond();
    case USDT:
      return usdtMinDisputeBond();
    default:
      throw new Error(
        `No dispute bond floor defined for currency "${currency}". ` +
          `Add one to minDisputeBondFor before opening a contest in it.`,
      );
  }
}

/**
 * Get a market's book in one currency, creating it if it does not exist.
 *
 * Both currencies are created on demand now. USDT used to be admin-only, on
 * the reasoning that its terms are business decisions — but the effect was
 * that a user holding USDT could not bet on anything until somebody opened a
 * book for that market by hand, one market at a time. Someone who has
 * deposited should be able to place a prediction, and an admin step between
 * those two things is a step that will not happen.
 *
 * The terms it opens with are deliberate defaults, not conversions: the
 * market's own platform cut, and {@link usdtMinStake}. An admin can still
 * change either through the books API, up until the book has stakes.
 *
 * **Cold start is the real cost here**, and it is a product problem rather
 * than a correctness one: a USDT book with one participant refunds or pays the
 * floor. Worth watching once there is real volume — see STAGE-I.7.
 */
export async function ensureBook(
  em: EntityManager,
  market: Market,
  currency: string,
): Promise<MarketBook> {
  if (currency === BTN_CURRENCY) return ensureBtnBook(em, market);

  const existing = await em.findOne(MarketBook, {
    where: { marketId: market.id, currency },
  });
  if (existing) return existing;

  await em.query(
    `INSERT INTO "market_books" ("marketId", "currency", "totalPool", "houseEdgePct", "minStake")
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT ("marketId", "currency") DO NOTHING`,
    // Starts empty. Unlike the BTN book, there is no legacy pool to carry
    // over — `markets.totalPool` is the ngultrum figure and always was.
    [market.id, currency, 0, Number(market.houseEdgePct), usdtMinStake()],
  );

  const book = await em.findOne(MarketBook, {
    where: { marketId: market.id, currency },
  });
  if (!book) {
    throw new Error(
      `Failed to create ${currency} book for market ${market.id}`,
    );
  }
  return book;
}

/**
 * Get the BTN book for a market, creating it if it does not exist.
 *
 * The C7 backfill gave every market that existed at migration time a BTN book,
 * but markets are created from several paths — the admin API, the EPL and UCL
 * schedulers, the BTC and TER jobs — and adding book creation to each is a
 * list that will be incomplete the moment someone adds a sixth. Creating it on
 * demand at the point of first use covers all of them, including any added
 * later, and is idempotent.
 *
 * For any other currency see {@link ensureBook}, which this one backs.
 */
export async function ensureBtnBook(
  em: EntityManager,
  market: Market,
): Promise<MarketBook> {
  const existing = await em.findOne(MarketBook, {
    where: { marketId: market.id, currency: BTN_CURRENCY },
  });
  if (existing) return existing;

  await em.query(
    `INSERT INTO "market_books" ("marketId", "currency", "totalPool", "houseEdgePct", "minStake")
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT ("marketId", "currency") DO NOTHING`,
    [
      market.id,
      BTN_CURRENCY,
      Number(market.totalPool) || 0,
      Number(market.houseEdgePct),
      btnMinStakeFor(market),
    ],
  );

  const book = await em.findOne(MarketBook, {
    where: { marketId: market.id, currency: BTN_CURRENCY },
  });
  if (!book) {
    throw new Error(`Failed to create BTN book for market ${market.id}`);
  }
  return book;
}

/**
 * Get this book's per-outcome rows, creating any that are missing.
 *
 * Returned in the same order as `market.outcomes`, because the LMSR service
 * pairs probabilities to outcomes positionally.
 */
export async function ensureOutcomeBooks(
  em: EntityManager,
  market: Market,
  currency: string,
): Promise<OutcomeBook[]> {
  const outcomeIds = market.outcomes.map((o) => o.id);
  if (outcomeIds.length === 0) return [];

  for (const outcome of market.outcomes) {
    await em.query(
      `INSERT INTO "outcome_books" ("outcomeId", "currency", "totalBetAmount", "currentOdds", "lmsrProbability")
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT ("outcomeId", "currency") DO NOTHING`,
      [
        outcome.id,
        currency,
        currency === BTN_CURRENCY ? Number(outcome.totalBetAmount) || 0 : 0,
        currency === BTN_CURRENCY ? Number(outcome.currentOdds) || 0 : 0,
        currency === BTN_CURRENCY ? Number(outcome.lmsrProbability) || 0 : 0,
      ],
    );
  }

  const books = await em.find(OutcomeBook, {
    where: outcomeIds.map((id) => ({ outcomeId: id, currency })),
  });
  const byOutcome = new Map(books.map((b) => [b.outcomeId, b]));
  return market.outcomes.map((o) => {
    const book = byOutcome.get(o.id);
    if (!book) {
      throw new Error(
        `Missing ${currency} outcome book for outcome ${o.id}`,
      );
    }
    return book;
  });
}
