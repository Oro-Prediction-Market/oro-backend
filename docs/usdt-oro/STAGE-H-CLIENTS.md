# Stage H: Clients — PWA USDT Flows, TMA Guard, Admin USDT Book

**Touches BTN:** No backend change, but it touches the apps existing BTN users
use every day.
**User-visible:** Yes.
**Depends on:** Stages E, F, G.
**Repos:** `oro-pwa`, `oro-tma`, `oro-admin`.

## H.1 Oro has three clients, not one

The source plan assumes a single Next.js PWA with an App Router route tree.
None of that is true here:

| | Stack | Role in this plan |
|---|---|---|
| `oro-pwa` | React + Vite + `react-router-dom` v6 | **All USDT work lands here** |
| `oro-tma` | React + Vite, Telegram Mini App | BTN-only. Needs a guard, nothing else |
| `oro-admin` | React + Vite | KYC review queue, USDT book, market currency selector |

There is no App Router, no server components, no route groups. The source plan's
`app/(auth)/signup/global/` layout does not translate; use the existing
`react-router` route table.

### The `shared/` directory is a drifted copy, not a symlink

`oro-pwa/shared/` and `oro-tma/shared/` are **two divergent copies** of the same
directory. They already differ: `api/client.ts` differs, `EplBanner.tsx`
differs, and each has components the other does not.

This matters. A currency-aware formatter added to `oro-pwa/shared/` **does not
reach the TMA**, and any assumption that editing `shared/` covers both clients
is wrong. Decide deliberately for each change whether it is PWA-only or must be
mirrored, and say so in the commit.

For this stage the answer is almost always PWA-only — the TMA is BTN-only — but
the currency formatter is the exception, because the TMA needs to keep
rendering `Nu.` after the formatter changes shape.

## H.2 Currency context in the PWA

A `CurrencyProvider` alongside the existing providers in
[`PwaApp.tsx`](../../../oro-pwa/src/PwaApp.tsx), reading currency from the
session.

- BTN accounts: `Nu.`, exactly as today.
- USDT accounts: `$` / `USDT`.

No dual display, no toggle, no secondary reference line. Each account is native
to one currency, so the tension that would justify a second line does not exist.

**Change the shared formatter's signature so currency is required**, rather than
adding a parallel USDT helper. A component that forgets to pass currency should
fail to compile, not silently render `Nu.` on a USDT screen. That is the same
trick Stage B uses on `ledgerBalance`, and it is the only reliable one.

Mirror the signature change into `oro-tma/shared/` in the same change set,
passing `'BTN'` at every TMA call site. The TMA's rendering must not move.

## H.3 Remove the TON placeholder

