# Segregation Model on Oro

> Read before Stage B, B′, E, F, or H. This is the reference for how money is
> denominated, kept apart, and reconciled **in Oro's schema specifically.**
>
> The conceptual argument for segregation over FX conversion is in
> [`../usdt-21pay/SEGREGATION-MODEL.md`](../usdt-21pay/SEGREGATION-MODEL.md)
> and is not repeated here. This document is about mechanics.

## 1. The model

```
BTN                                    USDT
───                                    ────
DK Bank deposit                        21Pay deposit (on-chain)
      ↓                                      ↓
transactions(currency='BTN')           transactions(currency='USDT')
      ↓                                      ↓
BTN book of a market ──→ BTN payout    USDT book of same market ──→ USDT payout
      ↓                                      ↓
DK Bank withdrawal                     21Pay payout (on-chain)
```

Two vertical columns. **No horizontal arrow exists at any layer.**

## 2. Where currency lives

Oro has no wallets table. Segregation is expressed with two columns and one
rule.

| Column | Purpose |
|---|---|
| `users.currency` | The account's currency. Set at creation, never changed. The authority. |
| `transactions.currency` | The ledger row's currency. Backfilled `'BTN'`, `NOT NULL`. |

A user's balance is:

```sql
SELECT COALESCE(SUM(amount), 0)
FROM transactions
WHERE "userId" = ? AND currency = ?
```

**`users.currency` is not a denormalisation of the ledger, and the two must
never disagree.** A row whose currency differs from its owner's account
currency is a segregation breach, and Stage I checks for exactly that.

This is deliberately *simpler* than the source plan's wallets table. Because a
user holds exactly one currency, `(userId, currency)` uniqueness is trivially
satisfied by the account itself. Do not introduce a wallets table to mirror
LuckyPemX; it would add a join to the hottest query in the system and buy
nothing.

## 3. The 48 sums are the whole problem

