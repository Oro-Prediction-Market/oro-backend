# Stage E: Settlement and USDT Credit

**Touches BTN:** Ledger tables only, and only with `currency = 'USDT'` rows.
**User-visible:** No. Flag still off.
**Depends on:** Stages B, C, D.

## Goal

Turn a verified 21Pay event into a USDT ledger credit, exactly once, with
correct handling of the non-happy terminal states.

**No conversion.** USDT in, USDT credited. Under the abandoned FX design this
was the most complex stage in the plan; under segregation it is close to
trivial. That is the whole benefit.

## E.1 One service, two triggers

`src/payment/services/crypto-settlement.service.ts`. Called by the webhook
controller (Stage D) and by the polling job (Stage C). One entry point:

```ts
settle(pay21IntentId, status, detectedAmount, meta): Promise<void>
```

The salvaged `applyIntentUpdate` is the right shape and the right transaction
boundary. Read it before writing this.

All inside one DB transaction:

1. Load the intent `FOR UPDATE`. **Missing means an event for an intent we never
   created**: log at `error`, mark the webhook event processed with an error,
   return. Do *not* 5xx — retrying will not conjure the row.
2. If `creditedAt` is set, return. Idempotent no-op.
3. Branch on status (E.2).
4. On a crediting status, write the ledger row.
5. Update the intent: `status`, `detectedAmountUsdt`, `txHash`, `blockNumber`,
   `transactionId`, `paymentId`, `creditedAt`.
6. Stamp `processedAt` on the webhook event row.

## E.2 Status handling

| 21Pay status | Action |
|---|---|
| `awaiting_deposit` | Update local status. No credit. |
| `confirming` | Update local status. No credit. Drives the client's wait state. |
| `accepted` | A **tenant-configured soft threshold**, not chain finality. Do not credit; record and wait for `confirmed`. Crediting here trades reorg risk for a few seconds of UX. |
| `confirmed` | Credit. Happy path. |
| `confirmed_partial` | Underpaid. Credit the **detected** amount, mark partial, expose top-up. |
| `confirmed_overpaid` | Overpaid. Credit the **detected** amount. Flag for ops. Overpayment is real money received and must not be silently pocketed. |
| `completed_via_topup` | **Never credit.** Signalling only, set on the *parent* once a child top-up settles. The money arrives against the child, so crediting here pays twice. Credit children, always (§2.3). |
| `failed` | AML or chain failure. Mark failed with reason. **Never credit.** AML quarantine lands here — decision 9. |
| `expired` | No deposit arrived in time. Mark expired. No credit. A later arrival surfaces through 21Pay's unexpected-deposit handling. |

**Always credit the detected amount, never the expected amount.** The
expectation is what we asked for; the detected amount is what arrived on chain.

**But note what we are owed is not what we receive.** 21Pay deducts a per-tenant
`fee_bps` from every confirmed deposit at ledger-post time, so our claim on them
is `detected − fee` while the user's claim on us is `detected`. Crediting the
detected amount stays right; reconciliation has to model the fee or it reports a
permanent shortfall on every deposit (§6).

### A credited deposit can be taken back

`confirmed` is not final. A chain reorg reverts the credit and flips the intent
to `failed`, and **no webhook is sent when that happens** — the reorg subject is
not in the fan-out. The reversal is allowed to drive our balance at 21Pay
negative if we already paid the user out.

Nothing in the settlement path can catch this. Only the Stage I reconciliation
can, by re-polling anything credited inside the reorg window. That makes it a
correctness requirement rather than a monitoring nicety (§2.4).

The salvaged client already exports `CREDITABLE_INTENT_STATUSES`. Use it rather
than a second list that can disagree with the first.

## E.3 Writing the credit

Two rows, one transaction:

**`payments`** — `method = 'usdt'`, `currency = 'USDT'`, `type = DEPOSIT`,
`status = SUCCESS`, `externalPaymentId = <pay21IntentId>`, `confirmedAt` set,
`metadata` carrying `txHash`, `network`, `blockNumber`. This is what makes USDT
deposits visible to existing payment reporting without a second code path.

**`transactions`** — `type = DEPOSIT`, `currency = 'USDT'`,
`amount = detectedAmount`, `balanceBefore` / `balanceAfter` computed from the
**USDT** ledger via the Stage B `ledgerBalance` helper, `paymentId` linking the
two, `isBonus = false`.

`externalPaymentId` is the **21Pay intent id, not the `txHash`.** The intent id
is the stable natural key across detected, confirmed, partial, and top-up
events. A `txHash` is per-transfer, and a top-up produces a second one against
the same intent. `payments.externalPaymentId` is already `UNIQUE`, so this
gives exactly-once at the database layer for free.

Two independent guards on a credit path — the unique constraint and the
`creditedAt` check — is correct, not redundant.

**Do not call the gateway from the settlement path.** By settlement time 21Pay
has already told us what happened; calling back to confirm what the signed
webhook just said adds a failure mode and no information.

## E.4 Non-disruption: this is where Stage B is tested

This stage writes the first non-BTN rows to `transactions`. Everything that
makes that safe was built in Stage B, and **this is the first code to actually
exercise it.**

Re-verify rather than trusting it still holds:

- Every one of the 48 ledger sums is currency-scoped, and
  `ledger-currency-guard.spec.ts` is green.
- `balanceBefore` / `balanceAfter` on the new row are computed from the USDT
  book alone. If they are computed from an unscoped sum, the ledger is
  self-consistently wrong and reconciliation will not catch it — the row's own
  arithmetic checks out.
- Book totals and odds are per book, so a USDT stake cannot move a BTN
  figure (B.5).

A gap here corrupts the balance sheet for every live BTN user, and it does so
silently.

## E.5 Explorer link

Store `txHash` and `blockNumber` on the intent from the webhook payload. Build
`explorerUrl` server-side from network plus hash, so no client maintains a
per-chain URL table.

**Do not anchor these on-chain.** They are already on-chain transfers with
public, independently verifiable hashes. Anchoring a hash of something already
permanently public is redundant and costs gas.

## Verification

- Unit, per status: all nine through `settle`, asserting credit or no credit and
  the resulting local status.
- Unit: double delivery of the same `confirmed` event credits once.
- Unit: `confirmed_partial` credits the detected amount, not the expected.
- Unit: `confirmed_overpaid` credits the detected amount and raises the ops flag.
- Unit: unknown intent id neither throws nor 5xxs.
- Unit: parent `completed_via_topup` does not double-credit when the child
  already settled.
- Unit: **`balanceBefore` / `balanceAfter` reflect the USDT book only**, on a
  fixture where the same user id also has BTN rows. This is the test that would
  have caught an unscoped sum, and it is worth writing even though Stage B
  should make it impossible.
- Integration: signed webhook through to a `transactions` row with
  `currency = 'USDT'` and 6dp preserved at `numeric(28,9)`.
- Integration: parent partial, then top-up child confirmed, credits exactly the
  two detected amounts and no more.
- **BTN regression gate with USDT rows present.** Balance sheet, revenue
  reporting, and reconciliation must return byte-identical BTN numbers. The
  most important test in this stage.

## Rollback

`USDT_ENABLED=false` makes the handler unreachable, since no intent can be
created. Webhook events continue to be recorded unprocessed and can be replayed
after a fix. Already-credited USDT rows stay in the ledger and remain excluded
from BTN reporting.
</content>
