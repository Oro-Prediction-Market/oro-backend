# Stage 0: Recover the Reverted USDT Work

**Touches BTN:** No, if done as specified.
**User-visible:** No.
**Depends on:** Nothing. Do this first.

## Goal

A previous attempt at the USDT rail was built, tested, and then reverted out of
`main`. It is not lost — it is commit `93ee897` on branch
`safety/pre-uncommit`. Roughly 1,200 lines of it are directly reusable and
already have tests.

This stage recovers what is good, discards what encodes the abandoned FX model,
and resolves the migration-numbering collision that reverting created. It is
short, and doing it first means Stages A through E start from working code
rather than a blank file.

## 0.1 What is actually on `main` today

Nothing. Confirm before starting:

- [`src/payment/services/twentyone-pay/`](../../src/payment/services/twentyone-pay/) exists and is **empty**
- `transactions` has no `currency` column
- `payments.method` enum is `dkbank | ton | credits` — no USDT value
- [`main.ts`](../../src/main.ts) has no `rawBody`
- No `usdt-payment.service.ts`, no `usdt.util.ts`

**`docs/USDT_PAYMENT_INTEGRATION.md` states that phase 1 is "implemented and
tested".** Relative to `main`, that is false. It describes `93ee897`. Retire or
rewrite that document as part of this stage rather than leaving two plans
disagreeing about what exists.

## 0.2 The migration collision

`93ee897` added:

| File | Status |
|---|---|
| `1775990000200-AddUsdtTrc20Rail.ts` | **Collides.** `main` now uses `1775990000200` for `AddDisputeSideAndBondAmount` |
| `1775990000210-RenameUsdtLedgerIndex.ts` | Free, but exists only to fix an index name in the first one |

Do not cherry-pick these. Renumber above `main`'s current maximum
(`1775990000320-CreateUserNotifications`), and **fold the two into one** — the
rename migration exists only because the original shipped a name it then
regretted. Write it once with the final name.

Per the standing operational constraint, this migration will need hand-applied
SQL and a `migrations` row in production. It is additive and backfilled, so it
is safe to apply ahead of any code that reads the column.

## 0.3 Salvage: take as-is

These three files carry the counterparty contract and the money-parsing
primitives. They are the expensive part to get right and they already have
tests.

| File | Lines | Why it survives |
|---|---|---|
| `payment/services/twentyone-pay/twentyone-pay.client.ts` | 234 | 21Pay HTTP client. `IntentStatus`, `PaymentIntent`, `Payout`, a shared `request<T>` with error mapping, and `verifyWebhook` |
| `payment/usdt.util.ts` | 77 | `USDT_DECIMALS`, `toBaseUnits`, `fromBaseUnits`, `isValidTronAddress` (real base58check, not a regex) |
| `__tests__/usdt.util.spec.ts` | 175 | Base-unit round-trips, TRON address vectors, **and 8 webhook-HMAC tests** |

There is **no** `twentyone-pay.client.spec.ts`, despite what
`USDT_PAYMENT_INTEGRATION.md` claims. The webhook verification tests live
inside `usdt.util.spec.ts`: correct signature, tampered body, wrong secret,
replay window, short signature, non-hex and missing headers, absent raw body,
unconfigured secret.

**One case is missing and must be added: re-serialisation.** A body that has
been parsed and re-stringified must fail verification, because that is what
proves the route is receiving real raw bytes rather than a middleware
round trip. It is the most likely way a webhook receiver silently breaks —
see [Stage D.2](./STAGE-D-WEBHOOK.md).

`isValidTronAddress` covers Tron only. Stage A adds EVM validation beside it.

## 0.4 Salvage: take the idea, rewrite the code

**`__tests__/ledger-currency-guard.spec.ts` (72 lines).** The single most
valuable file in the commit. It is a source scan asserting that every
`SUM(amount)` over `transactions` is currency-scoped, with a documented rationale:

> Balances are derived (`SUM(amount)` per user), so an unfiltered sum folds
> USDT rows into the BTN book — a crypto deposit becomes spendable ngultrum and
> withdrawable through DK Bank. That is a mint-money bug, not a display bug, and
> it is invisible until the first USDT row exists.

