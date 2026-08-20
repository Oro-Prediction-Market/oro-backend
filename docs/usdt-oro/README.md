# USDT on Oro: Master Plan

> This is the Oro-native execution plan. The money model it implements comes
> from [`../usdt-21pay/`](../usdt-21pay/README.md), which was written against
> LuckyPemX — a different product with a different schema. That folder stays as
> the conceptual source; **this folder is what gets built.** Where the two
> disagree about mechanics, this one is right.
>
> Money model: [`SEGREGATION-MODEL.md`](./SEGREGATION-MODEL.md). Read it before
> any stage that touches a balance, a market, or a report.
>
> **Building? Start at [`BUILD.md`](./BUILD.md)** — commit-by-commit execution
> order, real DDL, and what blocks what. The stage docs are the reasoning; that
> one is the work.
>
> Counterparty: Twenty-one Pay. Contract in
> `21Pay/api/openapi/openapi.yaml`, webhooks in `21Pay/docs/06-webhooks.md`.

## 1. The shape

Two currencies, one backend, no path between them.

| | BTN | USDT |
|---|---|---|
| Users | Bhutanese residents | International and diaspora |
| Clients | TMA + PWA | PWA only |
| Auth | Telegram, DK Bank, BhutanApp | Email + password, document KYC |
| Ledger currency | BTN | USDT |
| Stakes into | the BTN book of a market | the USDT book of the same market |
| Funding rail | DK Bank | 21Pay, on-chain USDT |

**Currency belongs to the account, not the client.** The TMA stays BTN-only.
The PWA renders whatever the logged-in account holds. A Bhutanese user with
Telegram, DK Bank, and BhutanApp identities is one account with one BTN ledger,
reachable from both clients, and nothing about them changes.

**No conversion exists anywhere.** A USDT balance can only enter a USDT book
and can only leave as USDT. A BTN balance can only enter a BTN book and can only
leave through DK Bank. There is no path between them, by construction rather
than by rule.

**One event is one market.** A market is a single row with a single resolution
and a single card in the feed. What splits by currency is the pool underneath
it:

```
Market: "Will Bhutan beat Nepal?"     ← one row, one resolution, one card
  ├── BTN book    Nu 20,000    edge 10%
  └── USDT book   $420         edge 8%
```

The card shows both totals side by side and **never sums them** — there is no
exchange rate in this system, so the two numbers have no common unit. Each is
the real payout basis for its own book. Settlement runs once per book against
one resolved outcome, so odds, the platform cut, and refunds are all per book.
Details in [`SEGREGATION-MODEL.md`](./SEGREGATION-MODEL.md) section 4.

## 2. What is different about Oro

Four facts drive every deviation from the source plan. They are the reason this
folder exists.

### 2.1 Balance is derived, not stored

Oro has **no wallets table and no balance column.** A user's balance is:

```sql
SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE "userId" = ?
```

There are **48 such sums across 14 files**, each written independently in its
own service. `users` carries only `bonusBalance` and
`bonusRealPayoutRemaining`, which are promotional counters, not the balance.

This cuts both ways. The source plan's highest-risk item — 20 call sites
relying on a `currency = "BTN"` default parameter on a `WalletEngineService` —
has no analogue here, because there is no wallet service. It is replaced by a
worse one: **48 unfiltered `SUM(amount)` queries, any of which folds a USDT row
into the BTN book the moment the first USDT row exists.** A crypto deposit
becomes spendable ngultrum, withdrawable through DK Bank.

That is a mint-money bug. It is Stage B, and it is the whole plan's centre of
gravity.

### 2.2 Postgres, not MySQL

`timestamptz`, `jsonb`, enum types altered with `ALTER TYPE ... ADD VALUE`.
None of the source plan's MySQL migration guidance transfers. Widening a
`numeric` is metadata-only in Postgres, so Stage B's *migration* is cheap; its
risk lives entirely in the query audit, not the DDL.

Two operational facts constrain every migration in this plan:

