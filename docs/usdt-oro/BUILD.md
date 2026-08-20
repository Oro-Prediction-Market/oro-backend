# Build Sheet: USDT on Oro

> Execution order for the plan in this folder. Every item is a commit.
> Read [`README.md`](./README.md) for the shape and
> [`SEGREGATION-MODEL.md`](./SEGREGATION-MODEL.md) for the money model before
> starting. This file is the *how* and the *in what order*, not the *why*.

## Ground rules

Apply to every commit below without restating them.

- **Nothing is reachable while `USDT_ENABLED=false`.** That is the kill switch
  for everything up to Stage I.
- **Every new index is declared on the entity as well as in the migration.**
  `DB_SYNCHRONIZE` is honoured at boot and drops what it does not know about.
- **Production migrations are hand-applied.** Each one needs its SQL and a
  `migrations` row insert written out and reviewed before it runs.
- **`npm run typecheck` and `npm test` before every commit.** Known baseline on
  `main` at the time of writing: **2 failing suites / 659 passing of 661**, plus
  one pre-existing `tsc` error in `bank-link.service.spec.ts` (a 6-vs-7
  constructor-argument mismatch). Hold that line; do not add to it.
- **Migration numbering starts at `1775990000330`.** Current maximum on `main`
  is `1775990000320`.
- **BTN regression gate** on any commit touching shared money code: balance
  sheet, revenue reporting, and reconciliation return byte-identical BTN
  numbers before and after.

## Critical path

```
C1 ── C2 ── C3 ── C4 ── C5 ──┐
(salvage)  (ledger currency)  │
                              ├── C9 ── C10 ── C11 ── C12 ── C13 ── C14 ── C15
C6 ── C7 ──────────────────── ┤
(gateway, books)              │
                              │
C8 ───────────────────────────┘
(email + KYC, fully parallel)
```

C1–C5 are the critical path and cannot be parallelised. C6–C7 and C8 can run
alongside from day one.

---

# Phase 1 — Salvage and ledger currency

## C1. Restore the salvaged 21Pay code ✅ DONE

**Source:** commit `93ee897` on branch `safety/pre-uncommit`.

```
src/payment/services/twentyone-pay/twentyone-pay.client.ts   (234 lines)
src/payment/usdt.util.ts                                     (77 lines)
src/__tests__/usdt.util.spec.ts                              (175 lines)
```

There is **no** `twentyone-pay.client.spec.ts`, contrary to
`USDT_PAYMENT_INTEGRATION.md`. The 8 webhook-HMAC tests live inside
`usdt.util.spec.ts`. One case was missing and has been added: a
parsed-and-re-serialised body must fail verification — the test that proves the
Stage D route receives real raw bytes rather than a middleware round trip.