Take it, but harden it. As written it carries a `SKIP_FILES` allowlist
containing `usdt-payment.service.ts`, and an alias blocklist distinguishing
`positions.amount` from `transactions.amount` by variable name. Both are
fragile: a new file with an unfiltered sum passes if someone adds it to the
allowlist, and alias-based discrimination breaks the first time a query uses a
different alias. Tighten before relying on it, and treat every entry in either
list as something that needs a comment justifying it.

This test is what makes [Stage B](./STAGE-B-LEDGER-SEGREGATION.md) permanent
rather than a point-in-time audit. Land it in Stage 0 — **failing** — so the
Stage B work has a green-light condition.

**`main.ts` raw body.** The commit used
`NestFactory.create(AppModule, { rawBody: true })`, which is global. Stage D
scopes it to the webhook route instead; see D.2 for why.

## 0.5 Discard

| File | Why |
|---|---|
| `docs/TON_WALLET_INTEGRATION.md` (383 lines) | TON is dropped. Delete rather than leave a third plan in the tree |
| `payment/usdt-payment.service.ts` (523 lines) | Read it, then rewrite. See below |
| `1775990000210-RenameUsdtLedgerIndex.ts` | Folded into the single renumbered migration |

**On `usdt-payment.service.ts`:** it is good code for the wrong model. It
implements a single-account-two-rails design — `assertRailAllowed`,
`getUsdtBalance(userId)` as a second balance on the same account, resident
gating on the rail — with FX-funded betting deferred to a "phase 2". That is
the design segregation replaces. Under this plan an account *is* USDT or *is*
BTN, so a `getUsdtBalance` alongside a BTN balance is a category error.

Its individual pieces are still instructive: `createDeposit`, `syncIntent`,
`applyIntentUpdate`, `handleWebhook`, and `withdraw` map almost one-to-one onto
Stages C, D, E, and F. Read it before writing those stages. Do not import it.

Same for the five routes it added to
[`payment.controller.ts`](../../src/payment/payment.controller.ts)
(`usdt/deposit`, `usdt/balance`, `usdt/intents/:id`, `usdt/withdraw`,
`usdt/webhook`). The shapes are close to right; `usdt/balance` disappears
entirely, because a USDT account's balance is just its balance.

## 0.6 Also in the commit, unrelated

`93ee897` bundles a BhutanApp token self-refresh change and a `yarn.lock`
rewrite of 2,493 lines. **Neither is part of this plan.** The BhutanApp change
may since have landed on `main` by another route — check before carrying it.
Do not let a lockfile rewrite ride along with a money-path migration.

## Deliverable

One commit containing:

- `twentyone-pay.client.ts` and `usdt.util.ts` restored under `src/payment/`,
  the client registered in `PaymentModule`
- `usdt.util.spec.ts` passing, **plus a new re-serialisation test**
- `ledger-currency-guard.spec.ts`, hardened, and **failing** — 48 offenders
- one renumbered migration: `transactions.currency` (backfilled `'BTN'`,
  `NOT NULL`, default `'BTN'`), the `(userId, currency)` index **declared on
  the entity as well**, and a new `payments.method` enum value

**Name the enum value `usdt`, not `usdt_trc20`.** The salvaged migration used
the latter, which bakes one chain into a payment-method name at a point where
four chains are planned. Postgres cannot remove an enum value once added, so
this is worth getting right in the only commit where it is still free. The
network belongs on the intent row, not in the method name.
- `transactions.currency` on the entity, with the `BTN_CURRENCY` constant
- `docs/USDT_PAYMENT_INTEGRATION.md` retired

Nothing calls any of it. `payments.currency` already exists and already defaults
to `'BTN'`, so nothing changes for DK Bank.

## Verification

- `npm test` — the two salvaged suites pass; the guard suite fails with a list
  of exactly the offending sites. That list is Stage B's worklist.
- `npx tsc --noEmit` clean.
- Migration applies and reverts on a scratch DB. Note that Postgres cannot
  remove an enum value, so `down()` leaves `usdt_trc20` behind. That is correct
  and should be commented, not worked around.
- `SUM(amount)` over `transactions` identical before and after the migration.
- Boot once with `DB_SYNCHRONIZE=true` on a scratch DB and confirm the new
  index survives. This is the check that catches an entity/migration mismatch.

## Rollback

Revert the commit and the migration. Nothing references any of it.
</content>
