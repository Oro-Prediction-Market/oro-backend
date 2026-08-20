# Stage I: Reconciliation, Monitoring, Rollout

**Touches BTN:** Reporting only.
**User-visible:** Yes. This is where the flag flips.
**Depends on:** Everything.

## I.1 Gate: E, F, G, H go live together

`USDT_ENABLED=true` turns on deposits, withdrawals, signup, and the client
surfaces simultaneously. None goes live alone:

- Deposit without withdrawal traps funds for users with no other rail.
- Withdrawal without deposit has nothing to withdraw.
- Signup without deposit is an empty account.
- Backend without a client is unreachable.

If any stage slips, they all wait. **This is the one sequencing rule that should
not be negotiated under schedule pressure.**

## I.2 Gate: the segregation invariant, proven

Before the flag, prove the boundary holds under real conditions:

- [ ] `ledger-currency-guard.spec.ts` green, with a documented justification for
      every entry in its skip-list.
- [ ] Zero transactions whose `currency` differs from their user's
      `users.currency`.
- [ ] Zero positions whose currency differs from their owner's
      `users.currency`.
- [ ] For every book, `sum(positions.amount)` equals `market_books.totalPool`.
- [ ] A USDT account cannot stake into a BTN book through any endpoint, client,
      or direct URL.
- [ ] A BTN account cannot stake into a USDT book or reach the crypto deposit
      path.
- [ ] No report, card, or stat sums money across currencies anywhere.
- [ ] `totalPaidOut + houseAmount + residual == market_books.totalPool` exactly,
      per book, on every settlement.
- [ ] A market with one book refunded and one book paid out settles correctly
      and reconciles.
- [ ] Existing Telegram, DK Bank, and BhutanApp users experience no change:
      markets, balances, deposit, withdrawal all byte-identical to production.

## I.3 Gate: compliance sign-off

Master-plan decisions 4, 5, 6, and 9 need written answers with named owners, not
verbal assurance:

- [ ] **Jurisdiction allowlist or blocklist.** Prediction markets are prohibited
      outright in several countries and the PWA is now explicitly an
      international product. Check what location data Oro actually captures on a
      position before assuming enforcement has the data it needs — the source
      plan assumed an `ipAddress` / `countryCode` pair that Oro may not record.
- [ ] **KYC review SLA and staffing.**
- [ ] **Document retention and access policy.** Encryption, retention period,
      access control, deletion on request. These users are in jurisdictions with
      erasure rights.
- [ ] **AML quarantine runbook.** 21Pay routes high-risk deposits to quarantine,
      which never produces a `confirmed` event. Define the user-facing state and
      the escalation path, and decide whether it routes through Oro's existing
      `aml/` module or stays with 21Pay.

Engineering does not own these. Engineering owns not shipping until they are
answered.

## I.4 Reconciliation

There is no DK-style internal counter-ledger for USDT. **21Pay's intent and
payout records are the counter-ledger.**

Daily:

| Check | Assertion |
|---|---|
| Custody parity | Sum of the USDT book equals `tenant.payable` at 21Pay, **less the deposit fees they deducted**. Read it from `GET /v1/ledger/balances`, not the CSV — that truncates at 1000 rows and omits `detected_amount` (§5.7, §6) |
| **Reorg reversal** | Every intent credited inside the reorg window still reads `confirmed` at 21Pay. **No webhook fires when one is reversed**, so this poll is the only way we find out (§2.4) |
| **Negative payable** | `tenant.payable` at 21Pay is not negative. A reorg clawback can drive it below zero if we already paid the user out, and it blocks all further withdrawal until a later deposit restores it |
| Deposit parity | Every 21Pay `confirmed` intent has one credited local intent, amounts equal |
| Payout parity | Every local payout has a matching 21Pay payout, amounts and status equal |
| Account/ledger agreement | Zero rows where `transactions.currency != users.currency` |
| Cross-currency isolation | Zero positions crossing the boundary |
| Book integrity | `sum(positions.amount)` equals `market_books.totalPool`, per book |
| Settlement identity | `totalPaidOut + houseAmount + residual == market_books.totalPool`, per book |
| Orphan deposits | 21Pay deposits with no matching local intent. Non-zero means an unexpected deposit to a derived address |
| Stuck intents | Non-terminal past the chain's finality window plus margin |
| Stuck payouts | Debited with no terminal status past SLA |

