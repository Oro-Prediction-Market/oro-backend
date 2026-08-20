# Stage D: HMAC Webhook Receiver

**Touches BTN:** No.
**User-visible:** No.
**Depends on:** Stage A. Parallel with Stage C.

## Goal

Accept, verify, and durably record 21Pay events. **This stage records only;
crediting is Stage E.** Splitting them means the receiver can ship and be
validated against real 21Pay traffic before any money moves.

## D.1 The delivery contract

> **Corrected 2026-08-19** against the engine source
> ([`21PAY-ANSWERS.md`](./21PAY-ANSWERS.md) §3). The header names below are
> `X-T1Pay-*`; the `X-21Tech-*` in 21Pay's own docs do not exist. **There is no
> `X-Request-Id`**, so the replay guard cannot key on a delivery id.

```
POST /payments/usdt/webhook
X-T1Pay-Event: deposit.confirmed
X-T1Pay-Timestamp: 1747632000
X-T1Pay-Signature: <hex>

{ "tenant_id", "intent_id", "network", "tx_hash",
  "block_number", "amount", "currency", "detected_at" }
```

Signature is `HMAC-SHA256(secret, "t=<timestamp>." + rawBody)`, hex encoded.
`verifyWebhook` on the salvaged client already implements this and has tests
covering forgery, tampering, re-serialisation, and the replay window. Do not
rewrite it.

Subjects, scoped to the launch chains rather than a broad `payment.tenants.>`
wildcard, which ships cross-chain freeze events with no handler. Per network in
`TWENTYONE_PAY_NETWORKS`:

```
payment.tenants.<tid>.deposits.<net>.detected
payment.tenants.<tid>.deposits.<net>.confirmed
payment.tenants.<tid>.deposits.<net>.failed
```

**Withdrawals do not arrive here.** The consumer binds deposits, payouts and
freeze only; the `withdrawals.*` family is not in the fan-out, so Stage F polls
instead (§3.7, Stage F.5).

Two subjects missing from 21Pay's published taxonomy are worth subscribing to:
`deposits.<net>.expired`, which lets a deposit screen close itself without
polling, and `deposits.<net>.unexpected`, a second deposit to an
already-used address. Nothing publishes `deposits.<net>.failed` despite it
being documented.

**The HMAC secret is returned exactly once at registration and is never
readable again.** Capture it straight into the secret manager. Losing it means
delete and re-register.

## D.2 Raw body capture — the thing most likely to break

NestJS parses JSON before the controller sees it. HMAC must be computed over
the **raw bytes**: any whitespace or key-order difference from a
parse-and-reserialise round trip breaks the signature.

The salvaged commit used `NestFactory.create(AppModule, { rawBody: true })` —
global. [`main.ts:54`](../../src/main.ts#L54) currently creates the app with no
options.

**Scope it to the one route instead:**

```ts
app.use(
  "/payments/usdt/webhook",
  bodyParser.json({
    verify: (req, _res, buf) => { (req as any).rawBody = buf; },
  }),
);
```

Global `rawBody` doubles the memory held per request across every endpoint on a
live API, to serve one route. The salvaged client's re-serialisation test is
what catches a regression here; make sure it runs against the real controller,
not a hand-built payload.

## D.3 Verification guard

`src/payment/guards/pay21-webhook.guard.ts`. **Order matters** — each step must
pass before the next runs:

1. Headers present. Missing → 401.
2. Timestamp skew within 300 seconds, **absolute in both directions**. Without
   this, a leaked signature replays forever.
3. Compute the expected HMAC over `t=<ts>.` plus the raw body.
4. Compare with `crypto.timingSafeEqual`. Never `===` — string equality leaks
   timing. Guard length first; `timingSafeEqual` throws on a length mismatch.
5. **Only now** parse the JSON.
6. Assert `tenant_id` matches `TWENTYONE_PAY_TENANT_ID`. A valid signature for
   another tenant is still not our event.

Oro has a global `ThrottlerGuard` at 120 req/min
([app.module.ts:58](../../src/app.module.ts#L58)). The existing DK Bank webhook
uses `@SkipThrottle()`; do the same here. During a 21Pay incident their retry
burst would otherwise be rate-limited into terminal failure. Apply a high
dedicated limit rather than none if the tooling allows it.

The route is unauthenticated by necessity. The HMAC is the authentication.

## D.4 Event table

**`crypto_webhook_events`**

```
id            uuid, pk
requestId     varchar(64), UNIQUE     X-Request-Id
eventType     varchar(64)             X-21Tech-Event
pay21IntentId varchar(64), indexed
network       varchar(16)
txHash        varchar(128), null
blockNumber   bigint, null
amount        varchar(64)             base units, as received
currency      varchar(8)
rawPayload    jsonb
receivedAt    timestamptz
processedAt   timestamptz, null
processError  varchar(512), null
```

**The replay guard cannot use a delivery id, because none is sent.** Key it on
`(eventType, pay21IntentId, txHash)` instead — the engine's own dedup uses the
same triple. Drop `requestId` from the entity; a column that is always null is
worse than no column.

A duplicate insert means we have already seen this delivery: return 200 without
reprocessing.

**Store `amount` as the raw string.** Converting at write time and again at
credit time is two chances to be wrong about decimals.

## D.5 Controller

1. Guard has verified. Insert the event row.
2. On unique violation, return 200 — already seen.
3. Dispatch to the settlement service (Stage E). **Synchronously.**
4. Return 200.

**Do not return 200 and then process asynchronously.** Once we 200, the engine
assumes durable handoff. After the backoff is exhausted
(`30s / 2m / 10m / 1h / 6h / 24h` — not the schedule in their docs) a delivery
is terminally failed.

**And there is no replay.** 21Pay's docs claim failed deliveries can be
replayed from the console; no such endpoint or UI exists. A delivery we lose is
lost, which makes the Stage C polling job load-bearing rather than a safety
net, and makes a synchronous 5xx the only way to get a retry at all.

The tradeoff is holding the request open across a DB write. At Oro's volume
that is acceptable, and correctness outranks receiver latency on a money path.

Until Stage E lands, step 3 is a **deliberate no-op**: the row is recorded,
`processedAt` stays null, 200 is returned. That is what lets this stage run
against real traffic and accumulate events for replay once settlement is live.

## D.6 Observability

- Log rejected signatures at `warn` with the request id and reason. **Never log
  the secret, the raw body, or the computed HMAC.** Oro has
  [`shared/utils/redact.util.ts`](../../src/shared/utils/redact.util.ts) — use
  it rather than trusting each log call site.
- Counter on rejections by reason: missing header, skew, bad signature, wrong
  tenant. A spike is a misconfigured secret or someone probing.
- Alert on any event row with `processedAt` null older than 10 minutes, once
  Stage E is live. That is a stuck deposit with a user waiting.

## Verification

- Unit: valid signature accepted; tampered body, stale timestamp, future
  timestamp, wrong tenant, and missing headers all rejected; duplicate
  `X-Request-Id` returns 200 without a second insert.
- **Integration: replay a captured real delivery byte for byte** and assert the
  signature verifies. This is the test that catches raw-body regressions, which
  unit tests with hand-built payloads miss entirely.
- Confirm the route is reachable unauthenticated and is not caught by the
  global throttler.
- **BTN regression gate.** New table and route only.

## Rollback

Deregister the endpoint at 21Pay, drop the table, revert. Events already
delivered can be replayed from 21Pay's console once the endpoint is back.
</content>
