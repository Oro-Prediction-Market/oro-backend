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
      await this.usdtCreditsTraceToIntents(),
      await this.usdtDebitsTraceToWithdrawals(),
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

  /**
   * Every USDT credit in the ledger came from a deposit 21Pay told us about,
   * for the amount 21Pay said arrived.
   *
   * The seven checks above are all internal consistency: balances derive
   * correctly, books add up, settlements balance. This one is wider — it holds
   * the ledger against a second table written by a different code path — but
   * be precise about how much wider, because it is tempting to over-trust:
   *
   * **It would not have caught the staging ledger that met the production
   * gateway.** Those credits each had an intent row behind them, of the right
   * amount, for the right user. Ledger and intents agreed perfectly; both were
   * describing deposits that the production tenant had never received. Only
   * custody parity catches that, and see the note at the end of this comment.
   *
   * What it does catch is drift between the two: a credit that entered the
   * ledger through some path other than a settled intent, an intent credited
   * for a different amount than the ledger row carries, or a credit landing in
   * the wrong user's wallet.
   *
   * Two directions, because they fail differently:
   *
   * - A credited intent whose ledger row is missing, is in the wrong currency
   *   or type, belongs to another user, or carries a different amount. That is
   *   a deposit we recorded and then mis-credited.
   * - Below, a USDT deposit row with no intent behind it at all. That is the
   *   mint-money shape: a credit that entered the ledger through some path
   *   other than a confirmed on-chain deposit.
   *
   * Note what this still does not do: it proves the ledger agrees with **our
   * own** record of the gateway, not with 21Pay's custody balance. Full
   * custody parity — SEGREGATION-MODEL §9 — needs a tenant balance endpoint
   * the client does not have a contract for yet.
   */
  private usdtCreditsTraceToIntents(): Promise<InvariantResult> {
    return this.check(
      "usdt_credits_trace_to_intents",
      "every USDT deposit is a credited 21Pay intent, and every credited intent is one ledger row of the same amount",
      `SELECT reason, id, "userId", amount FROM (
         SELECT 'intent credited without a matching ledger row' AS reason,
                i."pay21IntentId" AS id, i."userId",
                i."detectedAmountUsdt" AS amount
           FROM crypto_payment_intents i
           LEFT JOIN transactions t ON t.id = i."transactionId"
          WHERE i."creditedAt" IS NOT NULL
            AND (t.id IS NULL
                 OR t.currency <> 'USDT'
                 OR t.type <> 'deposit'
                 OR t."userId" <> i."userId"
                 OR t.amount <> i."detectedAmountUsdt")
         UNION ALL
         SELECT 'USDT credit with no 21Pay intent behind it' AS reason,
                t.id::text AS id, t."userId", t.amount AS amount
           FROM transactions t
          WHERE t.currency = 'USDT'
            AND t.type = 'deposit'
            AND NOT EXISTS (
              SELECT 1 FROM crypto_payment_intents i
               WHERE i."transactionId" = t.id
            )
       ) x
       LIMIT ${SAMPLE_LIMIT + 1}`,
    );
  }

  /**
   * Every USDT debit in the ledger is a withdrawal we actually requested.
   *
   * The mirror of the check above, on the side where money leaves. A debit
   * with no withdrawal record is money removed from a user's wallet by
   * something other than a payout, which is the shape of both a bug and a
   * theft; a withdrawal whose debit is missing is money sent on-chain that the
   * user was never charged for.
   */
  private usdtDebitsTraceToWithdrawals(): Promise<InvariantResult> {
    return this.check(
      "usdt_debits_trace_to_withdrawals",
      "every USDT withdrawal debit matches one crypto_withdrawals row of the same amount",
      `SELECT reason, id, "userId", amount FROM (
         SELECT 'USDT debit with no withdrawal record' AS reason,
                t.id::text AS id, t."userId", t.amount AS amount
           FROM transactions t
          WHERE t.currency = 'USDT'
            AND t.type = 'withdrawal'
            AND NOT EXISTS (
              SELECT 1 FROM crypto_withdrawals w
               WHERE w."debitTransactionId" = t.id
            )
         UNION ALL
         SELECT 'withdrawal debited for the wrong amount or wallet' AS reason,
                w.id::text AS id, w."userId", w."amountUsdt" AS amount
           FROM crypto_withdrawals w
           JOIN transactions t ON t.id = w."debitTransactionId"
          WHERE t.currency <> 'USDT'
             OR t."userId" <> w."userId"
             OR ABS(t.amount) <> w."amountUsdt"
       ) x
       LIMIT ${SAMPLE_LIMIT + 1}`,
    );
  }
}
