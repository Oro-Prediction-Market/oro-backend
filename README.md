# Oro — Prediction Markets for Bhutan

Oro is a parimutuel prediction market platform built for Bhutan and delivered as a Telegram Mini App. Users predict the outcome of real-world events — sports, gaming, weather, entertainment — stake Oro credits (Nu, pegged to the Bhutanese Ngultrum), and share a payout pool when the market resolves in their favour.

---

## Table of Contents

1. [What is Oro](#what-is-oro)
2. [Architecture](#architecture)
3. [Tech Stack](#tech-stack)
4. [Repositories](#repositories)
5. [Core Features](#core-features)
6. [Market Mechanics](#market-mechanics)
7. [Getting Started](#getting-started)
8. [Environment Variables](#environment-variables)
9. [Database & Migrations](#database--migrations)
10. [Running in Development](#running-in-development)
11. [Running in Production](#running-in-production)
12. [API Overview](#api-overview)
13. [WebSocket Events](#websocket-events)
14. [Admin Portal](#admin-portal)
15. [Keeper Automation](#keeper-automation)
16. [Payments — DK Bank & TON](#payments--dk-bank--ton)
17. [Bonus & Referral System](#bonus--referral-system)
18. [Duels (1v1 Challenges)](#duels-1v1-challenges)
19. [Reputation & Leaderboard](#reputation--leaderboard)
20. [Security](#security)
21. [Testing](#testing)

---

## What is Oro

Oro lets Bhutanese users make predictions on real-world events and win Ngultrum. Everything runs inside Telegram — no separate download or account creation is needed. Real-money flow is handled through **DK Bank**, Bhutan's digital payment network, with optional TON cryptocurrency deposits.

**Entry point:** `t.me/OroPredictBot`  
**Web (PWA):** `oro.fun`  
**Mini App host:** `tma.oro.fun`

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Telegram Mini App                    │
│                  (oro-tma  ·  tma.oro.fun)               │
└────────────────────────┬────────────────────────────────┘
                         │ REST + WebSocket
┌────────────────────────▼────────────────────────────────┐
│               NestJS Backend API                         │
│          (oro-backend  ·  api.oro.fun)                   │
│                                                          │
│  Markets · Settlement · Keeper · DK Bank · Telegram Bot  │
└──────┬───────────────────────────────┬───────────────────┘
       │ PostgreSQL (TypeORM)          │ Redis (BullMQ)
┌──────▼──────┐                ┌──────▼──────┐
│  PostgreSQL │                │    Redis    │
└─────────────┘                └─────────────┘

┌─────────────────────────────────────────────────────────┐
│               React PWA                                  │
│          (oro-pwa  ·  oro.fun)                           │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│               Admin Portal                               │
│          (oro-admin  ·  admin.oro.fun)                   │
└─────────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js, NestJS 11, TypeScript |
| ORM | TypeORM 0.3, PostgreSQL |
| Queue | BullMQ + Redis |
| Real-time | Socket.io (WebSocket gateway) |
| Auth | JWT + Passport, TOTP (2FA for admin) |
| TMA | Telegram Mini App SDK (`@tma.js`) |
| Frontend | React 18, Vite, TypeScript, Tailwind CSS |
| Admin | React 19, Vite 7, shadcn/ui, Tailwind CSS |
| Blockchain | TON Connect (deposit channel) |
| Package manager | Bun (frontend) · npm (backend) |
| Containerisation | Docker + NGINX |

---

## Repositories

| Repo | Purpose |
|------|---------|
| `oro-backend` | NestJS REST API, Keeper, Telegram Bot, parimutuel engine |
| `oro-tma` | Telegram Mini App (primary user interface) |
| `oro-pwa` | Progressive Web App (browser access without Telegram) |
| `oro-admin` | Admin Portal for platform operators |

---

## Core Features

### User-facing
- **Parimutuel markets** — open, bet, resolve, settle
- **Live odds** — shift in real time via WebSocket as bets come in
- **DK Bank integration** — deposit and withdraw Bhutanese Ngultrum
- **TON deposits** — via TON Connect wallet
- **Duels** — 1v1 side-bets between two users on opposite outcomes
- **Power cards** — Double Down, Shield, Ghost (unlocked by duel milestones)
- **Bet streaks** — daily streak counter with a 1.2× day-7 payout multiplier
- **Collectible badges** — milestone-based cosmetic achievements
- **Reputation tiers** — Rookie → Sharpshooter → Hot Hand → Legend (Brier score)
- **Leaderboard** — season-based competitive rankings
- **Referral system** — flat bonus + 5% of first bet, capped at Nu 75
- **Dispute window** — users with positions can challenge proposed resolutions
- **PWA access** — browser login via password set in Settings

### Admin-facing
- Market lifecycle management (create, close, resolve, cancel)
- Keeper Dashboard — monitor and manually trigger automation jobs
- Settlement & Payment Logs
- Resolution Log with admin accuracy tracking
- User management (ban, grant admin, view history)
- Reconciliation panel — real-time accounting integrity check
- Audit Log — every admin action with before/after payload

---

## Market Mechanics

Oro uses a **parimutuel pool** model. All stakes go into a shared pool. When the market resolves, the pool minus the house edge is distributed proportionally to winners.

### Settlement edge cases

**Thin-pool guard** — if all bets are on the winning outcome (no opposition), the market cannot pay out proportionally. All stakes are fully refunded, no house edge is deducted, and users receive a Telegram notification. The settlement record is written with `cancelReason: "thin_pool"`.

**1.05× payout floor** — winning bettors receive at least 1.05× their original stake when the post-rake payout pool can fund that floor for every winner. If the floor would require more than the post-rake payout pool, the market is fully refunded instead: all positions receive their original stake back, no house edge is deducted, and the settlement record is written with `cancelReason: "payout_floor_underfunded"`.

**Bonus-funded positions** — positions placed using bonus credits are flagged `isBonusFunded`. Payouts from bonus-funded bets are subject to a lifetime real-payout cap (`bonusRealPayoutRemaining`) to prevent splitting bonus into small bets to multiply withdrawable winnings.

### Settlement deduplication

The reconciliation query reads only the *earliest* settlement record per market and excludes orphaned settlement rows. This prevents double-counting if a settlement job ran more than once.

### House edge

Set per market by admins, visible on the Market Detail page before betting. Typical range: 3–10%.

### TER markets

Short-duration markets (15-minute windows) tied to live TER (ter.bt) price feeds. Resolution is automated using the `ask_price` at closing time. Minimum bet is Nu 10 (vs Nu 50 for standard markets).

---

## Getting Started

### Prerequisites

- Node.js 20+
- PostgreSQL 15+
- Redis 7+
- Bun (for frontend repos)
- A Telegram Bot token from [@BotFather](https://t.me/BotFather)

### Clone

```bash
git clone <oro-backend>
git clone <oro-tma>
git clone <oro-pwa>
git clone <oro-admin>
```

### Install dependencies

```bash
# Backend
cd oro-backend && npm install

# TMA / PWA / Admin
cd oro-tma && bun install
cd oro-pwa && bun install
cd oro-admin && bun install
```

---

## Environment Variables

Copy `.env.example` to `.env` in `oro-backend` and fill in the values.

| Variable | Description |
|----------|-------------|
| `DB_HOST` | PostgreSQL host |
| `DB_PORT` | PostgreSQL port (default 5432) |
| `DB_USERNAME` | PostgreSQL user |
| `DB_PASSWORD` | PostgreSQL password |
| `DB_NAME` | Database name |
| `REDIS_URL` | Redis connection URL |
| `BOT_TOKEN` | Telegram Bot token from BotFather |
| `CHANNEL_ID` | Telegram channel ID for announcements |
| `WEBHOOK_URL` | Public URL for Telegram webhook |
| `MINI_APP_URL` | TMA URL (`tma.oro.fun`) |
| `FRONTEND_URL` | PWA URL (`oro.fun`) |
| `PORT` | Backend server port (default 3000) |
| `JWT_SECRET` | Secret for signing JWT tokens |
| `JWT_EXPIRES_IN` | Token TTL (default `8h`) |
| `ADMIN_DEV_SECRET` | Password for admin portal login |
| `ADMIN_TELEGRAM_ID` | Telegram ID of the primary admin |
| `PHONE_HASH_SECRET` | HMAC-SHA-256 secret for hashing phone numbers |
| `FOOTBALL_DATA_API_KEY` | API key for football-data.org |
| `CORS_ORIGIN` | Comma-separated allowed CORS origins |
| `MIN_UNIQUE_BETTORS` | Thin-pool guard threshold (default `2`) |

---

## Database & Migrations

```bash
# Run all pending migrations
npm run typeorm:migrate

# Generate a new migration after entity changes
npm run typeorm:generate -- src/migrations/MigrationName

# Revert the last migration
npm run typeorm:revert

# Seed development data
npm run seed
```

---

## Running in Development

```bash
# Backend (with watch mode)
cd oro-backend && npm run dev

# TMA
cd oro-tma && bun dev

# PWA
cd oro-pwa && bun dev

# Admin
cd oro-admin && bun dev
```

The TMA and PWA both support HTTPS local dev for Telegram compatibility:

```bash
bun dev:https
```

---

## Running in Production

Each service includes a `Dockerfile` and an NGINX config. A typical deployment:

```bash
# Backend
docker build -t oro-backend .
docker run -p 3000:3000 --env-file .env.production oro-backend

# Frontend (TMA / PWA / Admin)
bun run build
# Serve dist/ via NGINX
```

The NGINX configs handle SSL termination and proxy to the respective services.

---

## API Overview

The backend exposes a REST API documented via Swagger at `/api/docs` in development.

| Prefix | Module |
|--------|--------|
| `/auth` | Telegram login, JWT, PWA password |
| `/markets` | CRUD, odds, positions |
| `/positions` | Place bet, list user bets |
| `/users` | Profile, reputation, badges |
| `/wallet` | Balance, transaction history |
| `/payment` | DK Bank deposit/withdraw, TON |
| `/challenges` | Duels — create, accept, resolve |
| `/leagues` | Leaderboard, seasons |
| `/admin/*` | All admin portal endpoints (JWT-gated) |
| `/ter` | TER price feed markets |

All user-facing endpoints require a `Bearer` JWT token obtained from `/auth/telegram`.

---

## WebSocket Events

Connect to the root namespace with a valid JWT. The gateway pushes:

| Event | Payload |
|-------|---------|
| `market:update` | Live odds and pool size for a market |
| `market:closed` | Market moved to `closed` status |
| `market:resolved` | Outcome proposed, dispute window open |
| `market:settled` | Payouts distributed |
| `position:confirmed` | Bet placement confirmed |
| `wallet:update` | User balance changed |
| `duel:accepted` | Opponent accepted a duel |
| `duel:resolved` | Duel outcome determined |

---

## Admin Portal

Access the Admin Portal at `admin.oro.fun`. Login requires:

1. **Dev Secret** — the `ADMIN_DEV_SECRET` environment variable
2. **TOTP code** — from an authenticator app (2FA is mandatory)

Sessions are stored in `sessionStorage` and expire on tab close.

### Key pages

| Page | Purpose |
|------|---------|
| Dashboard | Real-time platform health, pool volume, active markets |
| Market Management | Full market lifecycle control |
| Market Discovery | Browse and import from external sources |
| Keeper Dashboard | Monitor and manually trigger automation jobs |
| Settlement | Per-market settlement records and payout breakdowns |
| Payment Logs | All DK Bank and TON transactions |
| Resolution Log | Admin resolution history and accuracy metrics |
| User Management | Search, ban, grant admin, view wallet |
| Audit Log | Every admin action with full before/after payload |
| Reconciliation | Financial integrity check — money in = money out |

---

## Keeper Automation

The **Keeper** is a scheduled background service that automates time-sensitive operations:

- **Close markets** — moves `open` markets past their deadline to `closed`
- **Open dispute windows** — starts the objection period after an outcome is proposed
- **Auto-settle** — distributes payouts once the dispute window expires without an upheld objection
- **Expire duels** — returns wagers on unaccepted duels when the underlying market closes

The Keeper runs on a configurable cron cycle. Individual jobs can be triggered manually from the Keeper Dashboard. If the Keeper is paused, all settlement and payout operations halt — markets must be settled manually until it is re-enabled.

---

## Payments — DK Bank & TON

### DK Bank

Users link their account by entering their 11-digit Bhutanese CID and verifying their phone number via OTP. Deposits and withdrawals flow through the DK Bank API.

| Limit | Amount |
|-------|--------|
| Minimum deposit | Nu 50 |
| Maximum deposit | Nu 15,000 |
| Minimum withdrawal | Nu 50 |

### TON

Users can deposit via a TON Connect wallet. Withdrawals to TON are broadcast on-chain and publicly visible.

### Balances

| Type | Description |
|------|-------------|
| Real balance | Deposited funds + cash winnings. Withdrawable. |
| Bonus balance | Referral bonuses, streak rewards, promotional credits. Usable for bets, not withdrawable directly. |

First deposit receives a **+10% bonus** automatically.

---

## Bonus & Referral System

**Referral bonus:** Share your referral link from Profile. When a referred user places their first bet:
- You receive Nu 25 flat
- Plus 5% of their first bet amount
- Total capped at Nu 75 per referee

**Streak bonus:** Reach day 7 of a consecutive daily betting streak and receive a **1.2× multiplier** on all winning bets placed that day.

**Bonus payout cap:** Bonus-funded bets have a lifetime cap on the withdrawable portion of their winnings (`bonusRealPayoutRemaining`). Any payout above the cap is re-credited as bonus balance.

---

## Duels (1v1 Challenges)

A Duel is a 1v1 side-bet between two users on opposite outcomes of a market. The creator picks one outcome; the first acceptor automatically takes the opposite side. Winner takes both wagers minus a 10% platform fee.

- Requires at least 5 prior predictions to create your first Duel
- Nu 0 wagers allowed (bragging rights only)
- Expires automatically if no one accepts before the market closes
- Voided if the underlying market is cancelled

**Power cards** (one-use, earned by duel win milestones):

| Card | Effect |
|------|--------|
| Double Down | Waives the 10% fee — winner takes the full pot |
| Shield | Protects your bet streak for one missed day |
| Ghost | Hides your username from the duel feed |

---

## Reputation & Leaderboard

**Reputation tiers** are based on Brier score — a calibration metric that measures both accuracy and stake confidence. Tiers in ascending order: **Rookie → Sharpshooter → Hot Hand → Legend**.

**Leaderboard** runs in time-bounded **seasons**. Rankings, season start/end dates, and historical seasons are visible on the Leaderboard page. The current season name and standing appear at the top.

**Collectible badges** unlock automatically at milestones across five categories: Volume, Insight, Correct Calls, Tier, Profile, Referrals, and Duels. A pop-up animation appears when a new badge unlocks.

---

## Security

- All admin endpoints require JWT + TOTP 2FA
- Phone numbers are stored hashed (HMAC-SHA-256)
- Passwords are hashed with bcrypt
- HTTP headers hardened via Helmet
- Rate limiting via `@nestjs/throttler`
- CORS restricted to configured origins
- Every admin action recorded in the immutable Audit Log with IP address, payload diff, and priority classification (High / Medium / Low)
- Telegram Mini App init data is validated server-side on every request

---

## Testing

```bash
# Unit + integration tests
cd oro-backend && npm test

# Type checking (all repos)
npm run typecheck      # backend
bun run typecheck      # tma / pwa / admin
```

Key test suites:

| Suite | Coverage |
|-------|---------|
| `parimutuel.engine.spec.ts` | Core payout calculations |
| `parimutuel.engine.edge-cases.spec.ts` | Thin-pool guard, bonus cap, breakage |
| `audit.service.spec.ts` | Audit log pagination and filtering |
| `settlement.spec.ts` | End-to-end settlement flow |

---

## Licence

MIT