The middle three are the segregation invariants. **Equality, never tolerance.** A
tolerance hides exactly the class of bug these checks exist to find.

Extend [`reconciliation.service.ts`](../../src/reconciliation/reconciliation.service.ts)
rather than building a parallel service. The existing BTN reports stay scoped to
`currency = 'BTN'` and **their numbers must not move.**

## I.5 Monitoring

- Webhook signature rejections by reason. A spike is a misconfigured secret or
  someone probing.
- Webhook event rows with `processedAt` null older than 10 minutes. A stuck
  deposit with a user waiting.
- KYC queue depth and oldest-pending age. The first thing that breaks on a
  growth spike.
- Withdrawal approval SLA breach.
- Pending payouts exceeding 21Pay custody balance. Should be impossible; if it
  fires, reconciliation has already drifted.
- **Never log** the webhook secret, raw bodies, computed HMACs, document
  numbers, or image keys.

## I.6 Rollout sequence

0. **Assert all four chains report `activated`** via `GET /v1/networks` at
   startup. A chain we offer but 21Pay has not provisioned gives the user a
   deposit address nobody is watching (§5.2).
1. Staging end to end against **real** 21Pay: email signup, KYC submit, admin
   approve, whitelist a withdrawal destination **and wait out its 24h
   cooldown**, create intent, deposit on each launch chain, underpay and top
   up, withdraw, approve, confirm.
2. Confirm `key_handle` ownership and tenant provisioning **in writing**.
3. Confirm the gates in I.2 and I.3.
4. Apply the Stage B migration in a maintenance window with a verified backup —
   hand-applied SQL plus the `migrations` row, written out and reviewed before
   the window opens.
5. Open a USDT book on **one** market, with an underwritten minimum where
   cold-start liquidity is a concern (decision 3). Not a whole feed.
6. `USDT_ENABLED=true` for an **allowlist cohort**, not globally.
7. One real small deposit per chain, then one real small withdrawal, verified on
   chain and in the ledger.
8. **Hold until that first USDT book resolves and pays out**, so a real payout
   happens before widening. Confirm the BTN book on the same market settled
   independently and correctly.
9. Widen in steps, watching reconciliation at each step.
10. Final BTN regression gate with real USDT volume present.

**Step 8 is the one most likely to be skipped and the most important.** The
payout path is only proven by a real payout, and the cold-start assumption is
only tested by a market that actually attracts stakes.

## I.7 After launch

**Watch the cold start.** If the first USDT book does not attract meaningful
volume, the problem is market, not code. Do not respond by opening USDT books on
every market — that fragments what little liquidity exists across dozens of
near-empty pools, which is worse than a few visibly active ones. Respond by
increasing the underwritten floor or narrowing acquisition.

**Adding a chain is cheap:** a `CryptoNetwork` value, a webhook subject, an
address-format branch, a UI entry. Nothing in Stages 0 through F changes.
Ethereum L1 is the likely next addition if users report their exchange supports
none of the four.

**Then fix the bonus drift.** [Stage B′.4](./STAGE-B-PRIME-PROMO-CURRENCY.md#b4-do-not-fix-the-existing-bonus-drift-here)
deliberately deferred the `bonusBalance` desync and the `isBonus = false`
reporting gap so that no number moving during this work had two possible causes.
That reasoning expires once Stage I is done. Pick it up as its own change.

**Consider Option 3 on promotional money.** Launching with no USDT promotions
(decision 1) is the safe start, not the end state. Once there is a USDT cohort
worth retaining, streak and referral mechanics are the ones that pay for
themselves.
</content>