Do **not** take `usdt-payment.service.ts`, `docs/TON_WALLET_INTEGRATION.md`,
either migration, the `main.ts` change, or the `yarn.lock` rewrite. Reasons in
[`STAGE-0-SALVAGE.md`](./STAGE-0-SALVAGE.md#05-discard).

`TwentyOnePayClient` registered and exported in `PaymentModule`. Nothing calls
it yet.

**Result:** 2 failed / 676 passed of 678. Baseline held, +17 tests.

### Contract discrepancies found at C1 — now settled

Resolved against the 21Pay **engine source**, not staging behaviour or their
published docs. Full findings in [`21PAY-ANSWERS.md`](./21PAY-ANSWERS.md).

**The salvaged client was right on all three, and 21Pay's own docs were wrong.**

| | Client had | Docs said | Truth |
|---|---|---|---|
| Webhook headers | `x-t1pay-*` | `X-21Tech-*` | `X-T1Pay-*` — the documented names do not exist |
| Auth | Bearer everywhere | `X-Tenant-Id` on intents | Bearer everywhere; tenant resolves off the token and `X-Tenant-Id` is ignored |
| Statuses | 7 | 9 | 9 — the client was short `confirming` and `completed_via_topup` |

Applied in C6b below. Reverting to the "spec" would have broken a working
integration, which is the argument for having asked rather than assumed.

## C2. The static ledger guard, landed failing ✅ DONE

`src/__tests__/ledger-currency-guard.spec.ts`, taken from `93ee897` and
hardened. Three of the four changes were found by checking the guard's own
output against the source rather than trusting it:

- `SKIP_FILES` is now a `Map` of filename → justification. Only
  `transaction.entity.ts` remains; `usdt-payment.service.ts` is gone.
- **`READS_LEDGER` matches `JOIN transactions`, not just `FROM`.**
  `aml-detector.service.ts` reaches the ledger through a join inside a CTE, and
  the original pattern skipped it entirely.
- **Two SUM patterns, not one.** `SUM_DIRECT` covers plain, aliased, `ABS(...)`
  and `::numeric` cast forms; `SUM_CONDITIONAL` covers
  `SUM(CASE WHEN ... THEN amount END)`, which carries the promotional-credit
  totals on the admin dashboard. A single "clever" regex was tried and silently
  stopped matching `SUM(ABS(amount::numeric))` — nested parens get consumed as a
  unit. Two readable patterns beat one wrong one.
- **`SCOPES_CURRENCY` requires a predicate**, not the word appearing nearby, so
  a comment mentioning currency cannot satisfy the guard.

Plus a `guard self-check` describe block: every SUM shape in the codebase
matches, sums over other columns do not, a scoped query is recognised as
scoped, and a passing comment is not. Without that last group the suite could
only ever prove "still broken", never "genuinely fixed".

**Result: 48 offenders across 14 files** — not the 34 a manual grep found. The
20 raw-SQL sites in `admin.controller.ts` and `aml-detector.service.ts` were
the miss. Self-checks pass; the guard is red by design.

Full suite: 3 failed / 680 passed of 683 — the third failure is this guard.

**Before C4:** wire this into CI as a required check so it cannot be skipped
once green.

## C3. Migration — ledger and account currency ✅ DONE

`src/migrations/1775990000330-AddLedgerCurrency.ts`, plus the matching entity
columns. Adds `transactions.currency` and `users.currency`, both backfilled
`'BTN'` and `NOT NULL`, the `(userId, currency)` index, and `usdt` on the
`payments.method` enum.

Entity side: `Transaction.currency` with the class-level
`@Index("IDX_transactions_user_currency", ["userId", "currency"])` and an
exported `BTN_CURRENCY`; `User.currency` documented as write-once, with the
absence of an update path called out as the segregation guarantee.

**Verified against a real Postgres 16**, not by inspection:

| Check | Result |
|---|---|
| Full migration chain from empty | all 30 apply, `AddLedgerCurrency` last |
| `transactions.currency` | `varchar NOT NULL DEFAULT 'BTN'` |
| `users.currency` | `varchar NOT NULL DEFAULT 'BTN'` |
| Index | `btree ("userId", currency)` present |
| `payments_method_enum` | `dkbank, ton, credits, usdt` |
| `SUM(amount)` before → revert → re-run | `1250.000000000` unchanged at every step |
| Backfill with data present | 3 tx rows and 1 user, all `'BTN'` |
| Revert | drops both columns and the index cleanly, leaves `SUM` intact |
| Synchronize drop-check | 0 of 220 queries touch the index — the entity declaration holds |

**Guard wired into CI:** `.github/workflows/ci.yaml`, job
`ledger-currency-guard`, `ubuntu-latest`, on PR and push to `main`. Expected
red until C4 and documented as such in the workflow.

### Two adjacent gaps, flagged once

Neither is part of this plan; both were surfaced by testing it.

1. **`DB_SYNCHRONIZE=true` is destructive on this schema.** Against a properly
   migrated database, synchronize wants to run 220 queries and **drop 55
   existing indexes** — migration-created indexes that no entity declares. It
   also aborts partway on a `markets_category_enum_old` dependency, so it
   cannot complete. The flag should be treated as unusable outside a scratch
   database.
2. **There was no test CI before this commit**, and `main` carries 2 failing
   specs plus one `tsc` error (`bank-link.service.spec.ts`, a 6-vs-7
   constructor-argument mismatch). A `typecheck` job was deliberately left out
   of `ci.yaml` because it would be red on arrival for an unrelated reason.

## C4. Thread currency through all 48 ledger sums ✅ DONE

`src/shared/utils/ledger.util.ts` is the single place a balance is derived:

```ts
ledgerBalance(src, userId, currency)        // currency named by the caller
ledgerBalanceForAccount(src, userId)        // the account's own currency
ledgerBalancesForAccounts(src, userIds)     // bulk, one query, for settlement
accountCurrency(src, userId)
assertSameCurrency(src, fromUserId, toUserId)
```

No function has a default currency. All 48 sites now route through these or
carry an explicit predicate.

| Treatment | Sites | Why |
|---|---|---|
| `BTN_CURRENCY` literal | `dkbank-payment.service.ts` ×4 | DK Bank is a ngultrum rail. A USDT account gets 0 and is refused — following the account instead would pay out its USDT balance as Nu |
| Account currency | engine ×6, `markets.service`, `challenges` ×2, `users.controller` ×2, `streak`, `season`, `engagement.job`, `auth` ×4, `admin:1559`, `reconciliation` | "What can this user spend" |
| `'BTN'` in raw SQL | `admin.controller` ×15, `aml-detector` ×7 | Platform balance sheet and AML thresholds are ngultrum figures. Numbers must not move; USDT reporting is additive in Stage I |
| `GROUP BY currency` | `reporting.service:69` | A stats view, not a balance sheet — a row per currency is more correct than a BTN-only total |
| Currency of the reversed row | `reconcile-duplicate-payouts` | A reversal belongs to the same book as the row it reverses |

### Two things that were more than mechanical scoping

**Cross-currency account merges now throw.** `auth.service` has two paths that
move a balance between accounts — the BhutanApp merge and
`transferOrphanBalance`. Scoping the reads alone would have been worse than
leaving them: the debit leaves one ledger correctly and the credit lands
denominated in the sender's currency, which the receiving account never sums.
The money would not move, it would disappear. `assertSameCurrency` refuses the
operation instead.

**Admin manual credit sets currency on the write.** It read the account balance
and then wrote a row that defaulted to BTN. For a USDT account the credit would
land where that account's own balance query never looks.

### Note for C9: writes still default

C4 covers reads. Rows created outside the two paths above still take the entity
default of `'BTN'`. Correct today — every account is BTN — but each write on
the market money path needs its book's currency in C9, and the guard does not
cover writes.

### Result

Guard **green**, 6/6 self-checks. Full suite **2 failed / 682 passed of 684**,
which is the pre-existing baseline: `bank-link.service.spec.ts` fails to run on
a constructor-argument mismatch, and two `parimutuel.engine.edge-cases`
payout-floor tests fail. Both verified against stashed working tree —
`parimutuel.engine.edge-cases` fails identically at 2/17 without any of this
work. Typecheck unchanged.

Helper behaviour verified against a real Postgres, with a BTN account holding a
stray USDT row:

| | |
|---|---|
| unscoped `SUM` (the bug) | `10599` |
| `ledgerBalanceForAccount` (BTN account) | `600` |
| `ledgerBalance(account, 'USDT')` | `9999` |
| `ledgerBalance(USDT account, 'BTN')` | `0` |
| bulk, mixed accounts | `600` / `50`, absent ids omitted |

### Guard change

`GROUP BY currency` now counts as scoping. It is stronger than a predicate — a
group can never merge two currencies into one total — and `reporting.service`
uses it. Self-check added.

### Why the helpers use a subquery rather than a join

The first implementation joined `users`. That broke 48 tests across 11 suites,
because the hand-rolled repository mocks in this codebase stub only
`select` / `where` / `getRawOne`. Widening 20 mocks to accommodate a refactor of
live money code is the wrong trade — it makes the tests assert the shape of the
implementation rather than its behaviour. The subquery form uses only the
builder methods the original queries already used, so the existing tests keep
testing what they were written to test. Both forms were verified to produce
identical results against a real database.

The helpers accept an `EntityManager`, a `DataSource`, or a
`Repository<Transaction>` for the same reason: reaching through `.manager`
works in production and is undefined on the mocks.

## C5. Checkpoint — ledger segregation complete ✅ DONE

- [x] Guard green and wired into CI (`.github/workflows/ci.yaml`)
- [x] Test baseline unchanged
- [x] **BTN numbers unmoved — verified by execution, not by argument**
- [ ] Migration applied to staging by hand — ops, not done here

On all-BTN data a `currency = 'BTN'` predicate is a tautology, so the logical
risk was never that results would change. The real risk in 22 hand-edited raw
SQL statements is a syntax error or a predicate attached to the wrong subquery
or alias. So every modified raw query was executed against a seeded Postgres
both as written and with the currency predicates mechanically stripped, and the
result sets compared:

```
raw SQL (admin + aml): 11 modified queries executed, 0 mismatched, 16 skipped
AML runScan executed OK, alerts: 1
```

`AmlDetectorService` was instantiated and `runScan` called for real, exercising
all four detectors end to end. The 16 skipped are queries C4 did not touch or
that interpolate values.

### Pre-existing bug found while seeding

**`season_prize` is missing from the `transactions_type_enum` in the database.**
`TransactionType.SEASON_PRIZE` exists in TypeScript and
[`season.service.ts`](../../src/users/season.service.ts) writes rows with it,
but no migration ever added the value — a fresh database built from migrations
rejects the insert. Either production had it added by hand, or season prizes
have never successfully written. Worth checking against prod directly. Not part
of this plan, and not fixed here.

---

# Phase 2 — Gateway, books, onboarding (parallel)

## C6. Gateway: config, networks, EVM addresses ✅ DONE (partially blocked)

**`src/payment/services/twentyone-pay/twentyone-pay.types.ts`** — `CryptoNetwork`
(tron, base, polygon, arbitrum; lowercase to match the wire, no `ETHEREUM`
member), `EVM_NETWORKS`, and `parseEnabledNetworks`, which **throws at boot** on
an unrecognised value rather than skipping it.

**`usdt.util.ts`** — `isValidEvmAddress` with real EIP-55 checksum verification
when the input is mixed-case, and `isValidAddressForNetwork` dispatching to it
or to the existing Tron base58check validator.

**Client** — the `TWENTYONE_PAY_NETWORK` default is gone. `createPaymentIntent`
and `createPayout` now require an explicit `network`, checked against the
enabled set. Added `enabledNetworks`, `isNetworkEnabled`, `intentTtlMinutes`.

**`.env.example`** — `TWENTYONE_PAY_NETWORKS=tron,base,polygon,arbitrum`,
new `TWENTYONE_PAY_INTENT_TTL_MINUTES`, `TWENTYONE_PAY_NETWORK` removed, and
`USDT_ALLOW_CID_USERS` removed with a comment explaining that segregation gates
by currency structurally, and that whether residents may hold a USDT account is
a signup question rather than a rail flag.

### New dependency: `@noble/hashes@1.8.0`

EIP-55 needs keccak256, and Node has no keccak — its built-in `sha3-256` is
NIST SHA3, which differs in padding. `@noble/hashes` was already in the tree as
a transitive dependency of `otplib` and `pdfkit`; yarn deduped the direct
reference against the existing `^1.6.0` resolution, so nothing new is
downloaded. Verified against the known `keccak256("")` vector before use.

**Use `yarn`, not `npm`, in this repo.** `package-lock.json` is untracked;
`yarn.lock` is the tracked lockfile. An `npm install` here rewrote `yarn.lock`
by 2,495 lines — the same churn that rode along in `93ee897`. Reverted and
redone with `yarn add`, which touched 134 lines.

### Still blocked

The three contract discrepancies from C1 are unresolved and now documented at
the top of the client. **They block C10, not C6.** Getting the auth scheme wrong
means a payout authenticates as the wrong principal.

### Result

Full suite **2 failed / 692 passed of 694** — the same two pre-existing
failures, +10 tests. `usdt.util.spec.ts` is now 27 tests, including the
canonical EIP-55 vectors and a case-flip test that proves the checksum is
computed rather than stubbed: the corrupted address is still 40 valid hex
characters, so nothing but the checksum can reject it.

## C7. Books: schema and backfill ✅ DONE

`src/migrations/1775990000340-AddMarketBooks.ts` plus two new entities
(`MarketBook`, `OutcomeBook`), `currency` on the five money-path entities, and
precision widened to `numeric(28,9)`.

`market_books` is keyed `(marketId, currency)` and carries `totalPool`,
`houseEdgePct`, `minStake`, `status` and `isEnabled` — the per-book cut and the
per-book lifecycle that let one book refund while its sibling pays out.
`outcome_books` is keyed `(outcomeId, currency)` and carries stake, odds and
LMSR probability, all three being functions of stake distribution within a book.

`markets.totalPool`, `markets.houseEdgePct` and the three `outcomes` columns are
**not** dropped. They stay unread for one release so a rollback needs no data
restore.

### Verified against Postgres 16 with pre-existing data

Seeded a database from the full migration chain with three markets — a regular
one, a TER market on an 8% edge, and an empty BTC market — then applied C7:

| Check | Result |
|---|---|
| Market / outcome parity | 3 → 3 books, 4 → 4 books |
| `totalPool` sum | `12845.67` carried across exactly |
| `totalBetAmount` sum | `12845.67` carried across exactly |
| Edge preserved | 0 mismatches — TER kept 8%, not flattened to the 10% default |
| `minStake` | TER and BTC → 10, regular → 50, per the engine rule |
| Currency columns | 5 of 5 |
| Widened columns | 11 of 11 present |
| Re-running the backfill | inserts 0 rows — `ON CONFLICT` holds |
| FK cascade | deleting a market removes its book and its outcome books |
| Revert | tables, columns and indexes dropped, money narrowed back, source data intact |
| Synchronize drop-check | **0 of 7** C7 objects at risk |

### Two defects the verification caught

**`disputes.rewardAmount` does not exist in a migration-built database.** It is
declared on the entity but no migration ever created it, so the first run of
this migration aborted on it. `1775990000360-AddDisputeRewardAmount` creates the
column at `numeric(28,9)` when it is missing, and widening here is now
conditional on the column actually existing — an unconditional `ALTER` succeeds in an environment that
has seen `DB_SYNCHRONIZE` and kills the migration in one that has not. Given
this codebase has now produced two such drifts, defensive is right.

**Two indexes would have been dropped by synchronize.** `IDX_positions_currency`
and `IDX_settlements_market_currency` were created in the migration but not
declared on `Position` and `Settlement`. The dry-run drop-check caught it; both
are declared now.

### Staging

[`sql/STAGING-RUNBOOK.md`](./sql/STAGING-RUNBOOK.md) — before/after invariant
queries, the known drift to expect, rollback, and the `migrations` row inserts
for a hand-applied run. Staging before production, both migrations, in file
order.

### Result

Full suite **2 failed / 692 passed of 694** — unchanged baseline. Guard green.

### Still open for C9

Decisions 2a and 2b do not block the schema but do bind its defaults: which
markets get a USDT book (`isEnabled`), and the launch `houseEdgePct` per book.
Every backfilled book is `isEnabled = true` with the market's existing edge,
which is correct for BTN and says nothing yet about USDT.

## C8a. Email auth and KYC — schema ✅ DONE

Split from the rest of C8: schema and entities land first, the service and
review-queue work follows as C8b and C8c. The auth path serves 1,300 live users,
so the additive half is worth landing and verifying on its own.

`src/migrations/1775990000350-AddEmailAuthAndKyc.ts`:

- `AuthProvider.EMAIL` added to `auth_methods_provider_enum`
- `users.kycStatus` (`none | pending | approved | rejected`, default `none`)
- `users.emailVerifiedAt`
- `user_kyc_documents` with its own type and status enums, FK cascade on user,
  and a `(status, submittedAt)` index for the oldest-pending-first queue

Entities: `UserKycDocument`, `KycStatus`, `AuthProvider.EMAIL`, and the two new
`User` columns.

**No new unique constraint was needed for one-account-per-email.**
`auth_methods` is already unique on `(provider, providerId)`, so storing the
normalised address as `providerId` gives it for free.

### Verified against Postgres 16

| Check | Result |
|---|---|
| Existing user after migration | `kycStatus = none`, `emailVerifiedAt = null` — untouched |
| Provider enum | `telegram, dkbank, bhutanapp, email` |
| Duplicate email under `email` | rejected by `IDX_auth_methods_provider_providerId` |
| Same address under a different provider | allowed — a separate identity, correctly |
| FK cascade | deleting the user removes their documents |
| Revert | table, columns, enums and indexes dropped; existing user intact |
| Re-apply after revert | clean |
| Synchronize drop-check | **0 of 9** objects across C3/C7/C8 at risk |

### Two defects the verification caught

**`kycStatus` was never actually added to the entity.** The edit that was meant
to add it silently failed to match, and the assertion guarding it was too weak
to notice — it passed on a different change in the same script. The synchronize
drop-check surfaced it as an index referencing a column TypeORM could not find.

**Regex edits had stripped doc comments throughout `user.entity.ts`** — around
ten `/** */` blocks across the bonus, referral and admin fields. Reverted the
file and re-applied the three new columns cleanly; the diff is now 50
insertions and 0 deletions. Every other entity's diff was checked and contains
only the intended `precision: 18,2 → 28,9` swaps.

Both were found by verification rather than review, which is the argument for
running these checks on every schema commit rather than the risky-looking ones.

### Result

Full suite **2 failed / 692 passed of 694** — unchanged baseline. Guard green.

### Still to do in C8

- **C8b** — `loginWithEmail`, registration, email verification, password reset,
  each rate-limited at a tier appropriate to a sole credential rather than the
  global 120/min.
- **C8c** — KYC submission, the admin review queue, the reviewer role, signed
  URLs for images, and `audit_logs` on every view.

Neither is blocked. Both need decision 6 (document retention and access policy)
answered before they can ship, not before they can be built.

# Phase 3 — The money path

## C9a. Books: staking ✅ DONE

A stake now enters the book matching the staker's own currency and no other.

`src/markets/market-book.util.ts` — `btnMinStakeFor` (the TER/BTC Nu 10 rule in
one place, shared with the migration backfill) and `ensureBtnBook` /
`ensureOutcomeBooks`.

**Books are created lazily, not at market creation.** The C7 backfill covered
markets that existed at migration time, but markets are created from at least
five paths — the admin API, the EPL and UCL schedulers, the BTC and TER jobs —
and adding book creation to each is a list that is wrong the moment someone
adds a sixth. Creating on first use covers all of them, including any added
later, and is idempotent via `ON CONFLICT`.

**BTN books only are auto-created.** A USDT book carries a platform cut and a
minimum stake that are business decisions, not values derivable from the
market, so it is created deliberately by an admin. A market with no USDT book
simply refuses USDT stakes.

In `placePosition`:

- the book is resolved from `users.currency`, and an absent or disabled book
  refuses the stake — this is the segregation boundary, enforced on the money
  path rather than in the market list
- `minStake` and `houseEdgePct` come from the book, so odds are quoted at the
  rate that book actually charges
- pool, odds and LMSR probability are written to `market_books` /
  `outcome_books`, within that book only
- `Position.currency` and the ledger row's currency are stamped from the book

### The legacy mirror

`markets.totalPool` and the `outcomes` pool columns are still read by
settlement, reporting and the clients. Until those move to books they are
maintained as a **mirror of the BTN book** — which is exactly what every one of
those readers means today, since all of them are ngultrum figures. A USDT stake
deliberately leaves them untouched, and C9b removes the mirror as settlement
moves across.

### Guard precedence

The book check sits **after** the DK-account and phone guards, not before.
Placing it first changed the error an existing BTN user sees from "link your DK
Bank account" to "this market does not accept BTN stakes" — caught by the
existing tests, which is exactly what they are for.

### Tests

Seven new cases in `parimutuel.engine.spec.ts`, the first being the one that
matters:

- a USDT stake moves the USDT book and **`Market` and `Outcome` are never
  written at all** — asserted on the recorded `em.save` calls, not just on
  values
- position and ledger row carry the book's currency
- odds use the book's 6% cut where the market row says 10%
- a BTN stake still writes the mirror
- a USDT stake is refused when the book is absent, and when it is disabled
- the book's minimum is enforced, and the BTN Nu 50 rule does not leak across

While writing these I found the existing engine tests pass `lmsrService` in the
wrong constructor slot — position 11, where it belongs at 9. Harmless there
because those tests stop at the balance check and never reach the LMSR call.
The new tests use the correct positions.

### Result

Full suite **2 failed / 699 passed of 701** — the same two pre-existing
payout-floor failures, +7 tests. Guard green.

## C9b. Books: settlement ✅ DONE

`settleMarket` now opens one transaction, resolves the market's books, and
settles each one against the single resolved outcome. It returns one
`Settlement` per book.

The 547-line body became `settleBook(em, market, winner, book, ...)`. The
arithmetic is untouched — thin-pool guard, 1.05x payout floor, edge subsidy,
pro-rata scale-down, residual-derived house revenue all read exactly as before.
What changed is where the numbers come from:

| Was | Now |
|---|---|
| `market.totalPool` | `book.totalPool` |
| `market.houseEdgePct` | `book.houseEdgePct` |
| all PENDING positions | positions in this book's currency |
| one `Settlement` per market | one per `(market, currency)` |
| `market.status = SETTLED` inside the body | once in `settleMarket`, after every book |

Ledger rows — payout, streak boost, refund, challenger reward — all carry the
book's currency. `refundPositions` takes it from the position rather than a
parameter, so it is right even for a mixed set.

`houseForfeit` and `challengerRewardObjectors` reach the BTN book only. Dispute
bonds are ngultrum today, and routing them into a USDT book would move money
across the boundary.

Revenue distribution is now per book, at the rate that book actually charged
(derived from `houseAmount / totalPool`) rather than the market's configured
edge.

### `winnerPool` is derived, not read

The winning side's total now comes from the positions being settled rather than
from `outcome_books`. The payout shares divide by it, so taking both from one
source makes `sum(share) === 1` true by construction. The book's running total
also counts stakes from any earlier partial settlement, which is not what this
divisor means. It removed a query and a class of drift at the same time.

### Tests

Four new cases on a market with two live books:

- one settlement per book, each out of its own pool, at its own edge — BTN
  payout pool 276 at 8%, USDT 57 at 5%
- each winner credited in their own book's currency, the USDT winner paid 57
  rather than a share of some combined 360
- **a thin USDT book refunds while the BTN book on the same event pays out** —
  the divergent case, with the refund row carrying `USDT`
- `totalPaidOut + houseAmount === totalPool` per book

Existing settlement tests needed mock updates: `em.find` is now asked for
`MarketBook`, and the mocks answered with the positions array, so settlement
ran once per position. They also had to destructure the array return.

For markets with no book row at all, `settleMarket` creates the BTN book from
the market's own figures through the ORM rather than raw SQL — which is what a
market predating the migration needs anyway, and is honest production code
rather than a test accommodation.

### Result

Full suite **2 failed / 703 passed of 705** — the same two pre-existing
payout-floor failures, +4 tests. Guard green.

## C9c. Currency-aware rounding on the settlement path ✅ DONE

The blocker C9b left behind. `toFixed(2)` was correct for ngultrum and wrong
for USDT, which is a 6dp token — every payout was silently losing four decimal
places.

`src/shared/utils/money.util.ts`:

```ts
CURRENCY_DECIMALS = { BTN: 2, USDT: 6 }
moneyDecimals(currency)          // throws on an unknown currency
roundMoney(value, currency)
floorMoney(value, currency)
```

`moneyDecimals` **throws rather than defaulting**. A default would round a new
currency to somebody else's precision and say nothing — the same
silent-wrong-answer class the ledger guard exists to prevent.

`roundMoney` is implemented over `toFixed` on purpose, so
`roundMoney(x, "BTN")` is bit-for-bit what `parseFloat(x.toFixed(2))` produced
before. The tests assert that equivalence across sixteen awkward values,
including `0.1 + 0.2`, `1.005` and `2.675`, because no existing ngultrum payout
may move by a chhertum.

All 14 rounding sites in `settleBook` now round at the book's currency: payout
floor, shortfall, per-winner payout, the scaled effective payout, the
bonus-funded withdrawable cap, the streak boost, the pool residual, the house
cut, the challenger reward and its running total, and the booked house amount.

Two sites outside the settlement path were left alone deliberately, and are now
explicit rather than incidental:

- **Dispute-bond forfeit** rounds at `BTN_CURRENCY` by name. Bonds are ngultrum
  today; naming it means the day they are not, this reads as a decision to
  revisit rather than an assumption nobody recorded.
- **The Telegram profit line** is display text on a BTN-only notification path.

### One real bug fixed in passing

The challenger-reward house cut was computed from `market.houseEdgePct`, not
the book's. On a USDT book with a different rate that would have paid objectors
out of a number the book never charged. Now reads `book.houseEdgePct`.

### Tests

12 new cases in `money.util.spec.ts` — BTN equivalence, USDT 6dp, the dust
cases that collapse to zero at 2dp, negatives, `floorMoney` never rounding up,
and the throw on an unknown currency.

Plus the decisive one in the engine spec: a USDT book of `10.000001` at a 5%
edge pays its single winner `9.500001`, and the test asserts the paid amount is
**not** equal to itself rounded to 2dp. Before this change it would have been.

### Result

Full suite **2 failed / 712 passed of 714** — same two pre-existing
payout-floor failures, +13 tests. Guard green. Every existing BTN settlement
test passes unchanged, which is the evidence that ngultrum behaviour did not
move.

## C8b. Email auth service ✅ DONE

`src/auth/email-auth.service.ts` — register, verify, login, request reset,
complete reset. A separate service rather than more methods on the 1,900-line
`auth.service.ts`, which serves 1,300 live users across three providers and
must not move. Nothing in the existing auth paths was touched.

Registration creates the user immediately: `currency = 'USDT'`,
`kycStatus = NONE`, `emailVerifiedAt = null`. The account can do nothing until
both change — document upload is gated on verification, deposit on KYC
approval. That one write at creation is what places the account on the crypto
side of the boundary permanently.

Verification and reset tokens live in Redis with TTLs (24h and 30m), matching
the existing OTP flows rather than inventing a second mechanism. Both are
single-use, and the reset token is **consumed before** the password is written:
a crash in between costs the user a second email, where the reverse would leave
a live token behind.

### Three places this route family leaks information if built naively

Each is a deliberate design choice, and each has a test:

- **Registering an address that already exists** returns exactly what a fresh
  signup returns. An "already taken" response is a free oracle for which
  addresses hold an account.
- **Every login failure gives one message.** Unknown address, no password set,
  and wrong password are indistinguishable — otherwise the route tells an
  attacker which addresses are worth attacking.
- **Reset always reports success** and sends nothing for an unknown address.

### Rate limits

The controller runs at 10/min; these sit well below it, because for every other
provider a password is a convenience layered on an external identity and here
it is the only credential:

| Route | Limit |
|---|---|
| `POST /auth/email/register` | 3/min |
| `POST /auth/email/login` | 5/min |
| `POST /auth/email/reset/request` | 3/min |
| `POST /auth/email/reset/complete` | 5/min |
| `POST /auth/email/verify` | 10/min |

### Tests

13 cases: USDT account created unverified, identity stored under the normalised
address, password hashed not stored, duplicate registration indistinguishable
from fresh, malformed address and weak password rejected, verification
single-use, all three login failures producing one identical message, the hash
never returned, reset silent for unknown addresses, and reset tokens dying
after one use.

### Result

Full suite **2 failed / 725 passed of 727** — same two pre-existing failures,
+13 tests. Guard green.

### Still to do in C8

**C8c** — KYC submission gated on `emailVerifiedAt`, the admin review queue
with its own reviewer role, signed URLs for document images, and `audit_logs`
on every view. Needs decision 6 (document retention and access policy) answered
before it ships, not before it is built.

## C8c. KYC submission and review ✅ DONE

`src/kyc/` — service, two controllers, reviewer guard, storage interface.
Migration `1775990000360` adds `users.isKycReviewer`.

Submission requires a verified email, refuses while a document is already
PENDING or the account is APPROVED, and allows exactly one resubmission after
a rejection. It moves the account to PENDING; deposit stays gated on APPROVED.

### Storage is deliberately not implemented

`KycDocumentStorage` is an abstract class whose only binding
(`UnconfiguredKycDocumentStorage`) **refuses every call**.

Choosing a store means answering decision 6 first — encryption at rest,
retention period, access control, deletion on request — and those answers pick
the provider, not the other way round. Wiring an S3 client in now would bake a
choice nobody has made, and there is no storage SDK in this repo to reach for
anyway. The flow is complete and tested behind the interface; the day the
policy lands, that one file changes.

Uploads therefore fail loudly rather than silently writing images somewhere
nobody agreed on.

### Document numbers are encrypted, and cannot not be

`src/shared/utils/pii-crypto.util.ts` — AES-256-GCM, random IV per value,
key from `KYC_ENCRYPTION_KEY`.

**No fallback when the key is missing.** It raises. The failure mode of
"quietly stored passport numbers in the clear" is not one anybody discovers in
time, and a test asserts that with no key configured nothing is written and
storage is never even called.

GCM rather than CBC because the auth tag makes a tampered ciphertext fail on
read instead of decrypting to plausible garbage — also tested. A random IV per
value matters too: a deterministic ciphertext would let anyone with database
access confirm a guessed number by encrypting it and comparing.

Reviewers see `••••4567`, never the full number. The listing endpoint returns
neither the number nor the object key.

### The reviewer role does not follow from admin

`isKycReviewer`, checked by `KycReviewerGuard`, which **rejects an admin who is
not a reviewer**. Admin access means moving money and resolving markets; this
is permission to read strangers' passports. Different permission, different
people, and if one implied the other every admin would silently hold an ability
nobody granted. There is a test for exactly that case.

The review routes live on their own controller so the guard covers all of them
by construction, rather than route by route where a single omission is a
passport leak.

### Audited

`KYC_DOCUMENT_VIEW` is logged alongside approve and reject. **Opening a
document is itself an access to sensitive PII** and has to be attributable, not
only the decision that follows it. Images are served as 5-minute signed URLs,
never permanent links.

Double-decision is refused: two reviewers working the same queue cannot both
decide one item.

### Tests

26 across three files — 16 on the service, 7 on the crypto, 3 on the guard.
The ones that matter: plaintext never stored, nothing written when the key is
absent, tampered ciphertext rejected, admin refused by the reviewer guard, the
view audited, and a second decision on a reviewed document refused.

Migrations verified against Postgres 16: applied, reverted, re-applied.
Synchronize drop-check across everything this work created — **0 of 11 objects
at risk, 11 of 11 present**.

### Result

Full suite **2 failed / 751 passed of 753** — same two pre-existing failures,
+26 tests. Guard green.

### Before this ships

- **Decision 6** — retention, deletion, access policy — then implement
  `KycDocumentStorage`.
- `KYC_ENCRYPTION_KEY` provisioned in every environment, and in the secret
  manager rather than `.env`.
- At least one account granted `isKycReviewer`; nobody has it by default.

## E2E-1. First end-to-end run ✅ DONE — and it found a bug

Everything before this was unit-tested against **mocks**. Nothing had ever
booted, and nothing had made an HTTP call. That gap was worth closing before
claiming the rail works.

Run against real Postgres 16, real Redis, a stub 21Pay, and the actual
application over HTTP.

### The application had never been started

Unit tests construct services directly, so a DI or wiring error would not have
appeared anywhere. It boots: `Nest application successfully started`, and every
USDT route maps.

### A real bug that mocks could not have caught

The idempotent replay **500'd**:

```
Invalid USDT amount "25.500000000" — expected a non-negative decimal
with at most 6 places
```

Money columns are `numeric(28,9)`, so Postgres returns a value written as
`25.5` as `"25.500000000"` — nine decimal places, none significant — and
`toBaseUnits` rejected it. Unit tests passed because the mocks returned the JS
number `10`, not a Postgres numeric string.

This affected **every read path**: get, list, and replay would all have 500'd
on any real row. Fixed in `toBaseUnits` by trimming trailing zeros before
validating, because trailing zeros are not precision. Genuine over-precision
(`1.0000001`) is still rejected. Regression test added with the exact shape the
database returns.

### What was then proven end to end

| Step | Result |
|---|---|
| Create intent over HTTP | Address + `amountBaseUnits: "25500000"` returned |
| Idempotent replay | Same `intentId`, no second intent minted |
| List | Both intents |
| Signed webhook, `confirmed` | `{"credited": true}` |
| Ledger | One row: `deposit 25.500000000 USDT`, `0 → 25.5` |
| Replay the same delivery | `{"duplicate": true}`, no second credit |
| Forged signature | **401** |
| Tampered body, valid signature | **401** |
| Ledger after both attacks | Still one row, still 25.5 |

### Two more pre-existing drifts found, both blocking a fresh boot

Neither is mine, and both stop a migration-built database from starting:

- **`outcomes.sortOrder`** — on the entity, used in a startup query, created by
  no migration. Boot fails outright.
- **`markets.groupId`** — same, surfacing as a scheduler error every few
  seconds once running.

With `disputes.rewardAmount` and `season_prize`, that is **four** entity/
migration drifts. Production presumably has these columns from a historical
`DB_SYNCHRONIZE` run, which is precisely why the drift went unnoticed — and why
staging rebuilt from migrations will not start without them.

**Recommend a single reconciling migration** before any staging rollout. It is
small, and it is the difference between a fresh environment working and not.

### What this still does not prove

No call has been made to the **real** 21Pay. The stub answers the shapes we
coded to, which is exactly the assumption under test. Only a staging run
against their gateway closes that.

## E2E-2. First contact with the real 21Pay ✅ + three findings

Credentials arrived. `GET /v1/networks` and `GET /v1/ledger/balances` both
returned real JSON — **the client authenticates against the live gateway.**
That was the last wholly unproven link.

Their `.env` was already correct: base URL carries the `/v1` suffix the client
requires, and the token sits under `TWENTY_ONE_PAY_API`, which the client reads
as a fallback.

### Finding 1 — only Tron is activated

```
tron       active      activated: true
base       available   activated: false
polygon    available   activated: false
arbitrum   available   activated: false
```

The plan assumes a four-chain launch. **In reality there is one.** Either 21Pay
registers xpubs and activates the other three, or launch scopes to Tron — which
also removes wallet-connect entirely, since Tron has no browser wallet support
and manual was always going to be the majority path. Tron-only is the smaller,
cleaner launch.

The EIP-55 validation built in C6 is currently dead code. Harmless, and ready
if the chains are activated.

### Finding 2 — the tenant already holds 1,031 USDT

`tenant.payable` shows 1,031.000000 USDT credited against our tenant, zero
debits. Oro has no local record of any of it.

Custody parity will therefore report a 1,031 USDT discrepancy the first time
reconciliation runs — **correctly**. Someone has to decide before launch
whether that is written off as test funds or belongs to a real user.

### Finding 3 — their staging API went down mid-session

`GET /v1/networks` returned JSON, then minutes later the same call returned
nginx serving 21Pay's own frontend as a catch-all 404 — with and without a
token, while the host root served fine. Their API process stopped behind the
proxy.

Worth reporting to them: an integrator sees `404 Not Found` on a route that
exists and goes hunting for a bug in their own client. A JSON 502 from the
proxy would be unambiguous.

It also invalidated the probes meant to settle the payouts question, since
`/networks` 404'd alongside them.

### Still unsettled: `/v1/payouts` or `/v1/withdrawals`

Their staging integration page documents `POST /v1/payouts` with `to_address`
and **no** `key_handle` — which contradicts the engine-source finding that the
route is operator-only and merchants must use `/v1/withdrawals`. Stage F is
built against `/v1/withdrawals`.

Two GETs settle it once their API is back. Not guessing.

### Also new: a realtime WebSocket channel

`POST /v1/realtime/credentials` returns NATS creds for
`payment.tenants.<tid>.deposits.>` and `payouts.>`. A third delivery channel
not in the plan, and the natural answer to withdrawals being absent from the
webhook fan-out. Worth adding after the payouts question resolves.

---

## C15b. Reconcile entity/migration drift ✅ DONE

Migration `1775990000400`.

A migration-built database **could not boot**. Found by diffing entity metadata
against a freshly migrated schema rather than by reading migrations — the only
way to catch drift that accumulated silently.

Synchronize's plan listed 13 missing columns, but checking each against the
catalogue showed **4 genuinely absent**; the other 9 exist with type names
TypeORM would prefer to change (`timestamptz` vs `TIMESTAMP`, `varchar` vs a
named enum). Those are preference, not breakage, and rewriting live column
types to satisfy them would be risk for nothing.

| Missing | Consequence |
|---|---|
| `outcomes.sortOrder` | Read by a startup query — **boot fails outright** |
| `markets.groupId`, `groupTitle`, `isFeatured` | Scheduler error every few seconds |
| `transactions_type_enum` lacks `season_prize` | Every season-prize payout fails on insert |

That last one means **season prizes have never successfully written** on any
database built from migrations.

Every statement is `IF NOT EXISTS`, so it is a no-op in production, where these
almost certainly arrived via a historical `DB_SYNCHRONIZE` run — which is
precisely why the gap went unnoticed.

**Verified:** applied, idempotent on re-run, reverts and re-applies, and a
purely migration-built database now boots with **0 schema errors**.

## C10b. Network selection, activation-checked ✅ DONE

The user picks the network at deposit time — that was always the design — but
**nothing told the client which networks to offer**, so the PWA would have had
to hardcode a list. Given only Tron is actually activated, that is exactly how
a user ends up with a deposit address on a chain nobody is watching.

`GET /api/payments/usdt/networks` now returns the **intersection of what we
configure and what 21Pay reports as `activated` for our tenant.**

Config alone is not enough. `status: "available"` means the engine supports a
chain; `activated: true` means our tenant has an xpub registered and a watcher
running. Only the second is safe to offer — a deposit to an unwatched derived
address is simply lost.

**If 21Pay is unreachable, it returns nothing rather than falling back to
config.** Guessing here hands somebody an unrecoverable deposit; an empty
picker is a bad afternoon.

Anything configured but not activated is withheld and logged at `warn`, so a
misconfiguration surfaces as an operational signal rather than a lost deposit.
Cached five minutes, since activation changes about never.

Display copy is backend-owned — name, confirmation hint, and the Tron gas
warning (a TRC-20 transfer needs TRX for energy; a wallet holding only USDT
cannot send at all, which is the single most common Tron support issue). No
client keeps a per-chain table that can drift.

### The deliberate asymmetry

| | Who chooses the network |
|---|---|
| **Deposit** | The **user** — they are choosing where they are sending *from* |
| **Withdrawal** | **Nobody.** It is a property of the saved address record |

That is not an inconsistency. All three EVM chains share the `0x` format, so no
validation can tell a Base address from an Arbitrum one. At deposit the user
knows which chain their funds are on and the address we give back is derived
for it. At withdrawal, offering a network dropdown next to an address field
invites someone to pick the wrong one and lose the money permanently. Binding
the network to the record removes the choice, and therefore the mistake.

### Result

Full suite **2 failed / 819 passed of 821** — same two pre-existing failures,
+5 tests. Live verification pending: 21Pay's staging API is still down.

## C7b. Admin path to open a USDT book ✅ DONE — and it exposed a blocker

`MarketBookService` plus four admin routes. Until this, **no USDT market could
exist**, so a perfect deposit still gave an international user nothing to bet
on.

```
GET    /api/admin/markets/:id/books
POST   /api/admin/markets/:id/books          { currency, houseEdgePct, minStake }
PATCH  /api/admin/markets/books/:bookId      { houseEdgePct?, minStake? }
POST   /api/admin/markets/books/:bookId/enabled  { enabled }
```

A BTN book still appears on its own at first stake, because its terms follow
from the market. **A USDT book does not** — the cut and the minimum are
decisions nobody can infer — so it is opened deliberately. That is the
"explicit toggle" answer to decision 2a: opening one on every market by default
would give international users a feed of pools holding almost nothing.

Guards: unsupported currency, resolved market, market with no outcomes,
duplicate book, edge outside 0–50%, non-positive minimum. Terms are **frozen
once anyone stakes** — someone who bet at an 8% cut agreed to an 8% cut.
Disabling stays allowed with stakes present, so a chain going down mid-market
can stop new money without disturbing the pool. Every action audited.

### The blocker it exposed

With a book finally openable, a real USDT stake over HTTP returned:

```
"You must link your DK Bank account before placing a bet."
```

`placePosition` required `dkAccountNumber` and `phoneNumber` from **every**
staker. Those exist so BTN winnings reach a Bhutanese bank account. An
international USDT user will never have either.

**No USDT account could have placed a single bet.** The deposit rail, the
books, the settlement engine — all correct, and the product still unusable for
the exact cohort it was built for. Every unit test passed throughout, because
they all supplied a DK account without asking whether they should.

Now scoped to BTN accounts. A USDT account's equivalent gate is KYC approval on
the deposit path: an account that was never approved cannot have funded itself,
so it has nothing to stake. Two regression tests, one each way.

### Proven end to end

Against a live server, real Postgres, a funded USDT account:

| | |
|---|---|
| Stake before the book exists | refused |
| Admin opens USDT book, 6% cut | created |
| Same stake, after | **accepted** — `currency: USDT`, odds `0.94` |
| Odds basis | the book's 6%, not the market's 10% |
| `market_books` USDT pool | `10.000000000` |
| `markets.totalPool` (legacy BTN mirror) | **`0.00` — untouched** |
| Ledger | `deposit 100 USDT`, `bet_placed -10 USDT` |

That last row is the segregation invariant holding under a real request rather
than a mock.

### Result

Full suite **2 failed / 833 passed of 835** — same two pre-existing failures,
+14 tests.

## C14b. Stage H — PWA deposit and withdrawal ✅ FIRST CUT

`oro-pwa`. Compiles and builds clean; **not yet exercised against a live
backend**, which is the next step and the one that has found every real bug so
far.

### The currency foundation

`shared/currency/currency.tsx` — `CurrencyProvider`, `useMoney()`,
`formatMoney(amount, currency)`.

**Currency is a required argument.** The old helper defaulted to ngultrum,
which meant a component that forgot to pass one silently rendered `Nu` on a
USDT screen — wrong in a way nobody notices until a user does. Required turns
that into a compile error.

Display rounds USDT to 2dp for readability while the ledger keeps all 6. Those
are different concerns and the file says so, because someone will otherwise
"fix" the display to match the ledger.

### Deposit panel

Manual only, and **that is a decision rather than an omission**: Tron is the
only activated chain and has no browser wallet worth shipping, and most
deposits arrive from an exchange where no wallet is involved. A method toggle
with one option is noise. If EVM chains are activated this gains a second
method.

The screen exists to prevent two unrecoverable mistakes — wrong chain, wrong
amount:

- Network chosen first, with the consequence stated plainly
- Address **and amount** each with their own copy control, because users type
  the amount by hand and every wrong one becomes an underpayment
- The Tron gas warning, served by the backend
- Expiry countdown, and a per-chain confirmation expectation so `confirming`
  reads as progress rather than as stuck
- `confirmed_partial` surfaces the shortfall with **Top up** prominent, reusing
  the same address
- An empty network list says deposits are unavailable rather than showing an
  empty picker — the backend withholds any chain it cannot confirm 21Pay is
  watching

`clientRequestId` is generated once per attempt and reused, so a double-tap
replays the intent instead of burning another derived address.

### Withdrawal panel

**No network selector next to the amount.** The network belongs to the saved
address. All EVM chains share the `0x` format, so nothing can tell a Base
address from an Arbitrum one, and a dropdown there invites picking the wrong
one and losing the money. Chosen once when the address is added, then displayed
spelled out everywhere.

The 24h cooldown is surfaced with the time the address becomes usable, not a
bare refusal. A winner who cannot withdraw needs to know why.

`needsManualReview` reads as "Under review" with a line saying support will be
in touch and no action is needed — never a failure, because we genuinely do not
know yet whether that money moved.

### Not built, deliberately

Wallet-connect and the whole `wagmi`/RainbowKit dependency. Only Tron is
activated; adding a WalletConnect project id and ~200KB of bundle for a chain
nobody can use would be premature.

### Wired in and exercised against a live backend

Mounted into `PwaWalletPage`. A USDT account gets a Deposit/Withdraw tab pair
and **never sees the DK Bank buttons**; a BTN account sees exactly what it
always has. The two are mutually exclusive because an account is native to one
currency and there is no conversion between them.

### The bug that only running it could find

`GET /users/me` builds its response from an explicit `select` list, and
`currency` was not on it. So `profile.currency` was always `undefined`,
`isUsdt` was always false, and **the USDT panels would never have rendered** —
a USDT user would have seen a Top Up button wired to DK Bank that could not
possibly work.

Nothing in 833 backend tests or a clean PWA build could catch that: both halves
were correct, and the field connecting them simply was not being sent. Added
`currency` and `kycStatus` to the select, with a comment saying why they are
load-bearing.

### Verified end to end

Against a live backend with a funded USDT account:

| Call | Result |
|---|---|
| `/users/me` | `currency: USDT`, `kycStatus: approved`, `credits: 250` |
| `/payments/usdt/networks` | Tron only, with the TRX gas warning — `base` withheld as not activated |
| Create intent | address, `25500000` base units, expiry |
| Poll | `awaiting_deposit`, as the 5-second timer sees it |
| Add destination | `cooldown`, `usableAt` 24h out |
| Withdraw from a cooling address | refused **with the date it becomes usable** |

That last one is the point of surfacing the cooldown rather than just enforcing
it: the API hands the UI a sentence it can show a user.

### Still to do in Stage H

- Market card showing both book totals side by side, never summed
- TMA guard: a USDT account opening Telegram should be told to use the web app
- Styling — the panels carry semantic class names and no stylesheet yet

## C8d. Google Sign-In ✅ DONE (backend)

`AuthProvider.GOOGLE`, migration `1775990000410`, `loginWithGoogle` on
`EmailAuthService`, `POST /auth/google`, and `GOOGLE_CLIENT_ID` in
`.env.example`.

The primary path for international accounts. Google verifies the address, which
removes an email-verification flow, a reset flow and a stored password. It says
nothing about **who owns** the address, so KYC still gates deposits unchanged —
authentication and identity are different questions.

### Three decisions that matter

**Nothing the client sends is trusted.** The ID token is verified against
Google's keys with our client id as the audience; email, name and subject are
read from the verified payload. A caller that could assert its own email could
assert anybody's.

**Keyed on `sub`, never on email.** A person can rename the address on a Google
account. `sub` is stable for its life, so keying on email would silently detach
an identity the day somebody renames theirs.

**An unverified Google address is refused.** Some Google account types return
`email_verified: false`, and treating one as proof of ownership is the entire
vulnerability.

### The security-critical branch: linking

`users.email` is unique, so a Google sign-in for an address we already hold
**must link rather than create**. That branch has a specific attack in it:

Someone registers `victim@gmail.com` with a password and never verifies it.
When the real owner later signs in with Google, linking as-is would hand them
an account whose password the attacker knows.

So: Google's verified claim is the stronger evidence of ownership, and the
**unproven password is discarded** on link. The rightful owner can set a new
one; the attacker loses access they never legitimately had. Where the account
was already verified, both sides have proven ownership and the password is left
alone. Both branches are tested, and the unverified case logs at `warn`.

### Result

Migration verified against Postgres 16 — `telegram, dkbank, bhutanapp, email,
google` — applied, reverted, re-applied. Full suite **2 failed / 842 passed of
844**, same two pre-existing failures, +9 tests.

### Still to do

- **PWA**: the Google button, and `VITE_GOOGLE_CLIENT_ID`.
- **A real `GOOGLE_CLIENT_ID`** from the Google Cloud console. Until one exists
  the route returns 503 and nothing else changes.
- **Decide the fate of email/password.** With Google primary and OTP available,
  a password is a weaker credential whose recovery path is the stronger one we
  already have. Recommend removing it — but that deletes working, tested code,
  so it wants an explicit decision rather than a quiet cleanup.

## C8e. Blind index on KYC documents ✅ DONE

Migration `1775990000420` plus `blindIndex()` and `normaliseDocumentNumber()`.
This should have been in C8c; its absence was my error.

### The problem it fixes

`documentNumber` is AES-GCM with a random IV, so the same passport encrypts
differently every time — correct for confidentiality, and it makes
`WHERE documentNumber = ?` permanently useless. Two things need exactly that
lookup:

- **Duplicate detection.** Google sign-in makes accounts nearly free. The only
  thing linking five accounts to one person is the document behind them, and
  per-user responsible-gaming limits and AML both rest on noticing.
- **Account recovery.** Someone locked out of the Google account they signed up
  with cannot receive an email or a code — but they are still the person on the
  passport we already hold. Recovery means finding the account *from* the
  document.

### How

A keyed HMAC over the normalised number, stored beside the ciphertext.
Deterministic so it can be indexed and searched; one-way so the database still
never holds a readable passport number.

**Keyed, not a plain hash.** Document numbers are short and low-entropy; an
unkeyed digest falls to brute force in seconds. **And keyed separately from
`KYC_ENCRYPTION_KEY`**, so leaking one does not compromise the other.

**Normalisation matters more than it looks.** People write the same passport as
`P1234567`, `p 1234567` and `P-1234567`. Uppercase, strip non-alphanumeric —
otherwise duplicate detection is defeated by a space. Tested with all four
variants colliding to one index.

### Deliberately not a unique constraint

A duplicate is a **signal for a human**, never an automatic rejection. Families
share addresses, people legitimately re-register after a rejection, and a hard
database constraint would turn a review case into a support incident. Reviewers
see `alsoUsedBy` when they open a document, and it logs at `warn`.

### Result

Migration verified on Postgres 16 — nullable column, index present, applied,
reverted, re-applied. Full suite **2 failed / 855 passed of 857**, same two
pre-existing failures, **+13 tests**.

`KYC_ENCRYPTION_KEY` and `KYC_INDEX_KEY` both documented in `.env.example`,
with a note that rotating either needs a re-encryption or re-index plan.

## C15. Google sign-in in the PWA ✅ DONE

The backend route existed with nothing calling it. This is the client half.

`src/components/GoogleSignInButton.tsx`, wired into `ProtectedRoute` as a third
option below My Bhutan App, plus `loginWithGoogle()` in `shared/api/client.ts`.

### Placement

My Bhutan App stays first. Google is for people with no Bhutanese identity,
which is the whole point of the USDT rail, but it is not the majority path
today and reordering the existing options would be a regression for everyone
already using them.

### Failure modes handled, because each is real

- **No client id** — the button renders nothing at all. An unconfigured button
  is worse than an absent one: it looks like a working option and fails only
  after the user has committed to it.
- **Google's script blocked** — loaded from `accounts.google.com`, blocked
  outright on some networks and by some extensions, and when that happens the
  button silently never appears. A 6-second check turns the blank gap into an
  explanation.
- **Popup blocked or cancelled** — indistinguishable from each other through
  the library's `onError`, so one message covering both.
- **Unverified Google address** — the server refuses it. The client says so in
  those words, because "sign-in failed" gives the user nothing to act on.

### Referral attribution

Google signups previously dropped the referral code on the floor. The code now
travels with the credential and is resolved on the server, **only when the
account is created** — re-attributing on every sign-in would let anyone re-refer
an existing user by sending them a link. An unknown code is ignored rather than
rejected: a stale link must never cost us the account.

Codes are minted from Telegram ids, so a Google signup can only be referred by a
Telegram user. That is the realistic direction anyway.

### Loose end, deliberately left

A new account sets `sessionStorage["oro_new_account"]`. **Nothing reads it yet.**
It is the hook for the KYC screen, which does not exist — Google proves the
address is real and says nothing about who owns it, so deposits stay gated on an
approved document and a fresh account currently lands on the feed with no
prompt. That screen is the next piece of Stage H.

### Verification

PWA typecheck and `bun run build` clean. Backend suite **858 passed of 860**,
same two pre-existing failures, **+3 tests**. Endpoint exercised over real HTTP:
junk credential → 401, empty body → 400, neither a 500.

`VITE_GOOGLE_CLIENT_ID` added to `.env` and `.env.production`, with a note that
it must match the backend's `GOOGLE_CLIENT_ID` — a mismatch fails every sign-in
with an audience error.

## C16. The PWA verification screen ✅ DONE — storage still blocks it

`src/components/KycVerificationPanel.tsx`, gating the USDT rail in
`PwaWalletPage`, plus the backend gaps building it exposed.

Until now `POST /kyc/documents` had no caller and `approve` / `reject` had no
caller either, while `crypto-deposit.service.ts:227` refuses any deposit unless
`kycStatus === APPROVED`. The rail was gated on a status no UI could reach.

### Four backend faults the screen found

**`GET /kyc/status` served the JWT, not the database.** The token is minted at
login, so a user who submitted a document kept seeing "not started", and an
approval did not unlock deposit until they logged out and back in. Replaced with
`statusFor()`, which reads live and also returns `submittedAt`, `reviewedAt`,
`rejectionReason` and `canSubmit`. The reason is returned **only** when the
status is `rejected` — someone rejected then approved still has the old reason
on an older row, and showing it beside "verified" reads as a fresh problem.

**No image validation at all.** Anything base64-decodable was accepted and
handed to a reviewer. Now: JPEG, PNG or WebP only (**not PDF** — it carries
script and embedded files, and a reviewer opening one is a different risk), 4 MB
decoded ceiling, and a magic-byte check, because the declared MIME type is
client-controlled and is not evidence of anything.

**The 1 MB body limit made a phone photo impossible.** Base64 inflates by a
third, so the 4 MB image limit needs ~5.5 MB of JSON, and a camera photo hit an
opaque 413. A 6 MB parser is now mounted on `/api/kyc/documents` alone, ahead of
the general one — body-parser skips a request already consumed, so every other
route keeps the tighter limit instead of the whole API inheriting a 6 MB budget.

**The submission throttle locked out entire networks.** 3/hour keyed on source
IP. An office, a university, or any mobile carrier behind CGNAT is one address
shared by thousands, so that was three *people* an hour who could ever sign up
from that network. Raised to 30/hour and re-scoped to what it is actually for —
**bandwidth**, since this is the one route accepting megabytes. Flooding the
review queue was never possible anyway: `submit` refuses while a document is
pending, so a second one needs a reviewer's decision in between.

I first fixed this with a per-user tracker guard and **removed it again** — the
global `ThrottlerGuard` reads the same route metadata, so the IP-keyed limit
still applied and the custom guard bought nothing.

### The screen

One panel, four states. `none` and `rejected` both show the form — a rejection
reason with no way to act on it is just an insult — `pending` explains the wait
and polls every 30s so an approval unlocks deposit without a reload, `approved`
confirms.

**Client-side downscaling** to 1600px and stepping JPEG quality down until under
700 KB. Phones produce 3–8 MB and a reviewer gains nothing from a 12-megapixel
original; without this, every real submission is a 413.

The wallet reads `getKycStatus()` live rather than `profile.kycStatus`, for the
same staleness reason. **A failed status check leaves the gate closed** — the
server refuses an unverified deposit regardless, so showing the form is the
honest fallback.

`sessionStorage["oro_new_account"]`, left dangling by C15, now has its reader: a
new Google account is routed to the wallet instead of the feed.

### Verified against a running server

Status on a fresh account, magic-byte rejection, country rejection, 2 MB
accepted on the KYC path, 2 MB still 413 everywhere else, 7 MB refused, and 6
consecutive submissions from one IP (previously blocked after 3). Suite **866
passed of 868**, same two pre-existing failures, **+11 tests**.

Two things surfaced only by running it: the dev database was missing migration
`1775990000420`, and a missing `KYC_ENCRYPTION_KEY` produced a bare 500. The
second is now a 503 with the detail in the log — a deployment fault should not
read as a code bug and send whoever is on call looking in the wrong place. The
storage refusal was likewise leaking "decision 6" to the client.

### ⛔ Still blocked: no document store exists

`UnconfiguredKycDocumentStorage` refuses every `put`, so a complete, validated
submission ends in 503. **This is deliberate and it is decision 6** —
encryption at rest, retention period, access control, deletion on request.
Those answers pick the provider, not the other way round.

Everything on both sides of it is now built and exercised. When the policy
lands, `kyc-document-storage.ts` is the only file that changes.

**And there is still no admin review UI.** `oro-admin` has 20 pages and none of
them is KYC, so even with storage wired nobody can approve. That is the next
piece.

## C17. Sign-in sheet, and a swallowed configuration error ✅ DONE

### The bug worth recording

`this.google()` — which throws "not configured" — sat **inside** the try block
around `verifyIdToken`, so a deployment with no `GOOGLE_CLIENT_ID` reported
`401 Google sign-in failed`. That is the opposite fault pointed at the opposite
party: it tells the user to go check their Google account when the problem is
entirely ours, and it is indistinguishable from a genuinely bad token in the
logs. Resolved before the try now, so it surfaces as 503.

This cost real time. The first HTTP test of the Google route returned 401 and I
read that as "configured" — it was not, and the swallow is why.

### Configuration

The client id had been pasted into the **backend** `.env` as
`VITE_GOOGLE_CLIENT_ID`. That prefix means something only to Vite; the backend
reads `GOOGLE_CLIENT_ID`, saw nothing, and refused every token. Both files now
carry the same value under their own name.

Neither process re-reads `.env` while running — one restart-shaped failure was
just a server booted a minute before the file was written.

### Sheet layout

My Bhutan App and Google are the visible options; **the DK Bank CID form is
collapsed behind a link**. It only works for someone who has already set a
website password in Telegram, and we cannot know that until they type the CID —
so leading with an option most people cannot use was wrong. The password field
and the "set one in Telegram" notice inside it are unchanged.

The close button was at `top: -15px` with a media query pushing it to
`right: -20px`, so it floated outside the panel entirely on desktop. It now
hangs off a full-width wrapper rather than the 360px content column, which is
centred and left it sitting well inside the panel's edge.

## C18. A second wallet: Bhutanese accounts can hold USDT ✅ BACKEND DONE

A Bhutanese user with USDT in their own wallet can now deposit it into Oro.
Until now `crypto-deposit.service.ts` refused anything but a USDT-native
account, and `users.currency` was fixed at signup — one person, one currency,
forever.

### The shape that made this small

`users.currency` stays the **native** currency and keeps its exact meaning.
Streaks, seasons, leaderboards, bonuses and the DK Bank rail all keep reading
it, so **none of the 20 `ledgerBalanceForAccount` call sites moved**. A USDT
wallet is something an account holds *beside* its native currency, not a
change to what the account is.

The reverse does not exist: a USDT-native account cannot hold ngultrum, because
BTN only enters through DK Bank, which requires a Bhutanese identity. A BTN
wallet there could be credited but never funded.

Still no conversion, and still no rate anywhere.

### Who may hold one

An approved KYC document, **or a linked DK Bank account**. A verified CID is
national identity checked by a bank — strictly stronger than a photographed
passport read by a reviewer, so requiring a document on top of it would put the
best-identified users in the slowest queue for no gain.

**A near-miss worth recording.** My first version of `usdtIdentityVerified`
short-circuited on `currency === "USDT"` — reasoning that a USDT account is
obviously allowed USDT. That silently removed the KYC gate for every
international account, which is the exact population it exists for. An existing
test caught it within a minute. Holding a currency and having proved who you
are are two different questions, and the code now keeps them apart:
`allowedCurrencies()` answers the first, `usdtIdentityVerified()` the second.

### The invariant that had to be replaced

`segregation-invariants.service.ts` asserted every transaction and every
position carried its owner's account currency. Both become false by design
here. Deleting them without a replacement would have left the area unguarded,
so they were replaced by:

- **`no_wallet_overdrawn`** — no `(userId, currency)` sums below zero. Stronger
  than what it replaces: a row in the wrong wallet either creates money or
  spends what was never there, and the second half shows up here immediately.
  It also catches a stake paid from a wallet that could not fund it, which
  currency-matching never could.
- **`currencies_are_holdable`** — still catches an unknown currency string, and
  still refuses ngultrum on a USDT-native account.

Both were run against the real database, not just the mock. `no_wallet_overdrawn`
**found a violation on its first run** — one dev account at −1,322.84 BTN, from
manual withdrawal testing, with a double-written refund pair in its history
(identical amount, identical `balanceBefore`, 2ms apart). Dev data, not chased
here, but the check earned its place before it shipped.

### Changed

| | |
|---|---|
| `wallet.util.ts` | New. `allowedCurrencies`, `usdtIdentityVerified`, `resolveWalletCurrency`. |
| Deposit / withdrawal gates | "May this account hold USDT", not "is it a USDT account". Withdrawal matters most: money that goes in and cannot come out is the worse failure. |
| `placePosition` | Takes an optional stake currency. Omitted means native, so every existing caller is untouched. DK Bank and phone prerequisites now follow **the wallet being spent** — a USDT stake pays out to a crypto address and needs neither. |
| `OpenPositionDto` | Optional `currency`, validated against `BTN` / `USDT`. |
| `/users/me` | Adds `canHoldUsdt`, `usdtVerified`, `usdtBalance`. `creditsBalance` is untouched and still native-only — the two are never added, because there is no rate. |
| PWA wallet | A "USDT wallet" section beside the ngultrum rail for eligible accounts, with the KYC panel when unverified. |

### Verified against a running server

- Bhutanese + DK Bank linked → `canHoldUsdt: true`, `usdtVerified: true`, and a
  deposit intent that passes every local gate and reaches 21Pay (their staging
  404 is the known issue, not ours).
- Bhutanese with nothing proved → `canHoldUsdt: false`, deposit refused 403.
- Suite **888 passed of 890**, same two pre-existing failures, **+22 tests**.

### ⛔ Deposit works; spending does not yet

A Bhutanese user can fund a USDT wallet but **cannot stake it from the PWA**.
The engine accepts a stake currency and the API carries it — the bet form does
not send one, because the market payload does not expose its books, so the
client cannot tell which markets accept USDT. Offering the choice now would
mean a selector that fails on submit for most markets.

Order: **expose books on the market payload → market card shows both → bet form
picks the wallet.** The first is already on the Stage H list as "market card
showing both books"; it is now a blocker rather than a nicety.

## C19. KYC document storage on MinIO ✅ DONE — decision 6 answered

The last thing standing between a submitted document and a reviewer. Modelled
on the MinIO adapter in 975BuddyClassroomBackend, with one change the content
demands.

### The bucket only ever holds ciphertext

975Buddy stores classroom media as-is and hands out presigned URLs. That is
right for a lecture slide and wrong for a passport, so the image is encrypted
with AES-256-GCM under `KYC_ENCRYPTION_KEY` **before** it is uploaded.

This is what makes MinIO an acceptable answer to decision 6 without a separate
encryption-at-rest story: bucket credentials, a leaked backup, or a
misconfigured public policy yield nothing readable. Encryption is ours, not the
store's.

`encryptBytes` / `decryptBytes` are binary rather than base64url like the
string helpers — an image is already megabytes and base64 would add a third to
every upload and download for nothing. Objects are framed `ORO1 | iv | tag |
ciphertext`, so a plaintext image written by some future code path fails loudly
instead of being served as though it had been protected.

### Which means no presigned URLs

A presigned link would hand the reviewer ciphertext no browser can render.
`signedUrl` instead mints a short-lived HMAC-signed link to
`GET /api/admin/kyc/image`, which decrypts and streams.

**That route needed its own controller.** A browser loads it in an `<img>` tag,
which sends no Authorization header, so both `JwtAuthGuard` and
`KycReviewerGuard` would reject it. `@Public()` was not enough — it disables
only the JWT guard, leaving the reviewer guard to fail confusingly. The
signature is the authorisation: bound to one object key and one expiry, so a
reviewer cannot walk to another applicant's document by editing the query
string, and it dies in minutes.

Object keys are random UUIDs, not derived from the user or the time — a key
ends up in logs and error reports.

### The bug that would have shipped

The module first chose its provider with
`useClass: MinioKycDocumentStorage.isConfigured() ? ... : ...`. **Decorator
arguments are evaluated when the file is imported, which happens before
`main.ts` calls `dotenv.config()`** — so the check always saw an empty
environment, always picked the refusing stub, and logged "credentials not set"
on a deployment where they were set correctly. Now a `useFactory`, which runs
at container init.

This only surfaced because the end-to-end run was done against a real MinIO.
Every unit test passed throughout.

### Verified against real MinIO, end to end

- Bucket missing → `healthy()` says so; `bucketExists` is a signed call, so bad
  credentials fail at boot rather than at the first upload.
- Upload → the object in the bucket begins `ORO1` and **contains no JPEG
  magic**; read back byte-identical, correct MIME from object metadata.
- Signed link verifies; a tampered key and an extended expiry are both refused.
- Full flow through the API: submit → `pending` → queue → open for review →
  image streams as `image/jpeg`, 3004 bytes → approve → `approved` → deposit
  intent passes every gate and reaches 21Pay.
- Delete removes the object.

Suite **901 passed of 903**, same two pre-existing failures, **+21 tests**.

### Configuration

`MINIO_ENDPOINT` (host:port or a full URL), `MINIO_ACCESS_KEY`,
`MINIO_SECRET_KEY`, `MINIO_KYC_BUCKET`, `MINIO_USE_SSL`. Unset means uploads are
refused outright — a deployment that takes a document and cannot store it is
worse than one that says so at the door.

A `minio` service is now in `docker-compose.yml` on ports 19000/19001, so dev
matches without ad-hoc containers.

### Still open: retention

The **capability** is built — `remove()` works and is tested. The **policy** is
not: how long an approved document is kept, and what happens on an erasure
request. That is a number somebody has to choose, and I am not going to invent
one. Nothing accumulates dangerously until real documents exist, but the job
that enforces it should be written before they do.

## C14a. Remove the TON placeholder ✅ DONE (backend + PWA)

Shipped alone, ahead of the rest of C14, so there is never a build where a user
sees two crypto options and one of them is a decoy.

**Backend** — `ton` removed from `GET /payments/methods`. It was returned with
`enabled: true` and no rail behind it. `PaymentMethod.TON` stays in the enum
because Postgres cannot remove an enum member and old rows may reference it;
it now carries a `@deprecated` note saying it never had a working rail.

**`oro-pwa`** — selector entry, the "TON payments coming soon" branch, the lazy
`TonConnectUIProvider`, the `tonconnect-manifest.json`, and the
`@tonconnect/ui-react` dependency, all gone. Build passes and the bundle no
longer contains any TonConnect code, which is the 835 KiB the lazy-loading
existed to defer.

Removed with `bun`, not `npm`: `oro-pwa` tracks both `bun.lock` and
`package-lock.json`, and the Dockerfile builds with `bun install` against
`bun.lock`. 32 deletions, no unrelated churn.

## ⚠️ The TMA has a live TON feature — decision 2 needs revisiting

Not touched, and it contradicts a premise this plan has been carrying.

`oro-tma` has **routed, reachable TON pages**:

```
src/navigation/routes.tsx:97   /ton-bet/:id   → TONBetPage
src/navigation/routes.tsx:104  /ton-connect
src/components/Root.tsx:83     TonConnectUIProvider wraps the whole app
```

Every stage doc says the Telegram client is BTN-only, and master-plan
decision 2 records that as an assumption to confirm. It is wrong as written:
the TMA ships a TON betting surface today.

That matters in three ways:

1. **"The TMA is untouched" is load-bearing** for the no-disruption guarantee,
   and it was assumed rather than checked.
2. **Removing `ton` from `GET /payments/methods` may have affected it.** If
   `TONBetPage` reads the methods list it is now degraded; if it drives
   TonConnect directly it still works. Worth checking before this reaches
   production.
3. **It is a second crypto rail** in a product whose whole design says there is
   one. Whether it is live, abandoned, or a prototype nobody removed changes
   what Stage H has to do.

**Answered (2026-08-19): the TMA's TON feature is not live, and whether it
stays is undecided.** So it is left exactly as it is — not removed, not wired
to anything. Nothing in this plan depends on it, and the backend no longer
advertises `ton` as a payment method either way.

Two things follow. The "TMA is untouched" guarantee holds, because the feature
is inert. And decision 2 stays open: if the TON surface is ever revived it is a
second crypto rail in a product designed for one, and it would need to answer
the same segregation questions from scratch.

## C15a. Segregation invariants ✅ DONE

The Stage I §I.4 checks, brought forward: they validate everything built so far
and needed no external answers.

`src/reconciliation/segregation-invariants.service.ts`, exposed at
`GET /reconciliation/segregation` behind the admin guard. Seven checks, each of
which must report **zero**:

| Check | Assertion |
|---|---|
| `ledger_matches_account` | every transaction's currency equals its owner's account currency |
| `positions_match_account` | every position's currency equals its owner's |
| `positions_have_a_book` | every position has a market book in its currency |
| `book_totals_match_stakes` | each open book's `totalPool` equals the stakes in it |
| `settlements_balance_per_book` | `totalPaidOut + houseAmount = totalPool`, per settled book |
| `settlements_have_a_book` | every settlement has a book in its currency |
| `outcome_books_complete` | every funded book has an outcome book per outcome |

**Zero, not "within tolerance".** A tolerance would hide exactly the class of
bug these exist to catch, because the first sign of a leak is always a small
number.

Two checks are deliberately scoped rather than universal, and both would
otherwise produce false alarms: `book_totals_match_stakes` skips settled and
cancelled markets, because settlement moves money out of a pool without
removing the positions; `settlements_balance_per_book` skips refunded books,
which return stakes rather than distributing a pool.

This complements the guard test rather than repeating it. **The guard proves no
code sums across currencies; these prove no data has crossed.**

### Verified by breaking them

Against a real Postgres: a correct world first — one BTN market, funded book,
matching positions, a BTN and a USDT account — all seven reporting zero. Then
each invariant was violated in turn:

```
FAIL  ledger_matches_account (1)        USDT ledger row on a BTN account
FAIL  positions_match_account (1)       USDT position owned by a BTN account
FAIL  positions_have_a_book (1)         position in a currency with no book
FAIL  book_totals_match_stakes (1)      book total drifted from stakes
FAIL  settlements_balance_per_book (1)  settlement that does not balance
FAIL  settlements_have_a_book (1)       settlement in a currency with no book
FAIL  outcome_books_complete (1)        funded book missing an outcome book
```

One violation each, no false positives and nothing missed. A check that has
never been seen to fail is not a check.

### Result

Full suite **2 failed / 756 passed of 758** — same two pre-existing failures,
+5 tests. Guard green.

### Before rollout

Wire `GET /reconciliation/segregation` to a daily job that alerts on
`ok === false`. It is inert until something reads it.

## C6b. Contract settled against the engine source ✅ DONE

[`21PAY-ANSWERS.md`](./21PAY-ANSWERS.md) answers all five question sections
from the engine source. Applied to the client:

- Status union extended to nine. `confirming` and `completed_via_topup` added.
- `CREDITABLE_INTENT_STATUSES` unchanged, now with the reasoning written down:
  `accepted` is a **tenant-configured soft threshold**, not finality, and
  `completed_via_topup` is parent-only signalling — crediting it pays twice,
  because the money arrives against the child.
- `Payout.status` widened to five; `broadcasting` is a real transient state and
  must never be auto-reversed.
- **`createPayout` and `getPayout` deleted.** `POST /v1/payouts` is
  operator-only and 403s a merchant token. Absent rather than stubbed, per the
  Stage 0 rule that a dead method on the money path is worse than a missing one.
- The contract-discrepancy warning replaced with what is actually true.

### What the answers changed in the plan

**Stage F rewritten from the premise up.** Merchants withdraw via
`/v1/withdrawals`, not `/v1/payouts`. 21Pay owns the wallet and enforces
whitelisting, a 24h destination cooldown, a velocity cap, an auto-approve limit
and maker-checker. **Decision 7 is closed as moot** — there is no key handle
for us to hold. Two things got harder rather than easier: `failed` does not
guarantee the money stayed put when a `tx_hash` is set, and withdrawals are not
in the webhook fan-out at all, so polling is load-bearing.

**Stage D** — the replay guard cannot key on a delivery id, because none is
sent; dedup on `(action, intent_id, tx_hash)` as the engine itself does. There
is also **no webhook replay**, contrary to their docs, so a lost delivery is
lost and the Stage C poller stops being a safety net.

**Stage E** — a `confirmed` deposit can be reversed by a chain reorg, with **no
webhook**, and the clawback may drive our balance at 21Pay negative. Nothing in
the settlement path can see this; only reconciliation can.

**Stage I** — reorg detection and a negative-payable alert are now correctness
requirements. Custody parity must model 21Pay's deposit fee and read
`GET /v1/ledger/balances`; the CSV truncates at 1000 rows and omits
`detected_amount`.

**Stage C** — validate `expires_at` ourselves (the engine does not), and set a
real minimum deposit (the engine has none). `POST /v1/payment-intents` is capped
at 30/min **per source IP**, shared with anything co-located.

### The finding with the largest blast radius is commercial, not technical

**21Pay deducts a per-tenant `fee_bps` from every confirmed deposit** at
ledger-post time. Our claim on them is `detected − fee` while the user's claim
on us stays `detected`. Crediting the detected amount remains correct; what
breaks is reconciliation, which would otherwise report a permanent shortfall on
every single deposit.

It also stacks on Oro's own platform fee and is charged on **gross inflow, not
GGR**. Recorded as decision 10. Blocking for the business case, not the code.

### Result

Full suite unchanged. Typecheck clean.

## C10. Deposit intents ✅ DONE

`crypto_payment_intents` + entity + `CryptoDepositService` + four routes.
Migration `1775990000370`.

**All nine engine statuses, verbatim**, with `CREDITING_STATUSES` and
`TERMINAL_STATUSES` derived from them. The entity documents that these are not
a one-way progression: a reorg takes `confirmed` back to `failed` and reverses
the credit, and AML can do the same after the fact — neither sends a webhook.

### The guards are the substance

In order, and **all of them run before anything reaches 21Pay**, because a
rejected request must not burn an HD derivation index:

1. Rail enabled
2. **KYC approved** — deposit is the gate, not withdrawal
3. **`users.currency === 'USDT'`** — the segregation boundary on the funding path
4. Network known *and* enabled
5. Amount valid, in range, and exactly representable at 6dp
6. Idempotency key present

**We enforce the deposit floor because 21Pay enforces none** (§5.5). A deposit
worth less than the gas to sweep it costs us money to accept.

**More than 6dp is rejected, never truncated.** A truncated expectation can
never equal the detected amount, so every such deposit would land as
`confirmed_partial` — a support ticket manufactured at validation time.

**`expiresAt` is validated our side**, because `POST /v1/payment-intents` does
not (§2.5). A past timestamp is accepted by the engine and expires on the next
tick, leaving the user an address they can never successfully pay.

An unrecognised status from 21Pay logs at `error` and is treated as
`awaiting_deposit` rather than being silently coerced — a status we do not know
is a contract change, not a data problem.

### Top-up is built now, not later

Underpayment will be common: exchange withdrawals sometimes deduct the network
fee from the amount sent, and users typing figures by hand get them wrong.
Without top-up every one of those is a support ticket and a stranded balance.

The child reuses the parent's derived address, so a user who already sent there
can simply send again. **The child carries the credit; the parent only ever
gets `completed_via_topup`**, which is signalling — crediting it pays twice.

### Two deliberate absences

**No `GET /usdt/balance`.** A USDT account's balance is just its balance. A
second balance route would imply an account can hold both currencies, which is
the model segregation replaces.

**Ownership failures and missing rows return the same 404**, so the route does
not confirm which intent ids are real.

### Rate limit

3/min on creation, well under the engine's **30/min per source IP** — a ceiling
shared with anything co-located behind the same egress address (§5.4).

### Result

Migration verified against Postgres 16: all nine enum values, 7 indexes, both
unique constraints, revert and re-apply clean, **0 objects at risk** from
synchronize.

Full suite **2 failed / 772 passed of 774** — same two pre-existing failures,
+16 tests. Guard green.

## C11. Webhook receiver ✅ DONE

`crypto_webhook_events` + entity + `CryptoWebhookService` +
`Pay21WebhookGuard` + `POST /api/payments/usdt/webhook`. Migration
`1775990000380`.

Records only. Crediting is C12, and keeping them apart is what lets this run
against real 21Pay traffic — accumulating replayable events — before any money
moves.

### The raw-body bug I nearly shipped

The plan said scope `bodyParser.json({ verify })` to the webhook route with
`app.use(path, ...)`. **That silently does nothing.** Nest installs its own JSON
parser during `create()`, and body-parser skips a request another parser has
already consumed, so a second parser registered afterwards never runs its
`verify` and `rawBody` stays `undefined`. Every legitimate delivery would then
have failed verification, with no error pointing at the cause.

Proved it against a bare Express app before fixing, rather than reasoning about
it:

```
second parser verify: MISSING
```

Fixed with `NestFactory.create(AppModule, { bodyParser: false })` and one parser
we control, retaining the buffer for the webhook path only — so no other route
pays the memory. Verified the fix the same way: raw bytes preserved on the
webhook path including insignificant whitespace, nothing retained elsewhere,
parsing unaffected.

### Dedup without a delivery id

21Pay sends **no delivery-id header of any kind** — their documented
`X-Request-Id` is the engine's inbound middleware, never an outbound header. So
the key is built from the payload: `(eventAction, pay21IntentId, txHash)`,
which is what the publisher's own JetStream idempotency key is derived from.

The unique index is **partial**, covering only rows that have both. An expiry
carries no `tx_hash` and must not collide with another keyless event. Verified
against Postgres: a duplicate `(confirmed, int-1, 0xabc)` is rejected, and two
keyless `expired` events both insert.

The service checks for a duplicate with a query rather than catching the
constraint violation, precisely because the index does not cover everything.

### Subject parsing

`X-T1Pay-Event` carries the **full NATS subject**
(`payment.tenants.<tid>.deposits.tron.confirmed`), not the short
`deposit.confirmed` in 21Pay's docs. Parsed as a subject: action is the last
segment, family the third from last.

We subscribe by wildcard and drop unhandled actions in the receiver, which is
more maintainable than enumerating 32 subjects. `unexpected` is handled — a
user re-sending to an expired intent's address lands exactly there, and it is
**not** credited to us, so it needs to reach support rather than be dropped.

### Why the 200 comes last

Synchronous processing, then the 200. Once we 200 the engine treats the
delivery as durably handed off, and after its backoff
(`30s / 2m / 10m / 1h / 6h / 24h`) it is terminally failed — with **no replay
endpoint**, contrary to their docs. A delivery we drop is gone, so a
synchronous 5xx is the only way to get a retry at all.

`@SkipThrottle()` for the same reason: an incident retry burst must not be
rate-limited into terminal failure.

### One rejection message for every failure

Missing raw body, stale timestamp, and forged signature all return
`Invalid signature`. The engine checks freshness before the HMAC, making stale
and forged indistinguishable to a caller; matching that means the route cannot
be used to probe which signatures are well-formed.

Also worth knowing, and now commented: each retry is signed with a **fresh**
timestamp, so a delivery arriving 24 hours after the event is still inside the
300-second window. The timestamp bounds the delivery, not the event.

### Result

Full suite **2 failed / 782 passed of 784** — same two pre-existing failures,
+10 tests. Guard green. Migration applied, dedup index verified by violating
it, revert clean.

## C12. Settlement and credit ✅ DONE

`CryptoSettlementService` + `CryptoIntentPoller`, wired into the webhook route.
**The deposit path is now complete end to end.**

One entry point, two callers. A status change must produce the same result
whichever way we learned of it.

### Crediting

Two rows per credit: a `payments` row keyed on the **intent id** — stable across
detected, confirmed, partial and top-up, where a tx hash is per transfer — whose
unique constraint gives exactly-once at the database layer, and a
`transactions` row in USDT with `balanceBefore`/`balanceAfter` from the USDT
ledger alone.

Two independent guards on the credit path: that constraint, and `creditedAt`.
Not redundant.

### Four things that must never credit, each with a test

- **`accepted`** — a tenant-configured soft threshold, not chain finality.
- **`completed_via_topup`** — parent-only signalling. The money arrived against
  a child that settles on its own; crediting here pays twice. This is the trap
  §2.3 flagged and the one most likely to have been got wrong.
- **A crediting status with no detected amount** — refuses rather than falling
  back to the expected amount. Crediting the expectation is how a ledger drifts
  from what is on chain.
- **A second delivery of the same event.**

An event for an intent we never created returns cleanly rather than throwing: a
5xx would burn 21Pay's whole backoff and terminally fail a delivery we can
never accept.

### Reversal, which nothing will tell us about

`reverse()` writes a compensating debit and clears `creditedAt`.

**No webhook exists for this.** The reorg subject is engine-wide and not in the
fan-out, and there is no `deposits.<net>.failed` publisher at all despite their
docs listing one. A credited deposit being taken back is discoverable only by
looking.

The reversal is **allowed to drive the user negative**, mirroring 21Pay's own
clawback against our tenant balance. The money is gone; pretending otherwise
would leave us funding it. A negative balance blocks staking and withdrawal,
which is the correct outcome and needs an ops path rather than a silent
write-off. Tested explicitly.

### The poller is not a fallback

The original plan called it one. It is the **only** recovery mechanism that
exists, because 21Pay has no webhook replay — a delivery dropped, or terminally
failed during an incident, is gone.

Three jobs:

| Job | Every | Why |
|---|---|---|
| `pollOpenIntents` | 1 min | Advance in-flight intents the webhook missed |
| `pollForReversals` | 5 min | Re-check credited deposits inside the reorg window. **The only way we learn of a reversal** |
| `sweepExpired` | 10 min | Mirror their expiry watcher — theirs wins if they later report a deposit |

Batched at 20 against a 30/min per-source-IP ceiling, and only touching rows the
webhook has already had 90 seconds at.

### On the fee

We credit the detected amount, because that is what the user is owed. Our claim
on 21Pay is `detected − fee`. The difference is reconciliation's problem, and
the code says so where it would otherwise look like a bug.

### Result

Full suite **2 failed / 796 passed of 798** — same two pre-existing failures,
+14 tests. Guard green.

## C13. Withdrawals ✅ DONE

`crypto_withdrawal_destinations` + `crypto_withdrawals` + client methods +
`CryptoWithdrawalService` + withdrawal polling + user and admin routes.
Migration `1775990000390`.

Built against `/v1/withdrawals`, not `/v1/payouts`. **No `key_handle`, no
`from_address`** — we never name a wallet.

### Why we still approve, when 21Pay already does

They enforce whitelisting, the 24h cooldown, a velocity cap, an auto-approve
limit and maker-checker. All of it protects the **tenant float**. None of it
knows which of our users is entitled to what. Their controls answer "may the
tenant move this much"; ours answers "whose money is this". Both are needed.

Maker-checker on our side too: a user who is also an admin cannot release their
own withdrawal.

### The failure path is the whole point

**`failed` does not mean the money stayed put.** Three paths reach it and only
two are safe. We cannot see which one occurred — but a `tx_hash` tells us a
broadcast happened:

| Signal | Action |
|---|---|
| `failed`, no `tx_hash` ever set | Restore. Never broadcast, or mined and reverted |
| `failed` **with** a `tx_hash` | `needsManualReview`, **no restore**, logged at `error` |

21Pay's own reaper refuses to auto-reverse a `broadcasting` row for exactly this
reason. Restoring blind pays the user twice — once on chain, once back into
their balance. Both branches are tested.

Only `completed` is treated as paid; `broadcasting` and `confirming` are
explicitly tested as *not* paid.

### Money handling

Debited at request, so the same balance cannot be requested twice while an
admin decides. Returned by a compensating credit, idempotent via
`restoreTransactionId`. **No `lockedBalance` column** — that would reintroduce
the stored-balance problem the derived ledger exists to avoid.

### The cooldown is explained, not just enforced

A destination in cooldown produces a message saying addresses are held for 24
hours and when it becomes usable — not a blank refusal. A winner who cannot be
paid needs to know why, or the product looks broken at exactly the moment it
matters most. **This is still a product problem, not a technical one**
(Stage F.2): either negotiate a tenant-specific cooldown, or prompt for an
address during onboarding so the clock has run out before anyone wins.

### Polling is the mechanism, not a safety net

Withdrawals are **not in the webhook fan-out at all**. Unlike deposits, where
polling is recovery, here it is the only way state ever reaches us. A stuck
poller is a user whose withdrawal silently never completes. Runs every minute,
skipping anything already terminal.

### Address safety

Validated locally per network before 21Pay sees it — their error is a worse
place to discover a malformed address than our own check. **The network is a
property of the stored destination**, never a choice at withdrawal time: all
three EVM chains share the `0x` format, so binding it to the record removes the
choice and therefore the unrecoverable mistake.

### Result

Full suite **2 failed / 813 passed of 815** — same two pre-existing failures,
+17 tests. Guard green. Migration applied, reverted, re-applied.

Synchronize check across all **27** objects this effort created: 26 untouched,
and `IDX_crypto_withdrawals_approval` dropped **and immediately recreated** —
churn, not loss. `DB_SYNCHRONIZE` remains unusable here for unrelated reasons
(~220 queries, 55 index drops).

### Still needed from 21Pay ops before this runs

- Our tenant's auto-approve limit, velocity cap and window.
- Whether the 24h destination cooldown is tunable.
- A forced-failure test on staging, **including a `broadcasting` failure** —
  the one path we deliberately cannot handle automatically.

## C13. Withdrawals

Largest unscoped piece: Oro has **no withdrawal approval step and no
locked-funds concept** today. Both are new. Blocked on decision 7.

Debit at request, compensating credit on failure — do not add a `lockedBalance`
column, which reintroduces the stored-balance problem C4 exists to remove.

**Test the `failed` path explicitly.** A payout that fails after the debit and
never restores is silent theft, and it is the failure mode least likely to be
reported.

## C14. Clients

**C14a first, alone:** remove the TON placeholder — the `ton` method at
[`payment.controller.ts:351`](../../src/payment/payment.controller.ts#L351), the
selector entry, the `TonConnectUIProvider`, and the `@tonconnect/ui-react`
dependency. It advertises `enabled: true` today with no rail behind it. Shipping
it separately means there is never a build showing two crypto options where one
is a decoy. Also drops 835 KiB.

Market card shows both books, **never summed**:

```
Will Bhutan beat Nepal?
20,000 BTN  |  $420
```

Inside the market the viewer sees their own book only. Do not render the other
book's odds — from their point of view those are a different market's odds.

`oro-pwa/shared/` and `oro-tma/shared/` are **divergent copies, not a symlink.**
The currency-formatter signature change must be mirrored into the TMA with
`'BTN'` at every call site.

## C15. Rollout

Gates, reconciliation, monitoring, and the staged flag flip in
[`STAGE-I-ROLLOUT.md`](./STAGE-I-ROLLOUT.md).

**Step 8 is the one that gets skipped:** hold until the first USDT book actually
resolves and pays out before widening.

---

## Decisions that block work

| # | Decision | Blocks | Owner |
|---|---|---|---|
| — | 21Pay contract: webhook header names, status count, auth scheme | **C6, C10** | Engineering, ask 21Pay |
| 1 | Promotional money on USDT — recommend none at launch | B′, before C9b | Product |
| 2a | Which markets get a USDT book — recommend explicit toggle | C7, C14 | Product |
| 2b | Per-book `houseEdgePct` launch numbers | C7 | Business |
| 2c | Divergent refunds acceptable + copy | C9b | Product |
| 7 | Payout custody — who holds `key_handle` | **C13** | 21Pay ops |
| 8 | Tenant UUID + xpubs per chain | C10 | 21Pay ops |
| 4, 5, 6, 9 | Jurisdiction, KYC SLA, document retention, AML quarantine | **C15** | Compliance |

C2 through C5 are blocked by nothing. Continue there.
