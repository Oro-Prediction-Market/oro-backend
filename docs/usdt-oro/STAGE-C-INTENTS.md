# Stage C: Deposit Intents and Top-Up

**Touches BTN:** No. New table, new endpoints, flag-gated.
**User-visible:** No.
**Depends on:** Stage A. Parallel with Stage D.

## Goal

A local record of every 21Pay payment intent, so settlement has something to
attach to, the client has something to poll, and reconciliation has a local
counter-ledger. 21Pay owns chain truth; Oro owns the mapping from an intent to
a user.

## C.1 Two tables, not one

The salvaged implementation stored intents as `payments` rows. That is
attractive — `payments` already has `externalPaymentId UNIQUE`, `currency`,
`metadata jsonb`, and every existing report knows about it — but
`PaymentStatus` has five values and 21Pay's intent lifecycle has nine, three of
which (`confirmed_partial`, `confirmed_overpaid`, `expired`) each drive a
different user-facing outcome in Stage E.

Collapsing nine into five is a lossy mapping that has to be undone later.

**Keep both.** The `payments` row stays the canonical money record, symmetric
with DK Bank and visible to existing reporting. A new table carries the
21Pay-specific lifecycle:

**`crypto_payment_intents`**

```
id                  uuid, pk
userId              varchar(36), indexed
paymentId           uuid, FK payments.id, nullable until credited
pay21IntentId       varchar(64), UNIQUE
network             enum CryptoNetwork
depositAddress      varchar(128), indexed
derivationIndex     int
amountUsdt          numeric(28,9)          expected
detectedAmountUsdt  numeric(28,9), null    from webhook or poll
status              enum CryptoIntentStatus   all nine, verbatim
parentIntentId      varchar(64), null      top-up children
transactionId       uuid, null             set once credited
creditedAt          timestamptz, null
idempotencyKey      varchar(128), UNIQUE
expiresAt           timestamptz
txHash              varchar(128), null
blockNumber         bigint, null
failureReason       varchar(255), null
metadata            jsonb, null
createdAt / updatedAt
```

Indexes: `(userId, status)` for the pending list, `(status, expiresAt)` for the
expiry sweeper, unique on `pay21IntentId` and `idempotencyKey`. **Declare all of
them on the entity** — `DB_SYNCHRONIZE` drops what it does not know about.

`CryptoIntentStatus` mirrors 21Pay's nine states verbatim. The salvaged client
already exports `IntentStatus` and `CREDITABLE_INTENT_STATUSES`; reuse them
rather than defining a parallel enum.

**No FX fields.** No rate, no lock, no spread. If a future change adds one, it
is a different product.

## C.2 Create-intent

Guards, in order. Each is cheap and each closes a real hole:

1. `USDT_ENABLED` is true.
2. **KYC is `APPROVED`.** Deposit is the KYC gate (Stage G). Rejecting here
   means a rejected applicant never funded an account and nothing is in limbo.
3. **`users.currency === 'USDT'`.** A BTN account has no business creating a
   crypto intent, and this is the segregation boundary on the deposit path.
4. Amount within `USDT_MIN_DEPOSIT` / `USDT_MAX_DEPOSIT` (already in
   `.env.example`). **21Pay enforces no minimum or maximum of its own** (§5.5),
   so ours is the only floor. Set it above dust per chain: a deposit worth less
   than the gas to sweep it costs us money to accept.
5. Daily deposit limit. Oro has no responsible-gaming deposit cap today — if
   one is wanted for USDT it is new work, and it should be raised now rather
   than discovered at Stage I.
6. Network is in `TWENTYONE_PAY_NETWORKS`. Reject anything else locally rather
   than passing it to 21Pay.

Then:

7. `idempotencyKey = intent:{userId}:{clientRequestId}`, where the client
   supplies a UUID generated once per deposit attempt, so a retry replays
   rather than double-creating.
8. `expiresAt = now + TWENTYONE_PAY_INTENT_TTL_MINUTES`. **Validate it is in
   the future before sending.** `POST /v1/payment-intents` does not check, so a
   past timestamp is accepted and then expires on the next tick — a deposit
   address the user can never successfully pay (§2.5).
9. `client.createIntent(...)`.
10. Persist the local row from the response.