- `DB_SYNCHRONIZE` exists and is honoured at boot ([app.module.ts:126](../../src/app.module.ts#L126)).
  Any index created only in a migration gets dropped by `synchronize` on the
  next boot. **Declare every index on the entity as well as in the migration.**
- **Production migrations are not auto-run.** Each one needs hand-applied SQL
  plus a `migrations` row. Budget for it; do not trust the deploy workflow's
  comment.

### 2.3 The market money path has to be restructured, not just tagged

`markets`, `outcomes`, `positions`, `settlements`, `revenue_distributions`,
`challenges`, and `disputes` all carry money at `numeric(18,2)`, while
`transactions` is `numeric(20,9)`. The money path is already split across two
precisions.

Because a market is not owned by a currency, the market list needs no currency
filter and the global Redis key at
[`markets.service.ts:346`](../../src/markets/markets.service.ts#L346) stays as
it is. The books model removes a hazard the currency-on-market design would have
introduced. What it adds instead is a restructuring of the market money path —
pool totals, odds, and settlement move onto per-currency book tables. That is
the bulk of Stage B.

### 2.4 Promotional money has no home in the source plan

Free credits, streak bonuses, referral prizes, season prizes, the Nu 50
withdrawable cap, `bonusRealPayoutRemaining`. All BTN, all promotional, all
mutating the same ledger. The source plan never had to answer what a USDT
account gets, because LuckyPemX has no bonus system.

This is a new decision, not an implementation detail — see decision 1 below.

## 3. What existing users experience

**Nothing.** Hard requirement.

- TMA users: untouched.
- PWA users on Telegram / DK Bank / BhutanApp: same app, same BTN balance, same
  markets.
- Users with several identities: one account, still reachable from every client.
- No balance converted, no account migrated, no communication needed.

Every stage that touches shared code carries the same regression gate: the
balance sheet, revenue reporting, and reconciliation must return byte-identical
BTN numbers before and after.

## 4. Chains

**Tron (TRC-20) primary. Base, Polygon, Arbitrum secondary.**

Tron is the dominant retail USDT rail with the cheapest exchange withdrawal
(~1 USDT) and universal exchange support; expect most volume there. The three
EVM chains serve self-custody wallet users and exchanges that route to an L2.

Ethereum L1 is **not** enabled — gas on an ERC-20 transfer is the worst of the
options. TON is **dropped**: its only rationale was Telegram-native signing, and
the TMA is BTN-only. Note that [`PwaPaymentSelector.tsx`](../../../oro-pwa/src/components/PwaPaymentSelector.tsx)
and [`payment.controller.ts:351`](../../src/payment/payment.controller.ts#L351)
still advertise a `ton` method with `enabled: true`. That is a live lie today
and Stage H removes it.

**The three EVM chains share the `0x` address format.** Validation cannot tell
them apart, so the network must be bound to the stored address record rather
than chosen at withdrawal time. Stage F.5, Stage H.7.

**Two deposit methods, both at launch.** Manual (copy address / QR) is the
default and always available; wallet connect is EVM-only. Most deposits will
arrive from an exchange, not a browser wallet, and Tron — the expected volume
leader — has no wallet integration at all. Manual has to be flawless.

## 5. Custody

Funds sit with 21Pay. `transactions` is a claim ledger against their custody.

Liquidity is structurally sound: USDT payouts come from USDT stakes, and the
parimutuel house edge means the winning side is paid from the losing side.
Only the edge leaves the system.

**Reconciliation replaces buffer sizing as the critical control.** The sum of
the USDT book must equal 21Pay's custody balance for our tenant, checked daily.

**This is a custody dependency.** A 21Pay incident affects our users' money, and
they will hold Oro responsible.

## 6. Open decisions

Numbering is stable. Resolved items are struck through in place so
cross-references keep pointing at the right thing.

1. **Promotional money on the USDT rail.** Does a USDT account receive free
   credits, streak bonuses, referral prizes, season prizes? In what currency,
   from what budget, and does the Nu 50 withdrawable cap have a USDT analogue?
   **Blocks Stage B′.** Recommendation: USDT accounts get no promotional credit
   at launch. It is the only answer that needs no new money math, and the bonus
   accounting already has a known reconciliation weakness that should not be
   duplicated into a second currency.
2. **Does the TMA ever get a USDT surface?** Assumed no throughout this plan,
   and load-bearing for "TMA is untouched".
   **Partly answered (2026-08-19):** `oro-tma` does carry routed TON pages
   (`/ton-bet/:id`, `/ton-connect`, a `TonConnectUIProvider` around the app),
   but the feature is **not live** and its future is undecided. It is left in
   place and untouched. If it is ever revived it is a second crypto rail in a
   product designed for one, and it would have to answer the segregation
   questions from scratch.
2a. **Which markets get a USDT book?** Every market by default, or an explicit
   admin toggle per market. Default-on means foreign users see a full feed where
   most books hold almost nothing; toggle means a curated but smaller feed.
   Recommendation: explicit toggle at launch, default-on once volume justifies
   it. Affects Stage B.7 and Stage H.
2b. **Per-book platform cut.** BTN and USDT books can carry different
   `houseEdgePct`. What are the launch numbers, and who owns changing them?
2c. **Divergent refunds.** A thin USDT book can refund while the BTN book on the
   same market pays out. Confirm this is acceptable product behaviour and agree
   the copy, because it will read as a bug to anyone who sees both.
3. **Cold-start liquidity.** A USDT book with two participants has a trivial
   pool, so nobody enters. Who underwrites a minimum, from which budget.
   Needed before Stage I.
4. **Jurisdiction gating.** Online prediction markets are prohibited outright
   in several countries. Needed before Stage I. Needs a non-engineering owner.
5. **KYC review SLA and staffing.** Manual document review is a queue with a
   service level. Needs a non-engineering owner.
6. **Document retention and access policy.** Passport and ID images are
   sensitive PII under regimes that now apply. Encryption, retention, access
   control, deletion on request. Needs a non-engineering owner.
7. ~~**Payout custody.**~~ **CLOSED AS MOOT (2026-08-19).** `POST /v1/payouts`
   is operator-only and 403s a merchant token. Merchants withdraw via
   `/v1/withdrawals`, where 21Pay owns the wallet and the controls. There is no
   key handle for us to hold. Stage F rewritten.
8. **Tenant provisioning.** Tenant UUID, merchant `tk_live_` tokens per
   environment, registered xpubs, and all four networks `activated`. Owner:
   21Pay ops. Assert at startup rather than assuming (§5.2).
10. **21Pay's deposit fee.** They deduct a per-tenant `fee_bps` from every
   confirmed deposit at ledger-post time, so our claim on them is
   `detected − fee` (§6). It stacks on top of Oro's own platform fee and is
   charged on **gross inflow**, not on GGR. Need: our `fee_bps` per chain, the
   billing plan, and whether an internal 21 Tech platform is set to 0.
   **Blocking for the business case, not for the code.**
11. **The 24h withdrawal-destination cooldown.** A winner cannot be paid for
   24 hours after adding an address. Either negotiate a tenant-specific value
   or design it into onboarding. Product decision, see Stage F.2.
9. **AML quarantine UX.** 21Pay routes high-risk deposits to quarantine, which
   never produces a `confirmed` event. Define the user-facing state and the
   escalation path. Oro has an `aml/` module already; decide whether this
   routes through it.

**Resolved:** currency segregation over conversion; one human may hold both a
BTN and a USDT account; deposits and withdrawals are not anchored on-chain
(they are already on-chain); the ledger is the source of truth for balance and
stays that way — this plan does not introduce a balance column.

## 7. Stage sequence

| Stage | Title | Touches BTN? | User-visible? | Depends on |
|---|---|---|---|---|
| [0](./STAGE-0-SALVAGE.md) | Recover and renumber the `93ee897` USDT work | No | No | none |
| [A](./STAGE-A-GATEWAY.md) | 21Pay contract, config, chains, address validation | No | No | 0 |
| [B](./STAGE-B-LEDGER-SEGREGATION.md) | Ledger currency (34 sums) + per-currency books | **Yes** | No | 0 |
| [B′](./STAGE-B-PRIME-PROMO-CURRENCY.md) | Promotional money on the USDT rail | **Yes** | No | B, decision 1 |
| [C](./STAGE-C-INTENTS.md) | Deposit intents and top-up | No | No | A |
| [D](./STAGE-D-WEBHOOK.md) | HMAC webhook receiver | No | No | A |
| [E](./STAGE-E-SETTLEMENT.md) | Settlement and USDT credit | Ledger only | No | B, C, D |
| [F](./STAGE-F-WITHDRAWALS.md) | USDT withdrawals | Ledger only | No | E, decision 7 |
| [G](./STAGE-G-ONBOARDING-KYC.md) | Email auth, document KYC, admin review | No | No | none |
| [H](./STAGE-H-CLIENTS.md) | PWA USDT flows, TMA guard, admin USDT book | No | Yes | E, F, G |
| [I](./STAGE-I-ROLLOUT.md) | Reconciliation, monitoring, rollout | Reporting | Yes | all |

Stage 0 comes first and is short. A, B, and G are then independent and can run
in parallel. C and D are independent once A lands.

**Stage B is the riskiest and should start immediately after 0.** It is the only
stage that changes how every existing balance in the system is computed.

**E, F, G, and H go live together.** A USDT user who can deposit but not
withdraw has trapped funds; one who can sign up but not be approved has an empty
account. Stage I flips the flag for all of them.

## 8. Non-negotiables

- **No conversion path, ever.** If a future feature needs BTN↔USDT for a user,
  it is a new product with its own licensing question.
- **Every `SUM(amount)` over `transactions` is currency-scoped.** Enforced by a
  static test, not by review. Stage B.3.
- **Never credit on a client signal.** Credit only on a verified 21Pay webhook
  or a server-side poll. A client response is trivially forged, and a wallet
  signature is proof of signature, not of settlement.
- **Credit the detected amount, never the expected amount.**
- **Tenant credentials never reach a client bundle.** The clients call Oro; Oro
  calls 21Pay.
- **A stake can only enter the book matching the account's currency**, checked
  server-side before any ledger write. Everyone sees every market; what is
  gated is which book you can stake into.
- **Two currencies are never summed**, on a market card or in a report. There
  is no rate, so a combined figure is undefined rather than imprecise.
- **KYC gates deposit, not withdrawal.** Blocking withdrawal means accepting
  money from someone we may then refuse to pay.
- **Deposits and withdrawals are not anchored on-chain.** Store `txHash`, render
  an explorer link.
- **Idempotent on intent id and payout id.** 21Pay delivers exactly once per
  subscription but retries on non-2xx.
- **Every new index is declared on the entity, not only in the migration**,
  because `DB_SYNCHRONIZE` will drop what it does not know about.
</content>
