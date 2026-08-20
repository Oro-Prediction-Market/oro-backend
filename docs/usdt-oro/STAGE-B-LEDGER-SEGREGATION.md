# Stage B: Ledger Segregation and Per-Currency Books

**Touches BTN:** **Yes.** Every balance in the system is computed differently
after this stage, and the market money path is restructured.
**User-visible:** No.
**Depends on:** Stage 0.

## Goal

Two things, both structural:

1. **Currency on the ledger**, so a balance means "spendable in one currency"
   rather than "sum of everything".
2. **Books on the market**, so one market can hold a BTN pool and a USDT pool
   that never mix.

Nothing opens a USDT book yet.

**This is the riskiest stage in the plan.** Start it immediately after Stage 0,
gate it hard, and do not bundle it with anything else. The ledger half (B.2)
and the books half (B.4) are separable and should be separate commits.

## B.1 One market, two books

A market is one event with one resolution. What splits by currency is the
**pool underneath it.**

```
Market: "Will Bhutan beat Nepal?"     ← one row, one resolution, one card
  ├── BTN book    Nu 20,000    edge 10%   ← Bhutanese stakes, pays in Nu
  └── USDT book   $420         edge 8%    ← foreign stakes, pays in USDT
```

Both figures appear on the market card, side by side, **never summed**. There
is no exchange rate anywhere in this system, so `Nu 20,000 + $420` is not a
quantity. Two numbers, two units, each one the real payout basis for its own
book.

That the card shows both is what makes a single market work as a product: one
event, one page, one comment thread, one admin resolution — and a user can see
the market is busy even though they can only stake into their own book.

Consequences that follow, each stated so nobody rediscovers it as a bug:

- **Odds differ between books.** Parimutuel odds come from how a pool is
  distributed. If Bhutanese back Bhutan and foreigners back Nepal, the same
  outcome pays differently in each book. That is correct — you are splitting
  the money of the people you are pooled with.
- **The platform cut is per book.** `houseEdgePct` moves onto the book, so BTN
  and USDT can carry different rates.
- **Refunds are per book.** Oro refunds when a pool is too thin or the 1.05×
  payout floor cannot be funded. Evaluated per book, so the BTN book can pay
  out normally while the USDT book refunds. Same event, different outcome for
  the two cohorts. Deliberate, and it needs clear copy.
- **Settlement runs once per book**, against one resolved outcome.

## B.2 Ledger currency: the 48 sums

Balance is derived, so every place that derives it is a place segregation can
leak. Thirty-four ledger sums across fourteen files. **Work the list; do not
sample it.**

| File | Lines | What it computes | Scope to |
|---|---|---|---|
| `markets/parimutuel.engine.ts` | 96, 511, 845, 1252, 1554, 1929 | balances at stake, dispute, and settlement time | book currency |
| `markets/markets.service.ts` | 902 | balance | book currency |
| `payment/dkbank-payment.service.ts` | 684, 776, 1027, 1166 | balance for deposit/withdrawal | **`'BTN'` literal** |
| `auth/auth.service.ts` | 1580, 1585, 1844, 1852 | balance at login / account merge | account currency |
| `challenges/challenges.service.ts` | 49, 81 | balance before a wager | account currency |
| `users/users.controller.ts` | 417, 650 | credits balance, referral total | account currency |
| `users/streak.service.ts` | 214 | balance | account currency |
| `users/season.service.ts` | 301 | balance | account currency |
| `jobs/engagement.job.ts` | 247 | balance | account currency |
| `admin/admin.controller.ts` | 1556 | per-user balance in the user list | account currency |
| | 307, 310, 346, 347, 348 | **raw SQL, `SUM(CASE WHEN ...)`** — bonus, referral, streak, season totals | per-currency |
| | 1639, 1646, 1654 | platform totals | per-currency, two columns |
| | 1701, 1753, 1763, 1785, 1798, 1817, 1843 | **raw SQL** platform and bonus totals | per-currency |
| `aml/aml-detector.service.ts` | 51, 59, 110, 114, 120, 194, 198 | **raw SQL**, withdrawal / deposit / stake totals | per-currency |
| `reporting/reporting.service.ts` | 69 | `SUM(amount)` grouped by type | **group by currency too** |
| `reconciliation/reconciliation.service.ts` | 312 | balance | per-currency |
| `reconcile-duplicate-payouts.ts` | 140 | balance | per-currency |

