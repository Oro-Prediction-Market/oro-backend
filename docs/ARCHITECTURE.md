# Oro Backend — Architecture Overview

## Table of Contents

1. [Stack](#1-stack)
2. [Module Map](#2-module-map)
3. [Entity / Data Model](#3-entity--data-model)
4. [Authentication Flows](#4-authentication-flows)
5. [Prediction Engine](#5-prediction-engine)
6. [Market Lifecycle](#6-market-lifecycle)
7. [Dispute & Resolution System](#7-dispute--resolution-system)
8. [Payment Flow (DK Bank)](#8-payment-flow-dk-bank)
9. [Balance Model](#9-balance-model)
10. [Reputation & Intelligence Layer](#10-reputation--intelligence-layer)
11. [Real-time Layer](#11-real-time-layer)
12. [Background Jobs & Queues](#12-background-jobs--queues)
13. [Auto-Market Modules (BTC / TER)](#13-auto-market-modules-btc--ter)
14. [Challenges (P2P Duels)](#14-challenges-p2p-duels)
15. [Leagues & Seasons](#15-leagues--seasons)
16. [Caching Strategy](#16-caching-strategy)
17. [Notification Delivery Chain](#17-notification-delivery-chain)
18. [Security & Hardening](#18-security--hardening)
19. [Migrations & DB Configuration](#19-migrations--db-configuration)
20. [Known Structural Notes](#20-known-structural-notes)

---

## 1. Stack

| Concern | Technology |
|---|---|
| Runtime | Node.js (TypeScript, strict) |
| Framework | NestJS |
| Database | PostgreSQL (TypeORM, `synchronize: false`) |
| Cache | Redis (custom `RedisService` wrapping `ioredis`) |
| Queue | BullMQ (`@nestjs/bullmq`) |
| Real-time (broadcast) | WebSocket Gateway via Socket.io (`MarketsGateway`) |
| Real-time (per-user) | Server-Sent Events (`SseService` / RxJS `Subject`) |
| Auth | JWT (Passport `JwtStrategy`) + HMAC-SHA-256 for Telegram initData |
| Timezone | `Asia/Thimphu` (UTC+6), set at process startup in `main.ts` |
| API prefix | `/api/*` |
| Docs | Swagger at `/docs` (disabled in production by default) |

---

## 2. Module Map

```
AppModule
│
├── RedisModule             shared Redis connection + helpers
├── JobsModule              BullMQ queue + cron jobs
│
├── AuthModule              login / registration for all providers
├── UsersModule             profile, streak, season, onboarding
│
├── MarketsModule           core prediction engine
│   ├── ParimutuelEngine    position placement, resolution, settlement
│   ├── LMSRService         probability display (not order matching)
│   ├── KeeperService       scheduled market state transitions
│   ├── ReputationService   intelligence / signal layer
│   └── MarketsGateway      WebSocket push on market events
│
├── PositionsModule         position query endpoints
├── AdminModule             admin controls, audit trail, fixtures
├── PaymentModule           DK Bank gateway, OTP, bank linking
├── TelegramModule          Bot API, channel posts, phone verification
│
├── ChallengesModule        P2P duels         ←forwardRef→ MarketsModule
├── LeaguesModule           group leaderboards
├── ReconciliationModule    financial audit / reconciliation
├── ReportingModule         analytics, dispute report endpoints
├── EventsModule            user event tracking
├── SseModule               Server-Sent Events
│
├── TerModule               TER token price polling + auto-markets
└── BtcModule               BTC price polling + auto-markets
```

**Circular dependency handling:** `JobsModule ↔ MarketsModule` and `ChallengesModule ↔ MarketsModule` both use NestJS `forwardRef()` to break the cycle.

---

## 3. Entity / Data Model

### Core tables

| Entity | Table | Purpose |
|---|---|---|
| `User` | `users` | Central user record; holds reputation, streak, bonus, referral, and admin accountability fields |
| `AuthMethod` | `auth_methods` | One record per auth provider per user (Telegram, DK Bank, BhutanApp, PWA password) |
| `Market` | `markets` | Prediction market; 7-state lifecycle machine |
| `Outcome` | `outcomes` | Options within a market (Yes/No, Team A/B, etc.) |
| `Position` | `positions` | A user's prediction on one outcome |
| `Transaction` | `transactions` | Append-only financial ledger — **balance is always derived via SUM, never stored** |
| `Payment` | `payments` | Deposit / withdrawal records linked to DK Bank |
| `Settlement` | `settlements` | Per-position payout record written at market resolution |
| `Dispute` | `disputes` | Objection raised during a resolution window, with bond tracking |

### Supporting tables

| Entity | Table | Purpose |
|---|---|---|
| `DKGatewayAuthToken` | `dk_gateway_auth_tokens` | DK Bank OAuth access/refresh tokens |
| `PaymentOtp` | `payment_otps` | OTP records for payment authorisation (10-minute TTL) |
| `AuditLog` | `audit_logs` | Immutable admin action trail |
| `Challenge` | `challenges` | P2P duel records with power card state |
| `Season` | `seasons` | Leaderboard season periods |
| `TelegramGroup` | `telegram_groups` | Registered Telegram groups for league play |
| `GroupMembership` | `group_memberships` | User ↔ group membership |
| `Reconciliation` | `reconciliations` | Financial reconciliation audit records |
| `UserEvent` | `user_events` | Granular user activity events |
| `LinkedBankAccount` | `linked_bank_accounts` | Saved DK Bank account numbers per user |

### Key field-level decisions

- **`User.reputationScore`** — decimal 0.0–1.0, starts at 0.5 (neutral prior). Confidence-adjusted from win/loss history.
- **`User.bonusBalance` / `bonusRealPayoutRemaining`** — free credit tracking. Real-money extraction from bonus predictions is capped at Nu 50 per grant.
- **`User.dkPhoneHash` / `telegramPhoneHash`** — HMAC-SHA-256 hashes only; raw phone numbers are never persisted.
- **`Market.totalPool`** — running sum updated atomically on each prediction. Source of truth for payout calculation.
- **`Market.disputeBondPool`** — accumulates forfeited bonds from wrong objectors; distributed to correct objectors at final resolution.
- **`Position.isBonusFunded`** — flag that determines whether the settlement payout is capped by `bonusRealPayoutRemaining`.

---

## 4. Authentication Flows

Four providers, all issued as a signed JWT on success.

### 4a. Telegram Mini App
1. Client sends raw `initData` string from `window.Telegram.WebApp.initData`.
2. `AuthService.validateTelegramInitData()` verifies the HMAC-SHA-256 signature using `TELEGRAM_BOT_TOKEN`.
3. `auth_date` must be within 1 hour (replay protection).
4. User is upserted by `telegramId`; first login grants a Nu 20 free credit.

### 4b. DK Bank CID (PWA login)
1. Client sends CID + password (bcrypt hash stored in `User.pwaPasswordHash`).
2. On first login, `DKGatewayService` performs a client inquiry against the DK Bank API to validate the CID and cache the account name.
3. Subsequent logins verify password only (no external call).

### 4c. BhutanApp JWT
1. Client sends a JWT issued by the BhutanApp identity service.
2. `AuthService` verifies it against `BHUTANAPP_JWT_SECRET`.
3. User is upserted by BhutanApp user ID.

### 4d. Manual / OTP login
1. Client requests an OTP for a phone number.
2. OTP is delivered via SMS (`SmsService`) or BhutanApp push.
3. Client submits OTP; `AuthService` validates and issues a JWT.

### Token lifecycle
- Default expiry: `JWT_EXPIRES_IN` (default `7d`).
- Sensitive fields (`dkPhoneHash`, `telegramPhoneHash`, `phoneNumber`, `pwaPasswordHash`) are stripped from every JWT payload and API response via `stripSensitiveFields()`.

---

## 5. Prediction Engine

All markets use the **Parimutuel** mechanism. LMSR is used only for real-time probability display.

### Position placement (`ParimutuelEngine.placePosition`)

1. Load market + user inside a DB transaction (`DataSource.transaction`).
2. Validate: market must be `OPEN`, outcome must belong to the market, amount > 0.
3. Check balance via `COALESCE(SUM(t.amount), 0)` on the transactions table.
4. Deduct stake: write a `STAKE` transaction (negative amount).
5. Update `Outcome.totalBetAmount` and `Market.totalPool`.
6. Recalculate LMSR probabilities across all outcomes and persist.
7. Create a `Position` record (`status: pending`).
8. Apply streak bonus if applicable (day-7 of prediction streak → 1.2× multiplier on payout).
9. Invalidate Redis market cache keys.
10. Push WebSocket event via `MarketsGateway` and SSE event via `SseService`.

### Settlement (`ParimutuelEngine.resolveMarket`)

1. Compute total pool after house edge deduction: `payoutPool = totalPool × (1 − houseEdgePct/100)`.
2. For each winning position, compute pro-rata share: `payout = (stake / winOutcomeTotalBet) × payoutPool`.
3. Enforce the 1.05x floor only when it is funded by the post-rake payout pool. If `sum(winning stakes × 1.05) > payoutPool`, refund every position, deduct no house edge, and write `cancelReason: "payout_floor_underfunded"`.
4. Write a `PAYOUT` transaction (positive amount) per winner.
5. Write a `Settlement` record linking market, position, and payout amount.
6. Update `Position.status` → `won` or `lost`.
7. Trigger reputation update via `ReputationService.onSettlement()`.
8. Release dispute bonds (return correct objectors' bonds + reward share; burn wrong objectors' bonds).
9. Emit SSE `balance:updated` per affected user.

---

## 6. Market Lifecycle

```
UPCOMING ──► OPEN ──► CLOSED ──► RESOLVING ──► RESOLVED ──► SETTLED
    │           │        │            │
    └───────────┴────────┴────────────┴──► CANCELLED
```

| Transition | Who triggers |
|---|---|
| `UPCOMING → OPEN` | Admin or `KeeperService` cron (when `opensAt` passes) |
| `OPEN → CLOSED` | Admin or `KeeperService` cron (when `closesAt` passes) |
| `CLOSED → RESOLVING` | Admin via `POST /admin/markets/:id/propose-resolution` |
| `RESOLVING → RESOLVED` | Auto (zero objections, window expired) or admin manual override |
| `RESOLVED → SETTLED` | `ParimutuelEngine.resolveMarket` (completes payouts) |
| Any → `CANCELLED` | Admin; all pending positions refunded automatically |

---

## 7. Dispute & Resolution System

### Objection window
When an admin proposes a resolution, a time window opens (default 60 min; allowed: 10 / 20 / 30 / 60 / 120 min). Users with an active `pending` position can raise an objection.

### Bond mechanism
- Fixed bond: **Nu 10** per objection (regardless of position size).
- Bond is deducted immediately via a `DISPUTE_BOND_LOCK` transaction.
- **Correct objector** (admin changes the outcome): bond returned + pro-rata share of `Market.disputeBondPool`.
- **Wrong objector** (admin upholds original): bond forfeited into `disputeBondPool`.

### Auto-resolution (happy path)
`AutoResolveMarketsJob` runs every 5 minutes. For any `RESOLVING` market whose `disputeDeadlineAt` has passed with **zero objections**, it auto-settles using `proposedOutcomeId` — no admin action required.

### Admin accountability
Every manual resolution increments `User.adminTotalResolutions`. If the admin later overrides their own proposal (outcome changed after objections), `User.adminWrongResolutions` is incremented. This ratio is surfaced in the admin panel.

---

## 8. Payment Flow (DK Bank)

### Deposit

```
Client                    Backend                       DK Bank API
  │── POST /payment/initiate ──►│                              │
  │                             │── client-inquiry (CID) ────►│
  │                             │◄── account details ─────────│
  │                             │  create Payment (pending)    │
  │                             │  generate OTP                │
  │                             │── send OTP (BhutanApp/SMS) ─►│ user's device
  │◄── paymentId + otpRequired ─│                              │
  │── POST /payment/confirm ───►│                              │
  │    { paymentId, otp }       │  validate OTP (10-min TTL)   │
  │                             │── transfer request ─────────►│
  │                             │◄── success ─────────────────│
  │                             │  write DEPOSIT transaction   │
  │                             │  emit SSE balance:updated    │
  │◄── success ─────────────────│                              │
```

### Withdrawal
Same flow in reverse. The `DKGatewayService` uses OAuth tokens stored in `DKGatewayAuthToken`; tokens are refreshed automatically on expiry.

### Bank linking
`BankLinkService` links a user's DK Bank account (by CID or account number) and stores HMAC-SHA-256 hashes of the phone number for identity verification on future payments. A timestamp `dkLinkVerifiedAt` is set on successful link via account number (fallback for users whose Telegram phone differs from their DK Bank phone).

---

## 9. Balance Model

**There is no stored balance column.** A user's balance at any point is:

```sql
SELECT COALESCE(SUM(amount), 0) AS balance
FROM transactions
WHERE user_id = $1;
```

Transaction types that affect balance:

| `TransactionType` | Direction | Trigger |
|---|---|---|
| `DEPOSIT` | + | DK Bank deposit confirmed |
| `WITHDRAWAL` | − | DK Bank withdrawal confirmed |
| `STAKE` | − | Prediction placed |
| `PAYOUT` | + | Market settled (won) |
| `REFUND` | + | Market cancelled / refund |
| `FREE_CREDIT` | + | Welcome bonus or referral reward |
| `BONUS_BET_WIN` | + | Bonus-funded prediction won |
| `DISPUTE_BOND_LOCK` | − | Objection filed |
| `DISPUTE_BOND_RETURN` | + | Correct objection resolved |
| `PLATFORM_FEE` | − | Challenge platform fee (10%) |
| `STREAK_BONUS` | + | Day-7 prediction streak multiplier |

Redis cache key `oro:cache:balance:{userId}` (short TTL) avoids repeated ledger scans on hot paths.

---

## 10. Reputation & Intelligence Layer

Managed by `ReputationService`. Four interlocking mechanisms:

### 1. Reputation-weighted LMSR
Each predictor's effective share = `position.amount × reputationMultiplier`  
`reputationMultiplier = 0.5 + reputationScore` (range ~0.5×–1.5×)  
High-rep users move the displayed probability more; low-rep users less.

### 2. Time-decay
`decayFactor = exp(−ln2 × daysSinceLastActive / 365)`  
At 365 days inactive a user's effective weight halves. Stored `reputationScore` is unchanged — decay is applied only during real-time signal computation.

### 3. Brier score calibration
`brierScore = rolling average of (predictedProbability − actual)²`  
`calibrationMultiplier = 1 − brierScore × 0.5`  
Full weight = `reputationMultiplier × decayFactor × calibrationMultiplier`

### 4. Cold-start bootstrap
Users with a verified DK CID start with a prior of `0.52` instead of neutral `0.50`, giving a slight accuracy head-start that erodes as real predictions accumulate.

### Score storage
`User.reputationScore` — confidence-adjusted raw accuracy:  
`adjusted = raw × confidence + prior × (1 − confidence)`  
where `confidence = min(totalPredictions / 30, 1.0)`

### Tiers
`rookie → sharpshooter → hot_hand → legend`

### Contrarian badge
Tracks users who predict against the Expert-weighted signal and win. Milestones: Bronze (3 wins, ≥55% rate) → Silver (7) → Gold (15).

---

## 11. Real-time Layer

Two parallel channels:

### WebSocket (MarketsGateway)
- Socket.io gateway at the NestJS level.
- Pushes market-level events (odds updates, status changes) to all connected clients.
- Rooms are keyed by `marketId`.
- Emitted from `ParimutuelEngine` on every prediction placed and from `KeeperService` on transitions.

### Server-Sent Events (SseService)
- RxJS `Subject<SseEvent>` bus. Each HTTP connection subscribes via `SseService.forUser(userId)`.
- Per-user events: `balance:updated`, `position:settled`, `challenge:updated`.
- Broadcast events (`userId: "*"`): `market:updated`.
- Used when a push needs to reach a specific user's browser without a WebSocket room.

---

## 12. Background Jobs & Queues

### BullMQ — NOTIFICATION_QUEUE

Jobs are enqueued by the prediction engine and payment service; processed by `NotificationProcessor`.

| Job name | Trigger | Action |
|---|---|---|
| `payment.success` | Deposit confirmed | Telegram DM to user |
| `market.settled` | Market resolved | Telegram channel post |
| `bet.result` | Position settled | Telegram DM (won / lost / refunded) |
| `streak.milestone` | Streak milestone hit | Telegram DM |
| `daily.credit` | Engagement job | Telegram DM with daily prompt |

Default job options: 3 attempts, exponential backoff (5s → 10s → 20s), keep last 100 completed / 200 failed.

### Cron jobs

| Job | Schedule | Action |
|---|---|---|
| `AutoResolveMarketsJob` | Every 5 minutes | Auto-settle `RESOLVING` markets with expired objection windows and zero objections |
| `KeeperService` | Every minute | Open `UPCOMING` markets past `opensAt`; close `OPEN` markets past `closesAt` |
| `EngagementJob` | Configurable | Send daily engagement messages to active users |

---

## 13. Auto-Market Modules (BTC / TER)

Both modules follow the same pattern:

```
PriceService  ──polls external API──►  price feed
     │
MarketService ──creates/resolves markets based on price thresholds──► MarketsModule
```

- **`BtcModule`** — polls a BTC/USD price feed; auto-creates `over/under` markets and resolves them at close.
- **`TerModule`** — polls a TER (Bhutan token) price feed; same auto-market logic.

Both modules depend on `MarketsModule` (for `MarketsService` / `ParimutuelEngine`) and `RedisModule` (for price caching).

---

## 14. Challenges (P2P Duels)

`ChallengesService` manages 1-vs-1 prediction duels.

- Minimum 5 resolved predictions required to participate.
- Platform fee: 10% of the total stake.
- **Power Cards** — earned at win milestones (3 / 7 / 15 duel wins):
  - `doubleDown` — 2× your stake for this duel
  - `shield` — nullify a loss
  - `ghost` — hide your pick from the opponent until settlement
- Card inventory stored as JSONB on `User.cardInventory`.
- Challenge state changes push SSE events to both participants.

---

## 15. Leagues & Seasons

- **`SeasonService`** — manages leaderboard season periods (`Season` entity). Handles seasonal resets and rankings.
- **`LeaguesService`** — manages `TelegramGroup` + `GroupMembership`. Groups can be registered; members compete on a group leaderboard scoped to the season.
- **`StreakService`** — tracks `User.betStreakCount` and `betStreakLastAt`. Day-7 awards a 1.2× payout multiplier (`STREAK_BONUS_MULT`) applied at settlement via `ParimutuelEngine`.

---

## 16. Caching Strategy

All caching goes through `RedisService` which wraps `ioredis`.

| Cache key | TTL | Invalidated on |
|---|---|---|
| `oro:cache:markets:all` | 30 s | Any market create/update/transition |
| `oro:cache:market:{id}` | 30 s | That market's create/update/transition |
| `oro:cache:markets:search:{q}` | 30 s | (expires naturally) |
| `oro:cache:balance:{userId}` | Short | Any transaction write for that user |
| BTC/TER price keys | Configurable | New price fetch |

Cache misses fall through to PostgreSQL. No write-through — cache is invalidated (deleted) on writes, not updated.

---

## 17. Notification Delivery Chain

OTP and alert delivery follows a priority chain:

```
1. BhutanApp push notification  (BhutanAppNotificationService)
        ↓ if user has no BhutanApp auth method or delivery fails
2. Telegram DM                  (TelegramSimpleService.sendMessage)
        ↓ if no telegramId or delivery fails
3. SMS                          (SmsService)
```

This chain is applied for withdrawal OTPs and critical payment alerts. Market and prediction notifications go directly to Telegram (channel posts or DMs).

---

## 18. Security & Hardening

| Concern | Implementation |
|---|---|
| Rate limiting | `ThrottlerModule` — 120 requests/min global default (configurable per route) |
| Security headers | `helmet` on all routes; relaxed CSP for `/docs` only |
| CORS | Allowlist-only; origins parsed and validated as `https:` URLs; no wildcard |
| JWT | RS256/HS256, `JWT_SECRET` env-required at startup (throws if missing) |
| Telegram auth | HMAC-SHA-256, `auth_date` staleness check (1-hour window) |
| Input validation | `ValidationPipe` with `whitelist: true` + `forbidNonWhitelisted: true` |
| Phone numbers | Stored as HMAC-SHA-256 hashes only (`PHONE_HMAC_SECRET` env var) |
| Sensitive fields | `dkPhoneHash`, `telegramPhoneHash`, `phoneNumber`, `pwaPasswordHash` stripped from all API responses |
| SQL injection | TypeORM parameterised queries; manual LIKE queries use `ESCAPE '\\'` |
| Admin actions | All admin mutations written to `AuditLog` via `AuditService` |

---

## 19. Migrations & DB Configuration

- `synchronize: false` — schema is never auto-synced in any environment.
- `migrationsRun: true` — pending migrations run automatically at app startup.
- Migration files live in `src/migrations/`, named with a timestamp prefix.
- Connection pool: `max: 20`, `min: 2`, idle timeout 30 s, connection timeout 5 s.
- `data-source.ts` exports a standalone `DataSource` for running migrations via CLI (`typeorm migration:run`).

---

## 20. Known Structural Notes

**Shared services are not in a SharedModule.** `DKGatewayService`, `TelegramSimpleService`, and `SmsService` are instantiated directly in `AuthModule`, `UsersModule`, and `PaymentModule` rather than being exported from a central shared module. This means multiple NestJS DI instances exist for these classes.

**Balance is always a ledger scan.** There is no denormalised balance column. This is correct and safe but every balance check hits the DB. The Redis cache key `oro:cache:balance:{userId}` mitigates hot-path reads.

**`ParimutuelEngine` is highly coupled.** It depends on `LMSRService`, `ReputationService`, `MarketsGateway`, `TelegramSimpleService`, `DKGatewayService`, `StreakService`, `ChallengesService`, and `SseService`. It is the system's central transaction coordinator.

**LMSR is display-only.** Despite the `LMSRService`, the actual settlement mechanism is parimutuel (pro-rata). LMSR probabilities are recomputed and stored on `Outcome.lmsrProbability` after each prediction purely for UI display.

**`routes/` directory is unused.** `src/routes/bot.ts`, `user.ts`, and `index.ts` appear to be legacy Express route stubs that are not wired into the NestJS application.