[`PwaPaymentSelector.tsx`](../../../oro-pwa/src/components/PwaPaymentSelector.tsx)
offers a `ton` method with `currency: "USDT"`, and
[`payment.controller.ts:351`](../../src/payment/payment.controller.ts#L351)
returns it from `GET /payments/methods` with `enabled: true`. There is a lazy
`TonConnectUIProvider` wired into the `/wallet` route in
[`PwaApp.tsx:210`](../../../oro-pwa/src/PwaApp.tsx#L210), deliberately
code-split to save 835 KiB elsewhere.

**None of it is connected to a working rail.** TON is dropped from this plan.

Remove the method from `GET /payments/methods`, remove the selector entry, and
remove the TonConnect provider and its `@tonconnect/ui-react` dependency. That
last one also deletes the 835 KiB the lazy-loading exists to avoid, which makes
this a small performance win as well as a correctness one.

Do this **before** adding the USDT method, so there is never a build where a
user sees two crypto options and one of them is a decoy.

## H.4 The market card shows both books

Everyone sees every market. There is no currency filter on the feed, because a
market is not owned by a currency.

The card shows both book totals side by side:

```
Will Bhutan beat Nepal?
20,000 BTN  |  $420
```

**Never sum them.** There is no exchange rate in this system, so the two have
no common unit. Two figures, two units, each the real payout basis for its own
book. If a combined number ever appears on a card, in a tooltip, or in a
"total volume" stat, something has been built wrong.

Inside the market, the viewer sees **their own book only**: their currency's
pool, their currency's odds, their currency's minimum stake. The other book's
total stays on the card as a signal that the market is busy, and nowhere else.
Do not render the other book's odds — they are a different market's odds from
the viewer's point of view and can only mislead.

A market whose USDT book is disabled shows one figure. That is normal, not an
error state.

**The stake control is gated by book, not by market.** A user whose currency
has no book on this market can read everything and stake nothing, with a plain
line saying so.

## H.5 Deposit: two methods, both at launch

```
How are you sending?
  ( • ) Manual           Copy the address, or scan. Any wallet or exchange.
  (   ) Connect wallet   EVM chains only. Not available on Tron.
```

**Manual is the default and always available.** Connecting is never a
prerequisite.

### Manual path — this is the majority path

- **Network selector first**, prominent, with the consequence stated. A
  wrong-network send is unrecoverable.
- Deposit address as selectable text, a copy button, and a QR.
- The exact amount with **its own copy button**. Users type this by hand and get
  it wrong, and every wrong amount is a `confirmed_partial`.
- Expiry countdown from the intent.
- Per-chain confirmation expectation. Tron is about a minute at 19
  confirmations; the L2s vary. The `confirming` state must feel intentional
  rather than stuck.
- **Warn about the sender's gas.** A TRC-20 transfer burns roughly 13–30 TRX in
  energy unless the sender has staked. A user holding only USDT and zero TRX
  cannot send at all. This is the single most common Tron support issue and one
  line of copy pre-empts it.

Most deposits will arrive from an exchange, and Tron — the expected volume
leader — has no wallet option at all. Manual has to be flawless.

## H.6 Wallet connect

**RainbowKit.** Both RainbowKit and Reown AppKit sit on wagmi and viem and both
require a WalletConnect project id, so neither avoids Reown's relay. RainbowKit
has the smaller API surface and the better defaults for what is a convenience
feature on a non-critical path. Reown's advantage is its non-EVM adapters and
embedded wallets; neither helps, because our non-EVM chain is Tron, which
neither library supports, and embedded wallet creation is useless to someone who
already holds USDT elsewhere.

**Scope it honestly.** 21Pay gives us a per-intent deposit address; the wallet
is just a payment source. Connecting saves the user copying an address and
typing an amount. That is the whole benefit. It is worth having and it is not
architectural.

Flow: connect, then `useWriteContract` for an ERC-20
`transfer(depositAddress, amount)` against the USDT contract on the selected
chain.

**Serve the USDT contract addresses from backend config**, not hardcoded in the
bundle, so a testnet swap or token migration is a config change:

```
polygon    0xc2132D05D31c914a87C6611C10748AEb04B58e8F
arbitrum   0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9
base       0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2
```

### Chain switching is the main failure point

The user's wallet will often be on a different chain than the intent.

- Detect the mismatch **before** showing the send button, not after.
- If the switch is declined or fails — and some wallets fail it silently — fall
  back to the manual path with the address already visible. **Never dead-end.**
- Verify the connected chain id matches the intent's network immediately before
  the write. Never send on the wrong chain.

### Never credit on the wallet callback

`useWriteContract` returns a hash once the user signs. That is proof of
signature, not of settlement — the transfer can still revert, and a client
response is trivially forged.

Treat the hash as a UI cue only. Settlement comes from the 21Pay webhook,
exactly as on the manual path. Both methods converge on the same intent status.

### Tron has no wallet option

TronLink needs a separate library, works only as a browser extension, and
deeplinks unreliably on mobile. Tron users overwhelmingly arrive from exchanges.

**Hide the method toggle entirely when Tron is selected.** Do not show a
disabled option; it reads as broken rather than intentional.

## H.7 Every state the UI must handle

Each is reachable in production.

| State | UI |
|---|---|
| KYC `PENDING` | Can browse. Deposit blocked with a clear "under review" state and expected turnaround |
| KYC `REJECTED` | Reason plus a single resubmit path |
| `awaiting_deposit` | Address, QR, amount, expiry countdown |
| `confirming` | Per-chain expectation, not a generic spinner |
| `confirmed` | Success, balance updated, explorer link |
| `confirmed_partial` | Shortfall shown, **Top up** prominent. The highest-value non-happy state — underpayment will be common |
| `confirmed_overpaid` | Full received amount credited. Say so plainly |
| `expired` | Offer a new intent, plus top-up if anything arrived |
| `failed` | Generic failure copy plus a support path. **Never surface AML reasons** |

**Reuse the open intent on retry** rather than creating a new one. A fresh
intent per retry burns HD derivation indices on 21Pay's side and leaves orphans.

## H.8 Withdrawal

- Linked addresses only. No ad-hoc entry.
- Network bound to the address record and **displayed spelled out** — "Base
  network", never a chain id. All EVM chains share the `0x` format, so this is
  the only thing standing between a user and an unrecoverable send.
- Pending-approval state with the SLA shown.
- Explorer link once broadcast.

## H.9 The TMA needs a guard, not a feature

The TMA is BTN-only and this plan does not change that (master-plan decision 2).

But "BTN-only" has to be enforced, not assumed. A USDT account that somehow
authenticates into the TMA would today see an empty market list and a balance
rendered in `Nu.` — a wrong-currency display of real money.

Add one check: if the session's currency is not BTN, show a plain "this account
is not supported in Telegram, use the web app" screen. It is a few lines, it is
the entire TMA scope of this plan, and it converts an undefined state into a
defined one.

## H.10 Admin

- KYC review queue (Stage G.6), with the reviewer role.
- Market creation opens a BTN book by default, with a USDT book as an explicit
  toggle. Per-book `houseEdgePct` and `minStake`.
- A book cannot be disabled once it has positions, and its currency is
  immutable.
- Per-book pool, exposure, and revenue in the dashboard — **two columns, never
  a combined total.**
- Settlement view must show both books' outcomes, including the case where one
  refunded and the other paid out.
- Withdrawal approval queue (Stage F.7).

## H.11 What must not regress

The PWA and TMA are live for Bhutanese users who play regularly. Every change
here is production-touching for them.

- A BTN account sees an identical app: same markets, same `Nu.`, same deposit
  and withdrawal flows.
- Users with several identities are one account and keep working from every
  client.
- No account migrated, no balance converted, no communication needed.

Treat this as the acceptance criterion, not an afterthought.

## Verification

- `npm run lint` clean in each touched repo.
- Manual, BTN account, PWA: full regression pass against production — markets,
  betting, deposit, withdrawal, profile.
- Manual, BTN account, TMA: full regression pass. The formatter signature change
  touches this app; nothing may move.
- Manual, USDT account: signup, KYC pending, approval, deposit by address on
  Tron, deposit by wallet connect on each EVM chain, underpay and top up,
  withdraw.
- Manual, wallet connect: connect on the wrong chain, accept the switch prompt;
  then separately decline it. Declining must fall back to manual with the
  address visible.
- Manual: the method toggle is **absent, not disabled**, when Tron is selected.
- Manual: force-close the browser immediately after signing. The webhook must
  still settle and the balance must be correct on next load.
- Manual: a USDT account can open any market and can stake **only** into the
  USDT book; the stake control is unavailable where no USDT book exists.
- Manual: no screen anywhere renders a summed BTN+USDT figure.
- Manual: a market where the USDT book refunded and the BTN book paid out reads
  correctly to a user in each cohort.
- Manual: a USDT account hitting the TMA sees the unsupported screen.
- Manual: mobile browser. A large share of the target cohort has no desktop.
- Confirm no currency string is hardcoded in any shared component, in either
  copy of `shared/`.

## Rollback

`USDT_ENABLED=false` hides the USDT signup route and the crypto deposit and
withdrawal flows. The PWA renders exactly as today for BTN accounts. In-flight
intents settle normally on the backend, which does not depend on the client.

The TON removal in H.3 does **not** roll back with the flag — it is a separate,
deliberate deletion. Ship it as its own commit so it can be reverted
independently.
</content>