Balance is derived, so **every place that derives it is a place segregation can
leak.** Forty-eight ledger sums exist across fourteen files — the full
file-and-line worklist is in
[Stage B.2](./STAGE-B-LEDGER-SEGREGATION.md#b2-the-worklist).

| Area | Sites |
|---|---|
| Market money path | `markets/parimutuel.engine.ts` (6), `markets/markets.service.ts` (1) |
| Payments | `payment/dkbank-payment.service.ts` (4) |
| Auth | `auth/auth.service.ts` (4) |
| Admin | `admin/admin.controller.ts` (6) |
| AML | `aml/aml-detector.service.ts` (3, raw SQL) |
| Users / progression | `users/users.controller.ts` (2), `users/streak.service.ts`, `users/season.service.ts`, `jobs/engagement.job.ts` |
| Challenges | `challenges/challenges.service.ts` (2) |
| Reporting / reconciliation | `reporting/reporting.service.ts`, `reconciliation/reconciliation.service.ts`, `reconcile-duplicate-payouts.ts` |

An unfiltered sum does not throw, does not log, and returns a plausible number.
It simply adds the USDT book into the BTN book. The user sees a larger BTN
balance, can stake it into a BTN book, and can withdraw it through DK Bank.

**This is a mint-money bug, and it is invisible until the first USDT row
exists.** Which is to say: it will not be caught in staging unless staging has
USDT rows.

The mitigation is not review. It is [Stage B.3](./STAGE-B-LEDGER-SEGREGATION.md#b3-the-static-guard):
a test that scans source for `SUM(amount)` over the ledger and fails on any
occurrence that is not currency-scoped. That test already exists on branch
`safety/pre-uncommit` and is the single most valuable thing to salvage.

## 4. One market, two books

A market is one event with one resolution. What splits by currency is the pool
underneath it.

```
Market: "Will Bhutan beat Nepal?"     ← one row, one resolution, one card
  ├── BTN book    Nu 20,000    edge 10%
  └── USDT book   $420         edge 8%
```

The market card shows both figures side by side and **never sums them.** There
is no exchange rate in this system, so `Nu 20,000 + $420` is not a quantity.
Each number is the real payout basis for its own book.

`market_books` is keyed `(marketId, currency)` and carries the pool total, the
platform cut, and the minimum stake. `outcome_books` is keyed
`(outcomeId, currency)` and carries per-book stake totals, odds, and LMSR
probability — all three derive from stake distribution, so all three are per
book.

**A pool never holds two currencies**, so a parimutuel payout never has to ask
what currency it is in. That is what makes the payout rule well-defined: you
split the money of the people you are pooled with, and you are pooled with
people in your own currency.

Four consequences, stated so nobody rediscovers them as bugs:

- **Odds differ between books.** Same outcome, different return, because each
  book has its own distribution.
- **The platform cut is per book.** BTN and USDT can carry different rates.
- **Refunds are per book.** The BTN book can pay out while the USDT book
  refunds for a thin pool. Same event, different outcome for the two cohorts.
- **Settlement runs once per book**, against one resolved outcome.

**Everyone sees every market.** There is no currency filter on the market list.
Segregation lives in the book, the stake check, and the ledger — not in
visibility. A user's currency decides which book they can stake into, not which
markets they can see.

## 5. Precision

Today the money path runs at two precisions:

| Table | Money columns | Precision |
|---|---|---|
| `transactions` | `amount`, `balanceBefore`, `balanceAfter`, `stakeAmount` | `numeric(20,9)` |
| `payments` | `amount` | `numeric(18,2)` |
| `markets` | `liquidityParam`, `disputeBondPool`, `disputeBondAmount` | `numeric(18,2)` |
| `market_books` | `totalPool`, `minStake` | new, `numeric(28,9)` |
| `outcome_books` | `totalBetAmount` | new, `numeric(28,9)` |
| `positions` | `amount`, `payout` | `numeric(18,2)` |
| `settlements` | `totalPool`, `houseAmount`, `payoutPool`, `totalPaidOut` | `numeric(18,2)` |
| `revenue_distributions` | `amount`, `totalPool` | `numeric(18,2)` |
| `challenges` | `wagerAmount` | `numeric(18,2)` |
| `disputes` | `bondAmount`, `rewardAmount` | `numeric(18,2)` |
| `users` | `bonusBalance`, `bonusRealPayoutRemaining` | `numeric(18,2)` |

USDT is 6dp. `numeric(20,9)` already holds it; `numeric(18,2)` silently
truncates. **Every money column on the market path widens to `numeric(28,9)`** —
scale 9 to match the ledger, precision 28 to leave headroom.

Widening a `numeric` in Postgres is a catalogue change, not a table rewrite, so
this is fast even on live tables. Verify with a `SUM()` per column before and
after regardless; the cost is one query and it is the only proof that nothing
moved.

One precision across the whole money path, no conversion boundary between
ledger and market, and it never needs revisiting.

## 6. Rounding and the payout residual

Oro's settlement path is not the source plan's, and the dust problem is
differently shaped.

[`parimutuel.engine.ts:1302-1340`](../../src/markets/parimutuel.engine.ts#L1302-L1340)
computes each winner's payout with `toFixed(2)` — round-half-up, independently
per winner. As in the source plan, independently-rounded shares do not sum to
the pool.

**But Oro does not overpay from this.** House revenue is computed as a residual
(`totalPool - totalPaidOut`, [engine:1512](../../src/markets/parimutuel.engine.ts#L1512)),
so rounding drift is absorbed by the house edge rather than minted. There is
also a payout-floor guard: winners are guaranteed `max(share, 1.05 × stake)`,
funded by giving up house edge and, in the extreme, by scaling every payout
pro-rata.

That machinery is sound and this plan does not rewrite it. Two changes only:

- **Round at the money path's precision, not at 2dp**, once the columns widen.
  A USDT payout truncated to 2dp loses four decimal places of a user's money.
- **Assert the invariant** `totalPaidOut + houseAmount + residual == totalPool`
  exactly, per settlement, per currency, in Stage I reconciliation. Equality,
  not tolerance. A tolerance hides the class of bug the check exists to find.

## 7. Promotional money is unresolved

`bonusBalance`, `bonusRealPayoutRemaining`, the Nu 50 withdrawable cap,
`FREE_CREDIT`, `STREAK_BONUS`, `REFERRAL_BONUS`, `REFERRAL_PRIZE`,
`SEASON_PRIZE` — all promotional, all BTN, all writing to the same ledger.

The source plan has nothing to say here because LuckyPemX has no bonus system.
Master-plan decision 1 owns it, and [Stage B′](./STAGE-B-PRIME-PROMO-CURRENCY.md)
implements whatever it decides.

Note that `users.bonusBalance` and `users.bonusRealPayoutRemaining` are scalar
columns with no currency, so if USDT accounts ever receive promotional money,
those columns need the same treatment the ledger got — or promotional money
must be BTN-only by construction, which is the recommendation.

## 8. Reporting

Per-currency, never combined.

The existing BTN reports in `reporting/`, `reconciliation/`, and the admin
dashboard stay scoped to `currency = 'BTN'` and **their numbers must not move.**
USDT sections are new and additive.

**Do not sum across currencies in any report.** There is no exchange rate in
this system, so a combined total is not merely inaccurate — it is undefined.
Where a business view needs both, show two columns.

## 9. Reconciliation

| Check | Assertion |
|---|---|
| Custody parity | Sum of the USDT book equals 21Pay's custody balance for our tenant |
| Deposit parity | Every 21Pay `confirmed` intent has one credited local intent, amounts equal |
| Payout parity | Every local payout has a matching 21Pay payout, amounts and status equal |
| Account/ledger agreement | Zero transactions whose `currency` differs from their user's `users.currency` |
| Cross-currency isolation | Zero positions whose currency differs from their owner's `users.currency` |
| Book integrity | For every book, `sum(positions.amount)` in that book equals `market_books.totalPool` |
| Settlement identity | `totalPaidOut + houseAmount + residual == market_books.totalPool`, per book |

The last three are the segregation invariants. If any is ever non-zero,
something has crossed the boundary and everything downstream is suspect.

## 10. What this model does not do

Stated so nobody rediscovers them as bugs:

- A user cannot convert between currencies. No feature, no endpoint, no admin
  override.
- A user cannot move funds between their own BTN and USDT accounts if they hold
  both.
- A BTN user cannot stake into a USDT book, or the reverse.
- Reports cannot show a combined total across currencies. Two books on one
  market card are two numbers, never one.
- The TMA never shows USDT.

If any of these becomes a product requirement, it is a currency-exchange
feature with its own licensing question, and it is a new product rather than an
extension of this one.
</content>