**Half of these are raw SQL**, not query-builder calls — 20 of the 48 sit
inside `dataSource.query()` template literals in `admin.controller.ts` and
`aml-detector.service.ts`. They cannot be fixed by changing a helper signature;
each needs its `WHERE` clause edited by hand. Budget accordingly.

Three treatments, and choosing the wrong one is how this stage fails:

- **`'BTN'` literal.** DK Bank is a BTN rail by definition. The literal is
  self-documenting — it says "this is the ngultrum book", not "we forgot".
- **Account currency**, from `users.currency`. Never from a request parameter.
- **Per-currency.** Reports return a row or column per currency and **never a
  combined total.**

`reconciliation.service.ts:478` sums `reconciliations.difference`, not the
ledger. Leave it.

### Extract a helper

Thirty-four hand-written variants of one query is how the problem arose:

```ts
export async function ledgerBalance(
  em: EntityManager,
  userId: string,
  currency: string,
): Promise<number>
```

with a bulk variant for the settlement path, which loads balances for up to
1,000 users at a time and must not regress to per-user queries.

A **required** `currency` parameter with no default means a future call site
cannot omit it.

## B.3 The static guard

Behavioural tests prove the 48 known sites are fixed. They prove nothing about
the 35th, written in six months by someone who has never read this document.

`__tests__/ledger-currency-guard.spec.ts`, landed **failing** in Stage 0, covers
that: a source scan that fails on any `SUM(amount)` over the ledger without a
currency filter.

**The ledger half of Stage B is done when that test goes green**, and it stays
green for the life of the codebase. A new entry in its skip-list is a design
change requiring a comment, not a test fix.

## B.4 Books: schema

Currency does **not** go on `markets`. It goes on the pool.

### New: `market_books`

```
id            uuid, pk
marketId      uuid, FK markets.id
currency      varchar(3)
totalPool     numeric(28,9)  default 0
houseEdgePct  numeric(5,2)
minStake      numeric(28,9)
status        enum   (matches or narrows the market's own lifecycle)
isEnabled     boolean         admin can open a market without a USDT book
createdAt / updatedAt
```

Unique on `(marketId, currency)`.

### New: `outcome_books`

```
id              uuid, pk
outcomeId       uuid, FK outcomes.id
currency        varchar(3)
totalBetAmount  numeric(28,9)  default 0
currentOdds     numeric(10,4)  default 0
lmsrProbability numeric(10,6)  default 0
```

Unique on `(outcomeId, currency)`.

Odds and LMSR probability are both derived from how stake is distributed across
outcomes, so both are per book. `markets.liquidityParam` (the LMSR `b`) stays
on the market unless a per-book value is wanted — flag if so.

### Changed

| Table | Change |
|---|---|
| `positions` | add `currency` — which book this stake is in |
| `settlements` | add `currency`; **one row per `(marketId, currency)`** |
| `revenue_distributions` | add `currency` |
| `challenges`, `disputes` | add `currency` |
| all of the above | money columns widen to `numeric(28,9)` |

### Migrated off `markets` / `outcomes`

`markets.totalPool`, `markets.houseEdgePct`, `outcomes.totalBetAmount`,
`outcomes.currentOdds`, `outcomes.lmsrProbability` move into the book tables.

**Backfill: one BTN book per existing market and outcome**, carrying the
current values across verbatim. Every existing market becomes a
single-BTN-book market and behaves exactly as it does today.

Do not drop the old columns in the same migration. Leave them in place,
unread, for one release, so a rollback does not need a data restore. Drop them
in a follow-up once the books path has run in production.

Precision widening is a catalogue change in Postgres, not a table rewrite. The
book tables are new. **The risk in this migration is the backfill, not the
DDL** — verify with a `SUM()` per column and a row-count match before and after.

**Declare every index on the entity as well as in the migration.**
`DB_SYNCHRONIZE` drops what it does not know about.

## B.5 Books: the money path

### Staking

