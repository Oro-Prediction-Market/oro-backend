# Stage F: USDT Withdrawals

**Touches BTN:** Ledger tables only, `currency = 'USDT'` rows.
**User-visible:** No until Stage I.
**Depends on:** Stage E.
**Launch scope. Not deferrable.**

> **Rewritten 2026-08-19.** The original version of this stage was written
> against `POST /v1/payouts` with `from_address` and `key_handle`, and was
> wrong from the first line. That route is operator-only and 403s a merchant
> token. See [`21PAY-ANSWERS.md`](./21PAY-ANSWERS.md) §4.
>
> **Master-plan decision 7 (payout custody, who holds `key_handle`) is closed
> as moot.** We are never meant to name a wallet, so there is no key to hold.

## Why this is launch scope

USDT users have no bank rail. Deposit without withdrawal means a user who wins
holds a balance they cannot extract — trapped funds, which is a consumer-harm
problem before it is an engineering one.

E, F, G and H go live together or not at all.

## F.1 The actual contract

```
POST /v1/withdrawal-destinations   { network, address, label }
GET  /v1/withdrawal-destinations
POST /v1/withdrawals               { idempotency_key, destination_id, amount, currency }
GET  /v1/withdrawals   /   GET /v1/withdrawals/{id}
POST /v1/withdrawals/{id}/cancel
```

**Most of what the old plan told us to build, 21Pay already enforces.** That is
the good news in this rewrite, and the work now is mostly *not* duplicating it:

| Control | Enforced by |
|---|---|
| Destination whitelisting, address format per network | 21Pay |
| 24h cooldown before a new destination can be used | 21Pay |
| Per-tenant velocity cap over a trailing 24h window | 21Pay |
| Per-tenant auto-approve limit, above which it waits for an admin | 21Pay |
| Maker-checker — a requester cannot approve their own | 21Pay |
| Balance checked and debited atomically with the send | 21Pay |

We still need our own approval step, because 21Pay's operates on the **tenant's**
aggregate balance and knows nothing about which of our users is entitled to
what. Their controls protect the tenant float; ours decide whose money it is.

## F.2 The 24h cooldown is a product problem, not a technical one

A destination sits in `cooldown` for 24 hours before its first use.

**A winner's first withdrawal cannot be paid for 24 hours after they add an
address.** That is not something to discover in production. Either negotiate a
tenant-specific cooldown with 21Pay ops, or design it into the flow — prompt
for a withdrawal address during onboarding, long before the user needs it, so
the clock has run out by the time they win.

Recommendation: do both. Ask, and design as if the answer is no.

## F.3 Nine states, and only one means paid

```
requested  pending_approval  approved  broadcasting
confirming  completed  rejected  failed  cancelled
```

Terminal: `completed`, `rejected`, `failed`, `cancelled`.

**Only `completed` means the user has been paid.** The original plan's rule —
do not release on `broadcast` — carries over unchanged and is still right.

## F.4 `failed` does not mean the money stayed put

The single most dangerous assumption in the original stage. Three paths reach
`failed` and they are **not** equivalent:

| Path | Did USDT move? | Our action |
|---|---|---|
| `pending → failed` | Never broadcast. No. | Restore the user's balance |
| `broadcast → failed` | Mined and reverted. No. | Restore the user's balance |
| `broadcasting → failed` | **Unknown — the broadcast may have landed** | Manual review. Never auto-restore |
| reorg orphan of `confirmed` | **Unknown — the tx may be re-mined** | Manual review. Never auto-restore |

21Pay's own reaper refuses to auto-reverse a `broadcasting` row for exactly
this reason.

**Rule: restore automatically only when no `tx_hash` was ever set.** When one
is present, hold the withdrawal in a manual-review state and reconcile against
`GET /v1/ledger/balances` before crediting anybody back.

Getting this wrong pays the user twice: once on chain, once back into their
balance.

## F.5 Withdrawals do not arrive by webhook

The webhook consumer binds deposits, payouts and freeze subjects only. **The
`withdrawals.*` family is not in the fan-out.**

So the Stage D receiver does not help here. Withdrawal state must be polled
(`GET /v1/withdrawals/{id}`) or taken from a realtime connection. Polling is
the smaller dependency and the one to build first.

That makes the poller load-bearing rather than a safety net — a stuck poller is
a user whose withdrawal never completes.

## F.6 What we build

**`crypto_withdrawals`**, keyed on the 21Pay withdrawal id, with our own
approval state alongside theirs. Ledger idempotency key
`crypto-withdrawal:{id}`.

**Destinations** mirror `linked_bank_accounts`: a local record joined to the
21Pay `destination_id`, carrying the network as a **property of the record**
rather than a choice at withdrawal time. All three EVM chains share the `0x`
format, so binding the network to the address is the only thing preventing an
unrecoverable wrong-chain send. Surface the cooldown state so the UI can
explain the wait rather than appear broken.

**Flow:**

```
1. User picks a whitelisted, active destination and an amount
2. We debit the USDT ledger and record the withdrawal as pending our approval
3. Our admin approves — whose money it is
4. POST /v1/withdrawals
5. Poll until terminal
6. completed → done. failed with no tx_hash → restore. Otherwise → review.
```

Debit at request with a compensating credit on restore, as in C4 — **no
`lockedBalance` column**, which would reintroduce the stored-balance problem
the whole ledger design avoids.

## F.7 Alerting

- Withdrawals in `broadcasting` or manual review, aged past an SLA.
- Our approval queue depth and oldest item.
- Any negative `tenant.payable` balance at 21Pay, which a reorg clawback can
  cause (§2.4) and which blocks all further withdrawal until a later deposit
  restores it.

## Verification

- Unit: happy path — request, debit, approve, submit, poll to `completed`.
- Unit: `failed` with **no** `tx_hash` restores the exact balance.
- Unit: `failed` **with** a `tx_hash` does **not** restore, and raises review.
- Unit: `broadcasting` never auto-reverses.
- Unit: only `completed` is treated as paid; `broadcast` and `confirming` are not.
- Unit: a destination in `cooldown` is refused with an explanation, not an error.
- Unit: duplicate poll results settle once.
- Unit: a BTN account cannot reach the USDT withdrawal path at all.
- Unit: a USDT withdrawal cannot be routed through DK Bank, and the reverse.
- Integration: full path against a stubbed 21Pay, asserting both ledger rows.
- **BTN regression gate** with USDT deposit and withdrawal rows present.

## Rollback

`USDT_ENABLED=false` closes the path. **Do not flip the flag with withdrawals
in flight** — the debit stands with no poller to complete or reverse it. Drain
first, then disable.

## Still needed from 21Pay ops

- Our tenant's auto-approve limit, velocity cap and window.
- Whether the 24h destination cooldown is tunable per tenant (F.2).
- A scheduled forced-failure test on staging, including a `broadcasting`
  failure, which is the path we cannot safely handle blind.