**Amount rounding.** Round to 6dp before `toBaseUnits`. Reject a value that
cannot be represented exactly at 6dp rather than truncating — a truncated
expectation never equals the detected amount, so every such deposit would land
as `confirmed_partial` and generate a support ticket.

**Ordering.** Write the local row only after a successful `createIntent`. The
idempotency key makes a retry safe; an orphan local row is harder to clean up
than a retried call.

## C.3 Endpoints

On [`payment.controller.ts`](../../src/payment/payment.controller.ts),
alongside the existing `dkbank/*` routes:

```
POST /payments/usdt/deposit-intent
GET  /payments/usdt/deposit-intent/:id
GET  /payments/usdt/deposit-intents
POST /payments/usdt/deposit-intent/:id/topup
```

The salvaged code had a `GET /payments/usdt/balance`. **It does not survive.**
Under segregation a USDT account's balance is just its balance, served by the
existing balance endpoint; a second balance route implies a second balance on
the same account, which is the model this plan replaces.

All authenticated, all behind `USDT_ENABLED`. Rate-limit list and status
normally; **rate-limit creation hard**.

Two reasons, and the second is new: each call burns an HD derivation index on
21Pay's side, and **`POST /v1/payment-intents` is capped at 30/min per source
IP** (§5.4). That ceiling is shared with any platform co-located behind the
same egress address, so our own limit has to keep us comfortably under it or
one busy minute starves every deposit on the box. Worth asking 21Pay for a
tenant-keyed limit instead.

Response shape:

```
{ intentId, network, depositAddress, amountUsdt, amountBaseUnits,
  status, expiresAt, txHash?, explorerUrl? }
```

`explorerUrl` is built server-side from network plus `txHash`, so no client
maintains a per-chain URL table.

## C.4 Top-up

`POST /v1/payment-intents/{id}/topup` creates a child intent reusing the
parent's deposit address and derivation index, with the remainder computed by
21Pay. Parent must be `confirmed_partial`, or `expired` with a non-zero
remaining balance.

**Build it now, not later.** Underpayment will be common: exchange withdrawals
sometimes deduct the network fee from the sent amount, and users typing amounts
by hand get them wrong. Without top-up, every underpayment is a support ticket
and a stranded balance.

The child settles through the same handler with its own credit, independent of
the parent.

## C.5 Polling as a fallback

A scheduled job in [`src/jobs/`](../../src/jobs/) reconciling non-terminal
intents against 21Pay. **Fallback, not primary** — webhooks (Stage D) are
primary. The salvaged `syncIntent` is the right shape for this.

- Every 60 seconds, select intents in `awaiting_deposit`, `confirming`, or
  `accepted` whose `updatedAt` is older than 90 seconds.
- Batch conservatively and honour `Retry-After`. The intents endpoint is
  rate-limited per source IP.
- Feed every status change through the **same settlement service** Stage D
  uses. One code path, two triggers.

## C.6 Expiry sweeper

Intents past `expiresAt` still in `awaiting_deposit` move to `expired` locally.
21Pay runs its own expiry watcher, so treat ours as a mirror rather than the
authority: **if 21Pay later reports a deposit against an intent we marked
expired, 21Pay wins.** That is exactly what `confirmed_partial` on an expired
parent plus `/topup` exists for.

## C.7 Minimum stake

`placePosition` enforces a minimum stake in ngultrum — Nu 10 on TER markets,
Nu 50 elsewhere, as bare constants. A USDT book needs its own `minStake`, and
**it is a chosen number, not a conversion**, because no rate exists.

Not strictly this stage's work, but it is the same class of decision as the
deposit limits and should be made once, here, rather than twice.

## Verification

- Unit: each guard rejects — flag off, KYC not approved, BTN account, amount
  out of range, disabled network, un-representable 6dp amount.
- Unit: idempotency replay returns the existing row rather than creating a
  second.
- Integration: create against a stubbed 21Pay; assert the local row matches the
  response field for field, and that the unique constraint rejects a duplicate.
- Migration applies and reverts; indexes survive a `DB_SYNCHRONIZE=true` boot.
- **BTN regression gate.** New table and routes only.

## Rollback

Drop the table, revert. No shared code touched beyond the controller, and every
route is behind the flag.
</content>