[`parimutuel.engine.ts:114`](../../src/markets/parimutuel.engine.ts#L114)
`placePosition` resolves the book from the user's currency, then:

- rejects if that book does not exist or is not enabled
- checks affordability against **that currency's** ledger balance
- validates against the book's `minStake`
- increments `market_books.totalPool` and `outcome_books.totalBetAmount`, never
  the market or outcome totals
- recomputes odds and LMSR probabilities **within that book only**

A stake never touches the other book's numbers. That is the boundary, and it is
enforced here rather than in the query layer — there is no query layer filter
any more, because everyone sees every market.

### Settlement

The market resolves **once**: one outcome, one resolution record, one admin
action. Then settlement iterates the books.

For each book, run the existing algorithm unchanged against that book's pool:

1. Thin-pool and payout-floor checks → refund **this book only**
2. `payoutPool = totalPool × (1 − book.houseEdgePct / 100)`
3. Winner shares, the 1.05× floor, the pro-rata scale-down if the floor cannot
   be funded even at zero edge
4. Ledger credits in **that book's currency**
5. One `settlements` row and one `revenue_distributions` row per book

The per-book algorithm is the code that exists today at
[engine:1191-1340](../../src/markets/parimutuel.engine.ts#L1191-L1340). **Do not
rewrite it.** Extract it into a function taking a book and call it once per
book. The refactor is the risk here; the arithmetic is already right.

Two changes inside it:

- **Round at the money path's precision, not `toFixed(2)`.** Every `toFixed(2)`
  in the settlement path discards four decimal places of a USDT user's money.
  There are roughly a dozen; find them all, not the obvious ones.
- **Assert the identity per book:**
  `totalPaidOut + houseAmount + residual == book.totalPool`, exactly. Equality,
  not tolerance.

### Refunds diverge

A book that refunds while its sibling pays out is a supported outcome, not an
error state. It needs:

- a per-book status, so the market can be `SETTLED` with one book `REFUNDED`
- copy that explains it without implying the market was cancelled
- a reconciliation check that a refunded book paid back exactly what it took

## B.6 Market visibility

**Everyone sees every market.** There is no currency filter on the market list
and no currency in the cache key, because a market is no longer owned by a
currency.

This deletes two hazards from the earlier draft: the server-side market filter,
and the global Redis cache key at
[`markets.service.ts:346`](../../src/markets/markets.service.ts#L346) that would
have defeated it. The market list is currency-agnostic and cacheable exactly as
it is today.

What the client renders per viewer is which book they can stake into. The card
shows both totals to everyone.

## B.7 Admin

- Market creation opens a BTN book by default; a USDT book is an explicit
  toggle, so a market can exist BTN-only.
- Per-book `houseEdgePct` and `minStake`, defaulting to the current constants
  for BTN.
- A book cannot be disabled once it has positions.
- A book's currency is immutable.

## Verification

- Migration applies and reverts. `SUM()` per widened column and row counts
  identical before and after; every existing market has exactly one BTN book
  carrying its former values.
- **`ledger-currency-guard.spec.ts` green.**
- Unit: `ledgerBalance` returns only the requested currency's rows, on a fixture
  where one user has both.
- Unit: staking into a book the user's currency does not match is rejected
  before any write.
- Unit: staking into the USDT book leaves every BTN book figure untouched —
  pool, outcome totals, and odds asserted before and after.
- Unit: odds computed per book differ correctly given different distributions.
- Unit: the settlement identity holds exactly, per book, across several winner
  counts and pool sizes.
- Unit: no settlement value is rounded to 2dp in a USDT book.
- Unit: a market where the USDT book refunds and the BTN book pays out
  completes, with both outcomes correct and the market marked settled.
- Unit: per-book `houseEdgePct` is applied to its own book only.
- Integration: full BTN book lifecycle — stake, settle, payout —
  byte-identical to pre-migration on a market with only a BTN book.
- **BTN regression gate, run twice.** Once after the migration with no USDT
  books, and again after a market has both books with positions and
  settlements. The second run is what proves the split works; the first only
  proves the DDL was harmless.

Review this stage line by line. It is a mechanical change across live money
code, and the type checker cannot tell a correct currency from a plausible one.

## Rollback

The ledger half is additive and reverts cleanly.

The books half does not. Once a USDT book has positions, `down()` cannot
reconstruct the pre-migration `markets.totalPool` without losing the USDT side.
Rollback is safe only while no USDT book has been opened — which is the whole
window between this stage and Stage I, and is why the old columns stay in place
for a release.

Run the migration in a maintenance window with a verified backup. Production
migrations are hand-applied here, so the SQL and the `migrations` row insert
should be written out and reviewed before the window opens, not during it.
