# Stage B′: Promotional Money on the USDT Rail

**Touches BTN:** **Yes.** Bonus accounting is live money code.
**User-visible:** No.
**Depends on:** Stage B, master-plan decision 1.

## Why this stage exists

The source plan has no equivalent. LuckyPemX has no bonus system, so it never
had to answer what a second currency does to promotional money. Oro does, and
the answer touches the ledger, so it cannot be deferred past Stage E.

## B′.1 What promotional money is in Oro

Six ledger types plus two scalar counters, all BTN, all writing to the same
`transactions` table the real money uses.

| Mechanism | Ledger type | Notes |
|---|---|---|
| Free credits | `FREE_CREDIT` | `isBonus = true`. The only type that sets it |
| Streak bonus | `STREAK_BONUS` | Booked at settlement, [engine:1386](../../src/markets/parimutuel.engine.ts#L1386) |
| Referral bonus | `REFERRAL_BONUS` | A cut of the referee's stake, [engine:519](../../src/markets/parimutuel.engine.ts#L519) |
| Referral prize | `REFERRAL_PRIZE` | |
| Season prize | `SEASON_PRIZE` | Fixed amounts: 700 / 500 / 350, [season.service.ts:16](../../src/users/season.service.ts#L16) |
| Duel wager / payout | `DUEL_WAGER`, `DUEL_PAYOUT` | Challenges |

Two scalar columns on `users`, both `numeric(18,2)`, **neither carrying a
currency**:

- `bonusBalance` — free-credit money still in play
- `bonusRealPayoutRemaining` — how much real money is still extractable from
  bonus-funded wins; resets to 50 on each grant, decremented as bonus bets pay
  out, and once zero all bonus wins become play credits only

Plus `positions.isBonusFunded`, which drives that logic at settlement.

**This accounting already has known weaknesses.** `bonusBalance` has drifted
from the ledger before, and `SEASON_PRIZE` / `REFERRAL_*` credits are
`isBonus = false` and so fall outside the bonus-issued totals the admin
dashboard computes at [admin.controller.ts:307](../../src/admin/admin.controller.ts#L307).
Duplicate `FREE_CREDIT` rows have needed a dedicated repair script
([reconcile-duplicate-payouts.ts](../../src/reconcile-duplicate-payouts.ts)).

That history is the strongest argument in this document. Whatever is decided,
**do not duplicate this machinery into a second currency.**

## B′.2 The decision

Master-plan decision 1. Three coherent answers.

### Option 1 — No promotional money on USDT (recommended)

USDT accounts receive no free credits, streak bonuses, referral rewards, or
season prizes. Promotional money is a BTN-market-growth instrument and stays
one.

- Cost: nothing to build. `users.bonusBalance` and `bonusRealPayoutRemaining`
  stay BTN-only and stay `numeric(18,2)`. Every grant path gets one guard.
- Consequence: USDT users have a plainer product — no streak multiplier, no
  referral earnings. Worth being explicit about, because streaks and referrals
  are retention mechanics and the USDT cohort is the one being acquired from
  zero.
- This is the only option that adds no new money math to a system whose
  existing bonus math has already needed repair.

### Option 2 — Promotional money in USDT, mirrored

Every mechanism duplicated per currency: `bonusBalanceBtn` / `bonusBalanceUsdt`,
or a `user_bonus_balances` table keyed `(userId, currency)`.

- Cost: the largest in the plan outside Stage B. Every bonus branch at
  settlement doubles, and the Nu 50 cap needs a USDT equivalent that is a
  business decision, not a conversion.
- **There is no exchange rate in this system**, so "Nu 50" cannot become "$0.60".
  A USDT cap is a separate number someone must choose and own.
- Only worth it if promotional spend on the USDT cohort is a committed
  acquisition strategy with a budget attached.

### Option 3 — Referral and streak only, no free credits

Split: recognition mechanics (streak multiplier, referral cut) work in USDT
because they are funded from the user's own winnings and the referee's own
stake; platform-funded grants (`FREE_CREDIT`, `SEASON_PRIZE`) do not.

- Cost: middling. Streak and referral need currency threading; the
  `bonusBalance` / `bonusRealPayoutRemaining` machinery — the fragile part —
  is untouched, because it only governs free-credit-funded bets.
- Defensible product answer: USDT users can earn from their own activity but
  the platform does not gift them money.

**Recommendation: Option 1 at launch, Option 3 as the planned follow-up** once
there is a USDT cohort worth retaining. Option 1 is reversible; Option 2 is not,
because once bonus money exists in a currency it cannot be withdrawn without
taking money back from users.

## B′.3 Implementation under Option 1

Every grant path guards on `users.currency === 'BTN'`:

| Path | Guard location |
|---|---|
| Free credit grant | wherever `FREE_CREDIT` is issued (see the commented-out sites in `auth.service.ts:763`, `onboard.service.ts:290` — confirm which are live) |
| Streak bonus | [`parimutuel.engine.ts:1373`](../../src/markets/parimutuel.engine.ts#L1373), before the `STREAK_BONUS` row |
| Referral bonus | [`parimutuel.engine.ts:519`](../../src/markets/parimutuel.engine.ts#L519) |
| Season prize | [`season.service.ts:276`](../../src/users/season.service.ts#L276) |
| Duel wager | `challenges/challenges.service.ts` |

**Skip silently, do not throw.** These run inside settlement transactions and
scheduled jobs; an exception on a promotional side-effect must never roll back
a real payout. Log at `debug` and move on.

`positions.isBonusFunded` is always `false` in a USDT book, which falls out
of the guard for free — no bonus money exists to fund one. Assert it in a test
anyway; it is the kind of invariant that holds by accident until it does not.

Leaderboards and season standings need a decision of their own: does a USDT
account appear in the same leaderboard as BTN accounts? It ranks by activity,
not money, so combining is defensible — but if any leaderboard sorts by an
amount, it is summing across currencies and
[`SEGREGATION-MODEL.md` §8](./SEGREGATION-MODEL.md#8-reporting) forbids it.
Check before assuming.

## B′.4 Do not fix the existing bonus drift here

`bonusBalance` desync and the `isBonus = false` reporting gap are real, but they
are BTN bugs that predate this work. Fixing them inside a currency migration
means any number that moves afterwards has two possible causes, and the BTN
regression gate stops being able to tell you anything.

Separate commit, separate review, either before Stage B or after Stage I.

## Verification

- Unit: a USDT account receives no `FREE_CREDIT`, `STREAK_BONUS`,
  `REFERRAL_BONUS`, or `SEASON_PRIZE` row on any path that would grant one to a
  BTN account in the same situation.
- Unit: a BTN account's grants are byte-identical to today — same amount, same
  type, same `isBonus`, same `bonusBalance` delta.
- Unit: settling a USDT book produces zero bonus-related rows and does not
  touch `users.bonusBalance`.
- Unit: a promotional guard that skips does not roll back the surrounding
  settlement transaction.
- Unit: `positions.isBonusFunded` is never `true` in a USDT book.
- **BTN regression gate.** Bonus totals on the admin dashboard must not move.

## Rollback

Guards only. Revert the commit and promotional grants resume their current
behaviour, which is correct while no USDT account exists.
</content>
