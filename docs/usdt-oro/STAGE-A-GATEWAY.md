# Stage A: 21Pay Gateway, Config, Chains, Address Validation

**Touches BTN:** No. Additive and dormant.
**User-visible:** No. `USDT_ENABLED` stays `false`.
**Depends on:** Stage 0.

## Goal

Take the salvaged 21Pay client from four-chain-ready to four-chain-correct:
resolve the auth-scheme question, replace the single-network config with an
enabled-networks list, and write EVM address validation, which does not exist.

Nothing upstream calls any of it yet.

## A.1 Config already exists

Unusually, `.env.example` survived the revert. The
`# ── USDT (TRC-20) via Twenty-one Pay ──` block is already on `main` even
though the code that reads it is not:

```
USDT_ENABLED=false
TWENTYONE_PAY_BASE_URL=https://dev-21pay.tech.bt/v1
TWENTYONE_PAY_API_KEY=
TWENTYONE_PAY_TENANT_ID=
TWENTYONE_PAY_NETWORKS=tron
TWENTYONE_PAY_NETWORK=tron
TWENTYONE_PAY_WEBHOOK_SECRET=
USDT_MIN_DEPOSIT=1
USDT_MAX_DEPOSIT=1000
USDT_ALLOW_CID_USERS=false
```

Three changes.

**Drop `TWENTYONE_PAY_NETWORK`.** A single default network is how a wrong-chain
deposit happens: some code path omits the network, the default fills in, and
the user is given a Tron address for a Base transfer. There is no recoverable
outcome from that. `TWENTYONE_PAY_NETWORKS` becomes the only source, and every
call site passes a network explicitly.

```
TWENTYONE_PAY_NETWORKS=tron,base,polygon,arbitrum
```

**Drop `USDT_ALLOW_CID_USERS`.** It gated Bhutan-resident accounts off the
crypto rail under the old two-rails-one-account model. Under segregation a
BTN account has no crypto rail to be gated off — the currency does the gating,
structurally. Leaving the flag in place implies a crossing exists.

**Add `TWENTYONE_PAY_INTENT_TTL_MINUTES`,** default 30.

Everything else stands. Keep the existing `TWENTY_ONE_PAY_API` fallback the
salvaged client reads; removing a live env key is a separate deliberate change.

## A.2 Settle the auth scheme against the real contract

The salvaged client sends `Authorization: Bearer <key>` on **every** request.
The 21Pay OpenAPI spec the source plan was written against uses two schemes:

| Routes | Header |
|---|---|
| `/v1/payment-intents*` | `X-Tenant-Id: <uuid>` |
| `/v1/payouts*`, `/v1/merchants*`, `/v1/admin/*` | `Authorization: Bearer <token>` |

These cannot both be right. The salvaged client was written and tested against
the staging gateway, so it may reflect reality better than the spec does — or
staging may simply accept a Bearer token everywhere.

**Resolve this against the live contract before writing another line of client
code.** Getting it wrong means Stage C's first real call 401s, which is
recoverable, or that Stage F's payout call authenticates as the wrong principal,
which is not. Then add a scheme argument to the private `request<T>` helper
rather than hardcoding either answer.

`TWENTYONE_PAY_TENANT_ID` is already in config and unused — the tenant header
was anticipated and never wired.

## A.3 Client surface

Keep the salvaged structure. The timeout and abort handling, the error mapping,
and the deliberate never-log-the-Authorization-header discipline are all correct
and stay.

Methods, after this stage:

```ts
createIntent(req: CreateIntentRequest): Promise<PaymentIntent>
getIntent(intentId: string): Promise<PaymentIntent>
createTopup(req: CreateTopupRequest): Promise<PaymentIntent>
verifyWebhook(...): boolean          // salvaged, unchanged
```

`createIntent` returns 201 for both a fresh create and an idempotency-key
replay. Treat both as success; do not special-case the replay.

