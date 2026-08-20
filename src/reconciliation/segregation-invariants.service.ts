import { Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";

export interface InvariantResult {
  /** Stable identifier, safe to alert on. */
  key: string;
  /** What must be true. */
  assertion: string;
  /** How many rows violate it. Zero, always, for every check here. */
  violations: number;
  /** A bounded sample, for someone opening the alert at 3am. */
  sample: Record<string, unknown>[];
}

const SAMPLE_LIMIT = 10;

/**
 * The checks that prove currency segregation is still holding.
 *
 * Every one of these must return zero. Not "small", not "within tolerance" —
 * zero. A tolerance would hide exactly the class of bug these exist to catch,
 * because the first sign of a leak is always a small number.
 *
 * They are cheap SQL and they are the only thing standing between "we believe
 * the boundary holds" and "we know it does". The guard test proves no *code*
 * sums across currencies; these prove no *data* has crossed.
 *
 * See docs/usdt-oro/SEGREGATION-MODEL.md §9 and STAGE-I-ROLLOUT.md §I.4.
 */
@Injectable()
export class SegregationInvariantsService {
  private readonly logger = new Logger(SegregationInvariantsService.name);

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /** Run everything. Returns each result whether it passed or not. */
  async runAll(): Promise<{
    ok: boolean;
    checkedAt: Date;
    results: InvariantResult[];
  }> {
    const results = [
      await this.noWalletOverdrawn(),
      await this.currenciesAreHoldable(),
      await this.positionsMatchBook(),
      await this.bookTotalsMatchStakes(),
      await this.settlementsBalancePerBook(),
      await this.settlementsMatchBookCurrency(),
      await this.noOrphanBooks(),
    ];

    const failing = results.filter((r) => r.violations > 0);
    for (const f of failing) {
      // Loud on purpose: any non-zero here means money may already have
      // crossed the boundary and everything downstream is suspect.
      this.logger.error(
        `[Segregation] ${f.key} FAILED with ${f.violations} violation(s): ${f.assertion}`,
      );
    }

    return { ok: failing.length === 0, checkedAt: new Date(), results };
  }

  private async check(
    key: string,
    assertion: string,
    sql: string,
  ): Promise<InvariantResult> {
    const rows = await this.ds.query(sql);
    return {
      key,
      assertion,
      violations: rows.length,
      sample: rows.slice(0, SAMPLE_LIMIT),
    };
  }

  /**
   * No wallet is ever overdrawn.
   *
   * The single most important check in this file, and the replacement for two
   * earlier ones that asserted every transaction and every position carried
   * its owner's account currency. Those stopped being true the day an account
   * was allowed to hold ngultrum natively and USDT beside it — but deleting
   * them without a replacement would have left the whole area unguarded.
   *
   * This is the stronger statement anyway. Balances are derived by summing
   * this table per `(userId, currency)`, so a row landing in the wrong wallet
   * either creates money from nowhere or spends money that was never there,
   * and the second half shows up here immediately as a negative sum. It also
   * catches a stake paid out of a wallet that could not fund it, which the old
   * currency-matching check never could.
   *
   * A wallet with no rows at all is not overdrawn; it simply does not exist
   * yet, which is the normal state before a first deposit.
   */
  private noWalletOverdrawn(): Promise<InvariantResult> {
    return this.check(
      "no_wallet_overdrawn",
      "no (user, currency) wallet sums to a negative balance",
      `SELECT t."userId", t.currency, SUM(t.amount) AS balance
         FROM transactions t
        GROUP BY t."userId", t.currency
       HAVING SUM(t.amount) < 0
        LIMIT ${SAMPLE_LIMIT + 1}`,
    );
  }

  /**
   * Every ledger row and every stake is in a currency its owner may hold.
   *
   * The weaker half of what the old account-matching checks did, kept because
   * it still catches a typo'd or unknown currency string, which would create a
   * third wallet nobody can see, spend, or reconcile.
   *
   * A USDT-native account cannot hold ngultrum: BTN only enters through DK
   * Bank, which requires a Bhutanese identity.
   */
  private currenciesAreHoldable(): Promise<InvariantResult> {
    return this.check(
      "currencies_are_holdable",
      "every transaction and position is in a currency its owner may hold",
      `SELECT src.kind, src.id, src."userId", src.currency, u.currency AS account_currency
         FROM (
           SELECT 'transaction' AS kind, t.id::text, t."userId", t.currency
             FROM transactions t
           UNION ALL
           SELECT 'position' AS kind, p.id::text, p."userId", p.currency
             FROM positions p
         ) src
         JOIN users u ON u.id = src."userId"
        WHERE src.currency NOT IN ('BTN', 'USDT')
           OR (u.currency = 'USDT' AND src.currency <> 'USDT')
        LIMIT ${SAMPLE_LIMIT + 1}`,
    );
  }

  /**
   * A stake sits in a book that exists on the market it was placed in.
   *
   * Catches a position whose currency has no book — money in a pool that is
   * not there, which would settle against nothing.
   */
  private positionsMatchBook(): Promise<InvariantResult> {
    return this.check(
      "positions_have_a_book",
      "every position has a market book in its currency",
      `SELECT p.id, p."marketId", p.currency
         FROM positions p
         LEFT JOIN market_books mb
           ON mb."marketId" = p."marketId" AND mb.currency = p.currency
        WHERE mb.id IS NULL
        LIMIT ${SAMPLE_LIMIT + 1}`,
    );
  }

  /**
   * A book's pool equals what was staked into it.
   *
   * Compared only on markets that have not settled: settlement moves money out
   * of the pool without removing the positions, so the two legitimately differ
   * afterwards.
   */
  private bookTotalsMatchStakes(): Promise<InvariantResult> {
    return this.check(
      "book_totals_match_stakes",
      "each open book's totalPool equals the sum of stakes in it",
      `SELECT mb.id, mb."marketId", mb.currency,
              mb."totalPool" AS book_total,
              COALESCE(SUM(p.amount), 0) AS staked
         FROM market_books mb
         JOIN markets m ON m.id = mb."marketId"
         LEFT JOIN positions p
           ON p."marketId" = mb."marketId" AND p.currency = mb.currency
        WHERE m.status NOT IN ('settled', 'cancelled')
        GROUP BY mb.id, mb."marketId", mb.currency, mb."totalPool"
       HAVING mb."totalPool" <> COALESCE(SUM(p.amount), 0)
        LIMIT ${SAMPLE_LIMIT + 1}`,
    );
  }

  /**
   * Every settled book paid out exactly what it held.
   *
   * `totalPaidOut + houseAmount = totalPool`, to the last decimal the currency
   * has. Refunded books are excluded: they return stakes rather than
   * distributing a pool, so the identity does not apply.
   */
  private settlementsBalancePerBook(): Promise<InvariantResult> {
    return this.check(
      "settlements_balance_per_book",
      "for each settled book, totalPaidOut + houseAmount = totalPool",
      `SELECT s.id, s."marketId", s.currency,
              s."totalPool", s."totalPaidOut", s."houseAmount",
              (s."totalPaidOut" + s."houseAmount" - s."totalPool") AS drift
         FROM settlements s
        WHERE s."cancelReason" IS NULL
          AND s."totalPaidOut" + s."houseAmount" <> s."totalPool"
        LIMIT ${SAMPLE_LIMIT + 1}`,
    );
  }

  /** A settlement belongs to a book that exists. */
  private settlementsMatchBookCurrency(): Promise<InvariantResult> {
    return this.check(
      "settlements_have_a_book",
      "every settlement has a market book in its currency",
      `SELECT s.id, s."marketId", s.currency
         FROM settlements s
         LEFT JOIN market_books mb
           ON mb."marketId" = s."marketId" AND mb.currency = s.currency
        WHERE mb.id IS NULL
        LIMIT ${SAMPLE_LIMIT + 1}`,
    );
  }

  /**
   * A book with money in it has an outcome book for every outcome.
   *
   * A missing one means odds cannot be computed for that outcome, and
   * settlement would divide by a winning-side total that is not there.
   */
  private noOrphanBooks(): Promise<InvariantResult> {
    return this.check(
      "outcome_books_complete",
      "every funded market book has an outcome book per outcome",
      `SELECT mb.id, mb."marketId", mb.currency,
              COUNT(o.id) AS outcomes,
              COUNT(ob.id) AS outcome_books
         FROM market_books mb
         JOIN outcomes o ON o."marketId" = mb."marketId"
         LEFT JOIN outcome_books ob
           ON ob."outcomeId" = o.id AND ob.currency = mb.currency
        WHERE mb."totalPool" > 0
        GROUP BY mb.id, mb."marketId", mb.currency
       HAVING COUNT(o.id) <> COUNT(ob.id)
        LIMIT ${SAMPLE_LIMIT + 1}`,
    );
  }
}