**Amounts stay smallest-unit strings on the wire.** `usdt.util.ts` already has
`toBaseUnits` / `fromBaseUnits` and they are tested. Convert at the repository
boundary only, never inside the client, and never let a base-unit integer and a
human USDT value share a variable name.

**Payouts are Stage F.** Do not stub `createPayout` now. A dead method on the
money path is worse than an absent one.

## A.4 Networks

**Tron, Base, Polygon, Arbitrum.** No Ethereum L1, no TON.

There is no `CryptoNetwork` enum on `main` to extend — the salvaged code was
Tron-only and typed the network as a string. Introduce one:

```ts
export enum CryptoNetwork {
  TRON = "tron",
  BASE = "base",
  POLYGON = "polygon",
  ARBITRUM = "arbitrum",
}
```

Lowercase values, matching the wire format, so no mapping layer is needed.

**Do not add an `ETHEREUM` member.** The source plan kept one as inherited
dead weight; Oro has no such inheritance, and an unwired enum value is an
invitation to wire it accidentally. Adding a chain later is a one-line change
plus a webhook subject.

Validate on read that every value in `TWENTYONE_PAY_NETWORKS` parses to a
`CryptoNetwork`, and fail boot if not. A typo in an env var should not surface
as a 500 on a user's first deposit.

## A.5 Address validation, EVM half missing

`usdt.util.ts` has `isValidTronAddress` — real base58check with a decode and
checksum verify, not a `T`-prefix regex, and it has 175 lines of tests. Keep it.

There is **no EVM validation of any kind.** Write it:

```ts
export function isValidEvmAddress(address: string): boolean
```

- `0x` plus exactly 40 hex characters
- EIP-55 checksum verification **when the input is mixed-case**. An all-lower or
  all-upper address is unchecksummed and legal; a mixed-case address with a bad
  checksum is a typo and must be rejected.

Then a dispatcher:

```ts
export function isValidAddressForNetwork(
  network: CryptoNetwork,
  address: string,
): boolean
```

**All three EVM chains share one address format.** Validation cannot tell them
apart, and with three enabled the odds of a mix-up are meaningfully higher than
with one. A user sending Base USDT to an address they hold on Arbitrum is a
real, unrecoverable failure that no amount of format checking prevents.

Two mitigations, both required, both outside this stage:

- Network is a stored property of the saved address record, never a separate
  choice at withdrawal time ([Stage F.5](./STAGE-F-WITHDRAWALS.md)).
- Network is displayed spelled out — "Base network" — never as a chain id, in
  both the deposit picker and the withdrawal confirmation
  ([Stage H](./STAGE-H-CLIENTS.md)).

Validate format only. Semantic validation belongs to 21Pay.

## A.6 Where this lives

Oro has no `shared/services/api-config.service.ts`; `src/shared/services/`
holds notification, email, and SMS only. Config is read through Nest's
`ConfigService` directly, which is what the salvaged client already does.

Follow that. Do not introduce a config-service abstraction for one rail.

```
src/payment/services/twentyone-pay/
  twentyone-pay.client.ts        salvaged, extended here
  twentyone-pay.types.ts         CryptoNetwork, intent/payout shapes
src/payment/usdt.util.ts         salvaged, + EVM validation
```

## Verification

- `npx tsc --noEmit` clean.
- Unit, client: correct header per route family once A.2 is settled, 201 create,
  201 idempotent replay, `GET` by id, timeout, 503, non-JSON body, and the
  snake_case → camelCase mapping.
- Unit, address validation: valid Tron; valid EVM all-lowercase; valid EVM
  checksummed; **EVM with one character's case flipped rejected**; a Tron
  address rejected under an EVM network and the reverse; truncated and
  over-length rejected. The case-flip test is the one that proves EIP-55 is
  actually implemented rather than stubbed.
- Unit: boot fails on an unknown value in `TWENTYONE_PAY_NETWORKS`.
- **BTN regression gate.** This stage should not move a single BTN number,
  which is the point of running it.

## Rollback

Entirely additive. Revert the commit. Nothing references any of it while
`USDT_ENABLED=false`.
</content>
